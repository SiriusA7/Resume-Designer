// The Jobs sheet.
//
// A separate file from OPShell.swift, which is the shell itself: this one owns
// only the job-descriptions screen. `project.yml` adds `../../ios` as a source
// path, so anything here compiles with no further wiring.
//
// Its JS counterpart is src/jobsBridge.js.
//
// Three things about this screen are worth knowing before changing it:
//
//   1. Nothing here confirms a delete through the web. `confirmDestructive()`
//      opens a Radix alert dialog INSIDE the webview, which is behind this
//      sheet: the user sees nothing and the promise never settles. The
//      confirmation is the `.confirmationDialog` below and the bridge action
//      deletes unconditionally.
//   2. The sheet renders from the projection and holds no truth of its own.
//      Which recommendations are applied, whether a run is going, what it has
//      reasoned so far — all of it comes back from `buildJobs()`, so a write
//      that was refused simply never appears.
//   3. A run publishes only twice on its own (when it starts and when it
//      settles), so `pollWhileRunning` asks for a fresh snapshot every second
//      while one is in flight. Without it the reasoning would arrive in one
//      lump at the end and a 40-second request would look frozen.

import SwiftUI
import UIKit

// MARK: - Wire contract

/// Mirrors `buildJobs()` in src/jobsBridge.js. Changing either side without the
/// other empties the sheet — this decodes as ONE struct, so a single missing
/// field takes the whole screen with it.
struct JobsView: Decodable, Equatable {
  struct Job: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let company: String
    /// The first 150 characters of the posting. The posting itself is multi-KB
    /// and this snapshot is re-posted on every canvas mutation, so the full text
    /// crosses for one job at a time, in `draft`.
    let preview: String
    /// Raw ISO. iOS formats it in the user's language, which the web card's
    /// hand-rolled "today"/"yesterday" cannot.
    let dateAdded: String
    let isActive: Bool
  }

  struct ModelOption: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let group: String
  }

  struct Run: Decodable, Equatable {
    let busy: Bool
    /// analyze | tailor, or "" when idle.
    let op: String
    /// Raw reasoning summary, unparsed — `ReasoningTimeline` splits and strips
    /// it. It is also the ONLY live feedback either call produces: neither wires
    /// a content hook, so with reasoning off nothing streams at all.
    let reasoning: String
  }

  /// A one-shot message from the last action: error | info, or "" for nothing.
  /// It rides exactly one snapshot (the JS read consumes it), so the sheet
  /// latches it rather than rendering it directly.
  struct Notice: Decodable, Equatable {
    let kind: String
    let text: String
  }

  /// The job being added or edited. "" id means a new one; Swift echoes the id
  /// back and never invents one.
  struct Draft: Decodable, Equatable {
    let id: String
    let title: String
    let company: String
    let description: String
  }

  struct RunMeta: Decodable, Equatable {
    let model: String
    let reasoningTokens: Int
    let promptTokens: Int
    let completionTokens: Int
    let cost: Double
    let webSearch: Bool
    let finishReason: String
  }

  struct Analysis: Decodable, Equatable {
    struct Gap: Decodable, Equatable, Identifiable {
      let id: Int
      let area: String
      let issue: String
      let suggestion: String
    }
    struct Recommendation: Decodable, Equatable, Identifiable {
      /// Its position in `analysis.recommendations` — NOT its position in the
      /// impact-sorted list this screen renders. Apply is addressed by this.
      let index: Int
      let impact: String
      let section: String
      let current: String
      let suggested: String
      let reason: String
      /// A hover tooltip on the web, so unreachable on a phone. It is shown as
      /// ordinary copy here.
      let impactReason: String
      var id: Int { index }
    }
    let matchScore: Int
    let keywordMatches: [String]
    let missingKeywords: [String]
    let strengths: [String]
    let gaps: [Gap]
    let recommendations: [Recommendation]
  }

  var jobs: [Job]
  var activeCount: Int
  var configured: Bool
  /// The last write did not reach storage. The web answers this with a toast,
  /// which nothing renders under the native shell.
  var saveFailed: Bool
  var models: [ModelOption]
  var analysisModelId: String
  var analysisReasoning: String
  var tailorModelId: String
  var tailorReasoning: String
  var analysis: Analysis?
  /// Which report `analysis` is, for `applyRecommendation` to echo back. Read
  /// off THIS projection because it is the one live while the sheet is open —
  /// see the note beside it in `getJobsState`.
  var revision: Int
  var appliedIndexes: [Int]
  var lastRun: RunMeta?
  var run: Run
  var notice: Notice
  /// The tailored changes went to the WEB review dialog. Nothing dismisses a
  /// presented sheet on its own, so this is how the review gets the screen.
  var handoff: Bool
  var draft: Draft?
}

/// Every jobs command is one `jobsAction`, so this is the only shape they take.
private extension ShellModel {
  /// `action`, not `type`: `send` writes the COMMAND name into `type` after
  /// copying this payload, so a nested `type` is overwritten before it leaves
  /// and every action would arrive as "jobsAction".
  func jobs(_ action: String, _ extra: [String: String] = [:]) {
    var body = extra
    body["action"] = action
    send("jobsAction", body)
  }
}

/// The four efforts this screen offers. Chat's list is wider; these are not it.
private let jobsReasoningOptions: [(id: String, label: String)] = [
  ("none", "Off"), ("low", "Low"), ("medium", "Medium"), ("high", "High"),
]

/// Shown while a write is not reaching storage. Deliberately the same words as
/// the profile sheet's: it is the same failure, and two descriptions of it
/// would read as two different problems.
private struct JobsSaveWarning: View {
  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text("Not being saved").font(.subheadline.weight(.semibold))
        Text("Storage is full, so these jobs are not on disk. Free up space — reloading now would lose them.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
    }
    .padding(.vertical, 2)
  }
}

// MARK: - Root

struct JobsSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  /// Which rows have their preview open — the web card's chevron. Nothing about
  /// it belongs on the wire.
  @State private var expanded: Set<String> = []
  @State private var pendingDelete: JobsView.Job?
  /// The workspace that prompt was raised in. See the dialog's own comment.
  @State private var deleteFrom: ShellSnapshot.Where?
  @State private var editor: Editor?
  /// Latched from the one-shot `notice`, so a run that failed while the sheet
  /// was closed still says so the next time it is opened.
  @State private var alert: JobsView.Notice?

  enum Editor: Hashable, Identifiable {
    case new
    case existing(String)
    var id: String {
      switch self {
      case .new: return ""
      case .existing(let jobId): return jobId
      }
    }
  }

  private var view: JobsView? { model.snapshot.jobs }

  var body: some View {
    NavigationStack {
      Group {
        if let view {
          if view.jobs.isEmpty {
            ContentUnavailableView {
              Label("No jobs yet", systemImage: "briefcase")
            } description: {
              Text("Save the postings you are targeting, then measure your resume against them.")
            } actions: {
              Button("Add a job") { openEditor(.new) }
            }
          } else {
            list(view)
          }
        } else {
          // The first snapshot lands a frame after the sheet opens; an empty
          // list would read as "you have no saved jobs".
          ProgressView()
        }
      }
      .navigationTitle("Jobs")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button { openEditor(.new) } label: { Image(systemName: "plus") }
            .accessibilityLabel("Add a job")
        }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .navigationDestination(item: $editor) { target in
        JobEditorScreen(model: model, target: target)
      }
      .confirmationDialog(
        "Delete this job description?",
        isPresented: .init(
          get: { pendingDelete != nil },
          set: { if !$0 { pendingDelete = nil } }
        ),
        titleVisibility: .visible
      ) {
        Button("Delete", role: .destructive) {
          guard let job = pendingDelete else { return }
          pendingDelete = nil
          // A job id is unique only inside a workspace, and one backup imported
          // into two produces the same ids in both — so after a tombstone
          // reloads the page under this sheet, deleting by id alone removes an
          // unrelated job from the replacement.
          guard deleteFrom == model.snapshot.whereAmI else {
            deleteFrom = nil
            return
          }
          deleteFrom = nil
          model.jobs("deleteJob", ["id": job.id])
        }
      } message: {
        Text("This permanently removes it from your saved jobs.")
      }
      .alert(
        alert?.kind == "error" ? "Something went wrong" : "Nothing to change",
        isPresented: .init(get: { alert != nil }, set: { if !$0 { alert = nil } })
      ) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(alert?.text ?? "")
      }
      // `initial: true` on both: the projection's one-shot fields are consumed
      // by the read that sends them, so the value can already be in the FIRST
      // snapshot this view sees — and a plain onChange would never fire for it.
      .onChange(of: view?.notice, initial: true) { _, now in
        guard let now, !now.text.isEmpty else { return }
        alert = now
      }
      .onChange(of: view?.handoff, initial: true) { _, now in
        // The tailored changes went to the web diff dialog, which renders in the
        // webview BEHIND this sheet. Getting out of its way is the whole point.
        if now == true { dismiss() }
      }
      .task(id: view?.run.busy ?? false) { await pollWhileRunning() }
      // ShellView's own teardown stops the stream; this tells the bridge the
      // sheet is gone, which is what stops a tailor that finished after the
      // dismissal from dismissing the sheet again when it is next opened.
      .onDisappear { model.jobs("closed") }
    }
    .presentationDetents([.large])
  }

  private func list(_ view: JobsView) -> some View {
    List {
      // First, and not a one-shot notice: a full disk stays full, and a job
      // that is only in memory is one relaunch from being gone.
      if view.saveFailed {
        Section { JobsSaveWarning() }
      }

      Section {
        ForEach(view.jobs) { row($0) }
      } header: {
        Text(view.jobs.count == 1 ? "1 job" : "\(view.jobs.count) jobs")
      } footer: {
        Text("\(view.activeCount) active. Tailoring uses the active ones; analysis lets you pick.")
      }

      Section {
        if view.run.busy {
          runProgress(view.run)
        } else {
          NavigationLink {
            AnalyzeScreen(model: model)
          } label: {
            Label("Analyze resume fit", systemImage: "magnifyingglass")
          }
          .disabled(!view.configured)

          NavigationLink {
            TailorScreen(model: model)
          } label: {
            Label("Tailor resume", systemImage: "wand.and.stars")
          }
          .disabled(!view.configured || view.activeCount == 0)
        }
      } header: {
        Text("Analysis")
      } footer: {
        Text(analysisFooter(view))
      }

      if let analysis = view.analysis {
        Section {
          NavigationLink {
            AnalysisScreen(model: model)
          } label: {
            HStack(spacing: 14) {
              Gauge(value: Double(analysis.matchScore), in: 0...100) {
                EmptyView()
              } currentValueLabel: {
                Text("\(analysis.matchScore)")
              }
              .gaugeStyle(.accessoryCircularCapacity)
              .scaleEffect(0.8)
              .frame(width: 44, height: 44)

              VStack(alignment: .leading, spacing: 2) {
                Text("Match score \(analysis.matchScore)").font(.body)
                Text(
                  analysis.recommendations.count == 1
                    ? "1 recommendation"
                    : "\(analysis.recommendations.count) recommendations"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
              }
            }
          }
        } header: {
          Text("Latest report")
        } footer: {
          if let meta = view.lastRun {
            Text(runMetaLine(meta))
          }
        }
      }
    }
  }

  private func row(_ job: JobsView.Job) -> some View {
    // Captured where the row is DRAWN, not where an action is chosen. A swipe
    // tray and a long-press menu each keep the closures they were presented
    // with — the row redraws underneath them, the presented actions do not — so
    // a tombstone landing while one is open leaves every action here holding a
    // job id that now names a different workspace's job. And a workspace cloned
    // from the same backup HAS that id, so nothing downstream can tell.
    //
    // The delete pin was already wrong for this reason rather than missing: it
    // was read when Delete was tapped, which is after the wait it has to span,
    // so the confirmation dialog only ever compared the replacement with
    // itself.
    let renderedIn = model.snapshot.whereAmI
    return VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(job.title).font(.body)
          Text(job.company).font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
        if job.isActive {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(.green)
            .accessibilityLabel("Active")
        }
      }
      if expanded.contains(job.id) {
        Text(job.preview).font(.footnote).foregroundStyle(.secondary)
        if let added = addedLabel(job.dateAdded) {
          Text(added).font(.caption2).foregroundStyle(.secondary)
        }
      }
    }
    .padding(.vertical, 2)
    .contentShape(.rect)
    .onTapGesture {
      if expanded.contains(job.id) { expanded.remove(job.id) } else { expanded.insert(job.id) }
    }
    .swipeActions(edge: .trailing) {
      Button("Delete", role: .destructive) {
        pendingDelete = job
        deleteFrom = renderedIn
      }
      Button("Edit") {
        guard renderedIn == model.snapshot.whereAmI else { return }
        openEditor(.existing(job.id))
      }
      .tint(.blue)
    }
    .swipeActions(edge: .leading) {
      Button(job.isActive ? "Deactivate" : "Activate") {
        guard renderedIn == model.snapshot.whereAmI else { return }
        model.jobs("toggleActive", ["id": job.id])
      }
      .tint(job.isActive ? .gray : .green)
    }
    // The same three on a tap-and-hold, because a swipe on a row is
    // discoverable only if you already know it is there.
    .contextMenu {
      Button(
        job.isActive ? "Deactivate" : "Activate",
        systemImage: job.isActive ? "circle" : "checkmark.circle"
      ) {
        guard renderedIn == model.snapshot.whereAmI else { return }
        model.jobs("toggleActive", ["id": job.id])
      }
      Button("Edit", systemImage: "pencil") {
        guard renderedIn == model.snapshot.whereAmI else { return }
        openEditor(.existing(job.id))
      }
      Button("Delete", systemImage: "trash", role: .destructive) {
        pendingDelete = job
        deleteFrom = renderedIn
      }
    }
  }

  private func runProgress(_ run: JobsView.Run) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text(run.op == "tailor" ? "Tailoring your resume" : "Analyzing resume fit")
          .font(.subheadline.weight(.medium))
      }
      if run.reasoning.isEmpty {
        // Said out loud rather than left as a bare spinner: with reasoning off,
        // or on a model that does not reason, nothing arrives until the whole
        // request finishes, and half a minute of silence reads as hung.
        Text("This can take a minute. Nothing comes back until it finishes.")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        InlineReasoningIndicator(reasoning: run.reasoning, isStreaming: true)
      }
    }
    .padding(.vertical, 4)
  }

  private func analysisFooter(_ view: JobsView) -> String {
    if !view.configured { return "Add an API key in Settings to use AI analysis." }
    if view.activeCount == 0 { return "Tailoring uses your active jobs — swipe a job right to activate one." }
    return "Tailoring rewrites the whole resume for your \(view.activeCount) active job"
      + (view.activeCount == 1 ? "." : "s.")
  }

  private func runMetaLine(_ meta: JobsView.RunMeta) -> String {
    let tokens = meta.promptTokens + meta.completionTokens
    var line = "\(meta.model) · \(tokens) tokens"
    if meta.reasoningTokens > 0 { line += " · \(meta.reasoningTokens) reasoning" }
    return line
  }

  private func openEditor(_ target: Editor) {
    // The full posting crosses for one job at a time, so the editor asks for it
    // and the push renders when it lands.
    switch target {
    case .new: model.jobs("newDraft")
    case .existing(let jobId): model.jobs("editDraft", ["id": jobId])
    }
    editor = target
  }

  /// Ask for a fresh snapshot every second while a run is in flight.
  ///
  /// `jobsAction` publishes when an action is dispatched and again when its
  /// promise settles, and nothing else publishes during a request — the canvas
  /// is idle behind the sheet. Without this the streamed reasoning would arrive
  /// in a single lump at the end. Bound to the sheet, so it stops the moment the
  /// run ends or the sheet closes.
  private func pollWhileRunning() async {
    guard view?.run.busy == true else { return }
    while !Task.isCancelled {
      try? await Task.sleep(for: .seconds(1))
      if Task.isCancelled { return }
      model.jobs("refresh")
    }
  }

  private func addedLabel(_ iso: String) -> String? {
    guard let date = ISO8601DateFormatter.jobDateParser.date(from: iso) else { return nil }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return "Added \(formatter.localizedString(for: date, relativeTo: Date()))"
  }
}

private extension ISO8601DateFormatter {
  /// `new Date().toISOString()` always carries milliseconds; the default parser
  /// rejects those.
  static let jobDateParser: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
}

// MARK: - Add / edit

/// A pushed screen, not a nested sheet: SwiftUI honours only one
/// `.sheet(isPresented:)` per view and the symptom is a button that silently
/// does nothing — the web version stacks two Radix dialogs here.
private struct JobEditorScreen: View {
  @ObservedObject var model: ShellModel
  let target: JobsSheet.Editor
  @Environment(\.dismiss) private var dismiss

  /// The workspace this editor was opened in.
  ///
  /// `saveDraft` names no workspace, so it writes into whichever is open when it
  /// arrives — and this screen is pushed, so a tombstone for the workspace
  /// reloads the webview underneath it without closing it. A new job then lands
  /// in the replacement workspace, and an EDIT can overwrite an unrelated job
  /// there outright, because a job id is unique only within a workspace and one
  /// backup imported into two produces the same ids in both.
  @State private var openedIn: ShellSnapshot.Where?
  @State private var savedElsewhere = false
  @State private var title = ""
  @State private var company = ""
  @State private var description = ""
  @State private var loaded = false

  private var draft: JobsView.Draft? { model.snapshot.jobs?.draft }
  private var isNew: Bool { target == .new }
  private var trimmedDescription: String {
    description.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var body: some View {
    Group {
      if loaded {
        form
      } else {
        // The posting is fetched by the command that opened this screen, so
        // there is one round trip before the fields can be filled.
        ProgressView()
      }
    }
    .navigationTitle(isNew ? "Add job" : "Edit job")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") { save() }.disabled(trimmedDescription.isEmpty)
      }
    }
    .onAppear {
      seed(draft)
      openedIn = model.snapshot.whereAmI
    }
    .alert("That workspace is gone", isPresented: $savedElsewhere) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("Your workspace changed on another device while this was open, so the job was not saved. Copy the text, then add it again.")
    }
    // Fires when the pasted posting comes back parsed, and only then: the user's
    // own typing never changes the projected draft, so this cannot clobber it.
    .onChange(of: draft) { _, now in seed(now) }
    .onDisappear { model.jobs("clearDraft") }
  }

  private var form: some View {
    Form {
      Section {
        TextField("Job title", text: $title)
        TextField("Company", text: $company)
      }
      Section {
        TextField("Paste the full job posting", text: $description, axis: .vertical)
          .lineLimit(6...20)
        // A PasteButton rather than reading UIPasteboard directly: the system
        // hands the text over without the "Allow Paste?" prompt a direct read
        // triggers. The splitting into title/company/description is the web's
        // own parser, one round trip away.
        PasteButton(payloadType: String.self) { items in
          guard let text = items.first, !text.isEmpty else { return }
          model.jobs("pasteDraft", ["text": text])
        }
        .labelStyle(.titleAndIcon)
      } footer: {
        Text("The posting is what the analysis reads. Title and company are how you recognise it.")
      }
    }
  }

  private func seed(_ draft: JobsView.Draft?) {
    guard let draft, draft.id == target.id else { return }
    title = draft.title
    company = draft.company
    description = draft.description
    loaded = true
  }

  private func save() {
    // The workspace this was written for, or nothing. Told rather than dropped
    // silently — the text is only in this screen, so a save that quietly went
    // nowhere would take a whole pasted posting with it.
    guard openedIn == model.snapshot.whereAmI else {
      savedElsewhere = true
      return
    }
    model.jobs("saveDraft", [
      "id": target.id,
      "title": title,
      "company": company,
      "description": description,
    ])
    dismiss()
  }
}

// MARK: - Analyze

/// Pin a run screen to the workspace it was set up in.
///
/// Analyze and Tailor each hand a whole run to the page and pop back to the
/// root, and both are PUSHED — a tombstone for the open workspace reloads the
/// webview underneath them without closing them, so their SwiftUI state
/// outlives the workspace it was chosen in. Analyze's tick marks are `@State`,
/// and a job id is unique only inside a workspace: one backup imported into two
/// produces the same ids in both, so `live` stays nonempty and the ids resolve
/// against the REPLACEMENT. The run then spends an API request and writes its
/// report over an unrelated résumé's analysis. Tailor names no ids at all — it
/// rewrites whichever workspace's active jobs it lands in.
///
/// So the workspace is captured on appear and re-read at the press. Told rather
/// than dropped silently: the button is the whole point of the screen, and a
/// dismiss with no run behind it reads as a run that started.
private struct WorkspacePin: ViewModifier {
  @ObservedObject var model: ShellModel
  @Binding var openedIn: ShellSnapshot.Where?
  @Binding var changed: Bool
  @Environment(\.dismiss) private var dismiss

  func body(content: Content) -> some View {
    content
      // Only the first appearance. A re-pin would take the value of whatever
      // workspace is open by then, which is exactly the one being guarded
      // against.
      .onAppear { if openedIn == nil { openedIn = model.snapshot.whereAmI } }
      .alert("That workspace is gone", isPresented: $changed) {
        // Back to the root, whose list belongs to the workspace that is
        // actually open. Staying would leave the pin naming a workspace that no
        // longer exists, so every further press would refuse as well.
        Button("OK", role: .cancel) { dismiss() }
      } message: {
        Text("Your workspace changed on another device while this was open, so nothing was started. Open it again to run this on the workspace you have now.")
      }
  }
}

/// Pick the jobs, the model and the effort, then start the run.
///
/// Model and effort seed from the per-area remembered choice the projection
/// carries, and the selection seeds from which jobs are active — the same two
/// seeds the web dialog uses.
private struct AnalyzeScreen: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var selected: Set<String> = []

  /// The selection, minus anything that is no longer in the list.
  ///
  /// A job list fetched from another device replaces the projection under this
  /// screen — that is why the rows update — but `selected` is Swift state and
  /// keeps the ids of jobs that have since been deleted. Counting them
  /// overstates what is about to be analysed, sending them asks the page about
  /// jobs it no longer has, and if EVERY selected job went, `startAnalysis`
  /// throws "no jobs selected" into a fire-and-forget call: the screen would
  /// dismiss with no run and no error.
  ///
  /// Derived rather than pruned in place. A row that disappears and comes back
  /// — the ordinary shape of a sync round trip — keeps its tick, where a
  /// destructive prune would have dropped it.
  private var live: Set<String> {
    selected.intersection((view?.jobs ?? []).map(\.id))
  }
  @State private var modelId = ""
  @State private var reasoning = "medium"
  @State private var seeded = false
  @State private var openedIn: ShellSnapshot.Where?
  @State private var workspaceChanged = false

  private var view: JobsView? { model.snapshot.jobs }

  var body: some View {
    Form {
      Section {
        JobsModelPicker(models: view?.models ?? [], selection: $modelId)
        JobsReasoningPicker(selection: $reasoning)
      }
      Section {
        ForEach(view?.jobs ?? []) { job in
          Button {
            if selected.contains(job.id) { selected.remove(job.id) } else { selected.insert(job.id) }
          } label: {
            HStack(spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(job.title).font(.body)
                Text(job.company).font(.caption).foregroundStyle(.secondary)
              }
              Spacer(minLength: 0)
              if selected.contains(job.id) {
                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
              }
            }
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
        }
      } header: {
        HStack {
          Text("\(live.count) selected")
          Spacer()
          Button("Select all") { selected = Set((view?.jobs ?? []).map(\.id)) }
          Button("Clear") { selected.removeAll() }
        }
        .textCase(nil)
      }
    }
    .safeAreaInset(edge: .bottom) {
      Button {
        // The ids below mean nothing outside the workspace they were ticked in.
        guard openedIn == model.snapshot.whereAmI else {
          workspaceChanged = true
          return
        }
        model.jobs("analyze", [
          // Every payload value is a String, so the selection crosses as a
          // comma-separated list of the ids the projection handed out — they are
          // generated as `jd-<time>-<suffix>` and never contain a comma.
          "ids": live.sorted().joined(separator: ","),
          "modelId": modelId,
          "reasoning": reasoning,
        ])
        // Back to the root, which is where the run's progress shows.
        dismiss()
      } label: {
        Text("Analyze (\(live.count))").frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(live.isEmpty)
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
    .navigationTitle("Analyze resume fit")
    .navigationBarTitleDisplayMode(.inline)
    .modifier(WorkspacePin(model: model, openedIn: $openedIn, changed: $workspaceChanged))
    .onAppear {
      guard !seeded, let view else { return }
      seeded = true
      selected = Set(view.jobs.filter(\.isActive).map(\.id))
      modelId = view.analysisModelId
      reasoning = view.analysisReasoning
    }
  }
}

// MARK: - Tailor

/// Tailoring has no selection step — it always uses the active jobs, exactly as
/// the web dialog does.
private struct TailorScreen: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var modelId = ""
  @State private var reasoning = "medium"
  @State private var seeded = false
  @State private var openedIn: ShellSnapshot.Where?
  @State private var workspaceChanged = false

  private var view: JobsView? { model.snapshot.jobs }

  var body: some View {
    Form {
      Section {
        JobsModelPicker(models: view?.models ?? [], selection: $modelId)
        JobsReasoningPicker(selection: $reasoning)
      } footer: {
        Text(
          "Tailors your resume for \(view?.activeCount ?? 0) active job"
          + ((view?.activeCount ?? 0) == 1 ? "." : "s.")
          + " The rewritten sections open in the review dialog, where you accept or reject each one."
        )
      }
      Section {
        Button("Tailor resume") {
          // Rewrites the ACTIVE jobs of whichever workspace this lands in, and
          // the choice was made about the one that was open.
          guard openedIn == model.snapshot.whereAmI else {
            workspaceChanged = true
            return
          }
          model.jobs("tailor", ["modelId": modelId, "reasoning": reasoning])
          dismiss()
        }
        .disabled((view?.activeCount ?? 0) == 0)
      }
    }
    .navigationTitle("Tailor resume")
    .navigationBarTitleDisplayMode(.inline)
    .modifier(WorkspacePin(model: model, openedIn: $openedIn, changed: $workspaceChanged))
    .onAppear {
      guard !seeded, let view else { return }
      seeded = true
      modelId = view.tailorModelId
      reasoning = view.tailorReasoning
    }
  }
}

// MARK: - The report

/// The persisted analysis for the current résumé.
///
/// Renders live from the snapshot rather than from a captured copy, so applying
/// a recommendation greys the right row out — `appliedIndexes` comes back from
/// the bridge, and a recommendation the writer could not place never enters it.
private struct AnalysisScreen: View {
  @ObservedObject var model: ShellModel

  private var view: JobsView? { model.snapshot.jobs }
  private var analysis: JobsView.Analysis? { view?.analysis }

  var body: some View {
    Group {
      if let analysis {
        List {
          Section {
            HStack(spacing: 16) {
              Gauge(value: Double(analysis.matchScore), in: 0...100) {
                EmptyView()
              } currentValueLabel: {
                Text("\(analysis.matchScore)")
              }
              .gaugeStyle(.accessoryCircularCapacity)
              .frame(width: 64, height: 64)
              Text("How closely this resume matches the jobs it was analyzed against.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
          }

          // Joined into two lines rather than a cloud of chips: at 390pt a
          // wrapping badge cloud shreds into one word per line, and the tint
          // that carries the meaning works just as well on the whole line.
          Section("Keywords") {
            keywordRow("Matched", analysis.keywordMatches, tint: .green, empty: "None found.")
            keywordRow("Missing", analysis.missingKeywords, tint: .red, empty: "None — great coverage.")
          }

          if !analysis.strengths.isEmpty {
            Section("Strengths") {
              ForEach(Array(analysis.strengths.enumerated()), id: \.offset) { _, strength in
                Label(strength, systemImage: "checkmark").font(.subheadline)
              }
            }
          }

          if !analysis.gaps.isEmpty {
            Section("Gaps to address") {
              ForEach(analysis.gaps) { gap in
                VStack(alignment: .leading, spacing: 4) {
                  Text(gap.area).font(.subheadline.weight(.medium))
                  Text(gap.issue).font(.footnote).foregroundStyle(.secondary)
                  if !gap.suggestion.isEmpty {
                    Text(gap.suggestion).font(.footnote)
                  }
                }
                .padding(.vertical, 2)
              }
            }
          }

          ForEach(["high", "medium", "low"], id: \.self) { impact in
            let items = analysis.recommendations.filter { $0.impact == impact }
            if !items.isEmpty {
              Section {
                ForEach(items) { recommendation($0) }
              } header: {
                Label(impactLabel(impact), systemImage: impactSymbol(impact)).textCase(nil)
              }
            }
          }
        }
      } else {
        ContentUnavailableView(
          "No report yet",
          systemImage: "chart.bar.doc.horizontal",
          description: Text("Run an analysis to see how this resume matches your jobs.")
        )
      }
    }
    .navigationTitle("Resume fit")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func keywordRow(_ label: String, _ words: [String], tint: Color, empty: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label).font(.caption2.weight(.semibold)).foregroundStyle(tint)
      Text(words.isEmpty ? empty : words.joined(separator: ", "))
        .font(.footnote)
        .foregroundStyle(words.isEmpty ? .secondary : .primary)
    }
    .padding(.vertical, 2)
  }

  private func recommendation(_ rec: JobsView.Analysis.Recommendation) -> some View {
    let isApplied = view?.appliedIndexes.contains(rec.index) ?? false
    // The report this card was DRAWN from. Read inside the button's action it
    // would resolve live at the press, comparing the current report with
    // itself — a guard that cannot fail is the same as no guard.
    let revision = view?.revision ?? -1
    return VStack(alignment: .leading, spacing: 8) {
      if !rec.section.isEmpty {
        Text(rec.section.uppercased())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.secondary)
      }
      // Stacked, never side by side — the same shape the change review uses,
      // because two columns of wrapped prose at 390pt are unreadable.
      if !rec.current.isEmpty { diffRow(label: "Before", text: rec.current, tint: .red) }
      if !rec.suggested.isEmpty { diffRow(label: "After", text: rec.suggested, tint: .green) }
      if !rec.reason.isEmpty {
        Text(rec.reason).font(.caption).foregroundStyle(.secondary)
      }
      if !rec.impactReason.isEmpty {
        Text(rec.impactReason).font(.caption).foregroundStyle(.secondary)
      }
      if isApplied {
        Label("Applied", systemImage: "checkmark")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      } else {
        Button("Apply") {
          // The report and the résumé arrive in the same sync unit, so the
          // revision that identifies one identifies the other: an adoption
          // replaces the analysis under this card and `rec.index` then counts
          // into a list that is not the one on screen.
          model.jobs("applyRecommendation", [
            "index": "\(rec.index)",
            "revision": String(revision),
          ])
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
      }
    }
    .padding(.vertical, 2)
    .opacity(isApplied ? 0.6 : 1)
  }

  private func diffRow(label: String, text: String, tint: Color) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2.weight(.semibold)).foregroundStyle(tint)
      Text(text)
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func impactLabel(_ impact: String) -> String {
    switch impact {
    case "high": return "High impact — address these first"
    case "low": return "Low impact — nice to have"
    default: return "Medium impact — worth considering next"
    }
  }

  private func impactSymbol(_ impact: String) -> String {
    switch impact {
    case "high": return "bolt.fill"
    case "low": return "minus"
    default: return "info.circle"
    }
  }
}

// MARK: - Shared pickers

/// The model list, grouped the way the projection grouped it.
///
/// A saved model that is not in the catalog (a custom OpenRouter slug, or an
/// offline first run) gets its own row: without it the picker renders blank and
/// the user cannot tell which model is about to be billed.
private struct JobsModelPicker: View {
  let models: [JobsView.ModelOption]
  @Binding var selection: String

  private var groups: [String] {
    var seen: [String] = []
    for model in models where !seen.contains(model.group) { seen.append(model.group) }
    return seen
  }

  var body: some View {
    Picker("Model", selection: $selection) {
      if !selection.isEmpty, !models.contains(where: { $0.id == selection }) {
        Text(selection).tag(selection)
      }
      ForEach(groups, id: \.self) { group in
        Section(group) {
          ForEach(models.filter { $0.group == group }) { model in
            Text(model.label).tag(model.id)
          }
        }
      }
    }
    .pickerStyle(.menu)
  }
}

private struct JobsReasoningPicker: View {
  @Binding var selection: String

  var body: some View {
    Picker("Reasoning", selection: $selection) {
      ForEach(jobsReasoningOptions, id: \.id) { option in
        Text(option.label).tag(option.id)
      }
    }
    .pickerStyle(.segmented)
  }
}
