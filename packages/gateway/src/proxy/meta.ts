/**
 * MCPリクエストの `_meta` に載るGateway独自の申告(T-003、ADR-001 追補3 決定4)。
 *
 * プロトコル自身が `_meta` を `io.modelcontextprotocol/*` 名前空間で使うため、
 * 独自キーには名前空間prefixを付ける。prefixは暫定値であり、最終確定は
 * T-013(OSS公開準備)。**T-013 で prefix を変更する際は、移行期間中は4キー
 * (runId / iteration / executionClass / actor)すべてについて旧prefixも受ける**
 * (未知キーの拒否も新旧両方のprefixに適用する)。旧prefixのキーを「名前空間外」
 * として黙って無視すると、旧prefixで申告した executionClass が落ちて
 * human_in_the_loop として通る fail-open になるため。
 *
 * - 申告キーの誤記は拒否する(declarationFromMeta。ADR-015 の既定拒否を誤記で
 *   迂回させない。セキュリティレビュー 2026-09-27 M2): Gatewayの名前空間
 *   (prefix。大文字小文字を区別せずに判定)で始まるが既知の4キーのいずれとも
 *   完全一致しないキー、および裸の executionClass / actor(大文字小文字・`_` / `-`
 *   の違いを含む)があれば invalid_request。メッセージは固定文言で、キー名も値も
 *   エコーしない
 * - runId / iteration(ADR-011 追記): Orchestrator(T-007)が申告する監査の束ね。
 *   移行期間として裸キー(`runId` / `iteration`)も受けるが、Gatewayの名前空間の
 *   キーが1つでもあれば裸キーはすべて無視する(キー単位のフォールバックで新旧の
 *   申告を混在させない)。不正値(runId は [A-Za-z0-9._:-] の1〜128文字、
 *   iteration は0以上の安全な整数。session.ts)は未申告として扱う: 監査の相関
 *   メタデータであり、呼び出し自体は単発run(session.ts resolveCallContext)として
 *   必ず記録されるため
 * - executionClass / actor(ADR-015): リクエストごとの実行区分・呼び出し主体。
 *   prefix付きキーのみを受ける(裸キーは前例がないため移行期間を設けず拒否する)。
 *   不正値は既定値に丸めず invalid_request で拒否する(区分による拒否を
 *   誤記で迂回させない)
 */
import {
  isValidIteration,
  isValidRunId,
  parseActor,
  parseExecutionClass,
} from "./session.js";
import {
  GatewayError,
  type CallContext,
  type SessionDeclaration,
} from "./types.js";

/** Gateway独自 `_meta` キーの名前空間prefix(暫定。最終確定はT-013)。 */
export const META_KEY_PREFIX = "io.github.sunaot.leisen/";

/** Gatewayが解釈する `_meta` キー。 */
export const GATEWAY_META_KEYS = {
  runId: `${META_KEY_PREFIX}runId`,
  iteration: `${META_KEY_PREFIX}iteration`,
  executionClass: `${META_KEY_PREFIX}executionClass`,
  actor: `${META_KEY_PREFIX}actor`,
} as const;

/** 名前空間内で受け付けるキー(完全一致のみ)。 */
const KNOWN_GATEWAY_KEYS: ReadonlySet<string> = new Set(
  Object.values(GATEWAY_META_KEYS),
);

/** 大文字小文字を区別しない名前空間判定用の prefix。 */
const NAMESPACE_PREFIX_LOWER = META_KEY_PREFIX.toLowerCase();

/** 移行期間中に受ける裸キー(ADR-001 追補3 決定4)。移行期間の終了時期は未定。 */
const LEGACY_BARE_KEYS = {
  runId: "runId",
  iteration: "iteration",
} as const;

/**
 * 裸キーとしては受け付けない申告名(小文字化し `_` / `-` を除いた形で照合する)。
 * 実行区分・actor の申告は prefix付きキーのみ(前例がないため互換を考慮しない)。
 */
const BARE_DECLARATION_NAMES: ReadonlySet<string> = new Set([
  "executionclass",
  "actor",
]);

const MISSPELLED_DECLARATION =
  "unrecognized or unprefixed gateway declaration key in _meta " +
  "(declare with the documented prefixed keys, ADR-015)";

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

/** 値を持つ自身のキー。 */
function presentKeys(record: MetaRecord): string[] {
  return Object.keys(record).filter((key) => has(record, key));
}

/** Gatewayの名前空間のキーか(大文字小文字を区別しない。誤記を名前空間外として見逃さない)。 */
function inGatewayNamespace(key: string): boolean {
  return key.toLowerCase().startsWith(NAMESPACE_PREFIX_LOWER);
}

function isBareDeclarationKey(key: string): boolean {
  return BARE_DECLARATION_NAMES.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/**
 * 申告キーの誤記を拒否する(M2)。名前空間内の未知キー(prefix・キー名の大文字
 * 小文字違いを含む)と裸の executionClass / actor は、黙って無視すると申告が
 * 落ちて既定の human_in_the_loop として通ってしまう。
 */
function assertNoMisspelledDeclaration(record: MetaRecord): void {
  for (const key of presentKeys(record)) {
    const misspelled = inGatewayNamespace(key)
      ? !KNOWN_GATEWAY_KEYS.has(key)
      : isBareDeclarationKey(key);
    if (misspelled) {
      throw new GatewayError("invalid_request", MISSPELLED_DECLARATION);
    }
  }
}

function readCallContextValue(
  record: MetaRecord,
  name: keyof typeof LEGACY_BARE_KEYS,
  legacyAllowed: boolean,
): unknown {
  const prefixed = GATEWAY_META_KEYS[name];
  if (has(record, prefixed)) {
    return record[prefixed];
  }
  const bare = LEGACY_BARE_KEYS[name];
  return legacyAllowed && has(record, bare) ? record[bare] : undefined;
}

/** `_meta` から runId / iteration の申告を読む(不正値は未申告扱い)。 */
export function callContextFromMeta(meta: unknown): CallContext {
  const record = asRecord(meta);
  // prefix付き(名前空間内)のキーが1つでもあれば裸キーはすべて無視する(minor-8)
  const legacyAllowed = !presentKeys(record).some(inGatewayNamespace);
  const runId = readCallContextValue(record, "runId", legacyAllowed);
  const iteration = readCallContextValue(record, "iteration", legacyAllowed);
  return {
    ...(isValidRunId(runId) ? { runId } : {}),
    ...(isValidIteration(iteration) ? { iteration } : {}),
  };
}

/**
 * `_meta` から実行区分・actor の申告を読む。先に申告キーの誤記を検査し
 * (invalid_request)、キーがあれば値を検証して不正なら GatewayError
 * ("invalid_request") を投げる。キーがなければ省略(既定値は bindSession が
 * human_in_the_loop / human を補う)。runToolCall は callContextFromMeta より先に
 * これを呼ぶため、誤記のある `_meta` は runId / iteration を含めて一切使われない。
 */
export function declarationFromMeta(meta: unknown): SessionDeclaration {
  const record = asRecord(meta);
  assertNoMisspelledDeclaration(record);
  const { executionClass, actor } = GATEWAY_META_KEYS;
  return {
    ...(has(record, executionClass)
      ? { executionClass: parseExecutionClass(record[executionClass]) }
      : {}),
    ...(has(record, actor) ? { actor: parseActor(record[actor]) } : {}),
  };
}
