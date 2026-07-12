/**
 * MCPセッションと利用者アイデンティティの束縛(T-003、ADR-001 追補)。
 *
 * MCPプロトコル自体はエンドユーザーIDを運ばない。Gatewayはトランスポート層で
 * 提示されたセッショントークンを IdpAdapter.authenticate で検証し、確立した
 * GatewaySession に以降の全ツール呼び出しを束縛する。トークンの再検証・失効は
 * IdP側のsemanticsに従う(失効反映は IdpAdapter.invalidateUser / TM-C4)。
 */
import { randomUUID } from "node:crypto";
import { actorSchema, type Actor } from "../audit/schema.js";
import type { IdpAdapter } from "../idp/types.js";
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

const HUMAN_ACTOR: Actor = { kind: "human" };

export class GatewaySessionManager {
  /** sessionId → runId → 次のiteration(自動採番用) */
  private readonly iterationCounters = new Map<string, Map<string, number>>();
  /** sessionId → セッション既定のrunId(Orchestrator未申告時のフォールバック) */
  private readonly defaultRunIds = new Map<string, string>();

  constructor(
    private readonly idpAdapter: IdpAdapter,
    private readonly ids: () => string = randomUUID,
  ) {}

  /**
   * セッション確立: トークンを検証して本人を確定する。申告された actor /
   * executionClass はここで検証する(不正なactorが監査書き込み時まで
   * 検出されないと、呼び出し自体は済んでいるのに記録だけ失敗する形になる)。
   */
  async establish(
    sessionToken: string,
    declaration: SessionDeclaration = {},
  ): Promise<GatewaySession> {
    const executionClass = declaration.executionClass ?? "human_in_the_loop";
    if (!EXECUTION_CLASSES.includes(executionClass)) {
      throw new GatewayError(
        "invalid_request",
        `unknown execution class: ${String(executionClass)}`,
      );
    }
    const actor = declaration.actor ?? HUMAN_ACTOR;
    const parsedActor = actorSchema.safeParse(actor);
    if (!parsedActor.success) {
      throw new GatewayError(
        "invalid_request",
        "invalid actor declaration (agent actor requires onBehalfOfChain, ADR-015)",
      );
    }
    // IdpError(unauthenticated等)は呼び出し元でGatewayエラーへ写像される
    const identity = await this.idpAdapter.authenticate(sessionToken);
    const sessionId = this.ids();
    return { sessionId, identity, executionClass, actor: parsedActor.data };
  }

  /**
   * 監査コンテキストの補完。runId / iteration はOrchestrator(T-007)の申告が
   * 本則で、未申告時はセッション単位のrunId+自動採番で「1呼び出し=1レコード」
   * の束ねを維持する。
   */
  resolveCallContext(
    session: GatewaySession,
    context: CallContext = {},
  ): { runId: string; iteration: number } {
    const runId = context.runId ?? this.defaultRunId(session.sessionId);
    if (context.iteration !== undefined) {
      return { runId, iteration: context.iteration };
    }
    let counters = this.iterationCounters.get(session.sessionId);
    if (!counters) {
      counters = new Map();
      this.iterationCounters.set(session.sessionId, counters);
    }
    const iteration = counters.get(runId) ?? 0;
    counters.set(runId, iteration + 1);
    return { runId, iteration };
  }

  /** セッション破棄(接続クローズ時)。採番状態を残さない。 */
  discard(sessionId: string): void {
    this.iterationCounters.delete(sessionId);
    this.defaultRunIds.delete(sessionId);
  }

  private defaultRunId(sessionId: string): string {
    let runId = this.defaultRunIds.get(sessionId);
    if (!runId) {
      runId = this.ids();
      this.defaultRunIds.set(sessionId, runId);
    }
    return runId;
  }
}
