/**
 * MCPリクエストの `_meta` に載るGateway独自の申告(T-003、ADR-001 追補3 決定4)。
 *
 * プロトコル自身が `_meta` を `io.modelcontextprotocol/*` 名前空間で使うため、
 * 独自キーには名前空間prefixを付ける。prefixは暫定値であり、最終確定は
 * T-013(OSS公開準備)。変更する場合は移行期間中に旧prefixも受ける。
 *
 * - runId / iteration(ADR-011 追記): Orchestrator(T-007)が申告する監査の束ね。
 *   移行期間として裸キー(`runId` / `iteration`)も受け、prefix付きキーが
 *   あればそれだけを見る(不正値でも裸キーへフォールバックしない)。不正値は
 *   未申告として扱う: 監査の相関メタデータであり、呼び出し自体は単発run
 *   (session.ts resolveCallContext)として必ず記録されるため
 * - executionClass / actor(ADR-015): リクエストごとの実行区分・呼び出し主体。
 *   prefix付きキーのみを受ける(裸キーの前例がないため移行期間を設けない)。
 *   不正値は既定値に丸めず invalid_request で拒否する(区分による拒否を
 *   誤記で迂回させない)
 */
import { parseActor, parseExecutionClass } from "./session.js";
import type { CallContext, SessionDeclaration } from "./types.js";

/** Gateway独自 `_meta` キーの名前空間prefix(暫定。最終確定はT-013)。 */
export const META_KEY_PREFIX = "io.github.sunaot.leisen/";

/** Gatewayが解釈する `_meta` キー。 */
export const GATEWAY_META_KEYS = {
  runId: `${META_KEY_PREFIX}runId`,
  iteration: `${META_KEY_PREFIX}iteration`,
  executionClass: `${META_KEY_PREFIX}executionClass`,
  actor: `${META_KEY_PREFIX}actor`,
} as const;

/** 移行期間中に受ける裸キー(ADR-001 追補3 決定4)。移行期間の終了時期は未定。 */
const LEGACY_BARE_KEYS = {
  runId: "runId",
  iteration: "iteration",
} as const;

type MetaRecord = Readonly<Record<string, unknown>>;

function asRecord(meta: unknown): MetaRecord {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta)
    ? (meta as MetaRecord)
    : {};
}

/** 自身のプロパティとして値を持つか(JSONにundefinedは載らないため存在判定と同値)。 */
function has(record: MetaRecord, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function readWithLegacy(
  record: MetaRecord,
  name: keyof typeof LEGACY_BARE_KEYS,
): unknown {
  const prefixed = GATEWAY_META_KEYS[name];
  if (has(record, prefixed)) {
    return record[prefixed];
  }
  const bare = LEGACY_BARE_KEYS[name];
  return has(record, bare) ? record[bare] : undefined;
}

/** `_meta` から runId / iteration の申告を読む(不正値は未申告扱い)。 */
export function callContextFromMeta(meta: unknown): CallContext {
  const record = asRecord(meta);
  const runId = readWithLegacy(record, "runId");
  const iteration = readWithLegacy(record, "iteration");
  return {
    ...(typeof runId === "string" && runId.length > 0 ? { runId } : {}),
    ...(typeof iteration === "number" &&
    Number.isSafeInteger(iteration) &&
    iteration >= 0
      ? { iteration }
      : {}),
  };
}

/**
 * `_meta` から実行区分・actor の申告を読む。キーがあれば値を検証し、不正なら
 * GatewayError("invalid_request") を投げる。キーがなければ省略(既定値は
 * bindSession が human_in_the_loop / human を補う)。
 */
export function declarationFromMeta(meta: unknown): SessionDeclaration {
  const record = asRecord(meta);
  const { executionClass, actor } = GATEWAY_META_KEYS;
  return {
    ...(has(record, executionClass)
      ? { executionClass: parseExecutionClass(record[executionClass]) }
      : {}),
    ...(has(record, actor) ? { actor: parseActor(record[actor]) } : {}),
  };
}
