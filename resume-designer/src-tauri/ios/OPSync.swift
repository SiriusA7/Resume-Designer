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

  /// Whether sync can run at all. Checked before every operation: signed out
  /// is a normal state, not an error, and must never wipe local data.
  func accountAvailable() async -> Bool {
    (try? await container.accountStatus()) == .available
  }
}
