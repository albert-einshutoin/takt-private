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
異なる path と NFC/NFD で同一になる path の衝突も拒否し、macOS と Windows で
検証結果が変わらないようにします。

`source` は kind ごとの discriminated union です。`github` は `.git` なしの
`https://github.com/owner/repository`、`git` は credential を含まない HTTPS URL、
`local` は相対 POSIX path と固定 ref `workspace` を使用します。query、fragment、
control 文字、local workstation の絶対 path は保存できません。すべての source は
小文字 hexadecimal 40 または 64 文字の commit に固定します。

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

入力上限は entry 4,096 件、path/source URI 512 code point、ref 256 code point、
capability 3 件です。parser は own property だけの plain JSON object と密な array
のみ受け入れ、継承値、accessor、class instance、sparse/拡張 array は entry 処理前に
拒否します。

## 互換性と v2 への移行

クライアントは未知の schema major を必ず拒否します。v1 は security に関係する
データを黙って捨てないため、未知 key も fail-closed で拒否します。

将来 v2 を導入する場合は `schemaVersion: "2.0"` を使い、明示的な移行コマンド
または adapter を提供します。adapter はまず v1 を検証し、新しい v2 manifest と
lock を作成して、source の commit と各 entry の digest を保存します。その後に
生成した適用計画をユーザーが確認します。v1 をその場で書き換えたり、ファイル内容
から新しい capability を推測したりしてはいけません。
