# 導入手順(リファレンスデプロイ)

Status: v0(T-012。T-021 の LibreChat overlay を追記)/ Date: 2026-09-28

Gateway を Docker Compose で起動するリファレンスデプロイの手順と、導入時に確認すべき事項をまとめる。
導入工程全体(アセスメント → PoC → 全社展開 → 検索層有効化判定)は [docs/playbook.md](playbook.md)、
設定スキーマの正は `packages/gateway/src/config/schema.ts`、設計判断は ADR-005 / ADR-010 / ADR-011 / ADR-013 を参照。

構成ファイル:

| パス | 内容 |
|---|---|
| `deploy/Dockerfile` | Gateway のイメージ(multi-stage、非 root、`kp-gateway serve`)。Orchestrator(`kp-ask serve`)と昇格判定レポートも含む |
| `deploy/compose/docker-compose.yml` | gateway + keycloak。検索バックエンドは profile `search-backend` の枠のみ |
| `deploy/compose/docker-compose.librechat.yml` | LibreChat overlay(T-021): orchestrator + librechat + mongodb + keycloak-tls(Keycloak の TLS 終端)。`-f` で重ねる([docs/ui-librechat.md](ui-librechat.md)) |
| `deploy/compose/librechat/` | overlay の設定(`librechat.yaml`、`librechat.env.example`、TLS 終端の `Caddyfile` / `keycloak-tls.sh`) |
| `deploy/compose/deployment.yaml` | リファレンス設定(コンテナの `/etc/kp/deployment.yaml`) |
| `deploy/compose/.env.example` | 環境変数の雛形(ローカル評価専用のダミー値) |
| `scripts/smoke/gateway-smoke.sh` | スモークテスト(CI とローカルで共用) |
| `scripts/smoke/orchestrator-smoke.sh` / `librechat-smoke.sh` | LibreChat overlay のスモークテスト(CI とローカルで共用) |
| `scripts/smoke/keycloak-token.sh` | 開発・CI 専用のトークン取得(パスワードグラント) |

## 0. この構成の位置づけ(最初に読む)

- **評価用構成である。** 開発用の部品(`kind: dev-fixture` の合成コーパス、`auth.provider: mock_env` の
  モック資格情報)を使うため、compose は `NODE_ENV=development` で起動する(`NODE_ENV=production` では
  `dev_only_in_production` で起動を拒否される)。**本番で使える本人資格情報の取得方式
  (`connectors[].auth.provider`)は T-004 で追加する。** それまでは実ソースを本人権限でつなぐ本番構成は組めない
- Keycloak は `e2e/keycloak` の realm(ローカル専用のダミー秘密)を流用する開発モード(`start-dev`、
  データは永続化しない)。本番の IdP ではない
- 実SaaSの認可経路は検証しない(ADR-010。`e2e/keycloak/README.md` と同じ限界)
- **起動確認の自動化(T-012 受け入れ条件1)は CI の `reference-deploy` ジョブが担い、PR #14(2026-09-27)で
  実行を確認した**(イメージのビルド → compose 起動 → Keycloak 発行トークンでのスモークまで成功)。本構成は
  Docker デーモンのない環境で作成した。作成時に確認したのは `docker compose config` による静的検証、Dockerfile の
  2ステージと同じファイル集合・同じ npm コマンドのコンテナ外での再現と、その成果物での起動・HEALTHCHECK・
  スモーク(Keycloak は代役のサーバー)、§6.3 の nginx 設定例の構文と挙動まで。手元の Docker での起動は未確認
- 同じジョブで LibreChat overlay(T-021)も重ねて起動し、orchestrator の認証の配線(トークンなし・不正なトークンは
  401、Keycloak のトークンで `tools/list` が通る)と LibreChat の起動(`/health` と OpenID ログインの開始)を
  確かめる。LLM はランナーにないため `ask` は CI では呼ばない([docs/ui-librechat.md](ui-librechat.md))

## 1. 前提

- Docker Engine 23 以降(BuildKit が既定。Dockerfile はキャッシュマウントを使う)と Docker Compose v2
  (`docker compose up --wait` が使えること)
- ホストの `127.0.0.1:8787`(Gateway)と `127.0.0.1:8080`(Keycloak)が空いていること
- スモーク用に `curl` と Node.js(22 を推奨。スクリプトは JSON の解析にだけ使う)
- LibreChat overlay を使う場合は、加えて `127.0.0.1` の 3080 / 8443 / 8790 が空いていることと、LLM
  (LM Studio 等の OpenAI 互換 API)が要る([docs/ui-librechat.md](ui-librechat.md) §1.1)
- コンテナを使わずに動かす場合は Node 22 と npm(§3)

## 2. 5分手順(Docker Compose)

```bash
cd deploy/compose
cp .env.example .env                  # ローカル評価専用のダミー値(dev-only-)
docker compose up -d --build --wait   # イメージをビルドし、keycloak(realm の import 完了)→ gateway の順に起動
KP_SESSION_TOKEN="$(../../scripts/smoke/keycloak-token.sh)" ../../scripts/smoke/gateway-smoke.sh
```

スモークは次を確かめ、失敗すると非0で終わる(トークンの値・検索結果の中身は出力しない):

```
[1/5] GET /healthz: ok
[2/5] initialize: ok (server kp-gateway 0.1.0, protocolVersion 2025-11-25)
[3/5] tools/list: ok (tools: describe, fetch, list, search; search sources: dev-docs)
[4/5] tools/call search: ok (2 hit(s) for the smoke query on dev-docs)
[5/5] requests without a valid token: ok (401)
gateway-smoke: all checks passed
```

- MCP クライアント(curl / MCP Inspector / Claude Code)からの接続手順は README「手元で動かす」と同じで、
  `Authorization: Bearer` に `keycloak-token.sh` で得たトークンを使う。トークンの有効期間は realm の
  設定で 5 分(`accessTokenLifespan: 300`)なので、切れたら取り直す
- ユーザー `bob` で試すときは `KP_SMOKE_USERNAME=bob KP_SMOKE_PASSWORD=dev-only-bob-password`
- 停止は `docker compose down`(監査ボリュームは残る)。`down -v` は監査ログのボリュームも消す。
  評価以外の環境では、監査ログの削除は保持期間の規程(ADR-013 §3)に従う

### 2.1 UI(LibreChat)・MCP クライアントから問い合わせる

利用者が自然言語で問い合わせる面は、Orchestrator を MCP サーバーとして公開し(`kp-ask serve`)、汎用の
チャット UI や MCP クライアントからつなぐ(ADR-018)。リファレンス構成では LibreChat の overlay を重ねる:

```bash
cp librechat/librechat.env.example librechat/librechat.env   # deploy/compose で。.env の KP_LLM_MODEL も合わせる
# ↑ 手元では LibreChat のセッション・暗号化の鍵を生成して置き換える(docs/ui-librechat.md §1.2)
docker compose -f docker-compose.yml -f docker-compose.librechat.yml up -d --build --wait
# → http://localhost:3080(Keycloak の alice / bob でログイン)
```

`librechat.env.example` の `JWT_SECRET` 等は公開されたダミーで、雛形のままだと `127.0.0.1:3080` に届く人が
LibreChat のセッションを偽造できる。手順・前提(LM Studio、鍵の生成、`keycloak.localhost` と証明書)・
履歴の保持と不変条件7・MCP クライアント(Claude Code 等)からの接続・トラブルシュートは
[docs/ui-librechat.md](ui-librechat.md)。

## 3. コンテナを使わない同等手順(Node 22)

イメージと同じビルド成果物をそのまま動かす。README「手元で動かす(5分)」と同じ(モック IdP)。

```bash
npm ci && npm run build
KP_MOCK_SESSIONS=dev-token=alice KP_MOCK_TOKEN_DEV_DOCS=dev-only-token \
  node packages/gateway/dist/bin/kp-gateway.js serve --config examples/deployment.dev.yaml
# 別の端末で
KP_SESSION_TOKEN=dev-token scripts/smoke/gateway-smoke.sh
```

イメージとの違いは IdP(モック)と監査の出力先(`audit.sink: stdout`)だけで、起動コード
(`kp-gateway serve`、停止時の SIGTERM 処理)は同じ。Keycloak を使う場合は `e2e/keycloak` の compose で
Keycloak だけを起動し、`deploy/compose/deployment.yaml` をもとにパス(`/etc/kp/…`、`/var/lib/kp/…`)と
`baseUrl`(`http://localhost:8080`)を手元の値に直した設定を使う。

## 4. deployment.yaml の注入と事前検証

- イメージは `/etc/kp/deployment.yaml`(環境変数 `KP_DEPLOYMENT_CONFIG` の既定値)を読む。compose は
  `deploy/compose/deployment.yaml` をそこへ読み取り専用でマウントする。導入1件=このファイル1枚(ADR-005)
- ファイル内のパスはコンテナ内のパス。相対パスは設定ファイルの所在ディレクトリ(`/etc/kp`)基準で解決される
- 変更は反映前に検証する。`validate` は設定の読み込みから Gateway の組み立てまでを行い(待ち受けない・
  ファイルを作らない)、不備を全件列挙して exit 1 で終わる:

  ```bash
  docker compose run --rm --no-deps gateway validate
  docker compose up -d --force-recreate gateway   # 反映(停止時は処理中のリクエストを待ち、監査を flush する)
  ```

  コンテナを使わない場合は `npx kp-gateway validate --config <deployment.yaml>`
- 設定からプラグイン(`connectors[].module`)を読み込めるため、deployment.yaml とプラグインの置き場所の
  書き込み権限は管理者に限る(T-010)
- `idp.adapter.allowedClients`(必須)は、トークンの発行先クライアント(`azp`)として受け入れるクライアント ID の
  許可リスト(issue #16)。利用者がログインする UI・MCP クライアントを IdP に登録して列挙する(リファレンス構成は
  `e2e-cli` と `librechat`)。`requireAudience: true` は `aud` に Gateway の `clientId` が含まれることを要求する
  (realm の両クライアントには audience マッパーがある)。`allowedIssuers` は、トークンの発行者(`iss`。Keycloak の
  `KC_HOSTNAME` で固定される公開 URL)がイントロスペクションに使う `baseUrl`(compose のサービス名)と異なる
  ため明示している。`allowedClients: ["*"]` は開発専用(WARNING、本番では `dev_only_in_production`)。トークンが
  401 になるときの切り分けは `docker compose run --rm --no-deps -e KP_SESSION_TOKEN gateway auth-check --token-env KP_SESSION_TOKEN`
  (項目ごとの pass / fail / skipped を表示。トークンは出力しない)

## 5. 秘密情報の渡し方

- **値は環境変数だけで渡す。** deployment.yaml には環境変数の「名前」だけを書く(`idp.adapter.clientSecretEnv`、
  `connectors[].settings` の `<name>Env`)。スキーマは秘密情報らしいキーを拒否する(不変条件6)
- compose は `deploy/compose/.env`(git 管理外。`.dockerignore` でイメージにも入らない)を変数展開に使い、
  各コンテナに必要な変数だけを渡す(gateway: `KP_KEYCLOAK_CLIENT_SECRET` / `KP_MOCK_TOKEN_DEV_DOCS` /
  `KP_RUN_ID_KEY` / `KP_ORCHESTRATOR_CREDENTIAL` / `KP_AUDIT_HMAC_KEY`、keycloak: `KC_BOOTSTRAP_ADMIN_PASSWORD`。
  LibreChat overlay の orchestrator: `KP_ORCHESTRATOR_CREDENTIAL` と LLM の接続先・モデル名)。未設定なら
  compose が起動前に止まる
- run API(ADR-019)の秘密は 3 つで、役割ごとに別の値にする(`deployment.yaml` の `gateway.runs.*Env` と
  `audit.docIdHmacKeyEnv` が環境変数名を決める。既定の名前が下のとおり):
  - `KP_RUN_ID_KEY`(runId の署名鍵。**Gateway だけが持つ**): 32 バイト以上の乱数を hex / base64 / base64url で。
    `NODE_ENV=production` では未設定・短い・`.env.example` の例の値を起動拒否にする。入れ替えは
    `KP_RUN_ID_KEY_PREVIOUS`(`gateway.runs.previousSigningKeyEnv`)に旧鍵を置いて新鍵で再起動し、runId の
    有効期間(`gateway.runs.ttlSec`、既定 15 分)とフィードバックの期間(`feedbackWindowSec`、既定 7 日)が
    過ぎたら旧鍵を外す。鍵を変えると(旧鍵を残さない限り)期限内の run の `finish` / `feedback` が
    `invalid_run_id` で拒否され、その run はレポートで「放棄」になる
  - `KP_ORCHESTRATOR_CREDENTIAL`(Orchestrator の資格情報。**gateway と orchestrator の両方に同じ値**): 16 文字
    以上。Gateway は run API(`/runs`)と、runId を申告する `tools/call` にこの値のヘッダ
    (`x-kp-orchestrator-credential`)を要求する。利用者本人の Bearer トークンの代わりではなく、追加の条件
    (本人が Orchestrator を通さずに run の結果を偽って申告できないようにする。threat-model TM-I5)。
    `NODE_ENV=production` では未設定・開発用の既定値(`.env.example` の値)を起動拒否にする。16 文字以上の
    空白を含まない印字可能な ASCII(HTTP ヘッダで運ぶ)。**UI(LibreChat)や利用者には渡さない**: 利用者が
    この値を持つと、Orchestrator を通さずに自分の run の結果・ToolInvocation を偽って昇格判定の集計を汚せる
    (他人の run には触れない)。`kp-ask` の 1 問モードを使う運用者・開発者だけに配る
  - `KP_AUDIT_HMAC_KEY`(引用 docId の HMAC 鍵。**Gateway だけが持つ**。`audit.privateScopeDocIds: hashed`):
    run API の `finish` がプライベートスコープを持つソースの引用を不可逆化するのに使う(ADR-019 決定5)。
    導入ごとに1回だけ乱数で生成して秘密ストアに保管し、以後は同じ値を使い続ける(変えると以前に記録した
    `hmac:…` と突き合わせられなくなる)。リファレンス構成の `dev-docs`(`privateScopes: excluded`)だけなら
    起動に要らないが、プライベートスコープを持つソースを有効にした時点で必須になる(`secret_env_missing`)。
    設定するなら 16 文字以上(`doc_id_hmac_key_invalid`)、本番では `dev-only-` で始まる値を拒否する

  3 つの秘密は互いに別の値にする(同じ値があれば `run_secret_reused` で起動拒否。使い回すと Orchestrator が
  署名鍵を持つのと同じになる)。

  `.env.example` の値はいずれも評価用のダミーなので置き換える。生成例:

  ```bash
  openssl rand -base64 32          # KP_RUN_ID_KEY / KP_ORCHESTRATOR_CREDENTIAL
  openssl rand -hex 32             # KP_AUDIT_HMAC_KEY
  # または Node だけで
  node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
  ```
- LibreChat overlay の LibreChat 固有の秘密(OpenID のクライアント secret、セッション・保存時暗号化の鍵)は
  `deploy/compose/librechat/librechat.env`(git 管理外。雛形は `librechat.env.example`)から librechat
  コンテナにだけ渡す
- `.env.example` の値は realm(`e2e/keycloak/realm/kp-realm.json`)と揃えたローカル専用のダミー。
  `KP_KEYCLOAK_CLIENT_SECRET` は realm のクライアント `gateway` の secret と一致させる必要がある
- 本番では秘密をオーケストレーターの秘密ストア(Docker secrets、Kubernetes Secret 等)から環境変数として
  注入し、イメージ・compose ファイル・リポジトリに置かない。Gateway はトークン・clientSecret・環境変数の
  値をログやエラーに出さない

## 6. ネットワーク公開と TLS 終端(リバースプロキシ前提)

### 6.1 コンテナ内の `0.0.0.0` と `confirmExposedHost`

- コンテナ内では `gateway.http.host: 0.0.0.0` で待ち受ける。コンテナ内のループバックで待ち受けると、
  ポート公開でホストから届かないため
- `gateway.http.host` がループバック以外のとき、起動コードは `gateway.http.confirmExposedHost: true` を
  要求する(なければ `http_host_exposed_requires_confirmation` で起動拒否。`kp-gateway validate` も同じ。
  `kp-gateway serve --host <addr>` で待ち受けアドレスを上書きした場合も、上書き後のアドレスに同じ検査をかける。
  確認は deployment.yaml でだけ行い、フラグでは解除できない)。
  **Gateway は TLS を終端せず、Host / Origin ヘッダの検証もしない**ため、ループバック以外で待ち受ける
  構成は「TLS 終端とそれらの防御を前段のリバースプロキシが担う」前提を明示的に受け入れる必要がある
  (T-003 レビュー minor-11)。リファレンス設定はこの前提で `true` にしている
- compose がホストへ公開するのは `127.0.0.1:8787` だけ。**外部への公開は必ずリバースプロキシ経由にし、
  compose の公開先を `0.0.0.0` に変えない。** 平文 HTTP で公開すると Bearer トークンと検索結果が
  ネットワークに流れる

### 6.2 ループバック以外へ公開する前の必須条件

HTTP 配線の再レビューで、次の3件を「ループバック以外へ公開する前の必須条件」とした。いずれも Gateway
(`packages/gateway/src/proxy/http.ts`)側は未実装のため、**現時点ではリバースプロキシ側の緩和を前提とする**
(Gateway 側で実装されたら本節を更新する)。

| 項目 | Gateway の現状 | リバースプロキシでの緩和(§6.3) |
|---|---|---|
| minor-6: MCP リクエスト単位の期限 | 同一 POST に `tools/call` と `notifications/cancelled` を同梱すると応答が返らず、接続が無期限に保持される(認証済み利用者のみ。監査は残る) | 上流の応答待ちの期限(`proxy_read_timeout`)。超えたら 504 で打ち切り、Gateway との接続も閉じる |
| minor-7: 拒否応答への `connection: close` | 401 / 404 / 405 / 5xx でも接続を閉じないため、未認証のクライアントがソケットを保持できる(最大 300 秒) | 本文を受け切ってから転送(`proxy_request_buffering on`)、送信の期限(`client_header_timeout` / `client_body_timeout`)、本文の上限、IP ごとの同時接続数(`limit_conn`)。Gateway への接続は応答ごとに閉じる |
| minor-11: 非ループバック公開の確認と Host / Origin 検証 | 確認フラグ(`confirmExposedHost`)は実装済み。Host / Origin の検証(DNS rebinding 対策)は未実装 | TLS 終端、Host の許可リスト(`server_name` と既定サーバーでの拒否)、Origin の許可リスト(`map`) |

MCP SDK 1.32.1(1.30.1 から変わらず)の `StreamableHTTPServerTransport` には `allowedHosts` / `allowedOrigins` /
`enableDnsRebindingProtection` があるが、いずれも非推奨(外部のミドルウェアでの検証が推奨)で、Gateway は
配線していない(§8)。

### 6.3 リバースプロキシの設定例(nginx)

ホスト上の nginx が TLS を終端し、`127.0.0.1:8787` の Gateway へ転送する例。ホスト名・証明書のパス・
各上限値は導入先に合わせる。nginx 1.24 で構文(`nginx -t`)と挙動(Origin 違反は 403、Host / SNI 違反は
接続拒否、minor-6 の要求は `proxy_read_timeout` で 504、送られない本文は `client_body_timeout` で
408 となり Gateway に届かない)を確認した。`ssl_reject_handshake` は nginx 1.19.4 以降。

```nginx
# /etc/nginx/conf.d/kp-gateway.conf(http コンテキストに読み込まれる前提)
# kp.example.test・証明書のパス・各上限値は導入先に合わせる。

# クライアント IP ごとの同時接続数(limit_conn)
limit_conn_zone $binary_remote_addr zone=kp_gateway_conn:10m;

# Origin の許可リスト(DNS rebinding 対策。minor-11)。
# Origin ヘッダのないリクエスト(ブラウザ以外の MCP クライアント)は通す
map $http_origin $kp_gateway_origin_ok {
    default                    0;
    ""                         1;
    "https://kp.example.test"  1;
}

upstream kp_gateway {
    # compose がホストのループバックに公開した Gateway。keepalive は設定しない
    # (Gateway への接続は応答ごとに閉じる)
    server 127.0.0.1:8787;
}

# Host の許可リスト: server_name に一致しない名前(SNI)への TLS 接続は拒否し、
# SNI は一致しても Host ヘッダが一致しない要求は応答せずに切る
server {
    listen 443 ssl default_server;
    ssl_reject_handshake on;
    return 444;
}

server {
    listen 443 ssl;
    server_name kp.example.test;

    ssl_certificate     /etc/nginx/tls/kp.example.test.crt;
    ssl_certificate_key /etc/nginx/tls/kp.example.test.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 遅い送信・長時間の保持でソケットを占有させない(minor-7)
    client_header_timeout 10s;
    client_body_timeout   10s;
    client_max_body_size  1m;
    keepalive_timeout     15s;
    send_timeout          30s;
    limit_conn kp_gateway_conn 20;

    if ($kp_gateway_origin_ok = 0) {
        return 403;
    }

    location = /mcp {
        proxy_pass http://kp_gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # 本文を受け切ってから Gateway に渡す(既定 on。遅い送信を Gateway に届かせない)
        proxy_request_buffering on;
        # MCP リクエスト単位の期限(minor-6)。Gateway の応答は単発 JSON のため、
        # この時間内に応答がなければ 504 で打ち切り、Gateway との接続も閉じる
        proxy_connect_timeout 5s;
        proxy_send_timeout    30s;
        proxy_read_timeout    60s;
    }

    # run API(ADR-019)。MCP のパスと同じディレクトリの runs(path: /mcp なら /runs、/kp/mcp なら /kp/runs。
    # Orchestrator も同じ規則で導く)。Orchestrator(kp-ask / kp-ask serve)だけが呼ぶ。利用者本人の Bearer に加えて
    # Orchestrator の資格情報のヘッダが要るため、/mcp と同じ制限で通す(Orchestrator が同じホスト内に
    # あり外部から呼ぶ必要がなければ、この location を置かず 404 のままにしてよい)
    location ~ ^/runs(/|$) {
        proxy_pass http://kp_gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_request_buffering on;
        # 本文は Gateway 側でも 64 KiB(gateway.runs.limits.maxBodyBytes)で打ち切る
        client_max_body_size 64k;
        proxy_connect_timeout 5s;
        proxy_send_timeout    30s;
        proxy_read_timeout    30s;
    }

    location = /healthz {
        proxy_pass http://kp_gateway;
    }

    location / {
        return 404;
    }
}
```

- 平文 HTTP(80)では待ち受けない。HTTPS へのリダイレクトも置かない(最初の平文リクエストで Bearer
  トークンが流れるため)
- `proxy_read_timeout` はソース別のタイムアウト(`connectors[].limits.timeoutMs`、既定 30 秒)と IdP の
  イントロスペクション(既定 5 秒)を足した値より長くする
- 接続数・頻度の上限は利用者数に合わせて調整する(頻度の上限が必要なら `limit_req` を併用する)
- リバースプロキシをコンテナで compose に加える場合は、gateway のホストへの公開(`ports`)を外し、
  `upstream` を `gateway:8787` にする

### 6.4 IdP への平文 http と `confirmPlainHttp`

- `idp.adapter.baseUrl` が平文 `http:` でループバック以外(内部網のホスト名・IP)を指す構成は、
  `idp.adapter.confirmPlainHttp: true` がなければ静的検証が `idp_plain_http_requires_confirmation` で拒否する
  (`kp-gateway validate` / `serve`、`kp-ask --config` も同じ。issue #17、ADR-011 追記)。イントロスペクション
  (RFC 7662)の往復には Gateway の clientSecret と利用者のセッショントークンが載るため、平文で内部網に出す
  構成は、経路が閉じた網であることを確認したうえで受け入れる(`gateway.http.confirmExposedHost` と同じ規約)
- リファレンス設定の `http://keycloak:8080` は、Gateway → Keycloak の区間が compose のサービス間ネットワーク
  だけを通る(Keycloak のホストへの公開は `127.0.0.1:8080` のみ)ため、`confirmPlainHttp: true` を付けている。Keycloak をホスト外に置く場合は `https` にしてフラグを外す
- `https` とループバック(`http://localhost:8080` 等)は確認不要

## 7. 監査ログの永続化

- `audit.sink: jsonl`。監査レコード本体は `/var/lib/kp/audit/audit.jsonl`(ボリューム `kp-audit`)、
  生クエリ原文は `/var/lib/kp/rawquery/raw-queries.jsonl`(ボリューム `kp-rawquery`)に追記する。
  保持期間(既定 365 日 / 30 日)と閲覧経路が異なるため別ボリュームにしている(ADR-011 §3、ADR-013 §3)
- ディレクトリは実行ユーザー(uid 1000)所有・0700、ファイルは 0600 で作られる。バインドマウントに
  変える場合は所有者を uid 1000 にする
- **at-least-once で、同じレコードが複数行に現れうる**(書き込みの成否が確定しない失敗でも再送するため)。
  読み手は冪等キー(`tool_invocation` は `requestId`、`answer_run` は `runId`、`audit_access` は
  `accessId`、`retention_purge` は `purgeId`)で重複を除く。昇格判定レポート(promotion-report)は
  このキーで重複を除いて集計する。同じ `runId` の AnswerRun が pending → 最終状態 → フィードバックと
  書き直される行は重複ではなく「更新」として別に数え、最終状態で集計する(レポートの `入力レコード数` の注記、
  JSON の `duplicateRecordCount` / `updatedRecordCount`)
- 開発用の `audit.sink: stdout` の出力(`{"kind":"audit", …}` の行)も、標準出力をファイルに保存すれば
  そのまま promotion-report の `--audit` に渡せる(封筒の `kind` を外して JSONL と同じ検証をかける)。
  保存するファイルは `umask 077` で作り、監査ログと同じ保持・閲覧の規程(ADR-013 §3)に従う(開発用)。
  **`stdout` シンクは `NODE_ENV=production` では `dev_only_in_production` で起動を拒否される**(issue #17、
  ADR-011 追記)。標準出力は運用ログと混ざり at-least-once も fail-closed も成立しないため、本番の監査にはならない。
  コンテナのログ基盤で監査を集めたい場合も、`jsonl` のファイルを収集基盤に取り込む形にする
- 書き込み失敗時は fail-closed(ADR-011)。ローカルバッファ(1000 件)で一時的な失敗を吸収し、あふれると
  ツール呼び出しが失敗する。停止(SIGTERM)時は処理中のリクエストを最大 10 秒待ってからバッファを
  flush し、flush できなければ exit 1 で終わる。compose の `stop_grace_period: 30s` はこのためで、
  短くして SIGKILL されるとバッファ内のレコードを失う
- 1ファイルに書き込むのは1プロセスに限る(Gateway は単一レプリカで動かす)
- **監査ストアに書くのは Gateway だけ**(ADR-019)。Orchestrator(`kp-ask` / `kp-ask serve`)の run
  (AnswerRun)も Gateway の run API(`/runs`)が `audit.jsonl` に記録する: run の開始で `answer_run`
  (pending)、終了で `answer_run_finish`、フィードバックで `answer_run_feedback` を追記する(部分レコード。
  書き直さない)。読み手は同じ `runId` の 3 種を結合して最終状態を得る(docs/audit-queries.md §0。昇格判定
  レポートは統合して集計し、有効期間を過ぎて finish のない run を「放棄」、pending のない部分レコードを
  「孤立」と数える。`gateway.runs.ttlSec` / `audit.rawQueryRetentionDays` を既定から変えたら
  `--run-ttl-sec` / `--raw-query-retention-days` に同じ値を渡す)。
  orchestrator のコンテナは監査ボリュームを一切マウントしない(Gateway の監査ログ `kp-audit`・生クエリ原文
  `kp-rawquery` も、以前の `kp-answer-runs` も)。Orchestrator は Gateway が信頼しない側(threat-model §1 の
  TB2)にあり、侵害・誤動作しても Gateway の監査ログを読めない・書き換えられない。ADR-018 決定4 の別ボリューム
  (`kp-answer-runs`、`answer-runs.jsonl`)は廃止した。以前の overlay で書いた `answer-runs.jsonl` が残って
  いるなら、その期間の集計には `--audit` を 1 つ足して渡す(下)
- **監査ボリュームの容量に警報を設ける**(threat-model TM-I5 (d))。run API は本文の大きさ(64 KiB)・質問の長さ
  (4,000 字)・利用者ごとの頻度(既定 60 回 / 分。`gateway.runs.limits`)に上限をかけるが、期限内の runId
  での `finish` / `feedback` の再送や単発の `tools/call` でレコードは増え続ける。fail-closed なので容量の枯渇は
  ツール呼び出し全体の停止になる。`kp-audit` / `kp-rawquery` の空き容量(目安: 残り 20% で警報)と
  `audit.jsonl` の増加率を監視し、利用者ごとの `invalid_run_id` の件数(docs/audit-queries.md §0)も見る
- 昇格判定レポートはコンテナ内で監査ボリュームを読んで実行できる(手順と注意は docs/playbook.md
  「有効化判定」。レポートの実行自体がメタ監査の対象で、`--meta-audit-out` のファイルを監査ストアに残す):

  ```bash
  docker compose run --rm --no-deps -v "$PWD/sources.json:/tmp/sources.json:ro" \
    --entrypoint node gateway packages/promotion-report/dist/cli.js \
    --audit /var/lib/kp/audit/audit.jsonl \
    --raw-queries /var/lib/kp/rawquery/raw-queries.jsonl \
    --sources /tmp/sources.json \
    --accessor <監査閲覧担当のuserId> \
    --meta-audit-out /var/lib/kp/audit/meta-audit.jsonl
  ```

  LibreChat overlay を使っていても `--audit` は 1 つ(AnswerRun も Gateway の `audit.jsonl` にある)。
  ADR-019 より前の overlay(orchestrator が `kp-answer-runs` に書いていた版)を動かした期間を含めて集計する
  ときだけ、残っているボリュームを読み取り専用で見せて `--audit` を足す(名前付きボリュームの実名は compose の
  project 名 `kp-reference` + `_kp-answer-runs`。`docker volume ls` で確かめられる。集計を終えたら ADR-013 §3 の
  保持規程に従って削除する):

  ```bash
  docker compose run --rm --no-deps \
    -v kp-reference_kp-answer-runs:/var/lib/kp/answer-runs:ro \
    -v "$PWD/sources.json:/tmp/sources.json:ro" \
    --entrypoint node gateway packages/promotion-report/dist/cli.js \
    --audit /var/lib/kp/audit/audit.jsonl \
    --audit /var/lib/kp/answer-runs/answer-runs.jsonl \
    --raw-queries /var/lib/kp/rawquery/raw-queries.jsonl \
    --sources /tmp/sources.json \
    --accessor <監査閲覧担当のuserId> \
    --meta-audit-out /var/lib/kp/audit/meta-audit.jsonl
  ```

### 7.1 出力の規則(stdout = 結果、stderr = ログ、監査 = ファイル)

各プロセスの出力先は次の規則に固定する(issue #17、ADR-011 追記)。構造化ロガーやリクエストログはなく、
出力はこの表がすべて。

| プロセス | stdout(機械が読む結果) | stderr(人が読むログ) | 監査(ファイル) |
|---|---|---|---|
| `kp-gateway serve` | 何も出さない。例外は開発用の `audit.sink: stdout`(監査レコード `{"kind":"audit",…}` を 1 行 1 件。本番では拒否) | 起動ログ(listening、deployment 名、有効ソース、IdP、sink、`run api: /runs (signing key: env KP_RUN_ID_KEY, kid …; orchestrator credential: env …; ttl …)`)、`WARNING`(開発部品の使用・一時鍵や開発用の資格情報・組み立て時の警告)、設定エラー、予期しない例外(例外の名前だけ。メッセージ・スタックは出さない) | `audit.sink: jsonl` の `audit.jsonl.path`(ToolInvocation、AnswerRun の `answer_run` / `answer_run_finish` / `answer_run_feedback`)と `rawQueryPath`(生クエリ原文。run の質問原文を含む) |
| `kp-gateway validate` | `validate: OK` と要約 | 設定の不備(`[code] path: message`)、`WARNING` | 書かない(ファイルも作らない) |
| `kp-ask`(一回実行) | 回答本文。`--json` なら Answer の JSON を 1 つ(失敗時も `{ "outcome": "error", … }`) | 進捗・警告(開発用の資格情報の使用)・エラー | 書かない(run は Gateway の run API に申告し、Gateway が記録する。ADR-019) |
| `kp-ask serve` | `--help` だけ | 起動ログ(`run api: gateway (orchestrator credential: …)` を含む)・エラー | 書かない(同上) |
| compose | コンテナの stdout / stderr は `docker logs` へ。収集は導入先の運用 | 同左 | 名前付きボリューム(§7) |

出さないもの: トークン・API キー・AuthContext(`redactAuthContext` 経由でしか文字列化しない。不変条件 6)、
検索結果の内容、生の例外。監査レコードの docId は方針(`audit.privateScopeDocIds`)に応じて hashed / omitted。
既知の不足: 運用ログ(非監査)に構造化の形式がない(grep 前提の行ログ)。HTTP 層の認証失敗は監査にもログにも
残らない(issue #39)。`audit.sink: stdout` のとき生クエリ原文がプロセス内メモリに単調増加する(issue #29)。

## 8. 未実装事項(既知の制約)

- **保持期限による定期削除**: `retentionDays` / `rawQueryRetentionDays` の期限超過分を削除するジョブ
  (`runRetentionPurge` の定期実行と、削除実行の記録 `retention_purge`、ADR-013 §3)は動いていない。
  JSONL は増え続ける
- **JSONL のローテーション**: 未実装。Gateway はバッチごとにパスを開いて追記するため、ファイルを
  rename すれば次の追記から新しいファイルに書かれる(コード上の挙動。再起動は不要)。ただし期限超過分の
  削除は削除実行の記録とセットで行う必要があるため、仕組みができるまでは手動で削除しない
- **本番の本人資格情報の取得**(`connectors[].auth.provider`): T-004。現状の `mock_env` は開発専用
- **Gateway 側の Host / Origin 検証・リクエスト単位の期限・拒否応答の `connection: close`**
  (minor-6 / minor-7 / minor-11): 未実装。リバースプロキシで緩和する(§6)
- **監査 sink の死活**: `/healthz`(イメージの HEALTHCHECK)は待ち受けの死活だけを示し、監査の書き込み
  状態(バッファの滞留)は反映しない(threat-model TM-E6)。監査ボリュームの空き容量とファイルの更新を
  別途監視する(§7 の容量の警報)
- **run API の段階 2**(ADR-019 決定11): 引用がその run で返した文書かは Gateway で検証しない(段階 1 は
  署名で発行元・本人・期限だけを確かめる)。Slack が有効な構成では引用 docId を記録しない(決定5)
- Keycloak の本番構成(永続 DB、TLS、ホスト名、管理者の扱い)は対象外
- イメージのレジストリ配布・署名、ベースイメージのダイジェスト固定(`deploy/Dockerfile` の
  `ARG NODE_IMAGE`)は未整備
- 検索バックエンド(profile `search-backend`)は T-016 の PoC で選定後に定義する
- LibreChat overlay の制約(👍👎 と feedback の連携なし、進捗のストリーミングなし、LibreChat v0.8.7 では通常の
  会話と一時チャットの保持期限を分けられない等)は [docs/ui-librechat.md](ui-librechat.md)「未実装・制約」

## 9. アップグレード手順(骨子)

1. リリースノートと ADR の変更を確認し、監査ボリューム(`kp-audit` / `kp-rawquery`。ADR-019 より前の
   overlay で作られた `kp-answer-runs` が残っていればそれも)をバックアップする
2. 新しいイメージを用意する(イメージタグの差し替え)。現状はソースからビルドする:
   対象のタグを checkout して `docker compose build gateway`。レジストリ配布が整備されたら、
   `image:` を配布タグに差し替えて `build:` を外す
3. 切り替える前に、新しいイメージで設定を検証する: `docker compose run --rm --no-deps gateway validate`
4. 設定スキーマの移行: 設定の読み込み時に `schemaVersion` を現行版まで自動で移行する
   (`packages/gateway/src/config/migrate.ts` の `MIGRATIONS`。現行は v1 のみ)。イメージが対応する版より
   新しい `schemaVersion` は拒否される。移行後の設定をファイルへ書き出すコマンドはまだないため、
   リリースノートに従って deployment.yaml を新しい版に書き換え、手順3で確かめる
5. 再起動: `docker compose up -d gateway`(停止時は処理中のリクエストを待って監査を flush する)
6. スモーク(§2)。問題があれば旧イメージのタグに戻す(監査 JSONL は追記のみのため、そのまま使える)

## 10. 導入チェックリスト

認可方式の前提(docs/auth-matrix.md §12〜13)とプライバシー方針(ADR-013)から、導入時に確認する項目。

- [ ] **GitHub: SCIM 連携(または EMU)を必須とする。** SAML 単独ではアカウント停止がトークン失効に
  つながらない(auth-matrix §4・§12.2)
- [ ] **Google Workspace: 管理者によるアプリの事前承認(ドメインインストール)。** Restricted scope の
  検証免除の条件を導入形態ごとに確認する(auth-matrix §2・§12.3)
- [ ] **Kerberos(ファイル共有、T-017)を使う場合はチケット寿命の短縮を検討する**(失効反映のラグ)
- [ ] **GitHub: GitHub App は組織にだけインストールする**(個人アカウントにはインストールしない)。
  GitHub コネクタは issue / PR・fetch の結果から所有者が個人アカウントかを判定できないため、個人の非公開
  リポジトリを検索範囲に入れない前提を構成で守る(packages/connector-github/README.md「プライベート領域」、
  ADR-016 追補2 決定7)
- [ ] **privateScopes の方針を決める**(既定 `excluded`)。`included` を採る場合は利用規程
  ([docs/usage-policy-template.md](usage-policy-template.md))の整備と労使協議・就業規則との整合確認を行い、
  確認フラグ(`confirmPrivateScopesIncluded: true`)を付ける(ADR-013 §1、TM-E4)。
  - `consent`(本人オプトイン)は**現在は指定できない**。同意状態の持ち方(#42)が未設計で、方針が
    コネクタに届かず除外も確認フラグも効かないため、`kp-gateway validate` / `serve` と `kp-ask` /
    `kp-ask serve` は無効化済みのコネクタでも `private_scopes_consent_not_supported` で起動を拒否する
    (ADR-016 追補2 決定6)
  - `excluded` は、コネクタが能力 `privateScopeHandling` に `enforced` か `classified` を宣言している
    場合だけ起動できる。宣言のないコネクタ(connector-sdk v0.3 のプラグイン)・`unsupported` のコネクタは
    `private_scopes_unenforceable` で起動を拒否する。`excluded` のソースでは、Gateway が DM・プライベート
    チャンネル・個人スコープに分類された結果を検索・一覧から落とし、fetch を `private_scope_excluded` で
    拒否する(ADR-016 追補2 決定3・4、TM-E8)
- [ ] 監査閲覧担当の指名と閲覧目的の規程化、メタ監査の運用(ADR-013 §3)
- [ ] `audit.failureMode` は `fail-closed` のまま運用する(run API の 3 経路にも同じ設定が及ぶ。`fail-open` はセキュリティポリシーへの明文化と
  確認フラグが必要。ADR-011)
- [ ] ループバック以外へ公開する前に §6.2 の緩和(TLS 終端、リクエスト期限、接続数上限、Host / Origin の
  許可リスト)をリバースプロキシに入れる
- [ ] 保持期間(監査 365 日、生クエリ 30 日、テレメトリ 14 日、チャット履歴 90 日)を確認し、定期削除が
  未実装であることを踏まえた運用計画を立てる(§8)
- [ ] コアダンプを無効にする(メモリ上のトークンを残さない。TM-C3。compose は `ulimits: core: 0`)
- [ ] Slack を対象にする場合は導入形態の法務確認(ADR-014。T-006 は法務確認待ち)

### 10.1 直接接続の統制

leisen への同意は、エージェント製品から各ソースへ直接つなぐこと(直接接続)の許可にはならない。同意は
OAuth アプリ単位で行うためである。ただし、ソース側でアプリを制限していなければ、leisen の導入と関係なく
直接接続ができてしまう。leisen を公認の経路にするなら、次の項目でほかの経路を塞ぐ。背景と体験の比較は
[docs/direct-connection.md](direct-connection.md)。

- [ ] **ソースのアプリ承認制で、leisen の OAuth アプリだけを承認する**(各ソースの管理者同意の仕組みは
  [docs/auth-matrix.md](auth-matrix.md) の「管理者同意」行)
  - Google Workspace: アプリアクセス制御で leisen のクライアントを信頼済みにし、信頼済み以外のアプリから
    Drive へのアクセスを止める。**社内アプリ(自社の GCP プロジェクトで作ったクライアント)を自動で信頼する
    設定は切る**か、プロジェクトを作れる人を限る(切らないと、社員が自分で作ったクライアントが通る)
  - Slack: アプリ承認制を有効にし、leisen 以外のアプリ(エージェント製品の Slack 連携を含む)を承認しない。
    **利用者が自分で作ったアプリをワークスペースに入れられないようにする**(承認制の対象に含める)
  - GitHub: Org の OAuth App アクセス制限と GitHub App のインストール承認を有効にしておく
  - Notion: Enterprise ではコネクションの承認リストで管理する。Enterprise 以外のプランでは止められない
    前提で利用規程に書く
  - Microsoft 365: 利用者による同意を止め、admin consent で承認したアプリだけにする
- [ ] **GitHub の個人アクセストークン(PAT)を制限する**: Org で classic PAT のアクセスを禁止し、fine-grained
  PAT を承認制にする。開発者は PAT を日常的に使い、公式の GitHub MCP サーバーも PAT で設定できるため、
  規程だけでは止まらない
- [ ] **ブラウザを操作するエージェントを端末側で管理する**: ブラウザ拡張の許可リスト(管理ポリシー)と、
  エージェント製品の組織管理設定で、ブラウザ操作・画面操作の機能を許可するかを決める。本人の Web セッションで
  動くため、ソース側からは本人の操作と区別できない
- [ ] **エージェント製品の組織管理機能で、ソースへの公式コネクタを無効にし、leisen(`kp-ask serve`。
  [docs/ui-librechat.md](ui-librechat.md))をカスタムコネクタとして配布する**(管理機能がある製品のみ)
- [ ] **利用規程に、leisen 以外の経路で社内データをエージェントに渡すことの扱いを書く**(セッショントークンの
  流用、規約外の自作アプリ、エクスポートやコピー&ペーストを含む。
  [docs/usage-policy-template.md](usage-policy-template.md))
- [ ] **事後の検知**: 各ソースのネイティブ監査ログで、leisen 以外の OAuth クライアントからのアクセスを定期的に確認する

## 11. Helm 化の要件(スコープ外)

Helm チャートは T-012 のスコープ外とし、作るときの要件だけを記録する。

- **values での注入**: deployment.yaml を ConfigMap として `/etc/kp/deployment.yaml` に読み取り専用で
  マウントする(秘密を含まない)。秘密は Secret から環境変数として渡し、変数名は deployment.yaml の
  `clientSecretEnv` / `<name>Env` と一致させる
- **readiness / liveness**: `GET /healthz`(認証不要)。監査 sink の状態は含まない(§8)
- **単一レプリカ前提**: 監査バッファがプロセス内にあり、JSONL は1ファイル1プロセスで書く。
  `replicas: 1`、更新戦略は `Recreate`(旧新の Pod が同じ監査ファイルに同時に書かない)。監査と
  生クエリはそれぞれ ReadWriteOnce の PVC
- **停止猶予**: `terminationGracePeriodSeconds` は 30 秒以上(処理中リクエストの待機 最大 10 秒 +
  監査 flush)
- **securityContext**: `runAsNonRoot: true`、`runAsUser` / `runAsGroup` / `fsGroup` 1000、
  `allowPrivilegeEscalation: false`、capabilities は全て drop。`readOnlyRootFilesystem: true` は
  書き込み先が監査ボリュームだけであることを確かめてから有効にする
- **公開**: Ingress(またはゲートウェイ)で TLS を終端し、§6.2 の緩和(リクエスト期限、接続数上限、
  Host / Origin の許可リスト)を入れる。NetworkPolicy で Gateway への流入を Ingress からに限る
- **将来のスケールアウトの条件**: 監査を冪等キー(requestId 等)で重複を除く共有ストアへ書く sink への
  置き換え(JSONL の単一ファイルをやめる)、ソース別レート制御(現状はプロセス内の固定窓で、
  レプリカ数だけ上限が増える)の共有化。MCP はステートレス(ADR-001 追補3)のため、セッションの
  固定(スティッキー)は不要
