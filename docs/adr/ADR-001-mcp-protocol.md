# ADR-001: コンポーネント間プロトコルとしてMCPを採用する

Status: Accepted / Date: 2026-07-04

## 文脈
LLMエージェントと各データソースコネクタの接続方式を標準化する必要がある。独自RPC、OpenAPIベースのツール定義、MCPが候補。

## 決定
Model Context Protocol (MCP) を採用する。各コネクタは1ソース=1 MCPサーバーとして実装し、GatewayがMCPクライアント/プロキシとして単一経路を成す。

## 理由
- エコシステム標準であり、公式・サードパーティのMCPサーバーを再利用できる
- 将来、社外のLLM製品・エージェント製品からも同じコネクタ群を利用可能
- ツールスキーマの自己記述性がOrchestratorのツール選択品質に寄与

## 帰結
- 公式MCPサーバーが本人トークンでの認可要件を満たす場合はそれを使い、満たさない場合のみ自前実装する(採用判断はコネクタごとにADR追記)
- Gateway は MCP のリクエスト/レスポンスを横取りして監査ログと認証を注入する

## 追補(2026-07-05)
「公式・サードパーティのMCPサーバーを再利用できる」の期待値を調整する。既存MCPサーバーの多くは自前でOAuthとトークン管理を行い、Gatewayが注入する本人資格情報・監査・未認可候補境界(ADR-012)・deployment.yamlと整合するとは限らない。**再利用候補として評価するが、整合しない場合はラップまたは自前実装を前提に見積もる。** 初の有力な採用候補はSlack公式MCPサーバー(ADR-014)。また、MCPは接続の標準であって下流SaaSの本人トークン取得・保管・失効同期を解くものではなく、GatewayにはMCPセッションと利用者アイデンティティの束縛設計が必要(T-003)。

## 追補2(2026-07-12): プロトコル実装として公式TypeScript SDKを採用(T-003)

GatewayのMCPサーバー/クライアント面の実装に `@modelcontextprotocol/sdk`(公式TypeScript SDK)を新規依存として採用する。

- 理由: プロトコルのフレーミング・ライフサイクル・型定義を自前実装しない。公式SDKはMCP仕様の参照実装であり、仕様改訂への追随コストをSDK更新に集約できる
- 使い方の制約: SDKは**プロトコル層のみ**に使う。認証・監査・レート制御・snippet truncateはGatewayコア(`packages/gateway/src/proxy/gateway.ts`)に置き、SDKのハンドラは薄い変換層に留める。SDK内蔵のOAuth/認可ヘルパーは使わない(認可方式はADR-010、セッション束縛はT-003の設計に従う)
- セッション束縛: MCPサーバーインスタンスは「確立済みGatewaySessionごと」に作る(1接続=1セッション)。トランスポート層でセッショントークンを検証してからサーバーを接続する
- 監査コンテキスト: Orchestrator(T-007)は runId / iteration をMCPリクエストの `_meta` で申告する(ツール引数スキーマをLLM向けに汚さない)。未申告時はGatewayがセッション単位で自動採番する
- 下流(コネクタ)は現時点でin-processの Connector IF(connector-sdk)呼び出し。外部プロセスのMCPサーバー型コネクタは、Connector IFを実装するMCPクライアントアダプタとして各コネクタタスクで追加する(IF境界は不変、不変条件5)

## 追補3(2026-08-15): MCP仕様2026-07-28版(ステートレス)を設計前提とする

Status: Accepted(2026-09-27 人間レビュー完了・承認。決定4のprefixは暫定値で承認、最終確定はT-013)

背景は `docs/mcp-spec-2026-07-28-review.md` を参照。仕様2026-07-28版はプロトコルレベルのセッションと `initialize` ハンドシェイクを廃止し、ステートレス化した。トランスポート未配線・Orchestrator(T-007)未着手の現段階で旧ステートフル前提を実装する理由がないため、以降のMCP実装は2026-07-28版を設計前提とする。

### 決定

1. **リクエスト単位認証。** 追補2の「1接続=1セッション」を置き換える。Streamable HTTP配線(T-003)では毎リクエストの `Authorization` ヘッダでセッショントークンを検証し、`GatewaySession` を接続ではなくリクエストから解決する。トークン検証コストはIdP検証キャッシュ(userId込みキー、`idp/cache.ts`)で吸収する。`server.onclose` によるセッション破棄前提は撤回する。
2. **MCPサーバーインスタンスにユーザー状態を持たせない。** インスタンスは共有可能なステートレス部品とし、ユーザーコンテキストはリクエストごとに引き渡す。
3. **runId / iteration は Orchestrator の申告を基本とする(ADR-011整合)。** 追補2の「未申告時はセッション単位で自動採番」はクロスコール状態となるため廃止し、T-007の受け入れ条件として `_meta` での申告を必須化する。未申告の呼び出しは単発run(呼び出し単位の新規runId、iteration=0)として記録し、run内の継続性は保証しない。**→ ADR-019(2026-10-09 Accepted)で runId の発行主体は Gateway(run API の `POST /runs`、HMAC 署名付き)に移る。iteration は Orchestrator の申告のまま。ステートレスの前提は署名による検証で保つ**
4. **`_meta` 独自キーに名前空間prefixを付ける。** プロトコル自身が `io.modelcontextprotocol/*` を使うため、`runId` / `iteration` は prefix付きキーへ移行する。**prefixは暫定で `io.github.sunaot.leisen/` とする**(2026-09-27、リポジトリオーナー確認。配布サイト未定のため暫定)。OSS公開前に配布名と併せて最終確定し、変更する場合は移行期間中に旧prefixも受ける。最終確定はT-013(OSS公開準備)の公開チェックリスト項目として管理する。
5. **`tools/list` はユーザー非依存を不変条件として明文化する。** 有効ソースはdeployment.yaml由来であり、ユーザーごとに内容を変えない(ソース可視性で認可状態を漏らさない。ADR-012と同方向。仕様上もlist系の接続非依存が必須)。新仕様で必須の `cacheScope` は `"private"` 固定、`ttlMs` はdeployment.yamlから注入する(既定値 300000)。
6. **後方互換はSDKのバージョンネゴシエーションに委ね、Gateway独自の互換レイヤは作らない。** 旧版クライアント(社外エージェント製品を含む)との会話は非推奨窓の間SDKが成立させる。非推奨窓終了後の旧版サポート打ち切りはSDK更新に追随する。
7. **非推奨機能(Roots / Sampling / Logging、HTTP+SSE)は採用しない。** 現状も未使用であり、新規実装に持ち込まない。

### SDK更新の進め方

`@modelcontextprotocol/sdk` は1.30.0(2026-07-28版対応)へ更新するが、本追補の承認後に別PRで行う。更新PRの検証項目: (a) 旧版クライアントとのネゴシエーションとStreamable HTTPセッションヘッダの実挙動、(b) `resultType` の自動付与、(c) `CacheableResult`(`ttlMs`/`cacheScope`)の返却経路、(d) ネゴシエートされたプロトコルバージョンを固定値と突き合わせる回帰テストの追加(SDK更新時に必ずレビューが走るようにする)。

### SDK更新の検証結果(2026-09-27)

本節は上記「SDK更新の進め方」の検証結果の記録であり、決定1〜7は変更しない。

`@modelcontextprotocol/sdk` を 1.29.0 から **1.30.1**(2026-09-23、npm の latest)に更新し、`packages/gateway/package.json` で exact 指定にピン留めした。caret を廃止したのは、lock の再生成や `npm update` で黙って上がるのを防ぎ、下記の回帰テストと併せて意図的な更新を強制するため(`docs/mcp-spec-2026-07-28-review.md` §C-2)。

**前提の訂正: `@modelcontextprotocol/sdk` 1.30.x は仕様2026-07-28版を実装していない。** 1.30.0(2026-07-27)は保守リリース(Zod validation 修正、Content-Type 検証の改善、Streamable HTTP の SSE keep-alive 修正、依存と CI の更新)である。1.30.1 の配布物でも `LATEST_PROTOCOL_VERSION` は `2025-11-25`、`SUPPORTED_PROTOCOL_VERSIONS` は `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07` のまま。`server/discover`・`Mcp-Method`・`Mcp-Name`・`resultType`・`ttlMs`・`cacheScope`・`subscriptions/listen` は実装されておらず、`Mcp-Session-Id` の処理は残っている。「SDK更新の進め方」にある「1.30.0(2026-07-28版対応)」は誤りだった。

review が「リリース即日対応」とした公式 TypeScript SDK の対応版は、v2 系の分割パッケージ(`@modelcontextprotocol/server` / `@modelcontextprotocol/client` / `@modelcontextprotocol/core`)とみられる。同じ `modelcontextprotocol/typescript-sdk` リポジトリから、2.0.0 が 2026-07-27、2.1.0 が 2026-09-23 に公開されている。2.1.0 の配布物には、2026-07-28 版の要素(`server/discover`、`Mcp-Method` / `Mcp-Name`、`resultType`、`ttlMs` / `cacheScope`、`subscriptions/listen`)が 2025 年版の旧フローと並んで含まれる。これは配布物の検索で確認しただけで、挙動は検証していない。

検証項目の結果(SDK 1.30.1、回帰テスト `packages/gateway/test/sdk-protocol.test.ts`):

- **(a) 旧版クライアントとのネゴシエーション、Streamable HTTP のセッションヘッダ**
  - SDK の Client は `initialize` で常に `2025-11-25` を要求し、その版でネゴシエートされる
  - 旧版(`2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07`)を要求するクライアントには、要求された版で応答する。未知の版(`2026-07-28` を含む)を要求されると `2025-11-25` で応答する
  - `StreamableHTTPServerTransport` のステートレスモード(`sessionIdGenerator` 未指定)は、`initialize` を含むどの応答にも `mcp-session-id` を付けない。クライアントも送らない
  - `initialize` 以降の要求は、ネゴシエート済みの版を `mcp-protocol-version` ヘッダで運ぶ。ヘッダのない要求(2025-03-26 以前のクライアント)も受理される。SUPPORTED 外の版(`2026-07-28`)を名乗るヘッダは HTTP 400 で拒否される
- **(b) `resultType` の自動付与**: 行われない。結果スキーマにもこのフィールドはない
- **(c) `CacheableResult`(`ttlMs` / `cacheScope`)の返却経路**: SDK には型も自動付与もない。結果スキーマはルーズなので、ハンドラが返した追加フィールドは型検証されずにそのまま通る。現時点の経路はこれだけである
- **(d) 回帰テスト**: ネゴシエートされた版を固定値 `2025-11-25` と突き合わせ、`SUPPORTED_PROTOCOL_VERSIONS` も定数と突き合わせる。SDK の版が変わると失敗し、更新PRのレビューを強制する。SDK を改変して `2026-07-28` を名乗らせると6件失敗することを確認した

**扱い(決定6に沿う):** 後方互換と版の選択は SDK のネゴシエーションに委ね(決定6)、Gateway 独自に 2026-07-28 版を話す層は作らない。したがって次のとおり扱う。

- 決定1〜3、決定4、決定5のうち `tools/list` のユーザー非依存、決定6、決定7は、現行 SDK(2025-11-25 版)のステートレスモードで実装する
- 仕様2026-07-28版に固有の項目(`Mcp-Method` / `Mcp-Name` ヘッダの検証、`server/discover`、`resultType`、決定5後半の `ttlMs` / `cacheScope`)は、**対応 SDK を採用するまで保留する**。2025-11-25 版でネゴシエートしている間は、ハンドラで手付けしない
- v1 系(`@modelcontextprotocol/sdk`)が 2026-07-28 版に対応すれば、回帰テストが失敗して検知する。ただし対応が v2 系でしか提供されない場合、v1 系の回帰テストは反応しない。v2 系への移行は依存パッケージと API の変更を伴う(追補2 の SDK 採用の見直しになる)ため、別途判断する

HTTP配線PRへの申し送り(SDK 1.30.1 の実挙動):

- ステートレスな transport はリクエスト間で再利用できない(2回目は HTTP 500)。`Server` も同時に1つの transport にしか接続できない。決定2の意図(インスタンスにユーザー状態を持たせない)は変わらないが、実装は「ユーザー状態を持たないサーバー生成処理を共有し、`Server` と transport はリクエストごとに組み立てる」形になる
- GET(スタンドアロン SSE)には 405 を返してよい。SDK の Client は 405 を「GET ストリームなし」として扱う
- SDK の HTTP トランスポートの型定義は、本リポジトリの `exactOptionalPropertyTypes` と噛み合わない(1.29.0 から同じ)。`{ sessionIdGenerator: undefined }` は型エラーになり、transport をそのままでは `Transport` IF の引数に渡せない。プロパティの省略(実行時は同一)と、理由コメント付きの `as Transport` で回避できる
- 1.30.x で transport のオプションに `keepAliveMs`(SSE keep-alive、既定 15000ms)と `maxRequestBodySize`(既定 4MiB、超過は 413)が加わった。既定値のままにするかは配線PRで判断する
- T-005 / T-006 で Gateway が MCP クライアントになる場合も、SDK の Client は `2025-11-25` を要求する。接続先 MCP サーバーの対応版は、review §D のとおり着手時に確認する

**人間への確認依頼:** 追補3 承認時の前提(1.30.0 が 2026-07-28 版に対応)が変わったので、再確認を求める。確認したいのは、上記の扱い(v1 系の現行 SDK で配線し、新仕様固有の項目は保留)で進めるか、v2 系への移行を先に検討するかである。

**追記(2026-09-27、スパイク結果):** v2 系(2.1.0)への移行スパイク `docs/spikes/mcp-sdk-v2-migration-spike.md` を実施した。要点: v2 の `createMcpHandler` は既定(`legacy: 'stateless'`)で v1 系クライアント(1.29 / 1.30、2025-11-25 版の initialize フロー)もそのまま受ける、`server/discover` / `resultType` / `ttlMs` / `cacheScope` / `Mcp-Method` / `Mcp-Name` は SDK が自動で満たす、`mcp.ts` の移植差分は小さい(SDK 起因は約20行)、v1 系の保守は v2 公開(2026-07-27)から少なくとも6か月保証。HTTP 配線(T-003)は v1 で完了済みで SDK 依存部は隔離してあるため、確認したいのは「**v2 移行 PR をいつ行うか**」(追補2 の SDK 採用の見直しを伴う。移行時は 2.1.0 を exact 指定し、定数突き合わせではなく実通信で固定する回帰テストに置き換える)。
