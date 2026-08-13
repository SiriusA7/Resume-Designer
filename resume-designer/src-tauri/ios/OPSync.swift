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

/// Asked to move data while the transport is down: `start(profileId:)` was
/// never called, or `stop()` has since taken it down.
///
/// `send` and `fetch` used to return quietly here, which is indistinguishable
/// from "sent" and "fetched, nothing new" to a caller whose only other channel
/// is the delegate — and the delegate says nothing either, because no engine
/// ran. They are `throws` functions; this is what they throw.
enum OPSyncError: Error, LocalizedError {
  case notStarted

  var errorDescription: String? {
    switch self {
    case .notStarted: return "Sync is not running."
    }
  }
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
  ///
  /// Returns whether EVERY unit handed over was applied. The transport keeps a
  /// record's change tag only on a `true` (see `deliver`), so this is not a
  /// progress report — it is the answer to "may this device claim to know which
  /// server version it is editing". Anything less than a confirmed full apply,
  /// including not being able to ask at all, is `false`.
  func syncDidFetch(_ units: [SyncUnit]) async -> Bool

  /// Units that LOST a conflict, for the caller to park in version history.
  /// Newer wins, and this is the older one — nothing is discarded silently.
  func syncDidLoseConflict(_ losers: [SyncUnit])

  /// Sends and fetches that did not land. See `OPSyncFailure`.
  func syncDidFail(_ failures: [OPSyncFailure])

  /// Sends and fetches that DID land, named the way `OPSyncFailure` names the
  /// ones that did not: a unit id, or nil for the ZONE or a fetch — which covers
  /// every unit in it.
  ///
  /// The counterpart to `syncDidFail`, and it exists because a warning raised by
  /// a failure otherwise has nothing that could ever take it down again. The
  /// good news is all on events this file already handles: `savedRecords` names
  /// the units a send landed, `savedZones` the zones, and a
  /// `didFetchRecordZoneChanges` carrying no error is a fetch that reached the
  /// server — Apple's header says so in as many words ("A nil value indicates a
  /// successful fetch").
  ///
  /// It says only that THESE names got through, never that sync is healthy. A
  /// caller that cleared every warning on any success would hide a unit that
  /// still cannot reach iCloud behind a unit that just did.
  func syncDidLand(_ unitIds: [String?])

  /// A DIFFERENT iCloud account is underneath the transport than the one this
  /// device last synced against — switched in Settings, or signed out and back
  /// in as somebody else.
  ///
  /// Nothing local is touched and nothing is deleted: a résumé belongs to the
  /// person, not to the account. What is true is that the new account has none
  /// of them — a unit reaches an account only when `send(unitIds:)` names it —
  /// so whatever the caller does about a full upload, it owes one again.
  ///
  /// NOT called for a sign-out, which has no account to owe anything to, or for
  /// the same account signing back in. See `handleAccountChange` for how those
  /// are told apart.
  func syncDidSwitchAccounts()
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

  /// Set by `remember`/`forget`, cleared by `flushSystemFields`. It exists so
  /// the map reaches `UserDefaults` once per engine event instead of once per
  /// record — see `flushSystemFields`.
  private var systemFieldsDirty = false

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
        stateSerialization: loadState(profileId: profileId),
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
    systemFieldsDirty = false
  }

  /// Queue units to go up, and send now.
  ///
  /// The scope is everything pending rather than just `unitIds`, on purpose: a
  /// unit whose last send failed for a transient reason was put back in the
  /// queue, and scoping to the ids named here would leave it sitting there until
  /// that same unit happened to be edited again.
  func send(unitIds: [String]) async throws {
    guard let engine, let zoneID else { throw OPSyncError.notStarted }
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
    guard let engine else { throw OPSyncError.notStarted }
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
    await owner?.handle(event, engine: syncEngine)
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

  /// Async because delivering fetched records is: `deliver` waits for the page
  /// to say whether it applied them, and the answer decides what happens to
  /// their change tags. `CKSyncEngine` awaits its delegate's `handleEvent`, so
  /// the event is not considered handled until that is settled — which is the
  /// point. `nextBatch` already suspends on the same bridge.
  fileprivate func handle(_ event: CKSyncEngine.Event, engine: CKSyncEngine) async {
    // Every path that touches the change-tag map runs under here, so this is
    // the one place that has to write it out — and writing it once per event
    // rather than once per record is the whole point of the dirty flag. It runs
    // after the suspensions below, so a tag settled by `deliver` is included.
    defer { flushSystemFields() }

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
      var arrivals: [Arrival] = []
      var unreadable: [OPSyncFailure] = []
      for modification in changes.modifications {
        let record = modification.record
        // DECODE FIRST. `remember` used to run before this check, and the two
        // in that order were a silent overwrite. A record that will not decode
        // is not hypothetical — it is an asset whose `fileURL` is nil because
        // the download did not finish, which is what every payload over
        // `opSyncAssetThreshold` travels as. It was dropped without a word, and
        // this device kept its change tag anyway; holding that tag makes the
        // NEXT save of that id a clean update, so it destroys the server copy
        // with no conflict raised and nothing parked.
        guard let unit = unit(from: record) else {
          // The tag goes with it. A tag is a claim to know which server version
          // this device is editing, and that cannot be true of content nobody
          // read. Without one the next save quotes no tag, CloudKit answers
          // `serverRecordChanged`, and the record comes back down the conflict
          // path where both copies are compared and the loser is parked.
          forget(record.recordID)
          unreadable.append(OPSyncFailure(
            unitId: record.recordID.recordName, willRetry: false, code: nil,
            reason: "a fetched record could not be read — most likely a large "
              + "payload whose asset did not finish downloading — and was not applied"
          ))
          continue
        }
        // Decoding it is not taking it. The record travels WITH its unit and
        // `deliver` decides its tag, once the page has answered.
        arrivals.append(Arrival(record: record, unit: unit))
      }
      // Reported, not swallowed: the engine's change token has already advanced
      // past these and there is no public way to rewind it, so the only thing
      // that can bring the record back down is something acting on this.
      //
      // Ahead of `deliver` rather than after it: `deliver` awaits the page, and
      // a page that is gone takes the full timeout to say so. Reporting first
      // costs nothing and keeps an unrelated failure from waiting behind it.
      report(unreadable)
      await deliver(arrivals)

    case .sentRecordZoneChanges(let sent):
      // The saved records come back carrying their NEW change tags. Recording
      // them is what makes the next save of the same unit a clean update rather
      // than a conflict.
      for record in sent.savedRecords { remember(record) }
      // A unit that saved is a unit that reached iCloud, which is the only thing
      // that can honestly take down a warning raised against THAT unit. Ahead of
      // the failures below so that a batch which both saved and failed ends with
      // the failure standing — the two lists name different records, so this is
      // an ordering rule rather than a conflict.
      land(sent.savedRecords.map(\.recordID.recordName))
      await handleFailedSaves(sent.failedRecordSaves, engine: engine)

    case .sentDatabaseChanges(let sent):
      // A zone that would not save takes every unit in it with it, so it is put
      // back and reported against no unit in particular. The same split as in
      // `handleFailedSaves` applies to `pendingDatabaseChanges` — the engine
      // keeps the retryable ones itself — but `add` deduplicates, so putting one
      // back unconditionally costs nothing and covers the rest.
      for failure in sent.failedZoneSaves {
        engine.state.add(pendingDatabaseChanges: [.saveZone(failure.zone)])
      }
      // A zone that saved is the good news that matches a failure reported
      // against no unit in particular, and it is named the same way — nil, the
      // whole zone. Before the report for the same reason as above.
      if !sent.savedZones.isEmpty { land([nil]) }
      report(sent.failedZoneSaves.map { failure in
        OPSyncFailure(unitId: nil, willRetry: true, code: failure.error.code,
                      reason: failure.error.localizedDescription)
      })

    case .didFetchRecordZoneChanges(let done):
      guard let error = done.error else {
        // The other zone-wide good news: this fetch reached the server and got
        // everything it asked for.
        land([nil])
        break
      }
      // A zone that is not there is not a failure: it is the first sync, before
      // anything has been sent. It is not success either — a zone save that is
      // still queued is exactly the failure a nil unit id stands for, and this
      // is the server agreeing it has not happened yet — so it neither reports
      // nor lands. Everything else the caller should hear about.
      if error.code != .zoneNotFound, error.code != .userDeletedZone {
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
  /// A different account also OWES A FULL UPLOAD, for the same reason turning
  /// sync on does: a unit reaches an account only when `send(unitIds:)` names
  /// it, and only a local edit names one, so everything not edited since the
  /// switch would simply never appear in the new container. That is the same
  /// failure the full-upload marker exists to close, one dimension over, and it
  /// is the host's to record because the host owns the debt.
  ///
  /// Told apart from a plain sign-out and back in BY NAME, which is the whole
  /// reason the last account's record name is persisted here: signing back into
  /// the same account owes nothing, and re-uploading every workspace for it
  /// would be pure waste. The event cannot answer that on its own — a `signIn`
  /// carries no `previousUser`, by documentation — and the sign-out that
  /// preceded it can be a launch or a week earlier, so an in-memory answer would
  /// be no answer at all. Free, though: both names arrive ON the events, so
  /// nothing here asks CloudKit for `userRecordID` or touches the network.
  ///
  /// A name this device never recorded counts as DIFFERENT. That is the one
  /// guess in here and it is deliberately the wasteful direction: an unneeded
  /// full upload costs bandwidth once, a skipped one is a workspace that is
  /// silently not in iCloud.
  ///
  /// `switchAccounts` does not consult the name at all — CloudKit is asserting
  /// the account changed, and no comparison this side makes is more
  /// authoritative than that.
  ///
  /// The debt is recorded, never paid, here: nothing in this file re-enters the
  /// engine from an event, and the next start offers the collection. Coming back
  /// from the Settings app — the only place an account is switched — is a start.
  ///
  /// The engine's own state serialization is left to the engine, which reissues
  /// it through `stateUpdate`.
  private func handleAccountChange(_ change: CKSyncEngine.Event.AccountChange.ChangeType) {
    switch change {
    case .signIn(let currentUser):
      let last = Self.lastAccount()
      // The same account coming back. Its tags went with the sign-out and its
      // records are exactly where this device left them, so there is nothing to
      // drop and nothing to re-offer.
      //
      // THE ONLY BRANCH HERE THAT CAN BE SILENTLY WRONG, so it is the only one
      // that has to earn its silence. A name is trusted only if it is a real
      // per-account id: CloudKit spells "whoever is signed in" with the
      // placeholder `CKCurrentUserDefaultName` elsewhere in its API, and if that
      // ever reached here, signing out of one account and into another would
      // compare placeholder to placeholder and suppress the re-offer — leaving
      // the new account permanently missing everything not edited since. So a
      // placeholder counts as unknown, and unknown re-offers.
      let recognised = last != nil
        && last != CKCurrentUserDefaultName
        && currentUser.recordName != CKCurrentUserDefaultName
        && last == currentUser.recordName
      Self.rememberAccount(currentUser)
      guard !recognised else { break }
      dropChangeTags()
      host?.syncDidSwitchAccounts()
    case .signOut(let previousUser):
      // WHICH account this device was synced against, for the sign-in that
      // eventually follows it.
      Self.rememberAccount(previousUser)
      dropChangeTags()
    case .switchAccounts(_, let currentUser):
      // Deliberately does NOT consult the stored name: CloudKit is asserting the
      // change, so this branch holds even if the record names turn out to carry
      // nothing useful.
      dropChangeTags()
      host?.syncDidSwitchAccounts()
      // AFTER the re-offer, not before. A crash between the two would otherwise
      // leave the new name stored with no debt recorded, and the next launch
      // would recognise the account and suppress. This order fails to a wasted
      // upload instead of a missing one.
      Self.rememberAccount(currentUser)
    @unknown default:
      // A case that does not exist yet still changed something about the
      // account, and `break` would neither drop the tags nor re-offer — the
      // silent direction. Treated as a switch.
      dropChangeTags()
      host?.syncDidSwitchAccounts()
    }
  }

  /// Bookkeeping about one account's server, dropped when that account is no
  /// longer the one underneath. Written out by `handle`'s `defer`.
  private func dropChangeTags() {
    systemFields = [:]
    systemFieldsDirty = true
  }

  private func handleFailedSaves(
    _ failures: [CKSyncEngine.Event.SentRecordZoneChanges.FailedRecordSave],
    engine: CKSyncEngine
  ) async {
    var arrived: [Arrival] = []
    var losers: [SyncUnit] = []
    var reported: [OPSyncFailure] = []

    // WHAT THE ENGINE HAS ALREADY DONE WITH THESE, because the shape of every
    // branch below depends on it and half an answer is worse than none.
    //
    // `CKSyncEngine` keeps a failed change in `state.pendingRecordZoneChanges`
    // when — and only when — the error is one it documents as handling itself.
    // CKSyncEngineState.h states the rule for the queue directly: it removes a
    // change once it sends it, and "if it fails to send a change due to some
    // retryable error (e.g. a network failure), it keeps that change in this
    // list". CKSyncEngine.h's "Error Handling" section names that set exactly,
    // and it is seven codes: notAuthenticated, accountTemporarilyUnavailable,
    // networkFailure, networkUnavailable, requestRateLimited, serviceUnavailable
    // and zoneBusy. Everything else is what Apple calls application-specific —
    // the engine drops the change and hands the error here.
    //
    // So the seven are left where they are, and every other error that deserves
    // another go is put back by hand. Re-adding one of the seven would not be
    // merely redundant: `add(pendingRecordZoneChanges:)` schedules a send when
    // none is scheduled, which is the one thing the engine's backoff exists to
    // avoid. Anything not put back is a decision to stop, and that is what
    // `willRetry: false` means on the way out.
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

        if Self.localWins(local: localUnit, server: serverUnit) {
          // Ours is newer. The server's copy is the only place its current
          // change tag exists, so it is recorded before the retry is queued: a
          // retry built without it is the fresh-record bug from the file
          // header, in exactly the case a conflict has just proved is live.
          // `recordToSend` now builds on that tag, so the retry is an update
          // rather than another conflict.
          remember(serverRecord)
          engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
          losers.append(serverUnit)
        } else {
          // Theirs is newer, or the two tie and the tie goes to the server so
          // both devices break it the same way — otherwise they converge on
          // different winners and sync forever.
          //
          // NOT remembered here: this device is about to take the server's
          // content, and the tag is a claim to hold it. `deliver` records it if
          // and only if the page says it landed — the same rule the fetch path
          // runs under, and for the same reason.
          arrived.append(Arrival(record: serverRecord, unit: serverUnit))
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

      case .notAuthenticated, .accountTemporarilyUnavailable, .networkFailure,
           .networkUnavailable, .requestRateLimited, .serviceUnavailable,
           .zoneBusy:
        // The seven above. The change is still queued and the engine owns the
        // backoff, so saying so is the whole of this side's job. `notAuthenticated`
        // in particular used to fall through to `default` and be dropped as
        // permanent — it is not: the account can come back, and the engine is
        // already waiting for it.
        reported.append(OPSyncFailure(unitId: recordID.recordName, willRetry: true,
                                      code: error.code,
                                      reason: error.localizedDescription))

      case .operationCancelled, .serverResponseLost:
        // Transient too — a cancelled operation is the app going to the
        // background or `stop()` being called, and a lost response is a request
        // whose outcome is simply unknown — but neither is on the engine's list,
        // so the change is off the queue and this side puts it back. Dropping
        // them as permanent, which is what `default` did, lost a local edit
        // until the unit happened to be edited again.
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

    await deliver(arrived)
    if !losers.isEmpty { host?.syncDidLoseConflict(losers) }
    report(reported)
  }

  /// Hand records that arrived from the server to the page, and keep their
  /// change tags only if the page took them.
  ///
  /// THE ONE PLACE a fetched record's tag is stored, which is what makes the
  /// invariant checkable rather than remembered: a change tag is a claim to
  /// know which server version this device is editing, and this device may only
  /// make that claim about content it actually holds.
  ///
  /// Two things falsify the claim and they are one bug, one layer apart. A
  /// record that would not DECODE never reaches here — its caller forgets the
  /// tag on the spot. A record the PAGE would not apply is the same failure
  /// after a longer trip: the apply is a round trip into JavaScript, and WebKit
  /// reclaims the content process of a backgrounded app, so a fetch landing
  /// while the webview reloads is answered by nobody. Remembering first and
  /// asking second — which is what this used to do — left this device holding
  /// tags for content it never took, and its next save of those units was then a
  /// clean, uncontested update that destroyed the server's newer copy, with no
  /// conflict raised, nothing parked and nothing logged.
  ///
  /// ALL OR NOTHING, deliberately. `applied` is a COUNT, not a set of ids, so
  /// the only honest reading of a short count is "which ones landed is unknown".
  /// The optimisation to resist is inventing per-id tracking to save a round
  /// trip: this bug class keeps coming back through exactly that kind of
  /// cleverness, and the trip it saves is worth nothing. Over-forgetting costs
  /// one — the next save quotes no tag, CloudKit answers `serverRecordChanged`,
  /// and the record comes back down the conflict path where both copies are
  /// compared and the loser is parked, so nothing is lost either way.
  /// Under-forgetting is the silent overwrite above.
  ///
  /// Nothing is reported, and that is not the same as nothing happening.
  /// `syncDidFail`'s recovery re-queues a SEND immediately, and a page that
  /// could not be reached to apply cannot be reached to be asked for a unit
  /// either — it would spend this session's one recovery attempt (see
  /// `syncDidFail` in OPShell.swift) on a webview that is still gone. The unit
  /// ids are held by the HOST instead, in the same set an edit made while the
  /// transport was down waits in, and offered again at the next start — which is
  /// a foreground or an activation, by which time the page is back. See
  /// `syncDidFetch` in OPShell.swift, which does that on its own answer rather
  /// than being told to from here: it is the side that knows the apply failed.
  ///
  /// Either way the tag is forfeited, so the next save of these units meets the
  /// conflict path. That is what makes the re-offer safe as well as useful: the
  /// send quotes no tag, CloudKit answers `serverRecordChanged`, both copies are
  /// compared and the loser is parked in version history. It costs one round
  /// trip and cannot lose content whichever copy wins.
  ///
  /// Awaiting the page suspends the event this runs inside. `nextRecordZoneChangeBatch`
  /// is not an event, so it is NOT serialized against that suspension and a send
  /// batch can be built from tags this call has not settled yet. That is safe and
  /// is not worth closing: `recordToSend` only READS the tag map, so the worst it
  /// can do is quote a stale tag or none — which CloudKit answers
  /// `serverRecordChanged`, routing it down the conflict path where both copies
  /// are compared. It fails toward an extra round trip, never toward an overwrite.
  private func deliver(_ arrivals: [Arrival]) async {
    guard !arrivals.isEmpty else { return }
    let applied = await host?.syncDidFetch(arrivals.map(\.unit)) ?? false
    for arrival in arrivals {
      if applied { remember(arrival.record) } else { forget(arrival.recordID) }
    }
  }

  private func report(_ failures: [OPSyncFailure]) {
    guard !failures.isEmpty else { return }
    host?.syncDidFail(failures)
  }

  /// `report`'s opposite, and deliberately as small: what got through, by the
  /// same name a failure would have carried. See `syncDidLand`.
  private func land(_ unitIds: [String?]) {
    guard !unitIds.isEmpty else { return }
    host?.syncDidLand(unitIds)
  }
}

/// A record from the server travelling with the unit decoded out of it, from the
/// moment it is read to the moment `deliver` settles its change tag.
///
/// The pair is the point: the unit is what the page is offered and the record is
/// what carries the tag, so anything holding one without the other can only
/// store a tag it cannot justify.
private struct Arrival {
  let record: CKRecord
  let unit: SyncUnit

  var recordID: CKRecord.ID { record.recordID }
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
      return await self.recordToSend(recordID, engine: engine)
    }
  }

  /// The record for one queued unit, built at SEND time.
  ///
  /// Returning nil SKIPS the change for this batch — `CKSyncEngineRecordZoneChangeBatch`
  /// documents exactly that, and skipping is not removing: the change stays in
  /// `pendingRecordZoneChanges` and is asked for again on the next send, and the
  /// next, forever. Both nil paths here are final answers, so both take the
  /// change off the queue themselves, which is what Apple's own CKSyncEngine
  /// sample does in this branch and what makes the reported `willRetry: false`
  /// true. It is still a dropped SEND and never a delete — the server keeps
  /// whatever it already holds, because absence is not deletion here.
  private func recordToSend(_ recordID: CKRecord.ID, engine: CKSyncEngine) async -> CKRecord? {
    guard let unit = await host?.syncUnit(withId: recordID.recordName) else {
      // This device has nothing under that id, and nothing will build one
      // later either, so leaving it queued is a question re-asked on every
      // send for the life of the app.
      engine.state.remove(pendingRecordZoneChanges: [.saveRecord(recordID)])
      return nil
    }
    // The record as it was last seen on the server, change tag and all. Without
    // it this is a brand-new CKRecord with no tag, which the engine's
    // `.ifServerRecordUnchanged` save policy rejects as a conflict every single
    // time — see the file header.
    let record = rememberedRecord(for: recordID)
      ?? CKRecord(recordType: opSyncRecordType, recordID: recordID)
    do {
      try apply(unit, to: record)
    } catch {
      // Staging the payload on disk failed. The next send would fail the same
      // way, so the change comes off the queue and the caller is told — which
      // is the only arrangement in which `willRetry: false` is a true statement
      // about what happens next.
      engine.state.remove(pendingRecordZoneChanges: [.saveRecord(recordID)])
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
  /// NOT per profile: an iCloud account is a property of the device, and every
  /// profile's zone lives in whichever one is signed in.
  private static let accountKey = "op-sync-icloud-account"

  /// The record name of the iCloud user this device last synced against, or nil
  /// if it has never recorded one. See `handleAccountChange`: nil is read as a
  /// different account, not as the same one.
  ///
  /// A user record id is per container and per account, so it is exactly the
  /// identity being asked about. It is stored as its `recordName` because that
  /// is the whole of it that is compared, and a String is what `UserDefaults`
  /// holds without an archiver.
  fileprivate static func lastAccount() -> String? {
    UserDefaults.standard.string(forKey: accountKey)
  }

  fileprivate static func rememberAccount(_ user: CKRecord.ID) {
    UserDefaults.standard.set(user.recordName, forKey: accountKey)
  }

  /// Absent state is normal — the first launch for a profile. Absent state
  /// because it would not DECODE is not, and it is not a small thing either: the
  /// change tokens live in there, so a nil return means fetching the whole zone
  /// again and re-sending every pending change. Silence would make that look
  /// like a slow first sync forever.
  fileprivate func loadState(profileId: String) -> CKSyncEngine.State.Serialization? {
    guard let data = UserDefaults.standard.data(forKey: Self.stateKey(profileId)) else { return nil }
    do {
      return try JSONDecoder().decode(CKSyncEngine.State.Serialization.self, from: data)
    } catch {
      report([OPSyncFailure(
        unitId: nil, willRetry: false, code: nil,
        reason: "the stored sync state could not be read, so this device is "
          + "starting over and will refetch everything: \(error.localizedDescription)"
      )])
      return nil
    }
  }

  fileprivate func saveState(_ serialization: CKSyncEngine.State.Serialization) {
    guard let profileId else { return }
    do {
      UserDefaults.standard.set(try JSONEncoder().encode(serialization),
                                forKey: Self.stateKey(profileId))
    } catch {
      report([OPSyncFailure(
        unitId: nil, willRetry: false, code: nil,
        reason: "the sync state could not be saved, so the next launch will "
          + "refetch and re-send everything: \(error.localizedDescription)"
      )])
    }
  }

  fileprivate static func loadSystemFields(profileId: String) -> [String: Data] {
    UserDefaults.standard.dictionary(forKey: recordsKey(profileId)) as? [String: Data] ?? [:]
  }

  /// Write the map out, if it changed. Called once per engine event by
  /// `handle`, never per record: `remember` used to write the WHOLE dictionary
  /// on every call, so a fetch carrying a hundred records rewrote it a hundred
  /// times, inside the loop.
  private func flushSystemFields() {
    guard systemFieldsDirty, let profileId else { return }
    systemFieldsDirty = false
    UserDefaults.standard.set(systemFields, forKey: Self.recordsKey(profileId))
  }

  /// Keep this record's system fields — id, zone, and the change tag that says
  /// which server version we are editing. In memory; `handle` flushes.
  fileprivate func remember(_ record: CKRecord) {
    let coder = NSKeyedArchiver(requiringSecureCoding: true)
    record.encodeSystemFields(with: coder)
    coder.finishEncoding()
    systemFields[record.recordID.recordName] = coder.encodedData
    systemFieldsDirty = true
  }

  fileprivate func forget(_ recordID: CKRecord.ID) {
    guard systemFields.removeValue(forKey: recordID.recordName) != nil else { return }
    systemFieldsDirty = true
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
