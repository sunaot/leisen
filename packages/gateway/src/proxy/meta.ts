/**
 * MCPリクエストの `_meta` に載るGateway独自の申告(T-003、ADR-001 追補3 決定4)。
 *
 * プロトコル自身が `_meta` を `io.modelcontextprotocol/*` 名前空間で使うため、
 * 独自キーには名前空間prefixを付ける。prefixは暫定値であり、最終確定は
 * T-013(OSS公開準備)。**T-013 で prefix を変更する際は、移行期間中は4キー
 * (runId / iteration / executionClass / actor)すべてについて旧prefixも受ける**
 * (誤記の照合のうち名前空間の判定=骨格の前方一致も新旧両方のprefixに適用する)。
 * 旧prefixのキーを「名前空間外」として黙って無視すると、旧prefixで申告した
 * executionClass が落ちて human_in_the_loop として通る fail-open になるため。
 *
 * - 申告キーの誤記は拒否する(declarationFromMeta。ADR-015 の既定拒否を誤記で
 *   迂回させない。セキュリティレビュー 2026-09-27 M2、再レビュー S1): 既知の4キーと
 *   完全一致しないキーのうち、骨格(skeleton: NFKC 正規化 → 小文字化 → ASCII 英数字
 *   以外を除去)が次のいずれかに当たるものがあれば invalid_request。
 *   (a) Gatewayの名前空間 prefix の骨格("iogithubsunaotleisen")で始まる
 *   (b) "executionclass" で終わる(名前空間を問わない)
 *   (c) "actor" に等しい(裸の actor)
 *   これにより大文字小文字、前後の空白・タブ、区切り(`/` `.` `:` `_` `-`・空白)の
 *   違い、prefix 直後の `/` の欠落、prefix の綴り違い(executionClass の場合)、
 *   全角文字・ゼロ幅文字による見た目違いを同じ申告名として照合する。メッセージは
 *   固定文言で、キー名も値もエコーしない
 *   - 他社名前空間の `com.example/executionClass` も (b) で拒否する(自社の申告の
 *     つもりで prefix を誤ったキー — `kp.gateway/` 等 — と区別できないため
 *     fail-closed に倒す)。`com.example/actor` は骨格が "actor" と一致しないため受ける
 *   - Gatewayでは検知できない残余: `_meta` 以外の場所での申告(`params.meta` 等の
 *     スキーマ外のキーは SDK が取り除く)、申告そのものの省略、名前空間外のキー名
 *     自体の綴り違い(`execClass` 等)、prefix を誤った actor(`kp.gateway/actor`
 *     等。他社名前空間の actor と区別できない)。いずれも既定の human_in_the_loop /
 *     human として扱われる(T-003 H1)
 * - runId / iteration(ADR-011 追記): Orchestrator(T-007)が申告する監査の束ね。
 *   移行期間として裸キー(`runId` / `iteration`)も受けるが、Gatewayの名前空間の
 *   キー(骨格で判定)が1つでもあれば裸キーはすべて無視する(キー単位の
 *   フォールバックで新旧の申告を混在させない)。不正値(runId は [A-Za-z0-9._:-] の
 *   1〜128文字、iteration は0以上の安全な整数。session.ts)は未申告として扱う:
 *   監査の相関メタデータであり、呼び出し自体は単発run(session.ts
 *   resolveCallContext)として必ず記録されるため
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

/**
 * Gatewayが tools/call の結果の `_meta` に載せるキー(結果側。要求側の
 * GATEWAY_META_KEYS とは別で、Gatewayは要求側としては解釈しない。T-007
 * セキュリティレビュー H1)。
 * - userId: そのリクエストで Gatewayが認証した利用者(トランスポート層が検証した
 *   Identity の userId)。呼び出し元(Orchestrator)は AnswerRun の主体をこの値に
 *   束縛し、自己申告の userId と食い違えば fail-closed にする。成功・失敗(isError)を
 *   問わず付け、検証済みの Identity がない結果(unauthenticated)と tools/list の結果
 *   (内容はユーザー非依存、ADR-001 追補3 決定5)には付けない(mcp.ts)
 * 名前空間 prefix 内のキーのため、要求の `_meta` にこのキーを書くと申告キーの誤記として
 * invalid_request で拒否される(利用者を要求側から申告させる口を作らない)。
 */
export const GATEWAY_RESULT_META_KEYS = {
  userId: `${META_KEY_PREFIX}userId`,
} as const;

/** 名前空間内で受け付けるキー(完全一致のみ)。 */
const KNOWN_GATEWAY_KEYS: ReadonlySet<string> = new Set(
  Object.values(GATEWAY_META_KEYS),
);

/**
 * 誤記の照合に使うキーの骨格: NFKC 正規化(全角英数字・記号などの互換文字を
 * ASCII 側へ寄せる)→ 小文字化 → ASCII 英数字以外(空白・タブ・区切り記号・
 * ゼロ幅文字等)の除去。見た目や区切りだけが違うキーを同じ申告名として扱う。
 */
function skeleton(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Gatewayの名前空間 prefix の骨格("iogithubsunaotleisen")。 */
const NAMESPACE_SKELETON = skeleton(META_KEY_PREFIX);

/** 骨格がこれで終わる未知キーは、名前空間を問わず実行区分の誤記として拒否する。 */
const EXECUTION_CLASS_SKELETON = skeleton("executionClass");

/**
 * 骨格がこれに等しい未知キー(裸の actor)を拒否する。他社名前空間の actor
 * (`com.example/actor`)を拒否しないよう、完全一致に限る。
 */
const BARE_ACTOR_SKELETON = skeleton("actor");

/** 移行期間中に受ける裸キー(ADR-001 追補3 決定4)。移行期間の終了時期は未定。 */
const LEGACY_BARE_KEYS = {
  runId: "runId",
  iteration: "iteration",
} as const;

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

/**
 * Gatewayの名前空間のキーか(骨格の前方一致で判定する。大文字小文字・区切り・
 * 全角/ゼロ幅の違いを名前空間外として見逃さない)。
 */
function inGatewayNamespace(key: string): boolean {
  return skeleton(key).startsWith(NAMESPACE_SKELETON);
}

/**
 * 申告キーの誤記か(M2、再レビュー S1)。既知の4キーと完全一致しないキーのうち、
 * 骨格が名前空間 prefix で始まる・"executionclass" で終わる・"actor" に等しいもの。
 */
function isMisspelledDeclarationKey(key: string): boolean {
  if (KNOWN_GATEWAY_KEYS.has(key)) {
    return false;
  }
  const keySkeleton = skeleton(key);
  return (
    keySkeleton.startsWith(NAMESPACE_SKELETON) ||
    keySkeleton.endsWith(EXECUTION_CLASS_SKELETON) ||
    keySkeleton === BARE_ACTOR_SKELETON
  );
}

/**
 * 申告キーの誤記を拒否する(M2、再レビュー S1)。誤記のキーを黙って無視すると
 * 申告が落ちて既定の human_in_the_loop として通ってしまう。
 */
function assertNoMisspelledDeclaration(record: MetaRecord): void {
  if (presentKeys(record).some(isMisspelledDeclarationKey)) {
    throw new GatewayError("invalid_request", MISSPELLED_DECLARATION);
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
  // 名前空間内のキーが1つでもあれば裸キーはすべて無視する(minor-8)
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
