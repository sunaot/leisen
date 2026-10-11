/**
 * リクエストと利用者アイデンティティの束縛(T-003、ADR-001 追補3)。
 *
 * MCPプロトコル自体はエンドユーザーIDを運ばない。Gatewayは**毎リクエスト**の
 * Bearerセッショントークンを IdpAdapter.authenticate で検証し(HTTP層で
 * JSON-RPCディスパッチ前、http.ts)、そのリクエストの申告(実行区分・actor)と
 * 合わせてリクエスト単位の GatewaySession を作る(決定1)。
 *
 * 本モジュールは状態を持たない(決定2): セッションの保持・破棄、接続クローズ
 * 時の後始末、runId / iteration のセッション単位の自動採番(旧設計の
 * クロスコール状態)はいずれも存在しない(決定3、ADR-011 追記)。
 * トークンの失効はIdP側のsemanticsに従い、リクエストごとに再検証されるため
 * IdP側で失効したトークンは次のリクエストから拒否される(TM-C4 / TM-C6)。
 */
import { actorSchema, type Actor } from "@kp/audit";
import type { Identity } from "../idp/types.js";
import {
  GatewayError,
  type CallContext,
  type ExecutionClass,
  type GatewaySession,
  type SessionDeclaration,
} from "./types.js";

const EXECUTION_CLASSES: readonly ExecutionClass[] = [
  "human_in_the_loop",
  "scheduled",
  "autonomous",
];

/** 申告がない場合の実行区分(人間の対話セッション、ADR-015) */
const DEFAULT_EXECUTION_CLASS: ExecutionClass = "human_in_the_loop";
const HUMAN_ACTOR: Actor = { kind: "human" };

/**
 * 申告された runId として受け付ける形(文字種と長さの上限)。runId はクライアント
 * (Orchestrator)が申告してそのまま監査レコードに残るため、任意文字列・長大な値を
 * 受け付けない。UUID や "run-42" 形式は通る。不適合は未申告として扱う(単発run)。
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 申告 runId の検証(文字種 [A-Za-z0-9._:-]、1〜128文字)。 */
export function isValidRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

/** 申告 iteration の検証(0以上の安全な整数)。 */
export function isValidIteration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 実行区分の申告を検証する(ADR-015)。未知の値は既定値に丸めず拒否する:
 * 丸めると「scheduled のつもりの誤記」が human_in_the_loop として通り、
 * 区分による拒否を迂回できてしまう。申告値はメッセージにエコーしない。
 */
export function parseExecutionClass(value: unknown): ExecutionClass {
  const known = EXECUTION_CLASSES.find((cls) => cls === value);
  if (known === undefined) {
    throw new GatewayError(
      "invalid_request",
      "unknown execution class declaration (ADR-015)",
    );
  }
  return known;
}

/** 呼び出し主体の申告を検証する(ADR-011/015)。agent は onBehalfOfChain 必須。 */
export function parseActor(value: unknown): Actor {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayError(
      "invalid_request",
      "invalid actor declaration (agent actor requires onBehalfOfChain, ADR-015)",
    );
  }
  return parsed.data;
}

/**
 * 申告を検証し、省略値を補う(human_in_the_loop / human)。申告は実行時にも
 * 検証する: 型を通らない外部入力(`_meta`)から組み立てられうるうえ、不正な
 * actorが監査書き込み時まで検出されないと、呼び出し自体は済んでいるのに
 * 記録だけ失敗する形になる。
 */
export function validateDeclaration(
  declaration: SessionDeclaration = {},
): Pick<GatewaySession, "executionClass" | "actor"> {
  return {
    executionClass: parseExecutionClass(
      declaration.executionClass ?? DEFAULT_EXECUTION_CLASS,
    ),
    actor: parseActor(declaration.actor ?? HUMAN_ACTOR),
  };
}

/** 検証済みIdentityとリクエストの申告からリクエスト単位のセッションを作る。 */
export function bindSession(
  identity: Identity,
  declaration: SessionDeclaration = {},
): GatewaySession {
  return { identity, ...validateDeclaration(declaration) };
}

/**
 * 監査コンテキストの解決(ADR-011 追記 2026-09-17)。runId / iteration は
 * Orchestrator(T-007)の申告を記録する。runId 未申告の呼び出しは呼び出し
 * 単位の新規runId・iteration=0 の単発runとして記録し、run内の継続性は
 * 保証しない(Gatewayは呼び出しをまたぐ採番状態を持たない)。
 * 申告値は `_meta` 経由(meta.ts)と同じ規則で検証し、不適合は未申告として扱う
 * (in-process の呼び出し元にも同じ規則を適用する)。
 */
export function resolveCallContext(
  context: CallContext,
  newRunId: () => string,
): { runId: string; iteration: number } {
  if (!isValidRunId(context.runId)) {
    return { runId: newRunId(), iteration: 0 };
  }
  return {
    runId: context.runId,
    iteration: isValidIteration(context.iteration) ? context.iteration : 0,
  };
}
