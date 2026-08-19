// The native iOS chrome for On Paper.
//
// tao owns the application lifecycle, the run loop, the UIWindow and the
// WKWebView, exactly as it does on every other platform. Once the window is
// scene-attached, `src-tauri/src/ios_shell.rs` calls `installShell` here, which
// makes a UIHostingController the window's rootViewController and moves wry's
// existing WKWebView into it. See docs/ios/swiftui-lifecycle-spike.md for why
// this is the only route that keeps Tauri whole — inverting the lifecycle so
// Swift owns `@main` is not merely hard, it is ruled out by an assertion in tao.
//
// The webview keeps rendering the résumé canvas, which is not negotiable: PDF
// export hands WKWebView's `createPDF` the live app DOM, so a SwiftUI résumé
// would mean a second rendering engine drifting from the first. What this file
// replaces is only the chrome AROUND that canvas.
//
// This file is compiled straight from here — `project.yml` adds `../../ios` as
// a source path. Do not copy it into `gen/apple/Sources`.
// Its JS counterpart is `src/iosShell.js`; the two share a wire contract that
// is unit-tested there (test/iosShell.test.js).

import Observation
import CloudKit
import PDFKit
import PhotosUI
import SwiftUI
import UIKit
// `UTType`, for the file importers' content types. SwiftUI re-exports enough
// for the literals to typecheck, but the `UTType(filenameExtension:)` lookup
// used for Markdown needs the module named outright.
import UniformTypeIdentifiers
import WebKit

// MARK: - Wire contract

struct ShellProfile: Decodable, Equatable, Identifiable {
  let id: String
  let name: String
  let initials: String
  let isActive: Bool
}

/// What the account holds, for the Workspaces sheet.
///
/// Every value arrives PRE-FORMATTED — the rates as `"42%"`, the median as
/// `"3 days"` — because the page formats them with the functions the desktop
/// Account section uses, and a second rounding rule on this side is how the
/// same account comes to show two different numbers on two screens.
struct ShellAccountStats: Decodable, Equatable {
  let resumes: Int
  let jobDescriptions: Int
  let applications: Int
  let responseRate: String
  let interviewRate: String
  let medianDaysToResponse: String
}

/// Mirrors the snapshot posted by src/iosShell.js. Changing either side
/// without the other silently empties the chrome.
struct ShellSnapshot: Decodable, Equatable {
  /// Which résumé, in which workspace — the pair that identifies what a
  /// command without an id of its own will land on.
  ///
  /// A résumé id is unique only within a workspace, so anything pinning a
  /// target across an unbounded wait has to carry both. See
  /// `ShellModel.ImageRequest`, which pins the same pair for the same reason.
  struct Where: Equatable {
    let profileId: String?
    let variantId: String?
  }

  var whereAmI: Where {
    Where(profileId: profiles.first(where: { $0.isActive })?.id, variantId: variantId)
  }

  struct Variant: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
  }

  var variantId: String?
  var variantName: String
  var variants: [Variant]
  var profiles: [ShellProfile]
  /// `nil` on a page that predates the Workspaces sheet, which is the one case
  /// the sheet has nothing to draw and says so rather than showing zeroes.
  var accountStats: ShellAccountStats?
  var zoom: Double
  var zoomPercent: Int
  var pdfBusy: Bool
  /// A web dialog owns the screen. The chrome floats above the webview, so it
  /// has to step aside or it covers the dialog's own buttons.
  var modalOpen: Bool
  var settings: Settings
  /// `nil` while the chat sheet is closed. Same reasoning as `document`.
  var chat: ChatView?
  /// `nil` while the library is closed.
  /// `nil` while the library is closed. An object rather than a bare list of
  /// entries: the sheet has three tabs, and the stats and timeline are derived
  /// from the SAME applications the entries are, so splitting them across
  /// sibling keys would let them disagree about a résumé that changed
  /// underneath.
  var library: LibraryView?

  /// `nil` while the history sheet is closed. Mirrors `buildHistory()`.
  var history: History?

  /// `nil` while their sheets are closed. Both screens live in their own files
  /// — OPJobs.swift and OPProfile.swift — because this one is the shell, and
  /// two more full editors in it would make it unreadable.
  var jobs: JobsView?
  var profile: ProfileView?

  /// The onboarding / new-résumé wizard, or `nil` while it is closed.
  ///
  /// Unlike every other screen there is no command that opens it: the WEB
  /// wizard's own `open` is the gate, because one component serves both a first
  /// run and the header's "New resume" and it decides which. So this arriving
  /// non-nil IS the instruction to present. Lives in OPOnboarding.swift.
  var onboarding: OnboardingView?

  /// The change-review dialog, or `nil` while it is closed. Like the wizard it
  /// has no open command: the WEB dialog decides, because every entry point
  /// (chat's Review changes, jobs tailoring, history compare, the inline
  /// banner) opens the same one.
  var diff: DiffReview?

  /// Mirrors `buildDiffReview()` in src/iosShell.js.
  ///
  /// **Nothing here applies anything.** The buttons call back into the web
  /// dialog's own handlers: tailoring goes through diffEngine and
  /// `applyChangesToStore`, and Apply All must batch through the ordered
  /// helper rather than loop, because leaf paths are indexed against the
  /// PROPOSED array. That sequence exists once, over there.
  struct DiffReview: Decodable, Equatable {
    let open: Bool
    let title: String
    let changes: [Change]
    /// What Apply All would actually write — not `changes.count`, which
    /// includes everything already decided.
    let pending: Int
    let busy: Bool

    struct Change: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      /// "add" | "remove" | "modify"
      let kind: String
      /// Already rendered for display by the diff engine, so nothing here
      /// formats a résumé value.
      let before: String
      let after: String
      let applied: Bool
      let rejected: Bool
      var id: String { path }
    }
  }

  struct History: Decodable, Equatable {
    /// The résumé these versions belong to. History is per-résumé and the sheet
    /// has no session identity, so a switch underneath it has to be noticed —
    /// restoring a version from another document would overwrite this one.
    let variantId: String
    let entries: [Entry]
    /// The open comparison, if any. Computed on demand: the version PAYLOADS
    /// never ride the snapshot.
    let diff: Diff?

    struct Entry: Decodable, Equatable, Identifiable {
      /// The store's own index — Swift echoes it back and never computes one.
      let index: Int
      let timestamp: String
      let description: String
      let changeType: String
      let label: String
      let isCurrent: Bool
      /// Positional indices renumber, so they are not stable identity. The
      /// timestamp is what makes a row itself.
      var id: String { "\(index)-\(timestamp)" }
    }

    struct Diff: Decodable, Equatable {
      let label: String
      let changes: [ChatView.PendingChange]
    }
  }

  /// Mirrors `buildLibrary()` in src/iosShell.js.
  struct LibraryView: Decodable, Equatable {
    let entries: [LibraryEntry]
    let stats: Stats
    /// NEWEST first, the reverse of the web's left-to-right axis. Flat: which
    /// month a date falls in, and what that month is called, is a locale
    /// question and belongs on this side.
    let timeline: [TimelinePoint]

    struct Stats: Decodable, Equatable {
      let sent: Int
      let responded: Int
      /// `nil` where there is nothing to divide by. Rendered as "—", not 0% —
      /// no replies yet is not a 0% response rate.
      let responseRate: Double?
      let interviewRate: Double?
      let medianDaysToResponse: Double?
      let perVariant: [PerVariant]

      struct PerVariant: Decodable, Equatable, Identifiable {
        let variantId: String
        let variantName: String
        let sent: Int
        let responded: Int
        let interviewed: Int
        var id: String { variantId }
      }
    }

    struct TimelinePoint: Decodable, Equatable, Identifiable {
      let id: String
      let variantId: String
      let variantName: String
      /// ISO 8601. Parsed here so the grouping and the formatting agree.
      let at: String
      let status: String
      let title: String
      let company: String
    }
  }

  struct LibraryEntry: Decodable, Equatable, Identifiable {
    let id: String
    let name: String
    let updatedAt: String
    let applicationCount: Int
    let status: String
    let snippet: String
    let snippetSource: String
  }

  /// Mirrors `buildChatView()` in src/iosShell.js. A subset: threads, messages,
  /// streaming and sending. The model picker, context chips and the AI's
  /// proposed CHANGES stay in the web panel — applying a change runs the diff
  /// engine and a review session, and a partial native version of that is how
  /// someone accepts an edit they never saw.
  struct ChatView: Decodable, Equatable {
    struct Thread: Decodable, Equatable, Identifiable {
      let id: String
      let title: String
      let isCurrent: Bool
    }
    struct Message: Decodable, Equatable, Identifiable {
      let id: String
      let role: String
      let text: String
      let hasChanges: Bool
      /// Raw reasoning summary, unparsed. `ReasoningTimeline` splits and strips
      /// it — the same job `LiveReasoning.jsx` does on the web.
      let reasoning: String
    }
    var threads: [Thread]
    var messages: [Message]
    /// The AI's still-pending edits, from the LIVE review session — not a
    /// message's frozen copy, so applying one removes it here.
    var pendingChanges: [PendingChange]

    struct PendingChange: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      let type: String
      let before: String
      let after: String
      var id: String { path }
    }

    var loading: Bool
    var streaming: Bool
    var configured: Bool
    /// The thread list is not on disk. Storage answers this, not the engine —
    /// the write is behind a coalescing drain and can be refused long after the
    /// send that made it.
    var saveFailed: Bool
    /// The engine's live status line. Empty when idle.
    var thinking: String
    var currentModel: String
    var models: [ModelOption]
    var reasoningEffort: String
    var reasoningSupported: Bool

    struct ModelOption: Decodable, Equatable, Identifiable {
      let id: String
      let label: String
      let group: String
    }
  }

  /// `nil` means the panel is closed and the outline is not being streamed —
  /// distinct from an empty outline, which would blank an open panel.
  var document: DocumentOutline?

  /// A flat, path-keyed projection of the résumé. Swift deliberately does NOT
  /// know the document's schema: it renders labelled fields and echoes back the
  /// paths it was given, so it cannot construct one and cannot become a second
  /// implementation of a grammar whose drift has corrupted data before.
  struct DocumentOutline: Decodable, Equatable {
    /// WHICH document these rows are, so a positional command can say which
    /// one it was computed against. Everything this sheet sends back about a
    /// list is an index, and a drag holds one across time nothing here counts
    /// as busy — long enough for an adopted résumé to renumber the array.
    var revision: Int

    /// The résumé is not on disk. Storage answers this, not the outline
    /// builder — the write is behind a coalescing drain and can be refused
    /// long after the keystroke that made it.
    ///
    /// Non-optional, like every other field in these structs: the projection
    /// always emits all of them, and a partial one should fail to decode
    /// loudly rather than render a sheet that quietly cannot warn.
    var saveFailed: Bool

    struct Field: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      let value: String
      let multiline: Bool
      var id: String { path }
    }
    struct Group: Decodable, Equatable, Identifiable {
      let id: String
      let title: String
      let fields: [Field]
      /// The path of the ARRAY behind this group's list rows, or nil when the
      /// group is a set of fields on one object and cannot be reordered.
      let listPath: String?
      /// How many non-list rows precede the list (a section's heading, a role's
      /// title/company/dates), so a row index maps to an array index.
      let listOffset: Int
      /// The Add button's label, or "" when this group's list cannot grow — a
      /// prose section is one string, not a list of rows.
      let addLabel: String
      /// The array this whole group is an element of, and where in it, for
      /// groups that can be deleted outright (a role, a section). `nil` for
      /// groups that are not array members, like the header.
      let removePath: String?
      let removeIndex: Int
      /// What the confirmation names, so it says "Delete Designer?" rather than
      /// "Delete this?".
      let removeTitle: String
      /// The row's own id, so a confirmation can find it again after the array
      /// under it has changed. Empty for documents older than the ids.
      let removeId: String
    }
    var groups: [Group]
    /// Adding the FIRST of something. A group only exists once its array is
    /// non-empty, so a résumé with no education has no education group — and
    /// without these could never gain one.
    var additions: [Addition]

    struct Addition: Decodable, Equatable, Identifiable {
      let path: String
      let label: String
      var id: String { path }
    }
  }

  /// `nil` while the design sheet is closed. Same reasoning as `document`, and
  /// more of it: this projection carries a dozen option lists and the whole font
  /// catalogue, and it is rebuilt after every design write — which is per FRAME
  /// while a slider is moving.
  var design: Design?

  /// Mirrors `buildDesign()` in src/iosShell.js.
  ///
  /// Every value is a String, Bool or Double: the design model is a pile of CSS
  /// — gradients, hex colours, font stacks — and Swift decodes none of it. It
  /// renders the names it was given, echoes back the ids it was given, and
  /// leaves the meaning of `linear-135` or `#c45c3e` entirely on the web side.
  struct Design: Decodable, Equatable {
    /// An `{ id, name }` pair. Seven of the contract's lists are exactly this
    /// and nothing more; giving each its own type would buy nothing.
    struct Option: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
    }

    struct Page: Decodable, Equatable {
      var size: String
      var orientation: String
      var widthIn: Double
      var groupPositions: Bool
    }

    /// Named for what it holds rather than `Color`, which inside this scope
    /// would shadow SwiftUI's own and make every tile's fill ambiguous.
    struct ColorSettings: Decodable, Equatable {
      var palette: String
      var customColor: String
    }

    /// `p1` accent, `p2` dark, `p3` light — the three tones the web swatch
    /// stripes, in that order.
    struct Palette: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      let p1: String
      let p2: String
      let p3: String
    }

    struct Header: Decodable, Equatable {
      /// solid | gradient | pattern | texture | image
      var type: String
      var styleId: String
      var imageOpacity: Double
      var imageFit: String
      /// Whether an image is set — never the image. A header background is a
      /// megabyte of base64 and the sheet has nothing to say about its pixels.
      var hasImage: Bool
    }

    struct HeaderStyle: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      /// gradient | pattern | texture — the picker's three sections.
      let group: String
      /// The CSS background the web tile paints with, already resolved against
      /// the current palette. Swift renders no CSS; `designSwatchColors` mines
      /// the hex out of it so a tile is at least the right colours.
      let css: String
    }

    struct Fonts: Decodable, Equatable {
      /// preset | google | system
      var mode: String
      /// "" when the two fonts do not add up to a pairing.
      var pairingId: String
      var displayName: String
      var bodyName: String
    }

    struct FontPairing: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      let display: String
      let body: String
    }

    struct GoogleFont: Decodable, Equatable, Identifiable {
      let family: String
      let category: String
      var id: String { family }
    }

    struct Spacing: Decodable, Equatable {
      var fontScale: Double
      var lineHeight: Double
      var sectionSpacing: Double
      var sidebarWidth: Double
      var marginTop: Double
      var marginRight: Double
      var marginBottom: Double
      var marginLeft: Double
      /// "" once the sliders have been moved off every preset.
      var presetId: String
    }

    struct Accent: Decodable, Equatable {
      var underlineStyle: String
      var underlineWidth: Double
      var bulletStyle: String
      var borderRadius: String
      var skillTagStyle: String
      var showCornerTriangle: Bool
      var showSidebarGradient: Bool
    }

    struct Bullet: Decodable, Equatable, Identifiable {
      let id: String
      let name: String
      /// The glyph itself, so a row shows what the résumé will show. Empty for
      /// "None".
      let char: String
    }

    struct Photo: Decodable, Equatable {
      var enabled: Bool
      var hasImage: Bool
      var placement: String
      var shape: String
      var size: String
      var borderColor: String
      /// A CSS `object-position` pair, "left top" through "right bottom".
      var objectPosition: String
      var scale: Double
    }

    /// A design key is not on disk. Each service writes its own, outside the
    /// résumé blob, so neither the document warning nor the settings one can
    /// see a refusal here.
    var saveFailed: Bool

    var page: Page
    var pageSizes: [Option]
    var color: ColorSettings
    var palettes: [Palette]
    var layout: String
    var layouts: [Option]
    var header: Header
    var headerStyles: [HeaderStyle]
    var fonts: Fonts
    var fontPairings: [FontPairing]
    var systemFonts: [Option]
    var googleFonts: [GoogleFont]
    var spacing: Spacing
    var spacingPresets: [Option]
    var accent: Accent
    var underlines: [Option]
    var bullets: [Bullet]
    var radii: [Option]
    var skillTags: [Option]
    var photo: Photo
    var placements: [Option]
    var shapes: [Option]
    var sizes: [Option]
  }

  /// Mirrors `buildSettings()` in src/iosShell.js. A SUBSET of the web Settings
  /// dialog: the updater, the companion bridge and the legacy Electron import
  /// are all desktop-only, and showing controls that cannot work is worse than
  /// not showing them.
  ///
  /// `hasApiKey`, not the key. The key lives in the OS keychain; the sheet can
  /// write a new one but nothing needs to read it back, so nothing does.
  ///
  /// `syncEnabled` remains in the Phase 0 snapshot shape while the web bridge
  /// still projects it, but native sync is automatic and does not read it. The
  /// STATUS is computed here (see `ShellModel.syncStatus`): the account state
  /// lives in the transport, and JS has no way to observe it.
  struct Settings: Decodable, Equatable {
    var theme: String
    var hasApiKey: Bool
    var autoFallback: Bool
    var syncEnabled: Bool
    var version: String
    /// A settings-bearing key is not on disk. Every control on the sheet writes
    /// through the cache and reports success on the value being TAKEN, so the
    /// refusal arrives afterwards — and the toast that carries it on desktop
    /// renders under this sheet.
    var saveFailed: Bool

    static let empty = Settings(
      theme: "system", hasApiKey: false, autoFallback: false, syncEnabled: false, version: "",
      saveFailed: false
    )
  }

  /// What the chrome shows before the first snapshot arrives — a fraction of a
  /// second at launch, but it must not render as blank or as "0%".
  static let empty = ShellSnapshot(
    variantId: nil, variantName: "On Paper", variants: [], profiles: [], accountStats: nil,
    zoom: 1, zoomPercent: 100, pdfBusy: false, modalOpen: false, settings: .empty,
    chat: nil, library: nil, history: nil, jobs: nil, profile: nil,
    document: nil, design: nil
  )
}

extension ShellSnapshot {
  // EVERY stored property needs a case here AND a line in `init(from:)` below.
  // The compiler will not tell you when one is missing: an optional `var` is
  // implicitly nil, so a forgotten decode compiles cleanly and the value is
  // simply always absent. `accountStats` was added to the struct and missed
  // here, and the Workspaces sheet drew without its stats for exactly that
  // reason — no error, no warning, nothing in a log.
  private enum CodingKeys: String, CodingKey {
    case variantId, variantName, variants, profiles, accountStats
    case zoom, zoomPercent, pdfBusy, modalOpen
    case settings, chat, library, history, jobs, profile, onboarding, diff, document, design
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    variantId = try values.decodeIfPresent(String.self, forKey: .variantId)
    variantName = try values.decode(String.self, forKey: .variantName)
    variants = try values.decode([Variant].self, forKey: .variants)
    // A newer shell can briefly host an older cached page during an update.
    // No profile list means no switcher, not a failed snapshot decode.
    profiles = try values.decodeIfPresent([ShellProfile].self, forKey: .profiles) ?? []
    accountStats = try values.decodeIfPresent(ShellAccountStats.self, forKey: .accountStats)
    zoom = try values.decode(Double.self, forKey: .zoom)
    zoomPercent = try values.decode(Int.self, forKey: .zoomPercent)
    pdfBusy = try values.decode(Bool.self, forKey: .pdfBusy)
    modalOpen = try values.decode(Bool.self, forKey: .modalOpen)
    settings = try values.decode(Settings.self, forKey: .settings)
    chat = try values.decodeIfPresent(ChatView.self, forKey: .chat)
    library = try values.decodeIfPresent(LibraryView.self, forKey: .library)
    history = try values.decodeIfPresent(History.self, forKey: .history)
    jobs = try values.decodeIfPresent(JobsView.self, forKey: .jobs)
    profile = try values.decodeIfPresent(ProfileView.self, forKey: .profile)
    onboarding = try values.decodeIfPresent(OnboardingView.self, forKey: .onboarding)
    diff = try values.decodeIfPresent(DiffReview.self, forKey: .diff)
    document = try values.decodeIfPresent(DocumentOutline.self, forKey: .document)
    design = try values.decodeIfPresent(Design.self, forKey: .design)
  }
}

// MARK: - Reply pacing

/// Paces the live reply so it flows instead of landing in bursts.
///
/// Ported from Olia (`Screens/Chat/MessageBubble.swift`,
/// `StreamingAnimationController`). Tokens do not arrive smoothly — the network
/// delivers them in clumps and the JS side coalesces them again before
/// publishing — so rendering the snapshot directly makes a reply appear a
/// paragraph at a time. This holds a target and walks toward it a couple of
/// characters per tick, accelerating when it falls behind, which is what turns
/// arrival into typing.
///
/// A class, not view state: the timer has to outlive any view rebuild, and
/// `deinit` is the only place its invalidation can be guaranteed.
@MainActor
@Observable
final class ReplyStream {
  private(set) var visible = ""
  /// True once the pacing has drawn level with what has actually arrived. Until
  /// then the last line is still being typed.
  private(set) var caughtUp = false

  private var target = ""
  private var displayed = ""

  @ObservationIgnored
  private nonisolated(unsafe) var timer: Timer?

  private enum Pace {
    static let interval: TimeInterval = 0.03   // ~33fps
    static let baseChunk = 2                   // characters per tick at rest
    static let maxChunk = 8                    // ceiling, so catching up is not a jump
    static let accelerateOver = 30             // characters behind before speeding up
  }

  deinit { timer?.invalidate() }

  /// Point the pacing at what has actually arrived so far.
  ///
  /// Shrinking or empty input means a NEW reply (or none), so the pacing resets
  /// rather than trying to walk backwards.
  func update(to text: String) {
    guard text != target else { return }
    if text.isEmpty || !text.hasPrefix(displayed) {
      timer?.invalidate()
      timer = nil
      displayed = ""
      visible = ""
    }
    target = text
    guard !text.isEmpty else { caughtUp = true; return }
    caughtUp = false
    start()
  }

  private func start() {
    guard timer == nil else { return }
    // `.common` mode, not the default one: a timer scheduled the ordinary way
    // stops firing the moment a scroll gesture begins, which freezes the reply
    // for exactly as long as the user is reading it.
    let created = Timer(timeInterval: Pace.interval, repeats: true) { [weak self] t in
      guard t.isValid else { return }
      Task { @MainActor in self?.tick(t) }
    }
    RunLoop.current.add(created, forMode: .common)
    timer = created
  }

  private func tick(_ t: Timer) {
    guard displayed.count < target.count else {
      displayed = target
      t.invalidate()
      timer = nil
      withAnimation(.easeOut(duration: 0.3)) {
        visible = displayed
        caughtUp = true
      }
      return
    }

    let behind = target.count - displayed.count
    let acceleration = min(Double(behind) / Double(Pace.accelerateOver), 3)
    let chunk = max(Pace.baseChunk, min(Int(Double(Pace.baseChunk) * acceleration), Pace.maxChunk))
    let end = wordBoundary(after: displayed.count, within: chunk, in: target)

    let from = target.index(target.startIndex, offsetBy: displayed.count)
    let to = target.index(target.startIndex, offsetBy: end)
    displayed += target[from..<to]
    visible = Self.completeLines(of: displayed)
  }

  /// While typing, prefer to publish only COMPLETE lines: a half-written `##` or
  /// `- ` renders as a heading or a bullet that then changes shape, and the
  /// flicker is worse than the wait.
  ///
  /// Deliberately different from Olia in one place: with no complete line yet it
  /// shows the partial one rather than nothing. Olia waits, which is invisible
  /// there because its replies are short; here a long opening paragraph would
  /// leave the transcript blank for the whole time it was being written.
  private static func completeLines(of text: String) -> String {
    guard let lastNewline = text.lastIndex(of: "\n") else { return text }
    return String(text[...lastNewline])
  }

  /// End the chunk on a word boundary where one is close, so words are never
  /// half-drawn.
  private func wordBoundary(after start: Int, within maxChars: Int, in text: String) -> Int {
    let length = text.count
    let ideal = min(start + maxChars, length)
    guard ideal < length else { return ideal }

    let from = text.index(text.startIndex, offsetBy: ideal)
    let to = text.index(text.startIndex, offsetBy: min(ideal + 3, length))
    if let boundary = text[from..<to].firstIndex(where: { $0.isWhitespace || $0.isPunctuation }) {
      return ideal + text.distance(from: from, to: boundary) + 1
    }
    return ideal
  }
}

/// A generated PDF waiting to be reviewed and saved.
struct PdfPreviewRequest: Equatable, Identifiable {
  /// The temp file this process just wrote. Rendered directly by PDFKit.
  let path: String
  /// The name to offer, without the extension.
  let filename: String
  var id: String { path }
  var url: URL { URL(fileURLWithPath: path) }
}

/// What one round trip to `window.__opShell.command()` produced — see
/// `ShellModel.sendForResult`.
///
/// This was `Any?`, and one `nil` could not carry the answer: it meant "the page
/// returned null", "the command refused", "the eval failed" and "nobody answered
/// inside ten seconds" all at once. `syncUnit` needs the last one told apart
/// from the first. A JS `null` is the page saying it holds nothing under that
/// id — a final answer, and `recordToSend` is right to drop the queued send on
/// it. A timeout is the page not answering AT ALL, and reading that as "nothing"
/// threw a real local edit off the queue, where it stayed until the unit
/// happened to be edited again.
enum ShellReply {
  /// The command ran and returned. `NSNull` is a real JS `null`; `nil` is a
  /// handler that returned nothing, which the dispatcher sends as an absent
  /// `result` key.
  case answered(Any?)
  /// No answer: no webview, the eval failed, the command refused, or the ten
  /// seconds ran out.
  case unanswered
}

/// The only three answers a profile-less page may act on at first launch.
private enum AccountProfilesAnswer: Sendable {
  case known(payload: String)
  case empty
  case unavailable

  var json: String {
    let object: [String: Any]
    switch self {
    case .known(let payload):
      guard let data = payload.data(using: .utf8),
            let profiles = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        return #"{"status":"unavailable"}"#
      }
      object = ["status": "known", "profiles": profiles]
    case .empty:
      object = ["status": "empty"]
    case .unavailable:
      object = ["status": "unavailable"]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let text = String(data: data, encoding: .utf8) else {
      return #"{"status":"unavailable"}"#
    }
    return text
  }
}

// MARK: - Model

/// The single piece of state the chrome renders from. Deliberately not durable:
/// `appStorage` and the Rust disk store stay the source of truth, and this is a
/// projection of them that is thrown away on every update.
@MainActor
final class ShellModel: ObservableObject {
  @Published var snapshot: ShellSnapshot = .empty {
    didSet {
      reply.update(to: Self.liveReplyText(in: snapshot))
      // Every snapshot, because this is the ONLY moment Swift is told a
      // workspace exists. The page owns the registry; a workspace created on
      // another device arrives by fetching it, lands in JS, and reaches this
      // side as a longer profile list on the next publish — with no event of
      // its own. Reconciling here rather than only where a fetch is about to
      // run means the running engine takes on the new zone whenever the page
      // says so, and nothing depends on which of two main-actor jobs the
      // publish and the fetch's continuation happen to run in.
      //
      // Cheap and idempotent: `adoptProfileZones` returns immediately once
      // every named zone is already handled, which is every snapshot but the
      // few that change the list.
      sync.adoptProfileZones(snapshot.profiles.map(\.id))
    }
  }

  /// A purge is an instruction not to recreate what the account owner removed.
  /// Published so Settings can explain the pause and offer the only action that
  /// clears it. The durable marker is loaded before any activation can start
  /// the transport.
  @Published private(set) var syncSuspended: Bool

  /// Covers the webview until profile resolution finishes, never past five
  /// seconds. The timeout is the offline path: launch cannot wait on iCloud.
  @Published private(set) var launchContinuationVisible = true

  private static let accountProfilesTimeout: TimeInterval = 5

  /// The longest the splash will ever hold, from launch.
  ///
  /// It waits for the first pull now, not merely for the registry, so this has
  /// to cover a page coming up AND a fetch completing. Long enough that an
  /// ordinary launch finishes inside it and the workspace is complete the first
  /// time it is drawn; short enough that an unreachable iCloud costs a pause
  /// rather than looking broken. A device that cannot reach iCloud must never
  /// be a device that cannot open its own résumés.
  private static let launchCeiling: TimeInterval = 8
  private var accountProfilesTask: Task<AccountProfilesAnswer, Never>?

  init() {
    syncSuspended = UserDefaults.standard.bool(forKey: Self.syncSuspendedKey)
  }

  /// Start the fixed-zone fetch as soon as the native shell owns the window.
  /// opShared needs no profile id, so this is independent of page bootstrap.
  func beginProfileBootstrap() {
    guard accountProfilesTask == nil else { return }
    accountProfilesTask = Task { await probeAccountProfiles() }
    // The CEILING, not the account probe's own timeout — those are different
    // waits and were the same number by coincidence. The probe answers the
    // page's one boot question; this bounds how long a person looks at a logo.
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.launchCeiling) { [weak self] in
      self?.releaseLaunchContinuation()
    }
  }

  /// Resolve the page's one account question, with a hard five-second ceiling.
  private func probeAccountProfiles() async -> AccountProfilesAnswer {
    await withCheckedContinuation { continuation in
      var settled = false
      let finish: @MainActor (AccountProfilesAnswer) -> Void = { answer in
        guard !settled else { return }
        settled = true
        continuation.resume(returning: answer)
      }

      Task { finish(await Self.fetchAccountProfiles()) }
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.accountProfilesTimeout) {
        MainActor.assumeIsolated { finish(.unavailable) }
      }
    }
  }

  /// Read only the shared registry record. Absence is a known-empty account;
  /// account, network, decode, and permission failures are unavailable.
  private static func fetchAccountProfiles() async -> AccountProfilesAnswer {
    let container = CKContainer(identifier: "iCloud.com.onpaper.app")
    do {
      guard try await container.accountStatus() == .available else { return .unavailable }
      let zoneID = CKRecordZone.ID(
        zoneName: opSharedZoneName, ownerName: CKCurrentUserDefaultName
      )
      let recordID = CKRecord.ID(
        recordName: "key:resume-designer-profiles", zoneID: zoneID
      )
      let record = try await container.privateCloudDatabase.record(for: recordID)
      guard record.recordType == "SyncUnit" else { return .unavailable }

      let payload: String?
      if let inline = record["payload"] as? String {
        payload = inline
      } else if let asset = record["asset"] as? CKAsset, let url = asset.fileURL,
                let data = try? Data(contentsOf: url) {
        payload = String(data: data, encoding: .utf8)
      } else {
        payload = nil
      }
      guard let payload, let data = payload.data(using: .utf8),
            let profiles = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
            profiles.allSatisfy({ $0["id"] is String && $0["name"] is String }) else {
        return .unavailable
      }
      return profiles.isEmpty ? .empty : .known(payload: payload)
    } catch let error as CKError where error.code == .unknownItem || error.code == .zoneNotFound {
      return .empty
    } catch {
      NSLog("[OPShell] account profile lookup unavailable: \(error)")
      return .unavailable
    }
  }

  /// Reply through the early bootstrap command. callAsyncJavaScript is required:
  /// the command participates in an async network answer just like syncApply's
  /// durability answer participates in an async disk write.
  func answerAccountProfilesRequest() async {
    let answer: AccountProfilesAnswer
    if let accountProfilesTask {
      answer = await accountProfilesTask.value
    } else {
      beginProfileBootstrap()
      answer = await accountProfilesTask?.value ?? .unavailable
    }
    guard let text = commandBody("syncAccountProfiles", ["answer": answer.json]),
          let webView else { return }
    webView.callAsyncJavaScript(
      "if (!window.__opProfileBootstrap) return null; "
        + "return await window.__opProfileBootstrap.commandAsync(command);",
      arguments: ["command": text],
      in: nil,
      in: .page
    ) { result in
      if case .failure(let error) = result {
        NSLog("[OPShell] account profile reply failed: \(error)")
      }
    }
  }

  /// The page knows WHICH workspace it is opening. That is not the same as
  /// having its contents, and the splash waits for the contents.
  ///
  /// Releasing here is what made a launch show the workspace as it was when the
  /// app last closed and then fill in seconds later, which reads as the app
  /// losing the other device's edits and then finding them again. Identity
  /// resolves early — it is a registry read — while the records arrive over the
  /// network afterwards.
  ///
  /// Deliberately does NOT release the splash any more. The ceiling armed in
  /// `beginProfileBootstrap` is the only thing that does besides the pull
  /// settling, so a launch waits for content or for the clock, and for nothing
  /// in between.
  func profilesDidResolve() {}

  /// Cover the webview for a reload that changes profile.
  ///
  /// A reload restarts the whole handover: the page comes up as the ORIGINAL
  /// WEB APP, chrome and all, and `activateWeb` retries until the shell takes
  /// it over. At launch nobody sees that because the splash is still up. On a
  /// profile switch nothing covered it, so the desktop UI flashed through every
  /// time — which reads as the app breaking rather than changing profile.
  ///
  /// The same view the launch uses, and that is the right one: the app IS
  /// starting again, on another profile's data. Released by the new profile's
  /// first pull settling, exactly as at launch, with its own ceiling because
  /// the launch timer is long spent.
  func coverForProfileReload() {
    launchContinuationVisible = true
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.launchCeiling) { [weak self] in
      self?.releaseLaunchContinuation()
    }
  }

  /// The initial pull has settled — it landed, or it reported itself
  /// unavailable. Either way there is nothing further to wait for, so the app
  /// opens showing what the ACCOUNT holds rather than what this device last saw.
  ///
  /// One function for both halves of that fact, because they must not drift:
  /// the page uses it to decide whether first-run onboarding may open, and the
  /// splash uses it to decide whether there is still something coming. Sent
  /// from every exit of `runStartSync`, including the ones that never reach
  /// iCloud, so a signed-out or suspended device settles immediately instead of
  /// staring at a logo until the ceiling.
  private func announceInitialFetchSettled(_ status: String) {
    send("syncInitialProfileFetchSettled", ["status": status])
    releaseLaunchContinuation()
  }

  /// Counted rather than a plain flag: the explicit pull at start brackets the
  /// deliveries that happen INSIDE it, so a single boolean would be cleared by
  /// the first arrival while the fetch was still running.
  private var syncPullDepth = 0

  private func beginPull() {
    syncPullDepth += 1
    if syncPullDepth == 1 { syncPulling = true }
  }

  private func endPull() {
    syncPullDepth = max(0, syncPullDepth - 1)
    if syncPullDepth == 0 { syncPulling = false }
  }

  private func releaseLaunchContinuation() {
    guard launchContinuationVisible else { return }
    withAnimation(.easeOut(duration: LaunchScreenContinuationView.dissolveDuration)) {
      launchContinuationVisible = false
    }
  }

  /// Paces the live reply's text. Lives here rather than in the chat sheet so
  /// closing and reopening the sheet mid-reply does not retype it from the top.
  let reply = ReplyStream()

  /// Set when the web side has generated a PDF and wants it reviewed. Unlike
  /// every other sheet this one is opened by the PAGE, not by a toolbar tap —
  /// export runs for a second or two first.
  @Published var pdfPreview: PdfPreviewRequest?

  /// The keychain refused the last API-key write, and nobody has been told yet.
  ///
  /// ON THE MODEL, because the sheet cannot be trusted to still be there. Tap
  /// Save and swipe Settings away and the task keeps running with the failure
  /// flag — and the typed key — in `@State` belonging to a view that is gone:
  /// the keychain says no (a locked device is enough), and reopening Settings
  /// shows an empty field with nothing to say the replacement never landed.
  /// Cleared when a write succeeds, and when the next one starts.
  ///
  /// The KEY itself is deliberately not kept here. It is a credential, and the
  /// shorter it lives in memory the better; losing a typed key to a refusal is
  /// recoverable by typing it again, whereas believing a key was saved when it
  /// was not is the failure this reports.
  @Published var apiKeyWriteFailed = false

  private static func liveReplyText(in snapshot: ShellSnapshot) -> String {
    snapshot.chat?.messages.first { $0.id == "streaming" }?.text ?? ""
  }

  /// Weak: the webview belongs to wry and is retained by the view hierarchy.
  weak var webView: WKWebView?

  /// The CloudKit transport, held STRONGLY and held nowhere else.
  ///
  /// `OPSyncEngine` holds its host weakly (OPSync.swift) so that CKSyncEngine's
  /// own strong hold on its delegate cannot close a cycle around the whole
  /// transport. That makes this the only strong reference in the app: a weak
  /// one here would let the engine deallocate the moment `start` returned, and
  /// the delegate would go with it — no callbacks, no error, no sign anything
  /// had stopped.
  ///
  /// `lazy` because `OPSyncEngine.init` takes `self`, which a stored property's
  /// initializer cannot reach. Assigning it in an `init` would work equally
  /// well; lazy keeps the reason next to the property instead of in a
  /// constructor this class does not otherwise need.
  private lazy var sync = OPSyncEngine(host: self)

  /// What the transport last said about the iCloud account. Drawn as a line in
  /// Settings (`syncStatus`) and nowhere else: signed out is a normal state,
  /// not an error, and it gets no alert.
  @Published private(set) var syncAccountState: OPSyncAccountState?

  /// Whether a pull is in flight RIGHT NOW, for the one place it is worth
  /// saying so.
  ///
  /// Only the pull, never a send. A send is this device's own edit on its way
  /// out and there is nothing to wait for — the résumé on screen is already the
  /// finished article. A pull is the other direction: the screen may be about
  /// to change under the person, and a moment of "something is arriving" is the
  /// difference between that reading as sync and reading as the app altering
  /// their work by itself.
  ///
  /// Deliberately not a status line, a percentage or a banner. There is nothing
  /// useful to say about how far along a fetch is, and sync that announces
  /// itself constantly is sync that feels unreliable.
  @Published private(set) var syncPulling = false

  /// ONE of the failures this device is not already acting on — see
  /// `syncDidFail`. Also only ever a line in Settings.
  ///
  /// WHICH one is not meaningful and deliberately not promised: `syncStatus`
  /// asks whether this is nil and nothing else, because no `CKError` is ever
  /// shown to a person. What IS promised is the bit — non-nil exactly while
  /// `syncOutstanding` holds something.
  @Published private(set) var syncFailure: OPSyncFailure?

  /// The one thing sync says while the app is in USE, rather than in Settings: a
  /// conflict was resolved underneath the person, and the version that lost it
  /// is still there to be restored. `nil` draws nothing. See `announceParked`.
  ///
  /// The design spec asks for "one non-blocking notice per resolution — not per
  /// record", and this is the whole of that. Non-blocking is not a style
  /// preference: sync is background reconciliation, nothing in the app waits on
  /// it, and an alert would take the keyboard away from someone mid-sentence to
  /// report something that has already been handled correctly.
  ///
  /// It lives on the model rather than in the chrome because the CLOCK that
  /// takes it back down is the model's. A notice raised while a sheet is up must
  /// not be cut short — or restarted — by that sheet closing and remounting the
  /// bar.
  @Published private(set) var conflictNotice: String?

  /// Counts notices so a stale hide cannot cut a newer one short — the same
  /// clock `keepZoomOpen` runs in the chrome, for the same reason.
  private var conflictNoticeGeneration = 0

  /// Every failure the status line is still standing behind, keyed the way
  /// Keyed by `OPSyncFailure.scope` — the workspace AND what failed in it: one
  /// unit, or the whole zone. The bare unit id is NOT enough, and neither side
  /// of this may use it: every workspace has a `data:settings`, so workspace A's
  /// save landing took down workspace B's outstanding warning and Settings
  /// reported sync healthy while B had never reached iCloud. The zone entries
  /// were worse — all of them shared one nil key, so any single zone's fetch
  /// succeeding cleared every other zone's failure too.
  ///
  /// `syncDidLand` names landings with the SAME type, and that pairing is the
  /// whole design: a key that only one side can build is a warning that either
  /// never comes down or comes down for the wrong reason.
  ///
  /// This exists so the warning can come DOWN. It used to be one value cleared
  /// only by switching sync off, so a network blip left "some changes haven't
  /// reached iCloud yet" up until relaunch, long after the change had reached
  /// iCloud. The engine says when something lands (`syncDidLand`), and the only
  /// honest reading of that is per-name: unit A failing permanently while unit B
  /// saves fine is still a problem, so clearing on any success would hide A
  /// behind B.
  ///
  /// A SET of ids would have been smaller and is not enough — `syncFailure` has
  /// to publish an `OPSyncFailure`, and synthesising one to stand for an id is a
  /// worse lie than keeping the one that was reported. A dictionary is the same
  /// set with the reported value still attached.
  private var syncOutstanding: [OPSyncScope: OPSyncFailure] = [:]

  /// The profile the page last activated with. The engine may not be running
  /// for it — sync suspended, or no iCloud account — but it is what a later
  /// start has to name, so it is recorded before those gates rather than after.
  /// A switch (which reloads the window) can then be told apart from the same
  /// document coming back after WebKit reclaimed its content process.
  private var syncProfileId: String?

  /// The `OPSyncScope`s — workspace AND unit — `syncDidFail` has already
  /// re-queued once. The bound on the recovery loop; see `syncDidFail` for why
  /// there has to be one, and why one unit id is not enough to key it by.
  private var syncRecovered: Set<OPSyncScope> = []

  /// Ids re-deferred while one persisted queue is being offered. The durable
  /// set stays intact during the await — a kill there must leave every id owed
  /// — so this is what distinguishes an id the completed send settled from one
  /// that a refusal inside that same send owed again. The key identifies either
  /// a profile queue or the device-wide shared queue.
  private var syncDeferredDrainKey: String?
  private var syncDeferredReowed: Set<String> = []

  /// How many times each profile has been OWED a full upload, so a settlement
  /// can tell whether it is settling the debt it set out to pay. See
  /// `sendAllUnits`.
  private var syncFullUploadOwe: [String: Int] = [:]

  /// What a picked image has to still be true of before it is written.
  ///
  /// The RÉSUMÉ as well as the target, because `setDesignImage` writes to
  /// whichever résumé is open when it arrives — it carries no id. Moving this
  /// counter onto the model let a request survive the screen, which was the
  /// point; it also let it survive a résumé switch, which was not. Pick a slow
  /// image, close Design, change résumé, and it lands on the new one.
  ///
  /// And the WORKSPACE, because a résumé id is only unique within one. Two
  /// workspaces holding the same id is not exotic — importing one backup into
  /// both produces it — and a workspace switch does not stop a Swift task: it
  /// reloads the WKWebView, which kills anything in flight on the JS side and
  /// nothing on this one. So the id alone could match again in a workspace that
  /// never asked for the image.
  struct ImageRequest {
    let profileId: String?
    let variantId: String?
    let target: String
    let token: Int
  }

  /// The newest request per (résumé, target).
  ///
  /// ON THE MODEL, not on a screen. It first lived in each screen's `@State`,
  /// which cannot do the job it was added for: leave Photo while a load is in
  /// flight and that screen's counter goes with it, so reopening it starts a
  /// fresh one — commonly at the same number — and the abandoned task passes a
  /// guard that is no longer comparing it against anything.
  ///
  /// Per target, because the header image and the photo are independent: a
  /// header pick must not supersede a photo still loading.
  private var imageRequests: [String: Int] = [:]

  private func imageRequestKey(_ profileId: String?, _ variantId: String?, _ target: String)
    -> String {
    "\(profileId ?? "")|\(variantId ?? "")|\(target)"
  }

  /// The workspace the shell is currently in, as the snapshot reports it.
  private var activeProfileId: String? {
    snapshot.profiles.first(where: { $0.isActive })?.id
  }

  /// Claim the newest request for `target` on the open résumé. Every pick and
  /// every Remove calls this; what it returns is what a finished load checks
  /// itself against.
  @discardableResult
  func beginImageRequest(_ target: String) -> ImageRequest {
    let profileId = activeProfileId
    let variantId = snapshot.variantId
    let key = imageRequestKey(profileId, variantId, target)
    let next = (imageRequests[key] ?? 0) + 1
    imageRequests[key] = next
    return ImageRequest(
      profileId: profileId, variantId: variantId, target: target, token: next
    )
  }

  /// Whether this request is still the one that should be allowed to write.
  ///
  /// Both halves matter. The résumé test refuses a load that finishes after a
  /// switch; the token test refuses one overtaken by a newer pick or a Remove.
  /// Coming BACK to the originating résumé makes an outstanding load valid
  /// again, which is right — it is that résumé's image, and it is open.
  func isCurrentImageRequest(_ request: ImageRequest) -> Bool {
    guard activeProfileId == request.profileId, snapshot.variantId == request.variantId else {
      return false
    }
    return imageRequests[
      imageRequestKey(request.profileId, request.variantId, request.target)
    ] == request.token
  }

  /// A drain is between its first offer and its last settlement. See
  /// `drainSyncDeferred()` for why overlapping drains lose data, and why a
  /// request that arrives during one is remembered instead of dropped.
  private var syncDraining = false
  private var syncDrainAgain = false

  /// The shared zone belongs to the account rather than whichever profile is
  /// active, so its deferred work does too. This remains under the deferred-key
  /// prefix so an explicit account purge clears it with the profile queues.
  ///
  /// The leading underscore is why this can never be a profile's key rather
  /// than merely unlikely to be: `isValidProfileId` is `/^[A-Za-z0-9]+$/`, so
  /// it REJECTS this string, while it would happily accept a profile whose id
  /// was literally `shared`. Relying on `generateProfileId` never emitting that
  /// would rest this on a different function's format — and a shared key
  /// colliding with a profile's would offer that profile's units from every
  /// other profile, sending them to the wrong zone.
  private static let syncDeferredSharedKey = OPSyncEngine.deferredKey("_\(opSharedScope)")

  /// Device-local transport bookkeeping, beside OPSync's own
  /// `op-sync-state-<profile>` and `op-sync-records-<profile>` UserDefaults.
  /// Per-profile because each profile is a different CloudKit zone, and outside
  /// JS storage so neither sync nor a backup can carry one device's debt to
  /// another.
  ///
  /// TRI-STATE, and all three states are load-bearing: absent means this device
  /// has never offered this profile a full upload, `true` means it owes one, and
  /// `false` means it settled one. `runStartSync` creates the debt on absent and
  /// `sendAllUnits` settles it to `false` — never back to absent, or every later
  /// activation of that profile would look like its first.
  private static func syncFullUploadKey(_ profileId: String) -> String {
    "op-sync-full-upload-owed-\(profileId)"
  }

  /// Set when the account's owner deleted this app's data from iCloud. This is a
  /// prompt, not a preference: sync is otherwise automatic, while this marker
  /// keeps the engine down until the person explicitly asks this device to put
  /// its local data back. It must never reuse the removed preference's key —
  /// "does not want sync" is permanent, while "the server was emptied" waits
  /// for one decision and then clears.
  ///
  /// Device-wide rather than per profile because a purge empties the container,
  /// and resuming re-offers every profile this device knows about.
  ///
  /// Set SYNCHRONOUSLY the moment the engine reports the purge, so that no
  /// crash between that event and the recovery work leaves the instruction
  /// unrecorded — see `syncDidPurgeFromICloud`.
  ///
  /// Cleared ONLY by `resumeSyncing`, after it has durably re-owed every known
  /// profile's full upload. Nothing at startup, on a timer, or in account-state
  /// handling clears it.
  private static let syncSuspendedKey = "resume-designer-sync-suspended"

  /// The `startSync` in flight, if any — see `startSync` for why one is enough.
  private var syncStart: Task<Void, Never>?

  /// Set when any batch in the explicit initial pull was refused by the page.
  /// A completed network request is not workspace readiness if its bytes did not
  /// land durably; onboarding must wait for a later successful start instead.
  private var syncInitialFetchRefused = false

  /// What the last `setZoom` said, so a finger resting still does not fire a
  /// command per touch event. Everything a frame carries is in here, because
  /// dropping a frame whose SCALE was unchanged would also drop the pan a
  /// two-finger drag produces.
  private struct ZoomFrame: Equatable {
    let milliPercent: Int
    let live: Bool
    let focus: CGPoint?
  }
  private var lastZoomFrame: ZoomFrame?

  /// Drive the web zoom model from a native pinch.
  ///
  /// Clamped to the same range `zoomControls.js` uses, and de-duplicated at a
  /// tenth of a percent. NOT at a whole percent, which is where this started:
  /// one percent of absolute scale is a 2% jump at a typical fit zoom, so the
  /// canvas visibly stepped from one value to the next instead of tracking the
  /// fingers. A tenth is ~0.8px on the page's 816px width — finer than the
  /// display can show, and the readout still rounds to whole percent.
  ///
  /// `live` marks the frames of a gesture, which the web side applies without
  /// its zoom transition. The de-dupe deliberately lets a repeat through when
  /// `live` changes: the last frame of a pinch is usually the same value as
  /// the one before it, and swallowing it would leave the canvas stuck in
  /// no-transition mode for good.
  ///
  /// `focus` is the midpoint between the fingers, in the canvas view's own
  /// coordinates — which are also the page's client px, because page zoom is
  /// off and the webview is pinned to that view edge to edge. The web side
  /// scrolls to hold that point still, so the zoom happens under the gesture.
  func setZoom(_ value: Double, live: Bool = false, focus: CGPoint? = nil) {
    let clamped = min(max(value, 0.25), 2.0)
    let frame = ZoomFrame(
      milliPercent: Int((clamped * 1000).rounded()),
      live: live,
      focus: focus.map { CGPoint(x: $0.x.rounded(), y: $0.y.rounded()) }
    )
    guard frame != lastZoomFrame else { return }
    lastZoomFrame = frame
    var payload = [
      "value": String(format: "%.4f", clamped),
      "live": live ? "true" : "false",
    ]
    if let focus {
      payload["x"] = String(format: "%.1f", focus.x)
      payload["y"] = String(format: "%.1f", focus.y)
    }
    send("setZoom", payload)
  }

  /// Send a command to `window.__opShell.command()`.
  ///
  /// The payload crosses as a JS *string literal* rather than an object
  /// literal, so nothing in it can be parsed as code however it was built.
  /// `onResult` receives the dispatcher's own `ok` — false when the command ran
  /// and REFUSED, which is different from the eval failing. Most callers do not
  /// care, because the next snapshot shows whether the write landed; the ones
  /// that address a version by index do, because a refusal there means the
  /// history renumbered under the sheet and the user has to be told.
  func send(
    _ type: String, _ extra: [String: String] = [:], onResult: ((Bool) -> Void)? = nil
  ) {
    evaluate(type, extra) { reply in
      guard let onResult else { return }
      onResult((reply?["ok"] as? Bool) == true)
    }
  }

  /// `send`, but with the JS handler's own RETURN VALUE.
  ///
  /// The dispatcher replies `{ ok, result }` and `send` collapses that to `ok`,
  /// which is all any command needed until sync: `syncUnit` asks the page for a
  /// unit and the unit is the point.
  ///
  /// A PROMISE IS AWAITED, and that is why this goes through
  /// `callAsyncJavaScript` rather than `evaluateJavaScript` (see `evaluateAsync`
  /// and `syncApply` in iosShell.js). `evaluateJavaScript` cannot serialize a
  /// promise, so the dispatcher's synchronous entry point drops one — and an
  /// apply is not confirmed until the bytes are on disk, which is a promise.
  /// Every other caller here answers synchronously and is unaffected: an
  /// already settled value crosses this path exactly as it crossed the other
  /// one.
  func sendForResult(_ type: String, _ extra: [String: String] = [:]) async -> ShellReply {
    await withCheckedContinuation { continuation in
      // Resumed exactly once, from whichever of the two paths below arrives
      // first. Both land on the main thread — WKWebView calls its completion
      // handlers there, and the timer is on the main queue — so the flag needs
      // no lock.
      var settled = false
      let finish: @MainActor (ShellReply) -> Void = { value in
        guard !settled else { return }
        settled = true
        continuation.resume(returning: value)
      }

      evaluateAsync(type, extra) { reply in
        guard let reply, (reply["ok"] as? Bool) == true else {
          finish(.unanswered)
          return
        }
        finish(.answered(reply["result"]))
      }

      // BOUNDED, because `evaluateJavaScript` against a webview that is still
      // loading never calls back at all — measured, see `activateWeb`. That is
      // a live state here and not a hypothetical: WebKit reclaims the content
      // process of a backgrounded app and reloads on return, while the sync
      // engine sends on a schedule of its own. A continuation that never
      // resumes would suspend the engine's batch builder and with it every
      // later send for the life of the process, silently. Ten seconds is far
      // longer than a reply to a live page takes and short enough that the
      // engine is not left waiting on a page that is gone.
      //
      // It bounds the PAGE'S PROMISE too, now that one can be awaited here: a
      // disk that never answers times out as `.unanswered`, which is a `false`
      // from `syncDidFetch`, which forfeits the change tags. The safe direction,
      // and the same one every other way of not knowing takes.
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
        MainActor.assumeIsolated {
          if !settled { NSLog("[OPShell] command \(type) never answered") }
          finish(.unanswered)
        }
      }
    }
  }

  /// Ask the page to run the shared save-before-pointer switch path. The page
  /// answers true only after both editors and the active pointer are durable;
  /// this side owns the WKWebView reload and must not reload on any other reply.
  ///
  /// ANSWERED, like its three siblings below. A `false` means the workspace on
  /// screen is the one still open, and the menu that asked has already closed —
  /// so with the result dropped, a refused switch and a switch that had not
  /// happened yet looked exactly alike. Deliberately NOT `@discardableResult`:
  /// there is one caller, and a second one that ignored this would be the bug
  /// this comment is about.
  func switchToProfile(_ id: String) async -> Bool {
    guard case .answered(let value) = await sendForResult("switchProfile", ["id": id]),
          value as? Bool == true else { return false }
    coverForProfileReload()
    webView?.reload()
    return true
  }

  /// Create a workspace and open it. Reloads for the same reason a switch does:
  /// the page maps every owned key through the active profile, and the mapping
  /// is fixed at boot.
  @discardableResult
  func createProfile(named name: String) async -> Bool {
    guard case .answered(let value) = await sendForResult("createProfile", ["name": name]),
          value as? Bool == true else { return false }
    coverForProfileReload()
    webView?.reload()
    return true
  }

  /// Rename in place. NO reload: nothing about the storage mapping changed, and
  /// the new name arrives on the next snapshot like any other edit.
  @discardableResult
  func renameProfile(_ id: String, to name: String) async -> Bool {
    guard case .answered(let value) = await sendForResult(
      "renameProfile", ["id": id, "name": name]
    ) else { return false }
    return value as? Bool == true
  }

  /// Delete a workspace. Only ever one that is NOT active — the sheet does not
  /// offer it for the open one — so the mapping is untouched and the registry
  /// change rides the next snapshot.
  @discardableResult
  func deleteProfile(_ id: String) async -> Bool {
    guard case .answered(let value) = await sendForResult("deleteProfile", ["id": id])
    else { return false }
    return value as? Bool == true
  }

  /// Save the OpenRouter key, and say whether the keychain took it.
  ///
  /// Asked FOR AN ANSWER rather than sent, because a keychain can refuse — the
  /// device is locked, access is denied — and the sheet clears the field the
  /// user typed into. Without an answer that clearing is unconditional, so a
  /// refused write loses the key with nothing on screen to say so.
  /// The chain of key writes still to finish, and how many are outstanding.
  ///
  /// SERIALISED, and on the model rather than on the sheet. `savingApiKey` used
  /// to be the sheet's own `@State`, so swiping Settings away and reopening it
  /// gave a fresh sheet that believed nothing was in flight — it would offer
  /// Save and Remove again while the first write was still crossing to the
  /// keychain, and nothing below here ordered the two. The older key could land
  /// last and overwrite the newer choice.
  private var apiKeyWriteChain: Task<Bool, Never>?
  private var apiKeyWritesOutstanding = 0

  /// A key write is crossing. Published, so every sheet instance agrees.
  @Published var apiKeyWriteInFlight = false

  /// A rename or delete in the Profiles sheet was refused, and nobody has been
  /// told yet.
  ///
  /// ON THE MODEL for the same reason the key's refusal is: the durability
  /// check is a round trip to the page, and the sheet can be swiped away during
  /// one. Held in the sheet's own `@State`, a refusal arriving afterwards wrote
  /// into a view that was gone — and reopening Profiles showed the rolled-back
  /// profile sitting there again with nothing to say why.
  @Published var profileActionFailure: String?

  func saveApiKey(_ key: String) async -> Bool {
    // Each write waits for the one before it, so the LAST one asked for is the
    // last one to land — which is the only ordering a person could predict.
    let previous = apiKeyWriteChain
    let write = Task { @MainActor [weak self] in
      _ = await previous?.value
      guard let self else { return false }
      guard case .answered(let value) = await self.sendForResult("setApiKey", ["value": key])
      else { return false }
      return value as? Bool == true
    }
    apiKeyWriteChain = write
    apiKeyWritesOutstanding += 1
    apiKeyWriteInFlight = true

    let ok = await write.value

    apiKeyWritesOutstanding -= 1
    // Only the last one out turns the light off, and drops the chain so the
    // next write starts a fresh one rather than awaiting a finished task.
    if apiKeyWritesOutstanding == 0 {
      apiKeyWriteInFlight = false
      apiKeyWriteChain = nil
    }
    return ok
  }

  /// The command body, encoded once for both ways of asking.
  ///
  /// `nil` means it could not be built or there is nobody to ask; the caller
  /// must still answer whoever is waiting.
  private func commandBody(_ type: String, _ extra: [String: String]) -> String? {
    var body: [String: String] = extra
    body["type"] = type
    guard let json = try? JSONSerialization.data(withJSONObject: body),
          let text = String(data: json, encoding: .utf8) else {
      NSLog("[OPShell] could not encode command: \(type)")
      return nil
    }
    return text
  }

  /// One command out, one reply back. `send` uses this; `sendForResult` uses
  /// `evaluateAsync`, and the two differ only in whether a promise is awaited.
  ///
  /// `handle` is called exactly once, including when there is no webview to ask
  /// — a caller awaiting an answer has to get one.
  private func evaluate(
    _ type: String, _ extra: [String: String], _ handle: @escaping @MainActor ([String: Any]?) -> Void
  ) {
    guard let text = commandBody(type, extra),
          let literal = Self.jsStringLiteral(text) else {
      handle(nil)
      return
    }
    guard let webView else {
      NSLog("[OPShell] no webview for command: \(type)")
      handle(nil)
      return
    }
    webView.evaluateJavaScript("window.__opShell && window.__opShell.command(\(literal))") { value, error in
      if let error { NSLog("[OPShell] command \(type) failed: \(error)") }
      let reply = error == nil ? value as? [String: Any] : nil
      Task { @MainActor in handle(reply) }
    }
  }

  /// `evaluate`, through the API that AWAITS what the page returns.
  ///
  /// `callAsyncJavaScript` runs the body as an async function and resolves the
  /// promise before calling back, which is the whole reason it is here — see
  /// `applyUnits` in syncModel.js, whose answer is only true once the fetched
  /// content is on disk. Hand-rolling that with a token and a `postMessage`
  /// would be a second continuation registry racing the round trip it belongs
  /// to; WebKit already owns this one.
  ///
  /// The command crosses in `arguments` rather than as a quoted literal — the
  /// bridge's own escaping, which is one less thing to get right than
  /// `jsStringLiteral`, and nothing in it can be parsed as code either way.
  ///
  /// `handle` is called exactly once, on the main actor, as in `evaluate`.
  private func evaluateAsync(
    _ type: String, _ extra: [String: String], _ handle: @escaping @MainActor ([String: Any]?) -> Void
  ) {
    guard let text = commandBody(type, extra) else {
      handle(nil)
      return
    }
    guard let webView else {
      NSLog("[OPShell] no webview for command: \(type)")
      handle(nil)
      return
    }
    webView.callAsyncJavaScript(
      "if (!window.__opShell) return null; return await window.__opShell.commandAsync(command);",
      arguments: ["command": text],
      in: nil,
      in: .page
    ) { result in
      switch result {
      case .success(let value):
        handle(value as? [String: Any])
      case .failure(let error):
        NSLog("[OPShell] command \(type) failed: \(error)")
        handle(nil)
      }
    }
  }

  /// Quote `text` as a JS string literal using JSON's own escaping.
  private static func jsStringLiteral(_ text: String) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: [text]),
          let array = String(data: data, encoding: .utf8) else { return nil }
    // Strip the array brackets JSONSerialization needs at top level.
    let quoted = String(array.dropFirst().dropLast())
    // JSON permits raw U+2028/U+2029 inside strings; older JS parsers reject
    // them inside string literals. Cheap to escape, so never worth debugging.
    return quoted
      .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
      .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
  }
}

// MARK: - Sync

/// Driving the transport. A document coming up, a save landing, and a return to
/// the foreground drive automatic reconciliation. The one UI action is an
/// explicit resume after a purge; no failure becomes a dialog.
extension ShellModel {
  /// The page's answer to `syncCollect`: the id of every unit this device would
  /// push when this profile first starts or resumes after a purge.
  ///
  /// A purge can suspend sync during that round trip, and a batch that arrives
  /// afterward must not be sent. A transport that is merely DOWN keeps the
  /// persisted debt: `sendSync` may also hold the ids for the next start, but a
  /// profile switch drops that process-local set because the ids belong to
  /// another zone. Re-collecting from the persisted marker closes that hole.
  func sendAllUnits(_ unitIds: [String], forProfile answered: String) async {
    guard !syncSuspended else {
      NSLog("[OPShell] iCloud sync is suspended; \(unitIds.count) unit(s) not sent")
      return
    }
    // THE ANSWER NAMES ITS OWN WORKSPACE. Several asks can be outstanding — a
    // device that has never synced owes one per workspace — so settling against
    // whichever profile happens to be open would clear a debt that was never
    // paid and send one workspace's contents into another's zone. An older page
    // that does not echo the id is answering the ask this side used to make,
    // which was always about the open profile.
    let profileId = answered.isEmpty ? syncProfileId : answered
    guard let profileId, syncFullUploadOwed(profileId: profileId) else {
      NSLog("[OPShell] no full upload is owed; \(unitIds.count) collected unit(s) ignored")
      return
    }
    NSLog("[OPShell] offering \(unitIds.count) unit(s) for \(profileId)'s full upload")
    // WHICH debt, not just whether one was owed. The marker is a Bool, so a
    // debt re-owed during the send below is indistinguishable from the one this
    // call is paying — and settling then clears a claim about an account that
    // has never seen any of these units.
    //
    // It happens on the longest suspension in this file. `syncDidSwitchAccounts`
    // re-owes every considered profile, and it is a CKSyncEngine delegate event,
    // delivered from inside the very `sendChanges()` this is waiting on. Nothing
    // would have re-created the debt afterwards: settlement is deliberately a
    // `false` rather than a delete, so the profile stays "considered" and
    // `runStartSync` never offers it again.
    let owed = syncFullUploadOwe[profileId, default: 0]
    let sent = await sendSync(unitIds: unitIds, inProfile: profileId)
    guard sent else { return }
    guard syncFullUploadOwe[profileId, default: 0] == owed else {
      NSLog("[OPShell] \(profileId)'s full upload was re-owed mid-send; keeping the debt")
      return
    }
    setSyncFullUploadOwed(false, profileId: profileId)
  }

  /// Stop through the same ONE-AT-A-TIME chain as `startSync`. Capturing the
  /// current tail before installing this task is what orders an explicit resume
  /// behind the stop instead of letting its start enter `cancelOperations`.
  /// Server cleanup stays inside this task too, so resume cannot recreate an
  /// engine between teardown and forgetting the purged server's bookkeeping.
  private func stopSync(forgettingServer: Bool = false) async {
    let previous = syncStart
    let task = Task { @MainActor [weak self] in
      await previous?.value
      await self?.sync.stop()
      // The status line is about a transport that is now down; keeping the last
      // account state or failure would leave it describing a stopped engine.
      self?.syncAccountState = nil
      self?.forgetSyncFailures()
      if forgettingServer {
        OPSyncEngine.forgetEverythingAboutTheServer()
      }
    }
    syncStart = task
    await task.value
    // Only if nothing queued behind it, or this would drop a start still to run.
    if syncStart == task { syncStart = nil }
  }

  /// Bring sync up for the profile the webview just loaded, and pull once.
  ///
  /// Called from the `activated` message, which is posted once per document —
  /// a first load, a profile switch (which reloads the window), or WebKit
  /// reclaiming a backgrounded content process and reloading. `start` is
  /// idempotent for the profile already running, so the repeats cost nothing
  /// and, importantly, do not tear down the engine's in-memory queue.
  ///
  /// ONE AT A TIME. That idempotency only holds up to the first suspension:
  /// `sync.start` checks whether the engine is already up for this profile, and
  /// `stop()`'s `await cancelOperations()` is a window in which a second caller
  /// passes the same check and builds a second `CKSyncEngine` over the first.
  /// An activation landing on a foreground `resumeSync` is exactly that pair,
  /// and the engine is the one object every other piece of state here is keyed
  /// to.
  ///
  /// Serialized rather than coalesced: a profile switch and a foreground resume
  /// can name DIFFERENT profiles, so the second call has real work to do and
  /// folding it into the first would skip the switch. It waits its turn instead.
  func startSync(profileId: String) async {
    let previous = syncStart
    let task = Task { @MainActor [weak self] in
      await previous?.value
      await self?.runStartSync(profileId: profileId)
    }
    syncStart = task
    await task.value
    // Only if nothing queued behind it, or this would drop a start still to run.
    if syncStart == task { syncStart = nil }
  }

  private func runStartSync(profileId: String) async {
    guard !profileId.isEmpty else {
      // Before the workspace has an active profile there is no zone to sync
      // to. The app works; sync waits for the next activation.
      NSLog("[OPShell] no active profile in the activation — sync stays down")
      announceInitialFetchSettled("unavailable")
      return
    }
    if syncProfileId != profileId {
      // A different profile is a different zone and a different engine session,
      // so the previous session's process-local recovery attempts do not carry
      // over. Profile-scoped deferred ids stay under that profile's persisted
      // key; the account-scoped shared queue is safe to carry across sessions.
      syncRecovered.removeAll()
      syncDeferredDrainKey = nil
      syncDeferredReowed.removeAll()
      // Outstanding failures do NOT all go with them. The replacement session
      // covers every workspace in the registry and the shared zone, so most of
      // these can still be landed by the very zone they name; only a workspace
      // that has left the registry is beyond it. See `forgetSyncFailures(outside:)`.
      //
      // `""` is the shared zone, which every session holds. A registry that has
      // not arrived yet narrows this to the activating workspace alone, which
      // errs toward the old blanket behaviour — dropping a warning, never
      // stranding one.
      forgetSyncFailures(
        outside: Set(profileIdsForSession(activating: profileId)).union([""])
      )
      syncProfileId = profileId
    }

    // THE GATE. Every way the transport comes up runs through here — document
    // activation, a return to the foreground, and the explicit resume action.
    // A purge means the account owner emptied this app's iCloud data, so an
    // automatic start would recreate the zone and put this device's workspace
    // back. Nothing clears this marker except `resumeSyncing`.
    if syncSuspended {
      NSLog("[OPShell] this app's iCloud data was deleted by the account's owner — "
            + "the transport stays down and nothing is re-sent")
      announceInitialFetchSettled("unavailable")
      return
    }

    let knownProfileIds = profileIdsForSession(activating: profileId)

    // EVERY one of those workspaces' debt, if this device has never offered one.
    //
    // Workspaces are a shipped feature, so there are usually several. Every
    // profile's pre-existing resumes must be offered when it first starts: a
    // unit arrives in the account only when `send(unitIds:)` names it, and
    // persistence names a unit once, on the save that wrote it.
    //
    // Created on the profile's first start PAST THE GATE, which is the same
    // moment this profile is eligible to sync. Above the account check because a
    // debt is OWED, not sent, so a start while signed out still records it and
    // whichever later start reaches iCloud pays it.
    //
    // ONCE per profile per install, and the marker is what guarantees that
    // rather than a guess about when activations happen. An `activated` message
    // is posted per DOCUMENT — every profile switch, every relaunch, and every
    // time WebKit reclaims the content process and reloads — so a re-collection
    // on each one would be a whole-workspace re-upload several times a day.
    // `setSyncFullUploadOwed` now records `false` on settlement instead of
    // removing the key, so a settled debt is still a decision on record and only
    // a genuinely never-seen profile is absent here. Nothing removes the key
    // afterwards, so this branch cannot be taken twice for the same profile.
    // Not only the OPEN one, which is the change. A device that upgrades with
    // several workspaces has résumés in all of them, and owing a full upload
    // only for whichever happened to be open left the rest as registry entries
    // with empty zones — the other device offers the workspace in its switcher
    // and finds nothing inside. Opening a workspace is a UI act; whether its
    // contents are the person's data is not.
    for known in knownProfileIds where !syncFullUploadConsidered(profileId: known) {
      NSLog("[OPShell] first gated start seen for \(known) — a full upload is owed")
      setSyncFullUploadOwed(true, profileId: known)
    }

    // The page owns the registry and names every profile explicitly. Swift
    // carries those ids unchanged; the engine still adds the active profile as
    // a fallback when an older cached page supplied no list.
    let state = await sync.start(profileId: profileId, knownProfileIds: knownProfileIds)
    syncAccountState = state
    guard state == .available else {
      // Signed out, restricted, or iCloud not reachable. All normal, none an
      // error, and NOTHING local changes because of them — an empty server is
      // not what this means.
      NSLog("[OPShell] sync is not running: \(state)")
      announceInitialFetchSettled("unavailable")
      return
    }

    // THE SHARED ZONE FIRST, AND BEFORE ANYTHING GOES UP. It holds the profile
    // registry, which is what a device that has just been installed reads to
    // discover that this account already has workspaces — and that device is
    // never a blank slate: init has already given it a starter workspace of its
    // own, and it owes a full upload. Either send below would put that starter
    // workspace on the server first, and after that nothing tells the two apart.
    // So this one zone is pulled ahead of the drain rather than with the rest.
    //
    // Not fatal when it fails, like every other fetch here: the device runs on
    // the registry it has and tries again at the next start.
    // The registry has just landed, so the profile list handed to `start` above
    // is already out of date on the launch that matters most: a fresh install
    // starts knowing only the workspace it minted, and this pull is the moment
    // it learns the account's others. Their zones have to be inside the scope of
    // the general fetch below, which is the only pull this launch makes.
    //
    // That reconciliation is NOT done here. It rides the snapshot's `didSet`,
    // which fires when the page republishes the longer list — see there for why
    // that is the reliable place and this is not.
    try? await sync.fetchShared()

    // Anything this device still owes a send of goes up before the pull, so a
    // unit changed on both sides meets the conflict path rather than being
    // quietly overwritten by what arrives. That is also the only thing that can
    // recover a batch the page would not apply: the pull cannot re-deliver it —
    // the change token has moved past it — but a send with no tag brings it back
    // down that same conflict path. See `syncDeferred`.
    await drainSyncDeferred()
    syncInitialFetchRefused = false
    beginPull()
    do {
      try await sync.fetch()
      endPull()
      announceInitialFetchSettled(syncInitialFetchRefused ? "unavailable" : "ready")
    } catch {
      endPull()
      NSLog("[OPShell] initial profile fetch unavailable: \(error)")
      announceInitialFetchSettled("unavailable")
    }

    // The first automatic start, and an explicit resume after a purge, are the
    // moments this device offers everything it already holds. A unit reaches the
    // account only when `send(unitIds:)` names it, and persistence names a unit
    // once — on the save that wrote it — so a resume the person never edits again
    // would otherwise never arrive at all. The page answers `syncCollect` with a
    // `syncUnits` message.
    //
    // Requesting the collection does NOT clear the debt. The process can die,
    // the page can reload, or `sendSync` can defer these ids; only a successful
    // send in `sendAllUnits` clears it.
    //
    // One ask per owing workspace. The page can collect any of them without
    // opening it — `collectUnits(profileId)` reads that profile's namespaced
    // keys directly — so this does not disturb what is on screen. Each answer
    // names the workspace it is for, because several can be in flight.
    for owing in knownProfileIds where syncFullUploadOwed(profileId: owing) {
      send("syncCollect", ["profileId": owing])
    }
  }

  /// Back in the foreground: another device may have moved on while this one
  /// was away.
  ///
  /// The whole activation path rather than a bare `fetch`, because the engine
  /// may never have come up — signed out at launch, or no network — and nothing
  /// else would bring it up before the next document load. `start` is
  /// idempotent for the profile already running, so the ordinary case costs one
  /// account-status check.
  ///
  /// Backgrounding needs no counterpart: the save debounce has already posted
  /// `syncDirty` for anything that changed.
  ///
  /// Gated like every other way up, because it goes through `startSync`: a
  /// device suspended after a purge must not quietly start syncing the first
  /// time the app comes back to the foreground.
  func resumeSync() async {
    // No activation yet means no profile and no engine; that path fetches for
    // itself the moment the document comes up.
    guard let syncProfileId else { return }
    await startSync(profileId: syncProfileId)
  }

  /// Units whose bytes just landed on disk, named by `syncDirty`.
  ///
  /// The engine flushes EVERYTHING pending rather than just these, on purpose
  /// (OPSync.swift): a unit whose last send failed transiently is sitting in
  /// that queue and would otherwise wait for its own next edit.
  @discardableResult
  func sendSync(unitIds: [String], inProfile profileId: String? = nil) async -> Bool {
    guard !syncSuspended else {
      NSLog("[OPShell] iCloud sync is suspended; \(unitIds.count) changed unit(s) not sent")
      return false
    }
    // An answered collection can legitimately be empty. There is no transport
    // work to do, and treating that as sent lets its persisted debt settle.
    guard !unitIds.isEmpty else { return true }
    // RESOLVED NOW, before the send suspends, and carried into the catch.
    //
    // The `syncDirty` handler maps the open workspace to nil, and `deferSync`
    // used to resolve a nil against `syncProfileId` when its own body ran. That
    // is a different moment: `send` suspends asking the page for scopes, and a
    // restore that also switches workspaces ends in a reload whose `activated`
    // assigns a NEW `syncProfileId` with no await in front of it. The deferral
    // could therefore resume after the switch and file the OLD workspace's debt
    // under the NEW workspace's key — where the next drain collects the wrong
    // bytes for those ids, or none, and settles the debt either way. Nothing
    // names those units again, so the content simply never leaves the device.
    let owning = profileId ?? syncProfileId
    do {
      // `owning`, not `profileId`. Passing the original nil made the SEND
      // resolve late too — against `OPSyncEngine.profileId`, which during a
      // profile switch still names the previous workspace until `sync.start`
      // has finished stopping and replacing the engine, while `syncProfileId`
      // has already moved. The send then queued these ids in the old
      // workspace's zone, or dropped one that does not exist there, and
      // returned success either way: not deferred, not uploaded, not reported.
      // Capturing the workspace and then not using it for the one call that
      // routes the bytes was half a fix.
      try await sync.send(unitIds: unitIds, inProfile: owning)
      return true
    } catch {
      // Four things reach here, and three of them queued nothing at all before
      // throwing: `notStarted` — signed out, or an edit that beat the first
      // activation; `scopeUnknown`, the page not saying which zone these units
      // belong in, which is refused rather than routed on a guess; and
      // `eventInFlight`, which must wait until the delegate call has returned.
      // Holding the ids is the whole of what those three need. The fourth is
      // anything `engine.sendChanges()` itself throws, and holding costs it nothing:
      // `send` queued those changes before it threw and
      // `add(pendingRecordZoneChanges:)` deduplicates, so the next start
      // re-queues nothing that is already there.
      //
      // These ids are the ONLY record that those bytes changed: persistence
      // names a unit once, on the save that wrote it, and will not name it
      // again until it is edited again. So they wait for the next start instead
      // of being dropped — under the profile this send was FOR, which is the
      // open one only when nobody named another.
      await deferSync(unitIds, inProfile: owning)
      NSLog("[OPShell] sync send postponed; \(unitIds.count) unit(s) held durably")
      return false
    }
  }

  /// Unit ids this device still owes the server a send of. Profile-scoped ids
  /// remain confined to their profile's key; shared ids use one device-wide key
  /// because their zone belongs to the account, not the active profile.
  private func syncDeferred(key: String) -> Set<String> {
    Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
  }

  private func setSyncDeferred(_ unitIds: Set<String>, key: String) {
    UserDefaults.standard.set(Array(unitIds).sorted(), forKey: key)
  }

  private func addSyncDeferred(_ unitIds: Set<String>, key: String) {
    guard !unitIds.isEmpty else { return }
    var deferred = syncDeferred(key: key)
    deferred.formUnion(unitIds)
    setSyncDeferred(deferred, key: key)
    if syncDeferredDrainKey != nil {
      // Any fallback while a queue is draining may owe one of that queue's
      // offered ids again, even when the durable destination is another key.
      // Over-recording is safe: ids outside `offered` change no settlement,
      // while missing one here would silently settle debt that is owed again.
      syncDeferredReowed.formUnion(unitIds)
    }
  }

  /// Additive only. In particular, offering an id never removes it first in the
  /// hope that this function will put it back: the process can die between
  /// those operations, which is the durability hole this bookkeeping closes.
  /// Every id is first made durable under the active profile, before the scope
  /// ask can suspend. A shared answer adds a second, device-wide copy; the
  /// start-time hoist removes the fallback only after that copy is durable.
  private func deferSync(_ unitIds: [String], inProfile requested: String? = nil) async {
    // WHOSE DEBT THIS IS. Nil means the open profile, which is right for a send
    // that failed — those units came from the open workspace. It is wrong for a
    // FETCH that would not apply: that record arrived in some zone, and the
    // recovery is to send this device's copy of it back into THAT zone so the
    // server answers `serverRecordChanged` and returns its own. Recorded under
    // the open profile instead, the retry collected the open workspace's value
    // for the id and sent it to the open workspace's zone — so the profile that
    // actually needed the round trip never got one, and its change token had
    // already moved past the record, meaning nothing would deliver it again.
    guard let profileId = requested ?? syncProfileId else {
      NSLog("[OPShell] no active profile for \(unitIds.count) deferred sync unit(s)")
      return
    }
    let ids = Array(Set(unitIds)).sorted()
    guard !ids.isEmpty else { return }
    let profileKey = OPSyncEngine.deferredKey(profileId)
    addSyncDeferred(Set(ids), key: profileKey)
    guard let scopes = await syncScopes(forUnitIds: ids) else { return }

    let shared = Set(ids.filter { scopes[$0] == opSharedScope })
    addSyncDeferred(shared, key: Self.syncDeferredSharedKey)
  }

  /// Reclassify every profile queue's durable snapshot once the page is back.
  /// This repairs shared ids parked by the `nil` fallback even when their old
  /// profile is inactive or tombstoned. Enumerating these device-local keys is
  /// bookkeeping only; `syncScopes` remains the sole scope authority.
  ///
  /// The shared queue is written first; only then are those ids removed from
  /// any profile queue, so a process death between writes can duplicate debt
  /// but cannot lose it.
  private func hoistSharedSyncDeferred() async {
    let defaults = UserDefaults.standard
    let prefix = OPSyncEngine.deferredKey("")
    var profileQueues: [String: Set<String>] = [:]
    var offered: Set<String> = []

    for key in defaults.dictionaryRepresentation().keys
    where key.hasPrefix(prefix) && key != Self.syncDeferredSharedKey {
      let deferred = syncDeferred(key: key)
      guard !deferred.isEmpty else { continue }
      profileQueues[key] = deferred
      offered.formUnion(deferred)
    }

    guard !offered.isEmpty,
          let scopes = await syncScopes(forUnitIds: Array(offered).sorted()) else { return }

    let shared = Set(offered.filter { scopes[$0] == opSharedScope })
    guard !shared.isEmpty else { return }
    addSyncDeferred(shared, key: Self.syncDeferredSharedKey)

    for key in profileQueues.keys {
      var deferred = syncDeferred(key: key)
      deferred.subtract(shared)
      setSyncDeferred(deferred, key: key)
    }
  }

  /// Pay EVERY workspace's debt, not just the open one's.
  ///
  /// Debt is recorded per profile because it is only recoverable in that
  /// profile's zone. Draining only the open profile's queue meant a fetch into
  /// another workspace that the page would not apply waited for somebody to
  /// switch to that workspace — and the change token had already moved past the
  /// record, so until they did, nothing would deliver it again. On a device
  /// where that workspace is never opened, "until they did" is never.
  ///
  /// The open profile's queue is one of these and needs no special case, which
  /// is why this takes no profile any more. A queue whose profile the engine
  /// does not handle — one left behind by a deleted workspace — fails its zone
  /// lookup and keeps its debt, at the cost of a refused send and no round trip.
  ///
  /// Hoist first so a shared id parked by the `nil` fallback reaches the queue
  /// that every profile drains. `fetchShared` has already run before this call,
  /// preserving the shared-zone fetch-before-send order.
  ///
  /// ONE AT A TIME, and that is load-bearing rather than tidy.
  /// `syncDeferredDrainKey`/`syncDeferredReowed` are a single scratch pair, and
  /// `drainSyncDeferred(key:)` both arms them on entry and clears them on
  /// resume. Two drains overlapping therefore erase each other's record of what
  /// was re-owed mid-send — and an erased re-owe is not a lost message, it is a
  /// settled debt for bytes that were never sent, which is exactly what the
  /// comment on `syncDeferredReowed` says must not happen.
  ///
  /// They CAN overlap: a start's drain suspends inside `sendChanges()`, the
  /// engine delivers a delegate event from in there, a send postponed during it
  /// makes `finishDelegateEvent` spawn an unserialised `Task` — and that task
  /// calls `syncRetryDeferred`, which drains again.
  ///
  /// A request that arrives during a drain is remembered rather than dropped,
  /// and honoured for ONE more pass. Bounded deliberately: the retry fires from
  /// a refusal, and a webview that refuses every send would otherwise keep this
  /// loop going for ever. Anything still owed after two passes stays durable and
  /// goes out on the next start, which is the whole point of the queue.
  private func drainSyncDeferred() async {
    guard !syncDraining else {
      syncDrainAgain = true
      return
    }
    syncDraining = true
    var passes = 0
    repeat {
      syncDrainAgain = false
      await hoistSharedSyncDeferred()
      // Shared first: those ids belong to the account rather than to any one
      // workspace, and a profile drain must not be the thing that sends them.
      await drainSyncDeferred(key: Self.syncDeferredSharedKey)
      for (queueProfileId, key) in deferredProfileQueues() {
        await drainSyncDeferred(key: key, inProfile: queueProfileId)
      }
      passes += 1
    } while syncDrainAgain && passes < 2
    syncDraining = false
  }

  /// Every per-profile deferred queue this device holds, as (profile id, key).
  ///
  /// The keys ARE the record. Nothing else enumerates the profiles this device
  /// has ever owed a send for — a queue outlives the session that created it,
  /// which is the entire point of it being durable.
  private func deferredProfileQueues() -> [(String, String)] {
    let prefix = OPSyncEngine.deferredKey("")
    return UserDefaults.standard.dictionaryRepresentation().keys
      .filter { $0.hasPrefix(prefix) && $0 != Self.syncDeferredSharedKey }
      .sorted()
      .map { (String($0.dropFirst(prefix.count)), $0) }
  }

  /// Offer one durable snapshot without clearing it first. Only a completed
  /// send settles ids, and anything refused again during that send stays owed.
  /// If the process dies before settlement, the whole snapshot is harmlessly
  /// offered again on the next start.
  private func drainSyncDeferred(key: String, inProfile profileId: String? = nil) async {
    let offered = syncDeferred(key: key)
    guard !offered.isEmpty else { return }

    syncDeferredDrainKey = key
    syncDeferredReowed.removeAll()
    let sent = await sendSync(unitIds: Array(offered), inProfile: profileId)
    let reowed = syncDeferredReowed
    syncDeferredDrainKey = nil
    syncDeferredReowed.removeAll()

    guard sent else { return }
    var deferred = syncDeferred(key: key)
    deferred.subtract(offered.subtracting(reowed))
    setSyncDeferred(deferred, key: key)
  }

  /// Retry debt created by a send the transport refused during `handleEvent`.
  /// OPSync schedules this only after that delegate call has returned. A profile
  /// switch or purge suspension leaves the debt durable for its next ordinary
  /// start rather than sending it through the wrong engine session.
  func syncRetryDeferred(profileId: String) async {
    guard !syncSuspended, syncProfileId == profileId else { return }
    await drainSyncDeferred()
  }

  private func syncFullUploadOwed(profileId: String) -> Bool {
    UserDefaults.standard.bool(forKey: Self.syncFullUploadKey(profileId))
  }

  /// Whether this device has ever decided about a full upload for this profile —
  /// owed or settled, the two being the same answer to this question. Only an
  /// ABSENT key is "never", which is the state `runStartSync` acts on.
  private func syncFullUploadConsidered(profileId: String) -> Bool {
    UserDefaults.standard.object(forKey: Self.syncFullUploadKey(profileId)) != nil
  }

  private func setSyncFullUploadOwed(_ owed: Bool, profileId: String) {
    // STAMPED on the way in, so `sendAllUnits` can tell the debt it is paying
    // from one created while it was paying.
    //
    // EVERY owe has to come through here for that to hold, and one did not:
    // `oweFullUploadForEveryConsideredProfile` wrote the defaults key itself,
    // which is the account-switch path — the very one this stamp exists for. It
    // routes through this function now. Stamping at the callers instead would
    // have left exactly that kind of hole open.
    //
    // In memory only, and that is the safe direction: losing the stamp to a
    // relaunch leaves the marker itself `true`, which is a debt still owed.
    if owed { syncFullUploadOwe[profileId, default: 0] += 1 }
    // RECORDED, not removed, on settlement. The absence of this key is what
    // `runStartSync` reads as "this profile has never been offered a full
    // upload", so removing it here would make every later activation of that
    // profile look like its first and re-collect the whole workspace.
    UserDefaults.standard.set(owed, forKey: Self.syncFullUploadKey(profileId))
  }

  private func setSyncSuspended(_ suspended: Bool) {
    if suspended {
      UserDefaults.standard.set(true, forKey: Self.syncSuspendedKey)
    } else {
      UserDefaults.standard.removeObject(forKey: Self.syncSuspendedKey)
    }
    syncSuspended = suspended
  }

  /// Everything an iCloud purge changes on this side, in the order that survives
  /// a crash at any line of it.
  ///
  /// WHAT IS NOT DELETED, and why. The person emptied their ICLOUD, which is not
  /// the same instruction as erasing the résumés on the device in their hand —
  /// the Settings sheet they used says nothing about this device's documents,
  /// and this app is not a cache of CloudKit: the local store IS the document
  /// and the zone is a mirror of it. Reading a remote signal as "destroy the
  /// person's work" is also the exact failure this whole feature has spent six
  /// rounds refusing, and it is the one reading that cannot be undone. If they
  /// do want the résumés gone, deleting them here is a thing they can do and
  /// this side cannot do for them. So what goes is everything that describes
  /// ICLOUD — change tags, change tokens, the pending queue, the staged assets —
  /// and nothing that describes them.
  private func applyICloudPurge() async {
    // The refusal is ALREADY on record: `syncDidPurgeFromICloud` writes it
    // synchronously, before this turn was even scheduled, so a crash anywhere
    // from the engine's event onward still leaves it. Everything here is
    // recovery that the next start repeats.
    //
    // Stop and cleanup live in the same serialized task, so nothing can restart
    // between the engine going down and its server bookkeeping being removed.
    await stopSync(forgettingServer: true)
  }

  /// The only path that clears suspension. Re-owe and finish purge cleanup
  /// before clearing, so a process death at any later line cannot leave
  /// automatic sync running without the full upload this explicit action
  /// requested or with stale bookkeeping from the server that was emptied.
  ///
  /// The marker keys enumerate every profile this device has considered. The
  /// active profile is written explicitly too because it may be the first one
  /// seen on this install and therefore have no marker yet.
  func resumeSyncing() async {
    guard syncSuspended else { return }
    oweFullUploadForEveryConsideredProfile()
    if let syncProfileId {
      setSyncFullUploadOwed(true, profileId: syncProfileId)
    }
    await stopSync(forgettingServer: true)
    setSyncSuspended(false)
    NSLog("[OPShell] iCloud sync resumed after a purge; full uploads are owed")
    guard let syncProfileId else { return }
    await startSync(profileId: syncProfileId)
  }

  /// Owe a full upload again for every profile this device has ever considered.
  ///
  /// THE MARKER KEYS ARE THE LIST. This side never sees a workspace list — a
  /// profile is named to it by the page's `activated` message and no other way —
  /// but `runStartSync` leaves one key per profile it has gated, and nothing
  /// removes one, so the keys enumerate every profile this device has ever
  /// started syncing. That is the second thing recording a settled debt as
  /// `false` instead of deleting the key bought.
  ///
  /// Re-owing is a WRITE of `true`, never a delete. Absence means "never
  /// considered", and turning a settled profile back into a never-considered one
  /// would make its next activation look like its first for reasons that have
  /// nothing to do with why it is being re-offered here.
  ///
  /// A profile with no key is not reached and does not need to be: its first
  /// gated start creates its debt from absent, which is the same offer arriving
  /// by the other route.
  ///
  /// Owed, not sent — as everywhere else in this feature. The next start for a
  /// profile is what asks the page to collect it.
  private func oweFullUploadForEveryConsideredProfile() {
    let defaults = UserDefaults.standard
    let prefix = Self.syncFullUploadKey("")
    // Ids rather than keys, and THROUGH the setter below rather than writing the
    // defaults here. Same bytes either way; the difference is that the setter
    // stamps the owe, which is what lets a settlement in flight tell this new
    // debt from the one it set out to pay. Writing the key directly is how this
    // path silently opted out of that.
    var ids = Set(defaults.dictionaryRepresentation().keys
      .filter { $0.hasPrefix(prefix) }
      .map { String($0.dropFirst(prefix.count)) })
    // THE SNAPSHOT'S LIST TOO, which the marker keys do not cover. They record
    // every workspace this device has STARTED syncing, and after a purge that
    // is the wrong set: a workspace fetched from the account but never opened
    // has no marker, so a marker-only sweep silently left it out of the restore
    // the person had just explicitly asked for. (The comment that used to be
    // here said this side never sees a workspace list. It has since — see
    // `runStartSync`, which hands the registry's ids to `sync.start` — and the
    // enumeration was never updated to match.)
    ids.formUnion(snapshot.profiles.map { $0.id })
    for id in ids { setSyncFullUploadOwed(true, profileId: id) }
    NSLog("[OPShell] a full upload is owed again for \(ids.count) profile(s)")
  }

  /// Stand behind one more failure. The published value is the one just
  /// reported, which is the closest thing to "most recent" this keeps.
  private func recordSyncFailure(_ failure: OPSyncFailure) {
    syncOutstanding[failure.scope] = failure
    syncFailure = failure
  }

  /// `scope` — one unit in one workspace, or one workspace's whole zone —
  /// reached iCloud, so whatever was outstanding against it is not outstanding
  /// any more. Against IT, and nothing else: this is the lookup that used to be
  /// done by bare name, where one workspace's success answered for every
  /// workspace that shared the name.
  ///
  /// Republishing from what is LEFT is the whole point: the line stays up while
  /// anything remains, and `values.first` is an arbitrary survivor because the
  /// line does not name one. Cheap by construction — the guard means this runs
  /// only when something actually cleared, not on every successful save.
  private func resolveSyncFailure(_ scope: OPSyncScope) {
    guard syncOutstanding.removeValue(forKey: scope) != nil else { return }
    syncFailure = syncOutstanding.values.first
  }

  /// Stop standing behind any of it. For the one moment when nothing reported
  /// so far can still be observed: the transport going down.
  private func forgetSyncFailures() {
    syncOutstanding.removeAll()
    syncFailure = nil
  }

  /// Stop standing behind only what the next session will not be able to see.
  ///
  /// A profile switch is NOT that moment, which is what the blanket version
  /// used to treat it as. One engine session covers every workspace in the
  /// registry plus the shared zone, and the replacement session covers them
  /// again — so a failure in a workspace this device is not in is still
  /// landable, by that workspace's own zone, exactly as `OPSyncScope` names it.
  /// Wiping it said "everything is fine" about content that had not reached
  /// iCloud, at the worst possible moment: a unit that already spent its one
  /// recovery attempt has no pending send left to raise the warning again, so
  /// switching INTO a workspace silently cleared its own warning.
  ///
  /// What genuinely cannot be seen again is a workspace no longer in the
  /// registry: nothing will fetch or save its zone, so its scopes would be a
  /// warning with no way left to clear it. Those, and only those, are dropped.
  private func forgetSyncFailures(outside covered: Set<String>) {
    syncOutstanding = syncOutstanding.filter { covered.contains($0.key.profileId) }
    // Republished from what is LEFT, the same arbitrary survivor
    // `resolveSyncFailure` picks — the line stands for "something is
    // outstanding" and never names which.
    syncFailure = syncOutstanding.values.first
  }

  /// Every workspace the engine session for `profileId` will cover: the one
  /// being activated first, then the registry. The active id is included
  /// because it may be the first on this install and not yet published.
  ///
  /// One derivation, used both to decide which failures survive a switch and to
  /// tell the transport which zones to open, so the two cannot drift into
  /// disagreeing about what this session can observe.
  private func profileIdsForSession(activating profileId: String) -> [String] {
    var seen = Set<String>()
    return ([profileId] + snapshot.profiles.map(\.id))
      .filter { !$0.isEmpty && seen.insert($0).inserted }
  }

  /// The one status line Settings shows — or "", which draws no row at all,
  /// because saying nothing is better than saying nothing useful.
  ///
  /// Computed here rather than projected from JS: both halves of it, the iCloud
  /// account's state and the last failure, exist only in the transport, and the
  /// page has no way to observe either.
  ///
  /// The rules the wording follows matter more than the words:
  ///
  /// - **Signed out is not an error.** It is an ordinary state — the app works
  ///   exactly as well without an account — so the line says what to do, not
  ///   what went wrong.
  /// - **No `CKError` ever reaches a person.** `OPSyncFailure.reason` is
  ///   diagnostic text for a log line; it is never shown.
  /// - **Nothing claims success it cannot back.** "Synced" is a claim about a
  ///   server this device cannot see inside, so it is not made.
  /// - **Nothing blames the person, and nothing suggests their résumés are at
  ///   risk.** They are on this device whatever iCloud is doing.
  var syncStatus: String {
    // Suspension has its own actionable row in Settings. Showing the transport's
    // last account state beside it would describe an engine that is now down.
    guard !syncSuspended else { return "" }
    // The transport has not reported yet — a moment at launch, and the whole
    // time before the workspace has adopted a profile. Nothing to say.
    guard let syncAccountState else { return "" }

    switch syncAccountState {
    case .available:
      guard syncFailure == nil else {
        return "Some changes haven't reached iCloud yet. Your resumes are still here."
      }
      return "iCloud sync is on. New changes go up in the background."
    case .signedOut:
      return "Sign in to iCloud in the Settings app to sync this device."
    case .restricted:
      return "iCloud isn't available to On Paper on this device. Your resumes stay here."
    case .temporarilyUnavailable:
      return "iCloud isn't ready just now. On Paper will try again."
    case .undetermined:
      return "iCloud can't be reached right now. Your changes will go up when it is."
    case .checkFailed:
      return "On Paper couldn't check your iCloud account just now. It will try again."
    }
  }

  /// Long enough to read two clauses and decide whether to tap, short enough
  /// that it is gone before it becomes furniture. Two seconds more than the
  /// desktop migration toast, which sets its own eight in `showMigrationToast`
  /// (src/main.js) for one line of text with nothing to tap.
  private static let conflictNoticeSeconds = 10.0

  /// Raise the one notice for a resolution, and start the clock that takes it
  /// back down.
  ///
  /// A second resolution arriving while the first is still up REPLACES it and
  /// restarts the clock: one notice on screen at a time is the same rule as one
  /// notice per batch, applied across batches.
  private func announceParked(_ parked: Int) {
    guard parked > 0 else { return }
    let text = Self.conflictNoticeText(parked)
    conflictNotice = text
    // Said as well as drawn. A banner that appears on nobody's action and takes
    // itself down on a clock can live and die entirely unheard: VoiceOver moves
    // focus only where the person sends it, so nothing would ever read this out
    // and there is nothing left to find afterwards. An announcement is the one
    // form that suits the banner's own rule — it speaks the same sentence once
    // and moves no focus, so whatever the person was reading or typing is
    // exactly where they left it.
    AccessibilityNotification.Announcement(text).post()
    conflictNoticeGeneration += 1
    let generation = conflictNoticeGeneration
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.conflictNoticeSeconds))
      guard let self, generation == self.conflictNoticeGeneration else { return }
      self.conflictNotice = nil
    }
  }

  /// Read, or acted on. Bumps the generation so the pending hide belongs to
  /// nothing and cannot take a LATER notice down early.
  func dismissConflictNotice() {
    conflictNoticeGeneration += 1
    conflictNotice = nil
  }

  /// What the notice says. The rules behind the words:
  ///
  /// - **It does not say which side won**, and that is the load-bearing one. A
  ///   conflict parks a loser in BOTH directions: `resolveConflicts`
  ///   (src/sync/syncModel.js) parks the SERVER's older unit when this device
  ///   holds the newer edit — pushing second with the newer copy is an ordinary
  ///   half of all conflicts — and the LOCAL one when it does not. Both count
  ///   the same in `parked`, so "another device replaced yours" would be false
  ///   about half the time, and a single batch can hold both directions under
  ///   one count. What is true of every parked version either way is the
  ///   shape of the event: two devices had the résumé, the newer copy is what
  ///   the app now holds, the older one went to history. Wording it that way
  ///   costs nothing; carrying the direction back across `syncDidConflict` to
  ///   say more would cost the answer a field it has no other use for.
  /// - **The source device is not named**, though the spec's example sentence
  ///   named one. The record carries an opaque device id and nothing else, and
  ///   since iOS 16 `UIDevice.current.name` is a generic model string anyway —
  ///   so "from your iPhone" would be a guess printed as a fact. The parked
  ///   entry the person lands on is labelled "Earlier version"
  ///   (src/historyEntryLabels.js), which follows the same rule for the same
  ///   reason: it used to say "From another device", and that is false in every
  ///   conflict this device loses, where the parked version is the person's own.
  /// - **It names no résumé.** History is per-résumé, a batch can hold several,
  ///   and the unit id is the page's to decompose, not this side's — a unit is
  ///   `{ id, kind, payload, modifiedAt }` here and stays opaque. "The same
  ///   resume" is less than the person would like and all that is true.
  /// - **Nothing suggests loss**, because there is none: the sentence exists to
  ///   say where the older version went.
  /// - **`resume`, not `résumé`**, in display copy — the brand guide is
  ///   explicit about it (docs/brand/on-paper-brand-guide.md).
  private static func conflictNoticeText(_ parked: Int) -> String {
    parked == 1
      ? "Two devices edited the same resume. On Paper kept the newer version; "
        + "the earlier one is in Version history."
      : "Two devices edited the same \(parked) resumes. On Paper kept the newer "
        + "version of each; the earlier ones are in Version history."
  }
}

/// Where the transport meets the page. Every one of these is a command on the
/// same bridge the rest of the chrome uses, and not one of them looks inside a
/// payload — a unit is `{ id, kind, payload, modifiedAt, profileId }` with the payload an
/// opaque string, and all decomposition stays in JS.
///
/// The non-async methods are called from inside the engine's event handling, so
/// they stay cheap and none of them re-enters the engine directly. The async
/// pair suspends on the bridge, and the engine awaits them: the whole point of
/// `syncDidFetch`'s answer is that the transport must not move on before it has
/// one.
extension ShellModel: OPSyncHost {
  /// The unit as the page holds it RIGHT NOW, asked at send time.
  func syncUnit(withId id: String, inProfile profileId: String) async -> SyncUnit? {
    guard case .answered(let value) = await sendForResult(
      "syncUnit", ["unitId": id, "profileId": profileId]
    ) else {
      // Nobody answered — most often `sendForResult`'s ten-second bound against
      // a webview that is still reloading. That is NOT this device having
      // nothing: `recordToSend` (OPSync.swift) treats nil as a final answer and
      // takes the change off the queue, so reading silence that way dropped a
      // real local edit until the unit happened to be edited again. The id
      // waits for the next start instead, in the same set an edit made while
      // the transport was down waits in — under the profile whose record this
      // is, which is not necessarily the open one.
      await deferSync([id], inProfile: profileId.isEmpty ? nil : profileId)
      NSLog("[OPShell] no answer for unit \(id); held for the next start")
      return nil
    }
    // A null result is this device having nothing under that id. The engine
    // drops the queued send and the server keeps whatever it already holds:
    // absence is never a deletion.
    guard let object = value as? [String: Any] else { return nil }
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object),
          let unit = try? JSONDecoder().decode(SyncUnit.self, from: data) else {
      // The two halves of the bridge disagree about the shape of a unit. Same
      // effect as having nothing to send, but it is a bug rather than a state,
      // so it does not pass in silence.
      NSLog("[OPShell] sync unit \(id) did not decode: \(object)")
      return nil
    }
    return unit
  }

  /// Which zone each named unit belongs in, answered by the model.
  ///
  /// Cheap on purpose — ids in, one word each out, no payload either way — since
  /// it is asked once per send, at the moment the changes are queued. It is the
  /// one thing about a unit that cannot wait for send time: a `CKRecord.ID`
  /// carries its zone.
  ///
  /// Nothing is deferred here, unlike `syncUnit(withId:)`. A refusal fails the
  /// whole `send`, and `sendSync` holds every id it was given for the next start
  /// — which is the same set, reached one level up, without this side having to
  /// guess which of the ids the transport had already queued.
  func syncScopes(forUnitIds ids: [String]) async -> [String: String]? {
    guard let data = try? JSONEncoder().encode(ids),
          let json = String(data: data, encoding: .utf8) else {
      NSLog("[OPShell] could not encode \(ids.count) unit id(s) for a zone lookup")
      return nil
    }
    guard case .answered(let value) = await sendForResult("syncScopes", ["unitIds": json]),
          let scopes = value as? [String: String] else {
      // Every way of not knowing is the same refusal, and refusing is the safe
      // direction: a shared unit saved into a profile zone is a registry the
      // next clean device cannot find, and this is the feature that exists to
      // let it find one.
      NSLog("[OPShell] no usable zone answer for \(ids.count) unit id(s)")
      return nil
    }
    return scopes
  }

  /// Units from another device, handed to the page to apply.
  ///
  /// Answers whether the page took ALL of them and can still prove it after a
  /// relaunch, which is what the transport keeps their change tags on (`deliver`
  /// in OPSync.swift). Every way of not knowing is `false`: the units would not
  /// encode, the round trip was never answered, the reply carried no usable
  /// count, or the count came back short. A wrong `true` is a silent overwrite
  /// of the server's newer copy; a wrong `false` costs one extra round trip the
  /// next time this unit is saved.
  ///
  /// TOOK is DURABLY took, and the distinction was a data-loss bug of its own:
  /// the page's storage is a write-behind cache, so a count of what reached
  /// STORAGE said nothing about what reached disk, and a device killed inside
  /// that window relaunched holding old content paired with a new change tag.
  /// `applyUnits` now waits for the disk before answering (syncModel.js), which
  /// is why this round trip can take longer than the others and why it is the
  /// one that goes through `callAsyncJavaScript`. Waiting here costs nothing on
  /// screen: sync is background reconciliation and nothing in the app blocks on
  /// it — only this confirmation does.
  ///
  /// A `false` also OWES THESE UNITS ANOTHER GO, and this is the only place that
  /// can record that. Forfeiting the change tags keeps the next save honest, but
  /// it does not bring the content down: the engine's change token has already
  /// advanced past these records and there is no public way to rewind it, so
  /// without this they arrive again only when this device happens to EDIT the
  /// same units — which, for a résumé the person is finished with, is never.
  ///
  /// So the ids join the set an edit made while the transport was down waits in,
  /// and every start drains it (`runStartSync`) — an activation, a return to the
  /// foreground, a profile switch. Sending is the recovery: the tag is gone, so
  /// the save quotes none, CloudKit answers `serverRecordChanged`, and the
  /// record comes back down the conflict path where both copies are compared and
  /// the loser is parked in version history. One round trip, and nothing is lost
  /// whichever copy wins — which is the same argument `deliver` makes for
  /// forfeiting the tag in the first place.
  ///
  /// NOT `syncDidFail`, which would re-queue the send in the same breath and
  /// spend this session's one recovery attempt on the webview that just failed
  /// to answer. Waiting for a start is the difference: a start is a moment the
  /// page is back.
  ///
  /// DELIBERATELY UNBOUNDED, unlike `syncDidFail`'s. A turn of this loop costs
  /// one activation, not one engine event, and every turn is a real attempt that
  /// can succeed — a page that refused because an edit was in flight, or because
  /// the arriving copy was older, is a page that will take it or overrule it
  /// later. A bound could only drop the id, and this same set is where local
  /// edits that never reached iCloud wait, so dropping one is dropping content.
  /// The one case that would loop for ever ends itself: a page that answers "I
  /// have nothing under that id" makes `recordToSend` take the change off the
  /// queue for good.
  func syncDidFetch(_ units: [SyncUnit]) async -> Set<String> {
    // Records are landing, which is the only moment worth showing. Bracketed
    // here as well as around the explicit pull because the engine also fetches
    // on a schedule of its own, and that is exactly the case where content
    // changes with nothing on screen to explain it.
    beginPull()
    defer { endPull() }
    let accounted = await applyFetched(units)
    let refused = units.filter { !accounted.contains($0.route) }
    guard !refused.isEmpty else { return accounted }

    // Only what was REFUSED waits for another attempt. A settled unit is not
    // owed anything: this device has taken its server version into account and
    // holds its tag, so re-offering it would be a send with nothing behind it.
    syncInitialFetchRefused = true
    // GROUPED BY THE ZONE EACH ARRIVED IN, because one delivery can carry
    // several workspaces' records and the debt is only recoverable in the
    // zone it belongs to. `SyncUnit.profileId` is that zone, reported by the
    // transport as a fact about the record — the same seam `syncScopes`
    // crosses in the other direction. Empty means the shared zone, which
    // `deferSync` reads as "no profile of its own".
    for (profileId, group) in Dictionary(grouping: refused, by: \.profileId) {
      await deferSync(group.map(\.id), inProfile: profileId.isEmpty ? nil : profileId)
    }
    NSLog("[OPShell] \(refused.count) of \(units.count) fetched unit(s) were refused; "
          + "they are offered again at the next start")
    return accounted
  }

  /// The ask itself, split out so that no empty answer can reach the transport
  /// without the ids being held — the two would otherwise have to be kept in
  /// step at three separate returns.
  ///
  /// Answers the ROUTES the page accounted for. Empty means every way of not
  /// knowing: the units would not encode, the round trip went unanswered, or
  /// the reply carried nothing usable. All of them forfeit every tag in the
  /// batch, which is the safe direction and costs one round trip.
  private func applyFetched(_ units: [SyncUnit]) async -> Set<String> {
    // `SyncUnit`'s encoding includes `profileId`, reporting which record zone
    // each fetched unit arrived in. It does not classify the unit or choose a
    // destination; outbound zone selection still comes from `syncScopes`.
    guard let data = try? JSONEncoder().encode(units),
          let json = String(data: data, encoding: .utf8) else {
      NSLog("[OPShell] could not encode \(units.count) fetched unit(s)")
      return []
    }
    // A JSON STRING, not an object: the command channel is a JS string literal,
    // the same reason a picked file crosses as base64. `syncApply` parses it.
    //
    // `accounted` is what `applyUnits` returned, read off the dispatcher's own
    // `{ ok, result }` envelope. That is the bridge's shape, not a unit's: this
    // side still never looks inside a payload. Each entry names a unit by id
    // AND by the workspace it belongs to, because one id exists in every
    // workspace and a batch can carry several of them.
    guard case .answered(let value) = await sendForResult("syncApply", ["units": json]),
          let entries = (value as? [String: Any])?["accounted"] as? [[String: Any]] else {
      NSLog("[OPShell] no usable answer for \(units.count) fetched unit(s)")
      return []
    }
    // Built through `SyncUnit.route` rather than by joining strings here, so the
    // separator has ONE definition on this side and the page never sees it.
    var accounted: Set<String> = []
    for entry in entries {
      guard let id = entry["id"] as? String else { continue }
      let profileId = entry["profileId"] as? String ?? ""
      accounted.insert(SyncUnit(
        id: id, kind: "", payload: "", modifiedAt: nil, profileId: profileId
      ).route)
    }
    return accounted
  }

  /// Both versions of every unit whose save hit a conflict, handed to the model
  /// to resolve — and the one moment sync has anything to SAY.
  ///
  /// Awaited inline rather than deferred onto a later main-actor turn, unlike
  /// the park it replaces: the transport must not settle a change tag before it
  /// has this answer, which is the same reason `syncDidFetch` is awaited from
  /// inside the same event.
  ///
  /// ONE NOTICE for the batch, which is the spec's rule and not a nicety: a
  /// device that has been away comes back owing a full upload, so several
  /// résumés conflicting in a single push is an ordinary shape, and a stack of
  /// notices about something that resolved correctly reads as an alarm.
  ///
  /// The count is what actually reached a version history, and it comes from the
  /// model because nothing else can compute it. It is not `conflicts.count`: an
  /// append-shaped unit UNIONS, so neither side loses and there is nothing to
  /// park, and a snapshot whose loser is not a résumé has nowhere to park one.
  /// Zero parks, no notice — a notice pointing at Version history for a version
  /// that is not in it would be worse than silence.
  ///
  /// A unit the model did not resolve OWES ANOTHER GO, recorded exactly as
  /// `syncDidFetch` records one: the ids join the set an edit made while the
  /// transport was down waits in, and every start drains it. Sending is the
  /// recovery — the tag was forfeited by `resolve`, so the save quotes none,
  /// CloudKit answers `serverRecordChanged`, and both versions come back here.
  /// NOT `syncDidFail`, which would re-queue immediately and spend this
  /// session's one recovery attempt on a page that has just failed to answer.
  func syncDidConflict(_ conflicts: [SyncConflict]) async -> SyncConflictOutcome {
    let outcome = await resolveConflicts(conflicts)
    // By ROUTE, not by id. A batch can hold the same id from several workspaces,
    // and matching on the id alone let one workspace's answer mark another's
    // conflict resolved — so a conflict the page actually refused kept its
    // change tag, which is a tag held for content this device does not have.
    let resolved = Set(outcome.resolved.map(\.route))
    let unresolved = conflicts.map(\.server).filter { !resolved.contains($0.route) }
    if !unresolved.isEmpty {
      // Held under each one's own workspace, so the retry sends this device's
      // copy back into the zone the conflict came from.
      for (profileId, group) in Dictionary(grouping: unresolved, by: \.profileId) {
        await deferSync(group.map(\.id), inProfile: profileId.isEmpty ? nil : profileId)
      }
      NSLog("[OPShell] \(unresolved.count) of \(conflicts.count) conflict(s) were not "
            + "resolved; they are offered again at the next start")
    }
    announceParked(outcome.parked)
    return outcome
  }

  /// The ask itself, split out so that no unresolved conflict can reach the
  /// transport without its id being held — the two would otherwise have to be
  /// kept in step at three separate returns. The same shape as `applyFetched`,
  /// and every way of not knowing is the same empty answer: the units would not
  /// encode, the round trip was never answered, or the reply carried nothing
  /// usable. A wrong resolution is a change tag held for content this device
  /// does not have; a wrong refusal costs one round trip.
  private func resolveConflicts(_ conflicts: [SyncConflict]) async -> SyncConflictOutcome {
    guard let data = try? JSONEncoder().encode(conflicts),
          let json = String(data: data, encoding: .utf8) else {
      NSLog("[OPShell] could not encode \(conflicts.count) conflict(s)")
      return .unresolved
    }
    // A JSON STRING, like `syncApply`'s units and for the same reason: the
    // command channel is a JS string literal. This side still never looks inside
    // a payload — it carries two opaque versions over and reads back ids and
    // counts, which is the bridge's shape rather than a unit's.
    guard case .answered(let value) = await sendForResult(
            "syncResolveConflicts", ["conflicts": json]
          ),
          let object = value as? [String: Any],
          let entries = object["resolved"] as? [[String: Any]],
          let parked = object["parked"] as? Int
    else {
      NSLog("[OPShell] no usable answer for \(conflicts.count) conflict(s)")
      return .unresolved
    }

    var resolved: [SyncResolution] = []
    for entry in entries {
      guard let id = entry["id"] as? String, let retry = entry["retry"] as? Bool else {
        // The two halves of the bridge disagree about the shape of an answer.
        // Dropping the entry forfeits that one unit's tag, which is the safe
        // direction, so it is a log rather than a refusal of the whole batch.
        NSLog("[OPShell] a conflict resolution did not decode: \(entry)")
        continue
      }
      // Absent from an older page, which only ever resolved the open workspace.
      let profileId = entry["profileId"] as? String ?? ""
      resolved.append(SyncResolution(id: id, profileId: profileId, retry: retry))
    }
    return SyncConflictOutcome(resolved: resolved, parked: parked)
  }

  /// Sends and fetches that did not land.
  ///
  /// One class of these has to be ACTED on rather than logged. A fetched record
  /// that could not be read was dropped and its change tag forgotten, and the
  /// engine's change token has already advanced past it with no public API to
  /// rewind — so the server's newer copy reaches this device only if something
  /// sends that unit again. Re-queueing it is a real recovery: with no tag the
  /// save quotes none, CloudKit answers `serverRecordChanged`, and the record
  /// comes back down the conflict path where both copies are compared and the
  /// loser is parked. Nothing is lost whichever way that comparison goes.
  ///
  /// AT MOST ONCE PER UNIT PER ENGINE SESSION. An unreadable record is most
  /// often an asset whose download did not finish, and an asset that never
  /// downloads fails identically every time: unbounded, this is drop → send →
  /// conflict → same unreadable record → drop, forever, at CloudKit's expense
  /// and the battery's. One attempt either clears it or leaves it for the next
  /// launch. `syncRecovered` is that memory, and `startSync` clears it when the
  /// profile changes — the only point at which the engine session ends without
  /// the process ending with it.
  func syncDidFail(_ failures: [OPSyncFailure]) {
    // An explicit fetch that reports an unreadable record or fetch-level failure
    // did not establish workspace readiness, even if fetchChanges itself returns.
    syncInitialFetchRefused = true
    // Grouped by the workspace each failure came out of, so each zone is asked
    // for once. A recovery send is a re-send of that unit's BYTES, and
    // `sendSync` reads them back out of the workspace it is told: sent without
    // one, every recovery collected the OPEN workspace's unit of that name and
    // sent it to the OPEN zone. The failed record was left un-recovered, and
    // for the case that most needs recovering — an unreadable fetched asset,
    // whose change token has already moved past it — its content stayed
    // unavailable on this device until that workspace was next edited, which
    // for a workspace this device is not in may be never.
    var recover: [String: [String]] = [:]
    for failure in failures {
      // The workspace spelled out rather than the route, whose separator is a
      // control character that Console renders as nothing at all.
      NSLog("[OPShell] sync failure (unit \(failure.unitId ?? "—") in "
            + "\(failure.profileId.isEmpty ? "the open workspace" : failure.profileId), "
            + "willRetry \(failure.willRetry)): \(failure.reason)")
      // Retryable, or about the zone or a fetch rather than one unit: the
      // engine is already handling the first and there is no unit to re-queue
      // for the second. Both are for the status line.
      // A refetch that failed transiently is the one retryable failure nothing
      // is holding — see `needsDurableRetry`. Written into that profile's
      // durable queue, which the next start drains straight back into the path
      // that will refetch it.
      if failure.needsDurableRetry, let unitId = failure.unitId {
        let profileId = failure.profileId
        Task { @MainActor [weak self] in
          await self?.deferSync([unitId], inProfile: profileId.isEmpty ? nil : profileId)
        }
      }
      guard let unitId = failure.unitId, !failure.willRetry else {
        recordSyncFailure(failure)
        continue
      }
      // `insert` reports whether this is the first time. A second failure for
      // the same unit is where the loop would have been, so it is held for the
      // status line instead — this device has now stopped trying.
      //
      // Remembered by SCOPE, not by the bare id, for the same reason the send
      // is routed: `data:settings` exists in every workspace, so one workspace
      // failing it used to spend the single attempt every OTHER workspace's
      // `data:settings` was entitled to — they were recorded as already tried
      // and never recovered at all.
      guard syncRecovered.insert(failure.scope).inserted else {
        recordSyncFailure(failure)
        continue
      }
      recover[failure.profileId, default: []].append(unitId)
    }

    guard !recover.isEmpty else { return }
    // Deferred, not inline: this runs inside the engine's event handling and
    // `send` re-enters the engine. The task puts it on a later main-actor turn,
    // once the event these failures belong to has been fully handled.
    Task { @MainActor [weak self] in
      // "" is the open workspace, which is what `sendSync` already means by nil
      // — the same convention the `syncDirty` handler follows.
      for (profileId, unitIds) in recover {
        await self?.sendSync(unitIds: unitIds,
                             inProfile: profileId.isEmpty ? nil : profileId)
      }
    }
  }

  /// Sends and fetches that landed, which is how a warning comes back DOWN.
  ///
  /// Nothing here is a claim that sync is well — only that these names got
  /// through, which is exactly as much as is needed to stop standing behind a
  /// failure reported against one of them. A failure this device never recorded,
  /// or already cleared, resolves to nothing: `resolveSyncFailure` is a lookup,
  /// so every ordinary successful save costs one.
  ///
  /// A unit that reached iCloud after failing is settled and says nothing about
  /// any other unit, or about the same unit in another workspace. A zone scope
  /// is the zone or a fetch — the same scope the failure had, because a failure
  /// that names no unit is a failure of everything in THAT zone.
  func syncDidLand(_ scopes: [OPSyncScope]) {
    for scope in scopes { resolveSyncFailure(scope) }
  }

  /// A different iCloud account is underneath the transport now.
  ///
  /// Every profile this device has considered owes its full upload again. A
  /// settled debt is a claim about the account it settled against, and the new
  /// account has none of these units: nothing in its container was ever named
  /// for send. Left alone, everything not edited since the switch would be
  /// silently absent from it — the same failure the marker exists to close.
  ///
  /// Nothing local changes and nothing is sent from here. The markers are what
  /// the next start reads, and coming back from the Settings app, where an
  /// account is switched, IS a start (`resumeSync`).
  func syncDidSwitchAccounts() {
    NSLog("[OPShell] the iCloud account changed — re-offering every profile's full upload")
    oweFullUploadForEveryConsideredProfile()
  }

  /// The account's owner deleted this app's data from iCloud.
  ///
  /// Sync suspends on this device, and the marker is the only state in which
  /// "not resent" stays true across a launch. Settings explains why and offers
  /// the explicit action that re-owes every full upload before clearing it.
  ///
  /// Deferred onto a later main-actor turn, like every other host callback that
  /// re-enters the transport: this is called from inside the engine's event
  /// handling and the work below cancels the engine's operations.
  func syncDidPurgeFromICloud() {
    // BEFORE the hop, not inside `applyICloudPurge`, and this is the whole of
    // why it is written here: a kill between the engine's event and that later
    // turn would otherwise leave no record of the purge at all. The next launch
    // would then queue its unconditional `.saveZone` against a change token that
    // is still stale, and if the zone save wins that race the token's own
    // answer comes back as an expired token rather than as `.userDeletedZone` —
    // the account owner's instruction read as ordinary staleness, and undone.
    setSyncSuspended(true)
    Task { @MainActor [weak self] in await self?.applyICloudPurge() }
  }
}

/// Receives snapshots from `window.webkit.messageHandlers.opShell`.
///
/// A separate object because `WKUserContentController` retains its handlers
/// strongly: were `ShellModel` itself the handler, the webview's configuration
/// would retain the model, the model's view would retain the webview, and
/// nothing would ever deallocate.
private final class SnapshotBridge: NSObject, WKScriptMessageHandler {
  weak var model: ShellModel?

  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard JSONSerialization.isValidJSONObject(message.body),
          let data = try? JSONSerialization.data(withJSONObject: message.body),
          let body = message.body as? [String: Any] else {
      NSLog("[OPShell] undecodable message: \(message.body)")
      return
    }

    switch body["kind"] as? String {
    case "syncAccountProfiles":
      Task { @MainActor in await self.model?.answerAccountProfilesRequest() }
    case "profilesResolved":
      Task { @MainActor in self.model?.profilesDidResolve() }
    case "share":
      guard let path = body["path"] as? String else {
        NSLog("[OPShell] share message with no path: \(body)")
        return
      }
      NSLog("[OPShell] share requested: \(path)")
      Task { @MainActor in OPShell.presentShareSheet(path: path) }
    case "pdfPreview":
      guard let path = body["path"] as? String else {
        NSLog("[OPShell] pdfPreview message with no path: \(body)")
        return
      }
      let filename = body["filename"] as? String ?? "Resume"
      Task { @MainActor in
        self.model?.pdfPreview = PdfPreviewRequest(path: path, filename: filename)
      }
    case "activated":
      // A document just came up — the first one, or a reload after WebKit
      // reclaimed the content process of a backgrounded app. Either way the
      // scroll view's zoom settings were re-derived from the new page, so the
      // lock has to be re-applied or the canvas gets a second scale back.
      //
      // It also carries the active workspace profile, which is the one thing
      // sync cannot start without: `getActiveProfileId()` lives in JS and the
      // profile names the CloudKit zone. This message is the right carrier
      // because a profile switch reloads the window, so the id is fixed for the
      // life of a document.
      let profileId = body["profileId"] as? String ?? ""
      Task { @MainActor in
        OPShell.lockWebViewZoom()
        await self.model?.startSync(profileId: profileId)
      }
    case "syncDirty":
      // Persistence names the units whose bytes just landed, on the save
      // debounce it already had. WHEN they go up is the engine's to decide —
      // this only says what changed.
      // `{ id, profileId }` each, because a unit can belong to a workspace this
      // device is not in — a parked conflict loser does — and `sendSync` reads
      // the bytes back out of the workspace it is told. Grouped so each zone is
      // asked for once. `profileId` is "" for the open workspace, which is what
      // `sendSync` already means by nil.
      guard let units = body["units"] as? [[String: Any]], !units.isEmpty else {
        NSLog("[OPShell] syncDirty with no units: \(body)")
        return
      }
      var byProfile: [String: [String]] = [:]
      for unit in units {
        guard let id = unit["id"] as? String else { continue }
        byProfile[(unit["profileId"] as? String) ?? "", default: []].append(id)
      }
      Task { @MainActor in
        for (profileId, unitIds) in byProfile {
          await self.model?.sendSync(
            unitIds: unitIds, inProfile: profileId.isEmpty ? nil : profileId
          )
        }
      }
    case "syncUnits":
      // The answer to `syncCollect`: everything this device would push, asked
      // for on a profile's first automatic start and after a purge is resumed.
      //
      // Only the ID of each unit is read. The payloads are right there in the
      // message and they are deliberately left alone — the engine re-asks for
      // each unit's bytes at send time through `syncUnit(withId:inProfile:)`,
      // which is the whole point of that callback, and decoding a payload here
      // would be the first place Swift knew what is inside one.
      guard let units = body["units"] as? [[String: Any]] else {
        NSLog("[OPShell] syncUnits with no units: \(body)")
        return
      }
      let unitIds = units.compactMap { $0["id"] as? String }
      // Which workspace this is the collection OF, echoed back by the page,
      // because this side can have asked for several and the answers arrive
      // independently. Absent from an older page, which only ever answered for
      // the open one.
      let forProfile = body["profileId"] as? String ?? ""
      // An empty collection is still an answer: there is nothing to put on the
      // wire, and `sendAllUnits` can settle the persisted full-upload debt.
      Task { @MainActor in await self.model?.sendAllUnits(unitIds, forProfile: forProfile) }
    default:
      guard let snapshot = try? JSONDecoder().decode(ShellSnapshot.self, from: data) else {
        NSLog("[OPShell] undecodable snapshot: \(message.body)")
        return
      }
      Task { @MainActor in self.model?.snapshot = snapshot }
    }
  }
}

// MARK: - Entry point

/// Objective-C entry point `src-tauri/src/ios_shell.rs` calls through
/// `objc_msgSend`. The explicit `@objc(...)` names are load-bearing: Swift
/// would otherwise mangle both the class symbol and the selector, and
/// `AnyClass::get(c"OPShell")` would return `None`.
@objc(OPShell)
final class OPShell: NSObject {
  /// Retains the model for the app's lifetime. The hosting controller's root
  /// view holds it too, but this makes the ownership explicit rather than an
  /// inference about SwiftUI's storage.
  @MainActor private static var model: ShellModel?
  @MainActor private static var bridge: SnapshotBridge?

  /// The launch cover's view tag, so it can be found and removed idempotently.
  private static let launchCoverTag = 0x0_C0FFEE

  /// True once the cover has been taken down, so a later pass cannot put it
  /// back over a running app.
  @MainActor private static var launchCoverRetired = false

  /// Keep the launch screen on screen until the app has actually drawn.
  ///
  /// UIKit shows `UILaunchScreen` and stops the instant another window becomes
  /// visible. Here that instant is precisely `ios_view::apply`'s
  /// `makeKeyAndVisible` — and what it reveals is tao's web view with nothing
  /// painted in it. The app's first real frame comes later, when `installShell`
  /// swaps in the hosting controller. Between the two the screen is blank, which
  /// is why the launch logo appeared to sink away and snap back.
  ///
  /// MEASURED: `installShell` runs 147ms after the process's first log line, and
  /// the sag is 8–9 frames at 60fps — the same interval, ending exactly at the
  /// pop. Three earlier attempts all failed for one reason: every one of them
  /// ran INSIDE `installShell`, at the END of the gap. So does anything based on
  /// `UIWindow.didBecomeVisibleNotification`, which never fires here at all —
  /// tao's window is already unhidden when it is handed its scene.
  ///
  /// Called from Rust with the window pointer in hand, in the same turn of the
  /// runloop that shows it. The cover is the launch screen redrawn: same colour
  /// set, same image, same 88pt, same centre — so there is nothing to see when
  /// it goes.
  /// Show `window` the instant UIKit connects a scene, not a poll later.
  ///
  /// `makeKeyAndVisible` is a no-op on a window with no `windowScene` (see
  /// ios_view.rs), and at Rust's `setup` UIKit has not connected one yet —
  /// measured: three fixup passes report "scene MISSING" before one attaches.
  /// The tauri event loop only notices on its next pass, and by then the system
  /// has begun retiring the launch screen, which is the whole artefact.
  ///
  /// So this listens for the connection itself and does the work in the same
  /// turn of the runloop: adopt the scene, raise the cover, show the window.
  /// ios_view's polling stays exactly as it was — every step here is idempotent
  /// and it remains the safety net if this observer never fires.
  @objc(armLaunchWindow:)
  static func armLaunchWindow(_ window: UIWindow) {
    MainActor.assumeIsolated {
      coverLaunchWindow(window)
      adopt(scene: nil, for: window)

      NotificationCenter.default.addObserver(
        forName: UIScene.willConnectNotification, object: nil, queue: .main
      ) { note in
        MainActor.assumeIsolated { adopt(scene: note.object as? UIWindowScene, for: window) }
      }
      NotificationCenter.default.addObserver(
        forName: UIScene.didActivateNotification, object: nil, queue: .main
      ) { note in
        MainActor.assumeIsolated { adopt(scene: note.object as? UIWindowScene, for: window) }
      }
    }
  }

  /// Give `window` a scene and show it, if that is possible yet.
  @MainActor
  private static func adopt(scene: UIWindowScene?, for window: UIWindow) {
    guard !launchCoverRetired else { return }
    if window.windowScene == nil {
      let candidate = scene ?? UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first
      guard let candidate else { return }
      window.windowScene = candidate
    }
    coverLaunchWindow(window)
    window.isHidden = false
    window.makeKeyAndVisible()
    NSLog("[OPShell] window shown on scene connect, launch cover up")
  }

  @objc(coverLaunchWindow:)
  static func coverLaunchWindow(_ window: UIWindow) {
    MainActor.assumeIsolated {
      guard !launchCoverRetired else { return }
      guard window.viewWithTag(launchCoverTag) == nil else { return }

      let view = UIView()
      view.tag = launchCoverTag
      view.backgroundColor = UIColor(named: "LaunchBackground")
      view.translatesAutoresizingMaskIntoConstraints = false
      // Never eat a touch, so a cover that somehow outlived its welcome is a
      // cosmetic bug rather than an unusable app.
      view.isUserInteractionEnabled = false

      let logo = UIImageView(image: UIImage(named: "LaunchLogo"))
      logo.contentMode = .scaleAspectFit
      logo.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(logo)
      let side = LaunchScreenContinuationView.logoSize
      NSLayoutConstraint.activate([
        logo.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        logo.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        logo.widthAnchor.constraint(equalToConstant: side),
        logo.heightAnchor.constraint(equalToConstant: side),
      ])

      window.addSubview(view)
      // Constraints, not a frame: this runs before ios_view has sized anything,
      // so the window is very often still 0x0 here and a frame copied from it
      // would stay 0x0 for ever.
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: window.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: window.trailingAnchor),
        view.topAnchor.constraint(equalTo: window.topAnchor),
        view.bottomAnchor.constraint(equalTo: window.bottomAnchor),
      ])
    }
  }

  /// Take the cover down, once and for good.
  @MainActor
  private static func uncover(_ window: UIWindow) {
    guard let cover = window.viewWithTag(launchCoverTag) else { return }
    cover.removeFromSuperview()
    launchCoverRetired = true
  }

  /// Installs the chrome into `window` and reparents `webView` into it.
  /// Main thread only; Rust guarantees a single invocation.
  @objc(installShellInWindow:webView:)
  static func installShell(window: UIWindow, webView: UIView) {
    MainActor.assumeIsolated {
      let model = ShellModel()
      model.webView = webView as? WKWebView
      model.beginProfileBootstrap()
      self.model = model

      // SILENT CloudKit pushes. Nothing is ever shown — no alert, no badge, no
      // sound — and iOS does not prompt: that prompt belongs to
      // `UNUserNotificationCenter`, which this app never touches. This is only
      // the APNs registration that lets the database's change notifications
      // arrive at all.
      //
      // Nothing else is needed, and deliberately so. CKSyncEngine.h: a sync
      // engine "attempts to discover an existing CKDatabaseSubscription … If
      // the engine doesn't find a subscription, it automatically creates one …
      // On receipt of a notification, the engine schedules a sync operation to
      // fetch the related changes." So there is no delegate to forward from and
      // no subscription to manage — which is just as well, since Tauri owns the
      // app delegate. The same header states the requirement this pairs with:
      // "CKSyncEngine requires the CloudKit and Remote notifications
      // entitlements" (see `aps-environment` in project.yml).
      //
      // Without this, a device only learned of another's edit when it happened
      // to fetch — at launch, on returning to the foreground, or on the
      // engine's own schedule.
      UIApplication.shared.registerForRemoteNotifications()

      if let wk = webView as? WKWebView {
        let bridge = SnapshotBridge()
        bridge.model = model
        self.bridge = bridge
        // Named to match SHELL_HANDLER in src/iosShell.js.
        wk.configuration.userContentController.add(bridge, name: "opShell")
      } else {
        NSLog("[OPShell] not a WKWebView (\(type(of: webView))) — chrome will render, snapshots will not arrive")
      }

      // Capture tao's view controller BEFORE displacing it as root. It must
      // stay in the window hierarchy — see CanvasHost for what breaks otherwise.
      let taoController = window.rootViewController

      let host = UIHostingController(
        rootView: ShellView(model: model, taoController: taoController, webView: webView)
      )
      // The cover comes off only once this transaction has been rendered —
      // otherwise it is traded for the very blank frame it exists to hide.
      // What it uncovers is the SwiftUI continuation, drawn to the same numbers
      // from the same asset, so there is nothing to see at the swap.
      CATransaction.begin()
      CATransaction.setCompletionBlock { MainActor.assumeIsolated { uncover(window) } }
      window.rootViewController = host
      window.makeKeyAndVisible()
      window.layoutIfNeeded()
      CATransaction.commit()

      // A belt to the completion block's braces: if that never fires, a cover
      // left up would look like an app frozen on its splash. It cannot eat a
      // touch, but it would still be the worst bug in the file.
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
        MainActor.assumeIsolated { uncover(window) }
      }

      NSLog("[OPShell] installed: root=\(type(of: host)) webview=\(type(of: webView))")
      activateWeb()
    }
  }

  /// Present a share sheet for a file Rust staged (`stage_pdf_for_share`).
  ///
  /// iOS has no save-to-path dialog. `tauri-plugin-dialog`'s `save_file`
  /// approximates one with `UIDocumentPickerViewController(.exportToService)`
  /// presented on tao's view controller — and once tao is a CHILD of the
  /// hosting controller, that picker's remote view service launches and then
  /// never appears. Measured, twice.
  ///
  /// Presenting from the hosting controller — the window's actual root — avoids
  /// the whole question, and a share sheet is the better answer anyway: it
  /// offers Save to Files, AirDrop, Mail and Messages where the picker offered
  /// only a file location.
  @MainActor
  static func presentShareSheet(path: String) {
    guard let root = model?.webView?.window?.rootViewController else {
      NSLog("[OPShell] no root view controller to share from")
      return
    }
    NSLog("[OPShell] presenting share sheet from \(type(of: root))")
    let url = URL(fileURLWithPath: path)
    let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    // Delete the staged copy once the sheet is finished with it.
    //
    // `stage_pdf_for_share` copies the preview into the temp dir under the name
    // the person typed, and `discard_pdf_preview` only ever removed the preview
    // SLOT — so nothing deleted this one. Every export left a second résumé PDF
    // behind under its own name, accumulating for the life of the install: a
    // pile of somebody's CVs sitting in a directory, which is the part that
    // matters more than the disk.
    //
    // It cannot be deleted before the sheet is done: the activity reads the
    // file when the person picks a destination, which is after presentation and
    // possibly long after. The completion handler is the earliest safe moment,
    // and it runs whether they shared or dismissed.
    sheet.completionWithItemsHandler = { _, _, _, _ in
      do {
        try FileManager.default.removeItem(at: url)
      } catch {
        // Not worth surfacing: the file is in the system temp dir, which iOS
        // reclaims on its own. Logged so a leak has a trail if one shows up.
        NSLog("[OPShell] could not remove the staged PDF: \(error)")
      }
    }
    // iPad presents this as a popover and CRASHES without an anchor. Anchor it
    // to the top-trailing corner, under the PDF button that started the export.
    if let popover = sheet.popoverPresentationController {
      popover.sourceView = root.view
      popover.sourceRect = CGRect(
        x: root.view.bounds.maxX - 40, y: root.view.safeAreaInsets.top, width: 1, height: 1
      )
      popover.permittedArrowDirections = [.up]
    }
    // A dialog may still be dismissing, and "frontmost" was not enough: a
    // controller on its way out is still `presentedViewController` until the
    // transition finishes, so this walked onto the preview sheet that Save had
    // just closed and presented against it — a presentation UIKit can refuse.
    // The web side hears none of that: `sharePdf` reports true for POSTING the
    // message, so it discards the preview, `completionWithItemsHandler` is
    // never installed, and the person is left with no share sheet and a staged
    // résumé nothing will clean up.
    //
    // `pdfSave` is sent BEFORE `dismiss()` (see `settle`), so this is the
    // ordinary case rather than a race worth ignoring.
    var presenter: UIViewController = root
    while let next = presenter.presentedViewController, !next.isBeingDismissed {
      presenter = next
    }
    // And the presenter itself may be mid-transition — dismissing that child is
    // exactly what gives it a coordinator. Presenting from the completion is
    // the supported way to say "after this finishes".
    let target = presenter
    if let coordinator = target.transitionCoordinator {
      coordinator.animate(alongsideTransition: nil) { _ in
        target.present(sheet, animated: true)
      }
    } else {
      target.present(sheet, animated: true)
    }
  }

  @MainActor private static var handedOver = false

  /// Turn off WKWebView's own pinch zoom, so the app's CSS zoom model — the
  /// only one that reaches below 100% — is the single scale on the canvas.
  ///
  /// Called AFTER the handover, not at install: WebKit creates the scroll
  /// view's `pinchGestureRecognizer` lazily once the page and its viewport are
  /// parsed, so at install time it is still nil and disabling it is a silent
  /// no-op. Measured — that is exactly what the first version of this did, and
  /// a pinch went on scaling the page while the toolbar's readout sat still.
  ///
  /// Re-asserted once a second later because the recognizer can arrive after
  /// the first JS callback returns, and again on every `activated` message —
  /// each page load re-derives these from the new document's viewport.
  @MainActor
  static func lockWebViewZoom(attempt: Int = 0) {
    guard let scrollView = model?.webView?.scrollView else { return }
    scrollView.pinchGestureRecognizer?.isEnabled = false
    scrollView.minimumZoomScale = 1
    scrollView.maximumZoomScale = 1
    scrollView.bouncesZoom = false
    if attempt == 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { lockWebViewZoom(attempt: 1) }
    }
  }

  /// Hand the web side the class that hides its own chrome and ask it for a
  /// first snapshot.
  ///
  /// Retried, because the shell installs as soon as the window is
  /// scene-attached — which is normally BEFORE `src/main.js` has booted, and
  /// can be before the document that will run it even exists. A one-shot call
  /// sets a flag on a page that is about to be replaced, and the app comes up
  /// showing both chromes stacked on each other.
  ///
  /// The retry is scheduled by the timer, NOT from the completion handler:
  /// `evaluateJavaScript` against a webview that is still loading never calls
  /// back at all, so a chain driven by the callback stops after one attempt
  /// and takes the whole handover with it. Measured, not theorised — that was
  /// this function's first shape.
  @MainActor
  private static func activateWeb(attempt: Int = 0) {
    guard !handedOver else { return }
    guard let webView = model?.webView else {
      NSLog("[OPShell] no WKWebView to activate against")
      return
    }
    guard attempt < 100 else {
      NSLog("[OPShell] web side never activated — is initIOSShell() wired into main.js?")
      return
    }

    webView.evaluateJavaScript(
      "(function(){"
      + "window.__opShellPendingActivate = true;"
      + "return !!(window.__opShell && window.__opShell.activate());"
      + "})()"
    ) { result, error in
      MainActor.assumeIsolated {
        if result as? Bool == true, !handedOver {
          handedOver = true
          NSLog("[OPShell] web chrome handed over after \(attempt) retries")
          lockWebViewZoom()
        } else if let error, attempt == 0 {
          NSLog("[OPShell] first activation attempt errored (expected while loading): \(error)")
        }
      }
    }

    // 100 x 150ms = 15s. First-run boot waits on storage init and the legacy
    // migration probe, so the budget has to outlast those.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
      activateWeb(attempt: attempt + 1)
    }
  }
}

// MARK: - Hosting the webview

/// Hosts the *existing* webview as SwiftUI content. Nothing is recreated — that
/// is the whole point: Tauri's IPC, its script message handlers and the loaded
/// document all survive.
///
/// It re-parents tao's whole VIEW CONTROLLER rather than lifting the WKWebView
/// out of it, using real UIKit containment. That is not tidiness:
///
///   **`tauri-plugin-dialog` presents its `UIAlertController` on tao's view
///   controller.** Displace that controller as the window's root and leave it
///   out of the hierarchy, and every native dialog fails with "whose view is not
///   in the window hierarchy" — silently, since the presentation just never
///   happens and the JS promise never settles. That takes down the PDF export's
///   save dialog and, worse, the whole Phase 3.1 data-loss fix, which routes
///   every destructive confirmation through this plugin.
///
/// Found by exporting a PDF and watching the button spin forever. The webview
/// stays exactly where wry put it; only its ancestry above tao's controller
/// changes.
private struct CanvasHost: UIViewControllerRepresentable {
  let taoController: UIViewController?
  let webView: UIView
  /// Cumulative scale, the midpoint between the fingers, and the state.
  let onPinch: (CGFloat, CGPoint, UIGestureRecognizer.State) -> Void

  /// A real `UIPinchGestureRecognizer`, not SwiftUI's `MagnifyGesture`.
  ///
  /// SwiftUI gestures attached to a hosted UIKit view lose the arbitration to
  /// WKWebView's own recognizers — measured: `MagnifyGesture.onChanged` never
  /// fired once while the page went on scaling underneath. Attaching the
  /// recognizer directly, with a delegate that allows simultaneous recognition,
  /// puts us in the same arbitration WebKit is in rather than above it.
  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    let onPinch: (CGFloat, CGPoint, UIGestureRecognizer.State) -> Void
    /// The last focal point measured with both fingers still down. See below.
    private var twoFingerFocus: CGPoint?

    init(onPinch: @escaping (CGFloat, CGPoint, UIGestureRecognizer.State) -> Void) {
      self.onPinch = onPinch
    }

    @objc func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
      // `location(in:)` is the centroid of the touches STILL DOWN, in the
      // recognizer's own view — which is already the page's client coordinate
      // space, because the webview is pinned to that view.
      //
      // A pinch ends when the second finger lifts, and real fingers never lift
      // on the same frame. So on the final event the centroid has already
      // collapsed onto whichever finger is still there — up to half the finger
      // separation from where the gesture actually was. Anchoring the canvas to
      // that scrolled it by that much at the instant of release, which is the
      // snap. A simulated pinch does not show it: `simctl` lifts both touches
      // together, so its last event still reports two.
      //
      // Below two touches there is no meaningful focal point for a pinch, so
      // hold the last real one rather than trusting the collapsed centroid.
      let focus: CGPoint
      if recognizer.numberOfTouches >= 2 {
        focus = recognizer.location(in: recognizer.view)
        twoFingerFocus = focus
      } else {
        focus = twoFingerFocus ?? recognizer.location(in: recognizer.view)
      }
      switch recognizer.state {
      case .ended, .cancelled, .failed:
        twoFingerFocus = nil
      default:
        break
      }
      onPinch(recognizer.scale, focus, recognizer.state)
    }
    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { true }
  }

  func makeCoordinator() -> Coordinator { Coordinator(onPinch: onPinch) }

  func makeUIViewController(context: Context) -> UIViewController {
    let container = UIViewController()
    container.view.backgroundColor = .systemBackground

    let pinch = UIPinchGestureRecognizer(
      target: context.coordinator, action: #selector(Coordinator.handlePinch(_:))
    )
    pinch.delegate = context.coordinator
    container.view.addGestureRecognizer(pinch)

    // ios_view.rs drives these views by frame + autoresizing mask. Inside
    // SwiftUI it has to be Auto Layout's job instead, which is also why
    // rotation keeps working with tao's controller no longer the root.
    if let tao = taoController {
      container.addChild(tao)
      tao.view.translatesAutoresizingMaskIntoConstraints = false
      container.view.addSubview(tao.view)
      pin(tao.view, to: container.view)
      tao.didMove(toParent: container)

      // The webview needs pinning too, not just its controller's view.
      //
      // `ios_view.rs` sizes the webview to `UIScreen.bounds` and gives it a
      // flexible autoresizing mask. Reparenting moved its ORIGIN into the
      // content area but left its HEIGHT at the full screen's, so the page ran
      // ~114pt (the two bars) off the bottom of the display. Everything still
      // looked right, because the overflow is below the fold — but
      // `window.innerHeight` was 874 instead of 760, so every `vh` in the app
      // was wrong, dialogs centred too low, and the PDF preview's Save button
      // sat off-screen where a tap hit the overlay instead.
      //
      // Measured, not deduced: a diagnostic dumped `innerHeight: 874` next to a
      // 760pt content area.
      webView.translatesAutoresizingMaskIntoConstraints = false
      pin(webView, to: tao.view)
    } else {
      // No controller to adopt — fall back to hosting the bare webview so the
      // app still renders. Dialogs will be broken; the log line says so.
      NSLog("[OPShell] no tao view controller to adopt — native dialogs will not present")
      webView.removeFromSuperview()
      webView.translatesAutoresizingMaskIntoConstraints = false
      container.view.addSubview(webView)
      pin(webView, to: container.view)
    }
    return container
  }

  func updateUIViewController(_ controller: UIViewController, context: Context) {}

  private func pin(_ view: UIView, to parent: UIView) {
    NSLayoutConstraint.activate([
      view.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
      view.topAnchor.constraint(equalTo: parent.topAnchor),
      view.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
    ])
  }
}

// MARK: - Chrome

private struct ShellView: View {
  @ObservedObject var model: ShellModel
  let taoController: UIViewController?
  let webView: UIView
  /// ONE sheet slot, not three `.sheet(isPresented:)` modifiers on the same
  /// view — SwiftUI honours only one of those, and the symptom is a button that
  /// silently does nothing. Measured: chat and structure both no-op'd while
  /// settings worked.
  @State private var sheet: Sheet?
  /// The résumé file picker. The web import is a hidden `<input type="file">`,
  /// which does nothing in WKWebView — the menu item accepted a tap and never
  /// supplied a file — so the pick happens here and only the TEXT crosses. Same
  /// arrangement `OPProfile` already uses for its own import.
  @State private var importingVariant = false
  /// The New-workspace prompt. An `.alert` with a text field rather than a
  /// sheet: naming a workspace is one short answer, and a whole sheet for one
  /// field reads as a bigger commitment than creating one actually is.
  @State private var renamingVariant = false
  @State private var renameDraft = ""
  @State private var creatingProfile = false
  /// A picked file could not be read. See `readPickedText`.
  @State private var importFailed = false
  /// The résumé and workspace the rename alert was opened for, and whether the
  /// rename was refused because they moved. See `submitRename`.
  @State private var renameFrom: ShellSnapshot.Where?
  @State private var renameFailed = false
  /// …and the workspace the file picker was opened from. A picker is a system
  /// sheet that outlives a webview reload as surely as an alert does, and the
  /// import names no workspace — it would create the résumé in whichever one
  /// the tombstone handler selected.
  @State private var importFrom: ShellSnapshot.Where?
  /// A refused profile creation or switch, shown after the menu or alert that
  /// asked for it has gone. Named apart from `ProfilesSheet`'s own `failure`
  /// because they are different screens; the wording is deliberately the same,
  /// including the neutral title over a message that names the operation.
  @State private var profileFailure: String?
  @State private var newProfileName = ""
  /// The zoom a pinch started from; nil when no pinch is in flight.
  @State private var pinchBase: Double?
  /// The bar is showing the zoom controls rather than the tools — see
  /// `keepZoomOpen`.
  @State private var zoomExpanded = false
  /// Counts zoom interactions so a stale hide cannot cut a newer one short.
  @State private var zoomInteraction = 0
  /// A zoom menu is open, so the auto-collapse must not run.
  ///
  /// SwiftUI's `Menu` reports neither its opening nor its dismissal, so this is
  /// set on the tap that opens one and cleared by whichever comes first: an
  /// action being chosen, or the backstop below. Without the backstop a menu
  /// dismissed by tapping elsewhere would pin the controls open for good — the
  /// bug this guard exists to fix, with the sign flipped.
  @State private var zoomMenuOpen = false

  private enum Sheet: String, Identifiable {
    case settings, structure, design, chat, library, history, jobs, profile, pdfPreview
    case profiles
    var id: String { rawValue }
  }

  private var snapshot: ShellSnapshot { model.snapshot }

  /// The navigation bar, extracted from `body`.
  ///
  /// Not a preference: with the profile submenu inline, the whole `body`
  /// stopped type-checking "in reasonable time" and the BUILD failed. A
  /// `ToolbarContentBuilder` property is the documented way to divide it, and
  /// this has to stay separate however small it looks.
  @ToolbarContentBuilder
  private var chrome: some ToolbarContent {
        // `.disabled` is applied per ITEM, never to the NavigationStack's
        // content. It is an environment modifier that propagates down the
        // whole tree, so putting it on the content disabled CanvasHost and
        // therefore the hosted WKWebView — every tap on the web dialog was
        // swallowed before it reached the page, silently.
        ToolbarItem(placement: .topBarLeading) {
          // ONE button, not two. The initials and the overflow were separate
          // controls sitting side by side, which spent the leading slot twice
          // and made "whose profile is this" compete with "what else can I
          // do". Merged, the profile IS the identity of everything in the
          // menu, which is what it always was.
          // …and while a PDF is being captured, for the reason on `titleMenu`
          // below: this menu switches workspaces, which changes the document
          // mid-capture just as surely as switching résumés does.
          actionsMenu.disabled(snapshot.modalOpen || snapshot.pdfBusy)
        }
        ToolbarItem(placement: .principal) {
          // DISABLED DURING A CAPTURE, not only during a modal. The main-window
          // export yields — once while the layout settles, and again for every
          // page it captures — and the document can be swapped in any of those
          // gaps. What comes out is the replacement résumé, or worse, pages of
          // each, under the original's filename. The export button already
          // refuses a second run; this is the same rule for the other way to
          // change what is being captured.
          titleMenu.disabled(snapshot.modalOpen || snapshot.pdfBusy)
        }
        ToolbarItem(placement: .topBarTrailing) {
          HStack(spacing: 10) {
            // Present only while records are actually landing, and carrying
            // no label: a spinner beside the workspace is legible as "this is
            // catching up", and there is nothing truthful to add about how
            // far along a fetch is. It sits on the trailing side because the
            // leading pair is about to become one workspace control.
            if model.syncPulling {
              ProgressView()
                .controlSize(.small)
                .transition(.opacity)
                .accessibilityLabel("Syncing")
            }
            pdfButton
          }
          .animation(.easeInOut(duration: 0.2), value: model.syncPulling)
          .disabled(snapshot.modalOpen)
        }
  }

  var body: some View {
    NavigationStack {
      CanvasHost(taoController: taoController, webView: webView) { scale, focus, state in
        // `scale` is cumulative from the START of the pinch, so it multiplies
        // the zoom the gesture began at. Multiplying the LIVE zoom instead
        // compounds and runs away within a few frames.
        switch state {
        case .began:
          pinchBase = snapshot.zoom
          keepZoomOpen()
        case .changed:
          model.setZoom((pinchBase ?? snapshot.zoom) * Double(scale), live: true, focus: focus)
          keepZoomOpen()
        default:
          // One final non-live value closes the gesture on the web side, which
          // is what puts the zoom transition back for the buttons. It still
          // carries the focal point, so the last frame does not jump back to
          // the corner as the gesture lifts.
          model.setZoom((pinchBase ?? snapshot.zoom) * Double(scale), live: false, focus: focus)
          pinchBase = nil
          keepZoomOpen()
        }
      }
        // The canvas runs the full height of the window, not from the bottom of
        // the navigation bar to the top of the home indicator. Both bars are
        // transparent, so this is what actually puts the résumé behind them —
        // inset to the safe area it would be sitting between two strips of
        // empty window instead. Running under the bottom bar is deliberate and
        // was reverted once when "fixed". `.resume-scroller` reserves the top
        // bar's height as padding, so the page starts below the chrome and
        // scrolls up behind it.
        //
        // This also keeps the KEYBOARD out of the layout (the default region
        // set includes it), which is what stops SwiftUI and WKWebView both
        // avoiding it and collapsing the canvas to a ~90pt strip.
        //
        // EVERY edge, not just the vertical pair. Portrait has no horizontal
        // safe-area inset, so naming only top and bottom looked complete and
        // was: nothing could show the difference. LANDSCAPE has them — the
        // sensor housing on one side, and a symmetric inset on the other — and
        // the canvas stopped at them, leaving a black gutter down each edge of
        // the screen.
        //
        // That gutter was both of the things it looked like. The bars are
        // transparent, so what reads as "the header background" is this
        // webview showing THROUGH the navigation bar — when it stopped short,
        // the header appeared to stop short with it, and the avatar and share
        // button ended up sitting on its edge rather than inside it. One gap,
        // two symptoms.
        .ignoresSafeArea(edges: .all)
        .navigationBarTitleDisplayMode(.inline)
        // No bar backgrounds: the résumé runs edge to edge and shows THROUGH the
        // chrome, which is the whole point of glass controls floating over it.
        // Each toolbar item carries its own backing, so nothing here depends on
        // the bar for legibility.
        .toolbarBackground(.hidden, for: .navigationBar, .bottomBar)
        .toolbar { chrome }
        .sheet(item: $sheet) { which in
          switch which {
          case .settings: SettingsSheet(model: model)
          case .profiles: ProfilesSheet(model: model)
          case .structure: StructureSheet(model: model)
          case .design: DesignSheet(model: model)
          case .chat: ChatSheet(model: model)
          case .library: LibrarySheet(model: model)
          case .history: HistorySheet(model: model)
          case .jobs: JobsSheet(model: model)
          case .profile: ProfileSheet(model: model)
          case .pdfPreview:
            if let request = model.pdfPreview {
              PdfPreviewSheet(model: model, request: request)
            }
          }
        }
        // Naming a new workspace. An alert rather than a sheet: one short
        // answer, and a whole card would make creating one feel weightier than
        // it is. The create is disabled on an empty name rather than silently
        // inventing "New profile", so the workspace list never fills with
        // identical entries nobody meant to make.
        // Renaming the résumé, natively. It used to post `rd:variant-rename`,
        // which opened the WEB header's dialog — a desktop card in the middle
        // of a native app, and the last web surface reachable from this bar.
        // Pre-filled with the current name, because a rename is nearly always
        // an edit of what is there rather than a fresh sentence.
        .fileImporter(
          isPresented: $importingVariant,
          allowedContentTypes: resumeImportTypes,
          allowsMultipleSelection: false
        ) { openPickedResume($0) }
        .onChange(of: renamingVariant) { _, open in
          if !open {
            model.send("setNativeEditing", [
              "scope": "document", "holder": "rename", "value": "false",
            ])
          }
        }
        .alert("Rename resume", isPresented: $renamingVariant) {
          TextField("Name", text: $renameDraft)
            .textInputAutocapitalization(.words)
          Button("Cancel", role: .cancel) {}
          Button("Rename", action: submitRename)
            .disabled(trimmedRenameDraft.isEmpty)
        }
        .alert("New profile", isPresented: $creatingProfile) {
          TextField("Name", text: $newProfileName)
            .textInputAutocapitalization(.words)
          Button("Cancel", role: .cancel) {}
          Button("Create", action: submitNewProfile)
            .disabled(trimmedNewProfileName.isEmpty)
        } message: {
          Text("A separate profile with its own résumés, job descriptions and chats.")
        }
        .modifier(importFailureAlert(
          isPresented: $importFailed,
          hint: "Pick a résumé exported from On Paper — a .json or .md file."
        ))
        .modifier(NoticeAlert(
          title: "That resume moved",
          isPresented: $renameFailed,
          hint: "Your workspace changed on another device while the name was open, so nothing was renamed."
        ))
        .alert(
          "Couldn't save",
          isPresented: Binding(
            get: { profileFailure != nil },
            set: { if !$0 { profileFailure = nil } }
          )
        ) {
          Button("OK", role: .cancel) {}
        } message: {
          Text(profileFailure ?? "")
        }
        // The wizard, which is not in `sheet` at all. It has no open command —
        // the WEB component decides when it runs, because one component serves
        // both a first launch and the "New resume" menu item — so its presence
        // in the snapshot IS the instruction to present. A `fullScreenCover`
        // rather than a sheet: a first run has to be finished or explicitly
        // cancelled, and a card that can be swiped away leaves the app with no
        // résumé and no explanation of why.
        .fullScreenCover(isPresented: .constant(snapshot.onboarding?.open == true)) {
          if let wizard = snapshot.onboarding {
            OnboardingSheet(model: model, view: wizard)
          }
        }
        // The change review, opened by the PAGE the same way — every entry
        // point routes through one always-mounted web dialog, so its own
        // `open` is the signal. A sheet rather than a cover: unlike a first
        // run this is dismissible, and closing it decides nothing.
        // WRITABLE, unlike the cover above, because this one can be dismissed
        // by swiping. `.constant` discards the `false` SwiftUI writes back on a
        // swipe, so the page never heard that its dialog had closed: the web
        // `DiffDialog` stayed open with its Radix modal and `modalOpen` state
        // live — invisible, because `native-shell.css` hides it — which leaves
        // the native chrome withdrawn and lets a later snapshot present the
        // sheet again. The Close button was the only exit that told anyone.
        //
        // The setter routes through the SAME `diffClose` that button sends, so
        // the page stays the single source of truth: it closes its dialog, the
        // next snapshot reports `open == false`, and the getter agrees.
        //
        // The onboarding cover above stays `.constant` on purpose — a genuine
        // first run is non-dismissible, so there is no write to lose.
        .sheet(isPresented: Binding(
          get: { snapshot.diff?.open == true },
          set: { presented in if !presented { model.send("diffClose") } }
        )) {
          if let review = snapshot.diff {
            DiffReviewSheet(model: model, review: review)
          }
        }
        // The one sheet the PAGE opens: export generates for a second or two
        // first, and the result arrives as a message rather than a tap.
        .onChange(of: model.pdfPreview) { _, request in
          if request != nil { sheet = .pdfPreview }
        }
        .onChange(of: sheet) { previous, _ in
          // Stop streaming whatever the closing sheet was subscribed to: both
          // outlines are the largest things on the wire and the canvas
          // re-renders on every keystroke.
          // RELEASED HERE for both sheets that report focus, because a
          // disappearing SwiftUI screen does not reliably deliver the focus
          // transition their `onChange` handlers rely on. Dismissed with the
          // keyboard still up, `nativeEditing` kept the scope — and a stuck
          // guard REFUSES every fetched unit for it until another focus/blur
          // cycle or a relaunch. Sync simply stops, silently, which is a worse
          // failure than the overwrite the guard exists to prevent.
          //
          // Sent from the sheet's close rather than from each field: one place
          // that always runs, instead of N places that each run only if SwiftUI
          // delivered a final blur.
          switch previous {
          case .structure:
            model.send("setStructureOpen", ["value": "false"])
            model.send("setNativeEditing", ["scope": "document", "value": "false"])
          case .design:
            model.send("setDesignOpen", ["value": "false"])
            // Let the held edit go and commit what the Format tab changed. The
            // inline editor saves on finish, and finishing is what was held.
            model.send("formatRelease")
          case .chat:
            model.send("setChatOpen", ["value": "false"])
            model.send("setNativeEditing", ["scope": "chat", "value": "false"])
          case .library: model.send("setLibraryOpen", ["value": "false"])
          case .history: model.send("setHistoryOpen", ["value": "false"])
          case .jobs: model.send("setJobsOpen", ["value": "false"])
          case .profile:
            model.send("setProfileOpen", ["value": "false"])
            model.send("setNativeEditing", ["scope": "profile", "value": "false"])
          case .pdfPreview:
            // Swiped away rather than answered. The web side is still holding
            // the export guard and the temp PDF waiting to hear which it was,
            // so an unanswered dismissal has to count as Cancel or the next
            // export cannot start and the file is never cleaned up.
            if model.pdfPreview != nil {
              model.pdfPreview = nil
              model.send("pdfCancel")
            }
          default: break
          }
        }
    }
    // On the NavigationStack rather than the canvas: the canvas ignores the
    // safe area, so `.bottom` there is the screen edge, while here it is where
    // a bottom bar belongs — no inset to compute and nothing to keep in step
    // with it.
    //
    // Withdrawn while a web dialog is up. The bar floats ABOVE the webview, so
    // it covered the PDF preview's Save button — the dialog rendered fine and
    // simply could not be completed. Its commands would act on the canvas
    // behind the dialog anyway.
    .overlay(alignment: .bottom) {
      if !snapshot.modalOpen { bottomBar }
    }
    // A SECOND overlay rather than a stack with the bar inside the first one:
    // stacked, the bar would jump upwards by the notice's height the moment a
    // background reconciliation finished, and a control moving out from under a
    // reaching finger is exactly what "non-blocking" is supposed to rule out.
    // Held clear of the bar by a fixed inset instead, so nothing already on
    // screen moves at all.
    //
    // Withdrawn while a web dialog is up for the same reason the bar is — it
    // floats above the webview and would cover the dialog's own buttons. The
    // cost is a notice that expires unseen behind one, which is the right way
    // round: the dialog is what the person is doing, and the parked version is
    // in Version history either way.
    .overlay(alignment: .bottom) {
      ZStack(alignment: .bottom) {
        if let notice = model.conflictNotice, !snapshot.modalOpen {
          conflictNotice(notice)
            .padding(.bottom, Self.conflictNoticeInset)
            .transition(.opacity)
        }
      }
      .animation(.snappy(duration: 0.3), value: model.conflictNotice)
    }
    // Pull whatever another device changed while this one was away. Nothing
    // waits on it and no failure surfaces — sync is background reconciliation.
    //
    // The notification rather than `scenePhase`: this view is installed into a
    // UIHostingController by hand, under a window tao owns and a scene
    // delegate declared in project.yml, so how much of SwiftUI's scene
    // environment reaches it is an inference. `willEnterForeground` is
    // UIKit's own signal and does not depend on any of that.
    .onReceive(NotificationCenter.default.publisher(
      for: UIApplication.willEnterForegroundNotification
    )) { _ in
      Task { await model.resumeSync() }
    }
    // The app's own theme setting, not the system's. Without this a user who
    // picks Dark gets a dark resume canvas inside light native chrome; the two
    // halves of one screen disagreeing is worse than either choice.
    // `nil` means "System", which is exactly SwiftUI's default behaviour.
    .preferredColorScheme(preferredColorScheme)
    .overlay {
      if model.launchContinuationVisible {
        LaunchScreenContinuationView()
          .transition(.opacity)
          .zIndex(100)
      }
    }
  }

  private var preferredColorScheme: ColorScheme? {
    switch snapshot.settings.theme {
    case "light": return .light
    case "dark": return .dark
    default: return nil
    }
  }

  // The title IS the résumé switcher: on a phone the navigation bar's centre is
  // the only place a title-length control fits, and a separate switcher would
  // cost a row of vertical space the canvas needs more.
  private var titleMenu: some View {
    Menu {
      Section {
        ForEach(snapshot.variants) { variant in
          Button { [renderedIn = snapshot.whereAmI] in
            // Pinned like the two actions below it. A variant id is unique only
            // within a workspace, so a menu held open across a tombstone would
            // open a DIFFERENT résumé of that name in the replacement — or, in
            // a workspace cloned from the same backup, one that matches by id
            // and is not the row that was tapped.
            guard renderedIn == model.snapshot.whereAmI else { return }
            model.send("selectVariant", ["id": variant.id])
          } label: {
            // A checkmark on the current row, which is how iOS shows the
            // selected item in a menu.
            if variant.id == snapshot.variantId {
              Label(variant.name, systemImage: "checkmark")
            } else {
              Text(variant.name)
            }
          }
        }
      }
      Section {
        // Pinned like every other row in this menu. `newVariant` names no
        // workspace, so a menu held open across a tombstone starts the wizard
        // against the replacement — and `saveOnboardingResume()` then creates
        // the résumé AND its job descriptions there, in a workspace whose title
        // menu was never opened.
        Button { [renderedIn = snapshot.whereAmI] in
          guard renderedIn == model.snapshot.whereAmI else { return }
          model.send("newVariant")
        } label: {
          Label("New resume", systemImage: "plus")
        }
        Button {
          model.send("setLibraryOpen", ["value": "true"])
          sheet = .library
        } label: {
          Label("All resumes…", systemImage: "books.vertical")
        }
      }
      // Managing the résumé belongs to the control that NAMES it, not to the
      // catch-all menu on the other side of the bar — same split the chat
      // sheet already uses, where the title menu owns the current thread.
      // Headed, because everything above this line is about some OTHER résumé:
      // without it "Rename…" reads as applying to whichever row you last
      // looked at rather than to the one on screen.
      Section("This resume") {
        Button {
          renameDraft = snapshot.variantName
          renameFrom = snapshot.whereAmI
          renamingVariant = true
          // Seeded ONCE from the snapshot, so a résumé renamed on another
          // device while this alert is up would be overwritten by the stale
          // draft on Save. Same guard as the structure fields; released when
          // the alert closes, whichever way it closes.
          model.send("setNativeEditing", ["scope": "document", "holder": "rename", "value": "true"])
        } label: {
          Label("Rename…", systemImage: "pencil")
        }
        // Both pinned to the render, like every other menu on this shell: a
        // menu keeps the action it was presented with, so one open across a
        // workspace tombstone would duplicate — or start the delete of — a
        // résumé in the workspace that replaced the one it is showing.
        Button { [renderedIn = snapshot.whereAmI] in
          guard renderedIn == model.snapshot.whereAmI else { return }
          model.send("duplicateVariant")
        } label: {
          Label("Duplicate", systemImage: "plus.square.on.square")
        }
        Button(role: .destructive) { [renderedIn = snapshot.whereAmI] in
          guard renderedIn == model.snapshot.whereAmI else { return }
          model.send("deleteVariant")
        } label: {
          Label("Delete", systemImage: "trash")
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(snapshot.variantName.isEmpty ? "On Paper" : snapshot.variantName)
          .font(.headline)
          .lineLimit(1)
          .truncationMode(.tail)
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      // Leaves room for the leading menu and the trailing PDF button without
      // letting a long résumé name push either off the bar.
      .frame(maxWidth: 200)
    }
    .accessibilityLabel("Switch or manage resume")
  }

  /// Everything that is NOT about which résumé is open — that lives on the
  /// title menu, which is the control that names it.
  /// Both halves of the New-profile alert, out of the view builder.
  ///
  /// Inline, the trimming expression appeared twice inside a `ViewBuilder` and
  /// the toolbar chain around it stopped type-checking "in reasonable time" —
  /// a build failure, not a behaviour one, and it returns the moment either of
  /// these is folded back in.
  private var trimmedRenameDraft: String {
    renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func submitRename() {
    let name = trimmedRenameDraft
    guard !name.isEmpty else { return }
    // THE RÉSUMÉ AND WORKSPACE THIS ALERT WAS OPENED FOR. `renameVariant` names
    // neither — it renames whatever is current when it arrives — and this alert
    // outlives a reload: a tombstone for the open workspace switches to a
    // replacement and reloads the webview underneath, while the SwiftUI alert
    // and its draft stay exactly where they were. Confirming then renamed a
    // résumé in a workspace nobody had opened.
    //
    // `whereAmI` rather than the variant id alone, because both halves can
    // move: the same tombstone changes the workspace, and a tombstone for the
    // résumé alone changes which one is current inside it.
    guard renameFrom == model.snapshot.whereAmI else {
      renameFrom = nil
      renameFailed = true
      return
    }
    renameFrom = nil
    model.send("renameVariant", ["name": name])
  }

  private var trimmedNewProfileName: String {
    newProfileName.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func submitNewProfile() {
    let name = trimmedNewProfileName
    guard !name.isEmpty else { return }
    // ANSWERED, not fired and forgotten. `createProfile` returns false when the
    // creation is refused — `flushActiveEdits` failing, or the registry's own
    // durability flush — and the alert has already closed by then, so a
    // discarded result left the person with no error and no new profile, and
    // nothing on screen connecting the two. The rename and delete flows in
    // `ProfilesSheet` already say so; this is the same failure and deserves the
    // same sentence.
    Task {
      if await model.createProfile(named: name) == false {
        profileFailure = "Could not create \(name) — the change didn't reach disk."
      }
    }
  }

  /// Hand the picked résumé's TEXT to the page, or say it could not be read.
  ///
  /// Extracted from the `fileImporter` closure rather than written inline, for
  /// the same reason `avatar` below is: adding the failure branch tipped this
  /// view's expression over the type-checker's budget, and the failure is a
  /// build timeout rather than a wrong shape.
  ///
  /// Only the TEXT crosses. The parse, the employer-grouping question and the
  /// write all stay in JS, so the native picker and the web one end in the same
  /// code rather than in two imports that drift.
  private func openPickedResume(_ result: Result<[URL], Error>) {
    // The workspace this picker was opened from. Refused rather than imported
    // somewhere else: the file is still on disk and can be picked again, where
    // a résumé silently created in another workspace is found much later, if at
    // all.
    let openedIn = importFrom
    importFrom = nil
    guard openedIn == model.snapshot.whereAmI else {
      renameFailed = false
      importFailed = true
      return
    }
    guard let picked = readPickedText(result, label: "resume") else {
      importFailed = true
      return
    }
    model.send("importVariantText", ["text": picked.text, "name": picked.name])
  }

  /// The initials, as an actual circle.
  ///
  /// Extracted from the menu's label because inlining it tipped the toolbar
  /// expression over the type-checker's budget — the failure is a build timeout,
  /// not a wrong shape, and it comes back the moment this is folded in again.
  private var avatar: some View {
    // THE BAR'S OWN GLASS, not a circle drawn here. That is what makes this a
    // Liquid Glass button in the same sense the share button is one — the same
    // material, the same size, the same inset from its edge — and all three of
    // those came free the moment this stopped fighting the toolbar for the
    // background.
    //
    // Hiding the shared background and drawing the shape by hand cost exactly
    // those: the item left the bar's background group, so it was laid out with
    // its own margins and sat ~20pt further in than the share button opposite.
    //
    // The frame is what keeps it ROUND. The toolbar sizes its glass to the
    // content plus symmetric padding, so square content gives a circle and two
    // letters at their natural width give a capsule. Sized like the 17pt
    // symbols beside it, with the initials scaled to fit rather than allowed to
    // push it wider.
    // A SQUARE that cannot be argued with, and the initials drawn OVER it.
    //
    // The toolbar sizes its glass to the content's layout size plus symmetric
    // padding, so the content must measure exactly square or the glass comes
    // out a capsule. Text is the wrong thing to ask: `.frame` on it still let
    // the natural width leak into the measurement (4pt of it), and constraining
    // the width instead just shrank the letters.
    //
    // `Color.clear` at a fixed size has no opinion and no intrinsic width, and
    // an `.overlay` draws without contributing to layout at all — so the bar
    // measures 17×17 exactly, whatever the initials happen to be.
    Color.clear
      .frame(width: 17, height: 17)
      .overlay {
        Text(snapshot.profiles.first(where: \.isActive)?.initials ?? "?")
          .font(.system(size: 14, weight: .semibold))
          .lineLimit(1)
          .fixedSize()
          .foregroundStyle(Color.accentColor)
      }
  }

  private var actionsMenu: some View {
    Menu {
      // WORKSPACES FIRST, because the button is now the workspace's initials
      // and this is what it claims to be about. Switching is inline rather than
      // behind the sheet: it is the one thing done often enough to deserve a
      // single tap, and the sheet exists for the rest.
      // ONE ROW that opens a submenu, rather than the whole profile list spilling
      // into the main menu. With three or four profiles the list pushed File and
      // Tools off the bottom, so the menu opened on a scroll — and everything a
      // person came here for was the part they could not see.
      Menu {
        ForEach(snapshot.profiles) { profile in
          Button {
            Task {
              // "may not have reached disk", not "did not": the page also
              // refuses a switch while a first-run adoption is still finishing,
              // where nothing is unsaved. The one thing true of every refusal is
              // that the open workspace did not change.
              if await model.switchToProfile(profile.id) == false {
                profileFailure = "Could not switch to \(profile.name) — your "
                  + "latest changes may not have reached disk."
              }
            }
          } label: {
            if profile.isActive {
              Label(profile.name, systemImage: "checkmark")
            } else {
              Text(profile.name)
            }
          }
          .disabled(profile.isActive)
        }
        Divider()
        Button { newProfileName = ""; creatingProfile = true } label: {
          Label("New profile…", systemImage: "plus")
        }
        Button { sheet = .profiles } label: {
          Label("Manage profiles", systemImage: "person.2")
        }
      } label: {
        // Named for the profile you are IN, so the row answers "which one is
        // this" without being opened.
        Label(
          snapshot.profiles.first(where: \.isActive)?.name ?? "Profiles",
          systemImage: "person.crop.circle"
        )
      }
      // No "Edit" section. Undo and redo are document actions used constantly
      // while typing, and two taps into a menu is the wrong cost for something
      // done that often — they live in the bottom bar now, one tap from the
      // canvas.
      Section("File") {
        Button { [renderedIn = snapshot.whereAmI] in
          // In the capture list, not in the body: `snapshot` is a computed read
          // of `model.snapshot`, so reading it inside the action resolves LIVE
          // at the press — which is after the menu-open wait, and would pin the
          // very workspace being guarded against. (Not an `onChange` on the
          // body either: this view's expression is at the type-checker's budget
          // and one more modifier tips it over.)
          importFrom = renderedIn
          importingVariant = true
        } label: {
          Label("Import…", systemImage: "square.and.arrow.down")
        }
        // Pinned like Import above them. `exportVariant` delegates to
        // `exportCurrentVariant()` and carries no identity at all, so a menu
        // held open across a tombstone hands the share sheet the replacement
        // workspace's résumé — a document the person never asked to send, under
        // the name of one they did.
        Button { [renderedIn = snapshot.whereAmI] in
          guard renderedIn == model.snapshot.whereAmI else { return }
          model.send("exportVariant", ["format": "json"])
        } label: {
          Label("Export as JSON", systemImage: "curlybraces")
        }
        Button { [renderedIn = snapshot.whereAmI] in
          guard renderedIn == model.snapshot.whereAmI else { return }
          model.send("exportVariant", ["format": "md"])
        } label: {
          Label("Export as Markdown", systemImage: "text.alignleft")
        }
      }
      Section("Tools") {
        Button {
          model.send("setProfileOpen", ["value": "true"])
          sheet = .profile
        } label: {
          Label("Profile", systemImage: "person.crop.circle")
        }
        Button {
          model.send("setJobsOpen", ["value": "true"])
          sheet = .jobs
        } label: {
          Label("Jobs", systemImage: "briefcase")
        }
        Button {
          model.send("setHistoryOpen", ["value": "true"])
          sheet = .history
        } label: {
          Label("Version history", systemImage: "clock.arrow.circlepath")
        }
      }
      Section {
        Button { sheet = .settings } label: { Label("Settings", systemImage: "gearshape") }
      }
    } label: {
      // The initials, not an ellipsis: the same identity the desktop header
      // carries, so the corner answers "whose workspace is this" before it is
      // asked. `?` only before the first snapshot lands.
      // A REAL circle, drawn here, with the toolbar's own glass switched off
      // beneath it (`sharedBackgroundVisibility(.hidden)` on the item).
      //
      // The toolbar's automatic capsule cannot be a circle for this label: it is
      // 44pt tall and pads the content horizontally, so two letters always come
      // out wider than tall. Every attempt to size the label into a circle ends
      // up shrinking the initials to fit somebody else's arithmetic. Drawing the
      // shape means the shape is the shape.
      avatar
    }
    .accessibilityLabel("Profile and actions")
  }

  private var pdfButton: some View {
    Button {
      model.send("exportPdf")
    } label: {
      if snapshot.pdfBusy {
        ProgressView()
      } else {
        Image(systemName: "square.and.arrow.up")
      }
    }
    .disabled(snapshot.pdfBusy)
    .accessibilityLabel(snapshot.pdfBusy ? "Generating PDF" : "Export PDF")
  }

  /// The bottom bar, ours rather than the system's.
  ///
  /// It was a `ToolbarItemGroup` until the zoom controls needed to take its
  /// place, and a system toolbar item cannot morph — swapping the bar for an
  /// overlay read as one thing vanishing and another appearing. Ours can: the
  /// zoom capsule is never unmounted, so animating its frame carries its glass
  /// with it, from the trailing readout to the centred control.
  ///
  /// Deliberately NOT a `GlassEffectContainer`. One around both capsules merges
  /// them into a single hazy shape spanning the bar; the morph here comes from
  /// the capsule staying put, not from matched effect ids.
  ///
  /// It keeps the system's own shape deliberately — 44pt glass capsules at the
  /// bottom safe area, the same metrics the toolbar used — because the point is
  /// that it still reads as the standard bottom bar.
  private var bottomBar: some View {
    barRow
      .padding(.horizontal, 12)
      .padding(.bottom, 4)
  }

  /// Clears the bottom bar: its 44pt capsules (`BarCapsule`), the 4pt that holds
  /// them off the home indicator, and 8pt of air between the two.
  private static let conflictNoticeInset: CGFloat = 56

  /// What sync says when it has resolved a conflict — see
  /// `ShellModel.conflictNotice` for the rule and the copy.
  ///
  /// A button, because the sentence ends at Version history and that sheet is
  /// one tap away from here: the notice is then a route rather than a statement
  /// about somewhere else in the app. It opens the history of the résumé ON
  /// SCREEN, which is the one that produces very nearly every conflict — the
  /// copy names no résumé precisely so that this is a shortcut and not a claim.
  ///
  /// Glass on a rounded rect rather than `BarCapsule`: it is the same floating
  /// chrome as the bar below it, but a capsule around three lines of text draws
  /// a lozenge with enormous empty ends.
  private func conflictNotice(_ text: String) -> some View {
    Button {
      model.send("setHistoryOpen", ["value": "true"])
      sheet = .history
      model.dismissConflictNotice()
    } label: {
      HStack(alignment: .top, spacing: 10) {
        // The icon the "Version history" menu item already carries, so the two
        // read as the same destination.
        Image(systemName: "clock.arrow.circlepath")
          .font(.footnote)
          .foregroundStyle(.secondary)
          // Optical alignment with the first line of text rather than its box.
          .padding(.top, 1)
        Text(text)
          .font(.footnote)
          .foregroundStyle(.primary)
          .multilineTextAlignment(.leading)
          // Without this the text truncates instead of wrapping inside an
          // overlay that is free to be as tall as it likes.
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 20))
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 12)
    .accessibilityHint("Opens Version history")
  }

  private var barRow: some View {
    HStack(spacing: 12) {
      if !zoomExpanded {
        HStack(spacing: 20) {
          // UNDO AND REDO FIRST, and in the bar rather than the menu they used
          // to sit in. They are document actions used constantly while editing,
          // and two taps into an overflow menu is the wrong price for the one
          // pair of controls a person reaches for mid-sentence. Leading, where
          // a thumb already is.
          // DISABLED DURING A CAPTURE, like the two menus above. The
          // main-window export yields between pages, and an undo landing in one
          // of those gaps puts a different revision of the document in the
          // later pages than the earlier ones — one file, two résumés, and
          // nothing in it says so.
          Button { model.send("undo") } label: {
            Image(systemName: "arrow.uturn.backward")
          }
          .accessibilityLabel("Undo")
          .disabled(snapshot.pdfBusy)

          Button { model.send("redo") } label: {
            Image(systemName: "arrow.uturn.forward")
          }
          .accessibilityLabel("Redo")
          .disabled(snapshot.pdfBusy)

          Button {
            model.send("setChatOpen", ["value": "true"])
            sheet = .chat
          } label: {
            Image(systemName: "bubble.left.and.text.bubble.right")
          }
          .accessibilityLabel("Assistant")

          Button {
            model.send("setStructureOpen", ["value": "true"])
            sheet = .structure
          } label: {
            Image(systemName: "list.bullet.rectangle")
          }
          .accessibilityLabel("Edit structure")
          // The other two ways into the document from this bar. Same reason as
          // undo and redo: what they change lands between the pages a capture
          // is still taking.
          .disabled(snapshot.pdfBusy)

          styleButton.disabled(snapshot.pdfBusy)
        }
        .modifier(BarCapsule())
        // Scale rather than slide: the zoom capsule is growing into the space
        // this leaves, and two things travelling in different directions reads
        // as a swap. Shrinking in place reads as making room.
        .transition(.scale(scale: 0.9).combined(with: .opacity))

        Spacer(minLength: 0)
      }

      zoomControl
    }
    .font(.system(size: 17))
    .buttonStyle(.plain)
    .foregroundStyle(.primary)
  }

  /// Three separate items (−, readout, +) is what ran the bar out of room once
  /// Design joined it: seven capsules on a 390pt screen, and the last was
  /// clipped off the edge. As one item it is one capsule, and even expanded it
  /// leaves the four tools their room.
  ///
  /// Zoom is also not a thing you use continuously, which is what Safari's zoom
  /// UI is built around: a percentage at rest, and the controls only while you
  /// are actually changing it. `keepZoomOpen` runs that clock.
  ///
  /// The branch lives INSIDE this view rather than in the toolbar builder. A
  /// `ToolbarItemGroup` whose item COUNT changes is not reliably re-diffed by
  /// SwiftUI — the first version of this flipped its state and never redrew —
  /// but ordinary view content inside one item diffs normally.
  private var zoomControl: some View {
    HStack(spacing: 20) {
      if zoomExpanded {
        Button {
          model.send("zoomOut")
          keepZoomOpen()
        } label: {
          Image(systemName: "minus")
        }
        .accessibilityLabel("Zoom out")
        .transition(.opacity)
      }

      zoomMenu

      if zoomExpanded {
        Button {
          model.send("zoomIn")
          keepZoomOpen()
        } label: {
          Image(systemName: "plus")
        }
        .accessibilityLabel("Zoom in")
      .transition(.opacity)
      }
    }
    // The SAME id in both states — that is the morph. The capsule grows from
    // the corner readout into the centred control instead of one being
    // replaced by the other.
    .modifier(BarCapsule())
    // Centred while open, trailing while not: with the tools gone the leading
    // spacer goes with them, so this one is what balances it.
    .frame(maxWidth: zoomExpanded ? .infinity : nil)
  }

  // shell hides. Routing them here is what keeps hiding it from being a
  // functional regression.
  /// Text formatting and Design, behind ONE button.
  ///
  /// They were two buttons, side by side, and the pair could not be told apart:
  /// the bar's `textformat` glyph opened selection formatting, while the Design
  /// sheet's own Typography row carries the SAME glyph for document fonts. Two
  /// icons, one symbol, adjacent — and the honest answer to "which one changes
  /// the text" was "both, differently".
  ///
  /// Merging them made this a MENU whose first half was formatting and whose
  /// last item opened the sheet — a menu in front of a panel that had room for
  /// both. Now formatting is that panel's first tab, so the button opens the
  /// panel: one tap to the thing, instead of a tap to a list of things.
  private var styleButton: some View {
    Button {
      // The keyboard lives in its own window ABOVE any presented sheet, so a
      // panel opened while inline editing is running is drawn entirely behind
      // it — measured: nothing of the sheet was visible but its top corner.
      // Notes does what this does, and for the same reason.
      //
      // ORDER MATTERS. `formatHold` has to be in flight before the keyboard
      // goes, because dismissing it blurs the résumé's editor, and an unheld
      // blur commits and re-renders — which detaches the node the panel's
      // buttons are aimed at and leaves every one of them a silent no-op.
      model.send("formatHold")
      webView.endEditing(true)
      model.send("setDesignOpen", ["value": "true"])
      sheet = .design
    } label: {
      Image(systemName: "paintbrush")
    }
    .accessibilityLabel("Style")
  }

  /// Open the zoom controls, and restart the clock on closing them again.
  ///
  /// Called by the readout, by every zoom button, and by a pinch. Each call
  /// restarts the delay, so a run of taps or a long pinch keeps the controls up
  /// throughout and they leave once, together, when the user stops.
  private func keepZoomOpen() {
    zoomInteraction += 1
    let generation = zoomInteraction
    withAnimation(.snappy(duration: 0.25)) { zoomExpanded = true }
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(2.5))
      guard generation == zoomInteraction else { return }
      // A menu is up and the person is reading it. Collapsing now would take
      // the control the menu is anchored to out from under it.
      guard !zoomMenuOpen else { return }
      withAnimation(.snappy(duration: 0.3)) { zoomExpanded = false }
    }
  }

  /// An action was chosen, so the menu is gone: resume the ordinary timeout.
  private func releaseZoomMenu() {
    zoomMenuOpen = false
    keepZoomOpen()
  }

  /// Hold the controls open while a zoom menu is, and let go afterwards.
  ///
  /// The backstop is what makes the flag safe: a menu dismissed with a tap
  /// outside it tells us nothing, so the guard is released on a timer and the
  /// ordinary collapse resumes.
  private func holdZoomForMenu() {
    zoomMenuOpen = true
    keepZoomOpen()
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(12))
      zoomMenuOpen = false
      keepZoomOpen()
    }
  }

  /// Fit and Actual size — the zoom commands that are not a step.
  ///
  /// ONE definition, reached two ways, because they are the same commands and a
  /// second copy is how the collapsed pill and the expanded one come to offer
  /// different things.
  ///
  /// `finish` is the part the two callers do not share. Opened from the
  /// expanded control, the menu is holding the auto-collapse off, so choosing
  /// something has to let go of it. Opened from the collapsed pill there is
  /// nothing to release — and nothing to open either: growing the bar into the
  /// −/+ controls after the command has already run answers a question nobody
  /// asked, and then tidies itself away again 2.5s later.
  @ViewBuilder
  private func zoomActions(finish: @escaping () -> Void) -> some View {
    Button { model.send("zoomFit"); finish() } label: {
      Label("Fit to view", systemImage: "arrow.up.left.and.arrow.down.right")
    }
    // Fills the width and lets the page run off the bottom. On a phone this is
    // the one you actually want while READING: a portrait page fitted whole is
    // mostly margin, and on a multi-page résumé the whole-page fit is bound by
    // a height several screens tall.
    Button { model.send("zoomFitWidth"); finish() } label: {
      Label("Fit to width", systemImage: "arrow.left.and.right")
    }
    Button { model.send("zoomReset"); finish() } label: {
      Label("Actual size", systemImage: "1.magnifyingglass")
    }
  }

  /// The centre of the control: always the live percentage.
  ///
  /// Collapsed it is the button that opens the controls. Expanded it carries
  /// the two commands that are not a step — Fit and Actual size — because by
  /// then there is a control to hang them off.
  @ViewBuilder
  private var zoomMenu: some View {
    if zoomExpanded {
      Menu { zoomActions(finish: releaseZoomMenu) } label: {
        zoomReadout
      }
      // The controls were timing out from UNDER the open menu. `keepZoomOpen`
      // collapses them 2.5s after the last interaction, and opening a menu was
      // not one — so the bar tidied itself away mid-decision and took the menu
      // with it. Simultaneous, because the tap still has to reach the Menu.
      .simultaneousGesture(TapGesture().onEnded { holdZoomForMenu() })
      .accessibilityLabel("Zoom, \(snapshot.zoomPercent) percent")
    } else {
      // Collapsed, the readout OPENS the controls. It was a Menu in both
      // states for a moment, and tapping the percentage offered Fit and Actual
      // size instead of the −/+ the tap is asking for.
      //
      // A LONG PRESS still gets them, though, which is the point of this pair:
      // the tap does the common thing and the hold does the rarer one, so Fit
      // and Actual size stop being two taps away behind a control that has to
      // be opened first — and the pill offers the same two commands whichever
      // state it happens to be in.
      // `Menu(content:label:primaryAction:)`, not a Button with a
      // `.contextMenu`. Both give tap-one-thing / hold-another, but the context
      // menu had to win an arbitration against the button's own tap and the
      // bar's interactive glass, and lost often enough that a hold sometimes
      // did nothing at all. This pairing is the API for exactly this: the tap
      // runs `primaryAction`, the hold opens the menu, and neither has to beat
      // the other to it.
      Menu { zoomActions(finish: {}) } label: {
        zoomReadout
      } primaryAction: {
        keepZoomOpen()
      }
      .accessibilityLabel("Zoom, \(snapshot.zoomPercent) percent. Opens the zoom controls.")
    }
  }

  private var zoomReadout: some View {
    Text("\(snapshot.zoomPercent)%")
      .font(.subheadline)
      .monospacedDigit()
      // Fixed, or the capsule resizes on 99% → 100%.
      .frame(minWidth: 46)
      // Text is only hit-testable where its glyphs are; without this the pill
      // has a live centre and dead corners.
      .contentShape(.rect)
  }
}

// MARK: - PDF export

/// The generated PDF, before it is saved.
///
/// Replaces the web export dialog on iOS. That one rasterises the PDF with
/// pdf.js into stacked `<canvas>` sheets because a page has nothing better —
/// WKWebView will not render a PDF in a frame and the app's CSP forbids one
/// anyway. On iOS the system's own PDF view is right there: it renders text
/// sharply at any scale, scrolls and zooms for free, and needs no megabyte of
/// base64 through the bridge to do it.
///
/// The two outcomes route to the SAME callbacks pdf.js hands its own dialog, and
/// exactly one of them must run: the export guard is held from generation until
/// one does, and the temp file is only cleaned up by them. Hence the cancel on
/// an unanswered dismissal in ShellView.
private struct PdfPreviewSheet: View {
  @ObservedObject var model: ShellModel
  let request: PdfPreviewRequest
  @Environment(\.dismiss) private var dismiss

  @State private var filename = ""

  var body: some View {
    NavigationStack {
      PDFDocumentView(url: request.url)
        .safeAreaInset(edge: .bottom) { filenameField }
        .navigationTitle("Export PDF")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", role: .cancel) { settle(save: false) }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") { settle(save: true) }
              .fontWeight(.semibold)
              .disabled(trimmed.isEmpty)
          }
        }
    }
    .onAppear { filename = request.filename }
  }

  private var trimmed: String { filename.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var filenameField: some View {
    HStack(spacing: 6) {
      TextField("Resume", text: $filename)
        .textFieldStyle(.plain)
        .textInputAutocapitalization(.words)
        .autocorrectionDisabled()
        .submitLabel(.done)
        .onSubmit { if !trimmed.isEmpty { settle(save: true) } }
      Text(".pdf").foregroundStyle(.secondary)
    }
    .padding(.horizontal, 16)
    .frame(height: 48)
    .modifier(ComposerSurface())
    .padding(.horizontal, 12)
  }

  /// Answer the web side once, and only once.
  private func settle(save: Bool) {
    guard model.pdfPreview != nil else { return }
    model.pdfPreview = nil
    // Saving is a SHARE on iOS: `save_file`'s document picker never appears once
    // tao's view controller is nested, and the share sheet's own "Save to
    // Files" is the same destination the desktop picker writes to.
    model.send(save ? "pdfSave" : "pdfCancel", save ? ["filename": trimmed] : [:])
    dismiss()
  }
}

/// PDFKit, as a SwiftUI view.
private struct PDFDocumentView: UIViewRepresentable {
  let url: URL

  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    // autoScales fits the page to the width and still allows pinching past it,
    // which is what makes a phone-sized preview of a letter page readable.
    view.autoScales = true
    view.displayDirection = .vertical
    view.displayMode = .singlePageContinuous
    view.backgroundColor = .secondarySystemBackground
    view.document = PDFDocument(url: url)
    return view
  }

  func updateUIView(_ view: PDFView, context: Context) {
    guard view.document?.documentURL != url else { return }
    view.document = PDFDocument(url: url)
  }
}

// MARK: - Settings

/// The native Settings sheet.
///
/// A pure form with no document access — deliberately the first thing built on
/// the bridge, because it exercises reads (the snapshot's `settings`) and
/// writes (four commands) without touching the résumé.
///
/// It renders from the SNAPSHOT, not from local state, so every control shows
/// what actually landed in the store rather than what it optimistically set.
/// The one exception is the API-key field, which has no snapshot to render
/// from: only whether a key exists comes back.
/// What the résumé importer will open.
///
/// JSON and Markdown, because the shared pipeline takes both — `Header.jsx`
/// offers `.json`, `.md` and `.markdown`, and `importVariant` strips either
/// Markdown extension. Offering only JSON here made a Markdown résumé
/// unselectable on iOS while the parser behind the picker could read it.
/// `.plainText`/`.text` are the fallback a device with no Markdown declaration
/// resolves an `.md` file to — the same list `OPProfile` builds for its import.
private let resumeImportTypes: [UTType] = {
  var types: [UTType] = [.json, .plainText, .text]
  if let markdown = UTType(filenameExtension: "md") { types.insert(markdown, at: 1) }
  return types
}()

/// A picked file's text and name, or nil when nothing usable was chosen.
///
/// Shared by the two importers so the security-scoped read — which a file from
/// outside the app's container fails without — is written once rather than
/// twice. Same pair `OPProfile.handleImport` opens.
/// A one-button "this did not happen, and here is why" alert.
///
/// A modifier rather than the `.alert` written out at each site, and not as a
/// style choice: `ShellView`'s body sits at the type-checker's budget, and every
/// inline alert added to it has tipped it over — a build timeout rather than a
/// wrong shape. Each one that moves in here buys the next one room.
private struct NoticeAlert: ViewModifier {
  let title: String
  @Binding var isPresented: Bool
  let hint: String

  func body(content: Content) -> some View {
    content.alert(title, isPresented: $isPresented) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(hint)
    }
  }
}

/// The two importers that share `readPickedText`, which reports nothing itself.
private func importFailureAlert(isPresented: Binding<Bool>, hint: String) -> NoticeAlert {
  NoticeAlert(title: "Could not read that file", isPresented: isPresented, hint: hint)
}

private func readPickedText(
  _ result: Result<[URL], Error>,
  label: String
) -> (text: String, name: String)? {
  guard case .success(let urls) = result, let url = urls.first else {
    if case .failure(let error) = result {
      NSLog("[OPShell] \(label) import failed: \(error)")
    }
    return nil
  }
  let scoped = url.startAccessingSecurityScopedResource()
  defer { if scoped { url.stopAccessingSecurityScopedResource() } }
  guard let text = try? String(contentsOf: url, encoding: .utf8) else {
    NSLog("[OPShell] \(label) import could not be read as text")
    return nil
  }
  // `nil` is not only a log line. A security-scoped URL that cannot be opened,
  // or a file that is not UTF-8, leaves the picker closing with the screen
  // unchanged — which looks exactly like the selection being ignored. Every
  // caller owes the person a word; `ProfileView`'s importer already says one.
  return (text, url.lastPathComponent)
}

/// "These settings are not on disk." The third of these, worded like
/// `JobsSaveWarning` and `DocumentSaveWarning`, because it is the same failure
/// on the keys this sheet writes.
private struct SettingsSaveWarning: View {
  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text("Not being saved").font(.subheadline.weight(.semibold))
        Text("Storage is full, so these settings are not on disk. Free up space — they will go back to their old values on the next launch.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
    }
    .padding(.vertical, 2)
  }
}

private struct SettingsSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var apiKeyDraft = ""
  @State private var apiKeyFocused = false
  /// Guards the destructive remove behind one confirmation. The key cannot be
  /// read back out of the keychain to show, so a mis-tap is only recoverable by
  /// fetching a new one from OpenRouter.
  @State private var confirmRemoveKey = false
  /// The backup file picker, here for the same reason as the résumé one: the
  /// web input never opens under the shell.
  @State private var importingBackup = false
  /// The workspace the backup picker was opened FROM.
  ///
  /// Browsing the Files app is an arbitrarily long wait, and nothing dismisses
  /// a native sheet when the webview reloads underneath it. `importBackupText`
  /// names no workspace, so it restores into whichever one is open when it
  /// arrives — and a restore is not an ordinary write: the format-1 path wipes
  /// the active profile's owned keys before writing. Aimed at the wrong
  /// workspace it does not import somewhere odd, it REPLACES a workspace nobody
  /// asked about. The two résumé pickers already pin for the milder version of
  /// this; see `openPickedResume`.
  @State private var backupFrom: ShellSnapshot.Where?
  @State private var backupElsewhere = false
  /// That file could not be read. See `readPickedText`.
  @State private var importFailed = false

  private var settings: ShellSnapshot.Settings { model.snapshot.settings }

  var body: some View {
    NavigationStack {
      Form {
        // FIRST, and standing: every control below reports success on the cache
        // taking the value, so without this the sheet looks saved right up until
        // the settings revert on the next launch.
        if settings.saveFailed {
          Section { SettingsSaveWarning() }
        }
        Section("Appearance") {
          Picker("Theme", selection: themeBinding) {
            Text("System").tag("system")
            Text("Light").tag("light")
            Text("Dark").tag("dark")
          }
          .pickerStyle(.segmented)
        }

        Section {
          SecureField(
            settings.hasApiKey ? "Replace the saved key" : "sk-or-v1-…",
            text: $apiKeyDraft
          )
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          Button(model.apiKeyWriteInFlight ? "Saving…" : "Save key") {
            let key = apiKeyDraft
            model.apiKeyWriteFailed = false
            Task {
              let saved = await model.saveApiKey(key)
              // The draft survives a refusal. Clearing it unconditionally is
              // what used to lose the key: the keychain says no, nothing
              // publishes, and the field the user typed into is already empty.
              if saved { apiKeyDraft = "" } else { model.apiKeyWriteFailed = true }
            }
          }
          .disabled(
            model.apiKeyWriteInFlight
            || apiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty
          )

          // The only way to REMOVE a key on iOS. `Save key` refuses an empty
          // draft — deliberately, because clearing the field is how a refused
          // save used to lose the key — and the web Settings that offers this is
          // unreachable behind the native shell. So a revoked or unwanted
          // credential could be replaced but never erased from a keychain that
          // syncs to every device on the account.
          //
          // `saveApiKey("")` is already the clear operation; `backupFlow`'s
          // rollback uses exactly that. Nothing new crosses the bridge.
          if settings.hasApiKey {
            Button("Remove key", role: .destructive) { confirmRemoveKey = true }
              .disabled(model.apiKeyWriteInFlight)
          }

          Toggle("Automatic fallback", isOn: fallbackBinding)
            .confirmationDialog(
              "Remove the saved API key?",
              isPresented: $confirmRemoveKey,
              titleVisibility: .visible
            ) {
              Button("Remove key", role: .destructive) {
                model.apiKeyWriteFailed = false
                Task {
                  // The same refusal handling as a save: the keychain can say
                  // no, and claiming the key is gone when it is not would be
                  // worse here than for a write.
                  let cleared = await model.saveApiKey("")
                  if !cleared { model.apiKeyWriteFailed = true }
                }
              }
              Button("Cancel", role: .cancel) { }
            } message: {
              Text("The AI assistant will stop working until you add a key again. Everything else is unaffected. This also removes it from your other devices.")
            }
        } header: {
          Text("AI")
        } footer: {
          // Says what the app does with the key, in the place the key is
          // entered — the same promise the web onboarding makes.
          //
          // A refusal replaces it rather than joining it: the one thing worth
          // reading at that moment is that the key is NOT saved, and it should
          // not have to be found at the end of a paragraph about privacy.
          if model.apiKeyWriteFailed {
            // Worded to be true whether or not the draft is still there. This
            // notice can now outlive the sheet, so the old "it is still in the
            // field above" would be a false statement on a reopened one.
            Text("The keychain would not save that key, so it is not stored. Unlock the device if it was locked, then save again.")
              .foregroundStyle(.red)
          } else {
            Text(
              (settings.hasApiKey ? "A key is saved. " : "")
              + "Your key is stored in the iOS keychain and sent only to OpenRouter. "
              + "Automatic fallback retries an alternate model when the chosen one "
              + "is unavailable."
            )
          }
        }

        Section {
          if model.syncSuspended {
            Text(
              "iCloud data for On Paper was removed. This device stopped syncing "
              + "so it does not put it back."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            Button("Resume syncing") {
              Task { await model.resumeSyncing() }
            }
          }
          // No row at all when there is nothing to say — see `syncStatus`.
          if !model.syncStatus.isEmpty {
            Text(model.syncStatus)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        } header: {
          Text("Sync")
        } footer: {
          // The question sync raises is "where do my resumes go", and it is
          // answered here rather than in a policy nobody opens. Both halves
          // matter: whose account they land in, and that On Paper is not a party
          // to any of it.
          Text(
            "Your resumes are copied to your own iCloud account, so the devices you "
            + "use stay in step. Nothing is sent to On Paper."
          )
        }

        Section("Data") {
          Button("Export backup…") {
            // DISMISSED FIRST, like the import below. A staging failure reports
            // through a Tauri dialog, which presents on the window's root
            // controller with no walk over what is already presented — so with
            // this sheet still up UIKit refuses it and the person taps Export
            // and gets nothing at all, which is the silence this whole path was
            // fixed to remove. Dismissing also puts the share sheet back on the
            // root, where its iPad popover anchor actually lives.
            dismiss()
            model.send("exportBackup")
          }
          Button("Import backup…") {
            backupFrom = model.snapshot.whereAmI
            importingBackup = true
          }
        }

        Section {
          Button("Replay welcome guide") {
            model.send("replayOnboarding")
            // The wizard is web and renders in the canvas underneath, so the
            // sheet has to get out of its way.
            dismiss()
          }
        } footer: {
          Text("Your resumes and settings are kept.")
        }

        Section("About") {
          LabeledContent("On Paper", value: settings.version.isEmpty ? "—" : settings.version)
        }
      }
      .navigationTitle("Settings")
      .fileImporter(
        isPresented: $importingBackup,
        allowedContentTypes: [.json],
        allowsMultipleSelection: false
      ) { result in
        // Refused rather than restored elsewhere: the file is still on disk and
        // can be picked again, where a workspace overwritten by someone else's
        // backup is not recoverable from here.
        let openedIn = backupFrom
        backupFrom = nil
        guard openedIn == model.snapshot.whereAmI else {
          backupElsewhere = true
          return
        }
        guard let picked = readPickedText(result, label: "backup") else {
          importFailed = true
          return
        }
        // DISMISSED FIRST. The import asks for a destructive confirmation, and
        // that dialog is web — it renders in the canvas UNDER this sheet, where
        // it cannot be seen or answered, so the import simply stalled. The
        // "Replay welcome guide" button already does this for the same reason.
        dismiss()
        model.send("importBackupText", ["text": picked.text, "name": picked.name])
      }
      .modifier(importFailureAlert(
        isPresented: $importFailed,
        hint: "Pick a backup .json exported from On Paper."
      ))
      .modifier(NoticeAlert(
        title: "That workspace is gone",
        isPresented: $backupElsewhere,
        hint: "Your workspace changed on another device while the picker was open, "
          + "so nothing was restored. Open Settings again and pick the file once more."
      ))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.large])
  }

  // Bindings that WRITE through the bridge and READ from the snapshot, so the
  // control cannot drift from the store: a rejected write simply never comes
  // back and the control springs back to the truth.
  private var themeBinding: Binding<String> {
    Binding(
      get: { settings.theme },
      set: { model.send("setTheme", ["value": $0]) }
    )
  }

  private var fallbackBinding: Binding<Bool> {
    Binding(
      get: { settings.autoFallback },
      set: { model.send("setAutoFallback", ["value": $0 ? "true" : "false"]) }
    )
  }
}

// MARK: - Structure panel

/// The native structure editor.
///
/// The only place the document crosses the bridge. It renders whatever
/// `DocumentOutline` it is given — labelled, path-keyed fields — and writes
/// back with `setField(path, value)`, which routes to the same `store.update`
/// the web editor uses. Same path grammar, same undo history, same re-render.
///
/// **The focus rule is the load-bearing part.** Typing here writes to the
/// store, the store re-renders and republishes, and the new snapshot arrives
/// while the user is still mid-word. Rendering that value straight back into
/// the field they are typing in resets the cursor to the end on every
/// keystroke. So a FOCUSED field renders from its local draft and ignores
/// inbound snapshots for its own path; every other field keeps updating live.
/// "This résumé is not on disk." Worded like `JobsSaveWarning` and
/// `ChatSaveWarning`, which are the same failure on their own keys.
private struct DocumentSaveWarning: View {
  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text("Not being saved").font(.subheadline.weight(.semibold))
        Text("Storage is full, so these edits are not on disk. Free up space — reloading now would lose them.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
    }
    .padding(.vertical, 2)
  }
}

private struct StructureSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @FocusState private var focusedPath: String?
  @State private var drafts: [String: String] = [:]
  /// A whole role or section awaiting confirmation. Asked NATIVELY and before
  /// the command is sent — the web's `confirmDestructive()` renders a Radix
  /// dialog inside the webview, behind this sheet, where nobody would see it
  /// and its promise would never settle.
  @State private var pendingRemoval: Removal?

  private struct Removal: Identifiable {
    let path: String
    let index: Int
    let title: String
    /// What the row IS, as opposed to where it was. See `currentIndex(for:)`.
    let identity: String
    /// The workspace this was ASKED about.
    ///
    /// `currentIndex(for:)` re-resolves the row by its id, which is right for
    /// an adoption inside one workspace — an id there means the same row. It is
    /// no help at all across workspaces: `duplicateVariant` deep-copies the
    /// document, so a duplicate carries IDENTICAL ids, and a tombstone for the
    /// open résumé swaps another one in underneath this sheet without closing
    /// it. The id then matches a row the alert never named, in a résumé nobody
    /// opened, and a whole role or section is spliced out of it.
    ///
    /// The revision echo cannot stand in either: it is read live at the press,
    /// and a variant swap is not an adoption, so the counter never moves for it.
    let renderedIn: ShellSnapshot.Where
    var id: String { "\(path)[\(index)]" }
  }

  /// Set when an action was refused because the résumé had moved on. Carries
  /// the sentence to show, since the same alert covers a whole-group delete, a
  /// row delete and a reorder.
  @State private var staleAction: String?

  /// What every one of those has to say. The sheet is not busy during a drag or
  /// a swipe by any measure the sync guards use — there is no focused field —
  /// so an adopted résumé can renumber the list underneath the gesture, and
  /// acting on the index it started from would move or delete a different row.
  private var movedMessage: String {
    "The résumé changed while this was open, so nothing was changed. "
      + "Try again from the refreshed list."
  }

  /// Where that row sits NOW, or nil if it has moved or gone.
  ///
  /// The alert is an unbounded wait and `index` is a POSITION. This sheet is
  /// not busy unless a field has focus, so a fetched document can be adopted
  /// while the alert is up — and `removeItem` would then splice that index out
  /// of an array that has been reordered or replaced, deleting a role the alert
  /// never named.
  private func currentIndex(for removal: Removal) -> Int? {
    let candidates = groups.filter { $0.removePath == removal.path }
    if !removal.identity.isEmpty {
      return candidates.first { $0.removeId == removal.identity }?.removeIndex
    }
    // Older documents have no ids, so the title at the same position is the only
    // check left — and it is only a check while the title is UNIQUE. Two roles
    // called "Engineer" and a synced replacement that removed the one the alert
    // named leave the other sitting at that index answering to the same string,
    // which is a wrong delete dressed up as a verified one. Refuse instead: a
    // legacy document with duplicate titles is precisely where a positional
    // guess is least defensible.
    guard candidates.filter({ $0.removeTitle == removal.title }).count == 1 else { return nil }
    return candidates.first {
      $0.removeIndex == removal.index && $0.removeTitle == removal.title
    }?.removeIndex
  }

  private var groups: [ShellSnapshot.DocumentOutline.Group] {
    model.snapshot.document?.groups ?? []
  }

  var body: some View {
    NavigationStack {
      Group {
        if groups.isEmpty {
          // The first outline lands a frame after the sheet opens; an empty
          // form would read as "this résumé has no content".
          ProgressView()
        } else {
          Form {
            // FIRST, and a standing state rather than a notice: a full disk
            // stays full. The web's toast is the only other warning and it
            // renders UNDER this sheet, so without this someone can type here,
            // watch the canvas behind the sheet update, and quit believing the
            // work was saved.
            if model.snapshot.document?.saveFailed == true {
              Section { DocumentSaveWarning() }
            }
            ForEach(groups) { group in
              // Captured where the rows are DRAWN. A drag is a wait and a swipe
              // tray is retained, and the revision echo below cannot stand in
              // for this: it is read live at the drop, and a variant swap is not
              // an adoption, so the counter never moves for one. The paths are
              // no help either — "workExperience" means the same thing in every
              // résumé.
              let renderedIn = model.snapshot.whereAmI
              Section(group.title) {
                // Split, not one ForEach with `.onMove`: attaching the move to
                // the whole group put a drag handle on Role, Company and Dates
                // too, and a handle that refuses to do anything is worse than
                // no handle. Only the rows backed by an array get one.
                ForEach(fixedFields(of: group)) { fieldRow($0) }
                if let listPath = group.listPath {
                  ForEach(listFields(of: group)) { fieldRow($0) }
                    .onMove { indices, destination in
                      // Indices are already list-relative here, so there is no
                      // offset arithmetic to get wrong. Swift moves within a
                      // list it was TOLD about and never builds an element path.
                      guard let from = indices.first else { return }
                      guard renderedIn == model.snapshot.whereAmI else {
                        staleAction = movedMessage
                        return
                      }
                      model.send("moveItem", [
                        "path": listPath,
                        "from": String(from),
                        "to": String(destination),
                        "revision": String(model.snapshot.document?.revision ?? -1),
                      ]) { ok in if !ok { staleAction = movedMessage } }
                    }
                    .onDelete { offsets in
                      // Same property as the move: list-relative, so the offset
                      // arithmetic that maps a ROW to an array element never
                      // happens here.
                      guard let at = offsets.first else { return }
                      guard renderedIn == model.snapshot.whereAmI else {
                        staleAction = movedMessage
                        return
                      }
                      model.send("removeItem", [
                        "path": listPath, "index": String(at),
                        "revision": String(model.snapshot.document?.revision ?? -1),
                      ]) { ok in if !ok { staleAction = movedMessage } }
                    }
                }
                if !group.addLabel.isEmpty, let listPath = group.listPath {
                  Button {
                    guard renderedIn == model.snapshot.whereAmI else {
                      staleAction = movedMessage
                      return
                    }
                    model.send("addItem", [
                      "path": listPath,
                      "revision": String(model.snapshot.document?.revision ?? -1),
                    ]) { ok in if !ok { staleAction = movedMessage } }
                  } label: {
                    Label(group.addLabel, systemImage: "plus.circle.fill")
                  }
                  // Otherwise edit mode offers to reorder and delete the Add
                  // button along with the rows it adds.
                  .deleteDisabled(true)
                  .moveDisabled(true)
                }
                if let removePath = group.removePath {
                  Button(role: .destructive) {
                    pendingRemoval = Removal(
                      path: removePath, index: group.removeIndex, title: group.removeTitle,
                      identity: group.removeId, renderedIn: model.snapshot.whereAmI
                    )
                  } label: {
                    // `.destructive` reddens the TITLE and leaves the symbol on
                    // the accent colour, so a red label sits beside a blue
                    // trash can. Tint the whole label instead.
                    Label("Delete \(group.removeTitle)", systemImage: "trash")
                      .foregroundStyle(.red)
                  }
                  .deleteDisabled(true)
                  .moveDisabled(true)
                }
              }
            }

            if let additions = model.snapshot.document?.additions, !additions.isEmpty {
              Section {
                ForEach(additions) { addition in
                  Button {
                    // The revision, like every other list command. Without it
                    // `requireCurrentDocument` refuses before adding anything,
                    // and these buttons are the ONLY way to create the first
                    // experience, education or section row — so the empty state
                    // had no way out of itself.
                    model.send("addItem", [
                      "path": addition.path,
                      "revision": String(model.snapshot.document?.revision ?? -1),
                    ]) { ok in if !ok { staleAction = movedMessage } }
                  } label: {
                    Label(addition.label, systemImage: "plus")
                  }
                  .deleteDisabled(true)
                  .moveDisabled(true)
                }
              }
            }
          }
        }
      }
      .navigationTitle("Edit resume")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .environment(\.editMode, .constant(.active))
    .onChange(of: focusedPath) { previous, current in
      // Drop the draft once focus leaves, so the field goes back to rendering
      // the store's value — including any normalisation the store applied.
      if let previous { drafts[previous] = nil }
      // TOLD TO THE SYNC GUARD, because it cannot see a `@FocusState`. The web
      // side asks the DOM for an active contentEditable, which is nothing here,
      // and `store.isDirty` goes false again after the 500 ms save debounce —
      // so pausing mid-word while still focused let a fetched résumé pass
      // `interruptsLiveEditing` and replace the document underneath this field.
      // The binding below keeps showing its draft, and the next keystroke sends
      // that pre-fetch value back as a fresh local edit, over what was adopted.
      model.send("setNativeEditing", [
        "scope": "document", "holder": "field", "value": current == nil ? "false" : "true",
      ])
    }
    // An alert rather than a `confirmationDialog`: iOS 26 renders the compact
    // dialog with NO visible Cancel and relies on a tap outside, which is a
    // poor bargain when the other button deletes a section of the résumé.
    .alert(
      "Delete \(pendingRemoval?.title ?? "")?",
      isPresented: .init(
        get: { pendingRemoval != nil },
        set: { if !$0 { pendingRemoval = nil } }
      )
    ) {
      Button("Delete", role: .destructive) {
        if let removal = pendingRemoval {
          if removal.renderedIn != model.snapshot.whereAmI {
            staleAction = movedMessage
          } else if let at = currentIndex(for: removal) {
            model.send("removeItem", [
              "path": removal.path,
              "index": String(at),
              "revision": String(model.snapshot.document?.revision ?? -1),
            ]) { ok in if !ok { staleAction = movedMessage } }
          } else {
            staleAction = movedMessage
          }
        }
        pendingRemoval = nil
      }
      Button("Cancel", role: .cancel) { pendingRemoval = nil }
    } message: {
      Text("This cannot be undone from here.")
    }
    .alert(
      "That moved",
      isPresented: Binding(
        get: { staleAction != nil },
        set: { if !$0 { staleAction = nil } }
      ),
      presenting: staleAction
    ) { _ in
      Button("OK", role: .cancel) {}
    } message: { message in
      Text(message)
    }
  }

  @ViewBuilder
  private func fieldRow(_ field: ShellSnapshot.DocumentOutline.Field) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(field.label)
        .font(.caption)
        .foregroundStyle(.secondary)
      if field.multiline {
        TextField(field.label, text: binding(for: field), axis: .vertical)
          .lineLimit(2...8)
          .focused($focusedPath, equals: field.path)
      } else {
        TextField(field.label, text: binding(for: field))
          .focused($focusedPath, equals: field.path)
      }
    }
    .padding(.vertical, 2)
  }

  /// The rows above the list: a section's heading, a role's title/company/dates.
  private func fixedFields(
    of group: ShellSnapshot.DocumentOutline.Group
  ) -> [ShellSnapshot.DocumentOutline.Field] {
    guard group.listPath != nil else { return group.fields }
    return Array(group.fields.prefix(group.listOffset))
  }

  /// The rows backed by the array at `group.listPath`.
  private func listFields(
    of group: ShellSnapshot.DocumentOutline.Group
  ) -> [ShellSnapshot.DocumentOutline.Field] {
    guard group.listPath != nil else { return [] }
    return Array(group.fields.dropFirst(group.listOffset))
  }

  private func binding(for field: ShellSnapshot.DocumentOutline.Field) -> Binding<String> {
    Binding(
      get: {
        // The focus rule. While this field has focus its draft wins, so an
        // inbound snapshot cannot move the cursor mid-word.
        focusedPath == field.path ? (drafts[field.path] ?? field.value) : field.value
      },
      set: { newValue in
        drafts[field.path] = newValue
        // Write on every keystroke rather than on blur: the canvas behind the
        // sheet is the point of the app, and it should track what is typed.
        // `path` is echoed back exactly as received — never built here.
        model.send("setField", ["path": field.path, "value": newValue])
      }
    )
  }
}

// MARK: - Reasoning timeline

/// One line of the model's reasoning summary.
struct ReasoningStep: Identifiable, Equatable {
  let id: Int
  let content: String
  let isFirst: Bool
  let isLast: Bool
  /// The terminal "Done" row, shown only once reasoning has settled.
  var isDone: Bool = false
}

/// Strip `**Title**` markers from a reasoning summary.
///
/// Ported from Olia (`Screens/Chat/ReasoningTimelineView.swift`), which learned
/// the shapes the hard way: models emit `**Title**` on one line, but the closing
/// `**` often lands on the NEXT line, and sometimes appears orphaned on its own.
/// All three have to go or the timeline shows asterisks as content.
func stripReasoningTitles(_ content: String) -> String {
  var result = content
  let patterns: [(String, NSRegularExpression.Options)] = [
    (#"\*\*[^*]+\*\*"#, []),          // **Title** on one line
    (#"\*\*[^*\n]+\n\*\*"#, []),      // **Title\n**
    (#"^\*\*$"#, [.anchorsMatchLines]) // an orphaned closing **
  ]
  for (pattern, options) in patterns {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
    result = regex.stringByReplacingMatches(
      in: result, options: [], range: NSRange(result.startIndex..., in: result), withTemplate: ""
    )
  }
  return result
}

/// A vertical timeline of reasoning steps: a dot per line, joined by rules.
///
/// Ported from Olia. The rules are drawn as `Rectangle`s above and below each
/// dot rather than as one line behind the column, which is what lets a row size
/// itself to its own text without the connector stretching or breaking.
struct ReasoningTimeline: View {
  let content: String
  /// Fade-and-rise rows in as they arrive. Off for settled history, where every
  /// row would animate at once on open.
  var animateAppearance: Bool = false

  private var steps: [ReasoningStep] {
    let lines = stripReasoningTitles(content)
      .components(separatedBy: .newlines)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    return lines.enumerated().map { index, line in
      ReasoningStep(
        id: index, content: line,
        isFirst: index == 0, isLast: index == lines.count - 1
      )
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(steps) { step in
        ReasoningTimelineRow(step: step, animateAppearance: animateAppearance)
      }
    }
    .padding(.vertical, 8)
  }
}

struct ReasoningTimelineRow: View {
  let step: ReasoningStep
  var animateAppearance: Bool = false

  @State private var hasAppeared = false

  var body: some View {
    HStack(alignment: step.isDone ? .center : .top, spacing: 12) {
      ZStack(alignment: step.isDone ? .center : .top) {
        if !step.isFirst {
          Rectangle()
            .fill(Color.secondary.opacity(0.3))
            .frame(width: 1, height: 20)
            .offset(y: -20)
        }
        if !step.isLast {
          Rectangle()
            .fill(Color.secondary.opacity(0.3))
            .frame(width: 1)
            .frame(maxHeight: .infinity)
            .padding(.top, 20)
        }
        if step.isDone {
          Image(systemName: "checkmark.circle")
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.primary)
        } else {
          Circle()
            .fill(Color.secondary)
            .frame(width: 8, height: 8)
            .padding(.top, 6)
        }
      }
      .frame(width: 16)

      Text(step.content)
        .font(.subheadline)
        .fontWeight(step.isDone ? .medium : .regular)
        .foregroundStyle(step.isDone ? .primary : .secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, step.isLast ? 0 : 20)
    }
    .opacity(animateAppearance ? (hasAppeared ? 1 : 0) : 1)
    .offset(y: animateAppearance ? (hasAppeared ? 0 : 6) : 0)
    .onAppear {
      guard animateAppearance, !hasAppeared else { return }
      withAnimation(.easeOut(duration: 0.3)) { hasAppeared = true }
    }
  }
}

/// Find the last `**Title**` in a reasoning summary.
///
/// Ported from Olia. Models emit section titles as bold markdown, and the
/// closing `**` frequently lands on the NEXT line — hence the second pattern.
/// This is what the inline indicator shows while reasoning streams.
func findLastTitle(in content: String) -> String? {
  for pattern in [#"\*\*([^*]+)\*\*"#, #"\*\*([^*\n]+)\n\*\*"#] {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
    let range = NSRange(content.startIndex..., in: content)
    if let last = regex.matches(in: content, range: range).last,
       let titleRange = Range(last.range(at: 1), in: content) {
      return String(content[titleRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
  return nil
}

/// Strip inline markdown for a one-line preview.
private func stripMarkdownForPreview(_ text: String) -> String {
  var result = text
  let replacements: [(String, String)] = [
    ("`(.+?)`", "$1"),
    ("\\[(.+?)\\]\\(.+?\\)", "$1"),
    ("^#{1,6}\\s*", ""),
    ("\\*\\*\\*(.+?)\\*\\*\\*", "$1"),
    ("\\*\\*(.+?)\\*\\*", "$1"),
    ("\\*([^*\\n]+)\\*", "$1"),
    ("^[\\p{Pd}\\*]\\s+", ""),
  ]
  for (pattern, template) in replacements {
    result = result.replacingOccurrences(
      of: pattern, with: template, options: .regularExpression
    )
  }
  return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Shimmer, for text that is still arriving. Ported from Olia.
private struct Shimmer: ViewModifier {
  let active: Bool
  @State private var start = UnitPoint(x: -1, y: 0.5)
  @State private var end = UnitPoint(x: 0, y: 0.5)

  func body(content: Content) -> some View {
    if active {
      content
        .mask(
          LinearGradient(
            stops: [
              .init(color: .black.opacity(0.4), location: 0),
              .init(color: .black, location: 0.3),
              .init(color: .black, location: 0.7),
              .init(color: .black.opacity(0.4), location: 1),
            ],
            startPoint: start, endPoint: end
          )
        )
        .onAppear {
          withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) {
            start = UnitPoint(x: 1, y: 0.5)
            end = UnitPoint(x: 2, y: 0.5)
          }
        }
    } else {
      content
    }
  }
}

extension View {
  func shimmering(active: Bool = true) -> some View { modifier(Shimmer(active: active)) }
}

/// The one-line, tappable reasoning summary — Olia's shape, and the thing this
/// port originally got wrong by rendering the timeline inline.
///
/// While the model is thinking it shows the CURRENT section title (the last
/// `**Title**` in the completed lines) and shimmers; once the answer starts it
/// settles to "Thought process". The timeline lives in the sheet behind it.
///
/// The chevron is the affordance, so it appears ONLY once there is something to
/// open — before the first summary line arrives this is an inert "Thinking…"
/// label, not a button that opens an empty sheet.
struct InlineReasoningIndicator: View {
  let reasoning: String
  /// True while the model is still thinking: reasoning may still be arriving and
  /// the answer has not started. Goes false the moment the first content token
  /// lands, which is what stops the shimmer and settles the label.
  let isStreaming: Bool
  @State private var showSheet = false

  private var hasReasoning: Bool {
    !reasoning.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Only COMPLETE lines are considered, so a half-streamed title never shows.
  private var summary: String {
    guard isStreaming, let lastNewline = reasoning.lastIndex(of: "\n") else { return "" }
    let complete = String(reasoning[...lastNewline])
    if let title = findLastTitle(in: complete) { return title }
    let lines = complete.components(separatedBy: .newlines)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return stripMarkdownForPreview(lines.last ?? "")
  }

  private var displayText: String {
    if !isStreaming { return "Thought process" }
    return summary.isEmpty ? "Thinking…" : summary
  }

  var body: some View {
    Button { if hasReasoning { showSheet = true } } label: {
      HStack(spacing: 6) {
        Text(displayText).font(.subheadline).lineLimit(1)
        if hasReasoning {
          Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
        }
      }
      .foregroundStyle(.secondary)
      .shimmering(active: isStreaming)
    }
    .buttonStyle(.plain)
    .disabled(!hasReasoning)
    .sheet(isPresented: $showSheet) {
      ReasoningSheet(content: reasoning, isStreaming: isStreaming)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
    .accessibilityLabel(displayText)
    .accessibilityHint(hasReasoning ? "Opens the model's thought process" : "")
  }
}

/// The reasoning timeline, in a sheet.
///
/// A `List` rather than a `ScrollView`: on iOS 26 a ScrollView inside a sheet
/// picks up a green background tint. Olia hit that and the workaround is
/// carried over with it.
struct ReasoningSheet: View {
  let content: String
  let isStreaming: Bool

  private var visibleLines: [String] {
    let source: String
    if isStreaming {
      // Only complete lines while streaming, so a row never appears half-written.
      guard let lastNewline = content.lastIndex(of: "\n") else { return [] }
      source = String(content[...lastNewline])
    } else {
      source = content
    }
    return stripReasoningTitles(source)
      .components(separatedBy: .newlines)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }

  private var steps: [ReasoningStep] {
    let lines = visibleLines
    let showDone = !isStreaming && !lines.isEmpty
    var result = lines.enumerated().map { index, line in
      ReasoningStep(
        id: index, content: line,
        isFirst: index == 0,
        isLast: !showDone && index == lines.count - 1,
        isDone: false
      )
    }
    if showDone {
      result.append(ReasoningStep(
        id: result.count, content: "Done", isFirst: result.isEmpty, isLast: true, isDone: true
      ))
    }
    return result
  }

  var body: some View {
    NavigationStack {
      List {
        ForEach(steps) { step in
          ReasoningTimelineRow(step: step, animateAppearance: isStreaming)
            .listRowInsets(EdgeInsets(top: 0, leading: 28, bottom: 0, trailing: 28))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
      }
      .listStyle(.inset)
      .environment(\.defaultMinListRowHeight, 0)
      .navigationTitle(isStreaming ? (findLastTitle(in: content) ?? "Thinking…") : "Thought process")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

// MARK: - Markdown

/// Block-level markdown for a chat reply, ported from Olia
/// (`Screens/Chat/MarkdownText.swift`).
///
/// The models write in markdown — headings, bullets, numbered steps, the
/// occasional fenced block — and rendering that as one flat `Text` puts literal
/// `##` and `- ` in front of the user. SwiftUI's `Text` handles INLINE markdown
/// on its own (via `LocalizedStringKey`: bold, italic, code, links) but has no
/// notion of blocks, so this splits the text into blocks and lets `Text` finish
/// each one.
///
/// A hand-rolled parser rather than `AttributedString(markdown:)`: that one
/// throws on the half-formed markdown a stream produces mid-token, and it has no
/// block layout either.
struct MarkdownText: View {
  let text: String
  var spacing: CGFloat = 8
  /// Fade-and-rise each block in as it arrives, the way the reasoning timeline
  /// does its rows. Off for settled history, where every block would animate at
  /// once when the transcript scrolled into view.
  var isStreaming: Bool = false

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(_ text: String, spacing: CGFloat = 8, isStreaming: Bool = false) {
    self.text = text
    self.spacing = spacing
    self.isStreaming = isStreaming
  }

  var body: some View {
    let blocks = Self.parse(text)
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
        blockView(block)
          .transition(arrival)
          .animation(arrivalAnimation(at: index), value: block.contentHash)
      }
    }
    .animation(isStreaming ? .easeOut(duration: 0.25) : .easeOut(duration: 0.3), value: blocks.count)
  }

  private var arrival: AnyTransition {
    guard isStreaming, !reduceMotion else { return .opacity }
    return .asymmetric(insertion: .opacity.combined(with: .offset(y: 4)), removal: .opacity)
  }

  /// Stagger the first few blocks so a burst that lands in one update still
  /// reads as arriving rather than appearing. Capped, or a long reply would
  /// queue an ever-growing delay.
  private func arrivalAnimation(at index: Int) -> Animation {
    guard isStreaming else { return .easeOut(duration: 0.3) }
    guard !reduceMotion else { return .easeOut(duration: 0.1) }
    return .easeOut(duration: 0.25).delay(min(Double(index) * 0.05, 0.15))
  }

  @ViewBuilder
  private func blockView(_ block: Block) -> some View {
    switch block.kind {
    case let .heading(level, content):
      Text(LocalizedStringKey(content))
        .font(level == 1 ? .title3 : level == 2 ? .headline : .subheadline)
        .fontWeight(.semibold)
        .padding(.top, 2)
    case let .paragraph(content):
      Text(LocalizedStringKey(content))
        .fixedSize(horizontal: false, vertical: true)
    case let .list(items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(items) { item in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(item.marker).fontWeight(.semibold).monospacedDigit()
            Text(LocalizedStringKey(item.content))
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.leading, CGFloat(item.indent) * 16)
        }
      }
    case let .code(content):
      // Horizontally scrollable: a wrapped code line is unreadable, and a
      // clipped one silently hides the end of a command.
      ScrollView(.horizontal, showsIndicators: false) {
        Text(content)
          .font(.system(.footnote, design: .monospaced))
          .padding(10)
      }
      .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 8))
    case let .quote(content):
      HStack(spacing: 10) {
        Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 3)
        Text(LocalizedStringKey(content))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    case .rule:
      Divider()
    }
  }

  // MARK: parsing

  struct Block: Identifiable {
    let id: Int
    let kind: Kind

    /// Changes when this block's text does, which is what the arrival animation
    /// keys on — a block that grew re-animates, its neighbours do not.
    var contentHash: Int {
      switch kind {
      case let .heading(_, content): return content.hashValue
      case let .paragraph(content): return content.hashValue
      case let .list(items): return items.map(\.content).joined().hashValue
      case let .code(content): return content.hashValue
      case let .quote(content): return content.hashValue
      case .rule: return 0
      }
    }

    enum Kind {
      case heading(level: Int, content: String)
      case paragraph(String)
      case list([Item])
      case code(String)
      case quote(String)
      case rule
    }

    struct Item: Identifiable {
      let id: Int
      let content: String
      let indent: Int
      let marker: String
    }
  }

  /// Split markdown into blocks. Consecutive list lines coalesce into one list
  /// so the rows share a container and line up; everything else is one block per
  /// line, which is also what makes a streaming reply grow a block at a time
  /// instead of re-laying out the whole reply on every token.
  static func parse(_ text: String) -> [Block] {
    var blocks: [Block] = []
    var items: [Block.Item] = []
    var codeLines: [String] = []
    var inCode = false
    var nextID = 0

    func add(_ kind: Block.Kind) {
      blocks.append(Block(id: nextID, kind: kind))
      nextID += 1
    }
    func flushList() {
      guard !items.isEmpty else { return }
      add(.list(items))
      items = []
    }

    for line in text.components(separatedBy: .newlines) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)

      if trimmed.hasPrefix("```") {
        if inCode {
          add(.code(codeLines.joined(separator: "\n")))
          codeLines = []
        } else {
          flushList()
        }
        inCode.toggle()
        continue
      }
      if inCode {
        codeLines.append(line)
        continue
      }

      if trimmed.count >= 3, Set(trimmed).isSubset(of: ["-", "*", "_"]), Set(trimmed).count == 1 {
        flushList()
        add(.rule)
        continue
      }
      if trimmed.hasPrefix("#") {
        flushList()
        let level = trimmed.prefix(while: { $0 == "#" }).count
        let content = String(trimmed.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        add(.heading(level: min(level, 3), content: content))
        continue
      }
      if trimmed.hasPrefix(">") {
        flushList()
        add(.quote(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)))
        continue
      }
      if let item = listItem(line, id: items.count) {
        items.append(item)
        continue
      }
      if !trimmed.isEmpty {
        flushList()
        add(.paragraph(trimmed))
      }
    }

    // An unterminated fence is the normal state mid-stream, not an error: show
    // what has arrived rather than dropping it until the closing ``` lands.
    if inCode, !codeLines.isEmpty { add(.code(codeLines.joined(separator: "\n"))) }
    flushList()
    return blocks
  }

  private static func listItem(_ line: String, id: Int) -> Block.Item? {
    var spaces = 0
    for char in line {
      if char == " " { spaces += 1 } else if char == "\t" { spaces += 4 } else { break }
    }
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let indent = spaces / 2

    for bullet in ["- ", "* ", "+ "] where trimmed.hasPrefix(bullet) {
      let content = String(trimmed.dropFirst(2)).trimmingCharacters(in: .whitespaces)
      return Block.Item(id: id, content: content, indent: indent, marker: "•")
    }
    if let space = trimmed.firstIndex(of: " ") {
      let prefix = trimmed[..<space]
      if prefix.hasSuffix(".") || prefix.hasSuffix(")"), Int(prefix.dropLast()) != nil {
        let content = String(trimmed[space...]).trimmingCharacters(in: .whitespaces)
        return Block.Item(id: id, content: content, indent: indent, marker: String(prefix))
      }
    }
    return nil
  }
}

// MARK: - Composer

/// Reasoning effort, mirroring `REASONING_OPTIONS` in
/// `src/components/chat/ChatComposer.jsx` — the same four levels and the same
/// descriptions, so the phone and the desktop offer the same setting.
private let reasoningLevels: [(value: String, label: String, detail: String)] = [
  ("none", "Off", "Fastest responses"),
  ("low", "Low", "Quick thinking"),
  ("medium", "Medium", "Balanced"),
  ("high", "High", "Deep analysis"),
]

/// The message composer: one rounded card holding the field, the model and
/// reasoning-effort controls, and Send — the arrangement ChatGPT and Claude both
/// use on iOS.
///
/// The controls live HERE rather than in the navigation bar because the model in
/// use is part of asking the question, not a property of the conversation: on a
/// fresh chat the bar showed a title and nothing about the model, so there was
/// no way to see what you were about to talk to. The bar's centre is the chat's
/// own title and management menu instead.
///
/// It is one glass surface, not a bar: the transcript scrolls UNDER it (the
/// sheet mounts this as a `safeAreaInset`), which is the whole point of putting
/// glass there.
private struct ChatComposer: View {
  @Binding var text: String
  let isSending: Bool
  let models: [ShellSnapshot.ChatView.ModelOption]
  let currentModel: String
  let reasoningEffort: String
  let reasoningSupported: Bool
  /// Bumped on send. See `fieldGeneration` below — this is what makes a
  /// multi-line field collapse back to one line.
  let generation: Int
  let onSend: () -> Void
  let onStop: () -> Void
  let onSelectModel: (String) -> Void
  let onSetReasoning: (String) -> Void

  @FocusState private var isFocused: Bool

  private let characterLimit = 4000

  private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var canSend: Bool { !trimmed.isEmpty && !isSending && text.count <= characterLimit }
  private var isNearLimit: Bool { text.count > characterLimit * 80 / 100 }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      TextField("Ask about this resume", text: $text, axis: .vertical)
        .textFieldStyle(.plain)
        .focused($isFocused)
        .disabled(isSending)
        .lineLimit(1...6)
        .padding(.horizontal, 6)
        .padding(.top, 6)
        // A vertical-axis TextField is a UITextView underneath, and clearing its
        // binding does not invalidate the intrinsic height it grew to — so after
        // sending a multi-line message the composer stayed tall until something
        // unrelated forced a layout pass. Changing the identity rebuilds it, at
        // the only moment where losing the field's internal state is what we
        // want anyway.
        .id(generation)

      HStack(spacing: 8) {
        modelButton
        if reasoningSupported { effortButton }
        Spacer(minLength: 0)
        if isNearLimit {
          Text("\(text.count)/\(characterLimit)")
            .font(.caption)
            .foregroundStyle(text.count > characterLimit ? Color.red : Color.secondary)
        }
        trailingButton
      }
    }
    .padding(.horizontal, ChatComposer.innerPadding)
    .padding(.vertical, ChatComposer.innerPadding)
    .modifier(ComposerSurface())
    .padding(.horizontal, 12)
    // No bottom padding: `safeAreaInset` already holds the bar clear of the home
    // indicator, and anything on top of that reads as the bar floating.
    .padding(.bottom, 0)
  }

  /// Concentricity, the reason these three numbers are named rather than
  /// sprinkled: a nested shape reads as belonging to its container only when
  /// their curves share a centre, which means the inner radius has to be the
  /// outer radius minus the padding between them. 26 − 8 = 18, and a capsule
  /// 36pt tall has exactly an 18pt radius. Change one, change all three.
  static let surfaceRadius: CGFloat = 26
  static let innerPadding: CGFloat = 8
  static let controlHeight: CGFloat = 36

  /// Grouped the way the web picker groups them (by provider), preserving the
  /// order the catalogue arrived in rather than sorting — the featured models
  /// lead it deliberately.
  private var groupedModels: [(group: String, options: [ShellSnapshot.ChatView.ModelOption])] {
    var order: [String] = []
    var byGroup: [String: [ShellSnapshot.ChatView.ModelOption]] = [:]
    for option in models {
      let key = option.group.isEmpty ? "Models" : option.group
      if byGroup[key] == nil { order.append(key) }
      byGroup[key, default: []].append(option)
    }
    return order.map { ($0, byGroup[$0] ?? []) }
  }

  private var currentModelLabel: String {
    models.first { $0.id == currentModel }?.label ?? "Model"
  }

  private var modelButton: some View {
    Menu {
      ForEach(groupedModels, id: \.group) { group in
        Section(group.group) {
          ForEach(group.options) { option in
            Button { onSelectModel(option.id) } label: {
              if option.id == currentModel {
                Label(option.label, systemImage: "checkmark")
              } else {
                Text(option.label)
              }
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(currentModelLabel).lineLimit(1)
        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
      }
      .modifier(ComposerChip())
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Model: \(currentModelLabel)")
  }

  private var effortLabel: String {
    reasoningLevels.first { $0.value == reasoningEffort }?.label ?? "Medium"
  }

  private var effortButton: some View {
    Menu {
      Section("Reasoning effort") {
        ForEach(reasoningLevels, id: \.value) { level in
          Button { onSetReasoning(level.value) } label: {
            if level.value == reasoningEffort {
              Label("\(level.label) — \(level.detail)", systemImage: "checkmark")
            } else {
              Text("\(level.label) — \(level.detail)")
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "brain")
        Text(effortLabel)
      }
      .modifier(ComposerChip())
    }
    .buttonStyle(.plain)
    .menuOrder(.fixed)
    .accessibilityLabel("Reasoning effort: \(effortLabel)")
  }

  @ViewBuilder
  private var trailingButton: some View {
    if isSending {
      Button(action: onStop) {
        Image(systemName: "stop.fill")
          .font(.system(size: 14, weight: .semibold))
          .modifier(ComposerSendStyle(enabled: true))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Stop")
    } else {
      Button {
        guard canSend else { return }
        onSend()
        isFocused = false
      } label: {
        Image(systemName: "arrow.up")
          .font(.system(size: 16, weight: .semibold))
          .modifier(ComposerSendStyle(enabled: canSend))
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("Send")
    }
  }
}

/// The composer's own surface: liquid glass where it exists, a material before
/// it. Interactive glass on 26 so it responds to touch the way the system's own
/// input bars do.
private struct ComposerSurface: ViewModifier {
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: ChatComposer.surfaceRadius, style: .continuous)
    // `.regular`, NOT `.regular.interactive()`.
    //
    // Interactive glass "reacts to touch and pointer events", which means the
    // shape claims touches. This shape is not a control: it is the BACKING of
    // one, and every control on it — the field, the two chips, send — is its
    // own button with its own interactive glass. Nothing presses the backing,
    // so nothing should be listening to it.
    //
    // It is also the best candidate for a bug I could not reproduce. The model
    // and reasoning menus open upward out of chips on this surface, and on a
    // device their lowest rows cannot be selected by a direct press — but CAN
    // be if you press a row higher up and drag down onto them. That difference
    // says the touch-DOWN never reaches the menu, while a gesture the menu
    // already owns tracks fine: a hit-testing claim, not a drawing one. This
    // backing is the thing in that region with a claim to drop.
    //
    // Nothing about the resting appearance changes: same material, same shape,
    // same blur. UNVERIFIED — the simulator selects those rows under every
    // synthetic touch, including real HID paths, so the failure only exists
    // under a finger.
    content.glassEffect(.regular, in: shape)
  }
}

/// One capsule of the bottom bar.
///
/// 44pt and `.regular.interactive()`, matching what the system bottom bar drew
/// before this replaced it — the bar moved into our hands so the zoom control
/// could morph, not so it could look different.
private struct BarCapsule: ViewModifier {
  func body(content: Content) -> some View {
    let sized = content
      .padding(.horizontal, 20)
      .frame(height: 44)

    sized.glassEffect(.regular.interactive(), in: .capsule)
  }
}

/// The model and effort chips.
///
/// The capsule is part of the LABEL rather than a button style's background,
/// which is what fixes the sizing: as a `.bordered` Menu the pill was sized on
/// one pass and the text on another, so a label that changed — "Model" becoming
/// "Claude Sonnet 4.6" when the catalogue arrives — briefly overflowed its own
/// pill. Drawn behind the label, the shape cannot be out of date.
private struct ComposerChip: ViewModifier {
  func body(content: Content) -> some View {
    let base = content
      .font(.subheadline)
      .foregroundStyle(.primary)
      .lineLimit(1)
      .padding(.horizontal, 12)
      .frame(height: ChatComposer.controlHeight)

    base.glassEffect(.regular.interactive(), in: .capsule)
  }
}

/// Send/Stop: the same 36pt as the chips beside it, drawn rather than left to
/// `.glassProminent`.
///
/// The button style would add its own padding around whatever frame it was
/// given, which made this the tallest thing in the row — and since the row
/// centres its contents, that pushed the chips up off the card's bottom edge and
/// broke the concentricity they were sized for. One height for every control in
/// the row is what keeps that arithmetic true.
private struct ComposerSendStyle: ViewModifier {
  let enabled: Bool

  func body(content: Content) -> some View {
    let sized = content
      .foregroundStyle(enabled ? Color.white : Color.secondary)
      .frame(width: ChatComposer.controlHeight, height: ChatComposer.controlHeight)

    if enabled {
      sized.glassEffect(.regular.tint(.accentColor).interactive(), in: .circle)
    } else {
      // Plain, not glass: a disabled Send should not look tappable. The
      // accent-coloured arm of this branch went with the iOS-26 guard — inside
      // the `else`, `enabled` is false by construction.
      sized.background(.quaternary, in: .circle)
    }
  }
}

// MARK: - Chat

/// The native chat sheet, shaped after Olia's.
///
/// A second VIEW of the engine in `src/components/chat/useChat.js`, not a second
/// engine: every action dispatches an event the React panel handles, so
/// threading, streaming, aborting and persistence stay in the one implementation
/// that already works on desktop.
///
/// Still short of the web panel on purpose — no model picker, no context chips,
/// and no applying the AI's proposed CHANGES. Applying one runs the diff engine
/// and opens a review session; a partial native version of that is how someone
/// accepts an edit they never saw.
/// "These messages are not on disk." Worded like `JobsSaveWarning`, and for the
/// same reason: a full disk stays full, so this is a standing state rather than
/// a one-shot notice.
private struct ChatSaveWarning: View {
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      VStack(alignment: .leading, spacing: 2) {
        Text("Not being saved").font(.subheadline.weight(.semibold))
        Text("Storage is full, so these messages are not on disk. Free up space — reloading now would lose them.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .background(.bar)
  }
}

private struct ChatSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var draft = ""
  @State private var showReview = false
  @State private var showRename = false
  @State private var showDeleteConfirm = false
  /// The chat the delete prompt was raised for. See the dialog's own comment.
  @State private var pendingDeleteThread: String?
  /// The chat the rename alert was raised for, for the same reason.
  @State private var pendingRenameThread: String?
  /// …and the WORKSPACE either was raised in.
  ///
  /// A thread id is unique only within a workspace, and importing one backup
  /// into two produces the same ids in both. A tombstone for the open workspace
  /// reloads the webview underneath this sheet without closing it, so checking
  /// only that the id still exists finds the replacement workspace's unrelated
  /// chat and renames or deletes THAT. Only one of these prompts can be up at a
  /// time, so one field serves both.
  @State private var pendingThreadFrom: ShellSnapshot.Where?
  /// Unsent text, per chat. A draft belongs to the conversation it was written
  /// for; see the switch handler.
  @State private var drafts: [String: String] = [:]
  @State private var renameDraft = ""
  /// Bumped on every send; the composer's field is keyed on it. See the comment
  /// on the `.id` there.
  @State private var fieldGeneration = 0
  /// The workspace the visible draft was written in, and whether a send was
  /// refused because it changed. See `sendDraft`.
  @State private var composedIn: ShellSnapshot.Where?
  @State private var staleWorkspace = false

  private var chat: ShellSnapshot.ChatView? { model.snapshot.chat }

  var body: some View {
    NavigationStack {
      Group {
        if let chat, !chat.configured {
          ContentUnavailableView(
            "No API key",
            systemImage: "key",
            description: Text("Add an OpenRouter key in Settings to use the assistant.")
          )
        } else {
          transcript
            // PINNED, not a row at the top of the transcript. The transcript
            // scrolls to the newest message, so a banner among the messages
            // would be off screen at the exact moment it started applying — and
            // the web's global toast, which is what says this on desktop,
            // renders UNDER this sheet.
            .safeAreaInset(edge: .top) {
              if chat?.saveFailed == true { ChatSaveWarning() }
            }
            // An INSET, not a row in a VStack: the transcript keeps the full
            // height of the sheet and scrolls under the composer, so text passes
            // behind the glass instead of stopping at an opaque band above it.
            .safeAreaInset(edge: .bottom) { composer }
        }
      }
      .navigationBarTitleDisplayMode(.inline)
      // One tap on the transition from thinking to answering — the moment the
      // user has been waiting through. Mounted on the sheet, not on a message:
      // per-message it would fire once per row in the transcript. `nil` on the
      // way back suppresses a second tap when the finished stream row is
      // replaced by the committed message.
      .sensoryFeedback(trigger: responseStarted) { _, started in
        started ? .impact(weight: .light) : nil
      }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { threadsMenu }
        ToolbarItem(placement: .principal) { titleMenu }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      // A DRAFT BELONGS TO ITS THREAD. The guard below stops a REMOTE thread
      // list from moving out from under unsent text, and says nothing about the
      // person changing chats themselves — one `draft` for the whole sheet meant
      // switching carried the text along, and Send posted words written for one
      // conversation into another. Parked under the chat being left and restored
      // for the chat being opened, rather than cleared: text someone typed is
      // work, and discarding it to protect it is the trade this whole guard
      // exists to avoid.
      .onChange(of: currentThread?.id) { previous, current in
        if let previous { drafts[previous] = draft }
        draft = current.flatMap { drafts[$0] } ?? ""
        // The field is keyed on this; without the bump it keeps showing the
        // text of the chat that was just left.
        fieldGeneration += 1
      }
      // UNSENT TEXT IS WORK, and it is Swift state — `threadHolderBusy` asks the
      // React hook, which can only see a stream in flight. So a thread list
      // adopted from another device could select a different current thread
      // underneath this draft, and Send would post words written for one
      // conversation into another. Reported while the field holds anything, and
      // released when it is emptied — including by `sendDraft`, which clears it.
      // EVERY draft, not just the one on screen. Switching chats parks the
      // outgoing text in `drafts` and puts B's (usually empty) into `draft` —
      // which released the only hold, so a fetched thread list could delete A
      // while its unsent text existed nowhere but Swift. A then vanishes from
      // the menu, the parked text is unreachable, and closing the sheet
      // destroys it.
      //
      // I argued against this when the per-chat drafts went in, on the grounds
      // that a parked draft never expires and would hold the guard for ever.
      // That was wrong: the hold cannot outlive the sheet, because the sheet's
      // own close blanket-releases this scope. It is bounded by a screen the
      // person is looking at.
      .onChange(of: draft) { _, text in
        // Recorded as soon as there IS something to send, and left alone after
        // that: the workspace it was written in does not change because more
        // was typed.
        if composedIn == nil, !text.isEmpty { composedIn = model.snapshot.whereAmI }
        if text.isEmpty, drafts.isEmpty { composedIn = nil }
      }
      .modifier(NoticeAlert(
        title: "That workspace is gone",
        isPresented: $staleWorkspace,
        hint: "Your workspace changed on another device, so this was not sent. Copy the text, then reopen the chat."
      ))
      .onChange(of: hasUnsentText) { _, unsent in
        model.send("setNativeEditing", [
          "scope": "chat", "holder": "composer", "value": unsent ? "true" : "false",
        ])
      }
      .sheet(isPresented: $showReview) {
        ChangeReviewSheet(model: model)
      }
      .alert("Rename chat", isPresented: $showRename) {
        TextField("Name", text: $renameDraft)
        Button("Cancel", role: .cancel) {
          pendingRenameThread = nil
          pendingThreadFrom = nil
        }
        Button("Rename") {
          let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !title.isEmpty, let id = pendingRenameThread,
                pendingThreadFrom == model.snapshot.whereAmI,
                chat?.threads.contains(where: { $0.id == id }) == true else {
            pendingRenameThread = nil
            pendingThreadFrom = nil
            return
          }
          model.send("chatRenameThread", ["id": id, "title": title])
          pendingRenameThread = nil
          pendingThreadFrom = nil
        }
      }
      .confirmationDialog(
        "Delete this chat?", isPresented: $showDeleteConfirm, titleVisibility: .visible
      ) {
        Button("Delete", role: .destructive) {
          // THE CHAT THE PROMPT NAMED, pinned when it opened. Resolving
          // `currentThread` here read whatever was current at the moment of the
          // tap, and with an empty composer and no stream in flight
          // `threadHolderBusy` is false — so a thread list adopted from another
          // device can remove this chat and select a replacement while the
          // prompt is up, and Delete then permanently removed a conversation
          // nobody named.
          guard let id = pendingDeleteThread,
                pendingThreadFrom == model.snapshot.whereAmI,
                chat?.threads.contains(where: { $0.id == id }) == true else {
            pendingDeleteThread = nil
            pendingThreadFrom = nil
            return
          }
          model.send("chatDeleteThread", ["id": id])
          pendingDeleteThread = nil
          pendingThreadFrom = nil
        }
        Button("Cancel", role: .cancel) {
          pendingDeleteThread = nil
          pendingThreadFrom = nil
        }
      } message: {
        Text("The messages in it are removed. Your resume is not affected.")
      }
    }
  }

  /// The composer, extracted from the `safeAreaInset` rather than written
  /// inline — pinning the two option menus tipped this view's expression over
  /// the type-checker's budget, and a property has room for a `let`.
  ///
  /// `renderedIn` is read HERE, at the render, not inside the callbacks. Those
  /// menus keep the callback they were presented with, so reading the workspace
  /// when the selection is made reads whatever replaced it — the check would
  /// pass against exactly the state it exists to catch. An empty composer holds
  /// no chat guard, so a tombstone can land with one of these menus open.
  private var composer: some View {
    let renderedIn = model.snapshot.whereAmI
    return ChatComposer(
      text: $draft,
      isSending: chat?.loading ?? false,
      models: chat?.models ?? [],
      currentModel: chat?.currentModel ?? "",
      reasoningEffort: chat?.reasoningEffort ?? "medium",
      reasoningSupported: chat?.reasoningSupported ?? false,
      generation: fieldGeneration,
      onSend: sendDraft,
      onStop: { model.send("chatStop") },
      onSelectModel: { id in
        guard renderedIn == model.snapshot.whereAmI else { return }
        model.send("chatSetModel", ["id": id])
      },
      onSetReasoning: { value in
        guard renderedIn == model.snapshot.whereAmI else { return }
        model.send("chatSetReasoning", ["value": value])
      }
    )
  }

  // MARK: transcript

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 20) {
          ForEach(chat?.messages ?? []) { message in
            messageView(message).id(message.id)
          }
          if let thinking = chat?.thinking, !thinking.isEmpty {
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text(thinking).font(.subheadline).foregroundStyle(.secondary)
            }
            .id("thinking")
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      // Keyed on the message COUNT, not the last message's text. Keying it on
      // the text scrolled on every token, which took the scroll away from anyone
      // who had scrolled up to re-read something while the answer streamed. A
      // new turn is worth following; a growing one is the user's to follow.
      .onChange(of: chat?.messages.count ?? 0) { _, _ in
        scrollToEnd(proxy, animated: true)
      }
      .onAppear { scrollToEnd(proxy, animated: false) }
    }
  }

  private func scrollToEnd(_ proxy: ScrollViewProxy, animated: Bool) {
    guard let last = chat?.messages.last else { return }
    if animated {
      withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
    } else {
      proxy.scrollTo(last.id, anchor: .bottom)
    }
  }

  /// True once the reply itself has started arriving.
  ///
  /// This is the line between thinking and answering, and it drives three things
  /// at once: the shimmer stops, the reasoning summary settles to "Thought
  /// process", and the phone taps once. Models interleave — reasoning tokens can
  /// keep arriving after the answer starts — so treating the first content token
  /// as the end of thinking is a deliberate simplification; showing both live at
  /// once reads as two answers being written at the same time.
  private var responseStarted: Bool {
    guard chat?.messages.contains(where: { $0.id == "streaming" }) == true else { return false }
    // The PACED text, not the snapshot's: this drives the shimmer, the label and
    // the haptic, and all three should land when the answer becomes visible
    // rather than when its first token quietly arrives behind the pacing.
    return !model.reply.visible.isEmpty
  }

  @ViewBuilder
  private func messageView(_ message: ShellSnapshot.ChatView.Message) -> some View {
    let isUser = message.role == "user"
    let isLive = message.id == "streaming"
    let stillThinking = isLive && !responseStarted

    VStack(alignment: isUser ? .trailing : .leading, spacing: 8) {
      if !isUser, !message.reasoning.isEmpty || stillThinking {
        // Olia's shape: a one-line, tappable summary — NOT the timeline inline.
        // The timeline lives in a sheet behind it.
        InlineReasoningIndicator(reasoning: message.reasoning, isStreaming: stillThinking)
      }
      if !message.text.isEmpty {
        messageBody(message, isUser: isUser)
      }
      if message.hasChanges, let pending = chat?.pendingChanges, !pending.isEmpty {
        Button {
          showReview = true
        } label: {
          Label(
            pending.count == 1 ? "Review 1 suggested edit"
                               : "Review \(pending.count) suggested edits",
            systemImage: "wand.and.stars"
          )
          .font(.subheadline)
        }
        .buttonStyle(.bordered)
      } else if message.hasChanges {
        // The proposal was already decided — applied or rejected — so there is
        // nothing left to review. Saying so beats a button that opens an empty
        // sheet.
        Label("Suggested edits reviewed", systemImage: "checkmark")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    // The user's turn is a bubble and keeps a gutter on its leading edge; the
    // reply is not. A shape around the reply boxed in the one thing that should
    // read as the page's own text, and cost it the full width it needs for
    // lists and headings.
    .padding(.leading, isUser ? 48 : 0)
    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
  }

  @ViewBuilder
  private func messageBody(_ message: ShellSnapshot.ChatView.Message, isUser: Bool) -> some View {
    if message.id == "streaming" {
      // The paced text, not the snapshot's: `ReplyStream` walks toward what has
      // arrived so the reply types itself in instead of landing a paragraph at a
      // time, and MarkdownText fades each block in as it completes.
      MarkdownText(model.reply.visible, isStreaming: !model.reply.caughtUp)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    } else if isUser {
      Text(message.text)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.accentColor, in: .rect(cornerRadius: 20))
        .foregroundStyle(.white)
    } else if message.role == "error" {
      Label(message.text, systemImage: "exclamationmark.triangle")
        .font(.subheadline)
        .textSelection(.enabled)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.12), in: .rect(cornerRadius: 14))
    } else {
      MarkdownText(message.text)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  // MARK: chat management

  /// Whether any chat on this sheet is holding text that has not been sent —
  /// the one on screen, or any parked by a switch.
  private var hasUnsentText: Bool {
    let written = { (text: String) in
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    return written(draft) || drafts.values.contains(where: written)
  }

  private var currentThread: ShellSnapshot.ChatView.Thread? {
    chat?.threads.first { $0.isCurrent }
  }

  private var currentTitle: String { currentThread?.title ?? "New chat" }

  /// The left button: which chat you are in, and starting another. Navigation
  /// between chats, kept apart from the title menu — that one acts on the chat
  /// you are already looking at.
  private var threadsMenu: some View {
    Menu {
      // Both pinned to the render, like every other menu here. An empty
      // composer holds no chat guard, so a tombstone can be adopted with this
      // menu open — and a thread id is unique only within a workspace, so a
      // cloned one opens an unrelated chat rather than failing.
      Section {
        Button { [renderedIn = model.snapshot.whereAmI] in
          guard renderedIn == model.snapshot.whereAmI else { return }
          model.send("chatNewThread")
        } label: {
          Label("New chat", systemImage: "square.and.pencil")
        }
      }
      Section("Chats") {
        ForEach(chat?.threads ?? []) { thread in
          Button { [renderedIn = model.snapshot.whereAmI] in
            guard renderedIn == model.snapshot.whereAmI else { return }
            model.send("chatSelectThread", ["id": thread.id])
          } label: {
            if thread.isCurrent {
              Label(thread.title, systemImage: "checkmark")
            } else {
              Text(thread.title)
            }
          }
        }
      }
    } label: {
      Image(systemName: "bubble.left.and.bubble.right")
    }
    .menuOrder(.fixed)
    .accessibilityLabel("Chats")
  }

  /// The bar's centre: this chat's name and what you can do to it. The model
  /// picker used to live here, which put a per-message choice in the place a
  /// document's title belongs.
  private var titleMenu: some View {
    Menu {
      Button {
        renameDraft = currentTitle
        // Pinned when the alert opens, exactly as the delete beside it is. An
        // empty composer means the chat guard allows adoption, so a synced
        // thread list can remove this chat and select a replacement while the
        // alert is up — and resolving `currentThread` on Rename would then put
        // this chat's drafted title on that replacement.
        pendingRenameThread = currentThread?.id
        pendingThreadFrom = model.snapshot.whereAmI
        showRename = true
      } label: {
        Label("Rename", systemImage: "pencil")
      }
      Button(role: .destructive) {
        pendingDeleteThread = currentThread?.id
        pendingThreadFrom = model.snapshot.whereAmI
        showDeleteConfirm = true
      } label: {
        Label("Delete chat", systemImage: "trash")
      }
    } label: {
      HStack(spacing: 4) {
        Text(currentTitle).font(.subheadline.weight(.semibold)).lineLimit(1)
        Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
      }
      .frame(maxWidth: 200)
    }
    .menuOrder(.fixed)
    .accessibilityLabel("Chat: \(currentTitle)")
  }

  private func sendDraft() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    // Not into a workspace this was not written in. The per-thread parking
    // above keys on the thread id changing, and a workspace cloned from the
    // same backup can present the SAME current thread id after the reload — so
    // nothing fires, the draft stays on screen looking like it belongs, and
    // Send posts it into a conversation in a workspace nobody opened.
    guard composedIn == model.snapshot.whereAmI else {
      staleWorkspace = true
      return
    }
    model.send("chatSend", ["text": text])
    draft = ""
    // Sent, so there is no longer a parked draft for this chat to come back to.
    if let id = currentThread?.id { drafts[id] = nil }
    fieldGeneration += 1
  }
}

// MARK: - Version history

/// Every saved version of this résumé, newest first.
///
/// The only surface that shows the undo stack as a list rather than one step at
/// a time — the Actions menu's Undo and Redo walk the same stack, so a restore
/// here changes what those two do next.
private struct HistorySheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  /// The version a confirmation is pending on. Held whole rather than by index:
  /// indices renumber, and this is what gets sent back for the check.
  @State private var pendingRestore: ShellSnapshot.History.Entry?
  /// The résumé and workspace that prompt was raised in. See the dialog.
  @State private var restoreFrom: ShellSnapshot.Where?
  @State private var staleWarning = false

  private var history: ShellSnapshot.History? { model.snapshot.history }

  var body: some View {
    NavigationStack {
      Group {
        if let diff = history?.diff {
          comparison(diff)
        } else if let entries = history?.entries, !entries.isEmpty {
          list(entries)
        } else if history == nil {
          ProgressView()
        } else {
          ContentUnavailableView(
            "No versions yet",
            systemImage: "clock.arrow.circlepath",
            description: Text("Edits to this resume are saved here as you make them.")
          )
        }
      }
      .navigationTitle(history?.diff == nil ? "Version history" : "Changes since")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if history?.diff != nil {
          ToolbarItem(placement: .cancellationAction) {
            Button("Back") { model.send("closeCompare") }
          }
        }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .confirmationDialog(
        "Restore this version?",
        isPresented: .init(
          get: { pendingRestore != nil },
          set: { if !$0 { pendingRestore = nil } }
        ),
        titleVisibility: .visible
      ) {
        Button("Restore", role: .destructive) {
          guard let entry = pendingRestore else { return }
          pendingRestore = nil
          // The index AND timestamp were already checked against the live
          // history, which is enough while the history is this résumé's. Two
          // workspaces cloned from one backup hold histories with the same
          // positions and the same timestamps, so after a tombstone reload that
          // check passes against a different document — and a restore replaces
          // the whole of it.
          guard restoreFrom == model.snapshot.whereAmI else {
            restoreFrom = nil
            staleWarning = true
            return
          }
          restoreFrom = nil
          model.send(
            "restoreVersion", ["index": "\(entry.index)", "timestamp": entry.timestamp]
          ) { ok in staleWarning = !ok }
        }
      } message: {
        // Precise about what survives, because the web dialog's wording is not:
        // restoreToEntry truncates nothing, so the newer versions stay in the
        // stack as redo-able ones rather than being "saved in history".
        Text("The whole resume goes back to this version. The newer versions stay in this list, so you can come forward again.")
      }
      .alert("That version moved", isPresented: $staleWarning) {
        Button("OK", role: .cancel) {}
      } message: {
        Text("The history changed while this was open. Pick it again from the refreshed list.")
      }
    }
  }

  private func list(_ entries: [ShellSnapshot.History.Entry]) -> some View {
    List {
      ForEach(entries) { entry in
        // Captured where the row is DRAWN. A swipe tray and a long-press menu
        // keep the closures they were presented with, so reading the workspace
        // inside the action reads it AFTER the wait the pin exists to span —
        // and `restoreFrom` then holds the replacement, which its own
        // confirmation happily matches. The index and timestamp cannot catch it
        // either: a workspace cloned from the same backup has both.
        let renderedIn = model.snapshot.whereAmI
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Image(systemName: symbol(for: entry.changeType))
              .font(.caption)
              .foregroundStyle(entry.isCurrent ? Color.accentColor : .secondary)
              .frame(width: 18)
            Text(entry.label).font(.subheadline.weight(.medium))
            Text(relative(entry.timestamp)).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if entry.isCurrent {
              Text("Current")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.accentColor.opacity(0.15), in: .capsule)
                .foregroundStyle(Color.accentColor)
            }
          }
          if !entry.description.isEmpty {
            Text(entry.description)
              .font(.footnote)
              .foregroundStyle(.secondary)
              .padding(.leading, 26)
          }
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if !entry.isCurrent {
            Button("Restore") {
              pendingRestore = entry
              restoreFrom = renderedIn
            }
            .tint(.orange)
          }
          Button("Compare") {
            guard renderedIn == model.snapshot.whereAmI else { return }
            model.send("compareVersion", [
              "index": "\(entry.index)",
              "timestamp": entry.timestamp,
              "label": "\(entry.label) · \(relative(entry.timestamp))",
            ]) { ok in staleWarning = !ok }
          }
          .tint(.blue)
        }
        // The same two actions on a tap-and-hold, because a swipe on a row is
        // discoverable only if you already know it is there.
        .contextMenu {
          if !entry.isCurrent {
            Button("Restore this version", systemImage: "clock.arrow.circlepath") {
              pendingRestore = entry
              restoreFrom = renderedIn
            }
          }
          Button("Compare with current", systemImage: "arrow.left.arrow.right") {
            guard renderedIn == model.snapshot.whereAmI else { return }
            model.send("compareVersion", [
              "index": "\(entry.index)",
              "timestamp": entry.timestamp,
              "label": "\(entry.label) · \(relative(entry.timestamp))",
            ]) { ok in staleWarning = !ok }
          }
        }
      }
    }
  }

  /// Read-only on purpose. It reads "what has changed since then", not a
  /// proposal — the AI's review sheet is the only place changes get applied.
  private func comparison(_ diff: ShellSnapshot.History.Diff) -> some View {
    List {
      Section {
        if diff.changes.isEmpty {
          Text("Nothing has changed since this version.")
            .foregroundStyle(.secondary)
        }
        ForEach(diff.changes) { change in
          VStack(alignment: .leading, spacing: 6) {
            Text(change.label).font(.caption).foregroundStyle(.secondary)
            if !change.before.isEmpty {
              Text(change.before)
                .font(.footnote)
                .strikethrough(change.type == "remove")
                .foregroundStyle(.secondary)
            }
            if !change.after.isEmpty {
              Text(change.after).font(.footnote)
            }
          }
          .padding(.vertical, 2)
        }
      } header: {
        Text(diff.label.isEmpty ? "Compared version" : diff.label)
      } footer: {
        Text("Shown as it stands now against that version. Nothing here is applied.")
      }
    }
  }

  private func symbol(for changeType: String) -> String {
    switch changeType {
    case "initial": return "doc"
    case "ai": return "sparkles"
    case "import": return "square.and.arrow.down"
    case "reorder": return "arrow.up.arrow.down"
    case "add": return "plus"
    case "remove": return "minus"
    // A conflict's losing version, kept so it can still be restored. The web
    // dialog draws lucide's MonitorSmartphone for this; two device shapes is
    // the readable idea, so `laptopcomputer.and.iphone` is its counterpart
    // here. Only the LABEL is shared across the two platforms — the drawings
    // cannot be, which is why `src/historyEntryLabels.js` holds the strings and
    // nothing else.
    case "sync-conflict": return "laptopcomputer.and.iphone"
    default: return "pencil"
    }
  }

  /// The system's formatter, not a hand-rolled "3h ago": it speaks the user's
  /// language, which is why the timestamp crosses the bridge unformatted.
  private func relative(_ iso: String) -> String {
    guard let date = ISO8601DateFormatter.historyParser.date(from: iso) else { return "" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(for: date, relativeTo: Date())
  }
}

private extension ISO8601DateFormatter {
  /// The store writes `new Date().toISOString()`, which always carries
  /// milliseconds — the default parser rejects those.
  static let historyParser: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
}

// MARK: - Change review

/// Review the AI's proposed edits before they land.
///
/// This exists because the alternative was worse in both directions: dropping
/// the proposals silently made chat useless on the phone, and applying them
/// from a button in the transcript would let someone accept an edit they never
/// saw. So the rule is that nothing applies without its BEFORE and AFTER on
/// screen first.
///
/// Every action routes to the same session `inlineChanges.js` drives on
/// desktop. Apply-all in particular is NOT a loop over apply-one: leaf paths are
/// indexed against the proposed array, so insertions and removals have to land
/// before modifications or a write hits the wrong element. `applyChangesToStore`
/// owns that ordering and this must not reimplement it.
private struct ChangeReviewSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  private var changes: [ShellSnapshot.ChatView.PendingChange] {
    model.snapshot.chat?.pendingChanges ?? []
  }

  var body: some View {
    NavigationStack {
      Group {
        if changes.isEmpty {
          ContentUnavailableView(
            "Nothing to review",
            systemImage: "checkmark.circle",
            description: Text("Every suggested edit has been applied or rejected.")
          )
        } else {
          List {
            ForEach(changes) { change in
              Section {
                if !change.before.isEmpty {
                  diffRow(label: "Before", text: change.before, tint: .red)
                }
                if !change.after.isEmpty {
                  diffRow(label: "After", text: change.after, tint: .green)
                }
                HStack {
                  Button("Reject", role: .destructive) {
                    model.send("rejectChange", ["path": change.path])
                  }
                  Spacer()
                  Button("Apply") {
                    model.send("applyChange", ["path": change.path])
                  }
                  .buttonStyle(.borderedProminent)
                }
                .buttonStyle(.bordered)
              } header: {
                Text(change.label).font(.footnote).textCase(nil)
              }
            }
          }
        }
      }
      .navigationTitle("Suggested edits")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        if !changes.isEmpty {
          ToolbarItemGroup(placement: .bottomBar) {
            Button("Reject all", role: .destructive) {
              model.send("rejectAllChanges")
              dismiss()
            }
            Spacer()
            Button("Apply all") {
              model.send("applyAllChanges")
              dismiss()
            }
          }
        }
      }
    }
  }

  private func diffRow(label: String, text: String, tint: Color) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tint)
      Text(text)
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 2)
  }
}

// MARK: - Library

/// Every résumé, searchable.
///
/// A phone list rather than the desktop dialog's split view: one row per
/// résumé, and tapping it opens that résumé — which is what the desktop's
/// preview pane was for. Search runs in JS against the same `searchLibrary` the
/// dialog uses, so results cannot diverge; Swift owns only the query string.
///
/// Deep search is a toggle because it is materially slower: it flattens every
/// résumé's text and every attached job description, and on a phone that is
/// worth asking for rather than doing on every keystroke.
/// The application timeline.
///
/// The web draws a Gantt: one lane per résumé, dots on a shared horizontal
/// axis. That does not survive a 402pt screen — its lane-label column alone is
/// 148px, leaving a couple of hundred points for what can be a year of range,
/// and the dots land on top of each other. Same data, read top-down instead:
/// newest first, grouped by month, one row per application. The résumé each
/// one used is the secondary label rather than the axis.
private struct LibraryTimeline: View {
  @ObservedObject var model: ShellModel
  let points: [ShellSnapshot.LibraryView.TimelinePoint]
  let onOpen: () -> Void

  var body: some View {
    if points.isEmpty {
      ContentUnavailableView(
        "No applications yet",
        systemImage: "clock",
        description: Text(
          "Tailor a résumé against a job, or add an application from a "
          + "résumé, and it shows up here."
        )
      )
    } else {
      List {
        ForEach(months, id: \.key) { month in
          Section(month.title) {
            ForEach(month.points) { point in
              Button {
                model.send("openVariant", ["id": point.variantId])
                onOpen()
              } label: {
                row(point)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
    }
  }

  private func row(_ point: ShellSnapshot.LibraryView.TimelinePoint) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Circle()
        .fill(color(for: point.status))
        .frame(width: 9, height: 9)
        .padding(.top, 5)
      VStack(alignment: .leading, spacing: 2) {
        Text(point.title.isEmpty ? "Untitled role" : point.title)
          .font(.subheadline.weight(.medium))
        if !point.company.isEmpty {
          Text(point.company).font(.footnote).foregroundStyle(.secondary)
        }
        HStack(spacing: 6) {
          Text(point.variantName)
          if !point.status.isEmpty {
            Text("·")
            Text(Self.label(for: point.status))
          }
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
      }
      Spacer(minLength: 0)
      Text(dayLabel(point.at))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
    }
    .contentShape(.rect)
  }

  /// Muted for a draft that was never sent, so a prepared application does not
  /// read as an outcome — the same distinction the web makes by dimming it.
  ///
  /// The status set is closed and lives in `APPLICATION_STATUSES`
  /// (src/applications.js). It is matched here rather than sent as a colour
  /// because a colour is a rendering decision, and rather than imported
  /// because `applications.js` pulls in the store and its side effects, which
  /// would cost `iosShell.js` the purity its projections are tested on.
  private func color(for status: String) -> Color {
    switch status {
    case "prepared": return .secondary
    case "interview", "offer": return .green
    case "rejected", "no_response": return .red
    case "applied", "heard_back": return .blue
    default: return .secondary
    }
  }

  /// Mirrors `STATUS_LABELS` in src/applications.js. Not `.capitalized`, which
  /// renders `heard_back` as "Heard_back".
  private static func label(for status: String) -> String {
    switch status {
    case "prepared": return "Prepared"
    case "applied": return "Applied"
    case "heard_back": return "Heard back"
    case "interview": return "Interview"
    case "offer": return "Offer"
    case "rejected": return "Rejected"
    case "no_response": return "No response"
    default: return status
    }
  }

  private struct Month: Identifiable {
    let key: String
    let title: String
    let points: [ShellSnapshot.LibraryView.TimelinePoint]
    var id: String { key }
  }

  /// Grouped here rather than in the projection: which month a timestamp falls
  /// in depends on the device's calendar and time zone, and what that month is
  /// called depends on its locale.
  private var months: [Month] {
    var order: [String] = []
    var grouped: [String: [ShellSnapshot.LibraryView.TimelinePoint]] = [:]
    var titles: [String: String] = [:]
    for point in points {
      guard let date = Self.parse(point.at) else { continue }
      let key = Self.keyFormatter.string(from: date)
      if grouped[key] == nil {
        order.append(key)
        titles[key] = Self.monthFormatter.string(from: date)
      }
      grouped[key, default: []].append(point)
    }
    return order.map { Month(key: $0, title: titles[$0] ?? $0, points: grouped[$0] ?? []) }
  }

  private func dayLabel(_ iso: String) -> String {
    guard let date = Self.parse(iso) else { return "" }
    return Self.dayFormatter.string(from: date)
  }

  /// Two parsers: `appliedAt` carries fractional seconds and `createdAt` does
  /// not, and ISO8601DateFormatter fails outright on the option it was not
  /// given rather than ignoring it.
  private static func parse(_ iso: String) -> Date? {
    isoWithFraction.date(from: iso) ?? isoPlain.date(from: iso)
  }

  private static let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let isoPlain = ISO8601DateFormatter()
  private static let keyFormatter: DateFormatter = {
    let f = DateFormatter()
    // Fixed, because this one is a grouping KEY and must not change with the
    // locale — only the title the user reads does.
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM"
    return f
  }()
  private static let monthFormatter: DateFormatter = {
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate("MMMM yyyy")
    return f
  }()
  private static let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate("MMM d")
    return f
  }()
}

/// Four outcome tiles and a per-résumé comparison. A strip, not a dashboard —
/// the same scope the web keeps.
private struct LibraryStats: View {
  let stats: ShellSnapshot.LibraryView.Stats?

  var body: some View {
    if let stats, stats.sent > 0 {
      List {
        Section {
          LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            tile("Applications sent", "\(stats.sent)")
            tile("Response rate", percent(stats.responseRate))
            tile("Interview rate", percent(stats.interviewRate))
            tile("Median time to response", days(stats.medianDaysToResponse))
          }
          .padding(.vertical, 4)
        }
        .listRowBackground(Color.clear)

        if !stats.perVariant.isEmpty {
          Section("By résumé") {
            ForEach(stats.perVariant) { row in
              HStack(alignment: .firstTextBaseline) {
                Text(row.variantName).lineLimit(1)
                Spacer(minLength: 12)
                Text("\(row.responded)/\(row.sent) responses · \(row.interviewed) interview\(row.interviewed == 1 ? "" : "s")")
                  .font(.caption.monospacedDigit())
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    } else {
      ContentUnavailableView(
        "Nothing to measure yet",
        systemImage: "chart.bar",
        description: Text("Send an application and its outcome shows up here.")
      )
    }
  }

  private func tile(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(value).font(.title2.weight(.semibold).monospacedDigit())
      Text(label).font(.caption2).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
  }

  /// "—" rather than 0%: no replies yet is not a 0% response rate, and the
  /// projection sends null precisely so the two stay distinguishable.
  private func percent(_ value: Double?) -> String {
    guard let value else { return "—" }
    return "\(Int((value * 100).rounded()))%"
  }

  private func days(_ value: Double?) -> String {
    guard let value else { return "—" }
    if value < 1 { return "<1 day" }
    let n = Int(value.rounded())
    return "\(n) day\(n == 1 ? "" : "s")"
  }
}

/// Reviewing the AI's proposed changes.
///
/// **Nothing applies here.** Every button sends a command that calls the web
/// dialog's own handler — which is the whole design: tailoring goes through
/// diffEngine and `applyChangesToStore` rather than the inline-changes
/// session, and Apply All has to batch through the ordered helper rather than
/// loop, because leaf paths are indexed against the PROPOSED array. Rebuilding
/// any of that here is how someone accepts an edit that was never applied.
///
/// A decided change stays on screen, dimmed, rather than vanishing: a card
/// that disappears on Apply leaves no way to see what you just agreed to.
private struct DiffReviewSheet: View {
  @ObservedObject var model: ShellModel
  let review: ShellSnapshot.DiffReview

  var body: some View {
    NavigationStack {
      Group {
        if review.changes.isEmpty {
          ContentUnavailableView(
            "No changes to review",
            systemImage: "checkmark.circle",
            description: Text("Nothing was proposed for this résumé.")
          )
        } else {
          List {
            ForEach(review.changes) { change in
              Section {
                card(change)
              } header: {
                HStack(spacing: 6) {
                  Image(systemName: icon(for: change.kind))
                    .foregroundStyle(tint(for: change.kind))
                  Text(change.label)
                  Spacer(minLength: 0)
                  if change.applied {
                    Text("Applied").foregroundStyle(.green)
                  } else if change.rejected {
                    Text("Rejected").foregroundStyle(.secondary)
                  }
                }
                .font(.caption)
                .textCase(nil)
              }
            }
          }
        }
      }
      .navigationTitle(review.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { model.send("diffClose") }
        }
        ToolbarItem(placement: .confirmationAction) {
          // Counted, because "Apply all" beside eleven cards gives no way to
          // tell that eight of them were already decided.
          Button("Apply all (\(review.pending))") { model.send("diffApplyAll") }
            .disabled(review.pending == 0)
        }
      }
    }
  }

  @ViewBuilder
  private func card(_ change: ShellSnapshot.DiffReview.Change) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      // The old value is always struck: whether it is being replaced or
      // removed outright, it is what will no longer be there.
      if !change.before.isEmpty {
        value(change.before, tint: .red, strikethrough: true)
      }
      if !change.after.isEmpty {
        value(change.after, tint: .green, strikethrough: false)
      }
      if change.before.isEmpty && change.after.isEmpty {
        Text("(empty)").font(.footnote).italic().foregroundStyle(.secondary)
      }

      if !change.applied && !change.rejected {
        HStack(spacing: 10) {
          Button("Reject") { model.send("diffReject", ["path": change.path]) }
            .buttonStyle(.bordered)
          Button("Apply") { model.send("diffApply", ["path": change.path]) }
            .buttonStyle(.borderedProminent)
          Spacer(minLength: 0)
        }
        .controlSize(.small)
      }
    }
    .padding(.vertical, 4)
    .opacity(change.applied || change.rejected ? 0.5 : 1)
  }

  private func value(_ text: String, tint: Color, strikethrough: Bool) -> some View {
    Text(text)
      .font(.footnote)
      .strikethrough(strikethrough, color: tint)
      .foregroundStyle(strikethrough ? Color.secondary : Color.primary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .background(tint.opacity(0.12), in: .rect(cornerRadius: 8))
  }

  private func icon(for kind: String) -> String {
    switch kind {
    case "add": return "plus.circle.fill"
    case "remove": return "minus.circle.fill"
    default: return "pencil.circle.fill"
    }
  }

  private func tint(for kind: String) -> Color {
    switch kind {
    case "add": return .green
    case "remove": return .red
    default: return .blue
    }
  }
}

private struct LibrarySheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var query = ""
  @State private var deep = false
  @State private var tab = Tab.resumes

  private enum Tab: String, CaseIterable, Identifiable {
    case resumes = "Resumes"
    case timeline = "Timeline"
    case stats = "Stats"
    var id: String { rawValue }
  }

  private var library: ShellSnapshot.LibraryView? { model.snapshot.library }
  private var entries: [ShellSnapshot.LibraryEntry] { library?.entries ?? [] }

  var body: some View {
    NavigationStack {
      Group {
        switch tab {
        case .resumes: resumeList
        case .timeline: LibraryTimeline(model: model, points: library?.timeline ?? []) { dismiss() }
        case .stats: LibraryStats(stats: library?.stats)
        }
      }
      .navigationTitle("All resumes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .principal) {
          Picker("View", selection: $tab) {
            ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.segmented)
          .frame(width: 260)
        }
      }
      .onAppear { search() }
    }
  }

  private var resumeList: some View {
    List {
      Section {
        Toggle("Search inside résumés and job descriptions", isOn: $deep)
          .font(.subheadline)
          .onChange(of: deep) { _, _ in search() }
      }
      Section {
        if entries.isEmpty {
          Text(query.isEmpty ? "No resumes yet." : "No matches.")
            .foregroundStyle(.secondary)
        } else {
          ForEach(entries) { entry in
            Button {
              model.send("openVariant", ["id": entry.id])
              dismiss()
            } label: {
              row(entry)
            }
            .buttonStyle(.plain)
          }
        }
      } header: {
        Text(entries.count == 1 ? "1 resume" : "\(entries.count) resumes")
      }
    }
    // Only the résumé list is searchable — the search filters ENTRIES, and
    // leaving the field up on a tab it does not affect reads as a broken
    // search rather than an inapplicable one.
    .searchable(text: $query, prompt: "Search resumes")
    .onChange(of: query) { _, _ in search() }
  }

  private func row(_ entry: ShellSnapshot.LibraryEntry) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(entry.name).font(.body)
        Spacer()
        if entry.applicationCount > 0 {
          Text("\(entry.applicationCount)")
            .font(.caption.monospacedDigit())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: .capsule)
        }
      }
      if !entry.status.isEmpty {
        Text(entry.status.capitalized).font(.caption).foregroundStyle(.secondary)
      }
      if !entry.snippet.isEmpty {
        // Says WHERE the match was, because a snippet with no source reads as
        // if it came from the résumé when it may have come from a job post.
        Text("\(entry.snippetSource.capitalized): \(entry.snippet)")
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
    }
    .padding(.vertical, 2)
    .contentShape(.rect)
  }

  private func search() {
    model.send("librarySearch", ["query": query, "deep": deep ? "true" : "false"])
  }
}

// MARK: - Design

private typealias Design = ShellSnapshot.Design

/// One tab of the design panel. The order is the order of the chips.
///
/// `format` leads because it is what the toolbar button opens onto, and because
/// it is the only tab about the text you have SELECTED — everything after it is
/// a property of the document.
private enum DesignSection: String, CaseIterable, Identifiable {
  case format, page, color, layout, header, typography, spacing, accents, photo

  var id: String { rawValue }

  var title: String {
    switch self {
    case .format: return "Format"
    case .page: return "Page"
    case .color: return "Color"
    case .layout: return "Layout"
    case .header: return "Header"
    case .typography: return "Typography"
    case .spacing: return "Spacing"
    case .accents: return "Accents"
    case .photo: return "Photo"
    }
  }

  var symbol: String {
    switch self {
    // NOT `textformat`, which Typography has carried since this panel existed.
    // The two were one button precisely because that glyph on both of them made
    // "which one changes the text" unanswerable; as sibling tabs they need to
    // be told apart at a glance, and this one draws the three things it does.
    case .format: return "bold.italic.underline"
    case .page: return "doc"
    case .color: return "paintpalette"
    case .layout: return "square.split.2x1"
    case .header: return "rectangle.tophalf.filled"
    case .typography: return "textformat"
    case .spacing: return "arrow.up.and.down"
    case .accents: return "sparkles"
    case .photo: return "person.crop.circle"
    }
  }
}

/// The native design panel.
///
/// EIGHT SECTIONS BEHIND A PICKER, not a full-height list that pushes into them.
/// The web panel is nine collapsing sections holding sixty-odd controls, and a
/// phone-width form of all of it is a scroll nobody can hold their place in.
/// The drill-down list that first answered that charged a push and a pop for
/// every change, and covered the résumé while you made it.
///
/// The short sheet is the point, not the styling: `presentationBackgroundInteraction`
/// keeps the canvas live underneath, so the page you are designing can be
/// scrolled, pinched and READ without closing what you are editing. Nothing in
/// here previews the résumé because it does not have to — the résumé is on
/// screen, two inches up, re-rendering as you tap. Sections with more in them
/// than the compact height shows are one drag from `.large`.
///
/// Each section gets its OWN `NavigationStack` (`.id(section)`): Typography and
/// Header still push sub-screens, and switching chips has to land on the new
/// section's root rather than leave someone else's sub-screen on top.
/// "These design changes are not on disk." The fourth of these, and worded like
/// the others because it is the same failure on the keys this sheet writes.
///
/// A strip rather than a Form section: this sheet is a chip switcher over a
/// short panel, with no list to put a row in.
private struct DesignSaveWarning: View {
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      Text("Storage is full, so these design changes are not on disk. Free up space — they will go back on the next launch.")
        .font(.caption)
        .foregroundStyle(.secondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 8)
  }
}

private struct DesignSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss
  @State private var section: DesignSection = .format

  /// A shade over a third of the screen: the chips plus three rows of controls
  /// with room under them, and the résumé still the larger part of what you are
  /// looking at. Started at Notes' Format-panel proportion — about a quarter —
  /// and came up 20% from there, because the Format tab is three rows deep
  /// where Notes' is two and the footnote was landing below the fold.
  ///
  /// The sheet draws ~30pt taller than the number, so measure the result rather
  /// than trusting it. It is a named constant because
  /// `presentationBackgroundInteraction` has to be handed the SAME detent to
  /// know how far up the canvas stays live.
  private static let compactHeight: CGFloat = 296

  var body: some View {
    VStack(spacing: 0) {
      header
      if model.snapshot.design?.saveFailed == true { DesignSaveWarning() }
      content
    }
    // Three stops, not two. The compact one is the panel's working height and
    // `.large` is for the sections with a lot in them; without `.medium` the
    // drag between them was one long throw with nothing to catch it, and the
    // sections that want about half a screen — palettes, layouts, pairings —
    // had to overshoot to the top to be read.
    .presentationDetents([.height(Self.compactHeight), .medium, .large])
    // Only the compact stop leaves the canvas live. That stop exists so the
    // résumé can be scrolled and pinched while you work on it; dragging past it
    // is the gesture for "I am in the panel now", and the bars underneath going
    // inert with it is the same trade Maps makes.
    .presentationBackgroundInteraction(.enabled(upThrough: .height(Self.compactHeight)))
    // Without this, a swipe that starts on a Form resizes the SHEET instead of
    // scrolling the form — which at the compact height puts the lower controls
    // of a section out of reach of the gesture that should reach them.
    .presentationContentInteraction(.scrolls)
  }

  private var header: some View {
    HStack(spacing: 14) {
      chips
      closeButton
    }
    .padding(.leading, 16)
    .padding(.trailing, 14)
    .padding(.top, 14)
    .padding(.bottom, 10)
  }

  private var chips: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(DesignSection.allCases) { chip($0) }
        }
        // The chips carry glass, which draws a little outside its own bounds;
        // without this the first and last are clipped by the scroll view.
        .padding(.vertical, 2)
      }
      .scrollIndicators(.hidden)
      // Selecting the last chip on a 390pt screen otherwise leaves it expanded
      // half off the trailing edge, reading as "nothing is selected".
      .onChange(of: section) { _, selected in
        withAnimation(.snappy(duration: 0.28)) { proxy.scrollTo(selected, anchor: .center) }
      }
    }
  }

  private func chip(_ which: DesignSection) -> some View {
    let selected = which == section
    return Button {
      withAnimation(.snappy(duration: 0.28)) { section = which }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: which.symbol)
        // Only the selected chip carries its name. `fixedSize` because the
        // label appears mid-animation, and without it the text lays out against
        // the capsule's OLD width and truncates to an ellipsis on the way in.
        if selected {
          Text(which.title).fixedSize()
        }
      }
      .modifier(DesignChip(selected: selected))
    }
    .buttonStyle(.plain)
    .id(which)
    .accessibilityLabel(which.title)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }

  private var closeButton: some View {
    Button {
      dismiss()
    } label: {
      Image(systemName: "xmark")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
        .frame(width: DesignChip.height, height: DesignChip.height)
        .glassEffect(.regular.interactive(), in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Done")
  }

  private var content: some View {
    NavigationStack {
      Group {
        // Every tab but Format reads the design projection, which lands a frame
        // after the sheet opens; an empty form would read as a panel with
        // nothing in it. Format reads none of it — and it is the tab the
        // toolbar button opens onto, so it is the one that must never be a
        // spinner.
        if section != .format, model.snapshot.design == nil {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          screen
        }
      }
      // The chips ARE this sheet's title bar. A second one under them would
      // spend a third of the compact height saying what the lit chip says.
      .toolbar(.hidden, for: .navigationBar)
      // A Form opens with about 35pt of inset above its first section, which is
      // right under a navigation bar and wrong under a chip that has already
      // named the section. Measured: it and the header's own padding were
      // spending 52pt — a sixth of the compact sheet, and more than a row — on
      // the gap between the chips and the first control.
      .contentMargins(.top, 4, for: .scrollContent)
    }
    .id(section)
  }

  @ViewBuilder
  private var screen: some View {
    switch section {
    case .format: FormatScreen(model: model)
    case .page: PageScreen(model: model)
    case .color: ColorScreen(model: model)
    case .layout: LayoutScreen(model: model)
    case .header: HeaderScreen(model: model)
    case .typography: TypographyScreen(model: model)
    case .spacing: SpacingScreen(model: model)
    case .accents: AccentsScreen(model: model)
    case .photo: PhotoScreen(model: model)
    }
  }
}

/// Text formatting: the only tab that is a panel of BUTTONS rather than a Form.
///
/// Every other section edits a property the projection reports back, so a Form
/// bound to it is the honest shape. These are verbs with no state to read — the
/// page does not tell us whether the selection is bold — so a row of controls
/// that each look tapped-and-done is the honest shape for them, and it is what
/// every text editor draws.
///
/// Two scopes on one tab, which is why the footnote is not decoration: the top
/// row acts on the SELECTION, while the size buttons move the whole résumé's
/// font scale — the same value the Spacing tab shows as a percentage. They are
/// here because they were in the toolbar menu this replaced.
private struct FormatScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    // A ScrollView, though at the compact height the contents fit: Dynamic Type
    // at its larger settings grows every button, and a VStack that overflows
    // would quietly clip the last row rather than let it be reached.
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          action("Bold", "bold") { model.send("textBold") }
          action("Italic", "italic") { model.send("textItalic") }
          action("Underline", "underline") { model.send("textUnderline") }
          action("Bulleted list", "list.bullet") { model.send("textBullets") }
        }
        // Named, unlike the row above. `textformat.size.smaller` and
        // `.larger` are the system's own glyphs for this and they differ by a
        // few points of one letter — side by side and icon-only they were a
        // coin toss. Apple only ever draws them beside a label, and so do we.
        HStack(spacing: 10) {
          action("Smaller text", "textformat.size.smaller", name: "Smaller") {
            model.send("textSizeDecrease")
          }
          action("Bigger text", "textformat.size.larger", name: "Bigger") {
            model.send("textSizeIncrease")
          }
        }
        action("Clear formatting", "eraser", name: "Clear formatting") {
          model.send("textClearFormat")
        }
        Text("Text size changes the whole resume. Everything else applies to the text you have selected.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 4)
          .padding(.top, 2)
      }
      .padding(.horizontal, 16)
      .padding(.top, 6)
    }
  }

  /// Equal-width because they are peers within a row, and 44pt because that is
  /// the tap target the rest of the bar is built on.
  ///
  /// `name` is what the button SHOWS; `title` is what VoiceOver reads, and it
  /// stays the full phrase either way — "Clear formatting" is the action
  /// whether or not the row had the width to print it.
  private func action(
    _ title: String, _ symbol: String, name: String? = nil, run: @escaping () -> Void
  ) -> some View {
    Button(action: run) {
      HStack(spacing: 6) {
        Image(systemName: symbol)
        if let name { Text(name) }
      }
      .font(.system(size: 17))
      .lineLimit(1)
      .foregroundStyle(.primary)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 12))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }
}

/// A section chip: icon alone until it is the selected one, then icon and name.
///
/// Two branches rather than one with a ternary `Glass`, matching
/// `ComposerSendStyle`: the tinted and untinted glass are different values, and
/// building them at the call site is what the codebase already avoids.
private struct DesignChip: ViewModifier {
  static let height: CGFloat = 38

  let selected: Bool

  func body(content: Content) -> some View {
    let sized = content
      .font(.subheadline.weight(.medium))
      .lineLimit(1)
      // Collapsed chips are CAPSULES, not circles. At 10pt of padding a chip
      // was as wide as it was tall, and nine of those in a row read as crammed
      // rather than as a picker — the thing this is modelled on gives its
      // unselected chips about twice their height in width. Nine tabs cannot
      // afford twice; they can afford this, and the row scrolls.
      .padding(.horizontal, 18)
      .frame(height: Self.height)

    if selected {
      sized
        .foregroundStyle(.white)
        .glassEffect(.regular.tint(.accentColor).interactive(), in: .capsule)
    } else {
      sized
        .foregroundStyle(.primary)
        .glassEffect(.regular.interactive(), in: .capsule)
    }
  }
}

// MARK: design plumbing

/// The name of the option with this id, or the id itself.
private func optionName(_ id: String, in options: [Design.Option]) -> String {
  options.first { $0.id == id }?.name ?? id
}

/// Bindings that WRITE through `setDesign` and READ from the LIVE snapshot.
///
/// The SettingsSheet rule, and it earns more here: `applyDesign` clamps and
/// normalises what it is given, and a preset write moves eight other controls at
/// once. A control holding its own copy would show a value the résumé never
/// took; reading the snapshot back means a rejected write simply springs the
/// control to what actually landed.
///
/// The fallbacks are inert — `design` is only nil while the sheet is closing,
/// and a control on its way off screen showing one frame of nothing is not
/// worth a second code path.
///
/// `@MainActor` on all three: a `Binding`'s get and set are `@Sendable`, and a
/// closure formed in a nonisolated function cannot then touch the model at all.
/// The isolation is what a View gets for free — every caller here is one — and
/// stating it is what keeps these free functions on the same footing.
/// The workspace a design control was RENDERED for.
///
/// A `Picker`'s menu keeps the binding it was presented with, so a menu still
/// open across a workspace tombstone holds the binding built before the reload
/// while the sheet behind it has re-rendered for the replacement. Choosing then
/// writes into a workspace whose design the menu never showed.
///
/// Only the bindings need this. The palette, layout, header-style and font
/// buttons act on the tap itself, and the sheet has re-rendered for the new
/// workspace by then — so a tap after a reload targets exactly what is on
/// screen, which is right.
@MainActor
private func designText(
  _ model: ShellModel, _ group: String, _ property: String,
  _ read: @escaping (Design) -> String
) -> Binding<String> {
  let renderedFor = model.snapshot.whereAmI
  return Binding(
    get: { model.snapshot.design.map(read) ?? "" },
    set: {
      guard renderedFor == model.snapshot.whereAmI else { return }
      model.send("setDesign", ["group": group, "property": property, "value": $0])
    }
  )
}

@MainActor
private func designFlag(
  _ model: ShellModel, _ group: String, _ property: String,
  _ read: @escaping (Design) -> Bool
) -> Binding<Bool> {
  let renderedFor = model.snapshot.whereAmI
  return Binding(
    get: { model.snapshot.design.map(read) ?? false },
    set: {
      guard renderedFor == model.snapshot.whereAmI else { return }
      model.send(
        "setDesign", ["group": group, "property": property, "value": $0 ? "true" : "false"]
      )
    }
  )
}

/// `places` is the STEP's precision, not a display choice: the string is the
/// number the store keeps, and "%.2f" on a 0.1-step margin is what stops
/// 0.30000000000000004 crossing the bridge.
///
/// A slider sends on every frame of the drag, deliberately. The web side
/// debounces repagination by 200ms, so the canvas keeps up on its own and a
/// throttle here would only make the résumé lag the thumb.
@MainActor
private func designNumber(
  _ model: ShellModel, _ group: String, _ property: String,
  fallback: Double, places: Int,
  _ read: @escaping (Design) -> Double
) -> Binding<Double> {
  let renderedFor = model.snapshot.whereAmI
  return Binding(
    get: { model.snapshot.design.map(read) ?? fallback },
    set: {
      guard renderedFor == model.snapshot.whereAmI else { return }
      model.send(
        "setDesign",
        ["group": group, "property": property, "value": String(format: "%.\(places)f", $0)]
      )
    }
  )
}

/// A six-digit CSS hex as a Color. Everything on this wire is written the way
/// CSS writes it, because the store's own colour maths reads it back the same
/// way — `generateDarkColor` slices the string three bytes at a time.
private func designColor(_ hex: String) -> Color? {
  var digits = hex.trimmingCharacters(in: .whitespaces)
  if digits.hasPrefix("#") { digits.removeFirst() }
  guard digits.count == 6, let value = UInt64(digits, radix: 16) else { return nil }
  return Color(
    .sRGB,
    red: Double((value >> 16) & 0xFF) / 255,
    green: Double((value >> 8) & 0xFF) / 255,
    blue: Double(value & 0xFF) / 255,
    opacity: 1
  )
}

/// Back to `#rrggbb`, which is the only form the store parses.
///
/// The picker can hand back a wide-gamut colour whose components fall outside
/// 0–1. Clamping shifts it a shade; the alternative is a string the store reads
/// as NaN and paints black with.
private func designHex(_ color: Color) -> String {
  var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
  _ = UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
  func byte(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
  return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
}

/// The opaque colours in a header style's CSS, in the order they appear.
///
/// Swift renders no CSS, and a grid of identical grey rectangles is a picker
/// nobody can use. Mining the hex out of the string the web tile paints with
/// gets the tile the right COLOURS, which is what a header style is mostly
/// about — the pattern families then differ only by name, and the résumé behind
/// the sheet is the real preview.
///
/// Only the six-digit ones: a pattern lists its accent tint first as a hex with
/// a two-digit alpha suffix, and a tile starting from an 8%-opaque overlay
/// reads as broken.
private func designSwatchColors(in css: String) -> [Color] {
  var tokens: [String] = []
  var current: String?
  for character in css {
    if character == "#" {
      if let pending = current { tokens.append(pending) }
      current = ""
    } else if current != nil, character.isHexDigit {
      current?.append(character)
    } else if let pending = current {
      tokens.append(pending)
      current = nil
    }
  }
  if let pending = current { tokens.append(pending) }
  return tokens.filter { $0.count == 6 }.compactMap(designColor)
}

/// The web swatch's three bands, at the same 135° and the same stops.
private func paletteSwatch(_ palette: Design.Palette) -> some View {
  let accent = designColor(palette.p1) ?? .secondary
  let dark = designColor(palette.p2) ?? .secondary
  let light = designColor(palette.p3) ?? .secondary
  return LinearGradient(
    stops: [
      .init(color: dark, location: 0),
      .init(color: dark, location: 0.4),
      .init(color: accent, location: 0.4),
      .init(color: accent, location: 0.6),
      .init(color: light, location: 0.6),
      .init(color: light, location: 1),
    ],
    startPoint: .topLeading,
    endPoint: .bottomTrailing
  )
}

/// The columns every tile grid in this panel uses. Adaptive rather than a fixed
/// count so the same grid works on a phone and on an iPad's wider sheet.
private let designTileColumns = [GridItem(.adaptive(minimum: 84), spacing: 12)]

/// A tile in one of the pickers: a swatch, its name under it, and a ring when it
/// is the chosen one.
private struct DesignTile<Swatch: View>: View {
  let name: String
  let selected: Bool
  let action: () -> Void
  @ViewBuilder let swatch: () -> Swatch

  var body: some View {
    Button(action: action) {
      VStack(spacing: 6) {
        swatch()
          .frame(height: 44)
          .frame(maxWidth: .infinity)
          .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .strokeBorder(
                selected ? Color.accentColor : Color.primary.opacity(0.12),
                lineWidth: selected ? 2.5 : 0.5
              )
          }
        Text(name)
          .font(.caption)
          .lineLimit(1)
          .foregroundStyle(selected ? Color.primary : Color.secondary)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(name)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}

/// A row that is a choice: its own content, and a checkmark when it is the one
/// in force.
///
/// A `Button` rather than a `Picker` row, because these lists carry a second
/// line of detail — a pairing's two font names, a font's category — and a picker
/// row is one line of text.
private struct DesignChoiceRow<Content: View>: View {
  let selected: Bool
  let action: () -> Void
  @ViewBuilder let content: () -> Content

  var body: some View {
    Button(action: action) {
      HStack {
        content()
        Spacer(minLength: 8)
        if selected {
          Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.accentColor)
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }
}

/// A labelled slider with its readout above the track.
///
/// The web panel puts the label beside the slider. A phone row leaves about
/// 100pt of track once it has, which is not enough to pick a 1% step out of.
private struct DesignSlider: View {
  let title: String
  let readout: String
  let value: Binding<Double>
  let range: ClosedRange<Double>
  var step: Double = 0.01

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      LabeledContent(title) {
        Text(readout).monospacedDigit().foregroundStyle(.secondary)
      }
      Slider(value: value, in: range, step: step)
        .accessibilityLabel(title)
        .accessibilityValue(readout)
    }
    .padding(.vertical, 2)
  }
}

private func designPercent(_ fraction: Double) -> String {
  "\(Int((fraction * 100).rounded()))%"
}

// MARK: design images

/// The longest edge, in pixels, of an image this sends across the bridge.
///
/// Generous enough that a header background still has detail at print
/// resolution, small enough that the data URL — which is stored with the
/// résumé, copied into every backup and re-parsed on every render — stays in
/// the hundreds of kilobytes.
private let designImageMaxEdge: CGFloat = 1600

/// Load a picked image and encode it as a data URL for `setDesignImage`.
private func designImageDataURL(for item: PhotosPickerItem) async -> String? {
  guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
  // Detached: decoding and redrawing a full-resolution photo takes long enough
  // to drop frames, and the picker is dismissing over the top of it.
  return await Task.detached { designEncodedImage(data) }.value
}

/// Downscale and re-encode picked image data.
///
/// Two things rule out passing the picked bytes through untouched. The picker
/// hands back whatever the library holds, which on an iPhone is usually HEIC —
/// WebKit renders it, the Windows build's WebView2 does not, and a résumé
/// travels between them through backup export. And a 12-megapixel photo is
/// ~4MB before base64 inflates it by a third, for an image the résumé draws
/// 100pt wide.
///
/// PNG only when the source actually carries alpha: JPEG fills it black, which
/// on a cut-out header image is the whole point of the file, and PNG on a
/// photograph is several megabytes for nothing.
private func designEncodedImage(_ data: Data) -> String? {
  guard let image = UIImage(data: data) else { return nil }
  let longEdge = max(image.size.width, image.size.height)
  guard longEdge > 0 else { return nil }
  let ratio = min(designImageMaxEdge / longEdge, 1)
  let size = CGSize(
    width: max((image.size.width * ratio).rounded(), 1),
    height: max((image.size.height * ratio).rounded(), 1)
  )

  let format = UIGraphicsImageRendererFormat.default()
  // 1, not the screen's 3: the renderer would otherwise return a bitmap three
  // times the size just asked for, which is the cap undone.
  format.scale = 1
  format.opaque = !designImageHasAlpha(image)
  let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in
    image.draw(in: CGRect(origin: .zero, size: size))
  }

  if format.opaque, let jpeg = scaled.jpegData(compressionQuality: 0.85) {
    return "data:image/jpeg;base64," + jpeg.base64EncodedString()
  }
  guard let png = scaled.pngData() else { return nil }
  return "data:image/png;base64," + png.base64EncodedString()
}

private func designImageHasAlpha(_ image: UIImage) -> Bool {
  guard let info = image.cgImage?.alphaInfo else { return false }
  switch info {
  case .first, .last, .premultipliedFirst, .premultipliedLast, .alphaOnly: return true
  default: return false
  }
}

// MARK: page

private struct PageScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Page")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        Picker("Size", selection: designText(model, "page", "size") { $0.page.size }) {
          ForEach(design.pageSizes) { Text($0.name).tag($0.id) }
        }
        // Width and orientation are alternatives, not both: a continuous page
        // has no second dimension to turn.
        if design.page.size == "continuous" {
          Stepper(
            value: designNumber(model, "page", "widthIn", fallback: 8.5, places: 2) {
              $0.page.widthIn
            },
            in: 3...20,
            step: 0.1
          ) {
            LabeledContent("Width", value: String(format: "%.1f in", design.page.widthIn))
          }
        } else {
          Picker(
            "Orientation",
            selection: designText(model, "page", "orientation") { $0.page.orientation }
          ) {
            Text("Portrait").tag("portrait")
            Text("Landscape").tag("landscape")
          }
          .pickerStyle(.segmented)
        }
      }

      Section {
        Picker(
          "Positions at one employer",
          selection: designFlag(model, "page", "groupPositions") { $0.page.groupPositions }
        ) {
          Text("Grouped").tag(true)
          Text("Separate").tag(false)
        }
        .pickerStyle(.segmented)
        // The label is longer than the row, so it moves to the header and the
        // segments take the full width. It stays here for VoiceOver.
        .labelsHidden()
      } header: {
        Text("Positions at one employer")
      } footer: {
        Text(
          "Grouped puts one heading over every role at the same employer. "
          + "Separate gives each role its own."
        )
      }
    }
  }
}

// MARK: colour

private struct ColorScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Color")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        LazyVGrid(columns: designTileColumns, spacing: 12) {
          ForEach(design.palettes) { palette in
            DesignTile(
              name: palette.name,
              selected: design.color.palette == palette.id,
              action: {
                model.send(
                  "setDesign", ["group": "color", "property": "palette", "value": palette.id]
                )
              },
              swatch: { paletteSwatch(palette) }
            )
          }
        }
        .padding(.vertical, 6)
      } header: {
        Text("Palette")
      }

      Section {
        // Built by hand rather than through `designText`, because it trades in
        // `Color` and not a string — which is exactly how it missed the pin the
        // three helpers carry. The system chooser is a sheet of its own and
        // keeps this binding across a reload.
        ColorPicker(
          "Custom color",
          selection: Binding(
            get: { designColor(model.snapshot.design?.color.customColor ?? "") ?? .accentColor },
            set: { [renderedFor = model.snapshot.whereAmI] color in
              guard renderedFor == model.snapshot.whereAmI else { return }
              model.send(
                "setDesign",
                ["group": "color", "property": "customColor", "value": designHex(color)]
              )
            }
          ),
          supportsOpacity: false
        )
        DesignChoiceRow(
          selected: design.color.palette == "custom",
          action: {
            model.send("setDesign", ["group": "color", "property": "palette", "value": "custom"])
          },
          content: { Text("Use the custom color") }
        )
      } footer: {
        // Two controls rather than one, because that is what the model is: the
        // custom colour is remembered whether or not it is in use, and picking
        // one on the web does not switch the résumé to it either.
        Text(
          design.color.palette == "custom"
            ? "The resume is using your custom color."
            : "Pick a color, then use it — the palette above stays in charge until you do."
        )
      }
    }
  }
}

// MARK: layout

private struct LayoutScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Layout")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        // Names, not thumbnails. Drawing eleven schematics here would mean
        // teaching Swift what each layout looks like — a second description of
        // the templates, free to drift from the ones that render — and the
        // résumé itself is one tap away behind the sheet.
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
          ForEach(design.layouts) { layout in
            let selected = design.layout == layout.id
            Button {
              model.send("setDesign", ["group": "layout", "property": "value", "value": layout.id])
            } label: {
              HStack(spacing: 6) {
                Text(layout.name).lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                  Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                }
              }
              .padding(.horizontal, 12)
              .frame(height: 44)
              .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(selected ? Color.accentColor.opacity(0.10) : Color.clear)
              )
              .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .strokeBorder(
                    selected ? Color.accentColor : Color.primary.opacity(0.12),
                    lineWidth: selected ? 2 : 0.5
                  )
              }
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? [.isSelected] : [])
          }
        }
        .padding(.vertical, 6)
      } footer: {
        Text("The resume behind this sheet re-renders as you tap.")
      }
    }
  }
}

// MARK: header

private struct HeaderScreen: View {
  @ObservedObject var model: ShellModel

  @State private var pick: PhotosPickerItem?
  @State private var confirmRemove = false
  /// The picked photo could not be read. Kept in the SCREEN, unlike the sync
  /// guards and the key's refusal: this says "the image you just chose did not
  /// load", which is only meaningful to somebody still looking at the screen
  /// they chose it on. A person who navigated away has nothing to act on.
  @State private var loadFailed = false
  /// The résumé AND workspace the removal prompt was raised for.
  ///
  /// The prompt is an unbounded wait and `clearDesignImage` carries no id — it
  /// clears whatever is open when it arrives. A CloudKit tombstone for this
  /// résumé loads a replacement without closing this sheet or the prompt on top
  /// of it, so Remove deleted the replacement's image instead.
  ///
  /// The workspace for the same reason the picked-image token carries one: a
  /// résumé id is unique only within a workspace, and two can legitimately hold
  /// the same one.
  @State private var removeFrom: ShellSnapshot.Where?

  var body: some View {
    Form { content }
      .navigationTitle("Header")
      .navigationBarTitleDisplayMode(.inline)
      .onChange(of: pick) { _, item in
        guard let item else { return }
        // STAMPED, and the stamp is checked on the way out. Reading a photo out
        // of the library is asynchronous and the screen stays live throughout,
        // so two picks overlap and the one that lands is whichever the LIBRARY
        // finished first — an earlier, larger photo could arrive after a newer
        // one and replace it. Remove bumps it too: without that, a pick still in
        // flight when the image is removed comes back and undoes the removal.
        let request = model.beginImageRequest("header")
        Task {
          let url = await designImageDataURL(for: item)
          // Cleared either way, or picking the same photo twice in a row is the
          // same item and never fires this again. NOT gated on the stamp below:
          // a stale task clearing the binding is harmless — the newer task
          // clears it to the same nil — while a stale task that skipped this
          // could leave `pick` holding a photo the user then cannot re-pick.
          pick = nil
          // CURRENCY FIRST, before the outcome is acted on either way. A
          // superseded request has nothing to say: it must not write its image,
          // and it must not report a failure either — the person has since
          // picked something else or removed the image, and telling them "that
          // photo could not be read" would be about a choice they have already
          // replaced.
          guard model.isCurrentImageRequest(request) else { return }
          guard let url else {
            // SAID, not only logged. `loadTransferable` fails on an iCloud photo
            // that cannot be downloaded — offline, or the library is still
            // fetching it — and a silent return leaves the screen exactly as it
            // was, which is indistinguishable from a pick that never registered.
            NSLog("[OPShell] could not read the picked header image")
            loadFailed = true
            return
          }
          model.send("setDesignImage", ["target": "header", "dataUrl": url])
        }
      }
      .alert("That photo could not be read", isPresented: $loadFailed) {
        Button("OK", role: .cancel) {}
      } message: {
        Text("It may still be downloading from iCloud. Try again, or pick another one.")
      }
      .confirmationDialog(
        "Remove the header image?", isPresented: $confirmRemove, titleVisibility: .visible
      ) {
        Button("Remove", role: .destructive) {
          guard removeFrom == model.snapshot.whereAmI else {
            removeFrom = nil
            return
          }
          removeFrom = nil
          model.beginImageRequest("header")
          model.send("clearDesignImage", ["target": "header"])
        }
      } message: {
        Text("The header goes back to a gradient. The image is not kept.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        DesignChoiceRow(
          selected: design.header.type == "solid",
          action: { selectStyle(type: "solid", id: "solid") },
          content: { Text("Solid color") }
        )
      } footer: {
        Text("The header takes the palette's own color, with nothing over it.")
      }

      ForEach(styleGroups(design), id: \.self) { group in
        Section(groupTitle(group)) {
          LazyVGrid(columns: designTileColumns, spacing: 12) {
            ForEach(design.headerStyles.filter { $0.group == group }) { style in
              DesignTile(
                name: style.name,
                selected: design.header.type == group && design.header.styleId == style.id,
                action: { selectStyle(type: group, id: style.id) },
                swatch: { styleSwatch(style) }
              )
            }
          }
          .padding(.vertical, 6)
        }
      }

      Section {
        // No `photoLibrary:` argument, so the picker runs out of process: it
        // needs neither a permission prompt nor an `NSPhotoLibraryUsageDescription`
        // in an Info.plist this file does not own, and it still hands back the
        // one image that was chosen.
        PhotosPicker(selection: $pick, matching: .images) {
          Label(
            design.header.hasImage ? "Replace image" : "Add an image",
            systemImage: "photo.on.rectangle"
          )
        }
        if design.header.hasImage {
          DesignSlider(
            title: "Opacity",
            readout: designPercent(design.header.imageOpacity),
            value: designNumber(model, "header", "imageOpacity", fallback: 0.3, places: 2) {
              $0.header.imageOpacity
            },
            range: 0...1
          )
          Picker(
            "Fit",
            selection: designText(model, "header", "imageFit") { $0.header.imageFit }
          ) {
            Text("Cover").tag("cover")
            Text("Contain").tag("contain")
            Text("Tile").tag("tile")
          }
          .pickerStyle(.segmented)
          Button("Remove image", role: .destructive) {
            removeFrom = model.snapshot.whereAmI
            confirmRemove = true
          }
        }
      } header: {
        Text("Image")
      } footer: {
        // No preview of the image itself: the contract carries `hasImage` and
        // not the data URL, on purpose — a header background is a megabyte of
        // base64 and re-sending it on every design write would be the largest
        // thing on this wire by an order of magnitude.
        Text("An image sits behind the header at the opacity you choose, and is saved with the resume.")
      }
    }
  }

  /// The groups the contract sent, in the order it sent them.
  private func styleGroups(_ design: Design) -> [String] {
    var groups: [String] = []
    for style in design.headerStyles where !groups.contains(style.group) {
      groups.append(style.group)
    }
    return groups
  }

  /// gradient → Gradients. The contract's group ids are already the words.
  private func groupTitle(_ group: String) -> String {
    group.capitalized + "s"
  }

  private func selectStyle(type: String, id: String) {
    model.send("setDesign", ["group": "header", "property": "style", "value": "\(type):\(id)"])
  }

  @ViewBuilder
  private func styleSwatch(_ style: Design.HeaderStyle) -> some View {
    let colors = designSwatchColors(in: style.css)
    if colors.count >= 2 {
      LinearGradient(
        colors: Array(colors.prefix(3)), startPoint: .topLeading, endPoint: .bottomTrailing
      )
    } else if let only = colors.first {
      only
    } else {
      Color.secondary.opacity(0.2)
    }
  }
}

// MARK: typography

private struct TypographyScreen: View {
  @ObservedObject var model: ShellModel

  var body: some View {
    Form { content }
      .navigationTitle("Typography")
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        ForEach(design.fontPairings) { pairing in
          DesignChoiceRow(
            selected: design.fonts.mode == "preset" && design.fonts.pairingId == pairing.id,
            action: {
              model.send(
                "setDesign", ["group": "fonts", "property": "pairing", "value": pairing.id]
              )
            },
            content: {
              VStack(alignment: .leading, spacing: 2) {
                Text(pairing.name)
                Text("\(pairing.display) + \(pairing.body)")
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
            }
          )
        }
      } header: {
        Text("Pairings")
      } footer: {
        Text("A pairing sets both fonts at once. Choosing either font below leaves it.")
      }

      Section("Fonts") {
        NavigationLink {
          FontScreen(model: model, role: "display", title: "Headings")
        } label: {
          LabeledContent("Headings", value: fontLabel(design.fonts.displayName))
        }
        NavigationLink {
          FontScreen(model: model, role: "body", title: "Body")
        } label: {
          LabeledContent("Body", value: fontLabel(design.fonts.bodyName))
        }
      }
    }
  }

  private func fontLabel(_ value: String) -> String {
    value.isEmpty ? "Default" : value
  }
}

private struct FontScreen: View {
  @ObservedObject var model: ShellModel
  /// "display" or "body" — the `setDesign` property, carried rather than
  /// derived, so this screen never has to know which of the two it is.
  let role: String
  let title: String

  @State private var query = ""

  var body: some View {
    List { content }
      // Filtered here rather than by a round trip, unlike the library's search:
      // the whole catalogue is a few dozen names and it is already in hand.
      .searchable(text: $query, prompt: "Search fonts")
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      // The contract sends the font's NAME, not the id it was chosen by, so
      // that is what the checkmark matches on. It is the only handle there is,
      // and it is enough: two fonts with one name are one font.
      let current = role == "display" ? design.fonts.displayName : design.fonts.bodyName
      let systemFonts = design.systemFonts.filter { matches($0.name) }
      let googleFonts = design.googleFonts.filter { matches($0.family) }

      if systemFonts.isEmpty, googleFonts.isEmpty {
        ContentUnavailableView.search(text: query)
      }

      if !systemFonts.isEmpty {
        Section {
          ForEach(systemFonts) { font in
            DesignChoiceRow(
              selected: font.name == current,
              action: { select("system:\(font.id)") },
              content: { Text(font.name) }
            )
          }
        } header: {
          Text("System")
        } footer: {
          Text("System fonts work offline and render the same on every device.")
        }
      }

      if !googleFonts.isEmpty {
        Section("Google Fonts") {
          ForEach(googleFonts) { font in
            DesignChoiceRow(
              selected: font.family == current,
              action: { select("google:\(font.family):\(font.category)") },
              content: {
                HStack(spacing: 8) {
                  Text(font.family)
                  Text(font.category).font(.caption).foregroundStyle(.secondary)
                }
              }
            )
          }
        }
      }
    }
  }

  private func matches(_ name: String) -> Bool {
    query.isEmpty || name.localizedCaseInsensitiveContains(query)
  }

  private func select(_ value: String) {
    model.send("setDesign", ["group": "fonts", "property": role, "value": value])
  }
}

// MARK: spacing

private struct SpacingScreen: View {
  @ObservedObject var model: ShellModel

  @State private var confirmReset = false
  /// The workspace the reset prompt was raised for.
  ///
  /// `resetDesign` names a group and no workspace, so it writes the defaults
  /// into whichever one is open when it arrives. A CloudKit tombstone for this
  /// workspace loads a replacement and reloads the webview WITHOUT closing this
  /// sheet — its `@State` outlives the reload — so Reset would blank the design
  /// of a workspace the person never opened.
  @State private var resetFrom: ShellSnapshot.Where?

  var body: some View {
    Form { content }
      .navigationTitle("Spacing")
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog(
        "Reset spacing?", isPresented: $confirmReset, titleVisibility: .visible
      ) {
        Button("Reset", role: .destructive) {
          guard resetFrom == model.snapshot.whereAmI else {
            resetFrom = nil
            return
          }
          resetFrom = nil
          model.send("resetDesign", ["group": "spacing"])
        }
      } message: {
        Text("Every size and margin here goes back to its default. Your text is not affected.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        Picker(
          "Preset",
          selection: designText(model, "spacing", "preset") { $0.spacing.presetId }
        ) {
          ForEach(design.spacingPresets) { Text($0.name).tag($0.id) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
      } header: {
        Text("Preset")
      } footer: {
        // "" arrives once a slider has been moved off every preset, and no
        // segment being lit is then the truth: the spacing is none of them.
        Text(
          design.spacing.presetId.isEmpty
            ? "Fine-tuned — no preset is in force."
            : "A preset sets everything below at once."
        )
      }

      Section("Fine tune") {
        DesignSlider(
          title: "Font size",
          readout: designPercent(design.spacing.fontScale),
          value: designNumber(model, "spacing", "fontScale", fallback: 1, places: 2) {
            $0.spacing.fontScale
          },
          range: 0.7...1.3
        )
        DesignSlider(
          title: "Line height",
          readout: String(format: "%.2f", design.spacing.lineHeight),
          value: designNumber(model, "spacing", "lineHeight", fallback: 1.45, places: 2) {
            $0.spacing.lineHeight
          },
          range: 1.2...1.8
        )
        DesignSlider(
          title: "Section gap",
          readout: String(format: "%.1f rem", design.spacing.sectionSpacing),
          value: designNumber(model, "spacing", "sectionSpacing", fallback: 0.8, places: 1) {
            $0.spacing.sectionSpacing
          },
          range: 0.4...1.6,
          step: 0.1
        )
        DesignSlider(
          title: "Sidebar width",
          readout: String(format: "%.1f in", design.spacing.sidebarWidth),
          value: designNumber(model, "spacing", "sidebarWidth", fallback: 2.2, places: 1) {
            $0.spacing.sidebarWidth
          },
          range: 1.8...3.2,
          step: 0.1
        )
      }

      Section {
        marginStepper("Top", "marginTop") { $0.spacing.marginTop }
        marginStepper("Right", "marginRight") { $0.spacing.marginRight }
        marginStepper("Bottom", "marginBottom") { $0.spacing.marginBottom }
        marginStepper("Left", "marginLeft") { $0.spacing.marginLeft }
      } header: {
        Text("Page margins")
      } footer: {
        Text("Sidebar width and margins apply to the layouts that have them.")
      }

      Section {
        // Behind a dialog, where the desktop has a 28pt ghost icon in a section
        // header. On a phone an unconfirmed reset is one mis-tap away from an
        // hour of fitting a résumé onto one page.
        Button("Reset spacing", role: .destructive) {
          resetFrom = model.snapshot.whereAmI
          confirmReset = true
        }
      }
    }
  }

  private func marginStepper(
    _ title: String, _ property: String, _ read: @escaping (Design) -> Double
  ) -> some View {
    Stepper(
      value: designNumber(model, "spacing", property, fallback: 0.5, places: 2, read),
      in: 0.2...1.0,
      step: 0.1
    ) {
      LabeledContent(
        title, value: String(format: "%.1f in", model.snapshot.design.map(read) ?? 0.5)
      )
    }
  }
}

// MARK: accents

private struct AccentsScreen: View {
  @ObservedObject var model: ShellModel

  @State private var confirmReset = false
  /// The workspace the reset prompt was raised for.
  ///
  /// `resetDesign` names a group and no workspace, so it writes the defaults
  /// into whichever one is open when it arrives. A CloudKit tombstone for this
  /// workspace loads a replacement and reloads the webview WITHOUT closing this
  /// sheet — its `@State` outlives the reload — so Reset would blank the design
  /// of a workspace the person never opened.
  @State private var resetFrom: ShellSnapshot.Where?

  var body: some View {
    Form { content }
      .navigationTitle("Accents")
      .navigationBarTitleDisplayMode(.inline)
      .confirmationDialog(
        "Reset accents?", isPresented: $confirmReset, titleVisibility: .visible
      ) {
        Button("Reset", role: .destructive) {
          guard resetFrom == model.snapshot.whereAmI else {
            resetFrom = nil
            return
          }
          resetFrom = nil
          model.send("resetDesign", ["group": "accent"])
        }
      } message: {
        Text("Underlines, bullets, corners and skill tags all go back to their defaults.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section("Section titles") {
        Picker(
          "Underline",
          selection: designText(model, "accent", "underlineStyle") { $0.accent.underlineStyle }
        ) {
          ForEach(design.underlines) { Text($0.name).tag($0.id) }
        }
        DesignSlider(
          title: "Underline width",
          readout: "\(Int(design.accent.underlineWidth.rounded()))px",
          value: designNumber(model, "accent", "underlineWidth", fallback: 2, places: 0) {
            $0.accent.underlineWidth
          },
          range: 1...4,
          step: 1
        )
      }

      Section("Lists") {
        Picker(
          "Bullet",
          selection: designText(model, "accent", "bulletStyle") { $0.accent.bulletStyle }
        ) {
          // The glyph in front of the name, so the row shows what the résumé
          // will show. "None" has no glyph to show.
          ForEach(design.bullets) { bullet in
            Text(bullet.char.isEmpty ? bullet.name : "\(bullet.char)  \(bullet.name)")
              .tag(bullet.id)
          }
        }
      }

      Section("Shapes") {
        Picker(
          "Corner rounding",
          selection: designText(model, "accent", "borderRadius") { $0.accent.borderRadius }
        ) {
          ForEach(design.radii) { Text($0.name).tag($0.id) }
        }
        Picker(
          "Skill tags",
          selection: designText(model, "accent", "skillTagStyle") { $0.accent.skillTagStyle }
        ) {
          ForEach(design.skillTags) { Text($0.name).tag($0.id) }
        }
      }

      Section("Decoration") {
        Toggle(
          "Header corner accent",
          isOn: designFlag(model, "accent", "showCornerTriangle") { $0.accent.showCornerTriangle }
        )
        Toggle(
          "Sidebar gradient",
          isOn: designFlag(model, "accent", "showSidebarGradient") { $0.accent.showSidebarGradient }
        )
      }

      Section {
        Button("Reset accents", role: .destructive) {
          resetFrom = model.snapshot.whereAmI
          confirmReset = true
        }
      }
    }
  }
}

// MARK: photo

/// The nine `object-position` values, in reading order.
///
/// These are not on the wire and do not need to be: the pad's geometry IS the
/// value — top left is the button in the top left corner — so a list of ids
/// would not tell this screen anything the grid does not already say.
private let designFocusPositions = [
  "left top", "center top", "right top",
  "left center", "center center", "right center",
  "left bottom", "center bottom", "right bottom",
]

private struct PhotoScreen: View {
  @ObservedObject var model: ShellModel

  @State private var pick: PhotosPickerItem?
  @State private var confirmRemove = false
  /// The picked photo could not be read. Kept in the SCREEN, unlike the sync
  /// guards and the key's refusal: this says "the image you just chose did not
  /// load", which is only meaningful to somebody still looking at the screen
  /// they chose it on. A person who navigated away has nothing to act on.
  @State private var loadFailed = false
  /// The résumé AND workspace the removal prompt was raised for.
  ///
  /// The prompt is an unbounded wait and `clearDesignImage` carries no id — it
  /// clears whatever is open when it arrives. A CloudKit tombstone for this
  /// résumé loads a replacement without closing this sheet or the prompt on top
  /// of it, so Remove deleted the replacement's image instead.
  ///
  /// The workspace for the same reason the picked-image token carries one: a
  /// résumé id is unique only within a workspace, and two can legitimately hold
  /// the same one.
  @State private var removeFrom: ShellSnapshot.Where?

  var body: some View {
    Form { content }
      .navigationTitle("Photo")
      .navigationBarTitleDisplayMode(.inline)
      .onChange(of: pick) { _, item in
        guard let item else { return }
        // Stamped and checked, exactly as on the header screen — the reasoning
        // is written out there. The two picks are the same code because they are
        // the same problem, and this one is the reason the header's is not a
        // one-off.
        let request = model.beginImageRequest("photo")
        Task {
          let url = await designImageDataURL(for: item)
          pick = nil
          // Currency first, as on the header screen — a superseded request has
          // nothing to say, not even that it failed.
          guard model.isCurrentImageRequest(request) else { return }
          guard let url else {
            // Said rather than only logged, as on the header screen.
            NSLog("[OPShell] could not read the picked photo")
            loadFailed = true
            return
          }
          model.send("setDesignImage", ["target": "photo", "dataUrl": url])
        }
      }
      .alert("That photo could not be read", isPresented: $loadFailed) {
        Button("OK", role: .cancel) {}
      } message: {
        Text("It may still be downloading from iCloud. Try again, or pick another one.")
      }
      .confirmationDialog(
        "Remove the photo?", isPresented: $confirmRemove, titleVisibility: .visible
      ) {
        Button("Remove", role: .destructive) {
          guard removeFrom == model.snapshot.whereAmI else {
            removeFrom = nil
            return
          }
          removeFrom = nil
          model.beginImageRequest("photo")
          model.send("clearDesignImage", ["target": "photo"])
        }
      } message: {
        Text("The photo is deleted from this resume. Adding one again means picking it again.")
      }
  }

  @ViewBuilder
  private var content: some View {
    if let design = model.snapshot.design {
      Section {
        // Out of process, as on the header screen — no permission, no plist.
        PhotosPicker(selection: $pick, matching: .images) {
          Label(
            design.photo.hasImage ? "Replace photo" : "Add a photo",
            systemImage: "person.crop.square"
          )
        }
        if design.photo.hasImage {
          Toggle("Show the photo", isOn: designFlag(model, "photo", "enabled") { $0.photo.enabled })
          Button("Remove photo", role: .destructive) {
            removeFrom = model.snapshot.whereAmI
            confirmRemove = true
          }
        }
      } footer: {
        Text(
          design.photo.hasImage
            ? "The photo is stored with this resume and travels with its backup."
            : "Photos suit some templates and some countries. Many hiring processes prefer none."
        )
      }

      if design.photo.hasImage {
        Section("Placement") {
          Picker(
            "Position",
            selection: designText(model, "photo", "placement") { $0.photo.placement }
          ) {
            ForEach(design.placements) { Text($0.name).tag($0.id) }
          }
          Picker("Shape", selection: designText(model, "photo", "shape") { $0.photo.shape }) {
            ForEach(design.shapes) { Text($0.name).tag($0.id) }
          }
          Picker("Size", selection: designText(model, "photo", "size") { $0.photo.size }) {
            ForEach(design.sizes) { Text($0.name).tag($0.id) }
          }
          Picker(
            "Border",
            selection: designText(model, "photo", "borderColor") { $0.photo.borderColor }
          ) {
            Text("Accent").tag("accent")
            Text("White").tag("white")
            Text("None").tag("none")
          }
        }

        Section {
          focusPad(design)
          DesignSlider(
            title: "Zoom",
            readout: designPercent(design.photo.scale),
            value: designNumber(model, "photo", "scale", fallback: 1, places: 2) { $0.photo.scale },
            range: 1...2
          )
        } header: {
          Text("Crop")
        } footer: {
          Text("The focus point decides which part of the photo survives the crop.")
        }
      }
    }
  }

  private func focusPad(_ design: Design) -> some View {
    LazyVGrid(
      columns: Array(repeating: GridItem(.fixed(40), spacing: 8), count: 3), spacing: 8
    ) {
      ForEach(designFocusPositions, id: \.self) { position in
        let selected = design.photo.objectPosition == position
        Button {
          model.send(
            "setDesign", ["group": "photo", "property": "objectPosition", "value": position]
          )
        } label: {
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
            .frame(width: 40, height: 40)
            .overlay {
              Circle()
                .fill(selected ? Color.accentColor : Color.secondary)
                .frame(width: 8, height: 8)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(position.capitalized)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 4)
  }
}

/// Managing the account's workspaces, and what it holds.
///
/// The iOS counterpart of desktop's Settings → Account, and deliberately the
/// same three things in the same order: which workspaces exist, what you can do
/// to them, and the numbers for the one that is open. Switching is NOT here —
/// it is one tap in the menu that opened this — so the sheet is for the actions
/// that deserve a confirmation step.
private struct ProfilesSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  /// The workspace being renamed, and its draft. Held here rather than per row
  /// so only one row can be in edit mode at a time.
  @State private var renamingId: String?
  @State private var draftName = ""
  @State private var pendingDelete: ShellProfile?


  private var profiles: [ShellProfile] { model.snapshot.profiles }
  private var active: ShellProfile? { profiles.first(where: \.isActive) }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          ForEach(profiles) { profile in
            row(for: profile)
          }
        } header: {
          Text("Profiles")
        } footer: {
          Text("Separate profiles — each keeps its own résumés, job descriptions, "
               + "applications and chats. Everything here syncs across your devices.")
        }

        if let stats = model.snapshot.accountStats {
          Section {
            LabeledContent("Résumés", value: "\(stats.resumes)")
            LabeledContent("Job descriptions", value: "\(stats.jobDescriptions)")
            LabeledContent("Applications sent", value: "\(stats.applications)")
            LabeledContent("Response rate", value: stats.responseRate)
            LabeledContent("Interview rate", value: stats.interviewRate)
            LabeledContent("Median to hear back", value: stats.medianDaysToResponse)
          } header: {
            // Named for the workspace it describes, because these numbers are
            // NOT the account's — every workspace keeps its own applications.
            Text(active.map { "\($0.name) holds" } ?? "This profile holds")
          }
        }
      }
      .navigationTitle("Profiles")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
      // The same shape as renaming a résumé — an alert with the current name in
      // it — rather than an inline field that turned the row into a form and
      // gave a "Save" button no room to say anything when it failed.
      .alert("Rename profile", isPresented: renameBinding) {
        TextField("Name", text: $draftName)
          .textInputAutocapitalization(.words)
        Button("Cancel", role: .cancel) { renamingId = nil }
        Button("Rename", action: submitRename)
          .disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .alert("Delete profile?", isPresented: deleteBinding, presenting: pendingDelete) { profile in
        Button("Delete", role: .destructive) {
          Task {
            if !(await model.deleteProfile(profile.id)) {
              model.profileActionFailure =
                "Could not delete \(profile.name) — the change didn't reach disk."
            }
          }
        }
        Button("Cancel", role: .cancel) {}
      } message: { profile in
        // Says what is actually lost. "Delete workspace?" alone reads as
        // tidying a label, and this is every résumé inside it.
        Text("\(profile.name) and everything in it — résumés, job descriptions, "
             + "applications and chats — will be deleted on all your devices.")
      }
      .alert(
        "Couldn't save", isPresented: failureBinding, presenting: model.profileActionFailure
      ) { _ in
        Button("OK", role: .cancel) {}
      } message: { message in
        Text(message)
      }
    }
  }

  private func row(for profile: ShellProfile) -> some View {
    HStack {
      Text(profile.name)
      if profile.isActive {
        Text("Open")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      Spacer()

      // AN EXPLICIT BUTTON, not a swipe. The actions were behind a leftward
      // swipe on the row, which is a gesture nothing on the screen advertises —
      // so renaming a profile was a feature you had to already know about.
      Menu {
        Button { renamingId = profile.id; draftName = profile.name } label: {
          Label("Rename…", systemImage: "pencil")
        }
        // Delete is offered for every profile EXCEPT the open one, and only
        // when there is somewhere to go: deleting the profile you are looking
        // at leaves the app with no mapping and nothing on screen, and the last
        // one has no replacement at all. Switching away first is one tap in the
        // menu that opened this sheet.
        if !profile.isActive && profiles.count > 1 {
          Button(role: .destructive) { pendingDelete = profile } label: {
            Label("Delete…", systemImage: "trash")
          }
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          // The glyph alone is a thin target in the middle of a row that is
          // otherwise inert; this is the whole trailing end of the row.
          .frame(width: 44, height: 32)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Actions for \(profile.name)")
    }
  }

  private func submitRename() {
    guard let id = renamingId else { return }
    let name = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return }
    renamingId = nil
    Task {
      if !(await model.renameProfile(id, to: name)) {
        model.profileActionFailure = "Could not rename — the change didn't reach disk."
      }
    }
  }

  private var renameBinding: Binding<Bool> {
    Binding(get: { renamingId != nil }, set: { if !$0 { renamingId = nil } })
  }

  private var deleteBinding: Binding<Bool> {
    Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
  }

  private var failureBinding: Binding<Bool> {
    Binding(
      get: { model.profileActionFailure != nil },
      set: { if !$0 { model.profileActionFailure = nil } }
    )
  }
}
