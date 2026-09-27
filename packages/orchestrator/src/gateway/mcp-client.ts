/**
 * GatewayClient の MCP 実装(T-007)。Gateway の Streamable HTTP エンドポイント
 * (既定 `POST /mcp`)に公式 SDK の Client + StreamableHTTPClientTransport で接続する。
 *
 * - 認証: 毎リクエストの `Authorization: Bearer <セッショントークン>`
 *   (requestInit.headers)。Gateway はリクエストごとに検証する(ADR-001 追補3 決定1)
 * - セッショントークンは秘密情報(不変条件6): ログ・エラー・例外メッセージに出さない。
 *   トークンと SDK クライアントは ES の private フィールドに持ち、JSON 化・inspect の
 *   対象にしない。例外は固定文言の GatewayClientError に写し、SDK の例外メッセージ
 *   (応答本文を含みうる)を流さない
 * - ツール結果の isError は正規化エラー(本文の JSON の errorClass / message)に写す
 * - 接続(initialize)は最初の呼び出しで1回だけ行い、以降の要求で使い回す。
 *   Gateway はステートレスなので、接続の使い回しにユーザー状態の意味はない
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GatewayClientError } from "../errors.js";
import type {
  GatewayCallOptions,
  GatewayCallOutcome,
  GatewayClient,
  GatewayToolError,
  GatewayToolSchema,
} from "./types.js";

/** MCP 1リクエストのタイムアウト既定(SDK の DEFAULT_REQUEST_TIMEOUT_MSEC と同じ)。 */
export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 60_000;

export const ORCHESTRATOR_CLIENT_INFO = {
  name: "kp-orchestrator",
  version: "0.1.0",
} as const;

export interface McpGatewayClientOptions {
  /** Gateway の MCP エンドポイント(例: http://127.0.0.1:8787/mcp) */
  readonly url: string | URL;
  /** 利用者本人のセッショントークン(秘密情報。ログ・エラーに出さない) */
  readonly sessionToken: string;
  /** MCP 1リクエストのタイムアウト(ms) */
  readonly requestTimeoutMs?: number;
}

/** 正規化済みの分類コード(Gateway の GatewayErrorClass と同じ規約)。 */
const ERROR_CLASS_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

export class McpGatewayClient implements GatewayClient {
  readonly #url: URL;
  readonly #sessionToken: string;
  readonly #requestTimeoutMs: number;
  #connection: Promise<Client> | undefined;
  #closed = false;

  constructor(options: McpGatewayClientOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new GatewayClientError("gateway_protocol_error", "the gateway URL is invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new GatewayClientError(
        "gateway_protocol_error",
        "the gateway URL must use http or https",
      );
    }
    if (url.username !== "" || url.password !== "") {
      // 資格情報を URL に載せない(ログに残りやすい)。認証は Authorization ヘッダのみ
      throw new GatewayClientError(
        "gateway_protocol_error",
        "the gateway URL must not contain credentials",
      );
    }
    if (!/^\S+$/.test(options.sessionToken)) {
      throw new GatewayClientError("unauthenticated", "a session token is required");
    }
    this.#url = url;
    this.#sessionToken = options.sessionToken;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
  }

  /** 接続先(表示用。トークンを含まない)。 */
  get endpoint(): string {
    return this.#url.href;
  }

  async listTools(
    options: GatewayCallOptions = {},
  ): Promise<readonly GatewayToolSchema[]> {
    const client = await this.#connect(options);
    try {
      const result = await client.listTools(undefined, this.#requestOptions(options));
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    } catch (error) {
      throw toGatewayClientError(error, options.signal);
    }
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    meta: Readonly<Record<string, unknown>>,
    options: GatewayCallOptions = {},
  ): Promise<GatewayCallOutcome> {
    const client = await this.#connect(options);
    let result: unknown;
    try {
      result = await client.callTool(
        { name, arguments: { ...args }, _meta: { ...meta } },
        undefined,
        this.#requestOptions(options),
      );
    } catch (error) {
      throw toGatewayClientError(error, options.signal);
    }
    return normalizeCallResult(result);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection !== undefined) {
      try {
        await (await connection).close();
      } catch {
        // 接続に失敗していた、または既に閉じている
      }
    }
  }

  #requestOptions(options: GatewayCallOptions): {
    timeout: number;
    signal?: AbortSignal;
  } {
    return {
      timeout: this.#requestTimeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
  }

  #connect(options: GatewayCallOptions): Promise<Client> {
    if (this.#closed) {
      return Promise.reject(
        new GatewayClientError("gateway_protocol_error", "the gateway client is closed"),
      );
    }
    if (this.#connection === undefined) {
      this.#connection = this.#open().catch((error: unknown) => {
        // 失敗した接続は使い回さない(次の呼び出しで張り直す)
        this.#connection = undefined;
        throw toGatewayClientError(error, options.signal);
      });
    }
    return this.#connection;
  }

  async #open(): Promise<Client> {
    const client = new Client(ORCHESTRATOR_CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(this.#url, {
      requestInit: {
        headers: { Authorization: `Bearer ${this.#sessionToken}` },
      },
    });
    // SDK の型宣言が exactOptionalPropertyTypes に非対応のため型だけ合わせる
    // (packages/gateway/src/proxy/http.ts と同じ理由。実体は Transport IF を実装している)
    await client.connect(transport as Transport, { timeout: this.#requestTimeoutMs });
    return client;
  }
}

/**
 * トランスポート層の失敗を固定文言の GatewayClientError に写す。SDK の例外メッセージは
 * Gateway の応答本文を含みうるため流さない(Gateway は本文にトークンを載せないが、
 * 経路として閉じておく)。
 */
function toGatewayClientError(
  error: unknown,
  signal: AbortSignal | undefined,
): GatewayClientError {
  if (error instanceof GatewayClientError) {
    return error;
  }
  if (signal?.aborted === true) {
    return new GatewayClientError("aborted", "the gateway request was aborted");
  }
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    if (status === 401) {
      return new GatewayClientError(
        "unauthenticated",
        "the gateway rejected the session token (401)",
      );
    }
    if (
      status === 408 ||
      status === 429 ||
      (status !== undefined && status >= 500)
    ) {
      return new GatewayClientError("gateway_unavailable", "the gateway is unavailable");
    }
    if (
      status === 400 ||
      status === 404 ||
      status === 405 ||
      status === 406 ||
      status === 415 ||
      status === -1
    ) {
      return new GatewayClientError(
        "gateway_protocol_error",
        "the gateway endpoint did not accept the MCP request",
      );
    }
    return new GatewayClientError("gateway_rejected", "the gateway rejected the request");
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      return new GatewayClientError("gateway_timeout", "the gateway request timed out");
    }
    const data = error.data;
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { errorClass?: unknown }).errorClass === "unauthenticated"
    ) {
      return new GatewayClientError(
        "unauthenticated",
        "the gateway rejected the session token",
      );
    }
    return new GatewayClientError("gateway_rejected", "the gateway rejected the request");
  }
  // fetch の失敗(接続拒否・名前解決不能等)
  return new GatewayClientError("gateway_unavailable", "could not reach the gateway");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(result: Record<string, unknown>): string | undefined {
  const content = result["content"];
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const part of content) {
    if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") {
      return part["text"];
    }
  }
  return undefined;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const UNREADABLE_ERROR: GatewayToolError = {
  errorClass: "gateway_protocol_error",
  message: "the gateway returned an unreadable tool error",
};

/** CallToolResult を正規化する(isError は本文の JSON から errorClass を読む)。 */
export function normalizeCallResult(result: unknown): GatewayCallOutcome {
  if (!isRecord(result)) {
    return { ok: false, error: UNREADABLE_ERROR };
  }
  if (result["isError"] === true) {
    const body = parseJson(firstText(result));
    if (
      !isRecord(body) ||
      typeof body["errorClass"] !== "string" ||
      !ERROR_CLASS_PATTERN.test(body["errorClass"]) ||
      typeof body["message"] !== "string"
    ) {
      return { ok: false, error: UNREADABLE_ERROR };
    }
    const retryAfterMs = body["retryAfterMs"];
    return {
      ok: false,
      error: {
        errorClass: body["errorClass"],
        message: body["message"],
        ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
          ? { retryAfterMs }
          : {}),
      },
    };
  }
  const structured = result["structuredContent"];
  if (isRecord(structured)) {
    return { ok: true, result: structured };
  }
  const json = parseJson(firstText(result));
  if (json === undefined) {
    return {
      ok: false,
      error: {
        errorClass: "gateway_protocol_error",
        message: "the gateway returned an unreadable tool result",
      },
    };
  }
  return { ok: true, result: json };
}
