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
  /**
   * 稼働中の警告の出力先(起動コードがサーバーログにつなぐ。issue #38)。セッション表が
   * 空のまま認証を求められたとき、最初の1回だけ MOCK_IDP_NO_SESSIONS_REJECTED を渡す
   * (同じ理由の拒否を繰り返し出さない)。トークンの値は渡さない(不変条件6)
   */
  warn?: (message: string) => void;
}

/**
 * 起動時の警告(kp-gateway validate / serve が表示する): セッション表が空。モック IdP は
 * 開発用のためエラーにはしないが、このままでは Bearer トークン付きの全リクエストが 401 になる。
 */
export const MOCK_IDP_NO_SESSIONS_WARNING =
  "mock IdP: no sessions configured — 環境変数 KP_MOCK_SESSIONS が未設定(または空)のため、" +
  "すべてのリクエストが 401 になります。KP_MOCK_SESSIONS=<トークン>=<userId>[,<トークン>=<userId>...] を" +
  "設定して起動し直してください";

/**
 * 稼働中の警告(サーバーログ): セッション表が空のまま Bearer トークンを 401 で拒否した。
 * 最初の1回だけ出す。トークンの値は含めない(不変条件6)。
 */
export const MOCK_IDP_NO_SESSIONS_REJECTED =
  "mock IdP: no sessions configured — KP_MOCK_SESSIONS が空のため、Bearer トークン付きの" +
  "リクエストを 401 で拒否しました。KP_MOCK_SESSIONS を設定して起動し直してください" +
  "(以降の同じ理由の拒否は記録しません)";

/**
 * KP_MOCK_SESSIONS 形式("token=userId[,token2=userId2...]")を解析する。
 * 起動コード(bootstrap/)が注入された環境変数から読むために公開する。
 * 不正な形式のエラーには値(トークン)を含めない(不変条件6)。
 */
export function parseMockSessions(
  raw: string | undefined,
): Record<string, MockUser> {
  if (!raw) {
    return {};
  }
  // プロトタイプを持たない対応表にする("__proto__" / "constructor" 等のトークンで
  // Object.prototype のプロパティを引かない)
  const sessions: Record<string, MockUser> = Object.create(null) as Record<string, MockUser>;
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

function sessionsFromEnv(): Record<string, MockUser> {
  return parseMockSessions(process.env.KP_MOCK_SESSIONS);
}

export class MockIdpAdapter extends CredentialResolvingIdpAdapter {
  private readonly sessions: Readonly<Record<string, MockUser>>;
  private readonly warn: ((message: string) => void) | undefined;
  /** セッション表が空のままの拒否を警告したか(最初の1回だけ出す) */
  private warnedNoSessions = false;

  constructor(
    providers: readonly CredentialProvider[],
    options: MockIdpAdapterOptions = {},
  ) {
    assertNotProduction("MockIdpAdapter");
    super(providers, options.cache);
    this.sessions = options.sessions ?? sessionsFromEnv();
    this.warn = options.warn;
  }

  /** セッション表の件数(起動時の警告の判定用。トークンは返さない)。 */
  get sessionCount(): number {
    return Object.keys(this.sessions).length;
  }

  async authenticate(sessionToken: string): Promise<Identity> {
    // 自身のプロパティだけを引く(プロトタイプのプロパティ名のトークンを通さない)
    const user = Object.hasOwn(this.sessions, sessionToken)
      ? this.sessions[sessionToken]
      : undefined;
    if (!user) {
      if (!this.warnedNoSessions && this.sessionCount === 0) {
        // 原因(KP_MOCK_SESSIONS の設定漏れ)の手掛かりをサーバーログに1回だけ残す
        this.warnedNoSessions = true;
        this.warn?.(MOCK_IDP_NO_SESSIONS_REJECTED);
      }
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
  /**
   * トークンを読む環境変数(呼び出しのたびに参照する)。既定 process.env。
   * 起動コードが注入された環境(assembleGateway の env)を渡す。
   */
  env?: Readonly<Record<string, string | undefined>>;
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
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(
    public readonly sourceId: string,
    options: MockCredentialProviderOptions = {},
  ) {
    assertNotProduction("MockCredentialProvider");
    this.tokenLifetimeMs = options.tokenLifetimeMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? process.env;
  }

  async getCredential(identity: Identity): Promise<Credential> {
    const base = mockTokenEnvVar(this.sourceId);
    const perUser =
      this.env[
        `${base}__${identity.userId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
      ];
    const token = perUser ?? this.env[base];
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
