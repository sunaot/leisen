# knowledge-platform leisen ~ 霊泉

社内ナレッジをLLMが権限透過で検索できるようにする基盤。設計の全体像は `docs/product-design.md`(v1)+ `docs/product-design-v2.md`(OSS化差分)+ `docs/product-design-v3.md`(実装前レビュー反映差分)、開発ルールは `CLAUDE.md`、タスクは `docs/backlog/` を参照。

**現在は実装前ゲート(T-000a/b/c)のフェーズ。** ゲート完了までコード実装タスク(T-003以降)に着手しないこと。

## セットアップ

```bash
npm install
npm run build
npm test
```

## 構成

- `packages/connector-sdk` — コネクタ共通IF
- `packages/gateway` — MCP Gateway(認証・監査・ルーティング)
- `docs/adr` — 設計判断の記録
- `docs/backlog` — Phase 1タスク(受け入れ条件付き)

## 進め方

Claude Code でタスクIDを指定して着手する。例: 「docs/backlog/T-001-audit-log.md を読み、受け入れ条件を満たすまで実装して」
