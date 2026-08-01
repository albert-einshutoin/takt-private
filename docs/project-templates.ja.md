# プロジェクトテンプレートパック契約（v1）

プロジェクトテンプレートパックは、`.takt/` の設定をリポジトリ間、そして
TAKT や TaktDesk などのクライアント間で安全に移行するための形式です。v1 は
データ契約のみを定義します。ファイル適用やコマンド実行をせずに、解析・確認・
lock 化できます。

## manifest

manifest には `schemaVersion: "1.0"`、SemVer の `packVersion`、対応する
`takt.minVersion`（任意で `maxVersion`）、`kind`・`uri`・`ref`・不変の `commit`
を含む `source`、そして `entries` を指定します。各 entry は `.takt/` root 相対の POSIX パス、
`managed` / `merge` / `scaffold` / `excluded` の policy、4 桁 POSIX mode、
小文字の SHA-256 を必ず持ちます。

- `managed`: 管理対象ファイルを置き換える
- `merge`: 後続の三者マージ対象として扱う
- `scaffold`: 存在しないファイルだけを作成する
- `excluded`: 意図的に適用しない entry を記録する

`excluded` を含め、すべての entry に digest を持たせます。これによりプレビューと
lock の内容が再現可能になります。

たとえば `.takt/hooks/prepare.sh` は `hooks/prepare.sh` と記録します。
`.takt/` prefix、絶対パス、`..`、空セグメント、Windows の区切り文字・予約名、
ADS の `:`、control 文字、末尾の dot/space は拒否されます。大文字小文字だけが
異なる path の解釈差を避けるため、v1 の各 path segment は ASCII の英数字と
`.` `_` `-` のみに限定します。Unicode はファイル内容では制限されず、可搬 path
名だけの制約です。NFC 検証と NFKC + locale-aware lowercase の collision key は
defense-in-depth として維持します。Windows の
`CONIN$` と `CONOUT$` も予約名です。これにより macOS と Windows で
検証結果が変わらないようにします。各 segment はASCII 255文字、path全体は
512文字を上限とします。

`source` は kind ごとの discriminated union です。`github` は `.git` なしの
`https://github.com/owner/repository`、`git` は credential を含まない HTTPS URL、
`local` は `.` または `.takt/templates/...` を含む ASCII 相対 POSIX path と固定 ref
`workspace` を使用します。query、fragment、
control 文字、local workstation の絶対 path は保存できません。すべての source は
小文字 hexadecimal 40 または 64 文字の commit に固定します。
Git/GitHub URI は WHATWG URL でも解析し、入力と完全に round-trip する canonical
表現だけを許可します。userinfo、query、fragment、dot segment、percent-encoded
slash/backslash、default port や host の大文字小文字による別名は拒否します。
GitHub owner/repository の `.` と `..` も無効です。

`source.ref` は `git check-ref-format` のportable subsetです。`HEAD` や
`feature/review-152` は有効ですが、`..`、`.` で始まるsegment、末尾`.`、
`.lock` で終わるsegment、`@{`、backslash、control、space、およびGitが禁止する
`~ ^ : ? * [` を拒否します。ref全体の上限は従来どおり256文字です。

## capability

危険になり得る操作は宣言的に扱います。entry の capability は entry 自身と
トップレベルの `capabilities` の両方で宣言する必要があります。実行ビットを持つ
entry はさらに `executable` の宣言が必須です。利用できる名前は `executable`、
`github-write`、`external-command` です。

この二重宣言により、UI は適用前にパックが要求する権限を漏れなく表示できます。
解析処理自体が capability を実行することはありません。

## API・schema・lock

公開 API は `parseProjectTemplateManifest`、
`serializeProjectTemplateManifest`、`parseTemplateLock`、
`serializeTemplateLock`、およびエディタや連携ツール向けの
`calculateProjectTemplateManifestSha256`、`validateManifestLockPair`、
`validateDetectedTemplateCapabilities`、
`projectTemplateManifestV1JsonSchema`、`projectTemplateLockV1JsonSchema` を
提供します。schema は Ajv 6 と互換の JSON Schema draft-07 です。検証エラーは
安定した `code` と `field` を持つ `ProjectTemplateValidationError` なので、
呼び出し側は文言ではなく code を判定に使用してください。

package 利用側は、documented API を `takt` package root から import してください。
内部の `dist/**` module は review・storage の trust boundary を迂回し得るため、
意図的に export しません。この `exports` 境界は `takt`、`takt-dev`、`takt-cli`、
`devloopd` command を変更しませんが、未サポートの deep import に依存していた
consumer に対しては semver-visible な変更です。

lock は manifest と同じ `schemaVersion`、`packVersion`、`source`、トップレベル
capability と、path/policy/mode/digest/capability の entry 一覧を記録します。
さらに canonical manifest の `manifestSha256` を保持するため、意味が変わった別の
manifest に lock を流用できません。

schema は構造と単一 field の制約を検証します。TAKT min/max の順序、path の重複・
case・Unicode normalization 衝突、policy conflict、実行 bit と capability の関係、
plain object/array、manifest と lock の照合は複数 field にまたがるため runtime-only
です。schema が成功しても parser と `validateManifestLockPair` を必ず実行します。

入力上限はentry 4,096件、path/source URI 512 ASCII文字、各path segment
255文字、ref 256 code point、capability 3件です。parser はown propertyだけの
plain JSON objectと密なarray
のみ受け入れ、継承値、accessor、class instance、sparse/拡張 array は entry 処理前に
拒否します。

classifier と archive inspector は `{ path, capabilities }` の検出証拠を
`validateDetectedTemplateCapabilities` に渡します。検出 capability は対応 entry
と manifest の両方で宣言済みでなければならず、未知 path は fail-closed で拒否します。
entry が検出結果にないことや、検出処理自体を実行していないことは「trusted」の証拠に
なりません。呼び出し側は inspection の完了状態を別に管理し、必要な証拠がなければ
apply を拒否します。

WHATWG URL の canonical round-trip、ASCII path 境界、NFC 必須、NFKC collision key、capability
detection の完了性は runtime-only です。draft-07 schema は editor feedback 用であり、
runtime parser と検出照合の代わりにはなりません。

## ローカルプロジェクトの分類

`scanProjectTemplateDirectory(projectRoot)` は `projectRoot/.takt` を検査し、
redacted preview を返します。`entries` の path は `.takt` 相対です。sibling の
`.devloop` は固定 sentinel `.devloop` の excluded entry としてだけ記録し、その配下を
走査しません。すでに上限付き content を保持している連携先は、副作用のない
`classifyProjectTemplateEntry` core を利用できます。

portable candidate は共有 `workflows/`、`facets/`、`provider-options/` だけです。
project config、automation、quality gate は `project-owned` として明示的な policy
review を要求し、unknown path は default deny で excluded になります。runtime state、
log、cache、sensitive filename は candidate content として読みません。生成される
`sessions/`、`worktree-sessions/`、`clone-meta/`、`findings/`、
`language-cache/`、`runs/`、`worktrees/` と、`input_history`、
`persona_sessions.json`、`session-state.json`、`tasks.yaml`、
`staged-devloop-state.json` も runtime state です。runtime directory は
検証済みの相対 root だけを記録し、配下を走査しません。secret、
workstation の絶対 path（POSIX、home 相対、drive letter、UNC）、binary、symlink、
hard link、special file、realpath escape、
portable-name collision、独立した各 resource 上限超過は blocked です。

classifier は manifest と同じ `parsePortablePath` validator を再利用します。不正または
sensitive な入力名は元の名前を返さず、固定の redacted sentinel として報告します。
public input も bounded で、content は 1 MiB 以下、bytes は content と一致する
nonnegative safe integer、mode と digest は manifest と同じ形式、信頼済み absolute
path hint は件数・各長さ・合計長の独立上限を満たす必要があります。content がある
場合は core 自身が SHA-256 を計算し、caller 指定値との不一致を拒否します。
metadata-only 呼び出しでは caller 指定 digest を証拠として返さず、inspection は
`incomplete` です。

`scanStatus` は `complete` / `incomplete` / `blocked` を区別します。`canExport` が true
になるのは scan が complete で blocked と project-owned entry がない場合だけで、
project-owned がある場合は `reviewRequired` が true になります。各 file preview は
bytes、mode、SHA-256、安定した reason code、redacted summary、suggested policy、
warning、`validateDetectedTemplateCapabilities` に渡せる capability evidenceを返します。
capability evidence は `inspectionStatus` も返します。空の capability list が
authoritative なのは `complete` の場合だけで、metadata skip は `incomplete`、block
された検査は `blocked` です。executable、GitHub write、external command、曖昧な
command behavior の検出時は `reviewRequired` になります。
すべての `gh` command と GitHub API 向け `curl` は、保守的に `github-write` と
`external-command` の両方として扱います。unknown command は inspection を
`incomplete` にして review を要求します。`- run:` のような YAML block sequence
内の command key も同じように検出します。YAML capability 検査は alias を展開せず、
上限付き syntax tree を走査します。parse error、duplicate key、multi-document、
alias、非scalar execution value、depth/node 上限超過は `incomplete` のまま
review-required です。

`README.md`、`automation/**`、`quality-gates/**` は project-owned の
`scaffold` 候補です。既存ファイルを置換せず、存在しない場合だけ生成します。
`quality-gates/logs/**` は runtime state のため常に excluded です。共有wrapperを
scaffoldする場合、そのwrapperはproject-local gateへ委譲し、gateの欠落・失敗を
弱いfallbackで成功に変換してはいけません。

## config YAMLの三者マージ

`config.yaml` と `devloopd.yaml` の `merge` entryは、正式lockが参照するbase、
現在のlocal、incoming templateを使ってschema-awareに三者マージします。
provider routing、allowed/forbidden provider、base branch、workflow command gateは
project-ownedです。languageなどの安全なdefaultはtemplate-managed、loggingやCLI pathは
global-only、API key・token・passwordなどのcredential pathはforbiddenです。
credential名を `api.key` のように複数mappingへ分割しても禁止判定を回避できません。

mappingはleaf単位で比較します。同じleafをlocalとincomingが別々に変更した場合は、
具体的なpathを持つconflictになります。sequenceはfieldごとに `atomic`、
`unordered-set`、削除を許さない`monotonic-set`、または`ordered-keyed`を明示し、
未登録sequenceを暗黙に連結しません。quality gateのidentityはruntimeと共有し、
省略されたdefault timeoutなどを理由に同じcommandを重複追加しません。

編集元にはlocal YAML documentを使い、未変更node、mapping順、local comment、
sequence itemの表現、BOM、単一種類の改行、final newlineを保持します。semantic no-opは
local bytesをそのまま返します。alias、anchor、merge key、custom tag、複数document、
directive、および変更を伴うmixed EOLはfail-closedです。unknown keyは黙って削除せず、
保持後に同じproject schema validatorへ渡し、未対応ならpath付きerrorにします。
merge結果はapply planのdigestと診断へsealされ、executorは保存済みbaseから再導出して
一致しないresolved bytesを適用しません。

directory 列挙は bounded `opendir` stream を使い、`maxNodes + 1` で停止します。
この global witness に達すると残りの再帰と sibling もすべて停止します。inode と
realpath の検証に失敗した名前は `[unverified-entry]` としてだけ記録し、列挙された
raw name を error 証拠へ返しません。そのため攻撃者が大量に作った child 名を一括で
memory に展開しません。directory は
列挙前後にtype、device、inode、link count、timestamp、realpathを照合します。
scanner は open 済み file の stat snapshot を比較して走査中の変更を検出しますが、
成功した snapshot は恒久的な安全証明でも、後続 archive bytes の証明でもありません。
Issue #138 の archive 作成時と apply 時には type、containment、link count、size、
mode、digest、capability evidence を reopen して再検証してください。

## `.taktpack` export・inspect

`.taktpack` v1 は非圧縮のcontent-addressed USTARです。entry順は
`pack.json`、`manifest.json`、`export-report.json`、続いて
`blobs/sha256/<SHA-256>` のhash昇順に固定されます。destination pathはmanifestだけが
保持し、blob名にproject pathを含めません。headerのuid、gid、mtime、modeを固定し、
canonical JSONを使用するため、同一inputはbyte-for-byteで同じartifactになります。

`createProjectTemplateExportPlan` はclassifierがblocked/incompleteの場合、未承認の
capabilityがある場合、project-owned entryのpolicyが未指定の場合にfail-closedです。
runtimeやsensitive pathを開いてhash化せず、除外reasonの件数だけをredacted reportへ
記録します。source fileの絶対pathとinode snapshotはplanのJSONには含まれない
process-local stateとして保持されます。返却planは再帰的readonly/deep freezeで、
process-localなcanonical sealに束縛されます。writerはsealed snapshotからcontrol
documentを再構築し、copy・mutationされたplanをtemp作成前に拒否します。v1の
`warnings`はclosedな空fieldです。`excludedReasons`はclassifier reason codeだけを
許可し、bounded countの合計が`counts.excluded`と一致しなければなりません。

`writeTaktpack` はsourceを`O_NOFOLLOW`でreopenし、root containment、type、inode、
link count、size、mode、timestamp、SHA-256を再検証します。同一digestを複数pathが
共有する場合も全sourceを検証し、全件成功後に代表blobだけを同一directoryの`wx`
tempへstreamし、fsync後にpublishします。`force: false`はhard-link publishで競合時にも
no-clobberを維持し、`force: true`もregular single-link file以外を拒否して、完成した
新packをrenameするまで既存fileを保持します。
Windowsでは完成fileのfsync後、directory fsyncをunsupportedとして扱い、正常に
publish済みのartifactを失敗とは報告しません。

writer/inspectorのfilesystem failureはすべて、pathをredactした安定
`TaktpackError` codeへ正規化します。writerはarchive entryをawaitする前にpipeline
rejection handlerを即時attachします。`ARCHIVE_WRITE_FAILED`、
`ARCHIVE_READ_FAILED`、`DURABILITY_FAILED`、`CLEANUP_FAILED`はsource/tempのraw
pathを含みません。writerのI/O errorには`artifactState`があり、`not-published`は
destination未publish、durability errorの`published`は完成artifactが存在する一方で
directory durabilityを確認できなかった状態です。cleanup failureがprimary failureを
上書きすることはありません。

`inspectTaktpack` はextractも外部`tar`も使いません。USTAR blockを順次読み、
directory、PAX/GNU extension、sparse、symlink、hardlink、device、FIFO、unknown name、
順序違反、duplicate、truncation、trailing data、各resource上限超過をwrite前に
拒否します。pack indexがmanifest、export report、blobのhashとsizeを束縛し、
manifest/lock seed照合とclassifierによるsecret・absolute path・binary・capabilityの
再検査も行います。`currentTaktVersion`を省略した互換性は安全を仮定せず
`status: "unknown"`です。inspect結果は正式な`TemplateLockV1`ではなく、構造的に
異なる`{ kind: "project-template-lock-seed", ... }`を返します。承認と正式lock作成は
後続のapply段階の責務です。

## apply-preview review surface

公開するapply-previewのruntime surfaceは、
`renderProjectTemplateApplyPreviewHuman`と
`renderProjectTemplateApplyPreviewJson`だけです。公開型は
`ProjectTemplateApplyPreview`、`ProjectTemplateApplyPreviewBindings`、
`ProjectTemplateApplyPreviewCompositionConflictCode`、
`ProjectTemplateApplyPreviewContentHardConflict`、
`ProjectTemplateApplyPreviewApprovalEvidence`の5つです。previewの合成、seal検証、
hash計算、trusted approvalのissue/consume/revoke、rawなG2/G3/G4 composition
surface、approval storageはprivateのままです。

previewはsealされたprocess-local valueです。cloneやdeserializeしたlookalikeは、
どちらのrendererも受け付けません。両rendererはprecondition tokenを表示せず、
human/JSON出力はreview表示であって変更権限ではありません。approval evidenceも
process-localかつopaqueです。durable approval recordは監査stateにすぎず、それ単体は
権限ではありません。evidence objectをcopy・再構築しても権限を取得できません。

private approvalのTTLは5分で、single-useかつ使用前に不可逆にrevokeできます。
hard conflictを含むpreviewは承認できません。legacyのcontent-only approvalは、
repertoire-dependency planもそのcompanion lockも承認しません。trusted previewと
confirmationをpublic clientへ渡すH integrationは未完成です。現時点ではpublicな
approval issue/consume経路はなく、consumerはinternal deep importへ依存してはいけません。

## atomic applyとrollbackの境界

変更境界へ進めるのは、seal検証済みで競合のないapply planだけです。ただしplan sealは
previewを運ぶためのintegrity checksumであり、変更権限ではありません。apply前に、
独立したarchive inspection receipt、現在の正式lock、fresh target snapshot、incoming
manifest、検証済みcontents、独立したbaseline採用判断からcanonical plan全体を
再導出します。そのためaction、
digest、mode、capability、entry集合、global decisionを改ざんしてsealを再計算しても、
target変更前に拒否されます。downloadやwriteより前に、active/stale run、壊れたrun
evidence、personal daemon、stop-request、
persistent automationをread-only検査し、不明な証拠もfail-closedで拒否します。
run/daemon開始とapplyは同じ短期coordination mutexを使うため、preflightとlease取得の
間へ新しいrunnerが滑り込むこともありません。task runはproject所有のworkflow、
provider、runtime configを読み込み、`running` metadataをdurableに公開し終えるまで
同じmutexを保持します。worktree実行は通常のmetadataをworktree側へ保存すると同時に、
衝突しないcoordination mirrorを本体project rootにも公開します。初回または終了時の
mirror書き込みが失敗してもfail-closedな証拠を残すため、applyがactive worktree runを
見落としたり、古いtemplate世代を読み込んだrunと競合したりすることはありません。

templateに依存するすべての実行入口は、project configを読む、またはruntime task stateを
変更する前にdurableなpreparation recordを公開します。対象はqueue、direct resume、
direct selection、pipeline、run-all dispatch、watch lifecycleです。このrecordはretry
stateの解決、workspaceの作成・copy、attachment staging、次taskのclaim、watch待機中の
applyを拒否します。そのため、activeなwatchはidle中も意図的にtemplate applyを拒否し、
packを適用するときは先にwatchを停止する必要があります。

recordはowner-onlyの同一directory temp fileへ書き、file fsync、rename、POSIXでの
parent-directory fsyncを終えてから公開済みと扱います。canonical run metadataと必要な
coordination mirrorをdurableに公開した後でpreparation recordをterminal化するため、
引継ぎの瞬間にも保護の切れ目はありません。terminalなpreparation recordは監査用に
通常のrun historyへ残り、他のrunと同じretention policyに従います。準備processが
予期せず停止した場合、running recordはstaleとなり、既存の明示的なrecovery flowを
必要とします。長時間のcopyを放棄と推測して時間だけで自動解除することはありません。

GitHub remote previewは`receiptKey`から署名済みreceiptをofflineで開き直し、receipt
HMAC、cache path identity、archive digest、canonical USTAR、manifest、dependency refの
検証証拠を再確認します。bounded memoryへ保持するのはmanifestが参照するblobだけです。
receiptのfile authorityはtargetやinstall済みrepertoireを調べる前に消費され、previewへ
cache path、credential、receipt key、timestamp、apply authorityを残しません。そのため
apply時にはreceipt/cacheを必ずfresh readします。

portable installは`.takt-template-lock.json`、
`.takt-template-repertoire-lock.json`、`.takt-template-source-lock.json`の
3 companion lockを1 cohortとして扱います。previewが許可するのは全absentのfirst install
または全presentのupdateだけです。mixed、noncanonical、unreadable、symlink、hardlink、
special fileはfail-closedで拒否します。source lockへ保存するのはcanonicalな
repository/ref/tag/commit、archive/manifest/descriptor hash、version、dependency verification
digestだけで、credential、absolute path、receipt key、timestampは保存しません。
repository変更、version downgrade、同じtagが別commitを指すrepublishはhard conflictです。
domain-separatedな`transactionPlanId`がcontent/dependency/source plan、現在と次の3 lock、
target precondition、baseline strategy、認証済みreceipt provenanceを結びます。approvalは
`previewId`と`transactionPlanId`を明示的にbindし、TTL付きsingle-useを維持します。

applyは全outputをsecure stagingへ生成・再検証してから`.takt/`を変更します。正式content lock
は`.takt-template-lock.json`、privateなstaging・journal・世代数を制限したbackupは
`.takt-template-state/`へ保存します。後者はGit ignore対象かつowner-only permission
です。各control root自身にも`*`のprivate `.gitignore`を生成するため、任意の適用先で
backupが`git add -A`へ混入しません。このignore fileをdurableに作成・検証してからだけ
run-start mutex、apply lease、recovery markerを公開します。新しく作ったprivateな
staging、backup、blob directoryは、その内容を信頼する前にPOSIXでparent-directory
fsyncも完了させます。backup対象は変更するtemplate entryと正式lockだけで、runtime stateやexcluded
contentを新しく収集しません。backup manifestは元のhash、mode、timestampを監査用に
記録し、transaction前には存在しなかった適用先の親directoryも証拠として保持します。
補償、recovery、operator rollbackは、それらが空のままである場合だけ深い順に削除し、
既存directoryや後から内容が追加されたdirectoryは保持します。復元の一致判定は、
replaceでtimestamp自体が更新されるためhash、mode、absenceとdoctor結果を正式な
contractにします。

複数の独立fileをfilesystemのrenameだけで同時切替することはできません。そのためv1は
単一exclusive leaseの下でdurable journal、決定的なfile単位replace、補償rollbackを
組み合わせます。write、chmod、rename、file fsync、directory fsyncのどの失敗も
transaction failureとして扱い、適用後のconfig/workflow doctor失敗も元treeへ戻します。
doctorは新templateを採用するときだけgateにします。補償、operator rollback、recoveryは
記録済みのhistorical hash・mode・absence witnessへ復元できれば完了し、過去snapshotへ
現在のvalidator通過を要求しません。operator rollbackは、適用後に期待する全pathの
hash・mode・absenceを最初に一括検証し、
driftが1件でもあれば最初の変更前に停止します。
processが明示markerを書けない時点で停止しても、non-terminal durable journalが次の
download/writeとrun開始をfail-closedで止めます。`recoverProjectTemplateApply`は
journalとbackup manifestからcommittedまたはrolled-backへ収束し、検証成功後だけ
recovery markerを所有identity付きで解除します。
準備中の失敗では、そのtransactionが所有するstagingと未完成backupを削除します。
cleanup自体が中断された場合は、次のexclusive apply leaseがtarget変更前にboundedな
orphan回収を行い、valid manifestのある世代は保持し、壊れた証拠はfail-closedにします。
crashで残ったcoordination fileはowner PIDが確実に停止している場合だけ回収し、live、
malformed、判定不能なownerは拒否します。v1の脅威境界は共通leaseに従うTAKT/devloopd
writerです。Node標準APIにはdirectory fd相対のrenameがないため、同じOS userの敵対的
processが直前witnessとrenameの間で親directoryを差し替える競合は対象外です。
Windowsはdirectory fsyncを提供しないため、file fsync後のdirectory durabilityだけを
best-effortとして扱います。NodeがWindowsで公開するchmod semanticsはPOSIXの一部だけ
なので、Windowsではcontentとbyte lengthをtransaction witnessとし、manifest modeは
advisoryとして扱います。POSIX platformでは引き続きmodeの完全一致を要求します。

entry種別ごとのceilingは独立し、callerは縮小だけできます。`pack.json`と
`manifest.json`は各4 MiB、`export-report.json`と各blobは各1 MiBで、entry count、
total payload、archive全体にも別上限があります。USTARのoctal、checksum、
uname/gname、device、prefix、reserved bytesはv1 canonical encodingとの完全一致が
必要です。

writerは`tar-stream` 3.1.7をdirect dependencyとして固定しています。readerは
security境界を明確にするため自前のbounded USTAR parserを使います。3.2.0で追加された
writerに不要な`bare-fs`依存を取り込まず、supply-chain surfaceとNode以外のruntime向け
optional経路を増やさないためのpinです。

## 互換性と v2 への移行

クライアントは未知の schema major を必ず拒否します。v1 は security に関係する
データを黙って捨てないため、未知 key も fail-closed で拒否します。
schema version の欠落・非 string・形式不正は document ごとの `INVALID_MANIFEST`
または `INVALID_LOCK`、未知 major は `UNSUPPORTED_SCHEMA_MAJOR`、`1.1` のような
major 1 の未対応 version は `UNSUPPORTED_SCHEMA_VERSION` になります。

将来 v2 を導入する場合は `schemaVersion: "2.0"` を使い、明示的な移行コマンド
または adapter を提供します。adapter はまず v1 を検証し、新しい v2 manifest と
lock を作成して、source の commit と各 entry の digest を保存します。その後に
生成した適用計画をユーザーが確認します。v1 をその場で書き換えたり、ファイル内容
から新しい capability を推測したりしてはいけません。

## 運用CLIとTaktDesk連携

portableな運用境界には `takt project-template` を使います。全コマンドで
`--cwd <path>` と `--json` を利用できます。変更可能なコマンドも既定は
`--dry-run` で、変更にはfresh previewが返した完全一致の
`--expected-plan-id <sha256>` と `--apply` の両方が必要です。

| コマンド | 引数 | 追加オプション | 変更 |
|---|---|---|---|
| `export` | 出力 `.taktpack` | `--pack-version`, `--min-takt-version`, `--source-commit` | dry-run/apply |
| `inspect` | local `.taktpack` | `--current-takt-version` | なし |
| `diff` | local packまたはcanonical GitHub source | `--current-takt-version` | なし |
| `apply` | local packまたはcanonical GitHub source | `--current-takt-version` | dry-run/apply |
| `update` | canonical GitHub source | `--current-takt-version` | dry-run/apply |
| `rollback` | backup ID | なし | dry-run/apply |
| `list` | なし | なし | なし |

`--force` は `--apply` と同時にだけ指定でき、previewがreviewableと明示した変更を
承認します。hard conflict、recovery state、active run、lease、integrity check、
target drift、plan driftは迂回しません。

`--current-takt-version` はTaktDesk互換のために残す任意のruntime一致確認であり、
simulationやoverrideではありません。指定時は実行中Takt binaryのversionと完全一致が
必要です。高い値、低い値、形式不正な値はいずれもdispatch前に`INVALID_ARGUMENT`となり、
完全一致planの`--apply --force`でも同じです。互換性判定は常に実runtime versionを使うため、
previewとapplyの間でこの値を変えてもhard conflictを迂回できません。

local移行例:

```sh
takt project-template export ./team.taktpack --cwd ./source --pack-version 1.0.0 --min-takt-version 0.48.0 --source-commit 0123456789abcdef0123456789abcdef01234567 --dry-run --json
takt project-template export ./team.taktpack --cwd ./source --pack-version 1.0.0 --min-takt-version 0.48.0 --source-commit 0123456789abcdef0123456789abcdef01234567 --apply --expected-plan-id <sha256> --json
takt project-template inspect ./team.taktpack --cwd ./destination --json
takt project-template apply ./team.taktpack --cwd ./destination --dry-run --json
takt project-template apply ./team.taktpack --cwd ./destination --apply --expected-plan-id <sha256> --force --json
```

canonical GitHub例（source引数へcredentialを含めてはいけません）:

```sh
takt project-template diff github:team/repository@v1.2.3 --cwd ./destination --json
takt project-template apply github:team/repository@v1.2.3 --cwd ./destination --dry-run --json
takt project-template update github:team/repository@v1.2.3 --cwd ./destination --dry-run --json
takt project-template update github:team/repository@v1.2.3 --cwd ./destination --apply --expected-plan-id <sha256> --force --json
```

preview authorityはprocess-localかつsingle-useです。TaktDeskが保存できるのは安全なJSONの
`planId`、件数、readiness、review code、backup ID、recovery stateだけです。内部plan
objectを保存したり、別process・別machineへauthorityを移動したりしてはいけません。
Apply時はTaktDeskが`--expected-plan-id`付きで新しいCLI processを起動します。そのprocessが
leaseを取得し、sourceと3-lock cohortをfresh readしてplanを再導出します。証拠が変わって
いれば、古いpreviewを適用せずdriftを返します。

backupの一覧とrollbackはboundedかつ明示的です:

```sh
takt project-template list --cwd ./destination --json
takt project-template rollback backup-20260801 --cwd ./destination --dry-run --json
takt project-template rollback backup-20260801 --cwd ./destination --apply --expected-plan-id <sha256> --json
```

templateがinstall済みの場合、`list`はboundedな`sourceProvenance`射影として
`kind`、immutableな`sourceId`、`revision`、`version`、`archiveId`、`manifestId`を
返します。local path、repository URL、credential、mutable refは意図的に含めません。
単一list操作中にprovenance射影が変化した場合は、状態を混在表示せずtarget driftとして扱います。

machine出力はclosed schema `1.0`の単一envelopeです。`status`、`command`、`mode`、
`warnings`と、`result`または安定した`error.code`を持ちます。exit codeは`0`成功、
`20`不正な呼び出し、`21`review/conflict、`22`drift、`23`coordination/security guard、
`24`source/backupの利用不可または不正、`25`rollback/recovery/結果不確定、`70`内部・
protocol failure、mutation admission前のinterruptは`130`です。admission後はcommit、
rollback、recoveryの終端までdrainします。UI taskのcancelだけから成否を推測してはいけません。

従来の `devloopd onboard-repo` はpersonal automation設定向けのadvisory compatibilityとして
残ります。portable packのexport/apply protocolではなく、TaktDesk移行authorityには使いません。

completionは`bin/completions/`にあります。bashは`takt.bash`をsourceし、zshは`_takt`を
含むdirectoryを`fpath`へ追加し、fishは`takt.fish`をcompletion directoryへ配置します。
