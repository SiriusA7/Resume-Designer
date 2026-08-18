// CloudKit transport. Zones, records, conflicts — driven by `CKSyncEngine`.
//
// **This file never parses a payload.** A unit crosses as
// `{ id, kind, payload, modifiedAt, profileId }` with `payload` an opaque JSON string,
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
  /// "resume" | "plain" | "tokenUsage" — a description of the payload's shape,
  /// carried on the record and read by nothing in this file.
  ///
  /// It was written down as "enough to route a conflict without understanding
  /// the contents", and that was never true and could not have been: which
  /// units take newer-wins and which take a UNION is a property of what the app
  /// does with them, and no three-way label decides it — see `accumulatorFor`
  /// (src/sync/syncModel.js), which is the one list that does. Conflicts are now
  /// routed there, off the unit id, so this branches nowhere on purpose rather
  /// than by omission.
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
  /// so it loses to any real stamp and two unknowns tie. NOTHING IN THIS FILE
  /// COMPARES IT: that rule has one copy and it is the model's.
  ///
  /// Encoding drops the key rather than writing `null` — `Codable`'s synthesised
  /// `encode` uses `encodeIfPresent` for optionals — and the stamp IS read on
  /// the way out now, by the fetch path's recency guard and by a conflict's
  /// comparison. It is still faithful: `resolveConflict` reads an absent field
  /// and an explicit `null` the same way, as -Infinity, which is what "unknown"
  /// has to score at both ends.
  let modifiedAt: String?
  /// The profile zone a FETCHED record arrived in, or `""` for the account's
  /// shared zone. This reports a fact carried by `CKRecord.ID`; it does not
  /// interpret the unit id or decide where an outbound unit belongs. That
  /// decision remains the page's answer through `syncScopes`.
  let profileId: String

  /// Workspace and id together — what actually identifies one record, since the
  /// same unit id exists in every workspace's zone. See `SyncResolution.route`.
  var route: String { "\(profileId)\u{1F}\(id)" }

  init(id: String, kind: String, payload: String, modifiedAt: String?, profileId: String = "") {
    self.id = id
    self.kind = kind
    self.payload = payload
    self.modifiedAt = modifiedAt
    self.profileId = profileId
  }

  private enum CodingKeys: String, CodingKey {
    case id, kind, payload, modifiedAt, profileId
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    kind = try values.decode(String.self, forKey: .kind)
    payload = try values.decode(String.self, forKey: .payload)
    modifiedAt = try values.decodeIfPresent(String.self, forKey: .modifiedAt)
    // Units asked from the page are outbound and predate this arrival-only
    // field. Their zone is still chosen exclusively from `syncScopes`.
    profileId = try values.decodeIfPresent(String.self, forKey: .profileId) ?? ""
  }

  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(id, forKey: .id)
    try values.encode(kind, forKey: .kind)
    try values.encode(payload, forKey: .payload)
    try values.encodeIfPresent(modifiedAt, forKey: .modifiedAt)
    try values.encode(profileId, forKey: .profileId)
  }
}

/// A save conflict as it crosses to the model: the version this device tried to
/// send and the version the server answered with, both opaque.
///
/// BOTH SIDES TRAVEL, and that is the whole of the correction. The transport
/// used to compare `modifiedAt` here and pick a winner for every kind, which was
/// a second copy of `resolveConflict` (src/sync/syncMerge.js) — a rule both
/// devices must compute identically — and it was wrong outright for the two
/// units that do not take newer-wins: token usage and version history UNION, and
/// a union has no loser to park. Deciding which of those a unit is means knowing
/// what a unit is, which is exactly the knowledge this file does not have.
struct SyncConflict: Encodable, Equatable {
  let local: SyncUnit
  let server: SyncUnit
}

/// What the model did with one conflict.
struct SyncResolution: Equatable {
  /// The unit id. A conflict whose id is ABSENT from the answer was refused —
  /// see `resolve`, which forfeits its change tag.
  let id: String
  /// The workspace whose zone that conflict came from, `""` for the shared one.
  ///
  /// An id alone does not identify a conflict. One send can carry the same id
  /// from several zones — every workspace has a `data:settings` — so answers
  /// keyed by id collapsed into one, applying one workspace's decision to
  /// another's conflict. A REFUSAL matched to another's acceptance is the worse
  /// half: it leaves a change tag held for content this device does not have.
  let profileId: String
  /// Whether the SERVER still owes an update. True for a union (the merged
  /// document has to go up) and for a snapshot this device won; false for a
  /// snapshot the server won, where re-sending would push this device's stamp
  /// back over the version it has just taken.
  let retry: Bool

  /// How `resolve` matches an answer to the conflict that produced it.
  var route: String { "\(profileId)\u{1F}\(id)" }
}

/// The model's answer for a batch of conflicts.
struct SyncConflictOutcome: Equatable {
  let resolved: [SyncResolution]
  /// How many losers reached a version history — the only thing the conflict
  /// notice is raised on. NOT the number of conflicts: a union parks nothing
  /// because it loses nothing, and a snapshot whose loser is not a résumé has
  /// nowhere to park one.
  let parked: Int

  /// Every conflict refused, which is what every way of not knowing comes to.
  static let unresolved = SyncConflictOutcome(resolved: [], parked: 0)
}

/// Payloads larger than this go to a CKAsset. CloudKit caps a record's fields
/// at roughly 1MB; the headroom covers the other fields and encoding overhead,
/// so the decision never has to be revisited at the boundary.
let opSyncAssetThreshold = 700 * 1024

/// The zone holding units that describe the workspace SET rather than any one
/// workspace. Its name is a fixed literal and never derived, so a device that
/// knows nothing can still fetch it — that is the whole point. The profile
/// registry lives here, and a clean install needs the registry to learn which
/// profile zones exist at all.
///
/// It cannot collide with a profile zone: `generateProfileId()` returns
/// `p` + base36 timestamp + suffix, so every profile zone name begins with `p`.
/// It is not a reserved name either — CloudKit reserves the leading underscore,
/// which this does not use.
let opSharedZoneName = "opShared"

/// The model's word for a unit that belongs in the zone above. The vocabulary is
/// `keyScope`'s (src/sync/syncKeys.js); anything else — including no answer for
/// an id at all — is profile-scoped, which is what every unit was before this
/// zone existed.
let opSharedScope = "shared"

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
  /// The workspace this failed out of: "" for the shared zone, a profile id for
  /// a workspace's own. Every failure has one, including the zone-and-fetch
  /// failures — those name the zone they happened in, which is the whole point
  /// of them.
  ///
  /// Carried because a unit id is NOT an identity. Every workspace has a
  /// `data:settings`, and one engine session covers every zone, so a bare
  /// record name says which record only by accident. The host recovers a
  /// non-retryable failure by re-sending the unit, and re-sending it without
  /// this sent the OPEN workspace's unit to the OPEN zone: the failed record
  /// stayed un-recovered in a zone nobody named, and — for an unreadable
  /// fetched asset, whose change token has already advanced past it — the
  /// content stayed unavailable locally until that workspace was next edited.
  /// A `CKRecord.ID` has always carried its zone; this was simply dropping it.
  let profileId: String
  /// Whether the transport put the change back in the queue. `false` means
  /// nothing more will be attempted until the unit is edited again, which is
  /// the only case worth telling the user about.
  let willRetry: Bool
  /// nil when the failure was local (staging an asset on disk) rather than the
  /// server's answer.
  let code: CKError.Code?
  /// Diagnostic — for a log line or a status line, never for a decision.
  let reason: String
  /// This one needs the HOST to persist the retry, because nothing else will.
  ///
  /// `willRetry` usually means the engine kept the change and owns the backoff.
  /// A direct refetch is outside the engine entirely, and the send it recovers
  /// was already dropped — so a transient failure there has nothing holding it,
  /// and `willRetry: true` alone would be a statement about nobody. The host
  /// puts the id in that profile's durable deferred queue; draining it
  /// re-enters `recordToSend`, finds no local unit again, and refetches. The
  /// loop closes.
  let needsDurableRetry: Bool

  /// No default for `profileId`, deliberately. Every failure knows its zone —
  /// the record carries one and so does the fetch — and a default would let the
  /// next site added quietly answer "" (the SHARED zone) for a workspace's own
  /// failure. That silent wrong answer is this bug, and it has now been written
  /// four separate times in this file; a missing argument should not compile.
  /// `needsDurableRetry` DOES default, and to the safe answer: the engine holds
  /// its own retries, so only the one path outside it has to ask.
  init(unitId: String?, profileId: String, willRetry: Bool,
       code: CKError.Code?, reason: String, needsDurableRetry: Bool = false) {
    self.unitId = unitId
    self.profileId = profileId
    self.willRetry = willRetry
    self.needsDurableRetry = needsDurableRetry
    self.code = code
    self.reason = reason
  }

  /// What this failure NAMES — see `OPSyncScope`.
  var scope: OPSyncScope { OPSyncScope(profileId: profileId, unitId: unitId) }
}

/// What a failure or a landing names: one unit in one workspace, or a whole
/// workspace's zone (`unitId == nil`, which stands for every unit in it).
///
/// ONE type for both directions, because they are a matched pair. The status
/// line stands behind a failure until the same thing lands, so "the same thing"
/// has to mean the same key on both sides — and a bare record name is not one.
/// Every workspace has a `data:settings`, so workspace A's save landing took
/// down workspace B's outstanding warning and Settings reported sync healthy
/// while B had never reached iCloud. The zone entries collapsed further still:
/// every zone in the session shared the single nil key, so any one zone's fetch
/// succeeding cleared all of them.
struct OPSyncScope: Hashable {
  /// "" for the shared zone; a profile id for a workspace's own.
  let profileId: String
  /// nil for the zone itself — a zone save or a fetch — which covers every unit
  /// in it, and is therefore a different thing from any one of them.
  let unitId: String?

  /// The zone as a whole, which is what a fetch or a zone save answers for.
  static func zone(_ zoneID: CKRecordZone.ID) -> OPSyncScope {
    OPSyncScope(profileId: opProfileId(forZone: zoneID), unitId: nil)
  }

  /// One record, named by the zone it actually lives in.
  static func record(_ recordID: CKRecord.ID) -> OPSyncScope {
    OPSyncScope(profileId: opProfileId(forZone: recordID.zoneID),
                unitId: recordID.recordName)
  }
}

/// The workspace a zone holds: "" for the shared one, whose contents belong to
/// no single workspace. Zone names ARE profile ids by construction — `start`
/// creates one zone per profile and names it after the profile — so this is a
/// read of an identity that was decided when the change was queued, not a guess.
private func opProfileId(forZone zoneID: CKRecordZone.ID) -> String {
  zoneID.zoneName == opSharedZoneName ? "" : zoneID.zoneName
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
  /// `CKSyncEngine` delivers delegate events serially and forbids methods that
  /// can generate another event while `handleEvent` is still in flight. The
  /// caller durably holds the ids and the delegate wrapper retries them after
  /// the current event has returned.
  case eventInFlight
  /// The model could not be asked which zone these units belong in — the page is
  /// gone, or still reloading. NOT the same as "they are all profile-scoped":
  /// the shared zone exists so that a device which knows nothing can still find
  /// the registry, and a registry saved into a profile zone is invisible to
  /// exactly that device. Refusing costs a retry; guessing costs the feature.
  /// The caller holds the ids for the next start, as it does for `notStarted`.
  case scopeUnknown

  var errorDescription: String? {
    switch self {
    case .notStarted: return "Sync is not running."
    case .eventInFlight: return "Sync postponed a send until the current event finishes."
    case .scopeUnknown: return "The page did not say which zone these units belong in."
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
  ///
  /// `inProfile` is the workspace to read from, taken from the record's own
  /// zone by `recordToSend` — `""` for the shared zone, which has no workspace
  /// of its own. It is a route, not a classification: this side still never
  /// decides what a unit id means.
  func syncUnit(withId id: String, inProfile profileId: String) async -> SyncUnit?

  /// Which zone each of these units belongs in — `opSharedScope` or anything
  /// else for the profile's own zone — keyed by unit id.
  ///
  /// ASKED, because the answer follows from what a unit IS and this file holds
  /// no such knowledge. A `hasPrefix` on the id here would be the transport
  /// reading a unit's meaning out of its name, which is the boundary the
  /// conflict rule was moved across (see `SyncConflict`); `unitScopes`
  /// (src/sync/syncModel.js) answers from the same `keyScope` that stamps the
  /// unit when it is collected, so a unit cannot be queued into one zone and
  /// built as if it belonged in the other.
  ///
  /// Asked at QUEUE time rather than at send time, unlike everything else about
  /// a unit, because a `CKRecord.ID` carries its zone: by the time
  /// `recordToSend` has the unit in hand the zone is already chosen.
  ///
  /// An id MISSING from the answer is profile-scoped. `nil` is not that — it is
  /// the page not answering at all, and the send is refused rather than guessed,
  /// because a registry that lands in a profile zone is one a clean device
  /// cannot find.
  func syncScopes(forUnitIds ids: [String]) async -> [String: String]?

  /// Units that arrived from another device.
  ///
  /// Returns whether EVERY unit handed over was applied. The transport keeps a
  /// record's change tag only on a `true` (see `deliver`), so this is not a
  /// progress report — it is the answer to "may this device claim to know which
  /// server version it is editing". Anything less than a confirmed full apply,
  /// including not being able to ask at all, is `false`.
  /// The ROUTES (`SyncUnit.route`) of every unit the page accounted for: the
  /// ones it wrote, plus the ones it settled because nothing will ever land
  /// them — its own copy is newer, the payload is unreadable, the key is this
  /// device's own. Everything absent from the answer was refused and must be
  /// delivered again, so its change tag is forfeited.
  ///
  /// Per unit rather than a batch verdict, because the two outcomes are routine
  /// in the SAME delivery and a single answer for all of them cannot be right
  /// for either.
  func syncDidFetch(_ units: [SyncUnit]) async -> Set<String>

  /// BOTH versions of every unit whose save hit `serverRecordChanged`, handed to
  /// the model to resolve.
  ///
  /// The transport does not compare them and does not choose. A snapshot takes
  /// newer-wins and an append-shaped unit takes a UNION, and only the side that
  /// knows what a unit is can tell those apart — or tell that a union has no
  /// loser to park. This is also where the older version reaches version
  /// history: parking is part of resolving, not a separate errand run afterwards
  /// on whichever side happened to be told.
  ///
  /// The answer names the units the model resolved DURABLY, and that is what the
  /// transport keeps the server's change tag on — the same question
  /// `syncDidFetch` answers, in the same terms. Anything less, including not
  /// being able to ask, is an empty answer.
  func syncDidConflict(_ conflicts: [SyncConflict]) async -> SyncConflictOutcome

  /// A send was refused while a delegate event was in flight and its ids are
  /// now durable. Called on a later main-actor turn, after `handleEvent` has
  /// returned, so the host can drain that profile's deferred queue safely.
  func syncRetryDeferred(profileId: String) async

  /// Sends and fetches that did not land. See `OPSyncFailure`.
  func syncDidFail(_ failures: [OPSyncFailure])

  /// Sends and fetches that DID land, named the way `OPSyncFailure` names the
  /// ones that did not — as an `OPSyncScope`: a unit in a workspace, or a whole
  /// zone. The two sides MUST agree on the naming, or the status line stands
  /// behind a failure that nothing can take down, or takes one down that is
  /// still true.
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
  func syncDidLand(_ scopes: [OPSyncScope])

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

  /// THE OWNER OF THE ICLOUD ACCOUNT DELETED THIS APP'S DATA FROM IT.
  ///
  /// The one signal in this design that is not "absence", and the one place the
  /// rule that absence is never deletion has to yield. That rule exists so a
  /// sync bug cannot delete a résumé; it was never meant to overrule the
  /// account's owner giving an instruction in the Settings app. Apple requires
  /// the app to delete its locally cached data and NOT resend it
  /// (CKSyncEngineEvent.h, `CKSyncEngineZoneDeletionReasonPurged`).
  ///
  /// Reached three ways, all of them the same instruction: a fetched zone
  /// deletion whose reason is `.purged` or `.encryptedDataReset`, and a
  /// `.userDeletedZone` error, which CKError.h defines as "the user deletes a
  /// record zone using the Settings app".
  ///
  /// Everything this device cached ABOUT iCloud is gone by the time this is
  /// called — change tags, pending sends, the queued zone creation. What the
  /// caller must not do is put it back: this transport recreates its zone on
  /// every `start`, so a caller that merely stopped would resend the whole
  /// workspace at the next launch. The one thing that is NOT deleted, here or
  /// by the caller, is the person's content: they emptied their iCloud, which
  /// is not the same instruction as erasing the résumés on a device they are
  /// holding.
  func syncDidPurgeFromICloud()
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
  private var profileZoneIDs: [CKRecordZone.ID] = []
  /// `opSharedZoneName`'s zone, alongside every profile's for the whole life of
  /// an engine session. Held rather than rebuilt at each use so all zones are
  /// always set and cleared together.
  private var sharedZoneID: CKRecordZone.ID?

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

  /// Records THIS DEVICE could not read, which are the only ones a missing
  /// local unit justifies re-fetching.
  ///
  /// `syncUnit` returning nil does not mean "there is nothing here". Its most
  /// common cause is the ten-second bound against a webview that is still
  /// reloading, and its own comment says so. Re-fetching on that signal made
  /// every unanswered send pull the whole record back — the multi-megabyte
  /// asset included — and hand it to the same dead page, which refused it and
  /// re-owed the id. That voided the documented terminator for the retry loop
  /// ("a page that answers 'I have nothing under that id' makes `recordToSend`
  /// take the change off the queue for good"), so it ran again at every launch
  /// instead of ending.
  ///
  /// Populated only where a fetched record genuinely would not decode, and
  /// consumed on use, so one unreadable record buys exactly one direct fetch.
  private var unreadableRecords: Set<CKRecord.ID> = []

  /// True from the delegate wrapper's entry until its `handleEvent` returns.
  /// CKSyncEngine guarantees serial delivery, so this cannot nest and is a
  /// boolean rather than a counter.
  private var delegateEventInFlight = false

  /// Set only when `send` refuses work because of the marker above. All refused
  /// ids are made durable by the host before the delegate call can finish; this
  /// bit coalesces them into one post-event drain.
  private var sendPostponedDuringEvent = false

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

  /// Every profile's zone, not only the open one: a profile's résumés are user
  /// data whichever profile happens to be active, and a device that fetched only
  /// the open one could never mirror the account. Saved on every start because
  /// saving an existing zone is a no-op, and a "have I made it yet" flag is a
  /// second piece of state that can disagree with the server.
  @discardableResult
  func start(profileId: String, knownProfileIds: [String]) async -> OPSyncAccountState {
    let state = await accountState()
    guard case .available = state else { return state }
    if self.profileId == profileId, engine != nil {
      // Same profile, engine already up — but NOT necessarily the same set of
      // profiles. This device learns about a workspace created on another one
      // by fetching the registry, which happens while this engine is running,
      // and the zone set was fixed when it started. Left alone, the new
      // workspace is in the registry, visible in the switcher, and its zone is
      // outside every fetch — so it stays empty until something restarts the
      // engine. Reconcile instead of returning on the profile alone.
      adoptProfileZones(knownProfileIds + [profileId])
      return state
    }
    await stop()

    var seenProfileIds = Set<String>()
    let profileZones = (knownProfileIds + [profileId])
      .filter { seenProfileIds.insert($0).inserted }
      .map { CKRecordZone(zoneName: $0) }
    // And ONE zone for every profile, which is what a device that has never
    // heard of this account's profiles can still name. See `opSharedZoneName`.
    let sharedZone = CKRecordZone(zoneName: opSharedZoneName)
    self.profileId = profileId
    self.profileZoneIDs = profileZones.map(\.zoneID)
    self.sharedZoneID = sharedZone.zoneID
    // Per profile even for the shared zone's records, because the map belongs to
    // an ENGINE's conversation with the server and each profile runs its own.
    // Two profiles therefore hold separate tags for the same shared record; the
    // first save after a switch quotes none, meets the conflict path and unions.
    // That costs a round trip and cannot lose anything, which is the trade every
    // forfeited tag in this file makes.
    self.systemFields = Self.loadSystemFields(profileId: profileId)
    // Beside them, and for the same session: a record this device could not
    // read is still unread after a relaunch, and the deferred id that comes
    // back needs the marker to still be here.
    self.unreadableRecords = loadUnreadableRecords(profileId: profileId)

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

    let pendingZoneSaves: [CKSyncEngine.PendingDatabaseChange] =
      profileZones.map { .saveZone($0) } + [.saveZone(sharedZone)]
    engine.state.add(pendingDatabaseChanges: pendingZoneSaves)

    // Nothing staged for an earlier run can be uploaded now: every record is
    // rebuilt from `syncUnit(withId:)` at send time. Clearing the outbox here is
    // what keeps assets from an interrupted run from accumulating.
    Self.clearOutbox()
    return state
  }

  /// Take on any profile zone this running engine does not already handle.
  ///
  /// ADDITIVE ONLY, and never the reverse. A zone this session has handled has
  /// a change token that has already moved past its records; dropping it from
  /// the scope would leave later changes there fetched by nobody, which is the
  /// same silent staleness this exists to fix. A tombstoned workspace can also
  /// be revived (see `profiles.js`), and its zone is deliberately not deleted
  /// with it, so "gone from the list" is not "gone".
  ///
  /// Queues the zone save as well as widening the scope: a profile created on
  /// another device has a zone on the server already, and one created here does
  /// not — saving an existing zone is a no-op, so both cases take this path.
  @discardableResult
  func adoptProfileZones(_ knownProfileIds: [String]) -> [String] {
    guard let engine else { return [] }
    var handled = Set(profileZoneIDs.map(\.zoneName))
    let added = knownProfileIds.filter { !$0.isEmpty && handled.insert($0).inserted }
    guard !added.isEmpty else { return [] }

    let zones = added.map { CKRecordZone(zoneName: $0) }
    profileZoneIDs.append(contentsOf: zones.map(\.zoneID))
    engine.state.add(pendingDatabaseChanges: zones.map { .saveZone($0) })
    NSLog("[OPSync] now handling \(added.count) newly known profile zone(s)")
    return added
  }

  /// Put the transport down. Local data is untouched — this is the transport
  /// going quiet, not a sign-out.
  func stop() async {
    await engine?.cancelOperations()
    engine = nil
    delegate = nil
    profileId = nil
    profileZoneIDs = []
    sharedZoneID = nil
    systemFields = [:]
    systemFieldsDirty = false
  }

  /// Queue units to go up, and send now.
  ///
  /// The scope is everything pending rather than just `unitIds`, on purpose: a
  /// unit whose last send failed for a transient reason was put back in the
  /// queue, and scoping to the ids named here would leave it sitting there until
  /// that same unit happened to be edited again.
  ///
  /// WHICH ZONE EACH UNIT GOES TO IS THE MODEL'S ANSWER, asked here because a
  /// `CKRecord.ID` carries its zone and this is where the change is queued —
  /// `recordToSend`, which finally has the unit itself, is already too late to
  /// choose. Nothing about the id is inspected on this side; see `syncScopes`.
  /// A refused answer refuses the whole send rather than routing on a guess.
  /// `inProfile` names the workspace these units belong to, defaulting to the
  /// open one. Any other value sends a workspace this device holds but nobody
  /// has opened — a full upload of an unvisited profile, or debt owed for a
  /// fetch into its zone that the page would not apply. The zone has to be
  /// THAT profile's: routing those to the open profile's zone writes one
  /// person's résumés into another's workspace.
  func send(unitIds: [String], inProfile requested: String? = nil) async throws {
    try refuseSendDuringDelegateEvent()
    let profileId = requested ?? self.profileId
    guard let engine, let profileId, let sharedZoneID,
          let profileZoneID = profileZoneIDs.first(where: { $0.zoneName == profileId })
    else { throw OPSyncError.notStarted }
    guard let scopes = await host?.syncScopes(forUnitIds: unitIds) else {
      throw OPSyncError.scopeUnknown
    }
    // The scope ask suspends. An event may have begun while it was waiting, so
    // check again at the last possible point before anything enters the engine.
    try refuseSendDuringDelegateEvent()
    let changes = unitIds.map { id in
      // No answer for an id is profile-scoped, which is what every unit was
      // before the shared zone existed — including every unit a build older than
      // that zone ever queued.
      CKSyncEngine.PendingRecordZoneChange.saveRecord(
        CKRecord.ID(recordName: id,
                    zoneID: scopes[id] == opSharedScope ? sharedZoneID : profileZoneID)
      )
    }
    engine.state.add(pendingRecordZoneChanges: changes)
    try await engine.sendChanges()
  }

  private func refuseSendDuringDelegateEvent() throws {
    guard !delegateEventInFlight else {
      sendPostponedDuringEvent = true
      throw OPSyncError.eventInFlight
    }
  }

  /// The delegate methods are intentionally the only callers: their entry and
  /// exit are the exact boundary Apple's CKSyncEngine contract describes.
  fileprivate func beginDelegateEvent() {
    assert(!delegateEventInFlight, "CKSyncEngine delegate events must not nest")
    delegateEventInFlight = true
  }

  fileprivate func finishDelegateEvent() {
    assert(delegateEventInFlight, "a CKSyncEngine delegate event must begin before it finishes")
    delegateEventInFlight = false
    guard sendPostponedDuringEvent else { return }
    sendPostponedDuringEvent = false
    guard let profileId else { return }

    Task { @MainActor [weak self] in
      // This must be the task's first action. The current main-actor job has no
      // suspension between scheduling this task and returning from handleEvent;
      // yielding here therefore puts the drain after that delegate call has
      // unwound, never merely at the end of its implementation.
      await Task.yield()
      guard let self, self.profileId == profileId else { return }
      await self.host?.syncRetryDeferred(profileId: profileId)
    }
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

  /// Pull the SHARED zone, and only it.
  ///
  /// It exists for order, not for scope. The registry has to come down before
  /// this device sends anything: a fresh install owes a full upload, and an
  /// upload that went first would put its throwaway starter workspace on the
  /// server before the merge had seen what is already there — after which
  /// nothing distinguishes the two. The ordinary `fetch` cannot be that, because
  /// the start path deliberately drains the outbox before pulling (see
  /// `runStartSync` in OPShell.swift), and that drain is a send.
  ///
  /// The narrower scope survives `nextFetchChangesOptions`, which intersects
  /// rather than replaces.
  func fetchShared() async throws {
    guard let engine, let sharedZoneID else { throw OPSyncError.notStarted }
    try await engine.fetchChanges(
      CKSyncEngine.FetchChangesOptions(scope: .zoneIDs([sharedZoneID]))
    )
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
    guard let owner else { return }
    owner.beginDelegateEvent()
    defer { owner.finishDelegateEvent() }
    await owner.handle(event, engine: syncEngine)
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
    // Narrowed to every zone this device actually handles: every known profile's
    // and the shared one. A change token must never advance past records that are
    // then dropped. Every zone in this widened set is genuinely handled: its
    // records land through the same `deliver` path, carrying the zone they
    // arrived in so the page can apply them without Swift classifying unit ids.
    //
    // INTERSECTED with what was asked for rather than replacing it, so a caller
    // that wanted LESS keeps it: `fetchShared` pulls the registry on its own,
    // ahead of the first upload, and handing back a widened scope would quietly
    // undo that. A zone outside the handled set is dropped from the scope either
    // way.
    //
    // An EMPTY intersection falls back to every handled zone, because "no zones"
    // is not a scope CloudKit can be handed: `CKSyncEngineFetchChangesScope`
    // documents a nil zone-id set as meaning EVERY zone, and an empty one is too
    // close to that to bet the invariant above on. It is unreachable from this
    // file — the only narrowed ask names a zone that is in this list — and a
    // request naming none of them gets exactly the answer this delegate gave
    // before it honoured a narrower ask at all.
    guard let zoneIDs = owner?.currentZoneIDs, !zoneIDs.isEmpty else { return context.options }
    let asked = zoneIDs.filter { context.options.scope.contains($0) }
    var options = context.options
    options.scope = .zoneIDs(asked.isEmpty ? zoneIDs : asked)
    return options
  }
}

// MARK: - Events

extension OPSyncEngine {
  /// Every zone this engine session handles. Empty when it is not running,
  /// which is the one case `nextFetchChangesOptions` must not narrow on.
  fileprivate var currentZoneIDs: [CKRecordZone.ID] {
    guard let sharedZoneID else { return [] }
    let zoneIDs = profileZoneIDs + [sharedZoneID]
    return zoneIDs
  }

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
          // Marked as ours to ask for again. `recordToSend` cannot tell on its
          // own why the page had no unit — see `unreadableRecords`.
          unreadableRecords.insert(record.recordID)
          saveUnreadableRecords()
          unreadable.append(OPSyncFailure(
            unitId: record.recordID.recordName,
            profileId: opProfileId(forZone: record.recordID.zoneID),
            willRetry: false, code: nil,
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
      land(sent.savedRecords.map { OPSyncScope.record($0.recordID) })
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
      // against no unit in particular, and it is named the same way — THAT
      // zone, whole. Not "a zone": the session holds one per workspace plus the
      // shared one, so one of them saving says nothing about the others, and a
      // single nameless key for all of them had any one of them clear the lot.
      // Before the report for the same reason as above.
      land(sent.savedZones.map { OPSyncScope.zone($0.zoneID) })
      report(sent.failedZoneSaves.map { failure in
        OPSyncFailure(unitId: nil, profileId: opProfileId(forZone: failure.zone.zoneID),
                      willRetry: true, code: failure.error.code,
                      reason: failure.error.localizedDescription)
      })

    case .didFetchRecordZoneChanges(let done):
      guard let error = done.error else {
        // The other zone-wide good news: this fetch reached the server and got
        // everything it asked for — from THIS zone, which is the only one it
        // can speak for.
        land([.zone(done.zoneID)])
        break
      }
      // The zone was deleted in the Settings app (CKError.h). That is the
      // account owner's instruction, not an absence, and it is handled as one
      // wherever it turns up.
      if error.code == .userDeletedZone {
        purgeFromICloud(engine: engine, reason: "a fetch found the zone deleted from Settings")
        break
      }
      // A zone that is not there is not a failure: it is the first sync, before
      // anything has been sent. It is not success either — a zone save that is
      // still queued is exactly the failure a nil unit id stands for, and this
      // is the server agreeing it has not happened yet — so it neither reports
      // nor lands. Everything else the caller should hear about.
      if error.code != .zoneNotFound {
        report([OPSyncFailure(unitId: nil, profileId: opProfileId(forZone: done.zoneID),
                              willRetry: true, code: error.code,
                              reason: error.localizedDescription)])
      }

    case .fetchedDatabaseChanges(let changes):
      // A zone deletion, which is the ONE fetched deletion this transport acts
      // on. Record deletions and `.deleted` zones are still ignored — deletion
      // in this design is an explicit tombstone unit that travels like any other
      // unit, and nothing may turn a record's absence into a local delete. The
      // two reasons below are not absence: they are the owner of the account
      // saying so in the Settings app, and Apple requires that the data not be
      // resent (CKSyncEngineEvent.h).
      //
      // Not matched against `zoneID`: a purge empties the container, so a
      // deletion for ANY zone is the same instruction about this app's data, and
      // this device syncs one profile's zone at a time and would otherwise
      // ignore the notice for all the others.
      for deletion in changes.deletions {
        switch deletion.reason {
        case .deleted:
          // Only this app deletes its own zones, and it never does. Left alone
          // rather than guessed at.
          NSLog("[OPSync] a zone deletion this app did not make and cannot explain: "
                + "\(deletion.zoneID.zoneName) — ignored, local data untouched")
        case .purged:
          purgeFromICloud(engine: engine, reason: "the account's owner deleted this app's iCloud data")
        case .encryptedDataReset:
          purgeFromICloud(engine: engine, reason: "the account's owner reset their encrypted iCloud data")
        @unknown default:
          // A reason that does not exist yet. Treated as a purge, because the
          // two directions are not symmetric: stopping costs the person a switch
          // they can turn back on and destroys nothing, while guessing "ignore"
          // re-uploads data the account's owner may have just asked to remove.
          purgeFromICloud(engine: engine, reason: "a zone deletion with a reason this build does not know")
        }
      }

    // Progress notifications with nothing this transport has to decide.
    case .willFetchChanges, .willFetchRecordZoneChanges,
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

  /// The account's owner emptied this app's iCloud data. Stop, and do not put it
  /// back.
  ///
  /// EVERYTHING QUEUED COMES OFF FIRST, and that ordering is the whole of this
  /// function's job: the host tears the engine down on a later main-actor turn
  /// (it cannot be done from inside an event), and anything still pending in
  /// between would recreate the zone and upload into it. `start` queues a
  /// `.saveZone` unconditionally, so that pending change is the specific one
  /// that would undo the person's instruction.
  ///
  /// The change tags go too, and they go without a flush: they describe records
  /// that no longer exist. The rest of what this device cached about the server
  /// — the engine's state serialization, the staged assets — is removed by the
  /// host once the engine is down and can no longer rewrite it
  /// (`forgetEverythingAboutTheServer`).
  ///
  /// NOTHING OF THE PERSON'S IS TOUCHED HERE OR ANYWHERE BELOW. A résumé is not
  /// a cache of a CloudKit record: this app's local store is where the document
  /// lives and iCloud is a mirror of it, so "delete any locally cached data"
  /// means the data that is a cache OF ICLOUD, which is the bookkeeping above.
  private func purgeFromICloud(engine: CKSyncEngine, reason: String) {
    NSLog("[OPSync] iCloud data purged — \(reason). Stopping; nothing local is deleted "
          + "and nothing will be re-sent.")
    engine.state.remove(pendingRecordZoneChanges: engine.state.pendingRecordZoneChanges)
    engine.state.remove(pendingDatabaseChanges: engine.state.pendingDatabaseChanges)
    systemFields = [:]
    systemFieldsDirty = false
    host?.syncDidPurgeFromICloud()
  }

  private func handleFailedSaves(
    _ failures: [CKSyncEngine.Event.SentRecordZoneChanges.FailedRecordSave],
    engine: CKSyncEngine
  ) async {
    var conflicts: [Conflict] = []
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
      // Read off the record's own zone rather than the session's current
      // profile: one engine session sends into every workspace's zone plus the
      // shared one, so the failing record's workspace is whatever it was queued
      // against, not whichever one happens to be open now.
      let profileId = opProfileId(forZone: recordID.zoneID)
      let error = failure.error

      switch error.code {
      case .serverRecordChanged:
        guard let serverRecord = error.serverRecord,
              let serverUnit = unit(from: serverRecord),
              let localUnit = unit(from: failure.record)
        else {
          reported.append(OPSyncFailure(
            unitId: recordID.recordName, profileId: profileId,
            willRetry: false, code: error.code,
            reason: "conflict on an unreadable record: \(error.localizedDescription)"
          ))
          continue
        }

        // BOTH VERSIONS TRAVEL, and nothing is decided here. Which of them wins
        // — or whether the right answer is a union in which neither loses — is
        // the model's, and so is the parking that follows from it. See
        // `resolve`, and `SyncConflict` for what this file used to get wrong.
        //
        // Nothing is remembered yet either: the server's tag is a claim to hold
        // its content, and this device holds none of it until the model says so.
        conflicts.append(Conflict(
          serverRecord: serverRecord,
          versions: SyncConflict(local: localUnit, server: serverUnit)
        ))

      case .zoneNotFound:
        // The zone has never been created — this is the first send of the first
        // sync. Recreate it and send again. This is NOT "the server is empty so
        // drop the local copy" — it is the opposite, the local copy is the only
        // one left.
        //
        // THE RECORD'S OWN ZONE, not the profile's: this device writes to two of
        // them now, and recreating the profile zone for a shared record's
        // failure would retry against a zone that is still missing, for ever.
        engine.state.add(
          pendingDatabaseChanges: [.saveZone(CKRecordZone(zoneID: recordID.zoneID))]
        )
        forget(recordID)
        engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        reported.append(OPSyncFailure(unitId: recordID.recordName, profileId: profileId,
                                      willRetry: true, code: error.code,
                                      reason: error.localizedDescription))

      case .userDeletedZone:
        // NOT the same answer as `.zoneNotFound`, though the two used to share
        // this branch and that shared branch is what let an explicit purge be
        // silently undone: CKError.h defines this code as "the user deletes a
        // record zone using the Settings app", so recreating the zone and
        // re-sending puts back exactly what they just removed. Nothing local is
        // touched; see `syncDidPurgeFromICloud`.
        purgeFromICloud(engine: engine, reason: "a save found the zone deleted from Settings")
        reported.append(OPSyncFailure(unitId: recordID.recordName, profileId: profileId,
                                      willRetry: false, code: error.code,
                                      reason: error.localizedDescription))

      case .unknownItem:
        // A change tag for a record the server does not have. Forget the tag so
        // the retry goes up as a new record instead of quoting a tag nothing
        // will ever match.
        forget(recordID)
        engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        reported.append(OPSyncFailure(unitId: recordID.recordName, profileId: profileId,
                                      willRetry: true, code: error.code,
                                      reason: error.localizedDescription))

      case .notAuthenticated, .accountTemporarilyUnavailable, .networkFailure,
           .networkUnavailable, .requestRateLimited, .serviceUnavailable,
           .zoneBusy:
        // The seven above. The change is still queued and the engine owns the
        // backoff, so saying so is the whole of this side's job. `notAuthenticated`
        // in particular used to fall through to `default` and be dropped as
        // permanent — it is not: the account can come back, and the engine is
        // already waiting for it.
        reported.append(OPSyncFailure(unitId: recordID.recordName, profileId: profileId,
                                      willRetry: true, code: error.code,
                                      reason: error.localizedDescription))

      case .operationCancelled, .serverResponseLost:
        // Transient too — a cancelled operation is the app going to the
        // background or `stop()` being called, and a lost response is a request
        // whose outcome is simply unknown — but neither is on the engine's list,
        // so the change is off the queue and this side puts it back. Dropping
        // them as permanent, which is what `default` did, lost a local edit
        // until the unit happened to be edited again.
        engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)])
        reported.append(OPSyncFailure(unitId: recordID.recordName, profileId: profileId,
                                      willRetry: true, code: error.code,
                                      reason: error.localizedDescription))

      default:
        // Quota exceeded, a record over a hard limit, a rejected request, a
        // missing entitlement: none of these get better by being retried, and
        // retrying them forever would be a queue that never drains.
        reported.append(OPSyncFailure(unitId: recordID.recordName, profileId: profileId,
                                      willRetry: false, code: error.code,
                                      reason: error.localizedDescription))
      }
    }

    await resolve(conflicts, engine: engine)
    report(reported)
  }

  /// Hand every conflict to the model, and keep the server's change tag only for
  /// the units it resolved.
  ///
  /// THE MIRROR OF `deliver`, and the same invariant one path over: a change tag
  /// is a claim to know which server version this device is editing, and the
  /// server's version is accounted for only once the model says it merged,
  /// applied or parked it — durably, on disk, which is what the answer waits for
  /// (`resolveConflicts` in syncModel.js).
  ///
  /// `retry` is the model's answer too, not a rule kept here. A union owes the
  /// server the merged document; a snapshot this device won owes it ours; a
  /// snapshot the SERVER won owes it nothing, and re-sending there would push
  /// this device's stamp back over the version it has just taken.
  ///
  /// WHAT A RETRY SENDS IS NOT CACHED HERE. The model has already written the
  /// resolution to its own store, and `recordToSend` asks for the unit at send
  /// time as it does for every other send. A payload held on this side would be
  /// sent INSTEAD of a local edit that landed in between — the two collapse into
  /// one queued change — and that edit would never be named again. Asked at send
  /// time it is the resolution, or something newer built on top of it, and both
  /// are correct.
  ///
  /// A unit the model did not name is FORFEITED: the tag goes, no save is
  /// queued, and the host offers the unit again at the next start (see
  /// `syncDidConflict` in OPShell.swift). Nothing is reported for it, for the
  /// same reason `deliver` reports nothing — `syncDidFail`'s recovery re-queues
  /// a send immediately, and a page that could not resolve a conflict cannot be
  /// asked for the unit either, so it would spend this session's one attempt on
  /// a webview that is still gone.
  private func resolve(_ conflicts: [Conflict], engine: CKSyncEngine) async {
    guard !conflicts.isEmpty else { return }
    let outcome = await host?.syncDidConflict(conflicts.map(\.versions)) ?? .unresolved
    // `uniquingKeysWith` rather than `uniqueKeysWithValues`, which TRAPS on a
    // duplicate: these ids come off the bridge, and a malformed answer must cost
    // a round trip, never the process.
    let retries = Dictionary(outcome.resolved.map { ($0.route, $0.retry) },
                             uniquingKeysWith: { first, _ in first })

    for conflict in conflicts {
      let recordID = conflict.recordID
      // Matched on the same route the answer was named with — the workspace and
      // the id, not the id alone. `conflict.versions.server` carries the zone
      // this record arrived from, put there by `unit(from:)`.
      guard let retry = retries[conflict.versions.server.route] else {
        forget(recordID)
        continue
      }
      // The server's version is accounted for on this device, so this device may
      // now say which server version it is editing. Recorded BEFORE the save is
      // queued: a retry built without the tag is the fresh-record bug from the
      // file header, in exactly the case a conflict has just proved is live.
      remember(conflict.serverRecord)
      if retry { engine.state.add(pendingRecordZoneChanges: [.saveRecord(recordID)]) }
    }
  }

  /// Hand records that arrived from the server to the page, and keep their
  /// change tags only if the page took them.
  ///
  /// THE ONE PLACE a fetched record's tag is stored, which is what makes the
  /// invariant checkable rather than remembered: a change tag is a claim to
  /// know which server version this device is editing, and this device may only
  /// make that claim about content it actually holds.
  ///
  /// THREE things falsify the claim and they are one bug, three layers apart. A
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
  /// The third is the same sentence one layer deeper again, and it is why the
  /// tag this line stores is only ever written after the PAGE'S DISK: an apply
  /// confirmed against a write-behind cache is not an apply. Killed before that
  /// cache drains, the device relaunches with old content and this tag, which is
  /// the overwrite above with no round trip left to catch it. Apple asks for
  /// exactly this ordering — the engine's state must be persisted alongside the
  /// app data and the fetched changes it came with (CKSyncEngineEvent.h) — and
  /// `applyUnits` (syncModel.js) is where that barrier now is.
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
  /// Ask the server for ONE record by id, outside the change feed.
  ///
  /// For the case above: a record this device failed to decode, whose change
  /// token has already advanced past it. Everything it lands goes through the
  /// same `deliver` an ordinary fetch uses, so the page decides what to keep
  /// and the change tag is earned the same way.
  private func refetchMissingRecord(_ recordID: CKRecord.ID, profileId: String) async {
    do {
      let record = try await container.privateCloudDatabase.record(for: recordID)
      guard let unit = unit(from: record) else {
        // Still unreadable. The asset is genuinely not coming down, and saying
        // so is the whole of what is left — `willRetry: false`, because this
        // device has now tried the one thing that could have worked. Terminal,
        // so the marker goes.
        unreadableRecords.remove(recordID)
        saveUnreadableRecords()
        forget(record.recordID)
        report([OPSyncFailure(
          unitId: recordID.recordName, profileId: profileId, willRetry: false, code: nil,
          reason: "a record could not be read even when asked for directly — most likely a "
            + "large payload whose asset will not download"
        )])
        return
      }
      // It came down. Nothing left to ask for.
      unreadableRecords.remove(recordID)
      saveUnreadableRecords()
      await deliver([Arrival(record: record, unit: unit)])
    } catch let error as CKError where error.code == .unknownItem {
      // The server does not have it. Nothing is wrong and nothing is missing:
      // absence is not deletion here, and there is simply nothing to fetch.
      unreadableRecords.remove(recordID)
      saveUnreadableRecords()
      forget(recordID)
    } catch {
      // Network, quota, anything else. Worth saying, and worth saying it WILL
      // be tried again — the id stays in the recovery memory for this session
      // and the next start re-offers everything.
      report([OPSyncFailure(
        unitId: recordID.recordName, profileId: profileId, willRetry: true,
        code: (error as? CKError)?.code,
        reason: "could not re-fetch a record this device could not read: "
          + error.localizedDescription,
        needsDurableRetry: true
      )])
    }
  }

  private func deliver(_ arrivals: [Arrival]) async {
    guard !arrivals.isEmpty else { return }
    // PER ARRIVAL, not per batch. The page answers with the route of every unit
    // it has ACCOUNTED FOR — written, or settled because nothing will ever land
    // it — and only those keep their change tags.
    //
    // A batch verdict could not express the ordinary case. A second device's
    // freshly minted settings are always newer than the ones arriving, so that
    // unit is correctly skipped every single time; read as a batch failure it
    // condemned every other record delivered beside it, including the résumés,
    // and the identical batch came back and failed identically at every start,
    // for ever. Nothing converged and nothing said why.
    let accounted = await host?.syncDidFetch(arrivals.map(\.unit)) ?? []
    for arrival in arrivals {
      if accounted.contains(arrival.unit.route) { remember(arrival.record) }
      else { forget(arrival.recordID) }
    }
  }

  private func report(_ failures: [OPSyncFailure]) {
    guard !failures.isEmpty else { return }
    host?.syncDidFail(failures)
  }

  /// `report`'s opposite, and deliberately as small: what got through, by the
  /// same name a failure would have carried. See `syncDidLand`.
  private func land(_ scopes: [OPSyncScope]) {
    guard !scopes.isEmpty else { return }
    host?.syncDidLand(scopes)
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

/// The same pairing for a save conflict: the server's record, which is where its
/// change tag lives, travelling with BOTH versions of the unit from the moment
/// the rejection is read to the moment `resolve` settles that tag.
///
/// Same reason as `Arrival` — anything holding the versions without the record
/// can only store a tag it cannot justify — and one more: the two versions have
/// to reach the model together or it has nothing to compare.
private struct Conflict {
  let serverRecord: CKRecord
  let versions: SyncConflict

  var recordID: CKRecord.ID { serverRecord.recordID }
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
    // WHICH WORKSPACE'S BYTES, read off the record's own zone. A `CKRecord.ID`
    // carries its zone, so the route was decided when the change was queued and
    // is still here — it was simply being dropped, and the page then answered
    // out of whatever workspace was open. Same unit id in two zones is the
    // ordinary case, not an edge one: every workspace has a `data:settings`.
    let profileId = opProfileId(forZone: recordID.zoneID)
    guard let unit = await host?.syncUnit(withId: recordID.recordName, inProfile: profileId) else {
      // This device has nothing under that id, and nothing will build one
      // later either, so leaving it queued is a question re-asked on every
      // send for the life of the app.
      engine.state.remove(pendingRecordZoneChanges: [.saveRecord(recordID)])
      // ONLY for a record this device could not read. Any other nil — above all
      // a page that did not answer in time — keeps the old behaviour exactly,
      // which is what ends the retry loop.
      // CONSULTED, not consumed. The durable retry re-enters here on the next
      // start, and a marker taken on the first attempt would be gone by then —
      // the retry would find nothing, drop the change, and the record would be
      // stranded exactly as before, with the two fixes cancelling each other.
      // `refetchMissingRecord` clears it on the outcomes that end the matter.
      guard unreadableRecords.contains(recordID) else { return nil }
      // Dropping it is not the whole answer when the reason there are no bytes
      // is that this device could not READ the record. That is the
      // recovery `syncDidFail` queues for an unreadable fetch — most often a
      // large résumé whose asset did not finish downloading — and by then the
      // change token has moved past the server record, so nothing will offer it
      // again. Dropped silently, the résumé is unavailable here until some
      // other device happens to modify it, while the status line goes back to
      // reporting sync as healthy because this path raises no second failure.
      //
      // Asked for directly instead. A fetch by id is an ordinary database
      // operation and owes nothing to the engine's change feed, so the advanced
      // token does not stand in its way.
      await refetchMissingRecord(recordID, profileId: profileId)
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
      report([OPSyncFailure(unitId: recordID.recordName, profileId: profileId,
                            willRetry: false, code: nil,
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
    let arrivedZoneID = record.recordID.zoneID
    // ARRIVAL, not routing: the record says which zone it came from. Outbound
    // routing remains the page's `syncScopes` answer and never inspects an id.
    let profileId = arrivedZoneID == sharedZoneID ? "" : arrivedZoneID.zoneName

    if let payload = record["payload"] as? String {
      return SyncUnit(id: record.recordID.recordName, kind: kind,
                      payload: payload, modifiedAt: modifiedAt, profileId: profileId)
    }
    if let asset = record["asset"] as? CKAsset,
       let url = asset.fileURL,
       let data = try? Data(contentsOf: url),
       let payload = String(data: data, encoding: .utf8) {
      return SyncUnit(id: record.recordID.recordName, kind: kind,
                      payload: payload, modifiedAt: modifiedAt, profileId: profileId)
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
  /// long-running app has made.
  ///
  /// FULL record identity, for the same reason `systemFieldsKey` needs it and
  /// not one line later: one engine session handles every workspace's zone, and
  /// the same unit id exists in all of them. Keyed by name alone, two workspaces
  /// sending a large `data:settings` in one batch staged to ONE path — and a
  /// `CKAsset` is a URL the engine opens when it finally uploads, not an open
  /// file handle, so `.atomic`'s rename does not protect a reader that has not
  /// started. The second write simply became both uploads, and one workspace's
  /// payload went up into the other's zone.
  ///
  /// This was safe until foreign-zone saves became possible; it was never
  /// re-asked afterwards. Percent-encoding to alphanumerics is total and encodes
  /// the separator too, so the joined name cannot be ambiguous — `a/bc` and
  /// `ab/c` differ once `/` becomes `%2F`.
  private static func stage(_ data: Data, for recordID: CKRecord.ID) throws -> URL {
    let directory = outbox
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // Record names carry `:` (`resume:<id>`, `key:resume-designer-data`), so they
    // are not filenames. Percent-encoding down to alphanumerics is total.
    let name = [recordID.zoneID.ownerName, recordID.zoneID.zoneName, recordID.recordName]
      .joined(separator: "/")
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

// THERE IS NO CONFLICT RULE IN THIS FILE, and that is deliberate. `localWins`
// stood here — `resolveConflict` from src/sync/syncMerge.js transcribed into
// Swift, with its own pair of ISO8601 parsers to read `modifiedAt` — and a rule
// both devices must compute identically had two implementations that could
// drift. Worse, it was applied to EVERY unit, including the two that must not
// take newer-wins at all, so the append-shaped units never reached their union
// on this path. The comparison now happens once, in the model, for the fetch
// path and the save path alike. Nothing in this file reads `modifiedAt` for
// anything but carrying it to and from a record.

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
  private static func unreadableKey(_ profileId: String) -> String {
    "op-sync-unreadable-\(profileId)"
  }

  /// The unreadable-record markers, on disk beside the deferred queue they pair
  /// with.
  ///
  /// Held only in memory, the marker did not survive the thing the durable
  /// retry exists FOR. The queue outlives a launch; the marker did not, so the
  /// id came back on the next start, found nothing, and the change was dropped
  /// — the same stranded record, defeated a third way. Full record identity for
  /// the same reason `systemFieldsKey` uses it: one engine session covers every
  /// zone and the same record name exists in all of them.
  private func loadUnreadableRecords(profileId: String) -> Set<CKRecord.ID> {
    let raw = UserDefaults.standard.stringArray(forKey: Self.unreadableKey(profileId)) ?? []
    var out: Set<CKRecord.ID> = []
    for entry in raw {
      let parts = entry.components(separatedBy: "\u{1F}")
      guard parts.count == 3 else { continue }
      let zone = CKRecordZone.ID(zoneName: parts[1], ownerName: parts[0])
      out.insert(CKRecord.ID(recordName: parts[2], zoneID: zone))
    }
    return out
  }

  private func saveUnreadableRecords() {
    guard let profileId else { return }
    let key = Self.unreadableKey(profileId)
    guard !unreadableRecords.isEmpty else {
      UserDefaults.standard.removeObject(forKey: key)
      return
    }
    UserDefaults.standard.set(
      unreadableRecords.map(Self.systemFieldsKey).sorted(), forKey: key
    )
  }
  static func deferredKey(_ profileId: String) -> String { "op-sync-deferred-\(profileId)" }
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
      // Against THAT profile's zone: the state file is per profile
      // (`stateKey`), so this is not a fact about any other workspace and must
      // not be cleared by one of them landing.
      report([OPSyncFailure(
        unitId: nil, profileId: profileId, willRetry: false, code: nil,
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
        unitId: nil, profileId: profileId, willRetry: false, code: nil,
        reason: "the sync state could not be saved, so the next launch will "
          + "refetch and re-send everything: \(error.localizedDescription)"
      )])
    }
  }

  /// The map's key: FULL record identity, not the record name.
  ///
  /// One engine session handles every workspace's zone plus the shared one, and
  /// the same unit id exists in all of them — every workspace has a
  /// `data:settings`. Keyed by name alone, fetching one workspace evicted the
  /// other's tag, so its next save quoted none, met `serverRecordChanged` and
  /// spent a round trip re-resolving a conflict that was not one. Alternating
  /// between workspaces evicted continuously.
  ///
  /// `\u{1F}` (unit separator) is the joiner because it cannot occur in any
  /// part: zone names are profile ids or `opSharedZoneName`, and record names
  /// are unit ids built from storage keys, all of which are validated to
  /// printable characters.
  private static func systemFieldsKey(_ recordID: CKRecord.ID) -> String {
    [recordID.zoneID.ownerName, recordID.zoneID.zoneName, recordID.recordName]
      .joined(separator: "\u{1F}")
  }

  /// Decode one archived system-fields blob back into its empty record.
  ///
  /// `encodeSystemFields` writes no root object, so this is the decoder pair
  /// Apple documents for it rather than
  /// `NSKeyedUnarchiver.unarchivedObject(ofClass:from:)`, which would find
  /// nothing to unarchive.
  private static func decodeRecord(_ data: Data) -> CKRecord? {
    guard let coder = try? NSKeyedUnarchiver(forReadingFrom: data) else { return nil }
    coder.requiresSecureCoding = true
    let record = CKRecord(coder: coder)
    coder.finishDecoding()
    return record
  }

  fileprivate static func loadSystemFields(profileId: String) -> [String: Data] {
    let stored = UserDefaults.standard.dictionary(forKey: recordsKey(profileId))
      as? [String: Data] ?? [:]

    // Re-key anything written by a build that keyed by record name. The zone is
    // not lost and does not have to be guessed: the archived system fields carry
    // the whole `CKRecord.ID`, so each entry can say where it belongs. An entry
    // that will not decode is dropped, which costs it one uncontested round trip
    // — the same as never having had a tag, and it was unusable either way.
    //
    // Not written back here. The next event that dirties the map flushes it in
    // the new shape; until then this is re-derived on load, which is cheap and
    // leaves nothing half-converted if the process dies.
    var migrated: [String: Data] = [:]
    for (key, data) in stored {
      guard !key.contains("\u{1F}") else {
        migrated[key] = data
        continue
      }
      guard let record = decodeRecord(data) else { continue }
      migrated[systemFieldsKey(record.recordID)] = data
    }
    return migrated
  }

  /// Forget everything this device cached about the server, for EVERY profile.
  ///
  /// This is what "delete any locally cached data" means for an app whose local
  /// store is the document and whose CloudKit zone is a mirror of it
  /// (CKSyncEngineEvent.h asks for it on a purge). The things removed are the
  /// engine's state serialization, which carries the change tokens and pending
  /// queue; the change-tag map; and the deferred-send ids, whose debt describes
  /// the server that was just emptied. The staged assets go too — they are an
  /// outbox, and there is nothing left to send them to. Local content stays, and
  /// a later explicit opt-in creates the ordinary full-upload debt for it.
  ///
  /// EVERY profile, not the one running: a purge empties the container, so every
  /// zone's tokens and tags now describe records that are gone. The keys are
  /// enumerated by their own builders' prefixes, so the shapes have one source,
  /// the same way `oweFullUploadForEveryConsideredProfile` reads its markers.
  ///
  /// Leaving them would be worse than untidy. If the person later turns sync
  /// back on — the only way it comes back — a stale change token would name a
  /// zone that no longer exists, and the fetch answering `.userDeletedZone`
  /// would read as a fresh purge and switch sync straight back off, against
  /// their explicit instruction to resume.
  ///
  /// Called by the host only after the engine is down, since a running engine
  /// rewrites its state and record keys on its next event.
  static func forgetEverythingAboutTheServer() {
    let defaults = UserDefaults.standard
    let prefixes = [stateKey(""), recordsKey(""), deferredKey(""), unreadableKey("")]
    for key in defaults.dictionaryRepresentation().keys
    where prefixes.contains(where: key.hasPrefix) {
      defaults.removeObject(forKey: key)
    }
    clearOutbox()
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
    systemFields[Self.systemFieldsKey(record.recordID)] = coder.encodedData
    systemFieldsDirty = true
  }

  fileprivate func forget(_ recordID: CKRecord.ID) {
    guard systemFields.removeValue(forKey: Self.systemFieldsKey(recordID)) != nil else { return }
    systemFieldsDirty = true
  }

  /// An empty record carrying only the remembered system fields — which is
  /// exactly what a save needs as its base.
  fileprivate func rememberedRecord(for recordID: CKRecord.ID) -> CKRecord? {
    guard let data = systemFields[Self.systemFieldsKey(recordID)],
          let record = Self.decodeRecord(data)
    else { return nil }
    // THE ZONE STILL HAS TO MATCH, even though the key now carries it. A unit's
    // zone can change under the map — the registry used to be saved into the
    // active profile's zone, so a device upgrading into the shared zone still
    // holds a tag naming the old one — and the migration above re-keys such an
    // entry by the zone it was WRITTEN with, so it is reachable under its old
    // identity, not the one being asked for. This is the check that keeps a
    // lookup from ever building a save against the wrong zone; the key change
    // only stopped two zones evicting each other.
    guard record.recordID == recordID else { return nil }
    return record
  }
}
