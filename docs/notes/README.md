# docs/notes — 検討メモ

設計判断ではない分析メモ。決定事項は `docs/adr/` を正とする。HTML は単一ファイルで、図はインライン SVG。ブラウザで開いて読む(Web フォントの読み込みに失敗してもシステムフォントで読める)。

| 日付 | ファイル | 内容 | 関連 |
|---|---|---|---|
| 2026-10-14 | [2026-10-14-personal-auth-study.html](2026-10-14-personal-auth-study.html) | 個人の認可の実現方式。接続体験の選択肢と評価、Token Vault の要否と実装先、直接接続の扱い、推奨構成 | ADR-010 / ADR-022 |
| 2026-10-15 | [2026-10-15-credential-locality.html](2026-10-15-credential-locality.html) | 資格情報の置き場所。bearer token の根本的な困難、設計空間、標準・製品・事故の実例、ローカル寄せの案の評価 | ADR-022 |
| 2026-10-19 | [2026-10-19-auth-methods-comparison.html](2026-10-19-auth-methods-comparison.html) | 個人認可の方式比較。Token Vault / IdP トークン方式 / キーチェーンと MCP クライアント方式 / ESC 方式の実現方法、要件、評価、論点(2026-10-20 改訂) | ADR-022 |
| 2026-11-14 | [2026-11-14-token-store-boundary.html](2026-11-14-token-store-boundary.html) | Token Store の境界。ADR-022 確認事項 3 の文脈、論点、選択肢の空間(A / A' / B / B'' ほか)、A と B の位置付け、B へ移る判断基準 | ADR-022 / ADR-005 |
| 2026-11-15 | [2026-11-15-quality-observability-plan.html](2026-11-15-quality-observability-plan.html) | 品質の観測計画。計測基盤の設計要件と用語定義、コンポーネント構成、現状の評価、品質カテゴリと指標、評価方法、観測手段(監査ログ / 構造化運用ログ / 分離テレメトリ)、時間に関する指標(タイムアウト、ターンアラウンドタイム)、計装の実現方式、可視化手段(ロール別の関心事項とレポート構成)、ベースライン計測、実施計画 | ADR-011 / ADR-012 / T-008 |
| 2026-11-15 | [2026-11-15-observability-positioning.html](2026-11-15-observability-positioning.html) | オブザーバビリティの位置付け。品質の観測との違い、製品固有の制約、責任分界、監査ログと運用データの分離、3 層の構成(組み込み / ブリッジ / 開発・評価専用)、シグナルごとの扱い、APM 接続時の指針、組み込みで提供する運用機能、アラートの方針、論点。「品質の観測計画」と対になる | ADR-011 / ADR-013 / docs/install.md |

2026-10-14 と 10-15 のメモで「封緘」「開封」と呼んでいるものは、10-19 のメモと ADR-022 で ESC(encrypted self-contained credential)と「復号」に呼び直した。
