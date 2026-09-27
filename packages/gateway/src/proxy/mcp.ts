/**
 * GatewayのMCPサーバー面(T-003、ADR-001)— MCP SDKとの接合部。
 *
 * 上流(Orchestrator)にはMCPサーバーとして4ツール(search / fetch / list /
 * describe)を公開し、実行はGatewayコア(認証注入・監査・レート制御)へ
 * 委譲する。MCPのリクエスト/レスポンスをここで横取りして監査と認証を注入する
 * (ADR-001 帰結)。
 *
 * SDK依存の閉じ込め: このモジュールはSDKの Server 生成・ハンドラ登録・AuthInfo・
 * 結果の形への写像だけを持つ。ツール定義・引数検証・`_meta` の解決・エラーの
 * 正規化・結果の直列化・fail-closed の判断は SDK 非依存の tools.ts / meta.ts / session.ts、
 * 監査はGatewayコア(gateway.ts)にある。SDKを差し替える(v1系 → 仕様
 * 2026-07-28版対応のv2系)ときの手戻りは本モジュールと http.ts のトランスポート
 * 部分に限られる。
 *
 * ステートレス(ADR-001 追補3 決定1・2): サーバーはユーザー状態を持たない部品で、
 * 利用者アイデンティティはリクエストごとに受け取る。トランスポート層(http.ts)が
 * JSON-RPCディスパッチ前にセッショントークンを検証し、検証済み Identity を SDK の
 * AuthInfo(ハンドラの extra.authInfo、gatewayAuthInfo())に載せて渡す。SDK 1.x の
 * Server は1トランスポートにしか接続できないため、HTTPではリクエストごとに
 * createGatewayMcpServer() で作り応答後に閉じる(SDKのステートレスモードの流儀)。
 * 生成関数はユーザー状態を受け取らないので、1インスタンスを複数ユーザーの
 * リクエストで共有しても混線しない。旧設計(追補2)の「確立済みセッションごとに
 * サーバーを作り、server.onclose でセッションを破棄する」前提は撤回した。
 *
 * 保留(SDK対応待ち): MCP仕様2026-07-28版固有の server/discover 応答、全結果への
 * resultType 付与、tools/list の ttlMs / cacheScope、Mcp-Method / Mcp-Name
 * ヘッダ検証は、現行SDK(v1系、LATEST_PROTOCOL_VERSION=2025-11-25)が未実装の
 * ため付与しない。Gateway独自の互換レイヤとして手実装しない(追補2「SDKは
 * プロトコル層のみ」・追補3 決定6)。
 *
 * 下流(コネクタ)は現時点でin-processの Connector 実装(connector-sdk)を
 * 呼ぶ。外部プロセスのMCPサーバー型コネクタ(Slack公式MCP等、ADR-014)は
 * Connector IFを実装するMCPクライアントアダプタとして各コネクタタスク
 * (T-005/T-006)で追加する。IF境界は変えない(不変条件5)。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "../idp/types.js";
import type { Gateway } from "./gateway.js";
import { listTools, runToolCall, type ToolCallOutcome } from "./tools.js";
import { GATEWAY_REJECTION_ERROR_CODE } from "./types.js";

export const GATEWAY_SERVER_INFO = {
  name: "kp-gateway",
  version: "0.1.0",
} as const;

/**
 * AuthInfo.extra 上の検証済み Identity のキー。AuthInfo はプロセス内でのみ
 * 受け渡され(HTTP層 → SDKトランスポート → ハンドラ)、ワイヤーには載らない
 * (クライアントが設定する手段はない)。
 */
const IDENTITY_AUTH_EXTRA_KEY = "kp.gateway/identity";

/**
 * AuthInfo.token に入れる固定値(秘密情報ではない)。SDK の AuthInfo は token を
 * 必須とするが、Gateway 内で token を読む箇所はない(本人は extra の Identity で
 * 渡す)。セッショントークンを載せると、SDK 内部やハンドラの extra 経由で秘密情報の
 * 複製が増えるだけなので載せない(不変条件6)。
 */
export const GATEWAY_AUTH_INFO_TOKEN = "kp-gateway-authenticated";

/**
 * gatewayAuthInfo() が発行した extra オブジェクト。identityFromAuthInfo はこれに
 * 含まれる(= このモジュールが認証成功後に作った)extra だけを信用し、他の経路で
 * 組み立てられた AuthInfo(形が同じでも)を本人の根拠にしない。WeakSet のため
 * リクエスト処理が終われば GC で消える(ユーザー状態を保持しない)。
 */
const ISSUED_AUTH_EXTRAS = new WeakSet<object>();

/**
 * 検証済み Identity をリクエストハンドラへ渡す SDK の AuthInfo を作る。
 * トランスポート層が IdpAdapter.authenticate に成功した後にのみ呼ぶこと。
 * token は固定の非秘密値(GATEWAY_AUTH_INFO_TOKEN)。Identity(セッション
 * トークンを含む。不変条件6: このオブジェクトをログ・エラーへ出さない)は extra で
 * 渡す。clientId / scopes は Gatewayの認証(IdpAdapter)に対応する概念がないため空にする。
 */
export function gatewayAuthInfo(identity: Identity): AuthInfo {
  const extra = { [IDENTITY_AUTH_EXTRA_KEY]: identity };
  ISSUED_AUTH_EXTRAS.add(extra);
  return {
    token: GATEWAY_AUTH_INFO_TOKEN,
    clientId: "",
    scopes: [],
    extra,
  };
}

function identityFromAuthInfo(
  authInfo: AuthInfo | undefined,
): Identity | undefined {
  const extra = authInfo?.extra;
  if (extra === undefined || !ISSUED_AUTH_EXTRAS.has(extra)) {
    // gatewayAuthInfo() が発行していない AuthInfo は信用しない
    return undefined;
  }
  const candidate = extra[IDENTITY_AUTH_EXTRA_KEY];
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const { userId, session } = candidate as Partial<Identity>;
  // gatewayAuthInfo() 以外の経路で組み立てられた不完全な値は信用しない
  return typeof userId === "string" &&
    userId !== "" &&
    typeof session === "object" &&
    session !== null &&
    typeof session.subjectToken === "string"
    ? (candidate as Identity)
    : undefined;
}

/**
 * SDK非依存の結果を MCP の CallToolResult に写す(エラーはツール結果内で返す)。
 * 直列化は tools.ts(runToolCall)で済んでおり、ここでは直列化済みの text を載せる
 * だけにする(直列化の失敗を SDK の生の例外メッセージとして返さない)。
 */
function toCallToolResult(outcome: ToolCallOutcome): CallToolResult {
  if (!outcome.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: outcome.text }],
    };
  }
  return {
    content: [{ type: "text", text: outcome.text }],
    structuredContent: outcome.result as unknown as Record<string, unknown>,
  };
}

/**
 * Gatewayを公開するMCPサーバーを作る。ユーザー状態を受け取らない純粋な部品で、
 * 利用者はリクエストごとに extra.authInfo(gatewayAuthInfo)から解決する。
 */
export function createGatewayMcpServer(gateway: Gateway): Server {
  const server = new Server(GATEWAY_SERVER_INFO, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const outcome = listTools(gateway, identityFromAuthInfo(extra.authInfo));
    if (!outcome.ok) {
      throw new McpError(GATEWAY_REJECTION_ERROR_CODE, outcome.error.message, {
        errorClass: outcome.error.errorClass,
      });
    }
    return { tools: outcome.tools };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> =>
      toCallToolResult(
        await runToolCall(gateway, {
          identity: identityFromAuthInfo(extra.authInfo),
          name: request.params.name,
          arguments: request.params.arguments,
          meta: request.params._meta,
        }),
      ),
  );

  return server;
}
