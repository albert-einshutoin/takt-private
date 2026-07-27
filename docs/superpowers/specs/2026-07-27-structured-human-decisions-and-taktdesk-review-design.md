# Structured Human Decisions and TaktDesk Review Design

## 概要

private-taktの「判断待ち」を、単なる停止文言から、回答可能で再開可能な
`Decision Request`へ変更する。

Decision Requestは、何を判断するか、なぜ人の判断が必要か、どの選択肢があり、
回答後に何を行うかを構造化する。回答はprivate-taktのローカル台帳を正本として
追記保存し、対象の状態を再検証した場合だけ停止中の作業を再開する。
GitHub IssueまたはPRコメントは、明示的に選択した場合だけ同期する。

TaktDeskには判断センターを追加する。AppleのmacOS標準UI、Figmaのレビュー状態と
対象versionの考え方、NotionのStatusと段階的開示を参考に、判断対象、危険理由、
選択肢、再開結果を一つの画面で理解できるようにする。

## 背景と現状

private-taktは、人間へ戻すべき作業を次のような情報で停止できる。

- `Unsafe or too broad`
- `human review required`
- `product_policy`または`human_policy`
- `stopRule`、`reason`、`nextActions`、関連artifact

しかし、現行のdevloop ledgerとTaktDeskには次が不足している。

- 人間が答える質問本文
- YES/NO、A/B、自由記述の回答型
- 選択肢ごとの結果、利点、欠点
- 危険と判断した具体的なWhyと証拠
- 回答後に実行するHowと再開地点
- 回答、回答者、回答日時、適用結果
- 古い回答を拒否するversionと対象HEAD
- 停止作業へ回答を適用する決定論的な再開処理

TaktDeskは停止理由の文字列を表示できるが、その場で判断し、記録し、再開する
操作は持たない。このため、ユーザーは「なぜ待っているか」と「何をすれば
進むか」をログから推測しなければならない。

## 設計原則

1. 回答の正本はprivate-taktのローカル台帳とする。
2. 質問、回答、再開、GitHub同期は同じDecision IDで追跡する。
3. AIは質問と選択肢の候補を作れるが、schema、状態遷移、再開可否は
   決定論的なコードで検証する。
4. 回答の保存と回答の適用を分離し、古い回答で作業を再開しない。
5. 再開操作は登録済みのResume Strategyだけを使い、台帳から任意commandを
   実行しない。
6. GitHub同期は任意かつデフォルトOFFとし、失敗してもローカル回答を失わない。
7. 判断理由と証拠を示すが、secret、credential、顧客情報、raw private diffを
   保存または投稿しない。
8. 既存の非構造化stop ruleは読み取り互換を保つが、推測した回答で自動再開しない。
9. TaktDesk独自の判断状態を作らず、private-taktのschemaと台帳から表示する。
10. 色だけに意味を持たせず、状態ラベル、VoiceOver、キーボード操作を提供する。

## 目標

- YES/NO、単一選択A/B、自由記述の判断要求を型付きで保存できる。
- What、Why、Risk、Options、How、再開条件を必須化できる。
- TaktDeskとCLIの両方から回答できる。
- 回答を追記保存し、process再起動後も復元できる。
- staleなversion、HEAD、run、issueまたはPR状態では再開を拒否できる。
- 同じ回答または再開要求を再送しても副作用を重複実行しない。
- 回答適用後、停止したissue run、direct run、PR automation stageを
  登録済みcheckpointから再開できる。
- GitHub同期の成功、失敗、未同期をローカルで確認・再送できる。
- TaktDeskで未回答、回答済み、再開済み、再判断必要を識別できる。

## 非目標

- 人間の代わりにAIがproduct、security、releaseの最終判断を行うこと
- GitHubコメントを回答の正本にすること
- 任意shell commandを回答後に実行する汎用承認機構
- staleな回答を自動的に新しいHEADへ移し替えること
- 過去の全stop ruleを自動的に構造化Decision Requestへ変換すること
- 複数人の投票、quorum、組織権限管理
- TaktDeskをFigmaやNotionの視覚的複製にすること
- 初期実装でRust FFIを導入すること

## 検討した方式

### 1. TaktDeskが停止ログから質問を推測する

UIだけを短期間で追加できる。しかしログ文言から回答型、選択肢、再開地点を
安定して復元できず、private-taktとTaktDeskで判断意味が分岐する。
安全な再開を証明できないため採用しない。

### 2. private-taktに構造化Decision Requestを追加する

質問、回答、再開を同じ台帳とschemaで扱い、CLI、devloopd、TaktDeskが同じ意味を
共有する。process再起動、stale検知、監査、任意GitHub同期を実装できるため、
この方式を採用する。

### 3. GitHub IssueまたはPRコメントを正本にする

共同レビューには向くが、GitHub未認証、通信障害、rate limit、comment編集で
ローカル作業が再開不能または不整合になる。GitHubは任意の同期先に限定する。

## ドメインモデル

### Decision Request

```ts
type DecisionKind = 'yes_no' | 'single_choice' | 'text';

type DecisionStatus =
  | 'open'
  | 'answered'
  | 'applying'
  | 'applied'
  | 'revalidation_required'
  | 'superseded';

interface DecisionRequest {
  schemaVersion: 1;
  decisionId: string;
  decisionVersion: number;
  subject: DecisionSubject;
  kind: DecisionKind;
  what: string;
  why: DecisionWhy;
  how: DecisionHow;
  options: readonly DecisionOption[];
  answerRequirements: AnswerRequirements;
  resumeGuard: ResumeGuard;
  createdAt: string;
}
```

`decisionId`は論理的な判断を識別する。質問、対象、選択肢、再開条件の
実行上重要な内容が変わる場合は`decisionVersion`を増やし、旧versionを
`superseded`にする。

`DecisionRequest`は作成時点の不変データとする。`DecisionStatus`はevent foldで
導出するprojectionであり、request eventのfieldを後から書き換えない。

### 対象

```ts
interface DecisionSubject {
  repoPath: string;
  repository?: string;
  runSlug?: string;
  workflow?: string;
  step?: string;
  issueNumber?: number;
  prNumber?: number;
  candidateId?: string;
  title: string;
}
```

外部入力から得たtitleはsanitizeし、表示上限を設ける。`repoPath`はローカルの
再開対象識別に使うが、GitHubコメントへ投稿しない。

### What、Why、Risk

```ts
interface DecisionWhy {
  summary: string;
  riskCategory:
    | 'product_policy'
    | 'human_policy'
    | 'requirements_ambiguity'
    | 'security'
    | 'permission'
    | 'external_dependency'
    | 'high_risk'
    | 'unknown';
  reasons: readonly string[];
  evidence: readonly DecisionEvidence[];
}

interface DecisionEvidence {
  kind: 'run' | 'report' | 'changed_path' | 'check' | 'issue' | 'pr' | 'policy';
  reference: string;
  summary: string;
}
```

`why.summary`だけで「なぜ停止したか」が理解できなければschema validationを
通さない。`unknown`は危険でないことを意味せず、最も保守的な表示と再開制約を
選ぶ。

### YES/NOとA/B

```ts
interface DecisionOption {
  id: string;
  title: string;
  description: string;
  consequences: readonly string[];
  recommended: boolean;
  recommendationReason?: string;
}
```

YES/NOでもUI上の意味を明確にするため、`yes`と`no`の2 optionを明示的に保存する。
タイトルは「はい」だけでなく、「はい — 公開APIの変更を許可」のように
選択結果を説明する。

単一選択は2件以上8件以下とする。`recommended`は最大1件で、選択済みを意味しない。
破壊的または高リスクな選択肢を既定選択にしない。

自由記述では`options`を空にし、`AnswerRequirements`で文字数と理由の必須性を
検証する。

### HowとResume Strategy

```ts
type ResumeStrategy =
  | 'rerun_issue'
  | 'resume_direct_run'
  | 'continue_pr_stage'
  | 'replan'
  | 'manual_only';

interface DecisionHow {
  summary: string;
  strategy: ResumeStrategy;
  checkpoint: string;
  expectedEffects: readonly string[];
  verification: readonly string[];
}
```

台帳へcommand文字列を保存して実行してはならない。`strategy`ごとに登録済みadapterが
型付きsubjectから引数を組み立てる。

- `rerun_issue`: issue番号、repository、base/headを再検証してissue pipelineへ戻す
- `resume_direct_run`:既存runのresume可否を検証してTAKT resumeへ渡す
- `continue_pr_stage`: PR head、label、review、checkを再検証して指定stageへ戻す
- `replan`: 回答を新しいtask contextとして計画を作り直す
- `manual_only`: 回答だけを保存し、自動再開しない

### Resume Guard

```ts
interface ResumeGuard {
  contextHash: string;
  expectedDecisionVersion: number;
  expectedRunStatus?: string;
  expectedHeadSha?: string;
  expectedBaseSha?: string;
  expectedIssueUpdatedAt?: string;
  expectedPrUpdatedAt?: string;
}
```

`contextHash`は、質問、選択肢、subject、How、重要なpolicy理由を正規化して計算する。
timestamp、表示文言、ローカル絶対pathはhash対象から除外する。

### 回答

```ts
interface DecisionAnswerInput {
  decisionId: string;
  expectedDecisionVersion: number;
  expectedContextHash: string;
  value: { optionId: string } | { text: string };
  rationale: string;
  idempotencyKey: string;
}
```

回答理由はproduct、security、permission、high riskでは必須とする。
同じ`idempotencyKey`の再送は同じ結果を返し、新しいeventを増やさない。
保存時にprivate-taktが認証済みまたはローカル実行者の識別子とserver-side timestampを
追加する。クライアントが回答者や回答日時を偽装できる入力fieldは設けない。

適用前の回答訂正は、旧回答を消さず`decision_answer_superseded`を追記する。
適用済みの回答は書き換えず、新しいDecision Requestを作る。

## 台帳イベントと永続化

ローカル正本は既存の`.devloop/ledger.jsonl`を使う。

追加するevent type:

- `devloop_decision_requested`
- `devloop_decision_answered`
- `devloop_decision_answer_superseded`
- `devloop_decision_apply_started`
- `devloop_decision_applied`
- `devloop_decision_apply_failed`
- `devloop_decision_revalidation_required`
- `devloop_decision_github_sync`

すべて追記専用とし、既存のfile lock、atomic append、`0600`を利用する。
状態はevent foldで復元する。起動時の高速化が必要な場合は、台帳を正本にした
再生成可能なsnapshotを追加できるが、snapshotだけから回答済みと判定しない。

eventにはschema versionを持たせる。未知versionを黙って無視せず、TaktDeskとCLIで
「新しいprivate-taktが必要です」と表示する。

## Decision Requestの生成

### Issue Scout

`product_policy`、`human_policy`、high riskで
`Unsafe or too broad`になったcandidateごとにDecision Requestを作る。

既存のcandidateから次を利用する。

- title、summary
- policy category、risk bucket
- evidence、acceptance criteria
- escalation criteria、expected changed surfaces
- lane evidence

一般的な「human reviewが必要」だけではなく、具体的な危険理由と
「scopeを縮小する／この方針で進める／見送る」などの回答可能な選択肢を作る。
AIが選択肢候補を作った場合も、最大件数、重複ID、空理由、未知strategyを
決定論的に拒否する。

### PR Automation

product-policy impact、forbidden path、current-head approval不足、merge queue eviction
など、停止後に人の判断で進路が変わるactionからDecision Requestを作る。

機械的に解消できるCI failure、rate limit、backoffはDecision Requestにせず、
既存のretryまたはfailureとして扱う。人間へ不要な判断を増やさない。

### Workflow Blocked

workflowがrequirements ambiguity、permission、external dependencyを構造化して
返した場合にDecision Requestへ変換する。単なるprovider errorやtimeoutは
失敗として扱い、YES/NO質問へ偽装しない。

### 旧形式

過去の`Unsafe or too broad`文字列は「旧形式の判断待ち」として表示する。
質問とResume Guardがないため、そのまま回答・再開はできない。
必要な場合は最新状態を再検査して新しいDecision Requestを生成する明示操作を
提供する。旧ログから選択肢を推測して自動適用しない。

## 回答と再開の状態遷移

```text
OPEN
  -> ANSWERED
       -> APPLYING
            -> APPLIED
            -> REVALIDATION_REQUIRED
            -> ANSWERED + APPLY_FAILED
       -> ANSWER_SUPERSEDED -> ANSWERED
  -> SUPERSEDED
```

`回答のみ記録`は`ANSWERED`で停止する。
`回答を記録して再開`は回答eventを確定した後、別のapply transitionへ進む。

再開前に次を再検証する。

- decision versionとcontext hash
- run statusとcheckpoint
- issueまたはPRのopen/closed状態
- head SHAとbase SHA
- branchとworktreeのdirty/conflict
- active runとprocess
- label、review、check、permission、authentication
- 同じDecision IDのapply結果

不一致は`REVALIDATION_REQUIRED`にし、回答を削除しない。新しい状態と質問内容が
同じなら新versionを作り、異なるなら新しいDecision Requestを作る。

回答内容だけで安全gateを無効化しない。たとえばproduct方針を承認しても、
test failure、dirty worktree、head mismatch、未解決reviewを通過扱いにしない。

## CLI

追加するCLI:

```text
devloopd decisions list --cwd <repo> [--status open] [--json]
devloopd decisions show --cwd <repo> --id <decision-id> [--json]
devloopd decisions answer --cwd <repo> --stdin-json
devloopd decisions apply --cwd <repo> --id <decision-id> --idempotency-key <key>
devloopd decisions sync-github --cwd <repo> --id <decision-id>
```

自由記述をprocess listやshell historyへ露出しないため、回答本文は標準入力の
JSONで受け取る。CLIはschema validation結果を日本語と機械可読JSONで返す。

`answer --resume`の便利なaliasを提供してもよいが、内部ではanswerとapplyを
別eventとして実行する。

## GitHub任意同期

GitHub同期はデフォルトOFFとする。TaktDeskでは投稿対象、本文、repository、
IssueまたはPR番号を確認するsheetを表示する。

コメントには次を含める。

- Decision IDとversion
- What、Whyのsanitize済み要約
- 選択した回答と理由
- ローカルでの適用状態
- 秘密でない場合だけ再開runまたはPRへの参照

コメントmarker:

```html
<!-- takt-decision:v1 id=<decision-id> version=<n> -->
```

再送時はmarkerを検索し、同じversionの重複コメントを作らない。
コメント取得または更新に失敗した場合はローカルに
`github_sync: failed`を記録し、回答と再開をrollbackしない。

GitHubへ投稿しない情報:

- ローカル絶対path
- raw private diff
- credential、token、secret
- 顧客情報、private issue本文の不要な引用
- providerのraw error payload

## TaktDesk情報設計

### 全体構成

既存のmacOS標準sidebar + detailを維持し、sidebar上部へ
`判断待ち`を1項目追加する。未回答件数をbadgeで示す。

各project rowとproject heroは、未回答Decision Requestがある場合に橙の
`判断待ち`状態と`判断内容を見る`を表示する。失敗は赤、進行中は緑点滅、
判断待ちは橙として意味を分離する。

判断センターは次を提供する。

- 未回答、回答済み、再判断必要、再開済みfilter
- project、risk category、回答型filter
- 更新時刻と緊急度によるsort
- decision listと選択中decisionのinspector
- 解決済み判断の履歴表示

### Decision Inspector

表示順を固定する。

1. `What — 何を決めるか`
2. `Why — なぜ判断が必要か`
3. `Risk — 何が危険か`
4. `Options — 選択肢と影響`
5. `How — 回答後に何をするか`
6. `技術的な詳細 — 証拠、HEAD、run、policy`

主要情報を常に表示し、raw evidenceは`DisclosureGroup`へ入れる。
情報だけのalertを連続表示せず、対象context内のcardとinspectorで発見できるようにする。

### 回答control

YES/NO:

```text
[ はい — 公開APIの変更を許可 ]
[ いいえ — 互換性を維持 ]
```

A/B:

- option cardにtitle、短い説明、結果、利点、欠点を表示する
- private-taktの推奨案には`推奨`badgeと理由を表示する
- 推奨案を自動選択しない
- 最大8件をradio selectionとして扱う

自由記述:

- 複数行TextEditor
- 必須理由と文字数をinline validation
- secretを入力しない注意を表示
-回答内容は送信前に確認できる

### 主要操作

- `回答のみ記録`
- `回答を記録して再開`
- `GitHubにも同期` toggle。デフォルトOFF
- `再検証`
- `技術的な詳細を表示`

破壊的または不可逆な再開にdefault buttonを設定しない。
GitHub同期はellipsis付きの確認操作からsheetを開く。
実行中はbutton内にprogressを表示し、二重送信を無効化する。

### 状態表現

| 状態 | 色 | ラベル | 操作 |
| --- | --- | --- | --- |
| 未回答 | orange | 判断待ち | 回答 |
| 回答済み | blue | 回答記録済み | 再開 |
| 適用中 | green pulse | 再開処理中 | 無効 |
| 適用済み | green | 再開済み | 履歴 |
| 再判断必要 | red | 前提変更 | 再検証 |
| GitHub未同期 | orange secondary | ローカル記録済み | 再送 |
| 旧形式 | gray | 旧形式の判断待ち | 最新状態から作成 |

色に加え、symbol、ラベル、VoiceOver valueを必須とする。
Reduce Motionではpulseを静的表示へ変える。

## TaktDeskのデータ経路

表示は`.devloop/ledger.jsonl`のDecision eventを読み、Decision IDごとにfoldする。
大きな台帳を高頻度に全読込しないため、file identity、offset、末尾の不完全行を
保持するincremental scannerを使う。file rotationまたはtruncateを検知した場合だけ
全再構築する。

Swift側には公開schemaと対応するvalue modelを置く。private-taktのJSON fixtureを
Swift contract testでも読み、意味のdriftを防ぐ。

回答、適用、GitHub同期はTaktDeskが台帳へ直接書き込まず、同梱private-taktの
CLIへ型付きJSONを標準入力で渡す。これによりlock、validation、idempotency、
Resume Guardを一箇所に保つ。

初期実装はSwiftとNodeの既存境界を利用する。incremental scanとasync processで
必要な応答性能を満たせるためRust FFIは追加しない。計測で大規模台帳のfoldが
実際のbottleneckになった場合だけ、公開schemaを維持した独立indexerとして検討する。

## モジュール境界

private-takt:

- `src/devloopd/decisionRequest.ts`: schemaとvalidation
- `src/devloopd/decisionEvents.ts`: event生成とfold
- `src/devloopd/decisionStore.ts`: lock付きappendとquery
- `src/devloopd/decisionResume.ts`: strategy registryとResume Guard
- `src/devloopd/decisionGithubSync.ts`: 任意GitHub adapter
- issue scout、PR automation、workflow blocked adapter: request生成
- CLI adapter: list、show、answer、apply、sync

TaktDesk:

- Core Models: DecisionRequest、DecisionAnswer、DecisionState
- Core Services: DecisionLedgerScanner、DecisionPresentation
- App Services: PrivateTaktDecisionClient
- Store: decision list、selection、answer/apply state
- Views: DecisionCenterView、DecisionInspectorView、DecisionAnswerView、
  DecisionHistoryView、GitHubSyncReviewSheet

Viewは台帳fold、process起動、GitHub処理を持たない。

## セキュリティ

- JSONLとsnapshotを`0600`で作成する
- append時は既存file lockとatomic write policyを使う
- 外部文字列をshell commandへ連結せずargument arrayとstdinを使う
- path containmentとrepository identityを再開前に検証する
- Decision event保存前とGitHub投稿前に別々のredactionを行う
- answer本文をlog、process argument、analyticsへ出さない
- symlink、truncate、rotation、malformed JSONLをfail-closedで扱う
- 未知schema、未知strategy、未知option IDを拒否する
- 自己承認、AI回答、stale回答、別repositoryのDecision ID利用を拒否する
- GitHub対象をsubjectから固定し、UI自由入力でrepositoryや番号を差し替えない

## エラー処理

| エラー | ローカル回答 | 再開 | 表示 |
| --- | --- | --- | --- |
| schema不正 | 未保存 | しない | 修正箇所 |
| duplicate answer | 既存結果 | 重複しない | 回答済み |
| stale version/hash | 保持 | 拒否 | 再判断必要 |
| head/run変更 | 保持 | 拒否 | 新旧差分 |
| lock timeout | 未保存 | しない | 再試行可能 |
| resume adapter失敗 | 保持 | 失敗 | 原因と次の操作 |
| GitHub未認証 | 保持 | 影響なし | 未同期 |
| GitHub重複marker | 保持 | 影響なし | 同期済み |
| malformed ledger tail | 既存状態 | 新規操作停止 | 台帳修復案内 |

失敗を`unknown`へ丸めず、回答保存、回答適用、GitHub同期のどこで失敗したかを
別々に表示する。

## テスト戦略

TDDで失敗するtestを先に追加する。

### private-takt Unit

- 3種類のDecision Request schema
- YES/NO option数とID
- A/Bの重複、上限、推奨数
- textの長さと理由
- context hashの決定性
- event foldと全状態遷移
- answer correctionとapplied後の変更拒否
- idempotency key
- unknown schema/strategy/option拒否
- sensitive text redaction

### private-takt Integration

- issue scoutの危険candidateからrequest生成
- PR product-policy stopからrequest生成
- answerのlock付き`0600` append
- process再起動後のevent replay
- issue、direct run、PR stageのstrategy adapter
- head SHA、run status、dirty/conflict、active runのstale拒否
- answer保存後のapply failure保持
- GitHub comment preview、marker dedupe、未認証、再送
- CLI stdin JSONと機械可読error

### private-takt Security

- command injection、path traversal、symlink
- 別repositoryのDecision ID
- forged option ID、version、context hash
- raw secret、local path、private diffのGitHub流出防止
- duplicate applyによる二重run防止
- decision承認による既存quality gate bypass防止

### TaktDesk Core

- private-takt fixtureとのSwift decode contract
- incremental append、末尾不完全行、truncate、rotation
- Decision IDごとのfold
- 日本語What/Why/How presentation
- filter、sort、未回答count
- stale、apply failure、GitHub未同期の表示

### TaktDesk UI

- YES/NOの結果説明付きbutton
- A/B option cardと非自動選択
- text validation
- 回答のみ／回答して再開
- GitHub同期がデフォルトOFF
- stale時の再開button無効化
- progress中の二重送信防止
- VoiceOver、keyboard、Reduce Motion、色以外の状態表現

### E2E

1. issue scoutがproduct-policy candidateで停止し、判断センターにWhat/Why/Howを表示する
2. YES回答を保存し、鮮度確認後にissue pipelineを再開する
3. A/B回答がreplan contextへ入り、新しいrunを作る
4. 自由記述回答がprocess argumentやlogへ露出せず保存される
5. 回答後にPR headが変わり、再開が拒否される
6. GitHub未認証でもローカル回答と再開が成功する
7. GitHub同期再送で重複コメントを作らない
8. appとprivate-taktのprocess再起動後も判断状態を復元する

private-taktのCLI、devloopd、workflow実行を変更するため、実装完了時は少なくとも
build、lint、unit test、mock E2E、personal replay gateを実行する。
TaktDeskは全Swift test、Release build、同梱runtime検証、実画面と
アクセシビリティの確認を行う。

## 段階導入とPR分割

### PR 1: Decision schemaとevent store

- 型、validation、context hash
- append-only event、fold、query
- unit、property、security test
- 挙動はまだ既存stop ruleから変えない

### PR 2: Decision生成

- issue scout
- PR automation
- workflow blocked adapter
- 旧形式互換表示用metadata

### PR 3: CLI回答と安全な再開

- list、show、answer、apply
- Resume Strategy registry
- stale検証、idempotency、crash recovery

### PR 4: 任意GitHub同期

- preview、明示確認、marker dedupe
- redaction、failure/retry

### PR 5: TaktDesk read-only判断センター

- incremental scanner
- list、filter、inspector、history
- What/Why/Risk/How表示

### PR 6: TaktDesk回答と再開

- YES/NO、A/B、自由記述
- CLI client
- 回答、再開、GitHub同期sheet
- accessibilityとvisual verification

各PRは前のPRへ依存するstacked diffではなく、merge済みmainから次のbranchを作る。
TaktDeskにremoteがない間は同じ責任単位のlocal commitに分け、remote設定後に
PRへ移せるようにする。

## 互換性

- 新しいDecision eventを生成しない既存workflowは従来どおり動作する
- 既存stop ruleとautomation state eventを削除しない
- 旧形式はread-onlyで表示し、構造化回答を偽装しない
- schema versionを持ち、未知versionは明示的に停止する
- feature flagでrequest生成、apply、GitHub同期、TaktDesk操作を個別に戻せる
- stableなcore schemaが確定するまでGitHub同期はopt-inを維持する

## OSSとしての価値

Decision Request、Answer、Resume GuardをGitHub、provider、TaktDeskから分離する。
GitLab、ローカルforge、CI、別GUIからも同じJSON schemaとCLIを利用できるようにする。

公開物には次を含める。

- JSON Schema
- TypeScript API
- CLI JSON出力
- 日本語と英語の利用ガイド
- YES/NO、A/B、自由記述のexample fixture
- custom Resume Strategyを安全に追加するadapter contract

特定ユーザーのrepository、path、issue本文、秘密情報をfixtureへ保存しない。

## UI参考資料

- Apple Human Interface Guidelines:
  [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)、
  [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)、
  [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- Figma:
  [Dev Mode statuses and notifications](https://help.figma.com/hc/en-us/articles/26781702258583-Dev-Mode-statuses-and-notifications)、
  [View and manage comments](https://help.figma.com/hc/en-us/articles/360041547593-View-and-manage-comments)
- Notion:
  [Database properties](https://www.notion.com/help/database-properties)、
  [Comments and discussions](https://www.notion.com/help/guides/comments-and-discussions)

## 完了条件

- 3種類のDecision RequestがWhat、Why、Risk、Howを欠かさず保存される
- 回答がローカル台帳へ追記され、再起動後も復元される
- staleなversion、context、HEAD、runでは再開できない
- duplicate answerとduplicate applyが副作用を重複させない
- 登録済みResume Strategyだけが実行される
- GitHub未認証または同期失敗でもローカル回答を失わない
- TaktDeskで判断待ち件数、理由、選択肢、回答、再開結果を確認できる
- YES/NO、A/B、自由記述をkeyboardとVoiceOverで操作できる
- 旧形式の判断待ちを誤って回答・再開できない
- 全test、security review、実画面検証、同梱runtime検証が完了する
