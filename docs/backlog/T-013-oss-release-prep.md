# T-013: OSS公開準備

## 前提(人手)
2026-10-13 オーナー判断で、人手の前提は次の状態になった。

- ~~ライセンス最終決定(ADR-004)~~ → **確定**(Apache-2.0。LICENSE / NOTICE / package.json の `license` は配置済み)
- ~~プロジェクト名・商標・配布名~~ → **保留**(時期尚早。配布名は当面 `@kp` スコープ・`kp-ask`・`_meta` prefix `io.github.sunaot.leisen/` のまま公開する。確定時に移行期間を置く。issue #32 / #38、ADR-001 追補3 決定4)
- ~~脆弱性報告窓口の体制~~ → **保留**(時期尚早。SECURITY.md は体制を決めずに書ける範囲、例: GitHub の Private vulnerability reporting を窓口にする、で先行してよい)
- ~~公開時期の再判断~~ → **決定: すぐに公開する**(v3 §8 の Q2 / Q3 比較は行わない)
- **Slack導入形態の法務確認(ADR-014)** は未決のまま(T-006 の前提。公開自体は待たない)

公開を先に行うため、下記「内容」のうち人手の前提なしで進められる項目(公開チェックリスト、CI の audit / secret scan、SECURITY.md / CONTRIBUTING.md / CODE_OF_CONDUCT.md、README 導線)を優先する。

## 内容
- ~~LICENSE / NOTICE~~(配置済み) / SECURITY.md(非公開報告手順) / CONTRIBUTING.md(DCO。CLA は求めない、ADR-004) / CODE_OF_CONDUCT.md
- docs/install.md への同梱コンテナのライセンス注記(MongoDB は SSPL。ADR-004「決定」)。`NOTICE` の著作権者名は個人名で確定済み(2026-10-13 オーナー決定、ADR-004)
- contrib/ 階層の定義(コア外・ベストエフォート保守)とPRテンプレート(汎用性チェック=2社ルールの確認項目)
- 依存関係の脆弱性自動監査をCIに追加。vitest系dev依存の既知脆弱性はvitest 4系更新で解消済み(2026-07-05、npm audit 0件)。本タスクの残作業はCIへのaudit自動化
- **secret scan(gitleaks等)をCIとpre-commitに導入**する。.claude/guardは軽い安全網でありこれの代替ではない
- **ESLint導入時に `no-restricted-syntax` で `JSON.stringify(auth|authContext|credential)` 系を禁止**する(不変条件6を型では防げない分を静的解析で補う)
- **カナリア文書スイート**(T-000cの設計に基づく): 権限逸脱の常時検証をセキュリティテストスイートとして同梱し、導入プレイブックの標準工程に組み込む
- 公開リポジトリのREADME(導入ガイド/リファレンスアーキテクチャ/開発ガイドの3部導線)
- **MCP `_meta` 名前空間prefixの最終確定**(ADR-001追補3 決定4): 暫定値 `io.github.sunaot.leisen/` を配布名・配布サイトの確定と併せて見直す(2026-10-13: 配布名は保留のため、公開は暫定値のまま行う)。変更する場合はGateway(受け側)とOrchestrator(申告側)を同時に更新し、移行期間中は旧prefixも受ける。確定値をADR-001に追記する

## 受け入れ条件
- [ ] 公開チェックリスト(秘密情報スキャン、履歴確認、**`_meta` prefix最終確定**)の実施記録
- [ ] セキュリティテストスイート(カナリア文書+レッドチーム項目の自動化可能分)が同梱されている
- [ ] npm auditがhigh以上ゼロ
