/**
 * esa の本人照合(ADR-022 決定 8、ADR-023 決定 9 の改訂)。
 *
 * esa のリモート MCP サーバー向けのトークン(resource=https://mcp.esa.io、scope mcp)では
 * REST API の GET /v1/user が 403 になる(2026-11-14 に実チームで確認)。そこで同じ MCP サーバーの
 * esa_get_team_members を呼び、`myself: true` の行のメールアドレスを使う。
 *
 * - 呼び先は接続した esa コネクタと同じ MCP エンドポイント・同じチーム(トークンの受け手と一致)
 * - 最終アクセスの新しい順に並べる。認可した直後の本人はほぼ先頭に来る。見つからなければ
 *   ページを進め、上限(maxPages)で打ち切る
 * - 他のメンバーの行は読み捨てる(保管・記録しない)。戻り値は本人のメールアドレスだけ
 * - エラーは段階と HTTP 状態だけ(トークン・応答本文を含めない。不変条件6)
 * - MCP SDK には直接依存しない(SDK の接合部は proxy/mcp.ts に閉じ込める)
 */
import { RemoteMcpError, withRemoteMcpSession } from "../proxy/mcp.js";
import { SourceOAuthError } from "./oauth.js";
import { DEFAULT_HTTP_TIMEOUT_MS } from "./http.js";

export interface EsaIdentityLookupOptions {
  /** esa のチーム名(コネクタの settings.team) */
  readonly team: string;
  /** MCP エンドポイント(コネクタの settings.mcpUrl。既定 https://mcp.esa.io/) */
  readonly mcpUrl: string;
  readonly timeoutMs?: number;
  /** 本人の行を探すページ数の上限(1 ページ 100 人) */
  readonly maxPages?: number;
  readonly fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 1 ページ分の結果から本人のメールアドレスと次のページを読む(本人の行がなければ emails は undefined)。 */
export function readMembersPage(result: unknown): { emails: string[] | undefined; nextPage: number | null } {
  if (!isRecord(result) || result["isError"] === true) {
    throw new SourceOAuthError("rejected", "identity lookup was rejected by esa_get_team_members");
  }
  const content = Array.isArray(result["content"]) ? result["content"] : [];
  const text = content.find((c): c is { type: "text"; text: string } => isRecord(c) && c["type"] === "text" && typeof c["text"] === "string");
  let body: unknown = result["structuredContent"];
  if (body === undefined && text !== undefined) {
    try {
      body = JSON.parse(text.text) as unknown;
    } catch {
      body = undefined;
    }
  }
  if (!isRecord(body) || !Array.isArray(body["members"])) {
    throw new SourceOAuthError("invalid_response", "identity lookup returned an unexpected member list");
  }
  const me = body["members"].find((m) => isRecord(m) && m["myself"] === true);
  const emails =
    me === undefined
      ? undefined
      : isRecord(me) && typeof me["email"] === "string" && me["email"].includes("@")
        ? [me["email"].trim().toLowerCase()]
        : [];
  const next = body["next_page"];
  return { emails, nextPage: typeof next === "number" && Number.isInteger(next) && next > 0 ? next : null };
}

/** アクセストークンで本人のメールアドレスを引く関数を作る(SourceOAuthConfig.identityLookup に渡す)。 */
export function esaIdentityLookup(options: EsaIdentityLookupOptions): (accessToken: string) => Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxPages = options.maxPages ?? 20;
  return async (accessToken: string) => {
    try {
      return await withRemoteMcpSession(
        {
          url: options.mcpUrl,
          accessToken,
          timeoutMs,
          totalTimeoutMs: timeoutMs * (maxPages + 1),
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        },
        async (call) => {
          let page = 1;
          for (let i = 0; i < maxPages; i += 1) {
            const result = await call("esa_get_team_members", {
              teamName: options.team,
              sort: "last_accessed",
              order: "desc",
              page,
              perPage: 100,
            });
            const { emails, nextPage } = readMembersPage(result);
            if (emails !== undefined) {
              return emails;
            }
            if (nextPage === null) {
              break;
            }
            page = nextPage;
          }
          throw new SourceOAuthError("rejected", "identity lookup did not find the connecting user among the team members");
        },
      );
    } catch (error) {
      if (error instanceof SourceOAuthError) {
        throw error;
      }
      if (error instanceof RemoteMcpError && error.status !== undefined) {
        throw new SourceOAuthError(error.status >= 500 ? "unavailable" : "rejected", `identity lookup returned HTTP ${error.status}`);
      }
      throw new SourceOAuthError("unavailable", "identity lookup via the esa MCP server failed");
    }
  };
}
