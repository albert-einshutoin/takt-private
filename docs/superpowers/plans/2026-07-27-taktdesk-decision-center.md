# TaktDesk Decision Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a refined macOS Decision Center that explains What/Why/Risk/How, accepts YES/NO, A/B, or text answers, and safely invokes the bundled private-takt answer/apply/sync commands.

**Architecture:** TaktDeskCore incrementally reads private-takt decision events into immutable Swift projections. TaktDesk renders those projections in the existing sidebar/detail/inspector structure and performs mutations only through a typed stdin-JSON client for the bundled private-takt CLI.

**Tech Stack:** Swift 6, SwiftUI/AppKit on macOS, Swift Package Manager/XCTest, bundled Node/private-takt runtime, existing DashboardStore and adaptive refresh loop.

---

## File map

- Create `Sources/TaktDeskCore/Models/DecisionRequest.swift`: immutable Codable request.
- Create `Sources/TaktDeskCore/Models/DecisionAnswer.swift`: answer input/value without actor/time.
- Create `Sources/TaktDeskCore/Models/DecisionState.swift`: folded lifecycle/history/sync state.
- Create `Sources/TaktDeskCore/Models/DecisionPresentation.swift`: filters, labels, indicators, validation.
- Create `Sources/TaktDeskCore/Services/DecisionLedgerScanner.swift`: incremental JSONL event scanner/fold.
- Create `Sources/TaktDesk/Services/PrivateTaktDecisionClient.swift`: stdin JSON process boundary.
- Create `Sources/TaktDesk/Views/DecisionCenterView.swift`: inbox/list/filter surface.
- Create `Sources/TaktDesk/Views/DecisionInspectorView.swift`: What/Why/Risk/Options/How.
- Create `Sources/TaktDesk/Views/DecisionAnswerView.swift`: YES/NO, A/B, text controls.
- Create `Sources/TaktDesk/Views/DecisionHistoryView.swift`: applied/superseded audit.
- Create `Sources/TaktDesk/Views/GitHubSyncReviewSheet.swift`: optional external-write preview.
- Modify `Sources/TaktDesk/Services/ProjectRefresher.swift`, `Sources/TaktDesk/Stores/DashboardStore.swift`,
  `Sources/TaktDesk/Views/ContentView.swift`, `Sources/TaktDesk/Views/ProjectSidebarView.swift`,
  and `Sources/TaktDesk/Views/ProjectDashboardView.swift`.
- Add focused XCTest files named below.

### Task 1: Swift decision contract and shared fixtures

**Files:**
- Create: `Sources/TaktDeskCore/Models/DecisionRequest.swift`
- Create: `Sources/TaktDeskCore/Models/DecisionAnswer.swift`
- Create: `Sources/TaktDeskCore/Models/DecisionState.swift`
- Create: `Tests/TaktDeskCoreTests/DecisionRequestContractTests.swift`
- Copy test resources from private-takt sanitized `fixtures/decisions/*.json` through `Package.swift`
- Modify: `Package.swift`

- [ ] **Step 1: Write failing decode tests**

```swift
import XCTest
@testable import TaktDeskCore

final class DecisionRequestContractTests: XCTestCase {
    func testDecodesYesNoChoiceAndTextFixtures() throws {
        for name in ["yes-no", "single-choice", "text"] {
            let data = try fixtureData(named: name)
            let request = try JSONDecoder().decode(DecisionRequest.self, from: data)
            XCTAssertEqual(request.schemaVersion, 1)
            XCTAssertFalse(request.what.isEmpty)
            XCTAssertFalse(request.why.summary.isEmpty)
            XCTAssertFalse(request.how.summary.isEmpty)
        }
    }

    func testRejectsUnknownSchemaVersion() throws {
        let data = Data(#"{"schemaVersion":2}"#.utf8)
        XCTAssertThrowsError(try DecisionRequestDecoder.decode(data))
    }
}
```

- [ ] **Step 2: Verify failure**

Run: `swift test --filter DecisionRequestContractTests`

Expected: FAIL because the model/decoder do not exist.

- [ ] **Step 3: Implement Codable value types**

Use enums with explicit raw values for decision kind/status/risk/resume strategy. Keep request,
answer, apply result, GitHub sync, and projection separate. `DecisionRequestDecoder` must reject
unknown schema versions with a Japanese `LocalizedError`.

- [ ] **Step 4: Run focused tests**

Run: `swift test --filter DecisionRequestContractTests`

Expected: PASS for all three private-takt fixtures.

- [ ] **Step 5: Commit**

```bash
git add Package.swift Sources/TaktDeskCore/Models/DecisionRequest.swift Sources/TaktDeskCore/Models/DecisionAnswer.swift Sources/TaktDeskCore/Models/DecisionState.swift Tests/TaktDeskCoreTests/DecisionRequestContractTests.swift Tests/TaktDeskCoreTests/Fixtures/decisions
git commit -m "feat(decisions): decode private-takt decision contracts"
```

### Task 2: Incremental decision ledger scanner

**Files:**
- Create: `Sources/TaktDeskCore/Services/DecisionLedgerScanner.swift`
- Test: `Tests/TaktDeskCoreTests/DecisionLedgerScannerTests.swift`

- [ ] **Step 1: Write failing incremental tests**

Create a temporary `.devloop/ledger.jsonl`, scan one request, append an answer, and assert the
second scan reads only the appended byte range while producing `answered`. Add cases for an
incomplete final line, truncate/rotation, malformed event, and unknown schema.

```swift
XCTAssertEqual(first.projections["dec_1"]?.status, .open)
XCTAssertEqual(second.bytesRead, appendedData.count)
XCTAssertEqual(second.projections["dec_1"]?.status, .answered)
```

- [ ] **Step 2: Verify failure**

Run: `swift test --filter DecisionLedgerScannerTests`

Expected: FAIL because the scanner does not exist.

- [ ] **Step 3: Implement scanner state**

Implement the scanner as an actor and store file identity, offset, pending partial bytes, and
projections inside one scanner instance.
Reset only after inode/size regression. Fold known events by Decision ID; preserve prior valid
state and report a visible scanner error for malformed tails instead of silently marking a
decision resolved.

- [ ] **Step 4: Run focused tests**

Run: `swift test --filter DecisionLedgerScannerTests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/TaktDeskCore/Services/DecisionLedgerScanner.swift Tests/TaktDeskCoreTests/DecisionLedgerScannerTests.swift
git commit -m "feat(decisions): scan decision ledger incrementally"
```

### Task 3: Presentation, filtering, and answer validation

**Files:**
- Create: `Sources/TaktDeskCore/Models/DecisionPresentation.swift`
- Test: `Tests/TaktDeskCoreTests/DecisionPresentationTests.swift`

- [ ] **Step 1: Write failing presentation tests**

Assert Japanese labels, orange open, blue answered, green applying/applied, red revalidation,
project/risk/status filters, newest/urgent sort, no auto-selection of recommended options,
text bounds, and rationale requirements.

- [ ] **Step 2: Verify failure**

Run: `swift test --filter DecisionPresentationTests`

Expected: FAIL because presentation types do not exist.

- [ ] **Step 3: Implement pure presentation values**

Provide `DecisionStatusPresentation`, `DecisionFilter`, `DecisionSort`, and
`DecisionAnswerValidator`. Return semantic indicator values rather than SwiftUI `Color` from
TaktDeskCore. Keep all labels Japanese and convert unknown metadata to `未確認`.

- [ ] **Step 4: Run focused tests**

Run: `swift test --filter DecisionPresentationTests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/TaktDeskCore/Models/DecisionPresentation.swift Tests/TaktDeskCoreTests/DecisionPresentationTests.swift
git commit -m "feat(decisions): present actionable decision states"
```

### Task 4: Typed bundled private-takt client

**Files:**
- Create: `Sources/TaktDesk/Services/PrivateTaktDecisionClient.swift`
- Test: `Tests/TaktDeskCoreTests/PrivateTaktDecisionClientTests.swift`

- [ ] **Step 1: Write failing process-boundary tests**

Inject a fake process runner and assert:

```swift
XCTAssertEqual(invocation.arguments, ["decisions", "answer", "--cwd", project.path, "--stdin-json", "--json"])
XCTAssertFalse(invocation.arguments.joined().contains(answerText))
XCTAssertTrue(String(data: invocation.standardInput, encoding: .utf8)!.contains(answerText))
```

Test answer, apply, preview/sync, nonzero exit, invalid JSON, cancellation, and bounded timeout.

- [ ] **Step 2: Verify failure**

Run: `swift test --filter PrivateTaktDecisionClientTests`

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement the actor client**

Resolve executable `devloopd` only through `BundledPrivateTaktRuntime.environment`. Send
`DecisionAnswerInput` through stdin, close stdin promptly, capture bounded stdout/stderr through
an injected exact-PID process executor, decode machine JSON, and redact answer text from errors.
Never invoke a shell, host private-takt, or write the ledger directly.

- [ ] **Step 4: Run focused tests**

Run: `swift test --filter PrivateTaktDecisionClientTests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/TaktDesk/Services/PrivateTaktDecisionClient.swift Tests/TaktDeskCoreTests/PrivateTaktDecisionClientTests.swift
git commit -m "feat(decisions): call bundled private-takt safely"
```

### Task 5: Dashboard state and adaptive refresh integration

**Files:**
- Modify: `Sources/TaktDesk/Services/ProjectRefresher.swift`
- Modify: `Sources/TaktDesk/Stores/DashboardStore.swift`
- Modify: `Tests/TaktDeskCoreTests/DashboardStoreRefreshTests.swift`

- [ ] **Step 1: Write failing store tests**

Extend `ProjectRefreshPayload` with decisions. Assert store exposes global/project decisions,
unanswered counts, keeps the last successful projection on scanner failure, prevents duplicate
answer/apply tasks, and refreshes immediately after mutation.

- [ ] **Step 2: Verify failure**

Run: `swift test --filter DashboardStoreRefreshTests`

Expected: FAIL because payload/store have no decision state.

- [ ] **Step 3: Integrate scanner and client**

Add published decisions and separate answer/apply/GitHub mutation states. Keep scanner instances per project so
offsets survive polling. Add `recordAnswer`, `recordAnswerAndResume`, `revalidate`, and
`syncGitHub` methods. Existing app-update blocking and command-safety checks must remain active.

- [ ] **Step 4: Run store regressions**

Run:
`swift test --filter 'DashboardStoreRefreshTests|AppUpdateSafetyTests|LiveStatusPresentationTests'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/TaktDesk/Services/ProjectRefresher.swift Sources/TaktDesk/Stores/DashboardStore.swift Tests/TaktDeskCoreTests/DashboardStoreRefreshTests.swift
git commit -m "feat(decisions): manage decision inbox state"
```

### Task 6: Decision Center navigation and inspector

**Files:**
- Create: `Sources/TaktDesk/Views/DecisionCenterView.swift`
- Create: `Sources/TaktDesk/Views/DecisionInspectorView.swift`
- Create: `Sources/TaktDesk/Views/DecisionHistoryView.swift`
- Modify: `Sources/TaktDesk/Views/ContentView.swift`
- Modify: `Sources/TaktDesk/Views/ProjectSidebarView.swift`
- Modify: `Sources/TaktDesk/Views/ProjectDashboardView.swift`
- Modify: `Sources/TaktDeskCore/Support/ProjectSelectionResolver.swift`
- Test: `Tests/TaktDeskCoreTests/ProjectSelectionResolverTests.swift`
- Test: `Tests/TaktDeskCoreTests/JapanesePresentationTests.swift`

- [ ] **Step 1: Write failing navigation/presentation tests**

Add stable selection ID `decision-center`, selection fallback tests, and source assertions for
`判断待ち`, `What — 何を決めるか`, `Why — なぜ判断が必要か`, `Risk`,
`How — 回答後に何をするか`, and `技術的な詳細`.

- [ ] **Step 2: Verify failure**

Run:
`swift test --filter 'ProjectSelectionResolverTests|JapanesePresentationTests'`

Expected: FAIL because the destination/views do not exist.

- [ ] **Step 3: Build the native macOS surface**

Add one lightweight sidebar row with unread badge. Generalize the existing command-console
inspector selection into `console(projectID)` or `decision(decisionID)` so inspectors are not
stacked. Render a filterable decision list in detail and the selected request in a native
inspector. Use semantic materials, system spacing,
`DisclosureGroup` for evidence, orange/blue/green/red plus text/symbol labels, and project hero
button `判断内容を見る`. Do not add modal alerts for passive information.

Add `.decisionWaiting` to `LiveStatusIndicator`; blocked work with an open Decision Request must
render static orange instead of the existing failed red. Cover it in
`Tests/TaktDeskCoreTests/LiveStatusPresentationTests.swift`.

- [ ] **Step 4: Run navigation tests and build**

Run:
`swift test --filter 'ProjectSelectionResolverTests|JapanesePresentationTests' && swift build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/TaktDesk/Views/DecisionCenterView.swift Sources/TaktDesk/Views/DecisionInspectorView.swift Sources/TaktDesk/Views/DecisionHistoryView.swift Sources/TaktDesk/Views/ContentView.swift Sources/TaktDesk/Views/ProjectSidebarView.swift Sources/TaktDesk/Views/ProjectDashboardView.swift Sources/TaktDeskCore/Support/ProjectSelectionResolver.swift Tests/TaktDeskCoreTests/ProjectSelectionResolverTests.swift Tests/TaktDeskCoreTests/JapanesePresentationTests.swift
git commit -m "feat(ui): add the decision center"
```

### Task 7: YES/NO, A/B, text answers, and GitHub review sheet

**Files:**
- Create: `Sources/TaktDesk/Views/DecisionAnswerView.swift`
- Create: `Sources/TaktDesk/Views/GitHubSyncReviewSheet.swift`
- Modify: `Sources/TaktDesk/Views/DecisionInspectorView.swift`
- Test: `Tests/TaktDeskCoreTests/DecisionPresentationTests.swift`
- Test: `Tests/TaktDeskCoreTests/JapanesePresentationTests.swift`

- [ ] **Step 1: Add failing interaction-contract tests**

Assert result-oriented YES/NO labels, no recommended auto-selection, text/rationale validation,
two primary workflows (`回答のみ記録`, `回答を記録して再開`), GitHub toggle default false,
stale/applying disabled states, and explicit preview before sync.

- [ ] **Step 2: Verify failure**

Run:
`swift test --filter 'DecisionPresentationTests|JapanesePresentationTests'`

Expected: FAIL because answer views/actions are absent.

- [ ] **Step 3: Implement controls and review sheet**

Use standard buttons for YES/NO, radio-style option cards for A/B, and bounded `TextEditor`.
Never select recommendations automatically. Show expected effects and verification before
resume. GitHub sync opens a sheet with fixed repository/Issue/PR and sanitized body preview;
the user confirms the external write separately.

- [ ] **Step 4: Run focused tests and build**

Run:
`swift test --filter 'DecisionPresentationTests|JapanesePresentationTests' && swift build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Sources/TaktDesk/Views/DecisionAnswerView.swift Sources/TaktDesk/Views/GitHubSyncReviewSheet.swift Sources/TaktDesk/Views/DecisionInspectorView.swift Tests/TaktDeskCoreTests/DecisionPresentationTests.swift Tests/TaktDeskCoreTests/JapanesePresentationTests.swift
git commit -m "feat(ui): answer and resume blocked work"
```

### Task 8: Accessibility, runtime integration, visual QA, and full verification

**Files:**
- Modify the decision views only where validation finds issues.
- Modify: `README.md` or the existing user guide section for Decision Center.

- [ ] **Step 1: Add accessibility identifiers and announcements**

Every status light needs a text value; every option needs title, consequence, selected state;
answer/apply/sync success and failure use `AccessibilityAnnouncer`; Reduce Motion disables
applying pulse; Tab/Shift-Tab and Escape work in inspector/sheet.

- [ ] **Step 2: Run the complete Swift gate**

Run:

```bash
swift test
swift build -c release
git diff --check
```

Expected: all tests pass and Release build exits 0.

- [ ] **Step 3: Package current private-takt main and verify provenance**

Build/package using a clean private-takt worktree at the exact merged commit:

```bash
TAKTDESK_PRIVATE_TAKT_SOURCE=/absolute/clean/private-takt-worktree ./script/build_and_run.sh --verify
jq '{version,commit}' dist/TaktDesk.app/Contents/Resources/runtime/manifest.json
codesign --verify --deep --strict --verbose=2 dist/TaktDesk.app
```

Expected: runtime commit equals the intended private-takt commit; host `takt/devloopd` is not
used; code signature verifies.

- [ ] **Step 4: Perform visual and interaction QA**

Capture and inspect open YES/NO, A/B, text, applying, stale, applied, and GitHub-unsynced states
in Light/Dark mode and Reduce Motion. Verify narrow window behavior, long Japanese text,
VoiceOver reading order, full keyboard flow, and that red/orange/green meanings are not
color-only. Fix every material issue and rerun Swift tests.

- [ ] **Step 5: Security and self-review**

Confirm answer text never appears in argv/errors, TaktDesk never writes ledger JSONL directly,
external sync always has explicit confirmation, stale state disables apply, refresh cannot
cancel an in-flight mutation, and app update cannot interrupt active work.

- [ ] **Step 6: Commit**

```bash
git add Sources Tests README.md
git commit -m "docs(decisions): document TaktDesk decision workflow"
```
