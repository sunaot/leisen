# issue #18 の補足図

issue #18(監査 2 層モデルが出荷構成で完結しない)の検討「構造的にはなぜこうなっていて、壁・制約・コンフリクトはどこにあり、本来どうなっていると良いか」に添える図。決定事項ではなく検討材料で、ADR-019 のドラフトを書く場合はそちらに取り込む。

| ファイル | 内容 |
|---|---|
| `fig1-current-structure.svg` | 現状(A)の構造と、壁 C1〜C5 の位置 |
| `fig2-trust-boundary.svg` | TB2 の再定義(いま / あるべき)と、Orchestrator の置き場所 α・β |
| `fig3-run-api-sequence.svg` | run API のシーケンスと監査ストアのイベント列 |
| `fig4-migration-path.svg` | 現状 A → 段階 1 → 段階 2 で解ける問題と進め方 |
