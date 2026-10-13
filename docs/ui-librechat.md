# UI から使う(LibreChat / MCP クライアント)

Status: v0(T-021)/ Date: 2026-09-28

利用者がチャット UI や MCP クライアントから社内ナレッジに問い合わせるための接続手順。設計の正は
[ADR-018](adr/ADR-018-orchestrator-mcp-server-and-chat-ui.md)(Proposed)、リファレンスデプロイ全体の
手順・前提・公開時の必須条件は [docs/install.md](install.md) を参照。本書は次の 3 区分だけを示す。

- [1. LibreChat の場合](#1-librechat-の場合)(リファレンス構成の overlay で動かす)
- [2. MCP クライアントの場合](#2-mcp-クライアントの場合)(Claude Code、MCP Inspector、自作エージェントなど)
- [3. それ以外の場合](#3-それ以外の場合)(サポート外)

## 0. 位置づけ

- **Orchestrator を MCP サーバーとして公開する**(ADR-018 決定1)。`leisen-ask serve` が Streamable HTTP
  (ステートレス)で待ち受け、ツールは `ask({ question })` と `feedback({ runId, outcome })` の 2 つだけ。
  `ask` の結果は Markdown(本文 + 末尾の「出典」節 + `runId`)と `structuredContent`(Answer)
- **認証は Gateway に委譲する**(決定2)。Orchestrator は IdP を持たず、独自の資格情報も持たない。
  リクエストごとに受け取った Bearer トークンで Gateway の `tools/list` を呼んで有効性を確かめ、Gateway が
  拒否すれば HTTP 401、Gateway・IdP に届かなければ 503 を返す(LLM もソースも呼ばない)。トークンは
  保存せず、ログ・監査・エラー・`structuredContent` に出さない(不変条件6)
- **利用者本人のトークンを直接転送する**(決定8)。UI は、利用者がログインしたときに IdP(Keycloak)が
  本人に発行したアクセストークンを、MCP の `Authorization: Bearer` にそのまま載せる。Gateway の認証・
  監査・射影と、ソースへの本人権限での委譲(不変条件1)がそのまま効く
- **不変条件7 は起動時に守る**(決定5)。汎用 UI は会話履歴を保存するため、deployment.yaml で永続化
  できないソース(Slack、kind が `slack` / `slack-*`)が有効なら `leisen-ask serve` は起動を拒否する
  (解除の条件は [1.4](#14-履歴の保持と不変条件7))
- **監査ストアに書くのは Gateway だけ**(ADR-019。ADR-018 決定4 の別ボリュームは廃止)。Orchestrator は run の
  開始・結果・フィードバック(AnswerRun)を Gateway の run API(`/runs`)に申告し、Gateway が署名付きの
  runId で本人・期限を確かめて `audit.jsonl` に記録する。Orchestrator のコンテナは監査ボリュームを一切マウント
  しない(読めない・書けない)。run API には利用者本人のトークンに加えて Gateway と共有する Orchestrator の
  資格情報(`LEISEN_ORCHESTRATOR_CREDENTIAL`)が要る([1.7](#17-run-の記録answerrunと昇格判定レポート)、
  docs/install.md §5・§7)
- リファレンス構成は**評価用**(開発用の部品・ローカル専用のダミー秘密・開発モードの Keycloak)。
  限界は docs/install.md §0 と同じ

```
ブラウザ ─(OpenID ログイン)→ keycloak-tls(https://keycloak.localhost:8443)→ Keycloak
   │
LibreChat(http://localhost:3080)… UI 側の LLM(LM Studio)が ask / feedback を呼ぶ
   │  MCP(Streamable HTTP)  Authorization: Bearer <利用者本人のアクセストークン>
Orchestrator(leisen-ask serve、:8790)… 探索ループの LLM(LM Studio)
   │  MCP + 同じ Bearer
Gateway(:8787)─(イントロスペクション)→ Keycloak(http://keycloak:8080)
   │  本人の資格情報
コネクタ(評価用構成では開発用の dev-docs)
```

## 1. LibreChat の場合

リファレンス構成に LibreChat の overlay(`deploy/compose/docker-compose.librechat.yml`)を重ねる。
基本の compose(gateway + keycloak)は変えず、次を足す(ADR-018 決定11)。

| サービス | 内容 |
|---|---|
| `orchestrator` | `leisen-ask serve`。gateway と同じイメージを別エントリポイントで動かす。`127.0.0.1:8790` |
| `librechat` | LibreChat v0.8.7(安定版に固定)。`127.0.0.1:3080` |
| `mongodb` | LibreChat の保存先(会話履歴・利用者)。ホストへは公開せず、librechat と共有する内部ネットワーク `librechat-internal` だけに置く(他のコンテナからは届かない) |
| `keycloak-tls` | Keycloak の前段の TLS 終端(Caddy のローカル CA)。`127.0.0.1:8443`([1.3](#13-keycloaklocalhost-と証明書)) |

設定ファイルは `deploy/compose/librechat/`: `librechat.yaml`(MCP サーバー・保持期間・LLM エンドポイント)、
`librechat.env.example`(OpenID・セッション鍵の雛形)、`Caddyfile` と `keycloak-tls.sh`(TLS 終端)。

### 1.1 前提

- docs/install.md §1 の前提(Docker Engine 23 以降と Compose v2、スモーク用の curl と Node.js)
- ホストの `127.0.0.1` の 3080(LibreChat)・8443(Keycloak の TLS 終端)・8790(Orchestrator)・
  8787(Gateway)・8080(Keycloak)が空いていること
- **LM Studio**(OpenAI 互換 API)をホストで動かす。ツール呼び出し(function calling)に対応した
  モデルをロードし、ローカルサーバーを起動する(既定 `http://localhost:1234/v1`)。UI 側の LLM
  (LibreChat の会話相手)と Orchestrator の探索ループの両方が使う。gpt-oss 20B クラス以上を想定
  (packages/orchestrator/README.md「LM Studio で使う」)
  - コンテナからは `http://host.docker.internal:1234/v1` で呼ぶ。Docker Desktop(macOS / Windows)は
    そのまま届く。**Linux の Docker Engine では、LM Studio がループバック(127.0.0.1)だけで待ち受けて
    いると届かない**(host.docker.internal はブリッジのゲートウェイのアドレス)。LM Studio のサーバー
    設定でローカルネットワークでの待ち受けを有効にし、ファイアウォールで LAN からの接続を制限する
- ブラウザは Chrome / Firefox(`*.localhost` をループバックに解決する)。それ以外は hosts の追加が要る
  ([1.3](#13-keycloaklocalhost-と証明書))

### 1.2 5 分手順

```bash
cd deploy/compose
cp .env.example .env                                         # LEISEN_LLM_MODEL を LM Studio のモデル名にする
# librechat.env を雛形から作り、LibreChat 自身のセッション・保存時暗号化の鍵を生成した値に置き換える
# (鍵は画面にもコマンドライン引数にも出さない。ファイルは 0600)
(
  umask 077
  JWT_SECRET="$(openssl rand -hex 32)" JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  CREDS_KEY="$(openssl rand -hex 32)" CREDS_IV="$(openssl rand -hex 16)" \
  OPENID_SESSION_SECRET="$(openssl rand -hex 32)" \
  awk -F= '$1 ~ /^(JWT_SECRET|JWT_REFRESH_SECRET|CREDS_KEY|CREDS_IV|OPENID_SESSION_SECRET)$/ { print $1 "=" ENVIRON[$1]; next } { print }' \
    librechat/librechat.env.example > librechat/librechat.env
)
docker compose -f docker-compose.yml -f docker-compose.librechat.yml up -d --build --wait
```

- **`librechat.env` の鍵は必ず生成する。** 雛形 `librechat.env.example` の `JWT_SECRET` / `JWT_REFRESH_SECRET` /
  `CREDS_KEY` / `CREDS_IV` / `OPENID_SESSION_SECRET` はこのリポジトリで公開しているダミーで、雛形の値のままだと
  `127.0.0.1:3080` に届く人が LibreChat のセッション(JWT)を偽造できる(利用者の ID が分かればその利用者に
  なりすまし、会話履歴 = 本人の権限で得た回答を読める)。上のコマンドは `openssl rand -hex 32`(`CREDS_IV`
  だけ `openssl rand -hex 16`)で生成した値に置き換える(bash / zsh。Windows は WSL で実行する)。手で編集する
  場合も同じコマンドで生成して置き換える。雛形を `cp` したまま使うのは CI の `reference-deploy`(使い捨ての
  ランナー)だけ。`OPENID_CLIENT_SECRET` は realm(`e2e/keycloak/realm/leisen-realm.json`)のダミーと対なので、
  変えるときは realm も合わせる
- `.env` の `LEISEN_LLM_MODEL` は LM Studio でロードしたモデル名(`curl http://localhost:1234/v1/models` の
  `id`)。`LEISEN_LLM_BASE_URL` の既定はホストの LM Studio
- `-f` を毎回書かない場合は `.env` に `COMPOSE_FILE=docker-compose.yml:docker-compose.librechat.yml` を
  足す(Windows は `;` 区切り)
- 起動の確認(CI の `reference-deploy` ジョブと同じスモーク。トークン・応答本文は出力しない):

  ```bash
  LEISEN_SESSION_TOKEN="$(../../scripts/smoke/keycloak-token.sh)" ../../scripts/smoke/orchestrator-smoke.sh
  ../../scripts/smoke/librechat-smoke.sh
  ```

  `orchestrator-smoke.sh` はトークンなし・不正なトークンが 401 になり、Keycloak のトークンで `tools/list` が
  `ask` と `feedback` を返すことを、`librechat-smoke.sh` は LibreChat の `/health` と、OpenID ログインの開始が
  Keycloak(https)へのリダイレクトになること(LibreChat が起動時に OpenID を構成できたこと)を確かめる

LibreChat での操作(UI の表記は版によって異なる):

1. http://localhost:3080 を開き、「Keycloak でログイン」を押す
2. 初回はブラウザが `keycloak.localhost` の証明書の警告を出す(評価用のローカル CA)。続行する
   ([1.3](#13-keycloaklocalhost-と証明書))
3. Keycloak のログイン画面で `alice` / `dev-only-alice-password`(または `bob` / `dev-only-bob-password`。
   realm `e2e/keycloak/realm/leisen-realm.json` のダミー値)。初回ログインで LibreChat の利用者が作られる
4. エンドポイント「LM Studio」とモデル(ツール呼び出しに対応したもの)を選ぶ
5. 入力欄の下の MCP サーバーの選択から **Leisen** を選ぶ。起動時には接続しない設定(`startup: false`)の
   ため、初回の選択で接続を初期化する。エージェントで使う場合は、エージェントビルダーの
   ツールの追加 → MCP から Leisen を選ぶ
6. 質問する(例: 「VPN の接続手順を教えて」。評価用構成の検索対象は開発用の合成コーパス
   `examples/fixtures/dev-corpus.yaml`)。UI 側の LLM が `ask` を呼び、Orchestrator が Gateway 経由で
   本人の権限で検索して回答する。回答には「出典」節(`[n] タイトル(sourceId:documentId)— <url>`。url は
   Markdown の自動リンク)と `runId` が付く。本文の URL は除去済みで、原典へのリンクは出典欄だけが運ぶ
   (ADR-018 決定6)
7. フィードバック: 回答で解決したかどうかを会話で伝える(例: 「今の回答で解決した。feedback して」)。
   UI 側の LLM が `feedback({ runId, outcome: "resolved" | "unresolved" })` を呼び、Orchestrator が Gateway の
   run API に本人のトークンで申告して AnswerRun に記録される。記録できるのは質問した本人の run だけで、
   回答から 7 日(Gateway の `gateway.runs.feedbackWindowSec`)を過ぎた runId は受け付けない。LibreChat の
   👍👎 とは連携しない(未実装)
8. ユーザーを切り替えるときはログアウトする(Keycloak のセッションも終わる。`OPENID_USE_END_SESSION_ENDPOINT`)

停止は `docker compose -f docker-compose.yml -f docker-compose.librechat.yml down`。`down -v` は会話履歴
(MongoDB)・監査ログ(AnswerRun を含む)・ローカル CA のボリュームも消す(評価以外では監査ログの削除は
ADR-013 §3 に従う)。

### 1.3 keycloak.localhost と証明書

- **Keycloak を https で見せる理由**: LibreChat の OpenID クライアント(openid-client v6)は、発行者と
  各エンドポイント(認可・トークン・JWKS・userinfo・ログアウト)に https を要求し、http の発行者では
  ログインを構成できない(起動ログに `only requests to HTTPS are allowed`)。overlay は Keycloak
  (開発モード、http)の前段に TLS 終端 `keycloak-tls`(Caddy)を置き、発行者を
  `https://keycloak.localhost:8443/realms/leisen` に固定する(`KC_HOSTNAME`)。証明書は Caddy の内部 CA
  (ローカル CA)が発行し、LibreChat はそのルート証明書だけを追加で信頼する(`NODE_EXTRA_CA_CERTS`。
  `keycloak-tls.sh` が秘密鍵を含めずに書き出す)
- **keycloak.localhost という名前の理由**: ブラウザ(ログイン画面へのリダイレクト)とコンテナ(LibreChat の
  ディスカバリ・トークン交換)が同じ発行者 URL を使う必要がある。`*.localhost` は Chrome / Firefox が
  ループバックに解決し、compose 内はネットワークエイリアスで `keycloak-tls` に解決する
- **名前が解決できない環境**(Safari など): hosts に `127.0.0.1 keycloak.localhost` を足す
  (macOS / Linux は `/etc/hosts`、Windows は `C:\Windows\System32\drivers\etc\hosts`)
- **証明書の警告**: ローカル CA はブラウザに信頼されていないため、初回に警告が出る。**第一の方法は、警告を
  受け入れて続行すること**(評価用構成の割り切り。Chrome は「詳細設定」→「keycloak.localhost にアクセスする
  (安全ではありません)」、Firefox は「詳細情報」→「危険性を承知で続行」)。例外は `keycloak.localhost` の
  証明書に限られ、ブラウザ・OS の信頼ストアは変わらない
- **CA を信頼させる場合(任意)**: 警告を毎回出したくないときだけ、ルート証明書を取り出して、**ブラウザの
  プロファイル単位か、その利用者だけの信頼ストア(macOS は login キーチェーン)**に入れる。マシン全体の信頼ストア
  (macOS の System キーチェーン、Windows のローカルコンピューターのストア、Linux の
  `/usr/local/share/ca-certificates` など)には入れない。この CA の秘密鍵はボリューム `leisen-caddy-data` にあり、
  ボリュームを読める人は、この CA を信頼したブラウザに通用する任意の名前(実在のサイトを含む)の証明書を作れる。
  信頼させる範囲は最小にする:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.librechat.yml cp keycloak-tls:/ca/root.crt ./leisen-dev-root.crt
  ```

  | 環境 | 信頼させる(範囲) | 評価後に削除する |
  |---|---|---|
  | Firefox(OS によらず) | 設定 → プライバシーとセキュリティ → 証明書を表示 → 認証局証明書 → インポート(ウェブサイトの識別を信頼する)。**そのプロファイルだけ** | 同じ画面で削除 |
  | macOS(Safari / Chrome) | `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db leisen-dev-root.crt`(`sudo`・`-d`・System キーチェーンは使わない)。**login キーチェーン = その利用者だけ** | キーチェーンアクセスの「ログイン」から `Caddy Local Authority - <年> ECC Root` を削除 |
  | Windows(Edge / Chrome) | `certutil -user -addstore Root leisen-dev-root.crt`(`-user` を必ず付ける)。**現在のユーザーのストアだけ** | `certmgr.msc`(現在のユーザー)の「信頼されたルート証明機関」から同じ名前の証明書を削除 |
  | Linux の Chrome | 設定 → プライバシーとセキュリティ → セキュリティ → 証明書の管理 → 認証局 → インポート。**その利用者の NSS データベース(`~/.pki/nssdb`)だけ** | 同じ画面で削除 |

  **評価が終わったら必ず削除する**。`down -v` で CA も作り直しになる(次回は新しいルート証明書を入れ直す)
- Gateway のイントロスペクションは従来どおりネットワーク内の `http://keycloak:8080` を直接呼び、
  スモーク用のトークン取得(`scripts/smoke/keycloak-token.sh`)も `http://localhost:8080` を使う。
  どちらのトークンも発行者は `https://keycloak.localhost:8443/realms/leisen`(`KC_HOSTNAME` で固定)
- realm のクライアント `librechat` はアクセストークンの有効期間を 15 分にしている(realm 全体は 5 分)。
  ask は数十秒〜数分かかるため、5 分では送信直後に失効して 401 になりやすい。Gateway は毎回
  イントロスペクションで確かめるため、ログアウト・利用者の無効化は有効期間によらず反映される
- このクライアントには Gateway を audience に加えるマッパーを入れてある(Gateway が aud / azp の検証を
  入れたときのため。ADR-018 決定8)
- このクライアントのリダイレクト先はコールバック `http://localhost:3080/oauth/openid/callback`、ログアウト後の
  戻り先は `http://localhost:3080/login` の完全一致だけで(ワイルドカードを使わない)、認可コードフローには PKCE
  (S256)を必須にしている(`pkce.code.challenge.method`。LibreChat 側は `OPENID_USE_PKCE=true`)。
  `librechat.env` の `DOMAIN_SERVER` / `DOMAIN_CLIENT` / `OPENID_CALLBACK_URL` を変えたら、realm の
  `redirectUris` / `post.logout.redirect.uris` も同じ値に直す(`packages/gateway/test/reference-deploy.test.ts` が
  整合を検査する)

### 1.4 履歴の保持と不変条件7

LibreChat は会話を MongoDB に保存する。overlay の設定(`librechat.yaml` / `librechat.env`):

| 設定 | 値 | 意味(LibreChat v0.8.7) |
|---|---|---|
| `interface.retentionMode` | `all` | 一時チャットに限らず、すべての会話・メッセージに保持期限を付ける |
| `interface.temporaryChatRetention` | `2160`(時間) | 保持期限。90 日 = deployment.yaml の `chatHistory.retentionDays`(ADR-013 §4)。保存・更新のたびに付け直され、期限を過ぎると MongoDB が削除する |
| `ALLOW_SHARED_LINKS` | `false` | 会話の共有リンクを作らせない。回答は質問者本人の権限で検索した結果で、他人に見せるとソース側の認可を迂回する(threat-model TM-G4) |
| `DEBUG_LOGGING` | `false` | 会話の内容を含みうるデバッグログをファイルに書かない |

- **v0.8.7 では通常の会話と一時チャットの保持期限を分けられない**(上の 2160 時間が両方に効く)。
  通常の会話の期限 `interface.generalChatRetention` と 👍👎 の表示の切り替え `interface.feedback` は
  **v0.8.8 以降で設定できる**(設定 version 1.3.16 以降。2026-09-28 時点では rc のみ)。v0.8.7 では書いても
  黙って無視されるため、overlay には入れていない(ADR-018「人間に確認してほしい点」4 の想定との差)。v0.8.8 の
  安定版に上げるときに、イメージの版・`version` と合わせて `generalChatRetention: 2160`(通常の会話 90 日)と
  `temporaryChatRetention: 24`(一時チャット 1 日)に分ける
- 一時チャットも保持期限までは DB に残る(最短 1 時間)
- **Slack を有効にする場合**: deployment.yaml で Slack のソースが有効だと `orchestrator` は起動を拒否する
  (終了コード 1。理由は orchestrator の起動ログに出る)。有効にするには次をすべて行う
  1. 導入形態の法務確認(ADR-014。T-006 の前提と同じ)。LibreChat の履歴は最短でも 1 時間 DB に残るため、
     不変条件7(Slack 由来データを永続化しない)との関係もこの確認に含める
  2. `docker-compose.librechat.yml` の orchestrator の `command` に `--allow-non-persistable-sources` を足す
     (起動ログに WARNING が出て、`ask` の `structuredContent.retentionClass` が `non_persistable` になる。
     LibreChat はこの値を読まない)
  3. LibreChat の保持を最短にする: v0.8.7 は `retentionMode: all` のまま `temporaryChatRetention: 1`
     (すべての会話が 1 時間で消える。一時チャットの強制に相当)。v0.8.8 以降は `generalChatRetention` も
     同じく短くする
  4. `DEBUG_LOGGING=false` と `ALLOW_SHARED_LINKS=false` を保つ

### 1.5 セキュリティ上の注意

- **直接転送は、Orchestrator を運用者が信頼できる場合に限る。** LibreChat は
  `{{LIBRECHAT_OPENID_ACCESS_TOKEN}}` の転送を「信頼できる MCP サーバーにだけ使う」よう注意している。
  Orchestrator は Gateway と同じ運用者が同じ信頼境界で動かす前提(ADR-018 決定4・8)。第三者の MCP
  サーバーにこのプレースホルダを書かない(v0.8.7 は `librechat.yaml` に定義したサーバーでだけ展開し、
  利用者が追加したサーバーでは展開しない)
- **UI 側の LLM が呼べる外部のツールは Orchestrator だけにする**(threat-model TM-I2 / TM-I3)。
  `librechat.yaml` で次の 3 つを設定している(挙動は LibreChat v0.8.7 のソースで確認):

  | 設定 | 値 | 効果 |
  |---|---|---|
  | `interface.mcpServers` | `use: true`、`create: false`、`share: false`、`public: false` | 利用者は Leisen を使えるが、MCP サーバーを追加・共有できない。起動のたびに USER・ADMIN の両ロールへ適用される(書かない場合のロールの既定値は、USER が追加不可、ADMIN が追加・共有可) |
  | `mcpSettings.allowedDomains` | `http://orchestrator:8790`(Leisen の `url` の origin) | MCP の接続先の許可リスト。`librechat.yaml` に定義したサーバーも利用者が追加したサーバーも、スキーム・ホスト・ポートが一致する接続先にしか接続しない |
  | `endpoints.agents.capabilities` | v0.8.7 の既定の一覧から `actions`・`web_search`・`execute_code` を除いたもの | エージェント(MCP サーバーを選んだ通常の会話も内部ではエージェント)が、利用者の定義した外部 API(Actions)と Web 検索・コード実行の外部サービス(利用者が自分のキーや URL を入れて使える)を呼ばない。UI にも出ない |

  - `mcpSettings.allowedAddresses` は**私設 IP 宛ての SSRF 防御の例外**にすぎず、接続先の制限にはならない。
    `allowedDomains` が未設定だと LibreChat は私設 IP・localhost・内部向けの名前だけを拒否し、公開ホストへは
    すべて接続できる。`allowedDomains` を設定すると MCP の判定で `allowedAddresses` は参照されないため、この
    overlay には書かない。逆に `allowedDomains` に書いた接続先は私設 IP でも接続される(SSRF 防御の対象外に
    なる)ため、運用者が信頼する接続先だけを書く
  - MCP サーバーを足すときは `mcpServers` に定義し、`allowedDomains` にその origin を足す(足さないと起動時の
    検査で拒否され(起動ログに `[MCP][<名前>] Failed to initialize` と `Domain "…" is not allowed`)、接続
    できない)。LibreChat の版を上げるときは、これらの項目の意味と既定値を新しい版で確かめ直す
    (`capabilities` に書いていない機能は無効になる)
- **公開はループバックだけ。** 外部に公開する場合は、LibreChat(3080)・Orchestrator(8790)・Keycloak の
  前段に TLS を終端するリバースプロキシを置き、Host / Origin の許可リスト、リクエストの期限、利用者単位の
  流量制御をそこで担う(docs/install.md §6。Orchestrator 側の上限は同時実行数 `--max-concurrent-runs 4` と
  質問長 `--max-question-chars 4000` だけ)。Orchestrator はコンテナ内で `0.0.0.0` に待ち受けるため
  `--confirm-exposed-host` を付けている(Gateway の `confirmExposedHost` と同じ規約)
- **上流への平文 http は評価用。** orchestrator の `--allow-insecure-upstream` は、Gateway
  (`http://gateway:8787/mcp`)と LLM(ホストの LM Studio、`http://host.docker.internal:1234/v1`)へ
  ループバック以外の平文 http で送るための評価用構成の設定(`NODE_ENV=production` では使えず、有効時は
  起動ログに WARNING が出る)。Gateway へは利用者のトークンが、LLM へは本人の権限で取得した文書の本文が
  流れる。本番では上流を https にするか、同じホストのループバックにする
- **秘密情報**: `.env` と `librechat/librechat.env` は git 管理外。雛形の値はダミー(`dev-only-` と作り物の
  16 進列)で、このリポジトリで公開されている。手元でも LibreChat 自身の鍵(`JWT_SECRET` / `JWT_REFRESH_SECRET` /
  `CREDS_KEY` / `CREDS_IV` / `OPENID_SESSION_SECRET`)は必ず生成する([1.2](#12-5-分手順)。雛形の値のままだと
  `127.0.0.1:3080` に届く人がセッションを偽造できる)。評価以外では、これらと Keycloak のクライアント secret を
  新しく生成し、秘密ストアから注入する
- **MongoDB**: 認証なしで動かしている(LibreChat の上流の構成と同じ)代わりに、librechat と共有する内部
  ネットワーク `librechat-internal` だけに置く。ホストにも他のコンテナ(gateway・orchestrator・keycloak・
  keycloak-tls)にも見えない(名前解決も接続もできない)。`internal: true` のため MongoDB から外部へも出られない
- **ログ**: LibreChat の `DEBUG_OPENID_REQUESTS` は有効にしない(トークン交換の本文がログに出る)。
  `DEBUG_LOGGING` を調査で有効にしたら、終わったら戻してログを消す
- 最終文面を書くのは UI 側の LLM。出典の保証はツール境界まで(`instructions` とツール定義で「出典は
  改変せずに提示する」と指示している)。LibreChat の Markdown 描画が本文中の裸のドメイン名を自動リンク
  する可能性は残余リスク(threat-model RS-4)
- **ask の本文は UI 側の LLM にとって信頼できない入力。** 本文は検索対象文書(社内の誰かが書ける)にもとづくため、
  文書に埋め込まれた指示が UI 側の LLM に届き、feedback の誤記録(利用者が言っていない解決・未解決)や、
  回答の内容を外部のツールへ送ることを誘導しうる(threat-model TM-I3)。対策は、外部のツールを Orchestrator
  だけにする上の設定、原典へのリンクを出典欄の url(autolink)だけが運ぶこと(本文に URL を残さない。ADR-018
  決定6)、`instructions` とツール定義での指示(出典を改変しない・出典欄以外のリンクを作らない・feedback は
  利用者が明示したときだけ呼ぶ)。`instructions` は UI 側の LLM への指示で強制力はなく、本人の run への
  誤った feedback は残余リスク(feedback が更新できるのは質問した本人の run だけ)

### 1.6 トラブルシュート

以下の `docker compose` は `deploy/compose` で、`-f docker-compose.yml -f docker-compose.librechat.yml` を付けて
(または [1.2](#12-5-分手順) の `COMPOSE_FILE` を設定して)実行する。

| 症状 | 原因と対処 |
|---|---|
| ツールの呼び出しが 401 で失敗する | 転送したトークンの失効(クライアント `librechat` は 15 分)か、LibreChat のセッション切れ。ログアウトして再ログインし、質問を送り直す。`OPENID_REUSE_TOKENS=true` でないとトークンが転送されない |
| ツールの呼び出しが 503 で失敗する | Orchestrator から Gateway(または Gateway から Keycloak)に届かない。`docker compose ps` で gateway / keycloak が healthy か確かめる |
| ログインボタンがない・ログイン開始が 500 になる | LibreChat が起動時に OpenID のディスカバリに失敗した(ディスカバリは起動時に1回だけ)。`docker compose logs librechat` の `[openidStrategy]` を見る。多い原因は keycloak-tls の証明書を信頼できない(`NODE_EXTRA_CA_CERTS`)・http の発行者・`OPENID_ISSUER` の誤記。直したら `docker compose restart librechat` |
| ブラウザで keycloak.localhost が開けない | 名前が解決できない → hosts に `127.0.0.1 keycloak.localhost`。証明書の警告 → [1.3](#13-keycloaklocalhost-と証明書) |
| ログイン後に invalid issuer 等で失敗する | 発行者の不一致。`librechat.env` の `OPENID_ISSUER` は overlay の `KC_HOSTNAME` + `/realms/leisen` と同じにする(`packages/gateway/test/reference-deploy.test.ts` が整合を検査する) |
| Leisen が選べない・接続できない | `docker compose logs orchestrator` と LibreChat のログの `[MCP][leisen]` を見る。`librechat.yaml` の `url` と `mcpSettings.allowedDomains`(`url` の origin)が orchestrator の待ち受けと一致しているか(一致しないと `Domain "…" is not allowed` で拒否される) |
| Keycloak の画面に `Invalid parameter: redirect_uri` 等が出る | realm のクライアント `librechat` はリダイレクト先・ログアウト後の戻り先を完全一致で照合する。`librechat.env` の `DOMAIN_SERVER` / `DOMAIN_CLIENT` / `OPENID_CALLBACK_URL` を変えたなら realm の `redirectUris` / `post.logout.redirect.uris` も合わせ、keycloak を作り直す(`up -d --force-recreate keycloak`。realm は起動時の import だけで反映される。[1.3](#13-keycloaklocalhost-と証明書)) |
| ツールの呼び出しが `config_mismatch` で失敗する | Gateway が公開しているソースが、orchestrator に渡した `deployment.yaml` の有効なコネクタにない(設定のずれ)。両方に同じファイルを渡し、gateway と orchestrator を作り直す。永続化できないソース(Slack)を含めて動かすには `--allow-non-persistable-sources`([1.4](#14-履歴の保持と不変条件7)) |
| ツールの呼び出しが `busy` で失敗する | 同時に走れる run(既定 4)か feedback(既定 4)の上限。しばらく待って送り直す。上限は overlay の `--max-concurrent-runs` |
| 400 / 413 で失敗する | JSON-RPC のバッチ(配列)は受け付けない(400)。本文は 64 KiB まで(413)。質問は 4,000 字まで(`--max-question-chars`) |
| UI の LLM が ask を呼ばない | ツール呼び出しに対応していないモデル。対応モデルに替え、MCP サーバー Leisen が選ばれているか確かめる |
| LM Studio に届かない | orchestrator から確かめる: `docker compose exec orchestrator node -e "fetch(process.env.LEISEN_LLM_BASE_URL+'/models').then(r=>console.log(r.status),e=>console.log(e.cause?.code))"`。Linux はローカルネットワークでの待ち受けが要る([1.1](#11-前提)) |
| orchestrator が起動しない | `docker compose logs orchestrator`。Slack のソースが有効([1.4](#14-履歴の保持と不変条件7))、`LEISEN_LLM_MODEL` の未設定、引数の誤りは起動ログに固定文言で出る。`NODE_ENV=production` では `LEISEN_ORCHESTRATOR_CREDENTIAL` と https の上流が必須(評価用構成の overlay は development) |
| `ask` が `run_not_accepted` / `orchestrator_credential_rejected` で失敗する | Gateway が run の開始を拒否した。`LEISEN_ORCHESTRATOR_CREDENTIAL` が gateway と orchestrator で同じ値か(`.env` を変えたら両方を作り直す)、Gateway の起動ログの `run api:` 行を確かめる。`invalid_run_id` が Gateway の監査に続くなら、Gateway の署名鍵(`LEISEN_RUN_ID_KEY`)を run の途中で変えた・再起動で一時鍵が替わった(未設定時の WARNING)可能性がある |
| `feedback` が「受け付けられなかった」で失敗する | 質問した本人以外の runId、または回答から 7 日を過ぎた runId(`gateway.runs.feedbackWindowSec`)。runId は `ask` の結果のものをそのまま使う |
| LibreChat が起動しない | `docker compose logs librechat`。`librechat.yaml` が不正だと `Invalid custom config file` を出して終了する(MCP サーバーの `title` は英数字と空白だけ)。正常なら設定の読み込み・`OpenID Connect configured successfully`・待ち受けの順にログが出る |
| MongoDB が起動直後に落ちる | CPU が MongoDB 8 の要件(x86-64 は AVX)を満たさない。LibreChat の Docker 手順の注意に従い、override で古い版のイメージに替える |

### 1.7 run の記録(AnswerRun)と昇格判定レポート

orchestrator は監査ストアに書かない(ADR-019)。`ask` の run は、開始時に Gateway の run API(`POST /runs`)で
署名付きの runId を受け取り、Gateway がその時点で AnswerRun(pending)を `leisen-audit` の `audit.jsonl` に書く。
以降の `tools/call` はこの runId を申告し、終了時の `finish`、`feedback` ツールの `feedback` も同じ runId で
Gateway に申告する。Gateway は runId の署名で発行元・本人・期限を確かめてから部分レコード
(`answer_run_finish` / `answer_run_feedback`)を追記する。orchestrator のコンテナは監査ボリュームを一切マウント
しないため、Orchestrator から Gateway の監査ログは読めず、書き換えられない(threat-model TM-I4)。

run API を呼べるのは、利用者本人のトークンに加えて Orchestrator の資格情報(`LEISEN_ORCHESTRATOR_CREDENTIAL`。
`.env` で gateway と orchestrator に同じ値)を持つプロセスだけ。LibreChat にはこの値を渡さない。

昇格判定レポート(docs/install.md §7、docs/playbook.md「有効化判定」)は Gateway の監査ボリュームだけを読む
(`--audit` は 1 つ)。コマンドは docs/install.md §7 のとおりで、LibreChat overlay でも変わらない。ADR-019 より
前の overlay(AnswerRun を `kp-answer-runs` の `answer-runs.jsonl` に書いていた版)を動かした期間を含めるときだけ、
そのボリュームを読み取り専用で見せて `--audit` を足す(手順は docs/install.md §7)。

## 2. MCP クライアントの場合

Claude Code・MCP Inspector・自作エージェントなども同じ規約で接続する(ADR-018 決定9)。

- エンドポイント: `http://127.0.0.1:8790/mcp`(Streamable HTTP、ステートレス、応答は単発 JSON)。
  死活確認は `GET /healthz`(認証不要)
- 全リクエスト(`initialize` / `tools/list` を含む)に `Authorization: Bearer <Keycloak が利用者に発行した
  アクセストークン>` が要る。欠落・無効は 401、Gateway・IdP に届かなければ 503
- 開発用のトークンは `scripts/smoke/keycloak-token.sh`(パスワードグラント、開発・CI 専用のクライアント
  `e2e-cli`。有効期間 5 分)で取る。本番の利用者のトークンは IdP のログイン(認可コードフロー)で得る
- `ask` は LLM(LM Studio 等)を使う。LLM が動いていないと回答はエラーになる
- **どのクライアントのトークンを受けるか**(issue #16、ADR-018 追記): Gateway はトークンの発行先クライアント
  (`azp`)が deployment.yaml の `idp.adapter.allowedClients` にあるものだけを受ける。本番では、自作の MCP
  クライアントを含め、使うクライアントを realm に登録して(`requireAudience: true` なら Gateway を audience に
  加えるマッパーも付けて)このリストに足す(issue #21 の B)。リファレンス構成は `e2e-cli`(開発・CI 用)と
  `librechat`。開発では `allowedClients: ["*"]` が明示の逃げ道(`azp` の検証だけを省く。起動ログに WARNING、
  `NODE_ENV=production` では起動拒否)。トークンが 401 になる原因の切り分けは
  `leisen-gateway auth-check --config <yaml> --token-env LEISEN_SESSION_TOKEN`

curl で試す(トークンは環境変数に入れ、コマンドライン引数に載せない。`@<(…)` はヘッダをファイル
記述子で渡す bash の書き方):

```bash
export LEISEN_SESSION_TOKEN="$(scripts/smoke/keycloak-token.sh)"   # 表示しない。5 分で失効する
leisen_mcp() {
  curl -s http://127.0.0.1:8790/mcp \
    -H @<(printf 'Authorization: Bearer %s\n' "$LEISEN_SESSION_TOKEN") \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-11-25' \
    -d "$1"
}
leisen_mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
leisen_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
leisen_mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask","arguments":{"question":"VPN の接続手順を教えて"}}}'
leisen_mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"feedback","arguments":{"runId":"<ask の結果の runId>","outcome":"resolved"}}}'
```

- `initialize` の結果の `instructions`(出典の扱いなど)を、クライアント側の LLM にも渡す
- `ask` の結果の text は Markdown(本文 + 「出典」節 + `runId`)。`structuredContent` に Answer(`runId`・
  `outcome`・`citations`・`warnings` など)が入る。出典はそのまま提示する
- MCP Inspector(CLI、**未検証**): `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8790/mcp
  --transport http --header "Authorization: Bearer $LEISEN_SESSION_TOKEN" --method tools/list`
- Claude Code(**未検証**): `claude mcp add --transport http leisen http://127.0.0.1:8790/mcp
  --header "Authorization: Bearer $LEISEN_SESSION_TOKEN"`。ヘッダの値(トークン)は Claude Code の設定
  ファイルに平文で保存される。開発用のトークンは 5 分で失効するため、失効したら `claude mcp remove leisen`
  して登録し直す(開発・評価用途に限る)
- 注意: トークンは環境変数で渡し、ログ・シェルの履歴・チケット等に残さない。共有の端末で使わない

## 3. それ以外の場合

次の接続方法はサポート外(理由は ADR-018「却下した案」)。必要になったら別の ADR で扱う。

- Orchestrator を OpenAI 互換のチャットモデルとして公開し、UI が申告する利用者 ID のヘッダ
  (`X-OpenWebUI-User-*`、`{{LIBRECHAT_USER_*}}` など)を信頼する: 本人のトークンではなく UI の主張に
  認可を乗せることになり、UI の侵害が全利用者の権限に直結する
- UI から Gateway に直接 MCP で接続する(Orchestrator を通さない): 出典の検証・本文の URL 除去・
  run の記録(AnswerRun)が抜ける(Gateway の run API は Orchestrator の資格情報を要求するため、UI からは
  呼べない)
- Orchestrator に IdP の検証を複製する: 検証ロジックと信頼境界が分かれる(Gateway に run の口を作る案は
  ADR-019 で run API として採った)

## 未実装・制約

- LibreChat の 👍👎 と `feedback` の自動連携はない(v1 は会話で `feedback` ツールを呼ぶ。T-021 残課題)
- 進捗のストリーミング(MCP の progress 通知)はない。`ask` は回答が出るまで応答しない
  (`librechat.yaml` の `timeout: 300000` = 5 分)
- 出典の保証はツール境界まで。UI 側の LLM が出典を落とす・言い換える可能性は残る(評価ハーネス T-008 で
  UI 経由でも出典が保たれるかを測る。T-021 残課題)
- LibreChat v0.8.7 では通常の会話と一時チャットの保持期限を分けられない([1.4](#14-履歴の保持と不変条件7))。
  利用者本人による会話のエクスポート(LibreChat の機能)は止めていない
- Keycloak の TLS 終端(keycloak-tls)とローカル CA は評価用。実運用の IdP は導入先の TLS 構成で公開する
- Gateway は aud / azp をまだ検証しない(セキュリティレビュー R1)。realm 側の audience マッパーは準備だけ
- この overlay の起動は CI の `reference-deploy` ジョブが確かめる(イメージのビルド、orchestrator の
  認証の配線、LibreChat の healthy と OpenID ログインの開始まで)。ブラウザでのログインから ask・feedback
  までの通しは、LM Studio のある手元で人が確かめる(本書の作成時は Docker デーモンのない環境で、
  `docker compose config`・LibreChat v0.8.7 の設定スキーマでの `librechat.yaml` の検証・TLS 終端の
  再現(Caddy のローカル CA と openid-client での https のディスカバリ)と、イメージと同じファイル構成で
  overlay と同じ引数(`--confirm-exposed-host`・`--allow-insecure-upstream` を含む)で動かした leisen-ask serve と
  Gateway(モック IdP)に対する `orchestrator-smoke.sh`、[2](#2-mcp-クライアントの場合) の curl の手順
  (LLM はモック)までを確認した)
- ADR-019(T-023、2026-10-11)の反映(orchestrator から AnswerRun のボリュームと `LEISEN_AUDIT_HMAC_KEY` を外し、
  `LEISEN_ORCHESTRATOR_CREDENTIAL` を足す。`feedback` は Gateway の run API へ)は、`packages/gateway/test/reference-deploy.test.ts`
  と Orchestrator の結線テスト(`packages/orchestrator/test/`、実 Gateway を起動する)で確かめた。コンテナでの
  起動とスモークは CI の `reference-deploy`
- セキュリティレビューの反映(2026-09-28: MCP の接続先の制限・エージェントの機能の制限・AnswerRun の
  ボリューム分離・MongoDB の内部ネットワーク・realm のリダイレクト先の完全一致と PKCE)は、Docker デーモンの
  ない環境で `docker compose config`、LibreChat v0.8.7 の設定スキーマでの `librechat.yaml` の検証、v0.8.7 の
  MCP の接続先判定(`packages/api/src/auth/domain.ts`)をそのまま動かした照合までを確認した。コンテナでの
  起動とスモークは CI の `reference-deploy` で確かめる。PKCE を必須にした realm でのブラウザのログインは
  手元で人が確かめる(スモークは LibreChat のリダイレクトまでで、Keycloak の画面には進まない)
