# プロジェクトテンプレートパック契約（v1）

プロジェクトテンプレートパックは、`.takt/` の設定をリポジトリ間、そして
TAKT や TaktDesk などのクライアント間で安全に移行するための形式です。v1 は
データ契約のみを定義します。ファイル適用やコマンド実行をせずに、解析・確認・
lock 化できます。

## manifest

manifest には `schemaVersion: "1.0"`、SemVer の `packVersion`、対応する
`takt.minVersion`（任意で `maxVersion`）、`kind`・`uri`・`ref`・不変の `commit`
を含む `source`、そして `entries` を指定します。各 entry は相対 POSIX パス、
`managed` / `merge` / `scaffold` / `excluded` の policy、4 桁 POSIX mode、
小文字の SHA-256 を必ず持ちます。

- `managed`: 管理対象ファイルを置き換える
- `merge`: 後続の三者マージ対象として扱う
- `scaffold`: 存在しないファイルだけを作成する
- `excluded`: 意図的に適用しない entry を記録する

`excluded` を含め、すべての entry に digest を持たせます。これによりプレビューと
lock の内容が再現可能になります。

`path` は常に相対 POSIX パスです。絶対パス、`..`、空セグメント、Windows の
区切り文字は拒否されます。これにより macOS での検証結果が Windows で別の意味に
ならないようにします。

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
`projectTemplateManifestV1JsonSchema` を提供します。検証エラーは安定した `code`
を持つ `ProjectTemplateValidationError` なので、呼び出し側は文言ではなく code を
判定に使用してください。

lock は manifest と同じ `schemaVersion`、`packVersion`、`source` と、
path/mode/digest の entry 一覧を記録します。確認済みのパックを後から適用する際も、
選択した commit を固定できます。

## 互換性と v2 への移行

クライアントは未知の schema major を必ず拒否します。v1 は security に関係する
データを黙って捨てないため、未知 key も fail-closed で拒否します。

将来 v2 を導入する場合は `schemaVersion: "2.0"` を使い、明示的な移行コマンド
または adapter を提供します。adapter はまず v1 を検証し、新しい v2 manifest と
lock を作成して、source の commit と各 entry の digest を保存します。その後に
生成した適用計画をユーザーが確認します。v1 をその場で書き換えたり、ファイル内容
から新しい capability を推測したりしてはいけません。
