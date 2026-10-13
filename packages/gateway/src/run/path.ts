/**
 * run API(ADR-019)のパスの導出。
 *
 * run API は MCP エンドポイントと同じオリジン・同じディレクトリの `runs` に置く
 * (`/mcp` → `/runs`、`/leisen/mcp` → `/leisen/runs`)。Gateway(http.ts)と Orchestrator
 * (mcp-client.ts)が同じ関数で導くので、パスの接頭辞付きで公開した Gateway に対して
 * Orchestrator が別のパス(同じホストの別のバックエンド)へ本人のトークン・資格情報・質問を
 * 送ることがない。`gateway.http.path` に run API のパスそのもの(`/runs`、`/x/runs`)は
 * 使えない(config/schema.ts が予約する)。
 */
import { posix } from "node:path";

/** run API のパスの末尾の要素。 */
export const RUN_API_SEGMENT = "runs";

/** MCP エンドポイントのパスから run API のパスを導く(末尾の `/` は無視する)。 */
export function runApiPathFor(mcpPath: string): string {
  const normalized = posix.normalize(mcpPath.startsWith("/") ? mcpPath : `/${mcpPath}`);
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  const dir = posix.dirname(trimmed);
  return dir === "/" ? `/${RUN_API_SEGMENT}` : `${dir}/${RUN_API_SEGMENT}`;
}
