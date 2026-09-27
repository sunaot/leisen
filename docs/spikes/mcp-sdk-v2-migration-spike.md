# スパイク: MCP TypeScript SDK v2(2.1.0)への移行

Date: 2026-09-27 / Status: スパイク結果(本流にはマージしない。採否は統括者と人間が判断する)

関連: ADR-001(追補2・追補3、特に追補3「SDK更新の検証結果(2026-09-27)」)、`docs/mcp-spec-2026-07-28-review.md`、T-003、T-007

> **統括者注(2026-09-27、取り込み時)**: 本スパイクと並行して、T-003 の HTTP 配線は v1 系 SDK(1.30.1)で完了しマージ済み(コミット 5ff812a)。SDK に触れるコードは `proxy/mcp.ts` と `proxy/http.ts` のトランスポート生成部に隔離してあり(本レポート §5 の「案A の条件」を満たす)、認証・`_meta`・エラー正規化・監査は SDK 非依存。したがって人間の判断は「v2 に移ってから配線するか」ではなく「**いつ v2 移行 PR を行うか**」(案B の手順 1〜2 を配線後に行う形)になる。`spikes/mcp-sdk-v2/` は CI のビルド・テスト対象外の試作であり、移行 PR の土台として残す。

## 1. 目的

ADR-001追補3 は MCP 仕様 2026-07-28 版を設計前提としている。一方、v1 系 `@modelcontextprotocol/sdk`(最新 1.30.1)はこの版を実装していない(追補3「SDK更新の検証結果」)。対応版は v2 系の分割パッケージ(`@modelcontextprotocol/server` / `client` / `core`、2.1.0)である。本スパイクでは、v2 に移る場合の次の点を一次情報と実測で確かめ、統括者と人間が「v1 で HTTP 配線を続けるか、v2 に移ってから配線するか」を判断できる材料を揃える。

- 何が自動で満たされるか: `server/discover`、`resultType`、`ttlMs` / `cacheScope`、`Mcp-Method` / `Mcp-Name`
- 最重要の判断材料: v1 系クライアント(社外エージェント製品を含む)との互換が保てるか
- 追補3 の決定1〜7(リクエスト単位認証、ユーザー状態を持たないサーバー、`_meta` の prefix 付きキーなど)を v2 でどう書くか
- `packages/gateway/src/proxy/mcp.ts` を移すコスト

## 2. 検証環境と方法

### 環境

| 項目 | 版 |
|---|---|
| Node.js / npm | v22.22.2 / 10.9.7 |
| TypeScript / vitest / @types/node | 5.9.3 / 4.1.9 / 22.20.0(ルートの devDependencies をそのまま使用) |
| zod | 4.4.3(リポジトリの lock と同じ版に固定) |
| v2 | `@modelcontextprotocol/server` / `client` / `core` / `node` 2.1.0(2026-09-23 公開。2.0.0 は 2026-07-27) |
| v1(比較・互換確認用) | `@modelcontextprotocol/sdk` 1.30.1(v1 の latest)と 1.29.0(この worktree のルート lock) |
| その他 | hono 4.13.9、@hono/node-server 1.19.17(v2 の Node アダプタと v1 が共有) |

この worktree は main(69af9f4)から切られており、ルートの lock は 1.29.0 である。1.30.1 へのピン留め(740602d)と `packages/gateway/test/sdk-protocol.test.ts` は `claude/loving-edison-3yad2v`(8422ada)にあるため、`git show` で読んだ。

### 方法

1. **一次情報の読み込み**: 3パッケージ(と `@modelcontextprotocol/node`)を `npm pack` で worktree 外のスクラッチに展開し、README と `.d.ts` を読んだ。移行ガイド `docs/migration/upgrade-to-v2.md`、`docs/migration/support-2026-07-28.md`、リポジトリ README、`packages/server/CHANGELOG.md` は GitHub の main から原文を取得した。
2. **試作**(`spikes/mcp-sdk-v2/`。ルートの workspaces には含めない)
   - `src/gateway-mcp-v2.ts`: `mcp.ts` をコピーし、SDK v2 と追補3 の決定に合わせて最小限だけ書き換えた。元ファイルとの差分がそのまま移行コストの実測値になる
   - `src/http.ts`: Streamable HTTP の入口(`createMcpHandler` と `toNodeHandler`、リクエスト単位認証)
   - `src/type-probes.ts`: (v) 用の型検査プローブ
   - `test/*.test.ts`: 実物の Gateway コア(`packages/gateway/src`)と T-003 のテスト用モック(`packages/gateway/test/helpers/proxy.ts`)を読み込み、127.0.0.1 の実ソケット上で検証する。一部は `handler.fetch` を使ってプロセス内で実行する。`packages/*` は変更していない(connector-sdk の `dist/` をビルドしただけで、これは gitignore 対象)
3. **型検査**: ルートの `tsconfig.base.json`(strict、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、NodeNext)を継承し、`tsc --noEmit` で確認した。

補足: 試作に vitest を入れると npm 10.9.7 が peer 依存の解決中に落ちた(`Cannot read properties of null (reading 'edgesOut')`、vitest の peer set で発生)。MCP SDK とは無関係なので、typescript / vitest / @types/node はルートのものを使う構成にした。

### 実行結果の総括

`npm run typecheck`: エラー 0。`npm test`: 4 ファイル 13 件すべて成功(所要約 3.4 秒。3回続けて実行し、3回とも成功)。

## 3. 結果

### (i) v2 Client ↔ v2 サーバー(2026-07-28 版): 通った

`Client` を `versionNegotiation: { mode: 'auto' }` で作り、`StreamableHTTPClientTransport` で接続した(`test/modern.test.ts`)。v2 Client の既定は `'legacy'`、つまり 2025 年版の `initialize` を使うので、2026-07-28 版を話すにはこのオプトインが必須である。

実行ログの要点(HTTP 往復の記録):

```
modern wire [http, rpc, status, Mcp-Method, Mcp-Name]:
  [["POST","server/discover",200,"server/discover",null],
   ["POST","tools/list",200,"tools/list",null],
   ["POST","tools/call",200,"tools/call","search"]]
discover result: {"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete",
  "ttlMs":0,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"kp-gateway","version":"0.1.0"}}}
```

- **接続と呼び出し**: `server/discover` → `tools/list` → `tools/call` が通った。`client.getProtocolEra()` は `'modern'`。どの要求にも `MCP-Protocol-Version: 2026-07-28` が付き、`mcp-session-id` は要求にも応答にも一切現れない。応答は既定の `responseMode: 'auto'` により単一の JSON 本文で返る。
- **`server/discover`**: SDK が自前で応答する(ハンドラは不要)。`supportedVersions` は `["2026-07-28"]`。2025 年版は `initialize` でネゴシエートするため、ここには含まれない。
- **`resultType`**: 全結果に `"complete"` が**自動で**付く(discover、tools/list、tools/call で確認)。公開型からは消されており、ハンドラが扱うことはない。
- **`ttlMs` / `cacheScope`**: キャッシュ可能な結果(`tools/list`、`server/discover` など)にだけ**自動で**付く。既定値は `ttlMs: 0`、`cacheScope: "private"`。`ServerOptions.cacheHints` で操作ごとに指定でき、試作では `tools/list` に `{ ttlMs: 300000, cacheScope: "private" }` を指定して、その値が返ることを確認した(決定5)。`tools/call` の結果には付かない。v2 Client はこの値に従って応答をキャッシュするため、`listTools()` を2回呼んでも POST は1回だった。
- **`Mcp-Method` / `Mcp-Name`**: v2 Client が自動で付与する(`tools/call` では `Mcp-Name: search`)。サーバー側では modern の要求 POST に対して**必須**であり、欠落も不一致もすべて **HTTP 400 と JSON-RPC `-32020`(HeaderMismatch)** になる。拒否された要求はハンドラに届かない(監査は正常系の1件だけだった)。

```
all headers: HTTP 200 code=-
no Mcp-Method: HTTP 400 code=-32020
no Mcp-Name: HTTP 400 code=-32020
no MCP-Protocol-Version: HTTP 400 code=-32020
Mcp-Name != params.name: HTTP 400 code=-32020
Mcp-Method != method: HTTP 400 code=-32020
header version != envelope: HTTP 400 code=-32020
```

  未対応の modern 版(envelope とヘッダが `2099-01-01`)は HTTP 400 と `-32022`(`data.supported: ["2026-07-28"]`)になる。`MCP-Protocol-Version` 欠落の拒否は 2.1.0 で入った修正(CHANGELOG #2590)で、2.0.0 では受理されていた。

### (ii) 旧フロー互換(v1 系 Client → v2 サーバー): 通った

`createMcpHandler` は既定(`legacy: 'stateless'`)で、同じエンドポイント・同じファクトリのまま 2025 年版の要求も処理する(`test/legacy.test.ts`)。

```
legacy wire [http, rpc, status]:
  [["POST","initialize",200],["POST","notifications/initialized",202],["GET","-",405],
   ["POST","tools/list",200],["POST","tools/call",200]]
```

- **v1 1.30.1 の `Client` と `StreamableHTTPClientTransport`**: `initialize` → `tools/list` → `tools/call` が通った。ネゴシエートされた版は **`2025-11-25`**(`transport.protocolVersion`)。
- **`mcp-session-id`**: 応答に**一切付かない**(`transport.sessionId` は `undefined`)。スタンドアロン SSE 用の GET は 405 で、v1 Client はこれを「GET ストリームなし」として許容する。DELETE も 405。v1 のステートレス構成とまったく同じ見え方になる。
- **v1 1.29.0**(このリポジトリの lock)の Client でも同様に接続でき、`2025-11-25` でネゴシエートされた。
- **2025 年版の応答**には `resultType` / `ttlMs` / `cacheScope` が付かない。v1 の結果スキーマは余分なフィールドを素通しするので、付いていればクライアント側で見えるはずだが、見えなかった。生の `tools/list` 結果のキーは `["tools"]` だけだった。
- **より古いクライアント**(生の JSON-RPC で再現): `initialize` で要求した版がそのまま返る(`2025-06-18` → `2025-06-18`、`2025-03-26` → `2025-03-26`、`2024-11-05` → `2024-11-05`)。`initialize` で `2026-07-28` を要求すると `2025-11-25` で返る。`mcp-protocol-version` ヘッダのない要求(2025-03-26 以前のクライアント)も、`2025-06-18` ヘッダ付きの要求も 200 で受理される。
- **v1 サーバーと挙動が変わる点**: modern 版を名乗るヘッダ(`2026-07-28`)を付けたのに envelope がない要求は、modern 経路で 400 / `-32602` になる(v1 1.30.1 では 400 / `-32000`)。`Accept` に `text/event-stream` がない要求は v1 と同じく 406 になる。
- **`legacy: 'reject'`(modern 専用)にすると、v1 Client は接続できない**: `initialize` が 400 / `-32022`(`supported: ["2026-07-28"]`)で拒否される。社外の 2025 年版クライアントを受け入れる間は、既定の `'stateless'` を変えてはならない。
- **逆方向(参考、T-005 / T-006 向け)**: v2 Client(`'auto'`)を v1 1.30.1 のステートレスサーバーにつなぐと、`server/discover` のプローブが 400 で拒否され、その後 `initialize` にフォールバックして `2025-11-25` で動く(`probe against v1 server: server/discover 400 then initialize`)。Gateway が MCP クライアントになる場合も、2025 年版しか話さない相手と会話できる。

### (iii) リクエスト単位認証とサーバーインスタンスの共有: 書ける。インスタンスは共有できない

- **authInfo / requestInfo の受け渡し**
  - ファクトリは `McpRequestContext`(`{ era, authInfo?, requestInfo? }`)を受け取る
  - ハンドラの `ctx` には `ctx.http.authInfo`(呼び出し側が渡した `AuthInfo` の素通し)、`ctx.http.req`(元の Web 標準 `Request`。`headers.get('authorization')` で読める)、`ctx.mcpReq.envelope` がある
  - SDK は `authInfo` をヘッダから自分で作らず、トークン検証もしない
  - `toNodeHandler` は `req.auth` を `authInfo` として渡す。v1 の `extra.authInfo` / `extra.requestInfo` に当たるのが `ctx.http?.authInfo` / `ctx.http?.req` である(移行ガイドの対応表どおり)
- **試作の書き方**(`src/http.ts`): HTTP の入口で毎リクエスト `Authorization: Bearer` を取り出し、`gateway.establishSession()` で本人を確定する。失敗したら MCP の処理に入る前に **HTTP 401**(`WWW-Authenticate: Bearer error="invalid_token"`)を返す。成功したら `AuthInfo.extra` にセッションを載せて `toNodeHandler` に渡し、ハンドラは `ctx.http.authInfo` から取り出す。生のセッショントークンは入口より内側に渡さない(`AuthInfo.token` には sessionId を入れる)。リクエストが終わったら `discardSession` を呼ぶ。
- **実測**
  - トークン欠落、未知のトークン、2025 年版の `initialize` のいずれも 401 になり、コネクタ呼び出しと監査レコードは 0 件だった
  - alice(v2 Client、2026 年版)と bob(v1 Client、2025 年版)の呼び出しを同じエンドポイントで並行に交互に流しても、コネクタが受け取った `userId` と監査レコードの `userId` は正しく振り分けられた
  - runId を申告しない呼び出しは、リクエストごとにセッションが変わるため**呼び出しごとに新しい runId、iteration 0** になる。決定3の「単発run」がそのまま得られる
- **サーバーインスタンスの共有: できない。** `createMcpHandler` はファクトリを**リクエストごとに**呼ぶ。modern は discover と call の2回、legacy は initialize、initialized、call の3回呼ばれた。ファクトリが同じインスタンスを返すようにすると次のようになる。

```
shared instance, 2 concurrent requests: ["timeout",200] onerror calls: 0
```

  逐次の要求は2回とも 200 で、一見動く。しかし**並行2要求では片方が応答を返さないままになり、`onerror` にも何も出ない**(黙ってハングする)。ファクトリが毎回新しいインスタンスを返せば、並行3要求はすべて 200 になった。v1 の「transport はリクエスト間で再利用できない(2回目は 500)」と比べると、壊れ方が見えにくくなっている。共有してよいのはファクトリ(ツール定義と Gateway 参照)だけで、インスタンスはリクエストごとに作る。これは設計規則として明文化し、テストで固定する必要がある。

### (iv) `_meta` の独自キー: 読める(両 era)

`test/meta.test.ts`(プロセス内で `handler.fetch` に `authInfo` を渡して実行)の結果:

```
modern ctx: {"paramsMeta":{"io.github.sunaot.leisen/runId":"run-x","io.github.sunaot.leisen/iteration":3},
  "ctxMeta":{...同じ...},"envelopeKeys":["io.modelcontextprotocol/protocolVersion",
  "io.modelcontextprotocol/clientInfo","io.modelcontextprotocol/clientCapabilities"],
  "authInfoClientId":"kp-gateway-edge","authorizationHeaderSeen":true,"sessionId":null, ...}
legacy ctx: {"paramsMeta":{...同じ...},"ctxMeta":{...同じ...},"envelopeKeys":[], ...}
```

- `io.github.sunaot.leisen/runId` と `io.github.sunaot.leisen/iteration` は、modern と legacy のどちらでも `request.params._meta` と `ctx.mcpReq._meta` の**両方**に同じ内容で届く。予約キー `io.modelcontextprotocol/*` だけが `_meta` から外され、`ctx.mcpReq.envelope` に移される(modern のみ)。したがって現行コードの `request.params._meta` 読みは、v2 でも動く。
- 実物の Gateway を通したフロー((i) と (ii))でも、prefix 付きキーで申告した runId と iteration が監査レコードに入った(modern `run-v2` / 2、legacy `run-v1` / 1)。
- `ctx.sessionId` は両 era とも `null`(ステートレス)。legacy のインスタンスはリクエストごとに作り直され `initialize` を見ていないため、`server.getNegotiatedProtocolVersion()` は `undefined` になる。版が必要なら、modern は `ctx.mcpReq.envelope`、legacy は `mcp-protocol-version` ヘッダを読む。

### (v) zod v4 / exactOptionalPropertyTypes / tsc strict: 通った(キャスト1箇所)

- **zod**: v2 の依存は `zod ^4.2.0` で、リポジトリの 4.4.3 に**重複なく集約**される。v1 1.30.1 と同じ依存木にいても zod は1コピーだった。移植コードの `z.looseObject` / `z.strictObject` はそのまま動く。
- **tsc strict と `exactOptionalPropertyTypes`**: 移植した `mcp.ts` はエラーなしで通った。v2 は `setRequestHandler('tools/list', …)` の戻り値をメソッド名から型付けする(型が厳しくなった)が、現行の `Tool[]` 注釈付きツール表は問題なかった。
- **v1 で必要だった回避策は不要になった**: `new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`(型が `| undefined` を明示している)、`server.connect(new NodeStreamableHTTPServerTransport(...))`、v2 Client の `connect(new StreamableHTTPClientTransport(...))` のいずれも**キャストなしで通る**。v1 で要った `as Transport` と、`sessionIdGenerator` を省略する回避は要らない。
- **残った不整合は1箇所**: `toNodeHandler()` が返すハンドラに Node の `IncomingMessage` を渡すと TS2379 になる。`NodeIncomingMessageLike.method?: string` と `@types/node` の `method?: string | undefined` が噛み合わないためで、理由コメント付きの型アサーション1つで回避した(`src/http.ts`)。
- **`skipLibCheck: false` でも**、エラーは v1 の `streamableHttp.d.ts`(1.30.1 / 1.29.0)からだけ出た。v2 の `.d.ts` 自体は厳格設定で問題ない。
- **型の変更点**: `CallToolResult.structuredContent` の型が `unknown` になった(v1 は `Record<string, unknown>`。2026-07-28 版では非オブジェクト値も許される)。サーバー側(Gateway)は影響なし。クライアント側(T-007 Orchestrator)で読むときは絞り込みが要る。
- TypeScript 6 以降は `"types": ["node"]` の追加が必要になる(v2 の README)。現行の 5.9.3 では不要。

## 4. 移行コスト見積り

### `packages/gateway/src/proxy/mcp.ts`(294 行)

移植版との差分は **+76 / −46 行**(コメントを含む)。このうち SDK v2 が原因の変更は約 20 行で、残りは追補3 の決定1〜4 によるものである。後者は v1 で配線する場合も必要になる。

| 項目 | v1(現行) | v2 | 原因 |
|---|---|---|---|
| import | `@modelcontextprotocol/sdk/server/index.js` と `/types.js`(`CallToolRequestSchema`、`ListToolsRequestSchema` など) | `@modelcontextprotocol/server` から `Server`、`CallToolResult`、`ServerContext`、`Tool` | SDK(codemod の対象) |
| Server 生成 | `new Server(info, { capabilities: { tools: {} } })` | 同じ。決定5 のために `cacheHints: { 'tools/list': { ttlMs, cacheScope: 'private' } }` を追加 | 同じ + 決定5 |
| ハンドラ登録 | `setRequestHandler(ListToolsRequestSchema, …)` | `setRequestHandler('tools/list', …)`、第2引数は `extra` から `ctx` へ | SDK(codemod の対象) |
| 結果の返し方 | `{ content, structuredContent }` | 同じ形。低水準 `Server` では `server.projectCallToolResult(result, undefined)` を通すのが v2 の作法(オブジェクトの `structuredContent` なら恒等変換)。`resultType` は SDK が付けるので手で付けない | SDK |
| エラー返却 | `isError: true` と正規化 JSON(TM-A2) | **変更なし**。低水準 `Server` ならツール名不明も自前の `invalid_request` のまま返せる(`McpServer` に移ると SDK が `-32602` で拒否する形に変わる)。`McpError` / `ErrorCode` は `ProtocolError` / `ProtocolErrorCode` / `SdkErrorCode` に改名されたが、`mcp.ts` では使っていない | — |
| セッション束縛 | コンストラクタ引数の `session`(1接続=1セッション)と `server.onclose` での破棄 | `ctx.http.authInfo` から取り出す。破棄は HTTP 入口でリクエストごとに行う | 決定1・2 |
| `_meta` | 接頭辞なしの `runId` / `iteration` | `io.github.sunaot.leisen/runId` と `/iteration`(`request.params._meta` も `ctx.mcpReq._meta` も読める) | 決定3・4 |
| `Server` クラス | `@deprecated`(`McpServer` を推奨) | 同じく `@deprecated`。新たな懸念ではない | — |

### HTTP 配線(T-003 残作業。v1 / v2 どちらでも新規)

- v1 の場合: リクエストごとに `new Server` と `new StreamableHTTPServerTransport({})` を組み立て、`as Transport` でキャストし、GET には手で 405 を返す(`sdk-protocol.test.ts` の `statelessListener` と同じ形)。2026-07-28 版の保留項目は保留のまま残る。
- v2 の場合: `createMcpHandler(factory)` と `toNodeHandler(handler)` だけで済む。GET / DELETE の 405、2つの era の振り分け、ヘッダ検証、`server/discover` は SDK が処理する。試作の `src/http.ts` は 88 行で、その大半は SDK に依存しない認証入口(Bearer 取り出し → `establishSession` → 401 / `authInfo` → `discardSession`)である。この入口のロジックは v1 でも同じで、v1 でも `req.auth` を `extra.authInfo` に渡せる。
- `createMcpHandler` は Host / Origin を検証しない(意図的な設計)。ブラウザから届く経路がある場合は、`@modelcontextprotocol/node` の `hostHeaderValidation` / `originValidation` を手前に置く。

### 依存

- `@modelcontextprotocol/sdk` を外し、`@modelcontextprotocol/server` と `@modelcontextprotocol/node`(peer に `hono`)を足す。テストと T-007 には `@modelcontextprotocol/client` も使う。
- v2 server の実行時依存は `zod` と `@modelcontextprotocol/core` だけで、ajv は同梱されている。v1 1.30.1 の依存は 17 個(express、cors、express-rate-limit、raw-body など)なので、依存面は小さくなる。hono と @hono/node-server は v1 も依存している。
- zod(4.4.3 は `^4.2.0` を満たす)、Node(>=20)、TypeScript(5.9)は変更不要。
- 公式 codemod(`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`)が import、`setRequestHandler`、`extra` → `ctx` を機械的に書き換える。ただし monorepo の workspace メンバーの package.json は書き換えないので、手で直す。

### テスト

- **`InMemoryTransport` 相当の手段**: v2 にも `InMemoryTransport` はある(`@modelcontextprotocol/server` か `/client` から。ペアは同じパッケージから取る)。ただし 2025 年版のインスタンスしかつなげない。2026-07-28 版をソケットなしでテストするには、`createMcpHandler` の `handler.fetch` を `StreamableHTTPClientTransport` の `fetch` オプションに差し込む(`test/meta.test.ts`)。`authInfo` は `handler.fetch(req, { authInfo })` で注入できる。
- **`mcp-proxy.test.ts`(208 行)**: 書き換えは主に接続ヘルパーで、約 15 行を `handler.fetch` のプロセス内接続と `authInfo` 注入に替える。`_meta` のキー名(1件)と import パスも変わる。`client.listTools()` / `callTool()` の API は同じなので、アサーションの大半はそのまま使える。
- **`sdk-protocol.test.ts`(606 行、8422ada)**: v1 固有なので置き換える。本スパイクの `test/*.test.ts`(約 590 行)が土台になる。
  - **注意**: v2 でも公開定数 `LATEST_PROTOCOL_VERSION` は `"2025-11-25"` のままである。`SUPPORTED_PROTOCOL_VERSIONS` も 2025 年版の一覧だけで、v1 1.30.1 と同一である。modern の一覧は内部定数 `SUPPORTED_MODERN_PROTOCOL_VERSIONS = ["2026-07-28"]` で、公開されていない。
  - そのため、定数を突き合わせる方式の (d) では v2 の modern 対応を検知できない。回帰テストは wire で観測して固定する(`server/discover` の `supportedVersions`、ヘッダ検証のエラーコード、legacy フローの往復)。`test/modern.test.ts` がその形になっている。
- **Gateway コア**(`gateway.ts`、`session.ts`、`types.ts`)は SDK に依存しないので、SDK 移行による変更はない。ただし SDK とは独立に、リクエスト単位認証にすると `GatewaySessionManager` の自動採番用 Map にセッションごとの項目がたまる。リクエストごとに `discardSession` を呼ぶ(試作ではこうした)か、決定3 に合わせて自動採番を整理する必要がある。

### 規模感

`mcp.ts` の SDK 起因の変更は小さい(約 20 行)。移行コストの本体は2つある。

1. HTTP 配線を v1 と v2 のどちらの API で書くか
2. v1 固有の回帰テスト(606 行)の置き換え

試作は合計 1027 行で、目安の 500 行を超えた。内訳は次のとおり。

- `src` 439 行: `gateway-mcp-v2.ts` 324 行(うち約 250 行は `mcp.ts` の原文コピーで、差分を測るため)、`http.ts` 88 行、`type-probes.ts` 27 行
- `test` 588 行

## 5. 判断材料の整理

### v1(1.30.1)で配線を続ける場合

- **v1 のままでも実装できるもの**: 決定1〜4、決定5 のうち `tools/list` のユーザー非依存、決定6、決定7(追補3「SDK更新の検証結果」の扱いのとおり)。
- **保留のまま残るもの**: `server/discover`、`resultType`、`ttlMs` / `cacheScope`、`Mcp-Method` / `Mcp-Name` の検証。
- **v2 に移るときの手戻り**
  - HTTP 配線のうち SDK を組み立てる部分(リクエストごとの `Server` と transport、`as Transport`、GET 405)は捨てて `createMcpHandler` / `toNodeHandler` に置き換える。数十行程度
  - `sdk-protocol.test.ts` は書き直す
  - `mcp.ts` の機械的な変更は、今やっても後でやっても量は同じ
  - 認証入口、セッション破棄、`_meta` の prefix は SDK に依存しないので、そのまま使える
  - 別エージェントが進めている v1 配線でも、SDK を組み立てる部分を1モジュールに隔離しておけば、手戻りはその中に収まる
- **期限**: SDK リポジトリの README は「v2 is the stable release line…」「**v1.x continues to receive bug fixes and security updates for at least 6 months after v2's release**」と述べている。v2(2.0.0)は 2026-07-27 公開なので、v1 の保守が保証されるのは**少なくとも 2027-01 下旬まで**である。README は v1 の 2026-07-28 版対応には触れていない。v1 に留まった場合、回帰テスト (d) は v2 の登場に反応しない(追補3 の指摘どおり。前節のとおり v2 の公開定数も変わらない)。

### v2 に移る場合

**前提**

- ADR の追補が要る。追補2「公式 TypeScript SDK を採用」の対象パッケージが変わり、追補3 の「SDK更新の進め方」(1.30.0 への更新 PR → HTTP 配線 PR)も差し替わる。CLAUDE.md の「現在のフェーズ」の該当記述も同様。人間の承認が要る。
- 2.1.0 を exact でピン留めし、本スパイクのテストを回帰テストとして移植する。
- `createMcpHandler` の `legacy` は既定の `'stateless'` を維持する。社外の 2025 年版クライアントを受け入れる間は `'reject'` にしない。
- インスタンスはリクエストごとに作る(ファクトリが毎回新しいインスタンスを返す)ことを規則にし、テストで固定する。
- T-007(Orchestrator)が v2 Client を使う場合の注意点
  - `versionNegotiation` を `'auto'` か `{ pin: '2026-07-28' }` にする。既定のままだと 2025 年版で話す
  - `tools/list` は `ttlMs`(既定 300000)の間クライアントがキャッシュする
  - SDK がキャッシュするのは list 系と `server/discover` だけ(`CACHEABLE_RESULT_METHODS`)で、`tools/call`(search / fetch)の結果は対象外。不変条件4 には抵触しない
  - キャッシュストアを利用者間で共有するなら `cachePartition` を設定する
  - `structuredContent` は `unknown` なので絞り込みが要る

**リスク**

- **v2 はまだ若い。** 2.0.0 は 2026-07-27、2.1.0 は 2026-09-23 の公開である。2.1.0 でも仕様準拠の修正が入った(`MCP-Protocol-Version` 欠落を受理していた #2590、本文サイズ上限 #2698、request id `0` の扱い #2654)。README には「v2 settles」まで PR を制限するとある。挙動が変わる前提で、exact ピン留めと wire レベルの回帰テストで守る必要がある。
- **共有インスタンスの誤用が黙ってハングする**((iii))。例外もエラー報告も出ない。
- **`createMcpHandler` は Host / Origin を検証しない。** 必要なら前段に置く。
- **`toNodeHandler` の型不整合**のためにキャストが1つ要る((v))。
- **API 面が大きい**(MRTR、`subscriptions/listen`、Tasks の語彙など)。Gateway が使うのは tools だけなので、影響は限られる。

**互換(最重要の判断材料)**

v2 サーバーは、v1 1.29.0 / 1.30.1 の Client、生の JSON-RPC で再現した 2024-11-05 / 2025-03-26 / 2025-06-18 のクライアントとも、同じエンドポイントで会話できた。

- セッション ID は発行されず、GET / DELETE は 405。v1 のステートレス構成と同じ見え方である
- `Accept` の厳格さ(406)も v1 と同じ
- 結果に 2026 年版のフィールドは混入しない

v1 サーバーと比べて社外クライアントに対する後退は見つからなかった。違いは、modern 版を名乗るヘッダを付けながら envelope がない要求のエラーコード(`-32000` → `-32602`)だけである。

## 6. ADR-001追補3 決定1〜7 との整合(v2 の場合)

1. **リクエスト単位認証**: 整合する。入口で毎リクエスト `Authorization` を検証し、`authInfo` の素通し経路(ファクトリの `ctx.authInfo`、ハンドラの `ctx.http.authInfo`)で受け渡せた。`server.onclose` には依存しない。
2. **インスタンスにユーザー状態を持たせない**: 整合する。ただしインスタンスは共有できない(並行時に黙ってハングする)。「共有可能なステートレス部品」はファクトリとツール定義のこととして読むのが正しい(v1 の申し送りと同じ結論)。
3. **runId / iteration は申告が基本**: 整合する。申告は両 era で監査まで届いた。未申告の呼び出しは、リクエストごとのセッションにより呼び出し単位の新しい runId と iteration 0 になった。自動採番のコードは実質使われなくなるので整理対象になる。
4. **`_meta` の prefix**: 整合する。`io.github.sunaot.leisen/*` はそのまま届く。SDK が外すのは `io.modelcontextprotocol/*` だけである。
5. **`tools/list` のユーザー非依存と `cacheScope: "private"` / `ttlMs` の注入**: 整合する。`cacheHints` で宣言でき、2026 年版の応答にだけ付く。未決事項として、`server/discover` の `cacheHints` をどうするかがある(既定は `ttlMs: 0`)。
6. **後方互換は SDK に委ねる**: 整合する。`createMcpHandler` の既定 `legacy: 'stateless'` が、同じファクトリで 2025 年版も処理する。Gateway 独自の互換レイヤは不要。
7. **非推奨機能は採用しない**: 整合する。v2 は Roots / Sampling / Logging を `@deprecated` とし、SSE サーバー transport を削除した(`server-legacy` へ移動)。どれも使っていない。

v1 で保留になっていた項目(`server/discover`、`resultType`、`ttlMs` / `cacheScope`、`Mcp-Method` / `Mcp-Name` の検証)は、v2 では `cacheHints` の設定を除いて SDK が自動で満たす。

## 7. 推奨(判断のための案。Status は決めない)

**案B(推奨)**: v2 に移ってから HTTP を配線する。

- **順序**
  1. ADR-001 追補(v2 採用、追補2 の見直し)のドラフトを書き、人間の承認を得る
  2. v2 移行 PR を出す。依存の差し替え、`mcp.ts` の移植、テストの移植(`handler.fetch` によるプロセス内テストと、`sdk-protocol.test.ts` に代わる wire レベルの回帰テスト)を含み、HTTP の配線は含めない
  3. HTTP 配線 PR を出す。`createMcpHandler`、`toNodeHandler`、認証入口、リクエスト単位の `discardSession` を含む
- **理由**
  - 最重要の判断材料である v1 系クライアントとの互換が、SDK 既定の legacy 経路で保たれることを実測で確認した
  - SDK 起因の変更は小さい(`mcp.ts` で約 20 行)
  - 今 v1 で配線すると、SDK を組み立てる部分と回帰テストは v1 の保守期限(2027-01 下旬以降)までに捨てることになる
  - 追補3 の保留項目は v2 で解消し、決定1・2 のリクエスト単位モデルは `createMcpHandler` の設計そのものである
- **条件**: 5 節「v2 に移る場合」の前提(exact ピン留め、回帰テストの移植、`legacy: 'stateless'` の維持、インスタンスをリクエストごとに作る規則、必要に応じた Host / Origin 検証)。

**案A(代替)**: v1 1.30.1 で配線を続け、v2 への移行を期限付きで計画する(v1 の保守期限より前に実施する)。

- **条件**: HTTP 配線のうち SDK を組み立てる部分を1モジュールに隔離し、認証入口、セッション破棄、`_meta` の扱いは SDK に依存しない形に保つ。そうすれば手戻りはその1モジュールと回帰テストに限られる。
- **向く状況**: 今は新しい依存の採用判断を避けたい、v2 の安定をもう一段待ちたい、という場合。

**人間に判断してほしい点**

1. v2 系を採用するか(ADR-001 追補2 の見直し)
2. 別エージェントが進めている v1 配線をどう扱うか(v2 で書き直すか、SDK 組み立て部の隔離を条件に継続して後で移すか)
3. 2025 年版クライアントをいつまで受け入れるか(`legacy: 'stateless'` をいつまで維持するか。仕様の非推奨窓と SDK の追随に合わせるか)

## 付録: 再現手順とファイル

```
npm ci
npm run build -w @kp/connector-sdk      # 試作が実物の Gateway コアを読み込むため(dist/ は gitignore 対象)
cd spikes/mcp-sdk-v2
npm install                             # 試作専用の依存。ルートの package-lock.json は変わらない
npm run typecheck                       # ルートの tsc 5.9.3、tsconfig.base.json を継承
npm test                                # ルートの vitest 4.1.9。4 ファイル 13 件
```

| ファイル | 内容 |
|---|---|
| `spikes/mcp-sdk-v2/src/gateway-mcp-v2.ts` | `mcp.ts` の v2 移植(差分で移行コストを測る) |
| `spikes/mcp-sdk-v2/src/http.ts` | `createMcpHandler` と `toNodeHandler`、リクエスト単位認証の入口 |
| `spikes/mcp-sdk-v2/src/type-probes.ts` | (v) の型検査プローブ |
| `spikes/mcp-sdk-v2/test/modern.test.ts` | (i)、modern 側の (iv)、v2 の公開バージョン定数 |
| `spikes/mcp-sdk-v2/test/legacy.test.ts` | (ii)(v1 1.30.1 / 1.29.0、古い版の生リクエスト、`legacy: 'reject'`、逆方向) |
| `spikes/mcp-sdk-v2/test/request-auth.test.ts` | (iii)(401、利用者の交互実行、インスタンス共有) |
| `spikes/mcp-sdk-v2/test/meta.test.ts` | (iv)(`_meta`、`ctx` の中身、両 era、プロセス内実行) |
| `spikes/mcp-sdk-v2/test/helpers.ts` | 実物の Gateway の起動、HTTP 往復の記録、生の POST |

一次情報: npm 配布物(`@modelcontextprotocol/server` / `client` / `core` / `node` 2.1.0 の README と `.d.ts`)、GitHub `modelcontextprotocol/typescript-sdk` main の `README.md`、`docs/migration/upgrade-to-v2.md`、`docs/migration/support-2026-07-28.md`、`packages/server/CHANGELOG.md`(いずれも 2026-09-27 取得)。
