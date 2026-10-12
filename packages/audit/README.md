# @kp/audit — 監査ログの共通モジュール

監査 2 層モデル(ADR-011)のレコード定義・docId の不可逆化・生クエリ表・保持期間・永続 sink・JSONL ストアを、
Gateway から切り出したパッケージ(ADR-019 決定10、T-023 段階 1)。

- 依存は `zod` と Node の標準ライブラリだけ。`@kp/connector-sdk`・`@modelcontextprotocol/sdk`・Gateway の
  `proxy/`・`idp/`・`config/` を import しない(`npm run lint:imports` で検査する)
- Gateway(書き手)・Orchestrator(申告者)・昇格判定レポート(読み手)は、監査の型と読み書きの実装を
  `@kp/gateway` ではなくここから読む
- 集計サンプルクエリは `docs/audit-queries.md`、各モジュールの役割は `src/index.ts` の冒頭コメントを参照
