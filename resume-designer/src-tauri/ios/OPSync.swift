// CloudKit transport. Zones, records, conflicts — driven by `CKSyncEngine`.
//
// **This file never parses a payload.** A unit crosses as
// `{ id, kind, payload, modifiedAt }` with `payload` an opaque JSON string,
// because decomposing the résumé document is schema knowledge and the native
// side does not hold any. That is also what makes a future Mac client a
// transport-only job: it reimplements this file and nothing below it.
//
// Its JS counterpart is src/sync/syncModel.js.
//
// **Why CKSyncEngine and not CKDatabase.** This file used to hand-roll the
// transport, and its four worst bugs were one bug: record change tags, change
// tokens, batching and backoff are a single mechanism, and reimplementing any
// part of it means owning all of it. The one worth writing down is the silent
// one, because the build was green and the app looked like it was syncing:
// a save assembled from a FRESH `CKRecord` carries no `recordChangeTag`, so
// `.ifServerRecordUnchanged` answered `serverRecordChanged` to EVERY push, the
// tie-break handed the server the win every time, and no local edit ever
// reached iCloud. The others were of a piece — non-conflict failures were
// dropped so a caller could not tell "all saved" from "nothing saved", the
// conflict retry threw away its own result, and the change token was advanced
// past records that had been discarded, so they were never fetched again.
//
// CKSyncEngine owns the tags, the tokens, the batching and the retry. It owns
// the tags only if the app hands back the record it last saw, though, which is
// why `systemFields` below is persisted rather than merely cached — an
// in-memory map would reintroduce the bug above once per launch, for every
// unit.

import CloudKit
import Foundation

/// Mirrors the unit shape in src/sync/syncModel.js.
struct SyncUnit: Codable, Equatable {
  let id: String
  /// "resume" | "plain" | "tokenUsage" — enough to route a conflict without
  /// understanding the contents.
  let kind: String
  let payload: String
  /// OPTIONAL, and it has to be.
  ///
  /// `modifiedAtFor` in src/sync/syncModel.js emits an explicit `null` for a
  /// unit this device never stamped — deliberately, so an unstamped unit cannot
  /// win a conflict it never earned. A non-optional `String` here did not just
  /// mistranslate that: it failed decoding outright with
  /// `DecodingError.valueNotFound`, so every unit carrying it was dropped at the
  /// bridge instead of syncing.
  ///
  /// `nil` means "unknown", never "old". `resolveConflict`
  /// (src/sync/syncMerge.js) scores an absent or unparseable stamp `-Infinity`,
  /// so it loses to any real stamp and two unknowns tie. `Self.localWins` is
  /// that rule in Swift, to the letter.
  ///
  /// Encoding drops the key rather than writing `null` — `Codable`'s synthesised
  /// `encode` uses `encodeIfPresent` for optionals. That is fine in this
  /// direction: `applyUnits` reads `id`, `kind` and `payload` and never the
  /// stamp. It is only the JS→Swift direction that has to carry it.
  let modifiedAt: String?
}

/// Payloads larger than this go to a CKAsset. CloudKit caps a record's fields
/// at roughly 1MB; the headroom covers the other fields and encoding overhead,
/// so the decision never has to be revisited at the boundary.
let opSyncAssetThreshold = 700 * 1024

/// Whether sync may run — and when it may not, why.
///
/// This was a `Bool`, and one bit could not carry the answer: `false` meant
/// "there is no iCloud account on this device", "a restriction forbids this app
/// iCloud", and "we could not reach iCloud just now" all at once. The first two
/// are settled states the user has to act on, the third resolves itself, and the
/// status line planned for Settings has nothing else to draw from — with the
/// Bool it could only ever say "sync is off", never why. So the reason travels
/// with the answer.
enum OPSyncAccountState: Equatable {
  /// The only state in which anything may touch the database.
  case available
  /// No iCloud account on this device. A normal state, not an error: it means
  /// there is no server to compare against, never that the server is empty.
  case signedOut
  /// Parental controls or an MDM profile deny this app iCloud.
  case restricted
  /// Signed in, but iCloud is not ready. Apple's own guidance for this status
  /// is explicit that it is transient and cached data must be left alone.
  case temporarilyUnavailable
  /// CloudKit would not say, which in practice is usually no network.
  case undetermined
  /// The status check itself failed. The reason is diagnostic — for a log line
  /// or a status line, never for a decision.
  case checkFailed(reason: String)
}

/// Something that did not land.
///
/// The previous transport swallowed every non-conflict save failure: quota,
/// network, `limitExceeded`, `zoneNotFound` all came back as an empty array of
/// conflict losers, which is byte-for-byte what "everything saved" looked like.
/// So failures travel now, and they say whether anything will happen next.
struct OPSyncFailure: Equatable {
  /// The unit that failed, or nil when the failure belonged to the ZONE — which
  /// applies to every unit in it — or to a fetch.
  let unitId: String?
  /// Whether the transport put the change back in the queue. `false` means
  /// nothing more will be attempted until the unit is edited again, which is
  /// the only case worth telling the user about.
  let willRetry: Bool
  /// nil when the failure was local (staging an asset on disk) rather than the
  /// server's answer.
  let code: CKError.Code?
  /// Diagnostic — for a log line or a status line, never for a decision.
  let reason: String
}

/// The app side of the transport.
///
/// `CKSyncEngine` is delegate-driven: it decides WHEN to send and asks for the
/// records at that moment, and it may fetch on a schedule nobody asked for. So
/// the seam cannot be call-and-wait the way `push`/`pull` were. The caller
/// starts the engine, names the units that changed, and everything the
/// transport learns arrives here.
@MainActor
protocol OPSyncHost: AnyObject {
  /// The unit's CURRENT local state, or nil if this device has nothing to send
  /// under that id.
  ///
  /// Asked at send time rather than at `send(unitIds:)` time, which is why a
  /// unit edited twice before the engine gets around to it uploads once, with
  /// the later text.
  ///
  /// Returning nil drops the queued send. It never deletes anything: absence is
  /// not a deletion here, and the server keeps whatever it already holds.
  func syncUnit(withId id: String) async -> SyncUnit?

  /// Units that arrived from another device.
  ///
  /// Includes the winner of a conflict this device lost: that record is already
  /// in hand when the conflict is detected, and until it lands the two devices
  /// disagree, so it is delivered then rather than at the next fetch.
  func syncDidFetch(_ units: [SyncUnit])

  /// Units that LOST a conflict, for the caller to park in version history.
  /// Newer wins, and this is the older one — nothing is discarded silently.
  func syncDidLoseConflict(_ losers: [SyncUnit])

  /// Sends and fetches that did not land. See `OPSyncFailure`.
  func syncDidFail(_ failures: [OPSyncFailure])
}

private let opSyncRecordType = "SyncUnit"

@MainActor
final class OPSyncEngine {
  private let container = CKContainer(identifier: "iCloud.com.onpaper.app")
  /// Weak: the host owns this object, and CKSyncEngine holds its own delegate
  /// strongly (see `OPSyncDelegate`), so a strong reference here would close a
  /// cycle around the whole transport.
  private weak var host: OPSyncHost?

  private var engine: CKSyncEngine?
  private var delegate: OPSyncDelegate?
  private var profileId: String?
  private var zoneID: CKRecordZone.ID?

  /// The system fields — record id, zone, and the `recordChangeTag` — of every
  /// record this device has seen on the server.
  ///
  /// PERSISTED, not cached. See the file header: without the tag, a save is a
  /// brand-new record and CloudKit answers `serverRecordChanged` forever. An
  /// in-memory map would be correct until the first relaunch and then wrong for
  /// every unit, which is precisely the failure mode that made the old bug
  /// invisible.
  private var systemFields: [String: Data] = [:]

  init(host: OPSyncHost) {
    self.host = host
  }

  /// Whether sync can run at all, and why not when it cannot. Signed out is a
  /// normal state, not an error, and must never wipe local data.
  func accountState() async -> OPSyncAccountState {
    do {
      switch try await container.accountStatus() {
      case .available: return .available
      case .noAccount: return .signedOut
      case .restricted: return .restricted
      case .temporarilyUnavailable: return .temporarilyUnavailable
      case .couldNotDetermine: return .undetermined
      @unknown default: return .undetermined
      }
    } catch {
      return .checkFailed(reason: error.localizedDescription)
    }
  }

  /// Bring the engine up for one profile, and say why it did not when it did
  /// not.
  ///
  /// Idempotent for the profile already running, so a caller may call it on
  /// every foreground without tearing the engine down and losing its in-memory
  /// queue.
  @discardableResult
  func start(profileId: String) async -> OPSyncAccountState {
    let state = await accountState()
    guard case .available = state else { return state }
    if self.profileId == profileId, engine != nil { return state }
    await stop()

    // One zone per profile: atomic per-profile fetches, and a clean per-profile
    // delete. The zone name is the profile id, which is already a stable
    // identifier on disk.
    let zone = CKRecordZone(zoneName: profileId)
    self.profileId = profileId
    self.zoneID = zone.zoneID
    self.systemFields = Self.loadSystemFields(profileId: profileId)

    let delegate = OPSyncDelegate(owner: self)
    let engine = CKSyncEngine(
      CKSyncEngine.Configuration(
        database: container.privateCloudDatabase,
        stateSerialization: Self.loadState(profileId: profileId),
        delegate: delegate
      )
    )
    self.delegate = delegate
    self.engine = engine

    // Saving a zone that already exists is a no-op, so this is queued on every
    // start rather than tracked. It is the only thing that creates the zone, and
    // the alternative — a "have I made it yet" flag — is a second piece of state
    // that can disagree with the server.
    engine.state.add(pendingDatabaseChanges: [.saveZone(zone)])

    // Nothing staged for an earlier run can be uploaded now: every record is
    // rebuilt from `syncUnit(withId:)` at send time. Clearing the outbox here is
    // what keeps assets from an interrupted run from accumulating.
    Self.clearOutbox()
    return state
  }

  /// Put the transport down. Local data is untouched — this is the transport
  /// going quiet, not a sign-out.
  func stop() async {
    await engine?.cancelOperations()
    engine = nil
    delegate = nil
    profileId = nil
    zoneID = nil
    systemFields = [:]
  }

  /// Queue units to go up, and send now.
  ///
  /// The scope is everything pending rather than just `unitIds`, on purpose: a
  /// unit whose last send failed for a transient reason was put back in the
  /// queue, and scoping to the ids named here would leave it sitting there until
  /// that same unit happened to be edited again.
  func send(unitIds: [String]) async throws {
    guard let engine, let zoneID else { return }
    let changes = unitIds.map { id in
      CKSyncEngine.PendingRecordZoneChange.saveRecord(
        CKRecord.ID(recordName: id, zoneID: zoneID)
      )
    }
    engine.state.add(pendingRecordZoneChanges: changes)
    try await engine.sendChanges()
  }

  /// Pull what changed.
  ///
  /// Results arrive at `syncDidFetch`, not from here: the engine also fetches on
  /// its own schedule, and a return value would have been a second, quieter path
  /// for the same data — one the caller would have to remember to also handle.
  func fetch() async throws {
    guard let engine else { return }
    try await engine.fetchChanges()
  }
}

// MARK: - CKSyncEngine's delegate

/// Kept off `OPSyncEngine` itself for two reasons: the three delegate methods
/// are not part of the seam a caller should see, and `CKSyncEngine` holds its
/// delegate — so a delegate that owned the engine back would keep both alive for
/// the life of the process. This one holds its owner weakly, which is what makes
/// `stop()` actually stop.
@MainActor
private final class OPSyncDelegate: CKSyncEngineDelegate {
  weak var owner: OPSyncEngine?

  init(owner: OPSyncEngine) {
    self.owner = owner
  }

  func handleEvent(_ event: CKSyncEngine.Event, syncEngine: CKSyncEngine) async {
    owner?.handle(event, engine: syncEngine)
  }

  func nextRecordZoneChangeBatch(
    _ context: CKSyncEngine.SendChangesContext, syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
    guard let owner else { return nil }
    return await owner.nextBatch(context, engine: syncEngine)
  }

  func nextFetchChangesOptions(
    _ context: CKSyncEngine.FetchChangesContext, syncEngine: CKSyncEngine
  ) async -> CKSyncEngine.FetchChangesOptions {
    // Narrowed to this profile's zone. The private database holds a zone per
    // profile, and this engine's persisted state carries only this profile's
    // change tokens — so fetching another profile's zone here would advance a
    // token for records that are then dropped on the floor, which is the "pull
    // advanced past records it discarded" bug one level up. Another profile's
    // zone is fetched by another profile's engine, from its own state.
    guard let zoneID = owner?.currentZoneID else { return context.options }
    var options = context.options
    options.scope = .zoneIDs([zoneID])
    return options
  }
}

// MARK: - Events

extension OPSyncEngine {
  fileprivate var currentZoneID: CKRecordZone.ID? { zoneID }

  fileprivate func handle(_ event: CKSyncEngine.Event, engine: CKSyncEngine) {
    switch event {
    case .stateUpdate(let update):
      saveState(update.stateSerialization)

    case .accountChange(let change):
      handleAccountChange(change.changeType)

    case .fetchedRecordZoneChanges(let changes):
      // `changes.deletions` is ignored on purpose. Deletion in this design is an
      // explicit tombstone unit that travels like any other unit, and this task
      // does not implement it — nothing here may turn a record's absence, or the
      // server's deletion list, into a local delete.
      var units: [SyncUnit] = []
      for modification in changes.modifications {
        remember(modification.record)
        if let unit = unit(from: modification.record) { units.append(unit) }
      }
      if !units.isEmpty { host?.syncDidFetch(units) }

    case .sentRecordZoneChanges(let sent):
      // The saved records come back carrying their NEW change tags. Recording
      // them is what makes the next save of the same unit a clean update rather
      // than a conflict.
      for record in sent.savedRecords { remember(record) }
      handleFailedSaves(sent.failedRecordSaves, engine: engine)

    case .sentDatabaseChanges(let sent):
      // A zone that would not save takes every unit in it with it, so it is put
      // back and reported against no unit in particular.
      for failure in sent.failedZoneSaves {
        engine.state.add(pendingDatabaseChanges: [.saveZone(failure.zone)])
      }
      report(sent.failedZoneSaves.map { failure in
        OPSyncFailure(unitId: nil, willRetry: true, code: failure.error.code,
                      reason: failure.error.localizedDescription)
      })

    case .didFetchRecordZoneChanges(let done):
      // A zone that is not there is not a failure: it is the first sync, before
      // anything has been sent. Everything else the caller should hear about.
      if let error = done.error, error.code != .zoneNotFound,
         error.code != .userDeletedZone {
        report([OPSyncFailure(unitId: nil, willRetry: true, code: error.code,
                              reason: error.localizedDescription)])
      }

    // `fetchedDatabaseChanges` carries zone deletions, which are ignored for the
    // same reason record deletions are. The rest are progress notifications with
    // nothing this transport has to decide.
    case .fetchedDatabaseChanges, .willFetchChanges, .willFetchRecordZoneChanges,
         .didFetchChanges, .willSendChanges, .didSendChanges:
      break

    @unknown default:
      break
    }
  }

  /// iCloud signed in, out, or switched underneath us.
  ///
  /// Nothing local is touched: a résumé belongs to the user, not to the account,
  /// and the app works signed out. What IS dropped is the change-tag map, which
  /// is bookkeeping about ONE account's server — a tag from the previous account
  /// describes a record the new one cannot see, and offering it would turn every
  /// first save under the new account into an unwinnable conflict.
  ///
  /// The engine's own state serialization is left to the engine, which reissues
  /// it through `stateUpdate`.
  private func handleAccountChange(_ change: CKSyncEngine.Event.AccountChange.ChangeType) {
    switch change {
    case .signIn:
      break
    case .signOut, .switchAccounts:
      systemFields = [:]
      saveSystemFields()
    @unknown default:
      break
    }
  }

  private func handleFailedSaves(
    _ failures: [CKSyncEngine.Event.SentRecordZoneChanges.FailedRecordSave],
    engine: CKSyncEngine
  ) {
    var arrived: [SyncUnit] = []
    var losers: [SyncUnit] = []
    var reported: [OPSyncFailure] = []

    // By the time this event arrives the engine has already taken these changes
    // off the queue. Anything that should be tried again has to be put back, and
    // anything not put back is a decision to stop — which is why the ones that
    // are not put back are reported.
    for failure in failures {
      let recordID = failure.record.recordID
      let error = failure.error

      switch error.code {
      case .serverRecordChanged:
        guard let serverRecord = error.serverRecord,
              let serverUnit = unit(from: serverRecord),
              let localUnit = unit(from: failure.record)
        else {
          reported.append(OPSyncFailure(
            unitId: recordID.recordName, willRetry: false, code: error.code,
            reason: "conflict on an unreadable record: \(error.localizedDescription)"
          ))
          continue
        }

        // The server's copy is the only place its current change tag exists, so
        // it is recorded BEFORE anything decides what to do with it. A retry
        // built without it is the fresh-record bug from the file header, in
        // exactly the case a conflict has just proved is live.
        remember(serverRecord)

        if Self.localWins(local: localUnit, server: serverUnit) {
          // Ours is newer. Queue it again — `recordToSend` now builds it on the
          // server's tag, so the retry is an update rather than another
          // conflict.
          engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
          losers.append(serverUnit)
        } else {
          // Theirs is newer, or the two tie and the tie goes to the server so
          // both devices break it the same way — otherwise they converge on
          // different winners and sync forever.
          arrived.append(serverUnit)
          losers.append(localUnit)
        }

      case .zoneNotFound, .userDeletedZone:
        // The zone is gone from the server: never created, or deleted from
        // Settings. Recreate it and send again. This is NOT "the server is empty
        // so drop the local copy" — it is the opposite, the local copy is the
        // only one left.
        if let zoneID {
          engine.state.add(pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: zoneID))])
        }
        forget(recordID)
        engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        reported.append(OPSyncFailure(unitId: recordID.recordName, willRetry: true,
                                      code: error.code,
                                      reason: error.localizedDescription))

      case .unknownItem:
        // A change tag for a record the server does not have. Forget the tag so
        // the retry goes up as a new record instead of quoting a tag nothing
        // will ever match.
        forget(recordID)
        engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        reported.append(OPSyncFailure(unitId: recordID.recordName, willRetry: true,
                                      code: error.code,
                                      reason: error.localizedDescription))

      case .networkFailure, .networkUnavailable, .serviceUnavailable,
           .requestRateLimited, .zoneBusy, .serverResponseLost,
           .accountTemporarilyUnavailable:
        // Transient. CKSyncEngine owns the backoff; putting the change back is
        // the whole of this side's job.
        engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        reported.append(OPSyncFailure(unitId: recordID.recordName, willRetry: true,
                                      code: error.code,
                                      reason: error.localizedDescription))

      default:
        // Quota exceeded, a record over a hard limit, a rejected request, a
        // missing entitlement: none of these get better by being retried, and
        // retrying them forever would be a queue that never drains.
        reported.append(OPSyncFailure(unitId: recordID.recordName, willRetry: false,
                                      code: error.code,
                                      reason: error.localizedDescription))
      }
    }

    if !arrived.isEmpty { host?.syncDidFetch(arrived) }
    if !losers.isEmpty { host?.syncDidLoseConflict(losers) }
    report(reported)
  }

  private func report(_ failures: [OPSyncFailure]) {
    guard !failures.isEmpty else { return }
    host?.syncDidFail(failures)
  }
}

// MARK: - Records

extension OPSyncEngine {
  fileprivate func nextBatch(
    _ context: CKSyncEngine.SendChangesContext, engine: CKSyncEngine
  ) async -> CKSyncEngine.RecordZoneChangeBatch? {
    let scope = context.options.scope
    let pending = engine.state.pendingRecordZoneChanges.filter { scope.contains($0) }
    guard !pending.isEmpty else { return nil }
    return await CKSyncEngine.RecordZoneChangeBatch(pendingChanges: pending) { [weak self] recordID in
      guard let self else { return nil }
      return await self.recordToSend(recordID)
    }
  }

  /// The record for one queued unit, built at SEND time.
  ///
  /// Returning nil tells the engine to drop the queued change. That is a dropped
  /// SEND, never a delete — the server keeps whatever it already holds, because
  /// absence is not deletion here.
  private func recordToSend(_ recordID: CKRecord.ID) async -> CKRecord? {
    guard let unit = await host?.syncUnit(withId: recordID.recordName) else { return nil }
    // The record as it was last seen on the server, change tag and all. Without
    // it this is a brand-new CKRecord with no tag, which the engine's
    // `.ifServerRecordUnchanged` save policy rejects as a conflict every single
    // time — see the file header.
    let record = rememberedRecord(for: recordID)
      ?? CKRecord(recordType: opSyncRecordType, recordID: recordID)
    do {
      try apply(unit, to: record)
    } catch {
      report([OPSyncFailure(unitId: recordID.recordName, willRetry: false, code: nil,
                            reason: "could not stage the payload: \(error.localizedDescription)")])
      return nil
    }
    return record
  }

  /// A unit's fields onto a record. The payload goes into a field, or into an
  /// asset when it is too large — chosen purely on byte count, so this stays
  /// ignorant of what it is carrying.
  private func apply(_ unit: SyncUnit, to record: CKRecord) throws {
    record["kind"] = unit.kind as CKRecordValue
    // A nil stamp CLEARS the field, which is what "unknown" should look like on
    // the server: `unit(from:)` reads it back as nil and it loses every conflict,
    // the same as it does locally. Writing a placeholder date instead would let
    // an unstamped unit win one.
    record["modifiedAt"] = unit.modifiedAt.map { $0 as CKRecordValue }

    let data = Data(unit.payload.utf8)
    if data.count > opSyncAssetThreshold {
      record["asset"] = CKAsset(fileURL: try Self.stage(data, for: record.recordID))
      // Clearing the other form is not tidiness: a record left holding both an
      // asset and a string would be read back by `unit(from:)` as the string,
      // which is now the stale one.
      record["payload"] = nil
    } else {
      record["payload"] = unit.payload as CKRecordValue
      record["asset"] = nil
    }
  }

  /// The inverse. Returns nil for a record missing both payload forms, which is
  /// a corrupt record rather than an empty unit.
  fileprivate func unit(from record: CKRecord) -> SyncUnit? {
    guard record.recordType == opSyncRecordType else { return nil }
    let kind = record["kind"] as? String ?? "plain"
    // No `?? ""` here. An absent stamp is nil, which is the same "unknown" the
    // JS side sends; `?? ""` parsed as no date at all and reached the same
    // answer by accident, through a value that means "the epoch of nothing".
    let modifiedAt = record["modifiedAt"] as? String

    if let payload = record["payload"] as? String {
      return SyncUnit(id: record.recordID.recordName, kind: kind,
                      payload: payload, modifiedAt: modifiedAt)
    }
    if let asset = record["asset"] as? CKAsset,
       let url = asset.fileURL,
       let data = try? Data(contentsOf: url),
       let payload = String(data: data, encoding: .utf8) {
      return SyncUnit(id: record.recordID.recordName, kind: kind,
                      payload: payload, modifiedAt: modifiedAt)
    }
    return nil
  }

  /// Large payloads go up as assets, and a `CKAsset` is a file URL that has to
  /// still be there when the engine actually uploads — which is later, on its
  /// own schedule. So they are staged on disk rather than held in memory.
  ///
  /// One file per record, named from the record id rather than a fresh UUID: the
  /// same unit re-staged overwrites its own file, which is what bounds the
  /// directory by the number of large units instead of by the number of pushes a
  /// long-running app has made. `.atomic` writes through a rename, so an upload
  /// already reading the old file keeps reading the old file.
  private static func stage(_ data: Data, for recordID: CKRecord.ID) throws -> URL {
    let directory = outbox
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // Record names carry `:` (`resume:<id>`, `key:resume-designer-data`), so they
    // are not filenames. Percent-encoding down to alphanumerics is total.
    let name = recordID.recordName
      .addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? UUID().uuidString
    let url = directory.appendingPathComponent(name)
    try data.write(to: url, options: .atomic)
    return url
  }

  private static var outbox: URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("op-sync-outbox", isDirectory: true)
  }

  fileprivate static func clearOutbox() {
    try? FileManager.default.removeItem(at: outbox)
  }
}

// MARK: - Conflict rule

extension OPSyncEngine {
  /// `resolveConflict` from src/sync/syncMerge.js, in Swift.
  ///
  /// It has to be the same rule to the letter: both devices run it, and a
  /// disagreement about who won is a resync that never settles. There, each side
  /// scores `Date.parse(modifiedAt)` with `-Infinity` for absent or unparseable,
  /// and local wins only on `>`. So, here: a nil or unreadable stamp never wins,
  /// a real stamp beats a nil one, two nils tie, and an exact tie goes to the
  /// server — arbitrary but computed identically on both devices.
  static func localWins(local: SyncUnit, server: SyncUnit) -> Bool {
    guard let localAt = timestamp(local.modifiedAt) else { return false }
    guard let serverAt = timestamp(server.modifiedAt) else { return true }
    return localAt > serverAt
  }

  /// Two parsers, the same pair OPShell.swift keeps for history dates:
  /// ISO8601DateFormatter fails outright on the option it was not given rather
  /// than ignoring it. Timestamps here are minted by JS's `toISOString()`, which
  /// ALWAYS carries milliseconds, and a stock formatter parses none of them — so
  /// a single default formatter would have returned nil for both sides of every
  /// conflict, tied them, and handed the server the win every time. The plain
  /// parser stays for any timestamp minted without them.
  static func timestamp(_ iso: String?) -> Date? {
    guard let iso else { return nil }
    return isoWithFraction.date(from: iso) ?? isoPlain.date(from: iso)
  }

  private static let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let isoPlain = ISO8601DateFormatter()
}

// MARK: - What survives a launch

/// Two things are persisted, both in `UserDefaults`, and neither is user data.
///
/// `CKSyncEngine` REQUIRES its state serialization to be handed back on the next
/// launch: the change tokens and the queue of pending changes live inside it,
/// and an engine handed nil starts over with no idea what the server has already
/// told it. The change-tag map is the same kind of thing at record granularity.
///
/// `UserDefaults` because this is device-local sync bookkeeping — the same
/// reason the change token lived there in the previous design — and deliberately
/// NOT a JS-side storage key. Those keys are the app's documents: `collectUnits`
/// collects them, a backup exports them, and this device's conversation with the
/// server would then be shipped to a device it does not describe.
extension OPSyncEngine {
  private static func stateKey(_ profileId: String) -> String { "op-sync-state-\(profileId)" }
  private static func recordsKey(_ profileId: String) -> String { "op-sync-records-\(profileId)" }

  fileprivate static func loadState(profileId: String) -> CKSyncEngine.State.Serialization? {
    guard let data = UserDefaults.standard.data(forKey: stateKey(profileId)) else { return nil }
    return try? JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: data)
  }

  fileprivate func saveState(_ serialization: CKSyncEngine.State.Serialization) {
    guard let profileId, let data = try? JSONEncoder().encode(serialization) else { return }
    UserDefaults.standard.set(data, forKey: Self.stateKey(profileId))
  }

  fileprivate static func loadSystemFields(profileId: String) -> [String: Data] {
    UserDefaults.standard.dictionary(forKey: recordsKey(profileId)) as? [String: Data] ?? [:]
  }

  fileprivate func saveSystemFields() {
    guard let profileId else { return }
    UserDefaults.standard.set(systemFields, forKey: Self.recordsKey(profileId))
  }

  /// Keep this record's system fields — id, zone, and the change tag that says
  /// which server version we are editing.
  fileprivate func remember(_ record: CKRecord) {
    let coder = NSKeyedArchiver(requiringSecureCoding: true)
    record.encodeSystemFields(with: coder)
    coder.finishEncoding()
    systemFields[record.recordID.recordName] = coder.encodedData
    saveSystemFields()
  }

  fileprivate func forget(_ recordID: CKRecord.ID) {
    guard systemFields.removeValue(forKey: recordID.recordName) != nil else { return }
    saveSystemFields()
  }

  /// An empty record carrying only the remembered system fields — which is
  /// exactly what a save needs as its base. `encodeSystemFields` writes no root
  /// object, so this is the decoder pair Apple documents for it rather than
  /// `NSKeyedUnarchiver.unarchivedObject(ofClass:from:)`, which would find
  /// nothing to unarchive.
  fileprivate func rememberedRecord(for recordID: CKRecord.ID) -> CKRecord? {
    guard let data = systemFields[recordID.recordName],
          let coder = try? NSKeyedUnarchiver(forReadingFrom: data)
    else { return nil }
    coder.requiresSecureCoding = true
    let record = CKRecord(coder: coder)
    coder.finishDecoding()
    return record
  }
}
