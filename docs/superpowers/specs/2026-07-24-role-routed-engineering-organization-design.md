# Role-Routed Engineering Organization Design

## 概要

private-taktに、優秀なエンジニア組織で一般的な責任分担を再現する
`Organization Plan` 層を追加する。

この層は、作業の優先順位、担当する役割、依存関係、品質ゲート、
人間へ渡す判断、再開地点を型付きの `Execution Plan` として決定する。
実際の処理は既存の `WorkflowEngine`、`workflow_call`、`teamLeader`、
`parallel`、provider設定へ変換して実行する。

目標は全役割を毎回起動することではない。最短工数・最小実装で最大の利益を
得られるよう、変更内容とリスクに必要な役割だけを選び、AIでは再現できない
判断を適切な人間へ構造化して引き継ぐ。

## 背景と課題

現在のprivate-taktには、再利用可能なworkflow、persona、並列実行、
team leaderによる作業分解、worktree隔離、devloopdのlane分類とDAG計画が
存在する。一方、次の責任が第一級のデータとして表現されていない。

- 誰が優先順位を決め、その根拠を説明するか
- 誰が設計、実装、専門レビュー、統合確認を担当するか
- 変更リスクに応じて、どの役割と品質ゲートを追加するか
- AIが判断できない内容を、どの人間へ何の証拠とともに渡すか
- 人間の判断後に、どの計画版のどの地点から安全に再開するか
- 低コストモデルの失敗を、いつ再試行、昇格、停止するか
- PR表示ではなく実際のmergeと後片付けまで、どう証拠化するか

既存の `src/devloopd/workUnitPlanner.ts` はDAGとworktree実行計画を作れるが、
役割割当、汎用的な品質プロファイル、構造化された人間承認、永続的な
work unit状態を持たない。また、既定の品質ゲートがNode/npm向けに固定されて
いるため、組織フローの共通契約としてそのまま拡張するとdevloopd固有の責任が
coreへ漏れる。

## 設計原則

1. AIは根拠を抽出・提案するが、スコア計算、権限、状態遷移、承認有効性は
   決定論的なコードで判定する。
2. Routerは登録済みの役割、workflow、品質ゲートだけを選択できる。
3. 不明、矛盾、影響解析失敗、疑わしい検証対象0件はfail-closedで扱う。
4. 既存WorkflowEngineを置換せず、その上に薄い計画層を追加する。
5. 人間が行うのはAIで再現できない判断だけとし、待機、証拠、再開、監査は
   private-taktが管理する。
6. 全役割を固定的に起動せず、変更面とリスクに応じて最小の役割集合を選ぶ。
7. 設定がなくても既存workflowの挙動は変えない。
8. ユーザー向け表示と設定説明は日本語を標準とし、内部識別子は安定した
   英語IDを使用する。

## 目標

- BALANCED標準7役を組み込み、プロジェクトYAMLで安全に上書き・追加できる。
- 期待価値、緊急度、ブロッカー解消価値、工数、根拠確信度から、説明可能で
  再現可能な優先順位を作る。
- 登録済み要素だけを使い、独立して検証可能なwork unitのDAGを構築する。
- 各work unitへ担当役割、必要能力、権限、品質ゲート、完了証拠を割り当てる。
- 必要能力を満たす最小コストモデルから開始し、型付き失敗に応じて上限付きで
  昇格する。
- `approved`、`rejected`、`needs_changes` の人間判断を記録し、staleな承認を
  拒否してチェックポイントから再開する。
- GitHub FlowではIssueからPR、レビュー、実merge確認、安全なブランチ整理まで
  証拠化する。
- core契約が安定した後、TaktDeskから同じPlan、Role、Handoff、Evidenceを
  日本語で確認・操作できる。

## 非目標

- Routerが未登録の役割、任意コード、任意workflowを実行時に生成すること
- AIが事業方針、法務判断、価格、最終製品方針を確定すること
- 本番リリース、秘密情報発行、権限変更など高影響操作を無承認で実行すること
- 実在する個人の人事評価や組織管理を自動化すること
- Phase 1から全種類の作業を自動実行すること
- 既存WorkflowEngineを汎用DAGエンジンへ全面的に置き換えること

## 検討したアーキテクチャ

### 1. YAML合成だけで拡張

既存の `workflow_call`、`teamLeader`、`parallel` をYAMLで組み合わせる。
実装は最小だが、役割、責任、優先順位、引き継ぎが条件分岐へ埋まり、案件の
増加に伴って設定が巨大化する。durableな役割割当と人間承認も別途必要になる。

### 2. Organization Plan層

役割、優先順位、DAG、品質ゲート、人間引き継ぎを型付き計画として作り、
検証後に既存WorkflowEngineへ変換する。

既存実行資産を再利用しながら、責任と判断を第一級のデータにできるため、
この方式を採用する。

### 3. devloopd外部制御

devloopdに役割ステージを追加し、各workflowを外側から順番に呼ぶ。
GitHub自動化には直結するが、coreとdevloopdに実行・状態管理が二重化し、
CLIやTaktDeskから同じ組織フローを使いにくくなるため採用しない。

## アーキテクチャ

### 責任の流れ

```text
Issue / CLI / devloopd / TaktDesk
                |
                v
       Organization Planning
       +--------------------+
       | Evidence Extractor |-- AI: 根拠を型付きで抽出
       | Role Catalog       |-- 標準役割とproject override
       | Priority Policy    |-- 決定論的スコア
       | OrganizationRouter |-- 登録済み要素でDAGを提案
       | Plan Validator     |-- 権限・依存・証拠を検証
       +--------------------+
                |
                v
       Versioned Execution Plan
                |
        +-------+-------+
        |               |
        v               v
   Plan Adapter     Human Handoff
        |               |
        v               v
  WorkflowEngine    Human Role
        |
        v
 Evidence / Audit / Resume State
```

### モジュール境界

共通契約と決定論的ポリシーは `src/core/organization/` に置く。

- `RoleCatalog`: 組み込み役割、YAML上書き、追加役割を読み込み検証する
- `PriorityPolicy`: 型付き根拠から安定した優先順位を計算する
- `OrganizationRouter`: 必要な役割とwork unit DAGの候補を作る
- `PlanValidator`: 権限、workflow参照、DAG、品質ゲート、証拠契約を検証する
- `PlanAdapter`: 検証済み計画を既存WorkflowEngineのstepへ変換する
- `ModelResolver`: 必要能力とcost tierからモデルを決める
- `HandoffPolicy`: 理由を担当Human Roleへ割り当てる
- `OrganizationEventStore`: entity単位のイベントとスナップショットを扱う

外部システム固有の処理はadapterに置く。

- devloopd adapter: backlog、lane、GitHub Flow lifecycleとの接続
- GitHub adapter: Issue、PR、review、`mergedAt`、ブランチ整理の証拠取得
- CLI adapter: dry-run、承認入力、再開、状態確認
- TaktDesk adapter: 同じschemaの日本語表示と承認操作

既存 `src/devloopd/workUnitPlanner.ts` の汎用部分は段階的にcore契約へ移し、
同じ概念を二重実装しない。言語・framework・CI固有の品質ゲートはadapterの
Quality Profileとして扱い、coreへ `npm` コマンドを固定しない。

### 既存WorkflowEngineとの境界

`PlanAdapter` は任意のruntime workflowを生成しない。Role Catalogに登録された
callable workflowを参照し、既存の `workflow_call`、`parallel`、
`teamLeader`、system stepへ変換する。

実行前に次を検証する。

- workflowが存在し、callableとして登録されている
- call chainが既存の循環・深さ制限を超えない
- roleのtool権限とworkflowの要求権限が一致する
- DAGが非循環で、全work unitに担当、完了条件、証拠契約がある
- 必須専門レビューとHuman Gateが削除されていない

この境界により、Organization Planを導入してもWorkflowEngineのstep dispatchと
既存provider routingを維持できる。

## ドメインモデル

### Role Definition

```ts
interface RoleDefinition {
  id: string;
  kind: 'ai' | 'system' | 'human';
  responsibility: string;
  workflow?: string;
  requiredCapabilities: readonly string[];
  permissionProfile: string;
  qualityProfile?: string;
  modelPolicy?: string;
  requiredOutputContract?: string;
}
```

組み込み役割の上書きでは、表示名、説明、workflow参照、model policy、
quality profileを変更できる。権限拡大は通常のproject overrideとして受け入れず、
明示的なpolicy変更と人間承認を要求する。

追加役割は、既知のpermission profile、登録済みcallable workflow、既知の
出力契約だけを参照できる。human roleはworkflowやmodelを持たない。

### Evidence-backed Priority Input

```ts
interface PriorityEvidence {
  value: number | 'unknown';
  urgency: number | 'unknown';
  unblock: number | 'unknown';
  effort: number | 'unknown';
  confidence: number;
  references: readonly EvidenceReference[];
  rationale: string;
}
```

各数値は0から100とする。AIは値を決定事項として返すのではなく、値、理由、
参照証拠を構造化する。Validatorは範囲、参照可能性、必須理由を検査する。

### Execution Plan

```ts
interface ExecutionPlan {
  schemaVersion: number;
  planId: string;
  planVersion: number;
  planHash: string;
  source: WorkSource;
  priority: PriorityDecision;
  workUnits: readonly PlannedWorkUnit[];
  humanHandoffs: readonly HumanHandoff[];
  createdAt: string;
}

interface PlannedWorkUnit {
  id: string;
  title: string;
  dependencies: readonly string[];
  ownerRole: string;
  reviewerRoles: readonly string[];
  requiredCapabilities: readonly string[];
  permissionProfile: string;
  workflow: string;
  acceptanceCriteria: readonly string[];
  expectedChangedSurfaces: readonly string[];
  qualityGates: readonly QualityGate[];
  requiredEvidence: readonly EvidenceRequirement[];
  resumeCheckpoint: string;
}
```

`planHash` は、承認対象となる実行上重要な内容から正規化して計算する。
表示文言、timestamp、実行ごとに変化する値はhash対象から除外する。

## BALANCED標準7役

### 1. Priority Manager

要求と証拠を構造化し、Priority Policyを実行する。AIが必要なのは根拠抽出だけで、
最終スコアと同点処理はsystem stepが行う。

### 2. Tech Lead / Router

登録済みの役割とworkflowを使ってwork unitへ分解し、DAG、受入条件、
必要レビューを提案する。未登録要素の生成、品質ゲート削除、権限拡大はできない。

### 3. Planner

実装順、受入条件、TDD戦略、変更面、後方互換性を具体化する。read-onlyとし、
実装ファイルを変更しない。

### 4. Implementer

隔離worktreeでTDDにより変更する。指定された変更面と権限の範囲だけを書き込み
可能とし、品質ゲートや承認記録は変更できない。

### 5. Specialist Review Pool

次の専門roleから、Routerがリスクに応じて必要なものだけを選ぶ。

- Architecture Reviewer
- Security Reviewer
- Test Reviewer
- QA Reviewer

ReviewerはImplementerの内部会話を引き継がず、成果物、差分、テスト結果、
計画、証拠だけを独立した文脈で評価する。

### 6. Integrator / Evidence Verifier

機械的に検証できる証拠を優先して確認する。PRの表示状態だけでなく、
必須check、未解決review、実際のmerge状態、対象branchを照合する。
mergeが確認できた対象だけ、安全ポリシーに従ってbranch整理へ進める。

### 7. Human Approver

AIでは再現できない製品、セキュリティ、リリース、その他の判断を行う。
agentとして実行せず、構造化Handoffの外部担当として表現する。

標準roleは毎回すべて起動しない。例:

- 文書・機械的変更:
  Priority Manager → Router → Implementer → Verifier
- 通常コード:
  上記 + Planner + Test/Code Review
- アーキテクチャ境界:
  上記 + Architecture Review + 判断根拠
- 認証・秘密情報・権限:
  上記 + Security Review + `security_owner`
- 署名・配布・本番リリース:
  Release Evidence + `release_owner`

## 優先順位

### 通常スコア

```text
Priority Score =
  0.40 * Expected Value
  + 0.20 * Urgency
  + 0.15 * Unblock Value
  + 0.15 * Quick Win
  + 0.10 * Evidence Confidence

Quick Win = 100 - Effort
```

不明なExpected Value、Urgency、Unblock Valueは0、不明なEffortは100として
保守的に扱う。証拠が不足した項目を中間値で補完しない。

同点は次の順で安定して解決する。

1. Effortが小さい
2. Urgencyが高い
3. Work itemの安定IDが辞書順で先

### Expedite

証拠で確認された重大障害、重大脆弱性、リリース阻害だけは `expedite`
service classとして通常順位より前に置く。ExpediteはAIの自由記述だけで
選択できず、既知のreason codeと必要証拠を要求する。

リスクは優先順位を下げるために使わない。高リスクで重要な作業を後回しに
しないため、リスクは専門レビューとHuman Gateを増やす入力にする。

重みはYAMLで変更可能だが、合計100、既知fieldのみ、非負、schema version一致を
必須とする。重み変更は計画hashと監査イベントに反映する。

## Organization Router

Routerは次の順序で計画候補を作る。

1. work source、acceptance criteria、変更面、policy categoryを正規化する
2. Priority Decisionとリスクシグナルを受け取る
3. 独立して成果と検証が完結するwork unitへ分解する
4. 各work unitへowner role、reviewer、workflow、quality profileを割り当てる
5. 明示依存と変更面競合からDAGを構築する
6. 必要なHuman Gateとresume checkpointを追加する
7. Plan Validatorへ渡す

既定の最大分割数は8とする。超過、循環、担当なし、受入条件なし、証拠契約なし、
未登録workflow、権限超過は実行せず、再計画またはHuman Handoffへ送る。

RouterのAI出力は計画候補であり、Validatorを通過するまで実行権限を持たない。

### アーキテクチャ変更を選ぶ条件

Quick Winのスコアが高くても、小さな局所修正では目標を満たせない場合がある。
Routerはアーキテクチャ境界を変更する候補について、必ず次を比較する。

1. 現在の境界を維持する最小案
2. 境界を変更する案
3. 何もしない場合の継続コストとリスク

境界変更を選べるのは、最小案では安全性、重複、運用負荷、拡張性のいずれかを
必要水準まで改善できず、移行コストを含めても期待利益が高い場合だけとする。
Architecture Reviewerは、比較、影響範囲、互換性、段階移行、rollback、検証方法を
含むADR候補を作る。public contract、永続データ、権限モデル、配布方式へ影響する
場合は、実装前に `project_owner` または該当Human Roleの判断を要求する。

## Human Handoff

### Handoff契約

```ts
interface HumanHandoff {
  handoffId: string;
  runId: string;
  workUnitId: string;
  planVersion: number;
  planHash: string;
  targetHead?: string;
  requiredHumanRole: HumanRoleId;
  reasonCode: string;
  question: string;
  allowedDecisions: readonly ['approved', 'rejected', 'needs_changes'];
  evidence: readonly EvidenceReference[];
  resumeCheckpoint: string;
  blockedWorkUnits: readonly string[];
}

interface HumanDecision {
  handoffId: string;
  decision: 'approved' | 'rejected' | 'needs_changes';
  rationale: string;
  conditions: readonly string[];
  decidedBy: string;
  decidedAt: string;
  expectedPlanVersion: number;
  expectedPlanHash: string;
}
```

判断理由は必須とする。条件付き承認は `conditions` に構造化して保存し、
Verifierが完了前に条件を証拠として確認する。

### 担当Human Role

- 製品方針、UX、仕様選択: `product_owner`
- 認証、秘密情報、権限、重大脆弱性: `security_owner`
- 署名、配布、本番リリース: `release_owner`
- その他、または個別role未設定: `project_owner`

最終fallbackの `project_owner` も未設定なら設定エラーで停止する。AIによる
自動承認や、Implementer、Router、ReviewerによるHuman Approver代行は行わない。

### 状態遷移

```text
READY
  -> RUNNING
  -> WAITING_HUMAN
       approved     -> REVALIDATING -> RUNNING or VERIFYING
       needs_changes -> REPLANNING  -> READY
       rejected      -> BLOCKED
  -> VERIFYING
  -> COMPLETED
```

`needs_changes` は元の履歴を上書きせず、新しいplan versionと修正work unitを作る。
`rejected` は対象と依存work unitをBLOCKEDにする。再開には新しいplan versionと
新しいHandoffが必要となる。

### stale承認とidempotency

再開時にplan version、plan hash、対象HEAD、必須証拠を照合する。いずれかが
変化した承認は `stale` として拒否し、新しいHandoffを作る。

状態更新はexpected version付きで行う。同じHuman Decisionやresume要求が
再送されても、同じ副作用を重複実行しない。

イベントログに加え、runとwork unit単位のスナップショットを保持する。
プロセス再起動後も `WAITING_HUMAN` と未完了依存を復元できなければならない。

## モデル選択

### Model Catalog

モデル名をroleやRouterへハードコードしない。設定可能なModel Catalogに次を持つ。

- providerとmodel ID
- capability集合
- cost tier
- context上限
- 利用可能toolと実行環境
- 有効・無効状態
- 同一tier内の安定した優先順

Role Profileは必要capability、context、tool権限、最大cost tierを宣言する。
Model Resolverは条件を満たす候補をfilterし、cost tier、設定順で安定して
最小候補を選ぶ。

Priority計算、Plan検証、DAG検証、状態遷移、merge証拠照合など、決定論的に
実行できる処理ではモデルを呼ばない。

### 昇格ポリシー

既定値:

- 1 work unitにつき最大3試行
- 最大2回のmodel tier昇格
- Role Profileの最大cost tierを超えない
- 同じ失敗fingerprintが2回続いた場合、同じmodelと同じ入力で再試行しない

全試行についてmodel、plan version、結果、token、費用、失敗分類、昇格理由を
監査記録へ残す。

## 失敗処理

| 種別 | 例 | 処理 |
| --- | --- | --- |
| `transient` | timeout、rate limit | 同一tierの代替または短い再試行。能力昇格しない |
| `contract_violation` | 不正JSON、必須証拠なし | 修正要求を1回返し、再発時は次tier |
| `quality_failure` | test、lint、review不合格 | 失敗証拠付きで修正し、上限後は昇格またはHandoff |
| `capability_mismatch` | context、tool、推論能力不足 | 適合する次tierへ即時昇格 |
| `policy_denied` | 権限逸脱、秘密情報、危険操作 | 再試行せず停止し、Human RoleへHandoff |
| `external_blocker` | 認証、外部障害、人間判断 | 状態を保持してWAITING_HUMAN |

最大試行またはcost上限へ達した場合、失敗証拠と試行履歴を含むHuman Handoffを
作る。品質ゲートを削除したり、より弱い検証へ変更して成功扱いにはしない。

## セキュリティと権限

- PlannerとReviewerは原則read-only
- Implementerだけを隔離worktreeでwrite可能にする
- roleごとにtoolと変更面をallowlistする
- 未登録tool、権限拡大、品質ゲート削除、自己承認をValidatorが拒否する
- 外部入力をshell文字列へ連結せず、専用adapterへ型付き引数で渡す
- secret、credential、個人情報をPlan、prompt、eventへ保存する前にredactする
- PR、merge、branch削除などの外部変更は専用adapterとpolicyを通す
- merge確認前のbranch削除、対象が曖昧な破壊操作を禁止する

選択的テストの影響解析に失敗した場合、結果が不明な場合、または対象0件が
疑わしい場合は全検証へ切り替える。全検証runnerはselector、planner、
selector設定に依存せず、fallback自体が壊れない構成にする。

## 証拠契約

各roleの出力は少なくとも次を持つ。

```ts
interface RoleResult {
  status: 'succeeded' | 'needs_changes' | 'blocked';
  summary: string;
  evidence: readonly EvidenceReference[];
  findings: readonly Finding[];
  nextAction?: string;
  attempt: number;
  modelSelection?: ModelSelectionRecord;
}
```

完了はagentの自己申告ではなく、work unitの `requiredEvidence` が満たされた
ときだけ成立する。証拠には対象、取得元、timestamp、検証結果、必要に応じて
commit SHAまたはplan hashを含める。

GitHub Flowでは少なくとも次を区別する。

- local check結果
- hosted CI結果
- unresolved review thread
- mergeability
- 実際の `mergedAt` または同等のmerge証拠
- post-merge branch cleanup結果

## YAML設定

最小設定例:

```yaml
organization:
  enabled: true
  roles:
    implementer:
      workflow: implement_with_tdd
      model_policy: cheapest_capable
    security_reviewer:
      workflow: security_review
  humans:
    product_owner: product-maintainer
    security_owner: security-maintainer
    release_owner: release-maintainer
    project_owner: repository-maintainer
  priority:
    weights:
      value: 40
      urgency: 20
      unblock: 15
      quick_win: 15
      confidence: 10
  router:
    max_work_units: 8
  retries:
    max_attempts_per_work_unit: 3
    max_model_promotions: 2
```

設定項目はJSON Schemaまたは同等のschemaで検証し、未知key、型不一致、合計が
100でない重み、未登録workflow、存在しないhuman fallbackを起動時に日本語で
説明する。

TaktDeskでは通常利用者に次だけを最初に表示する。

- 現在の優先作業と理由
- 動いている役割
- 完了した品質ゲート
- 人間の判断が必要な項目
- 次に再開される地点

role、重み、model上限、retry、workflow割当は「詳細設定」にまとめる。
各設定には「何を変える設定か」「変更すると何が起きるか」「推奨値」
「安全上の制約」を日本語で表示する。

## 段階導入

### Phase 1: Observe Only

Role Catalog、Priority Score、Execution Plan、Validator、dry-run JSONを実装する。
既存workflowを変更せず、同じ入力から誰へ何を振るかを観測する。

この段階で決定性、未登録要素の拒否、DAG、配点、設定エラーを評価する。

### Phase 2: Low-risk Execution

機械的変更、文書、小規模コードだけをPlan Adapterで既存WorkflowEngineへ
変換する。worktree隔離、TDD、Evidence Contract、独立reviewを必須にする。

### Phase 3: Durable Handoff

Human Handoff、3種類の判断、stale検知、event/snapshot永続化、再起動後の再開、
idempotencyを追加する。

### Phase 4: GitHub Flow Lifecycle

Issue、PR、review、CI、実merge、post-merge cleanupをadapterで接続する。
本番リリースは自動化せず、証拠を揃えて `release_owner` へ渡す。

### Phase 5: TaktDesk Surface

安定したcore schemaを利用し、日本語の状態表示、承認、差し戻し、詳細設定を
追加する。TaktDesk独自の別状態を作らない。

## テスト戦略

TDDで各phaseの失敗するtestを先に追加する。

### Unit

- priority配点、不明値、同点、Expedite
- role schema、override、権限拡大拒否
- DAGのlayer、循環、欠落依存、最大分割数
- 必須reviewとHuman Gate
- error分類、retry、model昇格上限
- plan hash、stale approval、idempotent decision

### Contractとproperty

- 同一入力と同一設定は同一Execution Planになる
- Planは未登録role、workflow、toolを含まない
- Human ApproverをAI roleが代行できない
- 証拠なしでwork unitをCOMPLETEDにできない
- quality gateの選択が不明なら全検証になる
- plan hashへ実行上重要な変更が必ず反映される

### Integration

- Execution Planから既存WorkflowEngine stepへの変換
- callable workflow、循環、深さ制限との整合
- worktree隔離と変更面制約
- process再起動後のevent replayとsnapshot復旧
- duplicate decision、duplicate resumeの副作用が一度だけになる
- `needs_changes` が新しいplan versionを作る

### Security

- command injectionとpath traversal
- secret redaction
- role tool権限と変更面allowlist
- stale approvalの再利用拒否
- branch削除対象のmerge証拠と明示的な対象固定
- policy変更による品質ゲート弱体化の拒否

### E2E

1. 文書だけのQuick Winが最小role集合で完了する
2. 通常コードがPlanner、Implementer、Reviewer、Verifierを通る
3. 認証変更がSecurity Reviewerと `security_owner` へ到達する
4. アーキテクチャ変更がArchitecture Reviewと判断根拠を要求する
5. 低コストmodelのcontract violationが上限付きで昇格する
6. stale承認、循環DAG、未登録workflow、証拠なし完了が拒否される
7. 実merge確認済みの対象だけbranch cleanupされる

CLI、workflow実行、provider選択、sandbox/runtimeを変更するphaseでは
`npm run test:e2e:mock` を実行する。release準備では `npm run check:release` を
実行する。

## 評価指標

自動実行へ昇格するには、Observe Onlyで次を評価する。

- 未登録role/workflow実行: 0
- stale承認再利用: 0
- 自己承認: 0
- 二重副作用: 0
- 同一入力・同一設定のPlan一致率: 100%
- Handoffの担当、質問、証拠、再開地点の欠落: 0
- 必須品質ゲート通過率
- 人間reviewで初めて見つかった欠陥率
- task lead time
- 1 work unitあたりのAI試行数とmodel cost
- 人間待ち時間
- crash後の復旧成功率
- 監査イベントから判断理由を追跡できる割合

安全性のゼロ許容条件を満たしたlaneだけPhase 2以降へ進める。平均コスト削減だけ
を理由に、安全条件を緩和しない。

## 互換性と移行

- `organization.enabled` は初期状態でopt-inとする
- 未設定時は既存workflowとdevloopdの挙動を維持する
- 保存schemaにversionを付ける
- 読み取れない旧versionを黙って破棄せず、移行または明示的停止を行う
- 各phaseを独立したfeature flagで戻せるようにする
- devloopdの既存型を一括削除せず、core型へのadapterを置いて段階移行する
- 実行が安定するまでObserve Onlyの計画と既存結果を比較記録する

## OSSとしての価値

組織role、priority policy、quality profile、human handoff schemaをproviderやGitHub
から分離し、他のCLI、CI、forge、言語でも再利用可能にする。

組み込みBALANCED profileはすぐ試せる既定値として提供し、カスタムorganization
設定は公開schema、サンプル、検証コマンド、日本語と英語の説明を用意する。
特定ベンダーのmodel名、組織名、秘密情報を標準設定へ含めない。

## 実装時のコード品質

- TypeScriptの型で不正状態を表現しにくくし、`any` と未検証のtype assertionを
  避ける。
- priority、plan hash、状態遷移、retry、idempotency、権限判定などの
  business logicには、処理内容の言い換えではなく「なぜその規則が必要か」を
  コメントで残す。
- language、framework、CI、forge固有ロジックはadapterの後ろへ置く。
- 一時生成物、秘密情報、local stateをcommitせず、必要なpathを `.gitignore` と
  公開設定例へ反映する。
- Phaseと責任境界ごとに小さなcommitを作り、各commitで対応testをgreenにする。
- 実装完了後にセルフレビュー、TypeScriptレビュー、securityレビュー、
  documentation更新を行う。

## 完了条件

- 同一入力から決定論的なExecution Planを生成できる
- 標準7役と安全なYAML overrideが利用できる
- Routerが登録済み要素だけで最大8 work unitのDAGを作る
- 低リスクplanを既存WorkflowEngineで実行できる
- model失敗が型付きで処理され、上限を超えてloopしない
- Human Handoffを保存し、3種類の判断をstale検証後に再開できる
- process再起動後にwork unitとHandoffを復元できる
- GitHub Flowのcheck、review、実merge、cleanupを区別して証拠化できる
- fail-closed条件とsecurity testがすべて通る
- TaktDeskが同じschemaを日本語で表示し、詳細設定を説明できる
- 既存workflow利用者に後方互換性がある
