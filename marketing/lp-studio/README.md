# Evidence-led LP Studio MVP v0.3

競合・隣接製品・広告の公開情報を調査し、その場で得た証拠に重要判断を拘束しながら、LPのポジショニング、メッセージ設計、情報設計、HTMLプロトタイプまでを進めるためのMVPパッケージです。

## MVPのゴール

1. Briefを固定する
2. 公開Webを調査し、Observation / Interpretation / Performance Evidenceを分離して保存する
3. カテゴリの共通構造と差別化余地を分析する
4. ポジショニングを最低3案つくる
5. 選択案に対してメッセージ・情報設計を最低3案つくる
6. 選択案に対して、異なるビジュアルコミュニケーションのHTMLを最低3案つくる
7. Evidence / Conversion / Visual / Technical QAを行う
8. 前工程に戻った場合、後工程を stale にする

## 重要原則

- 事前学習知識は探索・分類・実装補助には使ってよいが、案件固有の重要判断の根拠にはしない。
- 競合が採用している表現は「成果が出る証拠」ではない。
- Observation（観察）と Interpretation（解釈）と Hypothesis（仮説）を混同しない。
- 3案は色違いではなく、異なる説得仮説にする。
- Claim Ledgerにない定量成果や顧客実績を創作しない。
- 広告とLPは一つの説得経路として扱う。

## 使い方

### 1. 新規案件を作成

```bash
python3 scripts/init_project.py projects/acme
```

### 2. `projects/acme/00-brief/brief.yaml` と `claim-ledger.yaml` を記入

### 3. エージェント/LLMに `skills/lp-studio/SKILL.md` を読み込ませ、案件ディレクトリを指定

### 4. ステージ完了ごとに状態更新

```bash
python3 scripts/set_stage.py projects/acme research approved
python3 scripts/set_stage.py projects/acme positioning approved --selected positioning-b
```

### 5. 前工程に戻る場合

```bash
python3 scripts/revisit_stage.py projects/acme analysis "ターゲット企業規模のサンプルが偏っていた"
```

### 6. 構造検証

```bash
python3 scripts/validate_project.py projects/acme
```

## 推奨ランタイム

このMVPは特定ベンダーに依存しません。Claude Code / Codex / その他のエージェント環境で利用できます。

- `skills/lp-studio/SKILL.md`: オーケストレーション
- `agents/*.md`: 分業用ロール
- `schemas/*.json`: 成果物の最低構造
- `scripts/*.py`: 状態管理・検証
- `templates/project/`: 新規案件テンプレート

PlaywrightやLighthouseは次版で自動化してもよいですが、MVPではHTML生成とブラウザ確認を人・エージェントの双方で回せる構成にしています。


## v0.2 — Blind Pain Research
A new pre-competitor stage hides the proposed solution from the pain researcher, gathers external evidence of jobs/breakdowns/workarounds, clusters pains first, and only then scores product fit. This prevents Product → Problem confirmation bias.


## v0.3 — Copy Development

v0.3 separates two layers that were previously conflated:

1. **Message Strategy diversification** — choose where persuasion begins (Pain, Job, Outcome, Mechanism, Category-reframe, Alternative).
2. **Copy Development** — preserve meaning while compressing it into a Hero Message Unit.

Copy Development now requires:
- Product Truth → Customer Value → Plain Message → Persuasive Copy → optional Brand Copy
- Reader Prior Knowledge / Unknown Product Test
- Hero Message Unit design
- blind 5-second comprehension audit
- explicit information requirements and compression-loss tracking

The package no longer treats maximum brevity or slogan-like copy as the default goal.
