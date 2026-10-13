# T-013: OSS公開準備

## 前提(人手)
2026-10-13 オーナー判断で、人手の前提は次の状態になった。

- ~~ライセンス最終決定(ADR-004)~~ → **確定**(Apache-2.0。LICENSE / NOTICE / package.json の `license` は配置済み)
- ~~プロジェクト名・配布名~~ → **確定**(2026-10-13、ADR-020: `leisen` に統一。`@leisen/*`、`leisen-gateway` / `leisen-ask` / `leisen-promotion-report`、`LEISEN_*`)。**商標** は保留(時期尚早)。`_meta` prefix は `io.github.sunaot.leisen/` のまま(最終確定は下記)
- ~~脆弱性報告窓口の体制~~ → **保留**(時期尚早。SECURITY.md は体制を決めずに書ける範囲、例: GitHub の Private vulnerability reporting を窓口にする、で先行してよい)
- ~~公開時期の再判断~~ → **決定: すぐに公開する**(v3 §8 の Q2 / Q3 比較は行わない)
- **Slack導入形態の法務確認(ADR-014)** は未決のまま(T-006 の前提。公開自体は待たない)

公開を先に行うため、下記「内容」のうち人手の前提なしで進められる項目(公開チェックリスト、CI の audit / secret scan、README 導線)を優先する。SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md は 2026-10-13 のオーナー判断で保留とし、公開を待たない。

## 内容
- ~~LICENSE / NOTICE~~(配置済み) / SECURITY.md(非公開報告手順) / CONTRIBUTING.md(DCO。CLA は求めない、ADR-004) / CODE_OF_CONDUCT.md — 3 文書は **保留**(2026-10-13 オーナー判断。窓口の体制と併せて後で決める)
- docs/install.md への同梱コンテナのライセンス注記(MongoDB は SSPL。ADR-004「決定」)。`NOTICE` の著作権者名は個人名で確定済み(2026-10-13 オーナー決定、ADR-004)
- contrib/ 階層の定義(コア外・ベストエフォート保守)とPRテンプレート(汎用性チェック=2社ルールの確認項目)
- ~~依存関係の脆弱性自動監査をCIに追加~~(2026-10-13、CI `audit` ジョブ。本番依存の high 以上で失敗する)。vitest系dev依存の既知脆弱性はvitest 4系更新で解消済み(2026-07-05)
- **secret scan(gitleaks等)をCIとpre-commitに導入**する。.claude/guardは軽い安全網でありこれの代替ではない(2026-10-13: CI の `secret-scan` ジョブは導入済み。許可は `.gitleaks.toml`。pre-commit は未導入)
- **ESLint導入時に `no-restricted-syntax` で `JSON.stringify(auth|authContext|credential)` 系を禁止**する(不変条件6を型では防げない分を静的解析で補う)
- **カナリア文書スイート**(T-000cの設計に基づく): 権限逸脱の常時検証をセキュリティテストスイートとして同梱し、導入プレイブックの標準工程に組み込む
- ~~公開リポジトリのREADME(導入ガイド/リファレンスアーキテクチャ/開発ガイドの3部導線)~~(2026-10-13、README「ドキュメント」節)
- ~~**ADR-020 の一括改名**(`kp` → `leisen`)を 1 本の PR で行う。~~(2026-10-13 実施)対象と確認方法は ADR-020 決定 8。npm の組織 `leisen` の確保はオーナーが公開前に行う
- **MCP `_meta` 名前空間prefixの最終確定**(ADR-001追補3 決定4): 暫定値 `io.github.sunaot.leisen/` を配布名・配布サイトの確定と併せて見直す(2026-10-13: 配布名は保留のため、公開は暫定値のまま行う)。変更する場合はGateway(受け側)とOrchestrator(申告側)を同時に更新し、移行期間中は旧prefixも受ける。確定値をADR-001に追記する

## 受け入れ条件
- [ ] 公開チェックリスト(秘密情報スキャン、履歴確認、**`_meta` prefix最終確定**)の実施記録 — 秘密情報スキャンと履歴確認は実施済み(`docs/release/2026-10-13-public-checklist.md`)。`_meta` prefix の最終確定はオーナー判断で保留(暫定値のまま公開)のため未完了
- [ ] セキュリティテストスイート(カナリア文書+レッドチーム項目の自動化可能分)が同梱されている
- [x] npm auditがhigh以上ゼロ — 本番依存で 0 件(2026-10-13)。CI の `audit` ジョブで継続確認
