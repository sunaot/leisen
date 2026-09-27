# T-003: Gateway MCPプロキシ骨格

## 依存
T-001, T-002, **T-010**(deployment.yamlの最小サブセットを最初から使う。sources.yamlは作らない)

## 目的
全ツール呼び出しの単一経路となるGatewayを作る。認証注入と監査ログはここで必ず通る。

## 内容
- MCPクライアント/サーバー両面を持つプロキシ: 上流(Orchestrator)からのMCPリクエストを受け、対象コネクタへ転送
- **MCPセッションと利用者アイデンティティの束縛**: セッション確立時に本人を確定し、以降の全ツール呼び出しに紐付ける(MCP自体はエンドユーザーIDを運ばない)
- 転送時にIdpAdapter(T-002)から資格情報を取得しコネクタへ受け渡す
- 全呼び出しをT-001のロガーで記録。**監査書き込み失敗時は既定fail-closed(ADR-011)**。タイムアウト・レート制御(ソース別設定)
- ADR-015の実行区分(human-in-the-loop以外は既定拒否)の照合
- SearchHit.snippetの強制truncate(MAX_SNIPPET_CHARS、ADR-016)

## 受け入れ条件
- [x] モックコネクタ2つを登録し、E2Eでsearch/fetchがプロキシ経由で通るテストがある
- [x] 資格情報取得失敗時にコネクタ呼び出しが行われないことがテストされている
- [x] 監査ログがリクエストごとに正確に1レコード出ること、書き込み失敗時にfail-closedになることがテストされている
- [x] scheduled/autonomous区分の呼び出しが拒否されることがテストされている
- [x] snippetがMAX_SNIPPET_CHARSでtruncateされることがテストされている

## 更新(2026-09-17): HTTPトランスポート配線(残作業)

上記受け入れ条件はPR #10(2026-07-12)で完了。**HTTPトランスポート配線は未実施**であり、以下の条件で別PRとして行う。

### 前提
**ADR-001追補3(MCP仕様2026-07-28版・ステートレス前提)は承認済み(2026-09-27)。** 着手可能。上記「内容」の「セッション確立時に本人を確定し、以降の全ツール呼び出しに紐付ける」は追補3で「リクエスト単位認証」に置き換わる(`docs/mcp-spec-2026-07-28-review.md` §B)。

### 残作業(追補3の決定を前提とする)

**実装状況(2026-09-27、HTTP配線PR):** 現行SDK(`@modelcontextprotocol/sdk` 1.29.0 / 1.30系)は仕様2026-07-28版を未実装(`LATEST_PROTOCOL_VERSION = '2025-11-25'`、`server/discover` / `Mcp-Method` / `resultType` / `cacheScope` 等の識別子なし)。そのため決定1〜5・7の実質を現行SDKのStreamable HTTPステートレスモードで実装し、仕様2026-07-28版固有の項目は**保留(SDK対応待ち)**とした。これらをGateway独自の互換レイヤとして手実装しない(追補2「SDKはプロトコル層のみ」・追補3 決定6)。SDKは先行PRで `@modelcontextprotocol/sdk` 1.30.1(exact指定)に更新済み。仕様2026-07-28版対応の公式SDKはv2系の分割パッケージ(`@modelcontextprotocol/server` 等)で提供されており、移行するかは人間の未決事項(ADR-001追補3「SDK更新の検証結果」)。

- [x] Streamable HTTP配線(`proxy/http.ts`。node:http + SDKの `StreamableHTTPServerTransport`、応答は単発JSON): 毎リクエストの `Authorization: Bearer` でセッショントークンを検証し、`GatewaySession` を接続ではなくリクエストから解決する(追補3 決定1)。initialize / tools/list を含む全MCPリクエストで認証を要求し、失敗はJSON-RPCディスパッチ前に正規化エラーのみを返す(unauthenticated→401、idp_unavailable→503、それ以外→500)。`server.onclose` によるセッション破棄前提は撤回した。GET / DELETE は405(ステートレスでSSEストリーム・セッションを持たない)、`GET /healthz` は認証不要で `{"status":"ok"}` のみ
- [x] MCPサーバーインスタンスからユーザー状態を排除(決定2): `createGatewayMcpServer(gateway)` はユーザー状態を受け取らない部品で、検証済みIdentityはSDKの `AuthInfo`(ハンドラの `extra.authInfo`)で受け渡す。SDK 1.xの Server は1トランスポートにしか接続できないため、HTTPではリクエストごとにServer+Transportを生成し応答後に閉じる。SDKに触れるコードは `mcp.ts`(Server生成・ハンドラ登録)と `http.ts` のトランスポート生成部に閉じ込め、認証・`_meta` の解決・エラー正規化(`tools.ts` / `meta.ts` / `session.ts`)と監査(`gateway.ts`)はSDK非依存とした(仕様2026-07-28版対応SDKへの差し替え時の手戻りを限定する。import境界はテストで固定)
- [x] runId / iteration のセッション単位自動採番を廃止(決定3、ADR-011 追記): 申告値を記録し、runId未申告は呼び出し単位の新規runId・iteration=0の単発run
- [x] `_meta` の `runId` / `iteration` を名前空間prefix付きキー `io.github.sunaot.leisen/runId` / `iteration` へ移行(決定4。移行期間は裸キーも受けるが、prefix付きキーが1つでもあれば裸キーはすべて無視する。不正値は未申告扱いで、runId は `[A-Za-z0-9._:-]` の1〜128文字に限る)。実行区分・actor(ADR-015)も**リクエストごと**に `io.github.sunaot.leisen/executionClass` / `io.github.sunaot.leisen/actor` で申告する(未申告は human_in_the_loop / human、不正値は既定値に丸めず invalid_request、scheduled / autonomous は従来どおり拒否)。**申告キーの誤記は invalid_request**(裸の executionClass / actor、prefix 内の未知キー、NFKC 正規化・小文字化・英数字以外の除去後の骨格で一致する見た目違い。黙って無視すると human_in_the_loop として通るため。2026-09-27 レビュー M2、再レビュー S1)。prefixは定数 `META_KEY_PREFIX`(`proxy/meta.ts`)の1箇所に置く。最終確定はT-013(変更時は移行期間中4キーすべてで旧prefixも受け、未知キー拒否も新旧両方に適用する)
- [x] deployment.yaml に `gateway.http`(`host` 既定 127.0.0.1 / `port` 既定 8787 / `path` 既定 /mcp、/healthz は予約)を追加。listenする起動コードは `kp-gateway serve`(2026-09-27 先行実装、`packages/gateway/src/cli/`。Docker 化は T-012)
- [ ] **保留(SDK対応待ち)** `tools/list` に `cacheScope: "private"` 固定と `ttlMs`(deployment.yaml注入、既定300000)を付与する(決定5)。ユーザー・接続非依存であること自体はテスト済み
- [ ] **保留(SDK対応待ち)** 新仕様の必須要件: `Mcp-Method` / `Mcp-Name` ヘッダ検証、`server/discover` 応答、`resultType: "complete"` 付与(§B-3)
- [x] ネゴシエートされたプロトコルバージョンを固定値と突き合わせる回帰テスト(§C-2)— 完了(`test/sdk-protocol.test.ts`。SDK更新PR、追補3「SDK更新の進め方」の検証項目(d))
- [x] `@modelcontextprotocol/sdk` の更新は別PRで行い、追補3「SDK更新の進め方」の検証項目を満たす — 1.30.1 で完了(1.30.xは2026-07-28版に非対応。回帰テストはv1系が新仕様に対応した場合に検知する。ADR-001追補3「SDK更新の検証結果」)

注記(T-004で判断): リクエスト単位認証により `IdpAdapter.authenticate` はMCPリクエストごとに呼ばれる。`idp/cache.ts` がキャッシュするのは資格情報(userId×sourceId)であり、authenticate の検証結果はキャッシュしていない(Keycloak参照実装ではリクエストごとにイントロスペクション1往復)。検証結果をキャッシュする場合はTTLが失効反映の遅延上限になるため、`keycloak.ts` 冒頭の方針どおりT-004で判断する(T-004 の H2)。

### セキュリティレビュー(2026-09-27、HTTP配線 5ff812a)

判定 FAIL(must 2件)を受けて反映した。**M1(TM-B2 正規化)/ M2(申告キー誤記の fail-open)を反映。**

- [x] M1: `normalizeToolError`(`proxy/tools.ts`)が LLM/利用者向けに `permission_denied` / `not_found` を単一の分類 `not_available`・固定文言にまとめる(retryAfterMs なし)。監査レコードの errorClass は元の分類を保持(`GatewayErrorClass` に `not_available` を追加。正規化でのみ生成)。threat-model TM-B2 を実装済みに更新
- [x] M2: `declarationFromMeta`(`proxy/meta.ts`)が、prefix 内の未知キー(大文字小文字違いを含む)と裸の executionClass / actor を固定文言の invalid_request で拒否する(コネクタ未到達・監査なし)。正しい prefix の scheduled は従来どおり execution_class_rejected(監査1件)。照合は再レビュー S1 で骨格による照合に拡張した(下記)
- [x] minor-1: Gatewayコアが結果を IF の既知フィールドだけに射影する(totalCount・debug 等を出さない、meta は string→string のみ、必須フィールドの型不正は internal_error)。snippet の強制 truncate も射影内で行う
- [x] minor-2: ツール結果の直列化を `runToolCall` の try 内へ移し、直列化失敗(BigInt・循環参照)も固定文言の internal_error にする。`mcp.ts` は直列化済み文字列を受け取る
- [x] minor-4: `gatewayAuthInfo` の token にセッショントークンを載せない(固定値 `kp-gateway-authenticated`)。`identityFromAuthInfo` は `gatewayAuthInfo` が発行した extra(モジュール内 WeakSet)だけを信用する
- [x] minor-5: TM-C6 検査のコメントを実態(検出できるのはラベル不一致のみ)に合わせた(errorClass は不変)
- [x] minor-8: prefix 付きキーが1つでもあれば裸の runId / iteration はすべて無視する
- [x] minor-10: runId を `[A-Za-z0-9._:-]` の1〜128文字に制限(不適合は未申告扱い。in-process の呼び出しにも同じ規則)。設定に存在しないソース(unknown_source)の監査レコードの sourceId は固定値 `unknown`(source_disabled は設定由来の値なのでそのまま)
- [ ] minor-6: `transport.handleRequest` の期限(`GatewayHttpServerOptions.requestTimeoutMs`、既定 60000。超過時は 500 固定文言・headersSent なら destroy・server.close)— **未反映**(同一 POST の `[tools/call id=7, notifications/cancelled requestId=7]` バッチで応答が返らず、接続とリクエスト単位の部品が保持される問題は残っている。公開前の必須条件として T-012 に記載)。`http.ts` 冒頭の「確実に閉じられる」の記述は再レビュー反映で実態に修正済み(コメントのみ)
- [ ] minor-7: 拒否応答(401 / 404 / 405 / 5xx)への `connection: close` 付与 — **未反映**(`http.ts` の挙動変更を伴う。再レビュー反映で変えたのはコメントのみ)
- 見送り: minor-3(IdP/コネクタ由来 message の固定文言化は T-004 で規約テストと共に行う)、minor-9(拒否の監査は ADR-011 の改訂が前提)、minor-11(`gateway.http.host` の非ループバック確認と Origin 検証は T-012 で扱う)

#### 人間への確認事項
- **H1**: 未申告の呼び出しを human_in_the_loop とする既定(ADR-015、`session.ts`)が、HTTP 化により Bearer セッショントークンを持つ任意の MCP クライアント(社外のエージェント製品を含む)に適用される。TM-C7 の受容範囲として再確認を求める。判断材料(申告キーの誤記の扱い):
  - Gateway が塞いだ範囲(M2、再レビュー S1): 裸の executionClass / actor、名前空間 prefix 内の未知キー、NFKC 正規化後の見た目違い(大文字小文字、前後の空白・タブ、区切りの違い、prefix 直後の `/` の欠落、全角・ゼロ幅文字。いずれも骨格で照合する)と、prefix を誤った executionClass(`io.github.sunaot.leisn/` / `leisen/` / `kp.gateway/` 等。骨格が `executionclass` で終わるキーは名前空間を問わず拒否する)。すべて invalid_request で、コネクタに届かない
  - Gateway では検知できない残余: (1) `_meta` 以外の場所での申告 — `params.meta` のようにアンダースコアの無いキーはスキーマ外として SDK が取り除くため Gateway に届かない、(2) 申告そのものの省略。ほかに、名前空間外のキー名自体の綴り違い(`execClass` 等)と、prefix を誤った actor(`kp.gateway/actor` 等。他社名前空間の actor と区別できない)も検知しない。いずれも human_in_the_loop / human として扱われる。したがって区分の申告は善意のクライアントの誤記を拒否する仕組みであり、申告しない(または申告を実装しない)クライアントには効かない。この残余を受容範囲に含めるかが H1 の判断対象

### セキュリティ再レビュー(2026-09-27、判定 PASS)

should 項目を反映した。

- [x] S1: 申告キーの誤記の照合を骨格 `skeleton(k) = k.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "")` で行う(`proxy/meta.ts`)。既知の4キーと完全一致しないキーのうち、骨格が名前空間 prefix の骨格(`iogithubsunaotleisen`)で始まる・`executionclass` で終わる・`actor` に等しいものを固定文言の invalid_request にする。再レビューで human_in_the_loop として実行されることが実証された変種(prefix 付きキー・裸キーの前後の空白やタブ、`.` / `:` 区切り、prefix 直後の `/` の欠落、prefix の綴り違い・`leisen/`・`kp.gateway/`、`execution class` / `execution.class`、末尾空白の `actor `、全角・ゼロ幅文字)の拒否(コネクタ未到達・監査なし)と、正当なキー(`progressToken`、`io.modelcontextprotocol/related-task` / `protocolVersion`、裸の `runId` / `iteration`、既知の4キー、`com.example/actor`)を拒否しないことをテストで固定した(`test/proxy-tools.test.ts`。HTTP / MCP 境界の代表例は `http-transport.test.ts` / `mcp-proxy.test.ts`)。他社名前空間の `com.example/executionClass` も拒否する(自社の申告のつもりで prefix を誤ったキーと区別できないため fail-closed に倒す)
- [x] S2: H1 の判断材料として、Gateway が塞いだ範囲と検知できない残余を分けて明記した(上記 H1)
- [x] S3(T-007): Orchestrator の `_meta` の組み立てを `buildGatewayMeta` に集約し、Orchestrator の MCP クライアント経由の scheduled 申告が実 Gateway で execution_class_rejected(監査1件)になる E2E を追加した(T-007 の受け入れ条件)
- [x] minor-6 の記述修正: `http.ts` 冒頭と `serveMcpRequest` の「handleRequest の完了=応答の送出完了(部品を確実に閉じられる)」を、取り消し通知を含むバッチでは完了せず部品が保持される実態に直した(期限の実装は上記 minor-6 のとおり未対応)
- 任意項目も反映: `@kp/connector-github` に `exports` を追加して深い import(`dist/*` の直接参照)を閉じた。guard hook `scripts/guard/pre-bash.sh` の GitHub トークン接頭辞を `post-edit.sh` と同じ集合に揃えた

### 受け入れ条件(残作業分)
- [x] Authorizationヘッダ欠落・不正なリクエストがコネクタ呼び出し・監査記録のいずれにも到達せず、正規化エラーのみ返る(`test/http-transport.test.ts`。失効トークンの401、IdP不達の503、想定外例外の500も)
- [x] 同一MCPサーバーインスタンスを複数ユーザーで共有してもユーザーコンテキストが混線しないことがテストされている(不変条件4。同一Gatewayを alice / bob が交互・並行に使うHTTP統合テストと、1サーバーインスタンスを共有するMCPテスト)
- [x] `tools/list` の内容がユーザー・接続に依存しないことがテストされている(ADR-012。bobが使えないソースも含め alice / bob で同一、ソースenumはdeployment.yaml由来のみ)
- [x] runId / iteration: prefix付き `_meta` 申告が監査レコードに反映され、未申告は単発run(呼び出しごとに異なるrunId、iteration 0)として記録されることがテストされている(prefix付き・裸・両方・不正値の4ケース)
- [x] プロトコルバージョン回帰テストが存在し、SDK更新時に失敗して更新レビューを強制する(`test/sdk-protocol.test.ts`)
