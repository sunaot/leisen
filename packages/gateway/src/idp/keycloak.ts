/**
 * Keycloak参照実装(T-002、旧T-011)。
 *
 * セッション検証はトークンイントロスペクション(RFC 7662)で行う。
 * 署名検証をローカルで行うJWKS方式より1往復増えるが、
 * - 検証ロジックをIdPへ委譲でき(自前JWT検証の実装リスクを避ける)、
 * - IdP側でのセッション失効・ユーザー無効化が即時反映される(TM-C系)
 * ため参照実装として採用する。スループットが必要になった場合のJWKS
 * ローカル検証+失効ラグの扱いはT-004で判断する。
 *
 * 検証範囲の限界: このアダプタと同梱のE2E(e2e/keycloak)は「Keycloak発行
 * トークンを受けるモックコネクタ」までを検証する。Google Drive / Slack等の
 * 実SaaS認可経路は検証しない(実接続はT-004)。
 *
 * HTTP呼び出しはfetch注入・タイムアウト設定可(開発ルール: 外部APIは
 * 薄いラッパー越し・タイムアウト注入可能に)。
 *
 * 受け手・種別・発行者の検証(issue #16、ADR-010 追補 2026-10-09): active だけでなく、
 * iss(発行者)・typ(アクセストークンであること)・azp(発行先クライアントの許可リスト)・
 * aud(requireAudience 時に自分の clientId を含むこと)を順に検証する。検証は環境によらず
 * 常に行い、開発で緩められるのは許可リストの内容(allowedClients: ["*"])だけで、緩めたことは
 * 設定と起動ログに現れる。失敗はすべて unauthenticated(利用者への応答は固定文言)で、理由は
 * diagnose フックにクレーム名だけで渡す(トークン・sub・応答全体は渡さない。不変条件6)。
 */
import { CredentialResolvingIdpAdapter } from "./adapter.js";
import type { CredentialCacheOptions } from "./cache.js";
import { assertNotProduction } from "./mock.js";
import {
  IdpError,
  type CredentialProvider,
  type Identity,
} from "./types.js";

export interface KeycloakIdpAdapterConfig {
  /** 例: http://localhost:8080 (末尾スラッシュなし) */
  readonly baseUrl: string;
  readonly realm: string;
  /** イントロスペクションを呼ぶconfidentialクライアント */
  readonly clientId: string;
  /** ログ出力禁止(不変条件6) */
  readonly clientSecret: string;
  /** HTTPタイムアウト(ms)。既定5000 */
  readonly timeoutMs?: number;
  /**
   * トークンの発行先(azp)として受け入れるクライアント ID の許可リスト。空は不可。
   * "*" を含むと azp の検証を省略する(開発専用。NODE_ENV=production では起動時に拒否され、
   * それ以外でも起動ログに WARNING が出る)。azp のない応答は "*" でない限り拒否する
   */
  readonly allowedClients: readonly string[];
  /** true なら aud(文字列または配列)に自分の clientId が含まれることを要求する。既定 false */
  readonly requireAudience?: boolean;
  /**
   * 受け入れる発行者(iss)。省略時は `${baseUrl}/realms/${realm}`。IdP の公開 URL が
   * イントロスペクションに使う baseUrl と異なる構成(リバースプロキシ・コンテナ間の
   * サービス名で呼ぶ等)でだけ明示する
   */
  readonly allowedIssuers?: readonly string[];
  /** テスト用fetch注入 */
  readonly fetchImpl?: typeof fetch;
  /**
   * 検証に失敗した理由の出力先(サーバーログ用の1行)。クレーム名と設定値だけを渡し、
   * トークン・sub・応答全体は渡さない(不変条件6)
   */
  readonly diagnose?: (message: string) => void;
  /**
   * diagnose の抑制間隔(ms)。検証項目ごとに最初の 1 件は即時、以降はこの間隔に 1 件
   * (抑制した件数を添える)。401 の洪水でサーバーログが線形に増えないようにする。既定 60000
   */
  readonly diagnoseIntervalMs?: number;
  /** テスト用の時計(既定 Date.now) */
  readonly clock?: () => number;
}

/** RFC 7662 のイントロスペクション応答のうち、このアダプタが読むクレーム。 */
export interface IntrospectionResponse {
  active: boolean;
  sub?: string;
  preferred_username?: string;
  name?: string;
  exp?: number;
  iss?: string;
  /** Keycloak: アクセストークンは "Bearer"、リフレッシュトークンは "Refresh"、ID トークンは "ID" */
  typ?: string;
  /** 発行先(authorized party)のクライアント ID */
  azp?: string;
  aud?: string | string[];
}

/** allowedClients の「任意のクライアントを受け入れる」印(開発専用)。 */
export const ANY_CLIENT = "*";

/** allowedClients に "*" が含まれる(他の項目と混在していても同じ扱い)。 */
export function acceptsAnyClient(allowedClients: readonly string[]): boolean {
  return allowedClients.includes(ANY_CLIENT);
}

/** allowedClients: ["*"] を受け入れたときの起動時の警告(kp-gateway validate / serve が出す)。 */
export const KEYCLOAK_ANY_CLIENT_WARNING =
  'any client is accepted (azp check disabled; idp.adapter.allowedClients contains "*")';

export type IntrospectionCheckName = "active" | "iss" | "typ" | "azp" | "aud";

/**
 * 検証項目1件の結果(kp-gateway auth-check の表示と diagnose の文言に使う)。
 * detail はクレーム名と設定値・クレームの値(iss / typ / azp / aud)だけで、トークン・sub・
 * 応答全体を含まない。
 */
export interface IntrospectionCheck {
  readonly name: IntrospectionCheckName;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_DIAGNOSE_INTERVAL_MS = 60_000;

/** 末尾のスラッシュを落とす(issuer の既定値と introspectUrl を同じ基準で組み立てる)。 */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

export class KeycloakIdpAdapter extends CredentialResolvingIdpAdapter {
  private readonly introspectUrl: string;
  private readonly authorizationHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** 受け入れる iss(既定は `${baseUrl}/realms/${realm}`) */
  private readonly allowedIssuers: readonly string[];
  private readonly diagnoseIntervalMs: number;
  private readonly clock: () => number;
  /** 検証項目ごとの直近の診断出力時刻と、その後に抑制した件数 */
  private readonly diagnoseState = new Map<
    IntrospectionCheckName,
    { lastAt: number; suppressed: number }
  >();

  constructor(
    private readonly config: KeycloakIdpAdapterConfig,
    providers: readonly CredentialProvider[],
    cacheOptions: CredentialCacheOptions = {},
  ) {
    super(providers, cacheOptions);
    if (config.allowedClients.length === 0) {
      throw new IdpError("misconfigured", "keycloak allowedClients must not be empty");
    }
    // 二重の防御: 起動コード(bootstrap/assemble.ts)が先に dev_only_in_production で拒否するが、
    // factory を直接使う経路でも本番では "*" を受け付けない
    if (acceptsAnyClient(config.allowedClients)) {
      assertNotProduction('keycloak allowedClients "*" (azp check disabled)');
    }
    this.diagnoseIntervalMs = config.diagnoseIntervalMs ?? DEFAULT_DIAGNOSE_INTERVAL_MS;
    this.clock = config.clock ?? Date.now;
    const realmUrl = `${trimTrailingSlash(config.baseUrl)}/realms/${encodeURIComponent(
      config.realm,
    )}`;
    this.introspectUrl = `${realmUrl}/protocol/openid-connect/token/introspect`;
    this.allowedIssuers =
      config.allowedIssuers !== undefined && config.allowedIssuers.length > 0
        ? config.allowedIssuers.map(trimTrailingSlash)
        : [realmUrl];
    this.authorizationHeader = `Basic ${Buffer.from(
      `${config.clientId}:${config.clientSecret}`,
    ).toString("base64")}`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * イントロスペクション応答を検証項目ごとに判定する(順序: active → iss → typ → azp → aud)。
   * active でなければ残りは skipped。aud は requireAudience のときだけ判定し、それ以外は
   * skipped。azp は allowedClients に "*" があれば skipped。
   */
  checkIntrospection(body: IntrospectionResponse): IntrospectionCheck[] {
    // active は boolean の true だけを有効とみなす(文字列 "false" 等の真値を通さない。fail-closed)
    const active = body.active === true;
    const hasSub = typeof body.sub === "string" && body.sub !== "";
    if (!active || !hasSub) {
      const detail = !active ? "token is not active" : "sub is missing";
      return [
        { name: "active", status: "fail", detail },
        { name: "iss", status: "skipped", detail: "token is not active" },
        { name: "typ", status: "skipped", detail: "token is not active" },
        { name: "azp", status: "skipped", detail: "token is not active" },
        { name: "aud", status: "skipped", detail: "token is not active" },
      ];
    }
    const checks: IntrospectionCheck[] = [{ name: "active", status: "pass", detail: "active" }];

    const iss = typeof body.iss === "string" ? trimTrailingSlash(body.iss) : undefined;
    checks.push(
      iss !== undefined && this.allowedIssuers.includes(iss)
        ? { name: "iss", status: "pass", detail: `iss is ${JSON.stringify(iss)}` }
        : {
            name: "iss",
            status: "fail",
            detail:
              body.iss === undefined
                ? `iss is missing (expected ${quoteList(this.allowedIssuers)})`
                : `iss mismatch (expected ${quoteList(this.allowedIssuers)})`,
          },
    );

    checks.push(
      body.typ === "Bearer"
        ? { name: "typ", status: "pass", detail: "typ is Bearer" }
        : {
            name: "typ",
            status: "fail",
            detail:
              body.typ === undefined
                ? "typ is missing (expected Bearer)"
                : `typ ${JSON.stringify(body.typ)} is not Bearer`,
          },
    );

    if (acceptsAnyClient(this.config.allowedClients)) {
      checks.push({
        name: "azp",
        status: "skipped",
        detail: 'allowedClients contains "*" (development only)',
      });
    } else if (typeof body.azp !== "string" || body.azp === "") {
      checks.push({ name: "azp", status: "fail", detail: "azp is missing" });
    } else if (this.config.allowedClients.includes(body.azp)) {
      checks.push({
        name: "azp",
        status: "pass",
        detail: `azp ${JSON.stringify(body.azp)} is in allowedClients`,
      });
    } else {
      checks.push({
        name: "azp",
        status: "fail",
        detail: `azp ${JSON.stringify(body.azp)} is not in allowedClients`,
      });
    }

    if (this.config.requireAudience !== true) {
      checks.push({ name: "aud", status: "skipped", detail: "requireAudience is false" });
    } else {
      const audiences =
        typeof body.aud === "string" ? [body.aud] : Array.isArray(body.aud) ? body.aud : [];
      const wanted = JSON.stringify(this.config.clientId);
      checks.push(
        audiences.includes(this.config.clientId)
          ? { name: "aud", status: "pass", detail: `aud includes ${wanted}` }
          : {
              name: "aud",
              status: "fail",
              detail:
                body.aud === undefined ? `aud is missing (expected ${wanted})` : `aud does not include ${wanted}`,
            },
      );
    }
    return checks;
  }

  async authenticate(sessionToken: string): Promise<Identity> {
    const body = await this.introspect(sessionToken);
    const failed = this.checkIntrospection(body).find((check) => check.status === "fail");
    if (failed !== undefined) {
      // 理由はサーバーログ向けにクレーム名だけで残し、利用者には固定文言(HTTP 層が 401 の
      // 固定文言に写す)。トークン・sub・応答全体は出さない
      this.diagnoseRejection(failed);
      throw new IdpError(
        "unauthenticated",
        "session token was rejected by keycloak introspection checks",
      );
    }
    // checkIntrospection が通れば sub はある
    const userId = body.sub ?? "";
    const displayName = body.name ?? body.preferred_username;
    return {
      userId,
      ...(displayName !== undefined ? { displayName } : {}),
      session: {
        subjectToken: sessionToken,
        ...(body.exp !== undefined ? { expiresAt: body.exp * 1000 } : {}),
      },
    };
  }

  /**
   * 拒否理由をサーバーログ向けに出す。検証項目ごとに最初の 1 件は即時、以降は
   * diagnoseIntervalMs に 1 件(その間に抑制した件数を添える)。
   */
  private diagnoseRejection(failed: IntrospectionCheck): void {
    const diagnose = this.config.diagnose;
    if (diagnose === undefined) {
      return;
    }
    const now = this.clock();
    const state = this.diagnoseState.get(failed.name);
    if (state !== undefined && now - state.lastAt < this.diagnoseIntervalMs) {
      state.suppressed += 1;
      return;
    }
    const suppressed = state?.suppressed ?? 0;
    this.diagnoseState.set(failed.name, { lastAt: now, suppressed: 0 });
    diagnose(
      `keycloak introspection rejected a session token: ${failed.detail}` +
        (suppressed > 0
          ? ` (${suppressed} more rejection(s) on "${failed.name}" suppressed in the last ${this.diagnoseIntervalMs}ms)`
          : ""),
    );
  }

  /**
   * イントロスペクション(RFC 7662)を1回呼び、応答をそのまま返す(検証は checkIntrospection)。
   * kp-gateway auth-check が検証項目ごとの結果を表示するために使う。
   */
  async introspect(sessionToken: string): Promise<IntrospectionResponse> {
    if (!sessionToken) {
      throw new IdpError("unauthenticated", "missing session token");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.introspectUrl, {
        method: "POST",
        headers: {
          authorization: this.authorizationHeader,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: sessionToken }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // 原因(cause)にURLやリクエスト詳細が含まれうるため付け直さない
      throw new IdpError(
        "idp_unavailable",
        `keycloak introspection unreachable (realm: ${this.config.realm})`,
      );
    }
    if (!response.ok) {
      // 401/403はGateway側クライアント資格情報の問題、5xxはIdP障害。
      // いずれも利用者セッションの有効性は判定できていないので
      // unauthenticated にはしない(fail-closedだが原因を区別する)。
      throw new IdpError(
        "idp_unavailable",
        `keycloak introspection failed with status ${response.status}`,
      );
    }
    let body: IntrospectionResponse;
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as IntrospectionResponse;
    } catch {
      // 200でも本文が空/非JSONならIdP側の異常として分類する(fail-closed)
      throw new IdpError(
        "idp_unavailable",
        "keycloak introspection returned a non-JSON response",
      );
    }
    return body;
  }
}
