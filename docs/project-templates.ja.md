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
log、cache、sensitive filename は candidate content として読みません。secret、
workstation の絶対 path、binary、symlink、hard link、special file、realpath escape、
portable-name collision、独立した各 resource 上限超過は blocked です。

`scanStatus` は `complete` / `incomplete` / `blocked` を区別します。`canExport` が true
になるのは scan が complete で blocked と project-owned entry がない場合だけで、
project-owned がある場合は `reviewRequired` が true になります。各 file preview は
bytes、mode、SHA-256、安定した reason code、redacted summary、suggested policy、
warning、`validateDetectedTemplateCapabilities` に渡せる capability evidenceを返します。

scanner は open 済み file の stat snapshot を比較して走査中の変更を検出しますが、
成功した snapshot は恒久的な安全証明ではありません。archive 作成時と apply 時には
type、containment、link count、size、mode、digest、capability evidence を reopen して
再検証してください。

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
