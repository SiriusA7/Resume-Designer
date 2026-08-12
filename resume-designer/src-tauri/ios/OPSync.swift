// CloudKit transport. Zones, tokens, push, pull, conflict detection, retry.
//
// **This file never parses a payload.** A unit crosses as
// `{ id, kind, payload, modifiedAt }` with `payload` an opaque JSON string,
// because decomposing the résumé document is schema knowledge and the native
// side does not hold any. That is also what makes a future Mac client a
// transport-only job: it reimplements this file and nothing below it.
//
// Its JS counterpart is src/sync/syncModel.js.

import CloudKit
import Foundation

/// Mirrors the unit shape in src/sync/syncModel.js.
struct SyncUnit: Codable, Equatable {
  let id: String
  /// "resume" | "plain" | "tokenUsage" — enough to route a conflict without
  /// understanding the contents.
  let kind: String
  let payload: String
  let modifiedAt: String
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

@MainActor
final class OPSyncEngine {
  private let container = CKContainer(identifier: "iCloud.com.onpaper.app")
  private var database: CKDatabase { container.privateCloudDatabase }
  private var zones: [String: CKRecordZone] = [:]

  /// One zone per profile: atomic per-profile fetches, and a clean per-profile
  /// delete. The zone name is the profile id, which is already a stable
  /// identifier on disk.
  func zone(for profileId: String) async throws -> CKRecordZone {
    if let cached = zones[profileId] { return cached }
    let zone = CKRecordZone(zoneName: profileId)
    let saved = try await database.modifyRecordZones(saving: [zone], deleting: [])
    _ = saved
    zones[profileId] = zone
    return zone
  }

  /// Whether sync can run at all, and why not when it cannot. Checked before
  /// every operation: signed out is a normal state, not an error, and must
  /// never wipe local data.
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
}

private let opSyncRecordType = "SyncUnit"

extension OPSyncEngine {
  /// A unit as a record. The payload goes into a field, or into an asset when
  /// it is too large — chosen purely on byte count, so this stays ignorant of
  /// what it is carrying.
  func record(for unit: SyncUnit, in zone: CKRecordZone) throws -> CKRecord {
    let id = CKRecord.ID(recordName: unit.id, zoneID: zone.zoneID)
    let record = CKRecord(recordType: opSyncRecordType, recordID: id)
    record["kind"] = unit.kind as CKRecordValue
    record["modifiedAt"] = unit.modifiedAt as CKRecordValue

    let data = Data(unit.payload.utf8)
    if data.count > opSyncAssetThreshold {
      let url = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString)
      try data.write(to: url)
      record["asset"] = CKAsset(fileURL: url)
    } else {
      record["payload"] = unit.payload as CKRecordValue
    }
    return record
  }

  /// The inverse. Returns nil for a record missing both payload forms, which
  /// is a corrupt record rather than an empty unit.
  func unit(from record: CKRecord) -> SyncUnit? {
    let kind = record["kind"] as? String ?? "plain"
    let modifiedAt = record["modifiedAt"] as? String ?? ""
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
}

extension OPSyncEngine {
  /// Send units up. Returns the ones that LOST a conflict, for the caller to
  /// park in version history.
  ///
  /// Per-record outcomes, not all-or-nothing: one failed record is retried and
  /// does not fail its neighbours.
  func push(_ units: [SyncUnit], profileId: String) async throws -> [SyncUnit] {
    guard case .available = await accountState() else { return [] }
    let zone = try await self.zone(for: profileId)
    let records = try units.map { try record(for: $0, in: zone) }

    // `atomically` defaults to TRUE, and these records live in a CUSTOM zone,
    // which is exactly where CloudKit honours it: one conflicting unit would
    // fail every other unit in the same push with `batchRequestFailed`. That is
    // the opposite of what this function promises, so it is passed explicitly
    // rather than left to a default that reads as harmless.
    let result = try await database.modifyRecords(
      saving: records, deleting: [], savePolicy: .ifServerRecordUnchanged,
      atomically: false
    )

    var losers: [SyncUnit] = []
    for (recordID, outcome) in result.saveResults {
      guard case .failure(let error) = outcome else { continue }
      guard let ckError = error as? CKError, ckError.code == .serverRecordChanged,
            let serverRecord = ckError.serverRecord,
            let serverUnit = unit(from: serverRecord),
            let localUnit = units.first(where: { $0.id == recordID.recordName })
      else { continue }

      // Newer wins. The tie goes to the server so both devices break it the
      // same way — otherwise they converge on different winners and sync
      // forever.
      let localAt = Self.timestamp(localUnit.modifiedAt) ?? .distantPast
      let serverAt = Self.timestamp(serverUnit.modifiedAt) ?? .distantPast
      if localAt > serverAt {
        // Ours is newer, so overwrite the server and their copy is the loser.
        //
        // The retry MUST start from `serverRecord`, not from a freshly built
        // record: CloudKit rejects a save whose change tag it does not
        // recognise, and a new CKRecord carries none — so retrying with one
        // fails forever in exactly the case a conflict just proved is live.
        // Mutating the server's own copy keeps its tag.
        serverRecord["kind"] = localUnit.kind as CKRecordValue
        serverRecord["modifiedAt"] = localUnit.modifiedAt as CKRecordValue
        let data = Data(localUnit.payload.utf8)
        if data.count > opSyncAssetThreshold {
          let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
          try data.write(to: url)
          serverRecord["asset"] = CKAsset(fileURL: url)
          // Clearing the other form is not tidiness: a record left holding both
          // an asset and a string would be read back by `unit(from:)` as the
          // string, which is now the stale one.
          serverRecord["payload"] = nil
        } else {
          serverRecord["payload"] = localUnit.payload as CKRecordValue
          serverRecord["asset"] = nil
        }
        _ = try? await database.modifyRecords(
          saving: [serverRecord], deleting: [], savePolicy: .changedKeys
        )
        losers.append(serverUnit)
      } else {
        // Theirs is newer: ours is the loser and the server already holds the
        // winner, which the next pull will bring down.
        losers.append(localUnit)
      }
    }
    return losers
  }

  /// Fetch what changed since the last pull. Tokens are per-zone and persisted
  /// by the caller so a pull is incremental rather than a full download.
  ///
  /// One page per call: `moreComing` is not looped over, and the token that
  /// comes back resumes exactly where this page stopped, so a large first sync
  /// arrives over several pulls rather than one long one.
  func pull(profileId: String, since token: CKServerChangeToken?) async throws
    -> (units: [SyncUnit], token: CKServerChangeToken?) {
    guard case .available = await accountState() else { return ([], token) }
    let zone = try await self.zone(for: profileId)

    let result = try await database.recordZoneChanges(
      inZoneWith: zone.zoneID, since: token
    )
    // `result.deletions` is ignored on purpose. Deletion in this design is an
    // explicit tombstone unit that travels like any other unit, and this task
    // does not implement it — nothing here may turn a record's absence, or the
    // server's deletion list, into a local delete.
    let units = result.modificationResultsByID.values.compactMap { outcome -> SyncUnit? in
      guard case .success(let modification) = outcome else { return nil }
      return unit(from: modification.record)
    }
    return (units, result.changeToken)
  }

  /// Two parsers, the same pair OPShell.swift keeps for history dates:
  /// ISO8601DateFormatter fails outright on the option it was not given rather
  /// than ignoring it. Timestamps here are minted by JS's `toISOString()`, which
  /// ALWAYS carries milliseconds, and a stock formatter parses none of them — so
  /// a single default formatter would have returned nil for both sides of every
  /// conflict, tied them at `.distantPast`, and handed the server the win every
  /// time. The plain parser stays for any timestamp minted without them.
  static func timestamp(_ iso: String) -> Date? {
    isoWithFraction.date(from: iso) ?? isoPlain.date(from: iso)
  }

  private static let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let isoPlain = ISO8601DateFormatter()
}
