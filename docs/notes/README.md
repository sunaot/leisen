# docs/notes — 検討メモ

設計判断ではない分析メモ。決定事項は `docs/adr/` を正とする。HTML は単一ファイルで、図はインライン SVG。ブラウザで開いて読む(Web フォントの読み込みに失敗してもシステムフォントで読める)。

| 日付 | ファイル | 内容 | 関連 |
|---|---|---|---|
| 2026-10-14 | [2026-10-14-personal-auth-study.html](2026-10-14-personal-auth-study.html) | 個人の認可の実現方式。接続体験の選択肢と評価、Token Vault の要否と実装先、直接接続の扱い、推奨構成 | ADR-010 / ADR-022 |
| 2026-10-15 | [2026-10-15-credential-locality.html](2026-10-15-credential-locality.html) | 資格情報の置き場所。bearer token の根本的な困難、設計空間、標準・製品・事故の実例、ローカル寄せの案の評価 | ADR-022 |
| 2026-10-19 | [2026-10-19-auth-methods-comparison.html](2026-10-19-auth-methods-comparison.html) | 個人認可の方式比較。Token Vault / IdP トークン方式 / キーチェーンと MCP クライアント方式 / ESC 方式の実現方法、要件、評価、論点(2026-10-20 改訂) | ADR-022 |

2026-10-14 と 10-15 のメモで「封緘」「開封」と呼んでいるものは、10-19 のメモと ADR-022 で ESC(encrypted self-contained credential)と「復号」に呼び直した。
