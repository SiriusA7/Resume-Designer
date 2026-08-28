// The wizard's individual steps.
//
// Split from OPOnboarding.swift the same way the web splits OnboardingSteps.jsx
// from OnboardingWizard.jsx: that file owns the step machine and this one owns
// the screens. Read the header of OPOnboarding.swift first — the step
// numbering, the two entry points, and the API-key rule are all there.
//
// Every step here is presentation plus one command. None of them decides what
// comes next: Next and Back are single commands and the web component resolves
// them against the flow it is running. That is what keeps the job path's 2 → 4
// jump, and the interview's six questions inside one step, from having to exist
// twice.

import SwiftUI
import UniformTypeIdentifiers

/// The largest file worth pushing through the command channel.
///
/// A picked file crosses as base64 inside a JS string literal — there is no way
/// to hand a Blob to `evaluateJavaScript` — so a 10MB PDF becomes a ~13MB
/// string. Résumés are a page or two; anything at this size is a portfolio, and
/// refusing it with a reason beats a webview that stalls with no explanation.
private let onboardingMaxFileBytes = 10 * 1024 * 1024

// MARK: - Step 0 — API key

/// First run only. New-résumé mode skips it: an existing user with no key would
/// otherwise be stranded here, since this step has no cancel and will not
/// advance without one.
struct OnboardingKeyStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView
  @State private var key = ""
  @State private var saving = false

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 20) {
          OnboardingHeader(
            icon: "key.horizontal",
            title: "Connect an AI model",
            description: "On Paper uses OpenRouter to write and tailor your résumé. "
              + "Your key is stored in the device keychain."
          )

          VStack(alignment: .leading, spacing: 8) {
            // Secure, and never seeded from the existing key — the projection
            // does not carry it. Replacing one means typing the new one.
            SecureField("sk-or-…", text: $key)
              .textFieldStyle(.roundedBorder)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .submitLabel(.done)

            if view.hasKey {
              Label("A key is already configured", systemImage: "checkmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(.green)
            }
          }
          .padding(.horizontal, 22)

          OnboardingNoticeLabel(notice: view.notice)
          // Said here as well as by the button, because "Skip for now" alone
          // reads as postponing something required. The web step carries the
          // same sentence directly under its own skip.
          if !view.hasKey {
            Text("You can add a key later in Settings. Everything except the AI assistant works without one.")
              .font(.footnote)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
              .padding(.horizontal, 22)
          }
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        Spacer(minLength: 0)
        // ALWAYS a way forward, which is the whole of this. Genuine first-run
        // onboarding is non-dismissible and `Save key` is disabled until
        // something is typed, so gating the only other action on `hasKey ||
        // hasProviders` left a fresh install with no way out of this screen: no
        // Continue, a disabled Save, and no close. Somebody who only wanted to
        // write a résumé had to go and obtain an OpenRouter key first. The web
        // wizard has never worked that way — it offers "Skip for now"
        // unconditionally, for the reason its own comment gives about not
        // stranding a keyless user.
        //
        // Two buttons rather than one with a conditional label, because the
        // emphasis differs too: with a key this is the primary action, without
        // one it sits behind `Save key`.
        if view.hasKey || view.hasProviders {
          Button("Continue") { model.send("onboardingNext") }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else {
          Button("Skip for now") { model.send("onboardingNext") }
            .buttonStyle(.bordered)
            .controlSize(.large)
        }
        // Two buttons rather than one with a conditional style: `.bordered` and
        // `.borderedProminent` are different concrete types and a ternary over
        // them does not type-check.
        Group {
          if view.hasKey {
            Button(saveLabel) { save() }.buttonStyle(.bordered)
          } else {
            Button(saveLabel) { save() }.buttonStyle(.borderedProminent)
          }
        }
        .controlSize(.large)
        .disabled(key.isEmpty || saving)
      }
    }
    // The wizard's own notice is the result channel: a refused keychain write
    // has to keep the user here rather than promise AI that is about to fail.
    //
    // Cleared on the COUNTER, not on those two values. Replacing a key that
    // already worked with another that works moves neither — `hasKey` was true
    // and stays true, the notice was nil and stays nil — so this sat on
    // "Saving…" with the button disabled, and the only way out of a mistyped
    // replacement was to leave the screen. A counter changes on every completed
    // attempt, including the ones whose outcome looks like the state before it.
    .onChange(of: view.keySaves) { _, _ in saving = false }
  }

  private var saveLabel: String { saving ? "Saving…" : "Save key" }

  private func save() {
    saving = true
    model.send("onboardingSaveKey", ["key": key])
  }
}

// MARK: - Step 1 — choose a path

struct OnboardingPathStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView

  private struct Path: Identifiable {
    let id: String
    let icon: String
    let title: String
    let blurb: String
  }

  private let paths = [
    Path(id: "job", icon: "target", title: "Target a job",
         blurb: "Paste a job description and have one written for it."),
    Path(id: "import", icon: "doc.text", title: "Import a résumé",
         blurb: "Bring in a file or paste the text of one you already have."),
    Path(id: "new", icon: "sparkles", title: "Start from scratch",
         blurb: "Answer six questions and get a first draft."),
  ]

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 20) {
          OnboardingHeader(
            icon: "square.grid.2x2",
            title: view.isNewResumeMode ? "New résumé" : "How would you like to start?",
            description: "You can change any of it afterwards."
          )

          VStack(spacing: 12) {
            ForEach(paths) { path in
              Button {
                model.send("onboardingChoose", ["mode": path.id])
              } label: {
                HStack(alignment: .top, spacing: 14) {
                  Image(systemName: path.icon)
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .frame(width: 28)
                  VStack(alignment: .leading, spacing: 3) {
                    Text(path.title).font(.headline)
                    Text(path.blurb)
                      .font(.footnote)
                      .foregroundStyle(.secondary)
                      .multilineTextAlignment(.leading)
                  }
                  Spacer(minLength: 0)
                  Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
                .contentShape(.rect)
              }
              .buttonStyle(.plain)
            }
          }
          .padding(.horizontal, 22)
        }
        .padding(.bottom, 24)
      }

      // Nothing behind this step in new-résumé mode: the key step is not part
      // of that flow, so Back would be a button to nowhere.
      if !view.isNewResumeMode {
        OnboardingFooter {
          OnboardingBackButton(model: model)
          Spacer(minLength: 0)
        }
      }
    }
  }
}

// MARK: - Step 2, import

struct OnboardingImportStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView
  @State private var text = ""
  @State private var picking = false
  @State private var pickError = ""

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          OnboardingHeader(
            icon: "doc.on.clipboard",
            title: "Import your résumé",
            description: "Choose a file, or paste the text below."
          )

          Button {
            picking = true
          } label: {
            Label("Choose a file", systemImage: "folder")
              .frame(maxWidth: .infinity)
              .padding(14)
              .background(
                Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12)
              )
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .padding(.horizontal, 22)
          .disabled(!view.busy.isEmpty)

          if !pickError.isEmpty {
            Text(pickError)
              .font(.footnote)
              .foregroundStyle(.red)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 22)
          }

          Text("or paste it")
            .font(.caption)
            .foregroundStyle(.secondary)

          TextEditor(text: $text)
            .frame(minHeight: 240)
            .font(.callout)
            .scrollContentBackground(.hidden)
            .padding(10)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
            .padding(.horizontal, 22)

          OnboardingNoticeLabel(notice: view.notice)
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        OnboardingBackButton(model: model)
        Spacer(minLength: 0)
        OnboardingBusyLabel(busy: view.busy)
        Button("Continue") {
          model.send("onboardingParseImport", ["text": text])
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || !view.busy.isEmpty)
      }
    }
    .onAppear { if text.isEmpty { text = view.importText } }
    // The extractors `parseResumeFile` has, and only those — offering a .pages
    // or .rtf that throws "Unsupported file type" after the picker closes is a
    // worse answer than not listing it.
    .fileImporter(
      isPresented: $picking,
      allowedContentTypes: [.pdf, .plainText, docxType].compactMap { $0 }
    ) { result in
      pickError = ""
      switch result {
      case .success(let url): send(url)
      case .failure(let error): pickError = error.localizedDescription
      }
    }
  }

  /// Read the picked file and hand it over as base64.
  ///
  /// The URL is security-scoped — the picker returns a reference into another
  /// process's container, and reading it without claiming access fails with a
  /// permission error that reads like a missing file.
  private func send(_ url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    do {
      let data = try Data(contentsOf: url)
      guard data.count <= onboardingMaxFileBytes else {
        pickError = "That file is too large to import. Paste the text instead."
        return
      }
      model.send("onboardingPickedFile", [
        // The NAME carries the extension, which is what selects the extractor
        // on the other side — not the content type.
        "name": url.lastPathComponent,
        "data": data.base64EncodedString(),
      ])
    } catch {
      pickError = error.localizedDescription
    }
  }
}

/// `.docx`, which has no `UTType` constant of its own.
private let docxType = UTType(
  "org.openxmlformats.wordprocessingml.document"
)

/// The text pulled out of a picked file, shown before it is parsed so a bad
/// extraction is caught by the person who knows what the file said.
struct OnboardingFilePreviewStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView
  let previewText: String

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          OnboardingHeader(
            icon: "doc.text.magnifyingglass",
            title: "Does this look right?",
            description: previewText.isEmpty
              ? "No text could be read from that file. It may be a scan."
              : "This is what was read out of your file."
          )

          if !previewText.isEmpty {
            Text(previewText)
              .font(.caption)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(12)
              .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
              .padding(.horizontal, 22)
          }
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        // Back here means "not that file", not "leave the wizard".
        Button("Choose another") { model.send("onboardingClearFile") }
          .buttonStyle(.bordered)
          .controlSize(.large)
        Spacer(minLength: 0)
        OnboardingBusyLabel(busy: view.busy)
        Button("Continue") {
          model.send("onboardingParseImport", ["text": previewText])
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(previewText.isEmpty || !view.busy.isEmpty)
      }
    }
  }
}

// MARK: - Step 2, interview

/// Six questions inside one step. The step number does not move between them —
/// the web behaves the same way, and a progress bar that advanced six times
/// inside step 3 of 6 would be lying about how far along you are.
struct OnboardingInterviewStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView
  @State private var value = ""
  @State private var appliedImprovement = 0
  /// The question that asked for the rewrite in flight. The answer comes back
  /// without one, so this is the only thing that can say whether it belongs
  /// to the question on screen.
  @State private var improvingQuestion: Int?
  @State private var shownQuestion = -1

  private var question: OnboardingView.Question? {
    view.questions.indices.contains(view.question) ? view.questions[view.question] : nil
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          OnboardingHeader(
            icon: "text.bubble",
            title: question?.question ?? "",
            description: "Question \(view.question + 1) of \(view.questions.count)"
          )

          Group {
            if question?.multiline == true {
              TextEditor(text: $value)
                .frame(minHeight: 160)
                .font(.callout)
                .scrollContentBackground(.hidden)
                .padding(10)
                .background(
                  Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12)
                )
            } else {
              TextField("Your answer", text: $value)
                .textFieldStyle(.plain)
                .padding(14)
                .background(
                  Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12)
                )
            }
          }
          .padding(.horizontal, 22)

          // Only two of the six questions offer it, and only with a provider
          // configured — the web gates it the same way.
          if question?.aiAssist == true && view.hasProviders {
            HStack {
              Button {
                // WHICH question asked. The improvement comes back as a bare
                // `{token, text}` with no question on it, and Next is disabled
                // only on empty text — never on `busy` — so a person who gives
                // up on a slow rewrite and moves on has an answer to the
                // PREVIOUS question land in the field they are typing in now.
                improvingQuestion = view.question
                model.send("onboardingImprove", ["value": value])
              } label: {
                Label("Improve this answer", systemImage: "wand.and.stars")
              }
              .buttonStyle(.bordered)
              .controlSize(.small)
              .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || view.busy == "improve")
              Spacer(minLength: 0)
              OnboardingBusyLabel(busy: view.busy == "improve" ? view.busy : "")
            }
            .padding(.horizontal, 22)
          }

          OnboardingNoticeLabel(notice: view.notice)
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        OnboardingBackButton(model: model)
        Spacer(minLength: 0)
        Button(view.question == view.questions.count - 1 ? "Finish" : "Next") {
          model.send("onboardingInterviewNext", ["value": value])
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    // Seed on arrival AND on every question change: this view is not rebuilt
    // between questions, so `value` would otherwise carry the previous answer
    // into the next question.
    .onAppear { syncQuestion() }
    .onChange(of: view.question) { _, _ in syncQuestion() }
    // Applied on token change rather than text change, so improving twice to
    // the same wording still lands.
    .onChange(of: view.improved) { _, improved in
      guard let improved, improved.token != appliedImprovement else { return }
      // Marked applied either way, before the check below: this token has been
      // dealt with, and leaving it unmarked would let it land later, on some
      // other question, the moment anything else republished.
      appliedImprovement = improved.token
      guard improvingQuestion == view.question else { return }
      value = improved.text
    }
  }

  private func syncQuestion() {
    guard shownQuestion != view.question else { return }
    shownQuestion = view.question
    value = view.answer
  }
}

// MARK: - Step 2, target a job

struct OnboardingJobStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView
  @State private var title = ""
  @State private var company = ""
  @State private var description = ""
  @State private var seeded = false
  @State private var selectedModel = ""
  @State private var selectedReasoning = "medium"

  private var draft: [String: String] {
    ["title": title, "company": company, "description": description]
  }

  var body: some View {
    // Once generation starts the form is replaced outright, the way the web
    // does it: a progress screen beside a still-editable form invites an edit
    // that the run in flight will not see.
    if let generating = view.generating {
      OnboardingGeneratingView(model: model, view: view, generating: generating)
    } else {
      form
    }
  }

  private var form: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          OnboardingHeader(
            icon: "target",
            title: "What are you applying for?",
            description: "Paste the job description and a résumé gets written for it."
          )

          VStack(spacing: 12) {
            TextField("Role", text: $title)
              .textFieldStyle(.plain)
              .padding(14)
              .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
            TextField("Company", text: $company)
              .textFieldStyle(.plain)
              .padding(14)
              .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
            TextEditor(text: $description)
              .frame(minHeight: 180)
              .font(.callout)
              .scrollContentBackground(.hidden)
              .padding(10)
              .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
              .overlay(alignment: .topLeading) {
                if description.isEmpty {
                  Text("Paste the job description")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 15)
                    .padding(.vertical, 18)
                    .allowsHitTesting(false)
                }
              }
          }
          .padding(.horizontal, 22)

          if !view.models.isEmpty {
            OnboardingModelPicker(
              view: view,
              selectedModel: $selectedModel,
              selectedReasoning: $selectedReasoning
            )
          }

          OnboardingNoticeLabel(notice: view.notice)
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        // Carries the half-typed job back with it, or a Back-then-forward
        // silently discards what was written.
        OnboardingBackButton(model: model, payload: draft)
        Spacer(minLength: 0)
        Button("Generate") {
          model.send("onboardingGenerate", draft.merging(
            ["model": selectedModel, "reasoning": selectedReasoning]
          ) { current, _ in current })
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .onAppear {
      guard !seeded else { return }
      seeded = true
      title = view.targetJob?.title ?? ""
      company = view.targetJob?.company ?? ""
      description = view.targetJob?.description ?? ""
      // Seeded from what the wizard last used, so the choice carries between
      // runs the way the web's does.
      selectedModel = view.model
      selectedReasoning = view.reasoning
    }
  }
}

/// The model and reasoning effort the generation runs at.
///
/// Selected here and passed with the Generate command rather than written
/// through a command of its own: the web persists both as `onboardingModel` /
/// `onboardingReasoning` inside its generate handler, so a separate setter
/// would be a second place that decides what "the model for next time" means.
struct OnboardingModelPicker: View {
  let view: OnboardingView
  @Binding var selectedModel: String
  @Binding var selectedReasoning: String

  private static let efforts = [
    ("none", "Off"), ("low", "Low"), ("medium", "Medium"), ("high", "High"),
  ]

  var body: some View {
    VStack(spacing: 10) {
      HStack {
        Text("Model").font(.subheadline).foregroundStyle(.secondary)
        Spacer(minLength: 0)
        Menu {
          // Grouped the way the web's select is — a flat list of every
          // OpenRouter model is unreadable on a phone.
          ForEach(groups, id: \.self) { group in
            Section(group) {
              ForEach(view.models.filter { $0.group == group }) { option in
                Button {
                  selectedModel = option.id
                } label: {
                  if option.id == selectedModel {
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
            Text(label(for: selectedModel)).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.caption2)
          }
          .font(.subheadline)
        }
      }

      HStack {
        Text("Thinking").font(.subheadline).foregroundStyle(.secondary)
        Spacer(minLength: 0)
        Picker("Thinking", selection: $selectedReasoning) {
          ForEach(Self.efforts, id: \.0) { Text($0.1).tag($0.0) }
        }
        .pickerStyle(.segmented)
        .frame(width: 220)
      }
    }
    .padding(.horizontal, 22)
  }

  private var groups: [String] {
    var seen = Set<String>()
    return view.models.compactMap { seen.insert($0.group).inserted ? $0.group : nil }
  }

  private func label(for id: String) -> String {
    view.models.first { $0.id == id }?.label ?? (id.isEmpty ? "Default" : id)
  }
}

/// The generating / done screen: the run's own reasoning as it arrives, and a
/// way out of a call that is taking too long.
struct OnboardingGeneratingView: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView
  let generating: OnboardingView.Generating

  /// Timed here rather than over the wire — a seconds counter driven by the
  /// bridge would post a snapshot per second for the whole run.
  @State private var elapsed = 0
  private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 18) {
          OnboardingHeader(
            icon: generating.done ? "checkmark.circle" : "sparkles",
            title: generating.done ? "Your résumé is ready" : "Writing your résumé",
            description: generating.done
              ? "Have a look before it is saved."
              : "\(elapsed)s"
          )

          if !generating.reasoning.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Reasoning")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
              Text(generating.reasoning)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
            .padding(.horizontal, 22)
          }

          if generating.done && !view.jobGaps.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Label("Worth filling in", systemImage: "exclamationmark.circle")
                .font(.subheadline.weight(.semibold))
              ForEach(view.jobGaps, id: \.self) { gap in
                Text("• \(gap)")
                  .font(.footnote)
                  .foregroundStyle(.secondary)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
            .padding(.horizontal, 22)
          }
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        if generating.done {
          Spacer(minLength: 0)
          Button("Review") { model.send("onboardingNext") }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        } else {
          Button("Cancel") { model.send("onboardingCancelGenerate") }
            .buttonStyle(.bordered)
            .controlSize(.large)
          Spacer(minLength: 0)
          ProgressView()
        }
      }
    }
    .onReceive(tick) { _ in if !generating.done { elapsed += 1 } }
  }
}

// MARK: - Step 3 — job descriptions

/// Reached by the import and interview paths only. The job path gathered its
/// job description on the way in and skips straight to review.
struct OnboardingJobListStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView
  @State private var showAdd = false
  @State private var title = ""
  @State private var company = ""
  @State private var description = ""

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          OnboardingHeader(
            icon: "briefcase",
            title: "Any jobs to tailor for?",
            description: "Optional. Add one and your résumé is rewritten against it."
          )

          VStack(spacing: 10) {
            ForEach(Array(view.jobDescriptions.enumerated()), id: \.offset) { index, job in
              HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                  Text(job.title).font(.subheadline.weight(.semibold))
                  Text(job.company).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button(role: .destructive) {
                  model.send("onboardingRemoveJob", ["index": String(index)])
                } label: {
                  Image(systemName: "trash")
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.red)
              }
              .padding(14)
              .background(
                Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12)
              )
            }

            Button {
              showAdd = true
            } label: {
              Label("Add a job description", systemImage: "plus")
                .frame(maxWidth: .infinity)
                .padding(14)
                .background(
                  Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12)
                )
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
          }
          .padding(.horizontal, 22)

          OnboardingNoticeLabel(notice: view.notice)
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        OnboardingBackButton(model: model)
        Spacer(minLength: 0)
        OnboardingBusyLabel(busy: view.busy)
        Button(view.jobDescriptions.isEmpty ? "Skip" : "Tailor") {
          model.send("onboardingNext")
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!view.busy.isEmpty)
      }
    }
    .sheet(isPresented: $showAdd) {
      NavigationStack {
        Form {
          Section {
            TextField("Role", text: $title)
            TextField("Company", text: $company)
          }
          Section("Job description") {
            TextEditor(text: $description).frame(minHeight: 200)
          }
        }
        .navigationTitle("Add a job")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { showAdd = false }
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Add") {
              model.send("onboardingAddJob", [
                "title": title, "company": company, "description": description,
              ])
              title = ""; company = ""; description = ""
              showAdd = false
            }
            .disabled(description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
      }
    }
  }
}

// MARK: - Step 4 — review

/// Read-only. Editing happens in the app proper once the résumé exists; a
/// second editor here would be a second place for the document shape to be
/// known, which is the one thing this bridge does not do.
struct OnboardingReviewStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 16) {
          OnboardingHeader(
            icon: "doc.text",
            title: "Here it is",
            description: view.isTailored
              ? "Tailored to the job you gave. Nothing is saved until you create it."
              : "Nothing is saved until you create it."
          )

          if let outline = view.resume {
            OnboardingResumePreview(outline: outline)
              .padding(.horizontal, 22)
          } else {
            Text("Nothing came back to review.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }

          OnboardingNoticeLabel(notice: view.notice)
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        OnboardingBackButton(model: model)
        Spacer(minLength: 0)
        Button("Create résumé") { model.send("onboardingCreate") }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
      }
    }
  }
}

/// The generated résumé, grouped exactly as the structure panel groups it — so
/// what is reviewed here reads the same as what is edited afterwards.
struct OnboardingResumePreview: View {
  let outline: ShellSnapshot.DocumentOutline

  var body: some View {
    VStack(spacing: 12) {
      ForEach(outline.groups) { group in
        // A group whose every field is empty is noise on a review screen: the
        // outline carries the document's full shape, not just what was filled.
        let filled = group.fields.filter { !$0.value.isEmpty }
        if !filled.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text(group.title)
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
              .textCase(.uppercase)
            ForEach(filled) { field in
              VStack(alignment: .leading, spacing: 2) {
                Text(field.label)
                  .font(.caption2)
                  .foregroundStyle(.tertiary)
                Text(field.value)
                  .font(.footnote)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
            }
          }
          .padding(14)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
        }
      }
    }
  }
}

// MARK: - Step 5 — done

struct OnboardingDoneStep: View {
  @ObservedObject var model: ShellModel
  let view: OnboardingView

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: 20) {
          OnboardingHeader(
            icon: "checkmark.seal",
            title: "You're set",
            description: "Your résumé is saved. Fill in your profile and every future "
              + "résumé starts from what you have already told it."
          )
        }
        .padding(.bottom, 24)
      }

      OnboardingFooter {
        Button("Open profile") { model.send("onboardingOpenProfile") }
          .buttonStyle(.bordered)
          .controlSize(.large)
        Spacer(minLength: 0)
        Button("Start writing") { model.send("onboardingFinish") }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
      }
    }
  }
}
