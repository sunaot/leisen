# ADR-018: 利用者向けの面 — Orchestrator の MCP サーバー化と汎用チャット UI(LibreChat)との接続(T-021)

Status: Accepted(オーナー決定 2026-10-08、issue #21: Orchestrator を ask / feedback の API として提供し、サポートする利用面は LibreChat と MCP クライアント。接続方式 A + LibreChat の方針は 2026-09-28 決定)/ Date: 2026-09-28(Accepted: 2026-10-08)

## 文脈
5 観点レビュー(2026-09-27、PR #14)で「利用者が問い合わせる面(UI/API)がない」が程度「高」のリスクになった。product-design §4.1 は「チャット UI および API から自然言語で問い合わせる」ことを Phase 1 の約束としているが、現状の利用面は CLI(`kp-ask`)だけで、T-009(チャット UI 最小)は未着手である。

オーナーの方針(2026-09-28): 自前の UI を作らず、既存の汎用チャット UI を疎結合で接続する。接続方式は **A(Orchestrator を MCP サーバーとして公開する)**、UI の第一候補は **LibreChat**。他の選択肢は比較せず、文書は「LibreChat の場合 / MCP クライアントの場合 / それ以外の場合」の 3 区分だけを示す。

前提となる既存の決定:
- Gateway はリクエスト単位の Bearer 認証(ADR-001 追補3 決定1)。IdP アダプタがトークンを検証し、資格情報は利用者本人のもの(不変条件1、ADR-010)
- AnswerRun は Orchestrator が書き、userId は Gateway が認証した値に束縛する(ADR-017 決定2、セキュリティレビュー H1)。別プロセス・別信頼境界の Orchestrator からの書き込み口は未決(ADR-017 確認事項3)
- 実行区分は human_in_the_loop / actor human 固定(ADR-015、ADR-017 決定5)
- Slack 由来データは永続化しない(不変条件7、ADR-014)。T-009 は「Slack を含む回答は既定で永続履歴に残さない」を要件にしている

LibreChat の関係する機能(公式ドキュメント、2026-09-28 時点で確認):
- MCP サーバー(`streamable-http`)を利用者ごとに分離した接続で扱う
- YAML 定義のサーバーは headers に `Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}'` と書くと、OpenID ログインで得た利用者本人のアクセストークンを転送する(`OPENID_REUSE_TOKENS=true` が前提)。401 / 403 のあと接続を 1 回だけ更新し、拒否されたツール呼び出しは自動では再実行しない。`obo` で audience 付きトークンへの交換もできる
- 一時チャットも保持期間(最短 1 時間)の間は DB に残る。`interface.retentionMode` と `temporaryChatRetention` / `generalChatRetention` で保持期間を設定できる
- 👍👎 のフィードバックは `interface.feedback` で有効化・無効化できる(API `PUT /api/messages/:conversationId/:messageId/feedback`)

## 決定
1. **Orchestrator を MCP サーバー(Streamable HTTP、ステートレス)として公開する。** 起動コマンドは `kp-ask serve`(`packages/orchestrator`)。ツールは 2 つだけ:
   - `ask({ question })` → 回答。text は Markdown(本文 + 末尾の「出典」節)、`structuredContent` に Answer(runId、outcome、confidence、citations、searchedSources、skippedSources、warnings、usage、`retentionClass`)を載せる
   - `feedback({ runId, outcome: "resolved" | "unresolved" })` → AnswerRun.userFeedback の更新
   Gateway と同じ規約で、`initialize` / `tools/list` を含む全リクエストに認証を要求する。ツール定義と `instructions`(initialize 結果)に「出典は改変せずそのまま提示する」「本文の URL は出典欄からたどる」と書き、UI 側の LLM に守らせる
2. **認証は Gateway に委譲する。** Orchestrator サービスは IdP を持たず、Bearer を検証せず、リクエストごとに Gateway の `tools/list` を利用者のトークンで呼んで有効性を確かめる(preflight。全体に既定 10 秒の期限)。preflight で得たソース一覧が `--config` の有効なコネクタと食い違えば、そのリクエストを `config_mismatch` で拒否する(不変条件7 と citedDocIds の分類が設定の中身に依存するため。`--allow-non-persistable-sources` なら通し、retentionClass を `non_persistable` にする)。Gateway の 401 / 503 はそのまま HTTP 401 / 503 で返し(JSON-RPC ディスパッチ前、固定文言)、LLM もソースも呼ばない。`ask` の run では既存どおり AnswerRun.userId を Gateway 認証値に束縛する(H1)。トークンはログ・監査・エラー・`structuredContent` のいずれにも出さない(不変条件6)。Orchestrator は利用者トークンの通過点であり、独自の資格情報を持たない(不変条件1)
3. **実行区分は human_in_the_loop / actor human 固定のまま。** チャット UI の LLM(エージェント)が `ask` を呼ぶ構図は「人間の対話の一部」として扱う(ADR-015、T-003 レビュー H1 の既定)
4. **AnswerRun は Orchestrator サービスが JSONL に追記する**(`--answer-run-jsonl`。Gateway の監査 JSONL とは別ボリュームの別ファイルで、Orchestrator は Gateway の監査ファイルにアクセスできない。同じスキーマ、追記のみ、0600)。昇格判定レポートは `--audit` を複数回指定して両方を読む。Gateway に run 登録の口は作らない。**Orchestrator サービスは Gateway と同じ運用者が同じ信頼境界で動かす前提**(リファレンス構成では同じホスト。監査ボリュームは分け、Orchestrator のコンテナは Gateway の監査ボリュームをマウントせず AnswerRun 専用のボリューム `kp-answer-runs` に書く)。別の信頼境界に置く構成は別 ADR とする(ADR-017 確認事項3 の決着案)
5. **不変条件7 は起動時に fail-closed で守る。** 汎用 UI は履歴を保存するため、`kp-ask serve` は deployment.yaml(`--config`、必須)に永続化不可のソース(kind が `slack` / `slack-*`)が有効なら起動を拒否する。`--allow-non-persistable-sources` で解除できるが、そのときは UI 側で一時チャットの強制と保持期間を設定し、法務確認(ADR-014)を経ることを docs/ui-librechat.md に明記する。`ask` の `structuredContent.retentionClass` は通常 `persistable`。`--allow-non-persistable-sources` で起動したときだけ `non_persistable` を返す(前提が崩れたことを UI 側に伝えるため)。将来ソースの性質を 1 概念にしたとき(5 観点レビューの提案)にここへ接続する
6. **回答の出力契約(Answer 表示契約の v1)。** text は Markdown。本文は無害化済みで URL を含まない。末尾に「出典」節を付け、各行は `[n] title(sourceId:documentId)— <url>`(CommonMark の自動リンク。パスに `[x](…)` を含む URL で別のリンクを作らせないため。セキュリティレビュー S1)。url は `http:` / `https:` のみ描画し、それ以外は url を省く。`structuredContent.citations` も同じ規則で無害化する。outcome が `unresolved` / `error` のときは注意書きを先頭に置き、`structuredContent.errorClass` に正規化コードを載せる。UI 側の Markdown 描画で本文の裸ドメインが自動リンクされうることは残余リスクとして受け入れる(threat-model RS-4 に追記)
7. **公開境界と上限。** 既定はループバック待ち受け。ループバック以外は `--confirm-exposed-host`(Gateway の `confirmExposedHost` と同じ規約)。TLS・Host/Origin 検証・利用者単位の流量制御はリバースプロキシで担う(docs/install.md §6)。同時実行の run 数(`--max-concurrent-runs`、既定 4。超過は固定文言のエラー)、feedback の同時実行(既定 4)、質問の長さ(`--max-question-chars`、既定 4,000 字)、HTTP 本文(既定 64 KiB、超過は 413)に上限を設け、JSON-RPC のバッチ(配列の本文)は 400 で拒否する(1 POST で feedback を 100 件束ねて Gateway への照会を増幅させない)。`NODE_ENV=production` では `--answer-run-jsonl` を必須にする(AnswerRun を永続化しないサービスを本番で動かさない)。上流(Gateway の URL、LLM のベース URL)への平文 http はループバックにしか許さない規則(T-007)はそのまま維持し、compose ネットワーク内のサービス名や `host.docker.internal` の LM Studio に向ける評価用構成のためだけに `--allow-insecure-upstream`(環境変数 `KP_ALLOW_INSECURE_UPSTREAM=1`)を設ける。`NODE_ENV=production` ではこのフラグを拒否し(exit 2)、有効時は起動ログに WARNING を出す
8. **LibreChat との接続は本人トークンの直接転送で行う。** `librechat.yaml` の `mcpServers` に `streamable-http` で Orchestrator を登録し、`Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}'`、`requiresOAuth: false`、`startup: false` とする。LibreChat のログインは同じ Keycloak realm の OpenID(`OPENID_REUSE_TOKENS=true`)。理由: 利用者本人のトークンがそのまま Gateway に届き、IdP の失効・有効期限にそのまま従う。OAuth クライアントの動的登録や MCP 認可メタデータ(RFC 9728)の実装は不要。Gateway が aud / azp の検証(セキュリティレビュー R1)を入れたときのため、realm の LibreChat クライアントには Gateway を audience に加えるマッパーを先に入れておく
9. **他の MCP クライアント**(Claude Code、MCP Inspector、自作エージェント)は同じ規約で接続する: Keycloak が利用者に発行したアクセストークンを `Authorization: Bearer` に載せる。**それ以外の面**(OpenAI 互換のチャットモデルとして公開する、UI の自己申告 ID を信頼する、など)はこの ADR のスコープ外で、必要になったら別 ADR にする
10. **フィードバックは `feedback` ツールで受ける。** 本人のトークンで、run の userId と一致するときだけ更新する(既存の `recordFeedback` の規則)。Gateway は利用者の userId を `tools/call` の結果の `_meta` にしか載せないため、Orchestrator サービスは利用者のトークンで先頭のソースに `describe` を 1 回呼んで本人を確かめる(この describe は `feedback:<UUID>` という別の runId で申告し、対象 run の監査記録には混ぜない。ToolInvocation としては残る。意図どおり)。LibreChat の 👍👎 との自動連携は v1 では行わない(T-021 の残課題)
11. **リファレンス構成に LibreChat の overlay を足す**(`deploy/compose/docker-compose.librechat.yml`)。基本の compose(gateway + keycloak)は変えず、`-f` の重ね合わせで orchestrator・librechat・mongodb を追加する。Gateway のイメージに orchestrator の dist と prompts を含め、orchestrator サービスは同じイメージを別エントリポイントで動かす。ブラウザとコンテナの両方から Keycloak を同じホスト名で参照するため、overlay では Keycloak のホスト名を `keycloak.localhost`(ネットワークエイリアス)にする。LibreChat(v0.8.7、openid-client 6.x)は http の発行者を拒否するため、overlay では Keycloak の前段に TLS 終端(Caddy、内部 CA)を置き `https://keycloak.localhost:8443` を発行者にする。ブラウザ側では内部 CA を信頼するか警告を受け入れる(評価用構成の割り切り。docs/ui-librechat.md)。overlay では Keycloak の `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` を false にし(ディスカバリの URL を常に https にする。Gateway のイントロスペクションは deployment.yaml の http://keycloak:8080 を直接呼ぶため影響しない)、LibreChat 側は `interface.mcpServers.create: false`(利用者が MCP サーバーを追加できない)と `mcpSettings.allowedDomains`(MCP の接続先を Orchestrator の origin だけにする)で、MCP 接続を Orchestrator だけに限る(`mcpSettings.allowedAddresses` は私設 IP 宛ての SSRF 防御の例外にすぎず、接続先の制限にはならない。LibreChat v0.8.7 のソースで確認)。LibreChat v0.8.7 では `interface.generalChatRetention` と `interface.feedback` が無効(v0.8.8 以降)のため、`retentionMode: all` と `temporaryChatRetention: 2160`(90 日)で全会話に期限を付ける(確認事項 4)。イメージは `ghcr.io/librechat-ai/librechat:v0.8.7` に固定する

## 理由
- 方式 A(MCP サーバー)にした理由: 両 UI が「利用者ごとの接続 + 本人トークン」を MCP サーバー向けに実装している一方、OpenAI 互換モデルとして公開する方式では UI の自己申告 ID(ヘッダ)を信頼する必要があり、Gateway の設計(IdP 検証済みの本人トークン)と合わない。方式 A なら Gateway の認証・監査・射影・TM-B2 正規化がすべてそのまま効く
- 認証を Gateway に委譲する理由: Orchestrator に IdP 設定と検証キャッシュを複製すると、検証ロジックが 2 か所になる(ドメインレビュー R6 の閉じた列挙の問題を増やす)。`tools/list` の 1 往復(ループバックで 1〜3ms)で Gateway の判断に従うほうが単純で、拒否の分類も 1 か所に揃う
- 直接転送を選び OAuth 登録を選ばなかった理由: 動的登録には Gateway 側に RFC 9728 / 8414 の実装と Keycloak の DCR 設定が要る。事前登録の OAuth クライアントでも LibreChat が別のトークンを保管することになり、失効の同期が 1 段増える。直接転送は LibreChat が「MCP サーバーを信頼できる場合のみ」と注意している方式だが、Orchestrator は同じ運用者が置く自前のサービスであり、この条件を満たす
- 不変条件7 を起動時に判定する理由: 汎用 UI の履歴は Orchestrator から制御できない。UI 側の設定に頼ると導入先ごとに漏れが出る。Slack を有効にした構成で「起動しない」を既定にしておけば、解除には明示のフラグと法務確認が要り、規約と実装が一致する
- AnswerRun を別 JSONL にする理由: Gateway の JSONL は Gateway プロセスが単独で追記する前提(docs/install.md)で、別プロセスからの同時追記は避けたい。同じスキーマの別ファイルなら、レポート側で結合するだけで済む

## 帰結
- 5 観点レビューの高リスク「利用者が問い合わせる面がない」は、リファレンス構成に LibreChat の overlay を足した時点で解消する。T-009 の受け入れ条件のうち、未ログイン時のツール呼び出しなし(Gateway が拒否)、出典リンク(出典欄の url)は満たす。保持期間の deployment.yaml からの注入と Slack 回答の非永続は LibreChat の設定に委ねる(T-009 を更新)
- 監査 2 層の運用: Gateway の JSONL と Orchestrator の JSONL の 2 ファイルになる。昇格判定レポートの入力を複数にする(T-014 の小改修)
- 最終文面を書くのは UI 側の LLM になる。出典の保証はツール境界までで、UI の LLM が出典を落とす・言い換える可能性は `instructions` とツール定義の文言で抑えるにとどまる。評価ハーネス(T-008)で「UI 経由でも出典が保たれるか」を測る項目を足す
- Orchestrator サービスは利用者トークンを受け取る新しいネットワーク面になる。脅威モデルに追記する(TM-I: Orchestrator サービス)
- Docker イメージが orchestrator を含むようになり、本番依存に `@anthropic-ai/sdk` が加わる

## 却下した案
- Orchestrator を OpenAI 互換モデルとして公開し、UI の自己申告ヘッダ(`X-OpenWebUI-User-*`、`{{LIBRECHAT_USER_*}}`)を信頼する: 本人トークンではなく UI の主張に認可を乗せることになり、UI の侵害が全利用者の権限に直結する。ADR-010 の方式にもない
- UI から Gateway に直接 MCP で接続する(Orchestrator を通さない): 出典検証・URL 除去・AnswerRun が抜ける(機能設計レビュー R9)
- Orchestrator に IdP 検証を複製する: 上記「理由」のとおり
- Gateway に run 登録 API を作る: 信頼境界を分けない前提では不要。分ける構成が現れたときに別 ADR で扱う

## 人間に確認してほしい点
1. 決定 4(AnswerRun を Orchestrator サービスの JSONL に書く。Gateway と同じ信頼境界)を ADR-017 確認事項3 の決着として受け入れるか
2. 決定 5(Slack 有効時は起動拒否、解除は明示フラグ + 法務確認)。Slack の導入形態の法務確認(ADR-014)と合わせて判断してほしい
3. 決定 8 の直接転送(LibreChat が「信頼できる MCP サーバーのみ」とする方式)を、自前サービスである Orchestrator に対して認めるか。認めない場合は事前登録の OAuth クライアント方式(LibreChat の `oauth` 設定 + Gateway の RFC 9728 メタデータ)に切り替える
4. LibreChat の履歴保持: 一時チャット強制と `temporaryChatRetention` の既定値(v1 の overlay は `retentionMode: all`、`generalChatRetention` を `chatHistory.retentionDays` と同じ 90 日相当に設定)

## 追記(2026-10-08): オーナー決定(issue #21)

issue #21 のコメント(2026-10-08)で次が決まり、本 ADR を Accepted とする。

- **Orchestrator を `ask` / `feedback` の API として提供する**(決定 1〜2、10)。
- **サポートする利用面は LibreChat と MCP クライアントの 2 つ**(決定 8・11 と決定 9)。docs/ui-librechat.md の「LibreChat の場合」「MCP クライアントの場合」が対応する。「それ以外の場合」(OpenAI 互換のチャットモデルとして公開する、UI の自己申告 ID を信頼する、独自の REST API を設ける等)は提供しない。必要になれば別 ADR とする。
- 「人間に確認してほしい点」1〜4 への個別の回答はなく、v1 の実装(決定 4・5・8・11 の記述どおり)で進める。異議があれば issue #21 にコメントする。
- **決定 5(Slack 有効時の起動拒否と明示フラグによる解除)は 2026-10-09 にオーナーが v1 として確認した**(issue #21)。Slack を検索対象にする導入向けに、会話を永続化しないフロントエンドを別途用意する方針が決まり、T-009 をその定義に付け替えた(2026-10-09、issue #21。`docs/backlog/T-009-chat-ui.md`)。
- 未決のまま残る点(本 ADR の範囲外として扱う): MCP クライアントから Gateway へ直接接続する経路の扱い(開発・検証用途に限るか、azp の許可リストで制限するか。issue #21 の判断点、#16・#24)、T-009(自前のチャット UI)を取り下げるか縮小するか。
