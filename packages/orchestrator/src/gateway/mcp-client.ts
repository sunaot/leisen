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
 * - 接続先 URL は、ループバック(localhost / 127.0.0.1 / [::1])以外では https 必須。
 *   資格情報・クエリ・フラグメント付きの URL は構築時に拒否する(セッショントークンを
 *   平文で送らない。セキュリティレビュー 2026-09-27 m3)。例外は allowInsecureHttp
 *   (kp-ask の --allow-insecure-upstream。開発・評価用途で、compose のネットワーク内の
 *   http://gateway:8787/mcp 等)のときだけで、NODE_ENV=production では構築を拒否する
 * - ツール結果の isError は正規化エラー(本文の JSON の errorClass / message)に写す。
 *   成功・失敗を問わず、結果の `_meta` から Gateway が認証した userId を読む
 *   (gatewayUserIdFromResultMeta。AnswerRun の主体の束縛に使う、H1)
 * - 接続(initialize)は最初の呼び出しで1回だけ行い、以降の要求で使い回す。
 *   Gateway はステートレスなので、接続の使い回しにユーザー状態の意味はない
 * - 接続にも最初の呼び出しの signal(run の時間上限など)を効かせる(セキュリティレビュー m1):
 *   initialize の要求は SDK が signal で取り消すが、続く notifications/initialized の送信には
 *   期限がないため、signal が中断されたら SDK クライアントを閉じて進行中の HTTP 要求ごと止める。
 *   close() も接続の完了を待たずに閉じる(応答しない Gateway で close が止まらない)。
 *   同じ接続を待つ他の呼び出しも同じ失敗になる(Orchestrator は1つの run の呼び出しに同じ
 *   signal を使う)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { GatewayClientError } from "../errors.js";
import { gatewayUserIdFromResultMeta } from "./meta.js";
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
  /**
   * Gateway の MCP エンドポイント(例: http://127.0.0.1:8787/mcp)。ループバック以外は
   * https 必須。資格情報・クエリ・フラグメントを含めない
   */
  readonly url: string | URL;
  /** 利用者本人のセッショントークン(秘密情報。ログ・エラーに出さない) */
  readonly sessionToken: string;
  /** MCP 1リクエストのタイムアウト(ms) */
  readonly requestTimeoutMs?: number;
  /**
   * ループバック以外の http の URL を許す(--allow-insecure-upstream。開発・評価用途)。
   * 平文ではセッショントークンと検索結果が経路上で読めるため、NODE_ENV=production では構築を拒否する
   */
  readonly allowInsecureHttp?: boolean;
}

/** 正規化済みの分類コード(Gateway の GatewayErrorClass と同じ規約)。 */
const ERROR_CLASS_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;

/** http を許すループバックのホスト(URL.hostname の表記。IPv6 は角括弧付き)。 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * 接続先 URL を検証する(m3)。メッセージは固定文言で、URL の中身をエコーしない
 * (資格情報やトークンを誤って URL に書いた場合にログへ残さない)。kp-ask serve は
 * 起動時にこれで --gateway を検証する(接続はしない)。
 */
export function parseGatewayUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayClientError("gateway_protocol_error", "the gateway URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayClientError(
      "gateway_protocol_error",
      "the gateway URL must use http or https",
    );
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    // セッショントークンを平文で送らない(http はループバックのみ)
    throw new GatewayClientError(
      "gateway_protocol_error",
      "the gateway URL must use https (http is allowed only for loopback hosts)",
    );
  }
  if (url.username !== "" || url.password !== "") {
    // 資格情報を URL に載せない(ログに残りやすい)。認証は Authorization ヘッダのみ
    throw new GatewayClientError(
      "gateway_protocol_error",
      "the gateway URL must not contain credentials",
    );
  }
  const href = url.href;
  if (url.search !== "" || url.hash !== "" || href.includes("?") || href.includes("#")) {
    // 空のクエリ・フラグメント("?" / "#" だけ)も拒否する
    throw new GatewayClientError(
      "gateway_protocol_error",
      "the gateway URL must not contain a query string or a fragment",
    );
  }
  return url;
}

/**
 * allowInsecureHttp(--allow-insecure-upstream)のときだけ使う接続先 URL の検証。ループバック
 * 以外の http も通す。それ以外の規則(資格情報・クエリ・フラグメントを載せない)は parseGatewayUrl を
 * そのまま使う(同じ URL を https に置き換えて検査する。parseGatewayUrl 自体は変えない)。
 */
export function parseInsecureGatewayUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayClientError("gateway_protocol_error", "the gateway URL is invalid");
  }
  if (url.protocol !== "http:" || LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return parseGatewayUrl(url);
  }
  const probe = new URL(url.href);
  probe.protocol = "https:";
  parseGatewayUrl(probe);
  return url;
}

/** ループバック以外への平文 http か(--allow-insecure-upstream でだけ許す接続。起動時の WARNING 用)。 */
export function isPlainHttpBeyondLoopback(url: URL): boolean {
  return url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname);
}

export class McpGatewayClient implements GatewayClient {
  readonly #url: URL;
  readonly #sessionToken: string;
  readonly #requestTimeoutMs: number;
  #connection: Promise<Client> | undefined;
  /** 接続中・接続済みの SDK クライアント(close で接続の完了を待たずに閉じるため) */
  #sdkClient: Client | undefined;
  #closed = false;

  constructor(options: McpGatewayClientOptions) {
    if (options.allowInsecureHttp === true && process.env["NODE_ENV"] === "production") {
      // 本番で平文 http の Gateway 接続を許さない(kp-ask の引数の解釈でも拒否する。
      // ライブラリとして直接組んだ場合の防波堤)
      throw new GatewayClientError(
        "gateway_protocol_error",
        "plain http to the gateway (allowInsecureHttp) is not allowed when NODE_ENV=production",
      );
    }
    // 検証の入口で分岐する(parseGatewayUrl 自体は変えない)
    const url =
      options.allowInsecureHttp === true
        ? parseInsecureGatewayUrl(options.url)
        : parseGatewayUrl(options.url);
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
    const client = this.#sdkClient;
    this.#sdkClient = undefined;
    this.#connection = undefined;
    if (client !== undefined) {
      try {
        // 接続の途中(initialize の応答待ちなど)でも待たずに閉じる(進行中の HTTP 要求を中断する)
        await client.close();
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
      this.#connection = this.#open(options.signal).catch((error: unknown) => {
        // 失敗した接続は使い回さない(次の呼び出しで張り直す)
        this.#connection = undefined;
        throw toGatewayClientError(error, options.signal);
      });
    }
    return this.#connection;
  }

  async #open(signal: AbortSignal | undefined): Promise<Client> {
    if (signal?.aborted === true) {
      throw new GatewayClientError("aborted", "the gateway request was aborted");
    }
    const client = new Client(ORCHESTRATOR_CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(this.#url, {
      requestInit: {
        headers: { Authorization: `Bearer ${this.#sessionToken}` },
      },
    });
    this.#sdkClient = client;
    // 中断されたら接続の途中でも閉じる(notifications/initialized の送信には SDK の期限がない)
    const abort = () => {
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // SDK の型宣言が exactOptionalPropertyTypes に非対応のため型だけ合わせる
      // (packages/gateway/src/proxy/http.ts と同じ理由。実体は Transport IF を実装している)
      await client.connect(transport as Transport, {
        timeout: this.#requestTimeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      });
      return client;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
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

/**
 * CallToolResult を正規化する(isError は本文の JSON から errorClass を読む)。
 * 成功・失敗を問わず、結果の `_meta` の認証済み userId を userId に写す(H1)。
 */
export function normalizeCallResult(result: unknown): GatewayCallOutcome {
  if (!isRecord(result)) {
    return { ok: false, error: UNREADABLE_ERROR };
  }
  const userId = gatewayUserIdFromResultMeta(result["_meta"]);
  const reported = userId !== undefined ? { userId } : {};
  if (result["isError"] === true) {
    const body = parseJson(firstText(result));
    if (
      !isRecord(body) ||
      typeof body["errorClass"] !== "string" ||
      !ERROR_CLASS_PATTERN.test(body["errorClass"]) ||
      typeof body["message"] !== "string"
    ) {
      return { ok: false, error: UNREADABLE_ERROR, ...reported };
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
      ...reported,
    };
  }
  const structured = result["structuredContent"];
  if (isRecord(structured)) {
    return { ok: true, result: structured, ...reported };
  }
  const json = parseJson(firstText(result));
  if (json === undefined) {
    return {
      ok: false,
      error: {
        errorClass: "gateway_protocol_error",
        message: "the gateway returned an unreadable tool result",
      },
      ...reported,
    };
  }
  return { ok: true, result: json, ...reported };
}
