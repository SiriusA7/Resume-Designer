// The onboarding / new-résumé wizard.
//
// A separate file from OPShell.swift, which is the shell itself. `project.yml`
// adds `../../ios` as a source path, so anything here compiles with no further
// wiring — but a NEW file still needs `xcodegen generate`, which
// `npm run ios:sim` does and a bare `tauri ios build` does not.
//
// Its JS counterpart is `OnboardingWizard.jsx` itself, not a controller module.
// That component is mounted from app start (App.jsx renders it once storage is
// ready) and merely renders null while closed, so unlike the structure panel
// and the dialogs there was nothing to extract: it pushes its state through
// `publishOnboarding` and these buttons call the handlers it registered.
//
// **The step numbers are the web wizard's**, deliberately:
//
//   0 API key · 1 choose path · 2 import | interview | job · 3 job descriptions
//   · 4 review · 5 done
//
// Every back/next handler over there is written against them, and step 2 is
// three different screens chosen by `mode`. The job path goes 2 → 4, skipping
// the step-3 collector, because it already gathered a job description on the
// way in. Reproducing that arithmetic here would give the two step machines
// something to disagree about; instead Next and Back are single commands and
// the component decides what they mean.
//
// **One component serves both entry points.** A first run shows the API-key
// step; "New resume" opens the same wizard with `isNewResumeMode`, which skips
// it and counts five steps rather than six.
//
// **The API key never crosses back**, the same rule the settings sheet follows.
// `hasKey` says whether one is configured; the field here writes a new one and
// never displays the old.

import SwiftUI

// MARK: - Wire contract

/// Mirrors `buildOnboarding()` in src/iosShell.js.
struct OnboardingView: Decodable, Equatable {
  var open: Bool
  var step: Int
  /// "new" | "import" | "job", or "" before a path is chosen.
  var mode: String
  var isNewResumeMode: Bool
  /// Whether a first run may be abandoned. False only for a genuine first run
  /// with no other profile to fall back to — otherwise a keyless user replaying
  /// the guide is stuck on the key step with no way out but a relaunch.
  var canDismiss: Bool
  var hasProviders: Bool
  var hasKey: Bool
  /// Completed key-save attempts. A counter rather than a status because the
  /// step needs to know an attempt FINISHED, and a status that lands on the
  /// value it already had says nothing.
  var keySaves: Int
  var displayStep: Int
  var totalSteps: Int

  var importText: String
  /// Extracted text of a picked file awaiting confirmation. `nil` means no file
  /// has been picked, which is what chooses between the import screen and the
  /// preview; `""` is a real outcome — a scanned PDF with no text layer.
  var filePreview: String?

  var questions: [Question]
  var question: Int
  var answer: String
  /// The Improve button's result, applied on token change. The field below owns
  /// its text while the user types, so a rewritten answer cannot simply arrive
  /// as `answer` without fighting the cursor.
  var improved: Improved?

  var targetJob: Job?
  var jobGaps: [String]
  var models: [Model]
  var model: String
  var reasoning: String
  var generating: Generating?

  var jobDescriptions: [Job]
  var isTailored: Bool
  /// The generated résumé, as the SAME outline the structure panel decodes.
  /// Read-only here: editing happens in the app once it exists, and a second
  /// editor would be a second place that knows the document's schema.
  var resume: ShellSnapshot.DocumentOutline?

  /// A long AI call with nothing else to show for it, named rather than
  /// boolean: "parse" | "tailor" | "improve" | "".
  var busy: String
  var notice: Notice?

  struct Question: Decodable, Equatable, Identifiable {
    let id: String
    let question: String
    let multiline: Bool
    let aiAssist: Bool
  }

  struct Improved: Decodable, Equatable {
    let token: Int
    let text: String
  }

  struct Job: Decodable, Equatable {
    let title: String
    let company: String
    let description: String
  }

  struct Model: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let group: String
  }

  struct Generating: Decodable, Equatable {
    let phase: String
    let reasoning: String
    /// Not populated by the bridge — the clock is kept on this side, because a
    /// seconds counter driven over the wire would post a snapshot per second.
    let elapsed: Int
    let done: Bool
  }

  struct Notice: Decodable, Equatable {
    let kind: String
    let text: String
  }
}

// MARK: - The wizard

/// Presented whenever `snapshot.onboarding` is non-nil.
///
/// Full screen and not dismissible by a drag: a first run has to be completed
/// or explicitly cancelled, and a half-finished wizard swiped away leaves no
/// résumé and no explanation. `canDismiss` puts an X in the header when the
/// flow is one the user may legitimately abandon.
struct OnboardingSheet: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        progressHeader
        Divider()
        step
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .background(Color(.systemGroupedBackground))
      .navigationBarHidden(true)
    }
    .interactiveDismissDisabled()
  }

  /// The web's header: a bar, "Step N of M", and a close button when the flow
  /// may be abandoned.
  private var progressHeader: some View {
    HStack(spacing: 14) {
      ProgressView(
        value: Double(view.displayStep),
        total: Double(max(view.totalSteps, 1))
      )
      .progressViewStyle(.linear)
      .frame(width: 140)

      Text("Step \(view.displayStep) of \(view.totalSteps)")
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .fixedSize()

      Spacer(minLength: 0)

      if view.canDismiss {
        Button {
          model.send("onboardingDismiss")
        } label: {
          Image(systemName: "xmark")
            .font(.footnote.weight(.semibold))
            .frame(width: 28, height: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Cancel")
      }
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 16)
  }

  @ViewBuilder
  private var step: some View {
    switch view.step {
    case 0: OnboardingKeyStep(model: model, view: view)
    case 1: OnboardingPathStep(model: model, view: view)
    case 2:
      switch view.mode {
      case "import":
        // A picked file's text waiting to be confirmed replaces the import
        // screen rather than stacking on it, so Back means "not that file"
        // rather than leaving the wizard.
        if let preview = view.filePreview {
          OnboardingFilePreviewStep(model: model, view: view, previewText: preview)
        } else {
          OnboardingImportStep(model: model, view: view)
        }
      case "job": OnboardingJobStep(model: model, view: view)
      default: OnboardingInterviewStep(model: model, view: view)
      }
    case 3: OnboardingJobListStep(model: model, view: view)
    case 4: OnboardingReviewStep(model: model, view: view)
    default: OnboardingDoneStep(model: model, view: view)
    }
  }
}

// MARK: - Shared furniture

/// The heading every step opens with. Centred like the web's, which uses it to
/// carry the whole step's framing rather than a navigation title.
struct OnboardingHeader: View {
  let icon: String
  let title: String
  let description: String

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 34, weight: .light))
        .foregroundStyle(.tint)
        .padding(.bottom, 2)
      Text(title)
        .font(.title2.weight(.semibold))
        .multilineTextAlignment(.center)
      if !description.isEmpty {
        Text(description)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 24)
    .padding(.horizontal, 24)
  }
}

/// A step's action row, pinned below its content rather than scrolling with it
/// — the primary action of a wizard should never be somewhere off the bottom.
struct OnboardingFooter<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    HStack(spacing: 12) { content }
      .padding(.horizontal, 22)
      .padding(.vertical, 16)
      .background(.bar)
  }
}

/// Back, where a step has somewhere to go back to.
struct OnboardingBackButton: View {
  @ObservedObject var model: ShellModel
  var payload: [String: String] = [:]

  var body: some View {
    Button("Back") { model.send("onboardingBack", payload) }
      .buttonStyle(.bordered)
      .controlSize(.large)
  }
}

/// What the wizard shows while an AI call it cannot hurry is running.
struct OnboardingBusyLabel: View {
  let busy: String

  var body: some View {
    if !busy.isEmpty {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text(message)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
  }

  private var message: String {
    switch busy {
    case "parse": return "Reading your résumé…"
    case "tailor": return "Tailoring to your job descriptions…"
    case "improve": return "Rewriting…"
    default: return "Working…"
    }
  }
}

/// An error the web would have raised as a toast in the canvas, which is
/// invisible under a full-screen wizard.
struct OnboardingNoticeLabel: View {
  let notice: OnboardingView.Notice?

  var body: some View {
    if let notice {
      Label(notice.text, systemImage: notice.kind == "error"
        ? "exclamationmark.triangle.fill"
        : "info.circle.fill")
        .font(.footnote)
        .foregroundStyle(notice.kind == "error" ? .red : .secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 22)
    }
  }
}
