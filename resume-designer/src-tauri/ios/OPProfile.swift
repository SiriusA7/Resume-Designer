// The Profile sheet.
//
// A separate file from OPShell.swift, which is the shell itself: this one owns
// only the profile editor. `project.yml` adds `../../ios` as a source path, so
// anything here compiles with no further wiring.
//
// Its JS counterpart is src/profileBridge.js.
//
// Seven navigation rows, not seven tabs. The web dialog is a 172px rail beside
// a 740px pane — the rail alone is 44% of a 390pt screen — and its Contact tab
// puts nine fields in two columns. Each section pushes its own screen instead,
// which is also what gives Experience the room to be a list of employers rather
// than a stack of cards with five buttons each.
//
// **Swift never learns the profile's schema.** Every field arrives as
// `{path, label, value, kind}` and goes back as `setField(path, value)` with
// the path echoed exactly as received, the same property that keeps the
// structure panel's path grammar single-sourced. The one control that is not a
// path is the employer name, because renaming an employer writes every role in
// the run at once and only the bridge knows which those are.
//
// **Nothing here calls the web's confirmations.** `confirmDestructive()` renders
// a Radix AlertDialog inside the webview, behind this sheet, where its promise
// would never settle. Deleting an employer and answering the import's grouping
// question are native dialogs, asked BEFORE the action is sent.

import SwiftUI
import UniformTypeIdentifiers

// MARK: - Wire contract

/// Mirrors `buildProfile()` in src/profileBridge.js. Changing either side
/// without the other empties the sheet: this decodes as ONE value, so a missing
/// key fails the whole thing rather than one row.
struct ProfileView: Decodable, Equatable {
  /// 0–100, from `profileCompleteness()` — the same number the desktop Account
  /// section shows, so the two never disagree about how far along you are.
  var completeness: Int
  /// The last write did NOT land (storage quota). The web reports this as a
  /// sonner toast rendered in the canvas, which is invisible under a sheet, so
  /// it crosses as state and every screen says so.
  var saveFailed: Bool
  /// A parsed markdown import waiting on the grouping question.
  var pendingImport: PendingImport?
  var sections: [Section]

  struct PendingImport: Decodable, Equatable {
    /// How many employers the import would fold into one heading. Only ever
    /// non-zero — the bridge applies an import with nothing to ask about.
    let runCount: Int
  }

  struct Section: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    /// The trailing summary on the root row: "3 of 9", "2 roles", "None".
    let badge: String
    /// "form" or "experience". The second one is a different screen, not a
    /// different set of fields.
    let kind: String
    /// The profile array this section's own rows come from — only the
    /// experience section has one, and it is what its add and delete echo
    /// back. "" everywhere else.
    let listPath: String
    let groups: [Group]
    let employers: [Employer]
  }

  struct Group: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let footer: String
    /// Rows that are not part of the list.
    let fields: [Field]
    /// The profile array these items come from, "" when the group is not a
    /// list. Echoed back on add and delete; never constructed here.
    let listPath: String
    let addLabel: String
    let emptyLabel: String
    let items: [Item]
  }

  struct Item: Decodable, Equatable, Identifiable {
    /// The row's own identity for the stale check — see `Role.key`.
    let key: String
    let index: Int
    let fields: [Field]
    /// Position, deliberately, NOT `key`. For six of the seven lists the key is
    /// the row's primary text, so identifying rows by it would give the row a
    /// new identity on every keystroke and SwiftUI would rebuild it mid-word,
    /// taking the keyboard with it.
    var id: Int { index }
  }

  struct Field: Decodable, Equatable, Identifiable {
    let path: String
    let label: String
    /// Shown under the control. Empty for most fields.
    let hint: String
    let placeholder: String
    let value: String
    /// "text" | "multiline" | "choice".
    let kind: String
    /// "default" | "email" | "phone" | "url" | "number".
    let keyboard: String
    /// Résumé content, as opposed to an identifier like an email or a URL.
    /// Text substitution has to be off on these — see `ProfileTextInput`.
    let prose: Bool
    let options: [Option]
    var id: String { path }
  }

  struct Option: Decodable, Equatable, Identifiable {
    let value: String
    let label: String
    var id: String { value }
  }

  /// One employer run: the company stated once, its positions beneath.
  struct Employer: Decodable, Equatable, Identifiable {
    let id: String
    let company: String
    /// The run lead's position in `workExperience`, and its entry id. Both go
    /// back on every action that touches the run.
    let leadIndex: Int
    let leadKey: String
    /// The run rule needs a non-empty company, so an unnamed employer cannot
    /// take a second role — it would render as two solo cards.
    let canAddRole: Bool
    let canLinkAbove: Bool
    let showLinkAbove: Bool
    let roles: [Role]
  }

  struct Role: Decodable, Equatable, Identifiable {
    let index: Int
    /// The entry's own id. Sent back with every structural action so a list
    /// that renumbered under the sheet refuses instead of hitting another row.
    let key: String
    let title: String
    let canDetach: Bool
    let dates: Dates
    let fields: [Field]
    var id: Int { index }
  }

  /// Read through `readEntryDates` in JS — the machine-readable pair only,
  /// never the display string. A zero year or month means nothing is selected.
  struct Dates: Decodable, Equatable {
    let display: String
    let startYear: Int
    let startMonth: Int
    let endYear: Int
    let endMonth: Int
    let ongoing: Bool
    /// No readable pair: the picker opens empty and offers the text instead.
    let freeform: Bool
  }
}

/// Every profile command is one `profileAction`, so this is the only shape they
/// take.
///
/// The action's name travels as `action`, NOT as `type`: `type` is what
/// `createCommandDispatcher` routes on, and `ShellModel.send` assigns it after
/// copying the payload, so a nested `type` would be overwritten before it left
/// this process.
private extension ShellModel {
  func profile(
    _ action: String, _ extra: [String: String] = [:], onResult: ((Bool) -> Void)? = nil
  ) {
    var body = extra
    body["action"] = action
    send("profileAction", body, onResult: onResult)
  }
}

@MainActor
private func profileSection(_ model: ShellModel, _ id: String) -> ProfileView.Section? {
  model.snapshot.profile?.sections.first { $0.id == id }
}

/// Find a role again after a republish.
///
/// By id first, because indices renumber; by position only for the entries old
/// enough to carry no id at all.
@MainActor
private func profileRole(_ model: ShellModel, key: String, index: Int) -> ProfileView.Role? {
  let roles = profileSection(model, "experience")?.employers.flatMap(\.roles) ?? []
  if !key.isEmpty, let match = roles.first(where: { $0.key == key }) { return match }
  return roles.first { $0.index == index }
}

// MARK: - Root

struct ProfileSheet: View {
  @ObservedObject var model: ShellModel
  @Environment(\.dismiss) private var dismiss

  @State private var importing = false
  @State private var importFailed = false
  /// Mirrored from the snapshot rather than read from it: a dialog bound
  /// straight to `pendingImport` re-presents itself the moment it is dismissed
  /// any way other than through its own buttons.
  @State private var groupingQuestion: Int?
  /// Whether one of the dialog's own buttons answered the grouping question.
  ///
  /// The binding's setter has to cancel a dismissal nobody answered — tapping
  /// outside the popover on iPad — but it also runs when a button dismisses the
  /// dialog, and SwiftUI does not promise whether the action or the binding
  /// write happens first. So the setter defers its decision by one main-actor
  /// turn and reads this, which is set synchronously by every button either way
  /// round. Checked rather than ordered, because ordering is the part that
  /// cannot be verified from here.
  @State private var groupingAnswered = false

  private var profile: ProfileView? { model.snapshot.profile }

  var body: some View {
    NavigationStack {
      Group {
        if let profile {
          List {
            if profile.saveFailed {
              Section { ProfileSaveWarning() }
            }
            Section {
              VStack(alignment: .leading, spacing: 6) {
                Text("\(profile.completeness)% complete")
                  .font(.subheadline.weight(.medium))
                ProgressView(value: Double(profile.completeness), total: 100)
              }
              .padding(.vertical, 2)
            } footer: {
              Text("Background the assistant reads before it writes anything. None of it goes on a resume as it stands here.")
            }
            Section {
              ForEach(profile.sections) { section in
                NavigationLink {
                  destination(section)
                } label: {
                  LabeledContent {
                    Text(section.badge).foregroundStyle(.secondary)
                  } label: {
                    Label(section.title, systemImage: symbol(for: section.id))
                  }
                }
              }
            }
          }
        } else {
          // The first projection lands a frame after the sheet opens; an empty
          // list would read as a profile with nothing in it.
          ProgressView()
        }
      }
      .navigationTitle("Profile")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          // Import only. The web header's Export and "AI interview" are
          // deliberately absent: Export is an `<a download>` blob click, which
          // does nothing in WKWebView and has no Rust staging command behind it
          // (only PDFs have one), and the interview hands off to the CHAT
          // sheet, which needs the shell's own sheet slot to present. Both
          // would be buttons that look like features and are not.
          Menu {
            Button {
              importing = true
            } label: {
              Label("Import from markdown…", systemImage: "square.and.arrow.down")
            }
          } label: {
            Image(systemName: "ellipsis.circle")
          }
          .accessibilityLabel("Profile actions")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
      .fileImporter(
        isPresented: $importing,
        allowedContentTypes: profileImportTypes,
        allowsMultipleSelection: false
      ) { result in
        handleImport(result)
      }
      .alert("Could not read that file", isPresented: $importFailed) {
        Button("OK", role: .cancel) {}
      } message: {
        Text("Pick a markdown profile exported from On Paper on the desktop.")
      }
      .confirmationDialog(
        groupingQuestion == 1
          ? "1 employer has more than one role"
          : "\(groupingQuestion ?? 0) employers have more than one role",
        isPresented: Binding(
          get: { groupingQuestion != nil },
          set: { presented in
            guard !presented else { return }
            groupingQuestion = nil
            // EVERY way out, including the one with no button: tapping outside
            // the popover on iPad dismisses it, and that used to clear only the
            // Swift state while `profileBridge` went on holding `pendingImport`.
            // Its projected `runCount` does not change, so no later snapshot
            // re-triggers the question — not even another import with the same
            // number of multi-role employers — and the import can then neither
            // be completed nor cancelled.
            Task { @MainActor in
              if !groupingAnswered { model.profile("cancelImport") }
              groupingAnswered = false
            }
          }
        ),
        titleVisibility: .visible
      ) {
        Button("Group") {
          groupingAnswered = true
          model.profile("resolveImport", ["group": "true"])
        }
        Button("Keep separate") {
          groupingAnswered = true
          model.profile("resolveImport", ["group": "false"])
        }
        // Explicit as well as covered by the setter: this one says what the
        // person chose, rather than inferring it from a dismissal.
        Button("Cancel", role: .cancel) {
          groupingAnswered = true
          model.profile("cancelImport")
        }
      } message: {
        Text("Group each employer's roles under a single company heading? Keep them separate if any of them are return stints rather than promotions.")
      }
      .onChange(of: profile?.pendingImport?.runCount) { _, runCount in
        groupingQuestion = runCount
      }
    }
    .presentationDetents([.large])
  }

  @ViewBuilder
  private func destination(_ section: ProfileView.Section) -> some View {
    if section.kind == "experience" {
      ProfileExperienceScreen(model: model, sectionId: section.id)
    } else {
      ProfileFormScreen(model: model, sectionId: section.id)
    }
  }

  /// Presentational only — the projection names the sections, this names their
  /// glyphs, and an unknown id still gets a row rather than a blank space.
  private func symbol(for id: String) -> String {
    switch id {
    case "contact": return "person.text.rectangle"
    case "summary": return "text.quote"
    case "experience": return "briefcase"
    case "skills": return "star"
    case "education": return "book"
    case "projects": return "folder"
    case "more": return "plus.square.on.square"
    default: return "square"
    }
  }

  /// Read the picked file here and send its TEXT.
  ///
  /// The web import is a hidden `<input type="file">` inside a `<label>`, which
  /// does nothing in WKWebView. The parse, the grouping decision and the write
  /// all stay in JS; this only turns a URL into a string.
  private func handleImport(_ result: Result<[URL], Error>) {
    guard case .success(let urls) = result, let url = urls.first else {
      if case .failure(let error) = result {
        NSLog("[OPProfile] import failed: \(error)")
        importFailed = true
      }
      return
    }
    // A file picked outside the app's container is only readable inside this
    // pair; without it the read fails with a permission error on a file the
    // user just chose.
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let text = try? String(contentsOf: url, encoding: .utf8) else {
      importFailed = true
      return
    }
    model.profile("importMarkdown", ["text": text])
  }
}

/// Markdown, and the plain-text types a `.md` file falls back to on a device
/// that has no declaration for it.
private let profileImportTypes: [UTType] = {
  var types: [UTType] = [.plainText, .text]
  if let markdown = UTType(filenameExtension: "md") { types.insert(markdown, at: 0) }
  return types
}()

/// The one thing in this sheet that must not be missable: the write did not
/// land, so everything typed since is only on screen.
private struct ProfileSaveWarning: View {
  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text("Not being saved").font(.subheadline.weight(.semibold))
        Text("Storage is full, so these edits are not on disk. Free up space — switching profiles or reloading now would lose them.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
    }
    .padding(.vertical, 2)
  }
}

// MARK: - Fields

/// One field, rendering whatever the projection said it is.
///
/// **The focus rule, copied from StructureSheet.** Typing writes through to
/// storage, storage republishes, and the new snapshot arrives while the user is
/// still mid-word; rendering that value back into the field they are typing in
/// resets the cursor to the end on every keystroke. So a FOCUSED field renders
/// from its own draft and ignores inbound snapshots; every other field on the
/// screen keeps updating live.
private struct ProfileFieldRow: View {
  @ObservedObject var model: ShellModel
  let field: ProfileView.Field

  @FocusState private var focused: Bool
  @State private var draft = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(field.label)
        .font(.caption)
        .foregroundStyle(.secondary)
      control
      if !field.hint.isEmpty {
        Text(field.hint)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
    .onChange(of: focused) { _, isFocused in
      // Seed on the way in; on the way out the field goes back to rendering
      // what actually landed, including anything the store normalised.
      if isFocused { draft = field.value }
      // TOLD TO THE SYNC GUARD. `userProfileHolderBusy` knew only about the
      // mounted React holder, which is not this — so a `data:userProfile` unit
      // landing during this focus was adopted and republished while the binding
      // above went on showing `draft`, and the next keystroke wrote that stale
      // text over the adopted field and uploaded it as newer.
      model.send("setNativeEditing", [
        "scope": "profile", "holder": "field", "value": isFocused ? "true" : "false",
      ])
    }
  }

  @ViewBuilder
  private var control: some View {
    switch field.kind {
    case "multiline":
      TextField(field.placeholder, text: binding, axis: .vertical)
        // A phone keyboard already owns half the screen; the web's fixed
        // rows={4}–{6} would leave two visible lines.
        .lineLimit(3...12)
        .focused($focused)
        .modifier(ProfileTextInput(field: field))
    case "choice":
      Picker(field.label, selection: choice) {
        // The stored default is "", and a Picker with no tag matching its
        // selection renders blank rather than saying so.
        Text("Not set").tag("")
        ForEach(field.options) { option in
          Text(option.label).tag(option.value)
        }
      }
      .pickerStyle(.menu)
      .labelsHidden()
    default:
      TextField(field.placeholder, text: binding)
        .focused($focused)
        .modifier(ProfileTextInput(field: field))
    }
  }

  private var binding: Binding<String> {
    Binding(
      get: { focused ? draft : field.value },
      set: { newValue in
        draft = newValue
        // Every keystroke, because there is no working copy on the other side:
        // the bridge writes through to the stored profile and this sheet reads
        // it back, which is what keeps a native edit out of the flush contract
        // backupFlow.js depends on.
        model.profile("setField", ["path": field.path, "value": newValue])
      }
    )
  }

  private var choice: Binding<String> {
    Binding(
      get: { field.value },
      set: { model.profile("setField", ["path": field.path, "value": $0]) }
    )
  }
}

/// Keyboard and text-substitution policy, per field.
///
/// `EDITABLE_TEXT_ATTRS` (src/spellcheck.js) exists because substitution
/// silently rewrites `**bold**` into curly punctuation with no undo, and these
/// values round-trip into the résumé. `.autocorrectionDisabled()` is that same
/// decision, applied to the same fields and to no others: an email, a phone
/// number or a URL keeps ordinary behaviour, exactly as the web's
/// `type="email"` inputs do.
private struct ProfileTextInput: ViewModifier {
  let field: ProfileView.Field

  func body(content: Content) -> some View {
    content
      .keyboardType(keyboardType)
      .autocorrectionDisabled(field.prose)
      .textInputAutocapitalization(capitalization)
  }

  private var keyboardType: UIKeyboardType {
    switch field.keyboard {
    case "email": return .emailAddress
    case "phone": return .phonePad
    case "url": return .URL
    // Not `.numberPad`: "3+" and "18 months" are real answers to "years", and
    // that keyboard cannot type either.
    case "number": return .numbersAndPunctuation
    default: return .default
    }
  }

  private var capitalization: TextInputAutocapitalization {
    if field.prose { return .never }
    // A capitalised address is wrong in both of these, which is why the web's
    // url/email inputs do not capitalise either.
    switch field.keyboard {
    case "email", "url": return .never
    default: return .sentences
    }
  }
}

// MARK: - Form sections

/// Contact, Summary, Skills, Education, Projects, More.
///
/// One generic screen for all six: the projection describes them as groups of
/// fields plus, optionally, a list of rows that can be added to and deleted
/// from, and nothing here knows what any of them mean.
private struct ProfileFormScreen: View {
  @ObservedObject var model: ShellModel
  let sectionId: String

  @State private var staleWarning = false

  private var section: ProfileView.Section? { profileSection(model, sectionId) }

  var body: some View {
    Form {
      if model.snapshot.profile?.saveFailed == true {
        Section { ProfileSaveWarning() }
      }
      ForEach(section?.groups ?? []) { group in
        Section {
          ForEach(group.fields) { field in
            ProfileFieldRow(model: model, field: field)
          }
          if !group.listPath.isEmpty {
            list(group)
          }
        } header: {
          if !group.title.isEmpty { Text(group.title) }
        } footer: {
          if !group.footer.isEmpty { Text(group.footer) }
        }
      }
    }
    .navigationTitle(section?.title ?? "")
    .navigationBarTitleDisplayMode(.inline)
    // RELEASED HERE, not on the row. SwiftUI does not promise a field a final
    // `false` on the way out: navigate back with the keyboard still up and
    // `ProfileFieldRow`'s `onChange(of: focused)` never fires again, leaving the
    // profile scope held — and the sheet's own teardown does not run either,
    // because the SHEET is still open. Every fetched `data:userProfile` unit is
    // then refused until some other field completes a focus/blur cycle. A stuck
    // guard stops sync silently, which is worse than the overwrite it exists to
    // prevent. `ProfileExperienceScreen` already does exactly this.
    //
    // On the SCREEN rather than the row because a `Form` row also disappears
    // when it scrolls out of view, while it is still alive and still focused —
    // a release there would drop the guard with the draft still on screen,
    // which is the original bug back again. A pop is unambiguous.
    //
    // Nothing to commit first, unlike the employer field: every keystroke here
    // already writes through (see `binding`).
    //
    // NAMED, and the name is the field row's. A blanket release here also took
    // down the guard the Dates screen raises in its own `onAppear` — a push runs
    // the destination's `onAppear` before the source's `onDisappear`, so pushing
    // INTO an editor was the thing that unguarded it.
    .onDisappear {
      model.send("setNativeEditing", ["scope": "profile", "holder": "field", "value": "false"])
    }
    .alert("That row moved", isPresented: $staleWarning) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("The profile changed while this was open, so nothing was deleted. Try again from the refreshed list.")
    }
  }

  @ViewBuilder
  private func list(_ group: ProfileView.Group) -> some View {
    if group.items.isEmpty {
      Text(group.emptyLabel).foregroundStyle(.secondary)
    }
    ForEach(group.items) { item in
      VStack(alignment: .leading, spacing: 8) {
        ForEach(item.fields) { field in
          ProfileFieldRow(model: model, field: field)
        }
      }
    }
    .onDelete { offsets in delete(group, offsets) }
    Button {
      model.profile("addItem", ["listPath": group.listPath])
    } label: {
      Label(group.addLabel, systemImage: "plus")
    }
  }

  /// Deletes take the row's own key with them, and the bridge refuses when the
  /// row at that index is no longer the one this screen was showing.
  ///
  /// One row: this list has no edit mode, so `.onDelete` is a swipe and carries
  /// a single offset. Sending several would be wrong anyway — each delete
  /// renumbers the ones after it.
  private func delete(_ group: ProfileView.Group, _ offsets: IndexSet) {
    guard let offset = offsets.first, offset < group.items.count else { return }
    let item = group.items[offset]
    model.profile("deleteItem", [
      "listPath": group.listPath,
      "index": String(item.index),
      "key": item.key,
    ]) { ok in staleWarning = !ok }
  }
}

// MARK: - Experience

/// Employers, each with its positions.
///
/// The web renders a run of one as a flat card and a run of 2+ as a block; both
/// are the same thing here, because a phone list already states a section's
/// heading once. Role-level actions are swipes and a context menu rather than
/// the desktop card's five stacked buttons.
private struct ProfileExperienceScreen: View {
  @ObservedObject var model: ShellModel
  let sectionId: String

  /// Which employer name is being typed into, and what has been typed.
  @FocusState private var focusedEmployer: String?
  @State private var companyDrafts: [String: String] = [:]
  @State private var pendingDeleteID: String?
  /// The employer's name as it stood when Delete was tapped, including a rename
  /// still sitting in the field. The commit that follows is a round trip
  /// through JS, so the snapshot would still be naming the old employer while
  /// this dialog asks to destroy it.
  @State private var pendingDeleteName = ""
  @State private var staleWarning = false

  private var section: ProfileView.Section? { profileSection(model, sectionId) }
  private var employers: [ProfileView.Employer] { section?.employers ?? [] }
  private var listPath: String { section?.listPath ?? "" }
  private var deleteTarget: ProfileView.Employer? {
    employers.first { $0.id == pendingDeleteID }
  }

  var body: some View {
    List {
      if model.snapshot.profile?.saveFailed == true {
        Section { ProfileSaveWarning() }
      }
      if employers.isEmpty {
        Section {
          Text("No experience yet")
            .foregroundStyle(.secondary)
        } footer: {
          Text("Detail beyond what the résumé says — challenges, technologies, team size, impact, what you learned.")
        }
      }
      ForEach(employers) { employer in
        Section {
          companyRow(employer)
          ForEach(employer.roles) { role in
            roleRow(employer, role)
          }
          if employer.canAddRole {
            Button {
              model.profile("addRole", [
                "index": String(employer.leadIndex), "key": employer.leadKey,
              ]) { ok in staleWarning = !ok }
            } label: {
              Label("Add role at this company", systemImage: "plus")
            }
          }
          // A detached role leaves [solo Acme] + [Acme block]; without this the
          // block's lead has no way back. Linking never writes `company` — see
          // linkAbove in profileBridge.js.
          if employer.showLinkAbove {
            Button("Link to company above") {
              model.profile("linkAbove", [
                "index": String(employer.leadIndex), "key": employer.leadKey,
              ]) { ok in staleWarning = !ok }
            }
            .disabled(!employer.canLinkAbove)
          }
        } header: {
          Text(employer.roles.count == 1 ? "Employer" : "Employer · \(employer.roles.count) positions")
        }
      }
      Section {
        Button {
          model.profile("addItem", ["listPath": listPath])
        } label: {
          Label("Add experience entry", systemImage: "plus")
        }
      }
    }
    .navigationTitle(section?.title ?? "Experience")
    .navigationBarTitleDisplayMode(.inline)
    .onChange(of: focusedEmployer) { previous, _ in
      if let previous { commitCompany(previous) }
    }
    // Leaving the screen with the keyboard still up never fires the focus
    // change, and an employer name is the one field here that is not written
    // per keystroke.
    .onDisappear {
      for id in Array(companyDrafts.keys) { commitCompany(id) }
      // …and the guard is released with them, or leaving this way would stall
      // every profile adoption until the sheet was opened and closed again.
      model.send("setNativeEditing", ["scope": "profile", "holder": "employer", "value": "false"])
    }
    // TOLD TO THE SYNC GUARD, like `ProfileFieldRow`'s own focus. This screen
    // does NOT use that row — it has its own binding and its own
    // `@FocusState` — so the notification added there covered nothing here,
    // and a `data:userProfile` unit could replace the profile underneath a
    // focused Company field. `commitCompany` then wrote the pre-fetch draft
    // over the adopted name on blur, as a fresh local change.
    //
    // This field is the one on this screen that is NOT written per keystroke,
    // so the window is the whole time the keyboard is up rather than a debounce.
    .onChange(of: focusedEmployer) { _, current in
      model.send("setNativeEditing", [
        "scope": "profile", "holder": "employer", "value": current == nil ? "false" : "true",
      ])
    }
    .confirmationDialog(
      "Delete \(pendingDeleteName.isEmpty ? "this employer" : pendingDeleteName)?",
      isPresented: Binding(
        get: { pendingDeleteID != nil },
        set: { if !$0 { pendingDeleteID = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let employer = deleteTarget else { return }
        pendingDeleteID = nil
        model.profile("deleteEmployer", [
          "index": String(employer.leadIndex), "key": employer.leadKey,
        ]) { ok in staleWarning = !ok }
      }
    } message: {
      let count = deleteTarget?.roles.count ?? 0
      Text("All \(count) \(count == 1 ? "position" : "positions") at this employer will be permanently removed from your profile.")
    }
    .alert("That entry moved", isPresented: $staleWarning) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("The profile changed while this was open, so nothing happened. Try again from the refreshed list.")
    }
  }

  private func companyRow(_ employer: ProfileView.Employer) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Company")
        .font(.caption)
        .foregroundStyle(.secondary)
      TextField("Company", text: companyBinding(employer))
        .font(.body.weight(.medium))
        .focused($focusedEmployer, equals: employer.id)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .submitLabel(.done)
        .onSubmit { focusedEmployer = nil }
    }
    .padding(.vertical, 2)
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button("Delete", role: .destructive) { askDelete(employer) }
    }
    .contextMenu {
      Button("Delete employer", systemImage: "trash", role: .destructive) {
        askDelete(employer)
      }
    }
  }

  private func roleRow(_ employer: ProfileView.Employer, _ role: ProfileView.Role) -> some View {
    NavigationLink {
      ProfileRoleScreen(model: model, roleKey: role.key, roleIndex: role.index)
    } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text(role.title.isEmpty ? "Untitled role" : role.title)
        Text(role.dates.display.isEmpty ? "No dates" : role.dates.display)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    // No confirmation, matching the web: only a whole employer asks.
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button("Delete", role: .destructive) { deleteRole(role) }
      if role.canDetach {
        Button("Detach") {
          model.profile("detachRole", [
            "index": String(role.index), "key": role.key,
          ]) { ok in staleWarning = !ok }
        }
        .tint(.orange)
      }
    }
    .contextMenu {
      if role.canDetach {
        Button("Make this its own employer", systemImage: "rectangle.split.2x1") {
          model.profile("detachRole", [
            "index": String(role.index), "key": role.key,
          ]) { ok in staleWarning = !ok }
        }
      }
      Button("Delete role", systemImage: "trash", role: .destructive) { deleteRole(role) }
    }
  }

  private func deleteRole(_ role: ProfileView.Role) {
    model.profile("deleteItem", [
      "listPath": listPath,
      "index": String(role.index),
      "key": role.key,
    ]) { ok in staleWarning = !ok }
  }

  /// Commit whatever is in the field before asking, so the dialog names the
  /// employer the user just typed rather than the one it was called an edit
  /// ago — the same reason `deleteEmployer` re-reads the live company on the
  /// web.
  private func askDelete(_ employer: ProfileView.Employer) {
    // Read the draft BEFORE resigning focus: that is what commits it, and
    // committing consumes it.
    pendingDeleteName = companyDrafts[employer.id] ?? employer.company
    focusedEmployer = nil
    pendingDeleteID = employer.id
  }

  private func companyBinding(_ employer: ProfileView.Employer) -> Binding<String> {
    Binding(
      get: {
        focusedEmployer == employer.id
          ? (companyDrafts[employer.id] ?? employer.company)
          : employer.company
      },
      set: { companyDrafts[employer.id] = $0 }
    )
  }

  /// The employer name is the ONE field here that commits on blur instead of
  /// per keystroke, and the reason is the run rule.
  ///
  /// A rename writes every role in the employer's run at once, and the run is
  /// the set of consecutive entries sharing an id AND a non-empty company. A
  /// name typed down to empty on its way to being replaced is not a run any
  /// more, so a per-keystroke write would reach the whole block up to the
  /// moment it is cleared and only the lead after it — silently leaving the
  /// other positions filed under the old employer. Committing the finished
  /// value means storage never sees the empty state at all.
  private func commitCompany(_ id: String) {
    guard let draft = companyDrafts.removeValue(forKey: id) else { return }
    guard let employer = employers.first(where: { $0.id == id }), employer.company != draft else {
      return
    }
    model.profile("setCompany", [
      "index": String(employer.leadIndex),
      "key": employer.leadKey,
      "value": draft,
    ]) { ok in staleWarning = !ok }
  }
}

/// One position: its fields, its dates, and nothing else competing for the
/// width.
private struct ProfileRoleScreen: View {
  @ObservedObject var model: ShellModel
  let roleKey: String
  let roleIndex: Int

  private var role: ProfileView.Role? { profileRole(model, key: roleKey, index: roleIndex) }

  var body: some View {
    Group {
      if let role {
        Form {
          Section {
            ForEach(role.fields) { field in
              ProfileFieldRow(model: model, field: field)
            }
          }
          Section {
            NavigationLink {
              ProfileDatesScreen(model: model, roleKey: roleKey, roleIndex: role.index)
            } label: {
              LabeledContent("Dates", value: role.dates.display.isEmpty ? "Not set" : role.dates.display)
            }
          } footer: {
            if role.dates.freeform && !role.dates.display.isEmpty {
              Text("Typed as text, so the résumé prints it exactly. Pick months instead to let positions at one employer be grouped by date.")
            }
          }
        }
      } else {
        ContentUnavailableView(
          "This role is gone",
          systemImage: "questionmark.folder",
          description: Text("It was removed while this screen was open.")
        )
      }
    }
    .navigationTitle(role.map { $0.title.isEmpty ? "Role" : $0.title } ?? "Role")
    .navigationBarTitleDisplayMode(.inline)
    // The same release as `ProfileFormScreen`'s, for the same reason — the
    // reasoning is written out there, including why it names the field row.
    // This is the screen both findings named: back out of a role with a field
    // still focused and the guard was stuck; push forward into Dates and a
    // blanket release took down the guard that screen had just raised.
    .onDisappear {
      model.send("setNativeEditing", ["scope": "profile", "holder": "field", "value": "false"])
    }
  }
}

// MARK: - Dates

private struct ProfileMonth: Equatable {
  var year: Int
  var month: Int
}

/// Hardcoded, and deliberately not a locale formatter: these labels have to
/// read the same as the string `buildDateFields` PERSISTS, and that one is
/// hardcoded in experienceDates.js for the same reason — a résumé authored in
/// one locale must not render its dates in another.
private let profileMonthNames = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

/// Matches the web picker's stepper bounds. `formatMonthField` pads to four
/// digits and the strict parser refuses anything else, so a year outside this
/// range would write a date the run gate cannot read back.
private let profileYearRange = 1900...2100

/// The month-range picker, as a pushed screen.
///
/// The web opens a 320px popover holding two month grids side by side; neither
/// fits a phone, and a Radix popover inside a native sheet positions badly. The
/// rules are the popover's, unchanged: picking a start clears the end (a range
/// restarts), and nothing is committed until the pair is complete — a half pair
/// or a reversed range makes `buildDateFields` return null, which means write
/// nothing.
private struct ProfileDatesScreen: View {
  @ObservedObject var model: ShellModel
  let roleKey: String
  let roleIndex: Int

  @Environment(\.dismiss) private var dismiss

  @State private var seeded = false
  @State private var start: ProfileMonth?
  @State private var end: ProfileMonth?
  @State private var ongoing = false
  @State private var startPage = 0
  @State private var endPage = 0
  @State private var typed = ""
  @State private var refused = false

  private var role: ProfileView.Role? { profileRole(model, key: roleKey, index: roleIndex) }

  var body: some View {
    Form {
      Section {
        ProfileMonthGrid(
          title: "Start",
          year: $startPage,
          selected: start,
          isDisabled: { _, _ in false },
          onPick: pickStart
        )
      }
      Section {
        // Writes the word "Present", which is already in the run gate's
        // ongoing vocabulary and already what the generation prompt asks for.
        Toggle("Still in this role", isOn: Binding(get: { ongoing }, set: setOngoing))
        if !ongoing {
          ProfileMonthGrid(
            title: "End",
            year: $endPage,
            selected: end,
            // A reversed range makes the entry unreadable to the run gate, so
            // the picker must not be able to produce one.
            isDisabled: { year, month in
              guard let start else { return false }
              return year * 12 + month < start.year * 12 + start.month
            },
            onPick: pickEnd
          )
        }
      }
      Section {
        TextField("Summer 2019", text: $typed)
          .autocorrectionDisabled()
          .submitLabel(.done)
          .onSubmit(commitText)
        Button("Use this text", action: commitText)
          // Text unchanged from what the field was seeded with is not an edit,
          // and committing it would run the clear rule and destroy the month
          // pair while the visible string stayed byte-identical.
          .disabled(typed == (role?.dates.display ?? "") || typed.isEmpty)
      } header: {
        Text("Or type it")
      } footer: {
        Text("Typed dates print exactly as written, but positions at one employer can only be grouped when both dates are months.")
      }
    }
    .navigationTitle("Dates")
    .navigationBarTitleDisplayMode(.inline)
    .alert("That did not save", isPresented: $refused) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("The role moved while this was open. Go back and open it again.")
    }
    // TOLD TO THE SYNC GUARD for the whole time the screen is up, like
    // `ProfileFieldRow`'s focus and the employer field's keyboard. Everything
    // this picker holds — `start`, `end`, `ongoing`, `typed` — is Swift state
    // seeded ONCE (see `seed`), so a `data:userProfile` unit adopted while it
    // is open replaces the role underneath a screen that goes on showing the
    // pre-fetch values, and the next pick writes them back over the adopted
    // dates as a fresh local change.
    //
    // Held from `onAppear` rather than from the first edit, because there is no
    // moment after seeding when this screen is NOT holding a draft. `typed` is
    // seeded from the display string, and `commitText`'s own "text unchanged
    // from what it was seeded with is not an edit" test compares against the
    // LIVE role — so an adoption alone makes an untouched seeded string differ
    // from the new display, re-enables the button, and turns "Use this text"
    // into a one-tap revert to the pre-fetch date.
    .onAppear {
      seed()
      model.send("setNativeEditing", ["scope": "profile", "holder": "dates", "value": "true"])
    }
    // Both ways out land here: a pop, and the `dismiss()` that `commitRange`
    // and `commitText` run once the write is acknowledged — so the guard is
    // never dropped while a write is still in flight. A swipe on the whole
    // sheet is covered by the profile case in `ShellView`'s sheet close, which
    // releases this scope regardless of what was pushed on top of it.
    .onDisappear {
      model.send("setNativeEditing", ["scope": "profile", "holder": "dates", "value": "false"])
    }
  }

  /// Seeded once. The snapshot republishes on every keystroke elsewhere, and a
  /// picker that re-seeded on each one would throw away a half-made selection.
  private func seed() {
    guard !seeded, let dates = role?.dates else { return }
    seeded = true
    let thisYear = Calendar.current.component(.year, from: Date())
    if dates.startYear > 0 && dates.startMonth > 0 {
      start = ProfileMonth(year: dates.startYear, month: dates.startMonth)
    }
    if dates.endYear > 0 && dates.endMonth > 0 {
      end = ProfileMonth(year: dates.endYear, month: dates.endMonth)
    }
    ongoing = dates.ongoing
    startPage = start?.year ?? thisYear
    endPage = end?.year ?? start?.year ?? thisYear
    typed = dates.display
  }

  private func pickStart(_ year: Int, _ month: Int) {
    start = ProfileMonth(year: year, month: month)
    end = nil
    endPage = year
    if ongoing { commitRange() }
  }

  private func pickEnd(_ year: Int, _ month: Int) {
    end = ProfileMonth(year: year, month: month)
    ongoing = false
    commitRange()
  }

  /// Turning it ON commits (given a start); turning it OFF only reopens the end
  /// grid, because "no end date and not ongoing" is the half pair that
  /// `buildDateFields` refuses to write.
  private func setOngoing(_ value: Bool) {
    guard value != ongoing else { return }
    ongoing = value
    guard value else { return }
    end = nil
    if start != nil { commitRange() }
  }

  /// One write of three fields — the display string and the machine-readable
  /// pair — assembled in JS by `buildDateFields`. Swift sends the selection and
  /// never the strings: a display string built here could disagree with the
  /// pair, and the run gate acts on the pair.
  private func commitRange() {
    guard let role, let start else { return }
    model.profile("setDates", [
      "index": String(role.index),
      "key": role.key,
      "mode": "range",
      "startYear": String(start.year),
      "startMonth": String(start.month),
      "endYear": String(end?.year ?? 0),
      "endMonth": String(end?.month ?? 0),
      "ongoing": ongoing ? "true" : "false",
    ]) { ok in
      if ok { dismiss() } else { refused = true }
    }
  }

  private func commitText() {
    guard let role, !typed.isEmpty, typed != role.dates.display else { return }
    model.profile("setDates", [
      "index": String(role.index),
      "key": role.key,
      "mode": "text",
      "text": typed,
    ]) { ok in
      if ok { dismiss() } else { refused = true }
    }
  }
}

/// Twelve months in a 3-column grid with a year stepper above it. Month
/// granularity, deliberately: résumé dates have no day.
private struct ProfileMonthGrid: View {
  let title: String
  @Binding var year: Int
  let selected: ProfileMonth?
  let isDisabled: (Int, Int) -> Bool
  let onPick: (Int, Int) -> Void

  private let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(title).font(.subheadline.weight(.medium))
        Spacer()
        Button {
          year = max(profileYearRange.lowerBound, year - 1)
        } label: {
          Image(systemName: "chevron.left")
        }
        .buttonStyle(.borderless)
        .disabled(year <= profileYearRange.lowerBound)
        .accessibilityLabel("Previous year")
        Text(String(year))
          .monospacedDigit()
          .frame(minWidth: 52)
        Button {
          year = min(profileYearRange.upperBound, year + 1)
        } label: {
          Image(systemName: "chevron.right")
        }
        .buttonStyle(.borderless)
        .disabled(year >= profileYearRange.upperBound)
        .accessibilityLabel("Next year")
      }
      LazyVGrid(columns: columns, spacing: 8) {
        ForEach(Array(profileMonthNames.enumerated()), id: \.offset) { offset, name in
          let month = offset + 1
          let isSelected = selected?.year == year && selected?.month == month
          Button {
            onPick(year, month)
          } label: {
            Text(name)
              .font(.subheadline)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 8)
              .background(
                isSelected ? Color.accentColor : Color.secondary.opacity(0.12),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
              )
              .foregroundStyle(isSelected ? Color.white : Color.primary)
          }
          .buttonStyle(.plain)
          .disabled(isDisabled(year, month))
          .opacity(isDisabled(year, month) ? 0.35 : 1)
          .accessibilityLabel("\(name) \(year)")
          .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        }
      }
    }
    .padding(.vertical, 2)
  }
}
