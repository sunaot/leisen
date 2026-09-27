# knowledge-platform leisen ~ 霊泉

社内ナレッジをLLMが権限透過で検索できるようにする基盤。設計の全体像は `docs/product-design.md`(v1)+ `docs/product-design-v2.md`(OSS化差分)+ `docs/product-design-v3.md`(実装前レビュー反映差分)、開発ルールは `CLAUDE.md`、タスクは `docs/backlog/` を参照。

**実装前ゲート(T-000a/b/c)は完了し、Gateway土台(T-001/T-002/T-010/T-003)と昇格判定レポート(T-014)がmainにある。** 次はコネクタ(T-005/T-019)・Orchestrator(T-007)・リファレンスデプロイ(T-012)。現在のフェーズと制約は `CLAUDE.md` の「現在のフェーズ」を正とする。

## セットアップ

```bash
npm install
npm run build
npm test
```

## 構成

- `packages/connector-sdk` — コネクタ共通IF
- `packages/gateway` — MCP Gateway(認証・IdP Adapter・監査・ルーティング・MCPサーバー面)。HTTPトランスポートは未配線(T-003 残作業。ADR-001追補3 承認済みで着手可能)
- `packages/promotion-report` — 昇格判定レポートCLI(T-014、ADR-006)
- `examples/deployment.yaml` — Deployment Profileのサンプル(T-010)。導入1件=このファイル1枚(ADR-005)。スキーマの正は `packages/gateway/src/config/`
- `docs/adr` — 設計判断の記録
- `docs/backlog` — Phase 1タスク(受け入れ条件付き)

## 進め方

Claude Code でタスクIDを指定して着手する。例: 「docs/backlog/T-001-audit-log.md を読み、受け入れ条件を満たすまで実装して」
