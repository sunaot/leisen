/**
 * esa のリモート MCP サーバー(https://mcp.esa.io)の薄いラッパー(ADR-023)。
 *
 * - 呼び出しはすべて利用者本人の OAuth アクセストークン(Authorization: Bearer)で行う
 *   (不変条件1)。トークンは Gateway が呼び出しごとに AuthContext で渡し、ここでは保持しない
 * - 呼べるツールは読み取り系の許可リスト(READ_ONLY_TOOLS)に限る。esa の MCP サーバーは
 *   書き込み系のツール(esa_create_post 等)も公開するが、コネクタからは呼べない
 * - 1 回の操作ごとに接続(initialize)→ ツール呼び出し → 切断を行う。セッションを利用者間で
 *   共有しない(不変条件4)
 * - エラーは分類(ConnectorErrorClass)と HTTP の状態・esa のエラーコードだけに落とす。
 *   応答本文・トークン・引数の値をメッセージに含めない(不変条件6)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorError } from "@leisen/connector-sdk";

/** fetch の注入点(テスト・プロキシ用)。 */
export type FetchLike = typeof fetch;

/** コネクタが呼べる esa のツール(読み取り系だけ)。 */
export const READ_ONLY_TOOLS = [
  "esa_search_posts",
  "esa_get_post",
  "esa_get_top_categories",
  "esa_get_categories",
] as const;

export type EsaReadTool = (typeof READ_ONLY_TOOLS)[number];

/** コネクタから見た上流の IF(テストではフェイクに差し替える)。 */
export interface EsaMcpCaller {
  callTool(accessToken: string, name: EsaReadTool, args: Record<string, unknown>): Promise<unknown>;
}

export interface EsaMcpClientOptions {
  /** MCP エンドポイント(既定 https://mcp.esa.io/)。https またはループバックの http */
  readonly url: string;
  /** 1 回の操作(接続からツールの結果まで)の期限 */
  readonly timeoutMs: number;
  readonly fetchImpl?: FetchLike;
  /** clientInfo に載せる名前・版 */
  readonly clientName?: string;
  readonly clientVersion?: string;
}

const CLIENT_NAME = "leisen-connector-esa";
const CLIENT_VERSION = "0.1.0";

/** esa のツールのエラー(isError の結果の本文にある error)を分類する。 */
export function classifyToolError(code: string | undefined): ConnectorError {
  switch (code) {
    case "not_found":
      return new ConnectorError("not_found", "esa returned not_found");
    case "unauthorized":
    case "invalid_token":
      return new ConnectorError("auth_expired", "esa rejected the access token");
    case "forbidden":
    case "access_denied":
    case "insufficient_scope":
      return new ConnectorError("permission_denied", "esa denied the request");
    case "too_many_requests":
    case "rate_limit_exceeded":
    case "rate_limited":
      return new ConnectorError("rate_limited", "esa rate limit exceeded");
    case "bad_request":
    case "invalid_request":
    case "invalid_params":
      return new ConnectorError("invalid_request", "esa rejected the request parameters");
    default:
      return new ConnectorError("source_unavailable", `esa tool returned an error (${code ?? "unknown"})`);
  }
}

/** エラーコードは英小文字・数字・_ に正規化して短くする(値をそのまま返さない)。 */
function normalizeCode(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") {
    return undefined;
  }
  return raw.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ツールの結果のテキストを JSON として読む(esa は "Error: {...}" の形でエラーを返す)。 */
function parseText(text: string): unknown {
  const trimmed = text.trim();
  const body = trimmed.startsWith("Error:") ? trimmed.slice("Error:".length).trim() : trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * ツールの結果を値にする。structuredContent があればそれを、なければ最初の text の JSON を使う。
 * isError の結果は ConnectorError にする
 */
export function readToolResult(result: unknown): unknown {
  if (!isRecord(result)) {
    throw new ConnectorError("source_unavailable", "esa returned a malformed tool result");
  }
  const content = Array.isArray(result["content"]) ? result["content"] : [];
  const firstText = content.find(
    (item): item is { type: "text"; text: string } =>
      isRecord(item) && item["type"] === "text" && typeof item["text"] === "string",
  );
  if (result["isError"] === true) {
    const parsed = firstText !== undefined ? parseText(firstText.text) : undefined;
    const code = isRecord(parsed) ? normalizeCode(parsed["error"]) : undefined;
    throw classifyToolError(code);
  }
  if (result["structuredContent"] !== undefined) {
    return result["structuredContent"];
  }
  if (firstText === undefined) {
    throw new ConnectorError("source_unavailable", "esa returned no content");
  }
  const parsed = parseText(firstText.text);
  if (parsed === undefined) {
    throw new ConnectorError("source_unavailable", "esa returned non-JSON content");
  }
  return parsed;
}

/** 上流の呼び出しで起きた例外を分類する(本文・トークンを含めない)。 */
export function classifyTransportError(error: unknown, timedOut: boolean): ConnectorError {
  if (error instanceof ConnectorError) {
    return error;
  }
  if (timedOut) {
    return new ConnectorError("source_unavailable", "esa MCP request timed out");
  }
  if (error instanceof UnauthorizedError) {
    return new ConnectorError("auth_expired", "esa MCP server rejected the access token (HTTP 401)");
  }
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    if (status === 401) {
      return new ConnectorError("auth_expired", "esa MCP server rejected the access token (HTTP 401)");
    }
    if (status === 403) {
      return new ConnectorError("permission_denied", "esa MCP server denied the request (HTTP 403)");
    }
    if (status === 429) {
      return new ConnectorError("rate_limited", "esa MCP server rate limit exceeded (HTTP 429)");
    }
    return new ConnectorError(
      "source_unavailable",
      `esa MCP server request failed (${typeof status === "number" && status > 0 ? `HTTP ${status}` : "transport"})`,
    );
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.InvalidParams) {
      return new ConnectorError("invalid_request", "esa MCP server rejected the tool arguments");
    }
    if (error.code === ErrorCode.RequestTimeout) {
      return new ConnectorError("source_unavailable", "esa MCP request timed out");
    }
    return new ConnectorError("source_unavailable", `esa MCP server returned a protocol error (${error.code})`);
  }
  return new ConnectorError("source_unavailable", "esa MCP server is unreachable");
}

/** URL の検査(https、またはテスト・開発用のループバックの http)。 */
export function checkMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RangeError("mcpUrl must be an absolute URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new RangeError("mcpUrl must use https (plain http only on loopback)");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RangeError("mcpUrl must not contain credentials");
  }
  return url;
}

export class EsaMcpClient implements EsaMcpCaller {
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #clientName: string;
  readonly #clientVersion: string;

  constructor(options: EsaMcpClientOptions) {
    this.#url = checkMcpUrl(options.url);
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#clientName = options.clientName ?? CLIENT_NAME;
    this.#clientVersion = options.clientVersion ?? CLIENT_VERSION;
  }

  async callTool(accessToken: string, name: EsaReadTool, args: Record<string, unknown>): Promise<unknown> {
    if (!(READ_ONLY_TOOLS as readonly string[]).includes(name)) {
      // 型で防いでいるが、実行時にも書き込み系のツールを通さない
      throw new ConnectorError("invalid_request", "tool is not in the read-only allowlist");
    }
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new ConnectorError("auth_expired", "no esa access token");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    timer.unref?.();
    const baseFetch = this.#fetch;
    // 同一オリジン以外へトークンを送らない(リダイレクトは追わない)
    const guardedFetch: FetchLike = (input, init) =>
      baseFetch(input, { ...init, signal: controller.signal, redirect: "error" });
    const transport = new StreamableHTTPClientTransport(this.#url, {
      fetch: guardedFetch,
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client({ name: this.#clientName, version: this.#clientVersion });
    try {
      // exactOptionalPropertyTypes と SDK の型の差(sessionId?: string)を吸収する(orchestrator と同じ)
      await client.connect(transport as Transport, { signal: controller.signal, timeout: this.#timeoutMs });
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal: controller.signal,
        timeout: this.#timeoutMs,
      });
      return readToolResult(result);
    } catch (error) {
      throw classifyTransportError(error, timedOut);
    } finally {
      clearTimeout(timer);
      if (transport.sessionId !== undefined && !timedOut) {
        await transport.terminateSession().catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
  }
}
