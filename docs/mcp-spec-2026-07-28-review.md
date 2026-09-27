# レビュー: MCP仕様 2026-07-28版のリポジトリへの影響

Date: 2026-08-15 / Status: レビュー結果(ADR-001追補3 は 2026-09-27 に承認済み。推奨アクション1は完了、2〜4はT-003残作業として着手可能)

## 対象と現状

- レビュー対象: [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)(前版 2025-11-25 からの改訂)
- 本リポジトリの現状:
  - MCP依存は `packages/gateway` の `@modelcontextprotocol/sdk` `^1.29.0` の1箇所のみ(lockは1.29.0固定)。connector-sdkはMCP非依存
  - 使用機能は **tools のみ**(`ListToolsRequestSchema` / `CallToolRequestSchema` の2ハンドラ、`packages/gateway/src/proxy/mcp.ts`)。resources / prompts / sampling / elicitation / roots / logging / notifications / subscribe は未使用
  - **トランスポート未配線**(stdio / Streamable HTTP / SSE いずれもプロダクションコードになし。テストのみ `InMemoryTransport`)
  - プロトコルバージョン文字列のピン留め・アサートはコードに存在せず、ネゴシエーションはSDK既定に完全委譲(ADR-001追補2の方針)
  - SDKのOAuth/認可ヘルパーは不使用(独自IdP層、ADR-001追補2 / ADR-010)

## 結論(サマリ)

**即時に壊れるものはなく、緊急のコード変更は不要。** 非推奨化された機能(Roots / Sampling / Logging / HTTP+SSE)をひとつも使っておらず、トランスポートも未配線のため、破壊的変更の大半は現時点で当たらない。

ただし **T-003の残作業(HTTPトランスポート配線とセッション束縛)が旧ステートフル前提で設計されており、実装前にADR-001の改訂(追補3)が必要**。ここが今回の仕様改訂の最大の影響点。加えて、小さな先回り対応が2点(`_meta`キーの名前空間、SDKバージョン管理)ある。

## 仕様変更の要点(本リポジトリに関係するもののみ)

1. **ステートレス化**: `initialize`/`notifications/initialized` ハンドシェイク廃止。`Mcp-Session-Id` ヘッダ廃止。毎リクエストが `_meta` にプロトコルバージョン・クライアントcapabilitiesを運ぶ(`io.modelcontextprotocol/protocolVersion` 等)。サーバーは `server/discover` RPC実装が必須(SEP-2575)
2. **list系エンドポイントの接続非依存化とキャッシュ可能化**: `tools/list` 等は接続ごとに内容を変えてはならず、結果に `ttlMs` と `cacheScope`(`"public"` / `"private"`)が必須(SEP-2567 / SEP-2549)
3. **全結果に `resultType` 必須**(`"complete"` / `"input_required"`)。サーバー発リクエスト(sampling / elicitation / roots)はMRTR(Multi Round-Trip Requests)パターンに置換(SEP-2322)
4. **Streamable HTTP強化**: POSTに `Mcp-Method` / `Mcp-Name` ヘッダ必須(HTTP層でメソッド・ツール名が見える)。GETエンドポイントと `resources/subscribe` は `subscriptions/listen` に置換。SSE再開(`Last-Event-ID`)廃止
5. **認可強化**: RFC 9207 `iss` 検証必須(クライアント側)、資格情報のissuer束縛、Dynamic Client Registration非推奨→Client ID Metadata Documents(CIMD)へ移行
6. **非推奨化**: Roots / Sampling / Logging、HTTP+SSEトランスポート。12ヶ月以上の非推奨窓を持つfeature lifecycleポリシーが正式化
7. **Tasks拡張**: 実験的tasksがコアから公式拡張(`io.modelcontextprotocol/tasks`)へ。ポーリング型(`tasks/get`)に再設計
8. **エラーコード再配置**: `-32000`〜`-32019` は実装定義、`-32020`〜`-32099` はMCP仕様予約

SDK対応: TypeScript SDKは新仕様にリリース即日対応(Tier 1)。npm上の `@modelcontextprotocol/sdk` 1.30.0(2026-07-27リリース)が対応版とみられる(採用前に要確認)。

## 影響評価

### A. 影響なし(未使用のため)

| 仕様変更 | 判定 |
|---|---|
| Roots / Sampling / Logging 非推奨化 | 未使用。対応不要 |
| HTTP+SSEトランスポート非推奨化 | 未使用。対応不要 |
| `subscriptions/listen` / GET廃止 / SSE再開廃止 | notifications・subscribe未使用。対応不要 |
| MRTR(elicitation / sampling置換) | 未使用。対応不要 |
| MCPレベルOAuthの変更(サーバー面) | SDKの認可ヘルパー不使用(独自IdP層)。Gatewayサーバー面は影響なし |

### B. T-003実装前に設計判断が必要(要ADR-001追補3)— 最重要

**B-1. セッション束縛モデルとステートレス化の衝突。**
現行設計は「1接続=1セッション」: MCPサーバーインスタンスを確立済み `GatewaySession` ごとに生成し、`server.onclose` でセッション破棄(`mcp.ts:236-294`、ADR-001追補2、TM-C6対応)。`mcp.ts:9-12` のコメントは「トランスポート層(HTTPのAuthorizationヘッダ等)でセッショントークンを受けてから本サーバーを接続する」という**接続単位の認証**を想定している。

2026-07-28版ではプロトコルレベルのセッションが消え、Streamable HTTPは毎リクエスト独立になる。よってT-003のHTTP配線をこのまま実装すると、配線した瞬間に旧仕様(2025-11-25以前)前提の実装になる。

一方でこれは本プロダクトにとって**むしろ好都合**な方向の変更である:

- 「毎リクエストにAuthorizationヘッダ → リクエスト単位で本人を認証」は不変条件1(認可は常に本人の資格情報で)と自然に整合する。接続にアイデンティティを持たせるより、TM-C6(セッション乗っ取り)の攻撃面も小さい
- ロードバランサ配下でのスケールアウトにsticky sessionが不要になる

**要再設計の点**: `GatewaySessionManager` のセッション単位の runId/iteration 自動採番(ADR-011)はクロスコール状態であり、ステートレスモデルでは置き場がない。新仕様の流儀は「サーバー発行のハンドルを通常のツール引数/`_meta`で受け渡す」。対応候補: (a) Orchestrator(T-007)側の runId/iteration 申告を必須化する、(b) Gatewayが初回に採番した runId をクライアントに返し以後申告させる。いずれもADR-011との整合確認が必要。

**B-2. `tools/list` のキャッシュ可能化と不変条件の明文化。**
現行の `toolDefinitions(gateway.enabledSourceIds())` は deployment.yaml 由来の有効ソースを enum で自己記述しており、**ユーザー非依存・接続非依存**(`mcp.ts:160-166, 244-246`)。新仕様の「list系は接続ごとに変えない」に既に適合している。ただし:

- 新仕様では `ttlMs` / `cacheScope` の値の決定が必要になる。**`cacheScope: "private"` を推奨**(単一テナントでも、認証済みGateway応答を共有中間キャッシュに乗せない。ADR-012の防御的な既定として)
- 「`tools/list` を将来ユーザーごとに変えない(ソースの可視性で認可状態を漏らさない)」ことを制約として明文化しておくべき。仕様上も接続非依存が必須になったため、per-userのソース絞り込みという設計選択肢は正式に閉じた — これはADR-012(件数も含め未認可候補を出さない)と同じ方向

**B-3. Streamable HTTP配線時の新要件**(T-003実装時のチェックリスト): `Mcp-Method` / `Mcp-Name` ヘッダの検証(HeaderMismatchError `-32020`)、`server/discover` 応答、`resultType: "complete"` 付与、`CacheableResult` フィールド。これらは対応版SDKが大半を吸収するはずだが、受け入れ条件に含めること。なお `Mcp-Method` / `Mcp-Name` がHTTP層で見えることは、Gatewayの監査・レート制御・認可の前段判定(JSON-RPCボディのパース前にツール名で振り分け)に利用できる利点でもある。

### C. 小さな先回り対応(仕様改訂と独立に今やって損がない)

**C-1. `_meta` キーの名前空間衝突回避。**
`runId` / `iteration` を接頭辞なしの裸キーで `_meta` から読んでいる(`mcp.ts:75-79, 147-158`)。新仕様ではプロトコル自身が `_meta` を `io.modelcontextprotocol/*` 名前空間で多用するようになった。仕様の `_meta` キー規約に沿って独自prefix付きキー(例: `dev.kp-gateway/runId`)へ移行し、移行期間は裸キーも受ける後方互換を持たせることを推奨。ADR-011の該当記述も更新する。

**C-2. SDKバージョン管理とバージョン検知テスト。**
`^1.29.0` のcaret範囲には新仕様対応版の1.30.0が入る。現在はpackage-lockが1.29.0を固定しているが、lock再生成や `npm update` で**黙って**新仕様対応SDKに上がる。プロトコルバージョンをアサートするコード・テストが1つもないため(ADR-001「追随コストをSDK更新に集約」の方針の裏面)、上がったことを検知できない。推奨:

- SDK更新は意図的に行う(当面1.29.0系に固定し、1.30.0の挙動 — 旧クライアントとのネゴシエーション互換、`resultType` の自動付与等 — を検証してから上げる)
- ネゴシエートされたプロトコルバージョンを固定値と突き合わせる回帰テストを1本追加し、SDK更新時にレビューが必ず走るようにする

### D. 将来タスクへの影響(今は着手しない)

- **T-005/T-006(MCPクライアントアダプタ)**: Gatewayがクライアントとして外部MCPサーバー(Slack公式MCP等)を叩く際、クライアント側の認可要件が変わる(`iss` 検証必須、資格情報のissuer束縛、DCR→CIMD)。対応版SDKが処理するはずだが、**Slack公式MCPサーバーがどの仕様版に追随しているか**をT-006着手前の法務確認と併せて確認する。ADR-014の前提(公式MCP第一候補)自体は変わらない
- **ADR-015(実行区分)**: 長時間実行はTasks公式拡張(`io.modelcontextprotocol/tasks`、ポーリング型)が標準になった。Phase 1はhuman-in-the-loopのみなので影響なし。scheduled / autonomous を解禁するPhase 2の設計時に評価する
- **T-007(Orchestrator)**: B-1の帰結として runId/iteration の申告が必須化される可能性がある。T-007の受け入れ条件に反映する
- **feature lifecycleポリシー**(12ヶ月以上の非推奨窓)により、今後の追随は計画的に行える。四半期ごとに仕様のdeprecated registryを確認するのが現実的

## 推奨アクション(優先順)

1. **ADR-001追補3のドラフト作成**(要人間レビュー): T-003のHTTP配線を2026-07-28版前提(リクエスト単位認証・ステートレス・`cacheScope: "private"`)で設計する決定。B-1のrunId採番の扱いを含む。**承認までT-003のトランスポート配線に着手しない**
2. `_meta` キーの名前空間移行(C-1)— 小さい変更、後方互換つき
3. プロトコルバージョン回帰テストの追加(C-2)
4. SDKは当面1.29.0系に固定し、1.30.0への更新は上記1の決定後に別PRで実施
5. T-006着手時: Slack公式MCPの対応仕様版を確認(D)

## 参考

- [公式チェンジログ 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [リリースブログ](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- 関連ADR: ADR-001(MCP採用・SDK)、ADR-011(監査2層・runId)、ADR-012(未認可候補境界)、ADR-014(Slack公式MCP)、ADR-015(実行区分)
- 関連脅威: TM-C6(MCPセッションと利用者アイデンティティの束縛不備)
