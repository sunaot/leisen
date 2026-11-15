# leisen リポジトリ: エージェント開発・プロセス資料の棚卸し(2026-11-15 時点、ブランチ claude/loving-allen-3kfr0r = main 相当)

出典はすべてリポジトリ内のファイルと読み取り専用の git コマンド。リンクはリポジトリ相対パス。行数は `wc -l`、文字数は `wc -m`。日本語文書は 1 行が長い(ADR は平均 約 183 文字/行)ので、行数は分量を過小に見せる。追跡ファイルは 374(research_notes/ と reports/ は対象外)。

## 1. CLAUDE.md の中身(恒久ルール / 状況ログ / 未決事項の比率、ネストした CLAUDE.md / AGENTS.md)

### Takeaway
CLAUDE.md は 58 行・15,592 文字で、本文の約 69%(10,223 文字)が「現在のフェーズ」という日付付きの状況ログと未決事項。恒久ルール(不変条件・構成・開発ルール・進め方)は約 4,600 文字にとどまる。ネストした CLAUDE.md と AGENTS.md は存在しない。

### Cited Findings
- 全体: 58 行、15,592 文字。見出しは 5 つ(不変条件 / リポジトリ構成 / 開発ルール / タスクの進め方 / 現在のフェーズ) — [CLAUDE.md](CLAUDE.md)
- セクション別の本文量: 不変条件 11 行 2,523 文字、リポジトリ構成 10 行 1,061 文字、開発ルール 8 行 703 文字、タスクの進め方 5 行 292 文字、現在のフェーズ 15 行 10,223 文字 — [CLAUDE.md](CLAUDE.md)
- 「現在のフェーズ」の内訳: 冒頭 1 段落、`main の状態(2026-10-12 更新)` の 1 段落(1 行で数千文字。PR #14 / #43 / #44 / #52、issue #16 / #17 の決定を日付順に連結)、箇条書き 10 項目。最後の箇条「人間の未決事項」は 1 行に約 10 件の未決事項を列挙 — [CLAUDE.md](CLAUDE.md) 43〜58 行
- 日付の出現は 21 回(異なる日付は 10)。PR / issue 参照は PR #14、#43、#52、issue #16、#17、#59 — [CLAUDE.md](CLAUDE.md)
- 恒久ルールの側にも状況が混じる: 「リポジトリ構成」に connector-sdk の版(v0.4、ADR-016 追補2)と ADR-019 決定10 の経緯 — [CLAUDE.md](CLAUDE.md) 19〜20 行
- 冒頭で 3 つの設計書(product-design.md の 2 章、v2、v3)を作業前に必ず読むよう指示 — [CLAUDE.md](CLAUDE.md) 3 行
- CLAUDE.md / AGENTS.md に該当する追跡ファイルはルートの CLAUDE.md のみ(`git ls-files` の照合)。パッケージ別は README のみ(audit / connector-esa / connector-github / orchestrator)
- README は CLAUDE.md を「開発ガイド」の入口として人間にも案内している(「人が書く場合も同じ規則に従う」) — [README.md](README.md) 36 行

### Inferences
- 恒久ルール 約 31% / 状況・未決 約 69%(文字数ベース)。エージェントは毎セッション、状況ログ 1 万文字を読み込む構造になっている。
- 状況ログは追記型で古い記述が残る(下の「重複・陳腐化」参照)。

### Gaps
- CLAUDE.md の過去の版ごとの増え方(行数の推移)は調べていない。

## 2. .claude/ と scripts/guard/(エージェント・フック・設定)

### Takeaway
.claude/ はサブエージェント定義 3 つと settings.json(フック 2 つ)だけで、commands・skills・追加の権限設定はない。フックは危険コマンドと秘密情報らしき文字列の遮断(Bash 前)と、不変条件 3・6 の粗い grep 検査(編集後)。

### Cited Findings
- 追跡ファイル: `.claude/agents/adr-keeper.md`(12 行)、`connector-implementer.md`(16 行)、`security-reviewer.md`(17 行)、`.claude/settings.json`(26 行)。`.claude/commands`、`.claude/skills` はない。`.claude/worktrees/` は .gitignore で除外 — [.claude/](.claude/)、[.gitignore](.gitignore)
- settings.json は hooks のみ: PreToolUse(matcher `Bash`)→ `scripts/guard/pre-bash.sh`、PostToolUse(matcher `Write|Edit|MultiEdit`)→ `scripts/guard/post-edit.sh`。permissions・env の定義はない — [.claude/settings.json](.claude/settings.json)
- pre-bash.sh(19 行): `rm -rf /`、`git push --force`、`git push -f` を拒否。Slack / GitHub のトークン接頭辞、`AIza`、`-----BEGIN` を含むコマンドを拒否(exit 2) — [scripts/guard/pre-bash.sh](scripts/guard/pre-bash.sh)
- post-edit.sh(30 行): packages/ の .ts を grep し、(a) `JSON.stringify(auth|authContext|credential` の直接シリアライズ(不変条件6)、(b) トークン形式の文字列のハードコード(不変条件6)、(c) packages/audit/src と packages/gateway/src/run 内の pre-filter 件数らしきフィールド名(不変条件3 / ADR-011)を検出すると exit 2 — [scripts/guard/post-edit.sh](scripts/guard/post-edit.sh)
- adr-keeper: ツールは Read / Grep / Glob / Write。ADR ドラフト後は人間レビューで停止、Status を勝手に Accepted にしない — [.claude/agents/adr-keeper.md](.claude/agents/adr-keeper.md)
- connector-implementer: model sonnet。IF を変えない、本人資格情報のみ、認可分岐テストを先に書く、完了時に security-reviewer を依頼 — [.claude/agents/connector-implementer.md](.claude/agents/connector-implementer.md)
- security-reviewer: model opus、ツールは Read / Grep / Glob / Bash。不変条件 1〜9 を基準に 6 観点で PASS / FAIL を返す — [.claude/agents/security-reviewer.md](.claude/agents/security-reviewer.md)
- CI のコメントは guard を「軽い検査」と位置づけ、本番の網は gitleaks としている — [.github/workflows/ci.yml](.github/workflows/ci.yml)

### Inferences
- フックが機械的に守るのは不変条件 9 つのうち 3 と 6 の一部だけ。1・2・4・5・7・8・9 はサブエージェントのレビューと PR テンプレートのチェックボックス頼み。
- サブエージェント定義は更新が止まっている(版・番号の古い記述。「重複・陳腐化」参照)。

### Gaps
- サブエージェントが実際にどの頻度で使われたかは git からは分からない(コミット件名に「セキュリティレビューの推奨を反映」が複数あることは確認)。

## 3. docs/ の棚卸し(設計書、ADR、backlog、eval、spikes、記録、導入ガイド)

### Takeaway
Markdown は 85 ファイル 7,206 行、加えて検討メモ HTML 4 本 2,396 行。ADR は 22 本(Accepted 20、Superseded 1、Proposed 1)で 12 本に追補があり、backlog は 29 タスクがファイルのチェックボックスで状態を持つが、完了の記録方法が不統一。

### Cited Findings
- 設計書: product-design.md 292 行、v2 176 行、v3 70 行(計 538 行) — [docs/](docs/)
- ADR: 22 ファイル(001〜023、009 欠番)、計 1,275 行・233,787 文字。平均 58 行・約 10,600 文字。最長は ADR-016(194 行)、ADR-019(162 行)、ADR-022(115 行)、ADR-001(101 行)。図は ADR-019 の SVG 5 枚 — [docs/adr/](docs/adr/)
- ADR の Status: Accepted 20、Superseded 1(ADR-002 → ADR-010)、Proposed 1(ADR-017「人間レビュー待ち」)。Status 行自体に日付・「オーナー決定」・issue 番号・URL を書き込んだものが多い(004、010、013、014、018、019、020、021、022、023) — 各 ADR の 3 行目付近
- 「追補」を含む ADR は 12 本(001、002、005、010、011、016、017、018、019、020、022、023)。ADR-001 は「追補」9 回・日付 15 種、ADR-016 は「追補」8 回。「実装の記録 / 検証結果」の節があるのは ADR-001、016、019 — [docs/adr/](docs/adr/)
- backlog: README(索引表)+ タスク 29 ファイル(T-000a/b/c、T-001〜T-026。T-011 は T-002 に統合済みで 3 行の残置)。計 940 行。形式は「前提(人手)/ 内容 / 受け入れ条件(チェックボックス)」 — [docs/backlog/](docs/backlog/)
- backlog の状態管理: 専用の status 欄はなく、チェックボックスと本文の日付付き追記で表す。チェック済みが多いのは T-003(29 / 33)、T-023(17 / 17)、T-026(10 / 11)、T-021(8 / 8)。README が「完了済み」とする T-001、T-002、T-010、T-014 はチェック 0(未チェック 5 / 5 / 4 / 3)のまま — [docs/backlog/README.md](docs/backlog/README.md) と各タスク
- backlog README 冒頭に「2026-10-08 進捗」の段落があり、現在の着手順は CLAUDE.md を参照と書く — [docs/backlog/README.md](docs/backlog/README.md)
- 評価: 2 本 239 行(探索プロンプト v3、T-022 汎化計測) — [docs/eval/](docs/eval/)
- スパイク: docs/spikes 1 本 307 行、コードは `spikes/mcp-sdk-v2/`(.ts 1,027 行) — [docs/spikes/mcp-sdk-v2-migration-spike.md](docs/spikes/mcp-sdk-v2-migration-spike.md)
- 検討メモ: HTML 4 本(811 / 601 / 554 / 430 行)と README 12 行。「設計判断ではない分析メモ。決定は ADR を正とする」 — [docs/notes/README.md](docs/notes/README.md)
- 公開記録: 2026-10-13 公開チェックリスト 59 行 — [docs/release/2026-10-13-public-checklist.md](docs/release/2026-10-13-public-checklist.md)
- 調査・レビュー系: auth-matrix.md 259 行、threat-model.md 280 行(改訂履歴と「受容した残余リスク」の章あり)、mcp-spec-2026-07-28-review.md 101 行
- 導入・運用系: install.md 566 行、ui-librechat.md 419 行、personal-auth.md 195 行、audit-queries.md 219 行、idp-adapter-guide.md 141 行、direct-connection.md 166 行、playbook.md 93 行、usage-policy-template.md 101 行
- 分類別の行数(概算): 導入・運用ガイド 約 1,900 / ADR 1,275 / backlog 940 / 設計書 538 / 調査・脅威モデル 640 / eval + spike + release 605 / 検討メモ HTML 2,396 / README 類(ルート 230、パッケージ 793、deploy・e2e 83)

### Inferences
- ADR は「決定の記録」と「実装ログ・追補の時系列」を兼ねており、決定の現在形を知るには全文を読む必要がある。
- backlog はタスク定義・進捗・レビュー指摘の残件(T-003 に minor-N が 10 回)を 1 ファイルに持つ。GitHub Issues(#16、#17、#21、#32、#59)と二重の追跡になっている。

### Gaps
- GitHub 上の issue / PR の本文は読んでいない(ローカルのみの調査)。issue の総数と open / closed は不明。

## 4. 読者別の分類と、OSS の定番ファイルの有無

### Takeaway
README は読者を 3 つ(導入 / 設計理解 / 開発)に分けて案内しているが、ファイルの置き場は分かれておらず docs/ 直下に混在する。LICENSE・NOTICE・PR テンプレートはあり、CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / issue テンプレート / CODEOWNERS はない(保留と明記)。

### Cited Findings
- 利用者・運用者向け: README.md、docs/install.md、docs/ui-librechat.md、docs/personal-auth.md、docs/playbook.md、docs/audit-queries.md、docs/usage-policy-template.md、examples/deployment*.yaml(5 本)、deploy/compose/README.md — [README.md](README.md) 11〜17 行
- 設計理解・評価者向け: product-design*.md、direct-connection.md、ADR、threat-model.md、auth-matrix.md — [README.md](README.md) 19〜31 行
- コントリビューター向け: CLAUDE.md、docs/backlog/、PR テンプレート、パッケージ README、idp-adapter-guide.md、e2e/keycloak/README.md — [README.md](README.md) 33〜40 行
- 内部のプロセス・判断ログ: CLAUDE.md「現在のフェーズ」、backlog の進捗追記、ADR の追補・実装の記録、docs/eval、docs/notes、docs/release、docs/spikes、mcp-spec レビュー
- ある: LICENSE(Apache-2.0)、NOTICE(著作権者は個人名)、.github/PULL_REQUEST_TEMPLATE.md(21 行、不変条件のチェック 8 項目)、.github/dependabot.yml、.gitleaks.toml — ルートと [.github/](.github/)
- ない: CONTRIBUTING.md、SECURITY.md、CODE_OF_CONDUCT.md、.github/ISSUE_TEMPLATE、CODEOWNERS(`git ls-files` の照合)。backlog README は SECURITY / CONTRIBUTING / CODE_OF_CONDUCT を「保留」と明記、公開チェックリストは CODEOWNERS 等の保護を「範囲外」に挙げる — [docs/backlog/README.md](docs/backlog/README.md)、[docs/release/2026-10-13-public-checklist.md](docs/release/2026-10-13-public-checklist.md)
- README の「進め方」は「Claude Code でタスク ID を指定して着手する」の 1 文 — [README.md](README.md) 224〜226 行
- README 冒頭の第 2 段落は CLAUDE.md と同じ進捗の要約(T 番号の列挙) — [README.md](README.md) 5 行

### Inferences
- 外部の人が貢献する手順(issue の立て方、ADR の起案権限、レビューの流れ、脆弱性の報告先)はどこにも書かれていない。現状は「オーナー + エージェント」前提の文書体系。
- README は入口の整理が済んでいるので、置き場の再編は README の 3 分類に沿わせやすい。

### Gaps
- GitHub のリポジトリ設定(Private vulnerability reporting、ブランチ保護)の状態はローカルからは確認できない。

## 5. 機微な内容のスキャン(分類とパスのみ。値は転記しない)

### Takeaway
本物の秘密・顧客名・社内ホスト名は見つからなかった。気になるのは、未解決のセキュリティ指摘の符号、承認待ち・未決事項の率直な記述、商用配布の論点、オーナー個人に結びつく記述が、エージェント向け文書と利用者向け文書の両方に散っている点。

### Cited Findings
- 秘密情報: 公開チェックリストは履歴全体の gitleaks で 6 件検出・すべて開発用ダミーと判定、許可は .gitleaks.toml に完全一致で記載 — [docs/release/2026-10-13-public-checklist.md](docs/release/2026-10-13-public-checklist.md)、[.gitleaks.toml](.gitleaks.toml)
- 社名・顧客名: 「株式会社」「Inc.」の一致は 0 件。「顧客 / 導入先」は一般語として 39 ファイルに出る(threat-model、docs/notes、ADR-017、direct-connection、auth-matrix)。公開チェックリストも「社名・社内ホスト名はなし」と記録
- メールアドレス: 追跡ファイル内の一致はほぼ例示ドメイン(example.com、*.example、example.test、acme.local など)でテストコード中心。実在ドメインに見える一致は公開チェックリスト(noreply 系 2 種の記述)とテスト 1 本 — [docs/release/2026-10-13-public-checklist.md](docs/release/2026-10-13-public-checklist.md)、packages/gateway/test/auth-server-hardening.test.ts
- 個人名: NOTICE の著作権者(個人名)、GitHub のユーザー名を含む `_meta` prefix(`io.github.<user>.leisen/`)が 18 ファイル 45 か所(gateway の src / test、backlog、spike 文書)。git の作者アドレスにオーナーの個人アドレスが含まれ、公開で見える点はチェックリストが明記 — [NOTICE](NOTICE)、packages/gateway/src/proxy/meta.ts、[docs/release/2026-10-13-public-checklist.md](docs/release/2026-10-13-public-checklist.md)
- 内部ホスト名: `.internal` / `.corp` / `.local` の一致は 23 ファイルで、テストの入力値と compose の `host.docker.internal` 系。実在の社内ホスト名は確認できず
- 未解決のセキュリティ指摘の符号: `minor-N` が 17 ファイル 59 か所(T-003 backlog 10、install.md 9、proxy-tools.test.ts 9、http.ts 2、CLAUDE.md)。`H1` が 27 ファイル 63 か所(threat-model、orchestrator の src / test / README、CLAUDE.md)。CLAUDE.md は minor-6(リクエスト期限なし)・minor-7 が未修正で「公開前はリバースプロキシで緩和」と書く — [CLAUDE.md](CLAUDE.md) 47 行、[docs/install.md](docs/install.md)、[docs/backlog/T-003-gateway-proxy.md](docs/backlog/T-003-gateway-proxy.md)
- 承認待ち・人手の前提: 12 ファイル 20 か所(CLAUDE.md 5、T-013、README 2、connector-github / connector-esa の README)。GitHub App 承認待ち、GCP OAuth 承認、API キー待ちなど
- 「オーナー決定 / オーナー判断」: 14 ファイル 32 か所(T-013、ADR-004、ADR-018、ADR-020、ADR-022、CLAUDE.md)
- 商用・価格: 「有償導入支援」「有償サポート契約の定型化」と Slack の Commercial Distribution の論点が CLAUDE.md、ADR-014 追記、T-006、T-013、install.md、ui-librechat.md、orchestrator README、product-design-v2.md(ロードマップ表)に出る(issue #59 参照は 7 ファイル)。「価格 / 料金」の一致の大半は LLM のトークン単価の設定コード(orchestrator の cost.ts / config.ts)で性質が別 — [docs/adr/ADR-014-slack-rts.md](docs/adr/ADR-014-slack-rts.md) 23〜26 行、[docs/product-design-v2.md](docs/product-design-v2.md) 136 行
- 商標・脆弱性報告窓口の保留: 7 ファイル(product-design-v2、T-013、公開チェックリスト、backlog README、ADR-020、ADR-004、CLAUDE.md)
- 実チームでの疎通記録: 「実チーム」が 7 ファイル(ADR-023、T-026、README、connector-esa README、gateway の src / test)。チーム名の記載は確認していない範囲では見当たらない
- 手元の環境の記述: オーナーの手元の LM Studio と具体的なモデル名、「手元の一時的な構成」 — [CLAUDE.md](CLAUDE.md)、[docs/backlog/README.md](docs/backlog/README.md)、[docs/eval/](docs/eval/)
- ソースコード内のプロセス参照: packages の .ts に T 番号 216 か所、ADR 番号 677 か所、issue / PR 番号 72 か所

### Inferences
- 広く宣伝する公開リポジトリで扱いに注意が要るもの(リスク順の私見): (1) 未修正の指摘を符号付きで並べた CLAUDE.md・T-003・install.md(攻撃者への案内になりうる。ただし install.md の緩和手順は利用者に必要)、(2) 商用配布・有償支援の論点(ADR-014 追記、issue #59 参照)、(3) CLAUDE.md の「人間の未決事項」と承認待ちの列挙、(4) 公開チェックリストの作者アドレスに関する記述、(5) docs/notes の検討メモ(決定ではない分析)。
- いずれも秘密ではなく「率直な内部メモが公開面に出ている」種類の問題。削除より、置き場と書き方の分離で対処できる性質。

### Gaps
- docs/notes の HTML 4 本と product-design 3 本は全文を精読していない(パターン検索のみ)。固有名が文脈で特定できる記述が残る可能性は否定できない。
- git 履歴上の過去の版の内容は自分では走査していない(チェックリストの記録に依拠)。

## 6. Git の事実

### Takeaway
137 コミット(2026-07-08〜2026-11-16)のうち 64% がエージェント名義の作者、71% に Co-Authored-By がある。PR 番号は #84 まで進み、README は日本語のみでバッジなし。

### Cited Findings
- コミット数 137。日付範囲 2026-07-08 〜 2026-11-16(コミット日付。調査日は 2026-11-15 でタイムゾーン差とみられる)。月別: 7 月 23、8 月 2、9 月 25、10 月 75、11 月 12 — `git log`
- 作者名: Claude 88(64%)、オーナー(2 つの表記)45(33%)、dependabot 4 — `git log --format=%an`
- Co-Authored-By を含むコミット 97(71%)。トレーラー行の内訳: Claude の各モデル名義 119 行(4 種のモデル表記 + 表記なし 8)、dependabot 4 行。Claude-Session トレーラーは 93 コミット(68%) — `git log --grep`
- マージコミット 40、「Merge pull request」件名 33。件名の `#N` 参照は 56 種で最大 #84(issue #16、#17、#21、#32、#59 を含む)。マージ件名のうち `claude/` ブランチは 37 — `git log --merges`
- タグなし。リモートは GitHub の 1 つ。ブランチは main と作業ブランチ 1 本 — `git tag`、`git remote -v`
- 公開チェックリストは 2026-10-13 時点で「リポジトリは private」と記録。CLAUDE.md は「公開はすぐに行う」(同日のオーナー判断) — [docs/release/2026-10-13-public-checklist.md](docs/release/2026-10-13-public-checklist.md)、[CLAUDE.md](CLAUDE.md) 56 行
- README: 日本語のみ、バッジ 0、230 行。英語版の文書(README.en など)はない。全 package.json は private(コミット件名「全パッケージを private にし…」) — [README.md](README.md)
- 言語: 文書・コードコメント・コミット件名・CI コメントは日本語。CI のステップ名と識別子は英語 — [.github/workflows/ci.yml](.github/workflows/ci.yml)

### Inferences
- 実装の大半はエージェントが書き、オーナーが決定とマージを担う体制。コミット本文は計 1,575 行あり、判断の経緯の一部はコミットメッセージにもある。
- 日本語のみ・バッジなし・タグなしで、対外的な体裁はまだ整えていない段階。

### Gaps
- 現在の GitHub 上の可視性(public / private)は未確認。
- マージ済み PR の正確な数は GitHub を見ないと確定しない(squash とマージコミットが混在)。

## 7. CI と自動化

### Takeaway
ワークフローは ci.yml の 1 本(5 ジョブ)で、エージェントを CI から起動する自動化はない。import 境界(lint:imports)と gitleaks は CI にあり、guard フックは CI では走らない。

### Cited Findings
- ci.yml(139 行)、トリガーは pull_request と main への push、権限は `contents: read`、Action は SHA 固定 — [.github/workflows/ci.yml](.github/workflows/ci.yml)
- ジョブ: `audit`(npm audit、本番依存の high 以上)、`secret-scan`(履歴全体の gitleaks)、`build-test`(build → lint:imports → test)、`keycloak-e2e`、`reference-deploy`(compose 起動とスモーク 3 種、30 分上限) — 同上
- `lint:imports` は scripts/lint-imports.mjs(147 行)。@leisen/audit と Gateway の run モジュールの import 境界を検査(ADR-019 決定10) — [package.json](package.json)、[scripts/lint-imports.mjs](scripts/lint-imports.mjs)
- scripts/ci/gitleaks.sh(47 行)は版とチェックサムを固定し、行内の許可コメントと .gitleaksignore を受け付けない — [scripts/ci/gitleaks.sh](scripts/ci/gitleaks.sh)、公開チェックリスト
- Dependabot: github-actions と npm を週次、npm の minor / patch は 1 本にまとめる — [.github/dependabot.yml](.github/dependabot.yml)
- スモーク: scripts/smoke 4 本(515 行) — [scripts/smoke/](scripts/smoke/)
- Claude の GitHub Action やレビュー自動化のワークフローはない(`.github/workflows` は ci.yml のみ)
- pre-commit での secret scan は未導入(チェックリストの範囲外項目) — [docs/release/2026-10-13-public-checklist.md](docs/release/2026-10-13-public-checklist.md)

### Inferences
- 不変条件の検査は「フック(ローカルのエージェントのみ)」「CI(import 境界と秘密情報)」「サブエージェントと人のレビュー」に分かれ、フックの検査は Claude Code を使わない貢献者には効かない。

### Gaps
- CI の実行結果(緑か赤か)はローカルからは確認していない。

## 8. プロセス・文書とコードの分量比

### Takeaway
ソース 約 31,400 行、テスト 約 31,500 行に対し、Markdown 7,206 行 + HTML 2,396 行。行数比では文書はコードの約 15% だが、日本語の長い行のため実際の読む量はそれより大きい。

### Cited Findings
- パッケージ別(.ts など、src / test の行数): audit 1,091 / 1,173、connector-esa 962 / 526、connector-github 2,621 / 2,431、connector-sdk 316 / 249、gateway 13,688 / 13,262、orchestrator 11,132 / 12,101、promotion-report 1,570 / 1,768。合計 src 31,380 / test 31,510 — `git ls-files` + `wc -l`
- その他のコード: spikes 1,027 行、scripts 758 行、deploy + e2e + examples 21 ファイル 1,761 行
- 文書: Markdown 85 ファイル 7,206 行(うち docs/ 5,910 行)、docs/notes の HTML 2,396 行。ADR だけで 233,787 文字
- エージェント設定そのもの(CLAUDE.md 58 行 + .claude 71 行 + guard 49 行)は計 178 行
- ソース内のコメントにプロセス参照が多い(ADR 番号 677、T 番号 216、issue / PR 番号 72)。TODO / FIXME は 2

### Inferences
- 文書(Markdown + HTML)9,602 行は src + test 62,890 行の約 15%。プロセス・判断ログ系(ADR、backlog、eval、notes、release、spike、CLAUDE.md)は文書全体の約 6 割を占める(約 5,800 行)。
- テストとソースがほぼ 1:1 で、品質の担保はテスト側に寄っている。

### Gaps
- 文字数ベースの全体比較は ADR 以外では取っていない。

## 9. 重複と陳腐化の兆候

### Takeaway
同じ進捗が CLAUDE.md・README・backlog README・各タスク・パッケージ README・ADR に重ねて書かれ、すでに食い違いが出ている。サブエージェント定義と PR テンプレートは不変条件や版の更新に追随していない。

### Cited Findings
- 「PR #14」のマージ記述が 8 ファイルに重複(CLAUDE.md、README.md、deploy/compose/README.md、ADR-018、backlog README、T-012、T-021、install.md)
- 「Claude API での実走は未確認」が 4 ファイル(CLAUDE.md、backlog README、T-007、orchestrator README)
- ADR-018 の食い違い: CLAUDE.md は「ADR-017・ADR-018 は Proposed で人間レビュー待ち」、ADR-018 の Status は Accepted(オーナー決定 2026-10-08) — [CLAUDE.md](CLAUDE.md) 47 行、[docs/adr/ADR-018-orchestrator-mcp-server-and-chat-ui.md](docs/adr/ADR-018-orchestrator-mcp-server-and-chat-ui.md)
- MCP SDK の版が 3 通り: backlog README「1.30.1 に更新済み」、CLAUDE.md「1.32.1」、package.json は 1.32.2 — [docs/backlog/README.md](docs/backlog/README.md)、[CLAUDE.md](CLAUDE.md) 52 行、packages/*/package.json
- connector-sdk の版: CLAUDE.md は v0.4、connector-implementer は v0.3 — [.claude/agents/connector-implementer.md](.claude/agents/connector-implementer.md)
- adr-keeper は「番号は ADR-017 から」「既存 ADR は 010〜016」と書くが、ADR は 023 まである — [.claude/agents/adr-keeper.md](.claude/agents/adr-keeper.md)
- PR テンプレートの不変条件 7 は「Slack 由来本文の永続化なし」。CLAUDE.md の不変条件 7 はメタデータまで対象を広げている — [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)、[CLAUDE.md](CLAUDE.md) 13 行
- backlog の完了表記の不一致: README で完了とされる T-001 / T-002 / T-010 / T-014 はチェックボックス未チェックのまま — [docs/backlog/](docs/backlog/)
- CLAUDE.md の節見出しが「main の状態(2026-10-12 更新)」のまま、同じ節に 2026-11-14・11-15 の記述が続く — [CLAUDE.md](CLAUDE.md)
- 旧名 `kp`: 23 ファイルに残る(docs/adr 8、docs 直下 4、ADR-019 の図 3、docs/eval 2、backlog 2、spike 1、release 1、gateway のテスト 1、CLAUDE.md 1)。CLAUDE.md は「既存の ADR・設計書・日付付きの記録の本文には旧名が残る」と明記 — [docs/adr/ADR-020-naming-leisen.md](docs/adr/ADR-020-naming-leisen.md)
- 陳腐化しやすい日付付きの記述: 「公開はすぐに行う」(2026-10-13)、「現在はコネクタ・Orchestrator・リファレンスデプロイに進む段階」、「Q2 に前倒し」「Q3 着手」、各「承認待ち」 — [CLAUDE.md](CLAUDE.md)
- backlog README は現在のフェーズを CLAUDE.md に委ねつつ、自分でも進捗段落を持つ — [docs/backlog/README.md](docs/backlog/README.md)

### Inferences
- 状態の正本が決まっていない。進捗は少なくとも 4 層(CLAUDE.md、README、backlog、ADR の追補)に手で複写され、エージェントが PR ごとに全部を更新する運用になっているとみられる。
- 常時読み込まれる CLAUDE.md に誤り(ADR-018 の Status、SDK の版)があると、エージェントの判断に直接影響する。

### Gaps
- 食い違いは目についたものの抽出で、網羅的な突き合わせではない。
