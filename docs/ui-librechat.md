# UI から使う(LibreChat / MCP クライアント)

Status: v0(T-021)/ Date: 2026-09-28

利用者がチャット UI や MCP クライアントから社内ナレッジに問い合わせるための接続手順。設計の正は
[ADR-018](adr/ADR-018-orchestrator-mcp-server-and-chat-ui.md)(Proposed)、リファレンスデプロイ全体の
手順・前提・公開時の必須条件は [docs/install.md](install.md) を参照。本書は次の 3 区分だけを示す。

- [1. LibreChat の場合](#1-librechat-の場合)(リファレンス構成の overlay で動かす)
- [2. MCP クライアントの場合](#2-mcp-クライアントの場合)(Claude Code、MCP Inspector、自作エージェントなど)
- [3. それ以外の場合](#3-それ以外の場合)(サポート外)

## 0. 位置づけ

- **Orchestrator を MCP サーバーとして公開する**(ADR-018 決定1)。`kp-ask serve` が Streamable HTTP
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
  できないソース(Slack、kind が `slack` / `slack-*`)が有効なら `kp-ask serve` は起動を拒否する
  (解除の条件は [1.4](#14-履歴の保持と不変条件7))
- AnswerRun は Orchestrator が Gateway と同じ監査ボリュームの別ファイル(`answer-runs.jsonl`)に追記する
  (決定4)。昇格判定レポートは `--audit` を 2 回指定して両方を読む(docs/install.md §7)
- リファレンス構成は**評価用**(開発用の部品・ローカル専用のダミー秘密・開発モードの Keycloak)。
  限界は docs/install.md §0 と同じ

```
ブラウザ ─(OpenID ログイン)→ keycloak-tls(https://keycloak.localhost:8443)→ Keycloak
   │
LibreChat(http://localhost:3080)… UI 側の LLM(LM Studio)が ask / feedback を呼ぶ
   │  MCP(Streamable HTTP)  Authorization: Bearer <利用者本人のアクセストークン>
Orchestrator(kp-ask serve、:8790)… 探索ループの LLM(LM Studio)
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
| `orchestrator` | `kp-ask serve`。gateway と同じイメージを別エントリポイントで動かす。`127.0.0.1:8790` |
| `librechat` | LibreChat v0.8.7(安定版に固定)。`127.0.0.1:3080` |
| `mongodb` | LibreChat の保存先(会話履歴・利用者)。ホストへは公開しない |
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
cp .env.example .env                                         # KP_LLM_MODEL を LM Studio のモデル名にする
cp librechat/librechat.env.example librechat/librechat.env   # ローカル評価専用のダミー値
docker compose -f docker-compose.yml -f docker-compose.librechat.yml up -d --build --wait
```

- `.env` の `KP_LLM_MODEL` は LM Studio でロードしたモデル名(`curl http://localhost:1234/v1/models` の
  `id`)。`KP_LLM_BASE_URL` の既定はホストの LM Studio
- `-f` を毎回書かない場合は `.env` に `COMPOSE_FILE=docker-compose.yml:docker-compose.librechat.yml` を
  足す(Windows は `;` 区切り)
- 起動の確認(CI の `reference-deploy` ジョブと同じスモーク。トークン・応答本文は出力しない):

  ```bash
  KP_SESSION_TOKEN="$(../../scripts/smoke/keycloak-token.sh)" ../../scripts/smoke/orchestrator-smoke.sh
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
   realm `e2e/keycloak/realm/kp-realm.json` のダミー値)。初回ログインで LibreChat の利用者が作られる
4. エンドポイント「LM Studio」とモデル(ツール呼び出しに対応したもの)を選ぶ
5. 入力欄の下の MCP サーバーの選択から **Leisen** を選ぶ。起動時には接続しない設定(`startup: false`)の
   ため、初回の選択で接続を初期化する。エージェントで使う場合は、エージェントビルダーの
   ツールの追加 → MCP から Leisen を選ぶ
6. 質問する(例: 「VPN の接続手順を教えて」。評価用構成の検索対象は開発用の合成コーパス
   `examples/fixtures/dev-corpus.yaml`)。UI 側の LLM が `ask` を呼び、Orchestrator が Gateway 経由で
   本人の権限で検索して回答する。回答には「出典」節(`[n] タイトル(sourceId:documentId)— url`)と
   `runId` が付く。本文の URL は除去済みで、原典へのリンクは出典欄だけが運ぶ(ADR-018 決定6)
7. フィードバック: 回答で解決したかどうかを会話で伝える(例: 「今の回答で解決した。feedback して」)。
   UI 側の LLM が `feedback({ runId, outcome: "resolved" | "unresolved" })` を呼び、AnswerRun に記録される。
   記録できるのは質問した本人の run だけ。LibreChat の 👍👎 とは連携しない(未実装)
8. ユーザーを切り替えるときはログアウトする(Keycloak のセッションも終わる。`OPENID_USE_END_SESSION_ENDPOINT`)

停止は `docker compose -f docker-compose.yml -f docker-compose.librechat.yml down`。`down -v` は会話履歴
(MongoDB)・監査ログ・ローカル CA のボリュームも消す(評価以外では監査ログの削除は ADR-013 §3 に従う)。

### 1.3 keycloak.localhost と証明書

- **Keycloak を https で見せる理由**: LibreChat の OpenID クライアント(openid-client v6)は、発行者と
  各エンドポイント(認可・トークン・JWKS・userinfo・ログアウト)に https を要求し、http の発行者では
  ログインを構成できない(起動ログに `only requests to HTTPS are allowed`)。overlay は Keycloak
  (開発モード、http)の前段に TLS 終端 `keycloak-tls`(Caddy)を置き、発行者を
  `https://keycloak.localhost:8443/realms/kp` に固定する(`KC_HOSTNAME`)。証明書は Caddy の内部 CA
  (ローカル CA)が発行し、LibreChat はそのルート証明書だけを追加で信頼する(`NODE_EXTRA_CA_CERTS`。
  `keycloak-tls.sh` が秘密鍵を含めずに書き出す)
- **keycloak.localhost という名前の理由**: ブラウザ(ログイン画面へのリダイレクト)とコンテナ(LibreChat の
  ディスカバリ・トークン交換)が同じ発行者 URL を使う必要がある。`*.localhost` は Chrome / Firefox が
  ループバックに解決し、compose 内はネットワークエイリアスで `keycloak-tls` に解決する
- **名前が解決できない環境**(Safari など): hosts に `127.0.0.1 keycloak.localhost` を足す
  (macOS / Linux は `/etc/hosts`、Windows は `C:\Windows\System32\drivers\etc\hosts`)
- **証明書の警告**: ローカル CA はブラウザに信頼されていないため、初回に警告が出る。評価では続行してよい
  (Chrome は「詳細設定」→「keycloak.localhost にアクセスする(安全ではありません)」、Firefox は
  「詳細情報」→「危険性を承知で続行」)。警告を消したい場合は、ルート証明書を取り出して信頼ストアに入れる:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.librechat.yml cp keycloak-tls:/ca/root.crt ./kp-dev-root.crt
  ```

  | 環境 | 信頼する | 評価後に削除する |
  |---|---|---|
  | macOS(Safari / Chrome) | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain kp-dev-root.crt` | キーチェーンアクセスの「システム」から `Caddy Local Authority - <年> ECC Root` を削除 |
  | Windows(Edge / Chrome) | `certutil -user -addstore Root kp-dev-root.crt` | `certmgr.msc` の「信頼されたルート証明機関」から同じ名前の証明書を削除 |
  | Firefox(OS によらず) | 設定 → プライバシーとセキュリティ → 証明書を表示 → 認証局証明書 → インポート(ウェブサイトの識別を信頼する) | 同じ画面で削除 |
  | Linux の Chrome | 設定 → プライバシーとセキュリティ → セキュリティ → 証明書の管理 → 認証局 → インポート | 同じ画面で削除 |

  この CA の秘密鍵はボリューム `kp-caddy-data` にある。**評価が終わったら信頼ストアから必ず削除する**
  (ボリュームを読める人が、ブラウザに信頼される任意の名前の証明書を作れるため)。`down -v` で CA も
  作り直しになる(次回は新しいルート証明書を入れ直す)
- Gateway のイントロスペクションは従来どおりネットワーク内の `http://keycloak:8080` を直接呼び、
  スモーク用のトークン取得(`scripts/smoke/keycloak-token.sh`)も `http://localhost:8080` を使う。
  どちらのトークンも発行者は `https://keycloak.localhost:8443/realms/kp`(`KC_HOSTNAME` で固定)
- realm のクライアント `librechat` はアクセストークンの有効期間を 15 分にしている(realm 全体は 5 分)。
  ask は数十秒〜数分かかるため、5 分では送信直後に失効して 401 になりやすい。Gateway は毎回
  イントロスペクションで確かめるため、ログアウト・利用者の無効化は有効期間によらず反映される
- このクライアントには Gateway を audience に加えるマッパーを入れてある(Gateway が aud / azp の検証を
  入れたときのため。ADR-018 決定8)

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
  サーバーにこのプレースホルダを書かない。LibreChat の MCP 接続は SSRF 防御で私設アドレスを拒否するため、
  例外は `mcpSettings.allowedAddresses` の `orchestrator:8790` だけにしている
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
  16 進列)。評価以外では `JWT_SECRET` / `JWT_REFRESH_SECRET` / `CREDS_KEY` / `CREDS_IV` /
  `OPENID_SESSION_SECRET` と Keycloak のクライアント secret を新しく生成し、秘密ストアから注入する
- **ログ**: LibreChat の `DEBUG_OPENID_REQUESTS` は有効にしない(トークン交換の本文がログに出る)。
  `DEBUG_LOGGING` を調査で有効にしたら、終わったら戻してログを消す
- 利用者が自分で MCP サーバーを追加する機能(LibreChat の既定で有効)を止めるなら
  `librechat.yaml` の `interface.mcpServers.create: false`
- 最終文面を書くのは UI 側の LLM。出典の保証はツール境界まで(`instructions` とツール定義で「出典は
  改変せずに提示する」と指示している)。LibreChat の Markdown 描画が本文中の裸のドメイン名を自動リンク
  する可能性は残余リスク(threat-model RS-4)

### 1.6 トラブルシュート

以下の `docker compose` は `deploy/compose` で、`-f docker-compose.yml -f docker-compose.librechat.yml` を付けて
(または [1.2](#12-5-分手順) の `COMPOSE_FILE` を設定して)実行する。

| 症状 | 原因と対処 |
|---|---|
| ツールの呼び出しが 401 で失敗する | 転送したトークンの失効(クライアント `librechat` は 15 分)か、LibreChat のセッション切れ。ログアウトして再ログインし、質問を送り直す。`OPENID_REUSE_TOKENS=true` でないとトークンが転送されない |
| ツールの呼び出しが 503 で失敗する | Orchestrator から Gateway(または Gateway から Keycloak)に届かない。`docker compose ps` で gateway / keycloak が healthy か確かめる |
| ログインボタンがない・ログイン開始が 500 になる | LibreChat が起動時に OpenID のディスカバリに失敗した(ディスカバリは起動時に1回だけ)。`docker compose logs librechat` の `[openidStrategy]` を見る。多い原因は keycloak-tls の証明書を信頼できない(`NODE_EXTRA_CA_CERTS`)・http の発行者・`OPENID_ISSUER` の誤記。直したら `docker compose restart librechat` |
| ブラウザで keycloak.localhost が開けない | 名前が解決できない → hosts に `127.0.0.1 keycloak.localhost`。証明書の警告 → [1.3](#13-keycloaklocalhost-と証明書) |
| ログイン後に invalid issuer 等で失敗する | 発行者の不一致。`librechat.env` の `OPENID_ISSUER` は overlay の `KC_HOSTNAME` + `/realms/kp` と同じにする(`packages/gateway/test/reference-deploy.test.ts` が整合を検査する) |
| Leisen が選べない・接続できない | `docker compose logs orchestrator` と LibreChat のログの `[MCP][leisen]` を見る。`librechat.yaml` の `url` と `mcpSettings.allowedAddresses` が orchestrator の待ち受けと一致しているか |
| UI の LLM が ask を呼ばない | ツール呼び出しに対応していないモデル。対応モデルに替え、MCP サーバー Leisen が選ばれているか確かめる |
| LM Studio に届かない | orchestrator から確かめる: `docker compose exec orchestrator node -e "fetch(process.env.KP_LLM_BASE_URL+'/models').then(r=>console.log(r.status),e=>console.log(e.cause?.code))"`。Linux はローカルネットワークでの待ち受けが要る([1.1](#11-前提)) |
| orchestrator が起動しない | `docker compose logs orchestrator`。Slack のソースが有効([1.4](#14-履歴の保持と不変条件7))、`KP_AUDIT_HMAC_KEY` / `KP_LLM_MODEL` の未設定、引数の誤りは起動ログに固定文言で出る |
| LibreChat が起動しない | `docker compose logs librechat`。`librechat.yaml` が不正だと `Invalid custom config file` を出して終了する(MCP サーバーの `title` は英数字と空白だけ)。正常なら設定の読み込み・`OpenID Connect configured successfully`・待ち受けの順にログが出る |
| MongoDB が起動直後に落ちる | CPU が MongoDB 8 の要件(x86-64 は AVX)を満たさない。LibreChat の Docker 手順の注意に従い、override で古い版のイメージに替える |

## 2. MCP クライアントの場合

Claude Code・MCP Inspector・自作エージェントなども同じ規約で接続する(ADR-018 決定9)。

- エンドポイント: `http://127.0.0.1:8790/mcp`(Streamable HTTP、ステートレス、応答は単発 JSON)。
  死活確認は `GET /healthz`(認証不要)
- 全リクエスト(`initialize` / `tools/list` を含む)に `Authorization: Bearer <Keycloak が利用者に発行した
  アクセストークン>` が要る。欠落・無効は 401、Gateway・IdP に届かなければ 503
- 開発用のトークンは `scripts/smoke/keycloak-token.sh`(パスワードグラント、開発・CI 専用のクライアント
  `e2e-cli`。有効期間 5 分)で取る。本番の利用者のトークンは IdP のログイン(認可コードフロー)で得る
- `ask` は LLM(LM Studio 等)を使う。LLM が動いていないと回答はエラーになる

curl で試す(トークンは環境変数に入れ、コマンドライン引数に載せない。`@<(…)` はヘッダをファイル
記述子で渡す bash の書き方):

```bash
export KP_SESSION_TOKEN="$(scripts/smoke/keycloak-token.sh)"   # 表示しない。5 分で失効する
kp_mcp() {
  curl -s http://127.0.0.1:8790/mcp \
    -H @<(printf 'Authorization: Bearer %s\n' "$KP_SESSION_TOKEN") \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-11-25' \
    -d "$1"
}
kp_mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
kp_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
kp_mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask","arguments":{"question":"VPN の接続手順を教えて"}}}'
kp_mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"feedback","arguments":{"runId":"<ask の結果の runId>","outcome":"resolved"}}}'
```

- `initialize` の結果の `instructions`(出典の扱いなど)を、クライアント側の LLM にも渡す
- `ask` の結果の text は Markdown(本文 + 「出典」節 + `runId`)。`structuredContent` に Answer(`runId`・
  `outcome`・`citations`・`warnings` など)が入る。出典はそのまま提示する
- MCP Inspector(CLI、**未検証**): `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8790/mcp
  --transport http --header "Authorization: Bearer $KP_SESSION_TOKEN" --method tools/list`
- Claude Code(**未検証**): `claude mcp add --transport http leisen http://127.0.0.1:8790/mcp
  --header "Authorization: Bearer $KP_SESSION_TOKEN"`。ヘッダの値(トークン)は Claude Code の設定
  ファイルに平文で保存される。開発用のトークンは 5 分で失効するため、失効したら `claude mcp remove leisen`
  して登録し直す(開発・評価用途に限る)
- 注意: トークンは環境変数で渡し、ログ・シェルの履歴・チケット等に残さない。共有の端末で使わない

## 3. それ以外の場合

次の接続方法はサポート外(理由は ADR-018「却下した案」)。必要になったら別の ADR で扱う。

- Orchestrator を OpenAI 互換のチャットモデルとして公開し、UI が申告する利用者 ID のヘッダ
  (`X-OpenWebUI-User-*`、`{{LIBRECHAT_USER_*}}` など)を信頼する: 本人のトークンではなく UI の主張に
  認可を乗せることになり、UI の侵害が全利用者の権限に直結する
- UI から Gateway に直接 MCP で接続する(Orchestrator を通さない): 出典の検証・本文の URL 除去・
  AnswerRun の記録が抜ける
- Orchestrator に IdP の検証を複製する、Gateway に run 登録の口を作る: 検証ロジックと信頼境界が分かれる

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
  overlay と同じ引数(`--confirm-exposed-host`・`--allow-insecure-upstream` を含む)で動かした kp-ask serve と
  Gateway(モック IdP)に対する `orchestrator-smoke.sh`、[2](#2-mcp-クライアントの場合) の curl の手順
  (LLM はモック)までを確認した)
