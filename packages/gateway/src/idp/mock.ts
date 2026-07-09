/**
 * 開発用モック実装(T-002)。実IdP・実SaaSなしでGateway/コネクタ開発を進める
 * ためのもの。資格情報は環境変数から注入する(コード・フィクスチャへの
 * 秘密情報ハードコード禁止、不変条件6)。
 *
 * 本番無効化: NODE_ENV=production では構築自体を拒否する(受け入れ条件)。
 * factory(createIdpAdapter)も同じ検査を行うため二重に守られる。
 */
import type { Credential } from "@kp/connector-sdk";
import { CredentialResolvingIdpAdapter } from "./adapter.js";
import type { CredentialCacheOptions } from "./cache.js";
import {
  IdpError,
  type CredentialProvider,
  type Identity,
} from "./types.js";

export function assertNotProduction(what: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new IdpError(
      "misconfigured",
      `${what} is disabled in production builds (NODE_ENV=production)`,
    );
  }
}

export interface MockUser {
  readonly userId: string;
  readonly displayName?: string;
}

export interface MockIdpAdapterOptions {
  /**
   * セッショントークン → ユーザーの対応表(開発用固定値)。
   * 未指定時は環境変数 KP_MOCK_SESSIONS("token=userId[,token2=userId2...]")
   * から読む。
   */
  sessions?: Readonly<Record<string, MockUser>>;
  cache?: CredentialCacheOptions;
}

function sessionsFromEnv(): Record<string, MockUser> {
  const raw = process.env.KP_MOCK_SESSIONS;
  if (!raw) {
    return {};
  }
  const sessions: Record<string, MockUser> = {};
  for (const pair of raw.split(",")) {
    const [token, userId] = pair.split("=").map((s) => s.trim());
    if (!token || !userId) {
      throw new IdpError(
        "misconfigured",
        "KP_MOCK_SESSIONS must be 'token=userId[,token=userId...]'",
      );
    }
    sessions[token] = { userId };
  }
  return sessions;
}

export class MockIdpAdapter extends CredentialResolvingIdpAdapter {
  private readonly sessions: Readonly<Record<string, MockUser>>;

  constructor(
    providers: readonly CredentialProvider[],
    options: MockIdpAdapterOptions = {},
  ) {
    assertNotProduction("MockIdpAdapter");
    super(providers, options.cache);
    this.sessions = options.sessions ?? sessionsFromEnv();
  }

  async authenticate(sessionToken: string): Promise<Identity> {
    const user = this.sessions[sessionToken];
    if (!user) {
      // トークン値をメッセージに含めない(不変条件6)
      throw new IdpError("unauthenticated", "unknown mock session token");
    }
    return {
      userId: user.userId,
      ...(user.displayName !== undefined
        ? { displayName: user.displayName }
        : {}),
      session: { subjectToken: sessionToken },
    };
  }
}

/** モック資格情報の環境変数名(sourceIdごと)。 */
export function mockTokenEnvVar(sourceId: string): string {
  return `KP_MOCK_TOKEN_${sourceId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export interface MockCredentialProviderOptions {
  /** 発行するトークンの有効期間(ms)。既定1時間。 */
  tokenLifetimeMs?: number;
  now?: () => number;
}

/**
 * 環境変数から固定アクセストークンを注入する開発用プロバイダ(方式A相当)。
 * 環境変数が未設定のユーザー/ソースは「未接続」(source_not_connected)として
 * 振る舞い、初回同意UX(ADR-010 決定3)の呼び出し側実装を開発できるようにする。
 *
 * 変数名: KP_MOCK_TOKEN_<SOURCEID>(ユーザー別に上書きしたい場合は
 * KP_MOCK_TOKEN_<SOURCEID>__<USERID>)。
 *
 * 注意: 変数名は英数字以外を "_" に正規化するため、"a.b" と "a_b" のような
 * userId同士は同じ上書き変数に写像される(開発専用機能の既知の限界)。
 * 開発用の固定userIdには英数字のみを使うこと。
 */
export class MockCredentialProvider implements CredentialProvider {
  readonly method = "oauth_individual" as const;
  private readonly tokenLifetimeMs: number;
  private readonly now: () => number;

  constructor(
    public readonly sourceId: string,
    options: MockCredentialProviderOptions = {},
  ) {
    assertNotProduction("MockCredentialProvider");
    this.tokenLifetimeMs = options.tokenLifetimeMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  async getCredential(identity: Identity): Promise<Credential> {
    const base = mockTokenEnvVar(this.sourceId);
    const perUser =
      process.env[
        `${base}__${identity.userId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
      ];
    const token = perUser ?? process.env[base];
    if (!token) {
      throw new IdpError(
        "source_not_connected",
        `no mock credential injected for source '${this.sourceId}' (set ${base})`,
      );
    }
    return {
      kind: "oauth_bearer",
      accessToken: token,
      expiresAt: this.now() + this.tokenLifetimeMs,
    };
  }
}
