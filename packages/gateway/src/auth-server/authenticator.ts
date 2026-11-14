/**
 * 認可サーバーを有効にした構成の IdpAdapter(ADR-022 決定 4)。
 *
 * - authenticate: Gateway が発行したアクセストークン(受け手 = Gateway の MCP の resource)を
 *   開いて本人を確定する。IdP への照会はしない(IdP の利用停止はリフレッシュ時の IdP の更新と
 *   拒否リストで反映する。遅延の上限はアクセストークンの有効期間)。IdP のトークンを直接受けるのは
 *   acceptIdpTokens: true のときだけ(内側のアダプタに委ねる)
 * - getCredential / invalidateUser: 内側のアダプタ(ソース別プロバイダ・キャッシュ)に委ねる。
 *   esc のプロバイダは identity.session.esc から取り出す
 */
import type { AuthContext } from "@leisen/connector-sdk";
import { IdpError, type Identity, type IdpAdapter } from "../idp/types.js";
import { Sealer } from "./seal.js";
import { TokenRejected, type TokenService } from "./tokens.js";

export interface GatewayTokenIdpAdapterOptions {
  readonly inner: IdpAdapter;
  readonly tokens: TokenService;
  /** Gateway の MCP エンドポイントの URL(このアダプタが受ける aud) */
  readonly resource: string;
  readonly acceptIdpTokens: boolean;
  /** 拒否した理由(分類だけ)の出力先 */
  readonly diagnose?: (message: string) => void;
}

export class GatewayTokenIdpAdapter implements IdpAdapter {
  readonly #o: GatewayTokenIdpAdapterOptions;

  constructor(options: GatewayTokenIdpAdapterOptions) {
    this.#o = options;
  }

  get inner(): IdpAdapter {
    return this.#o.inner;
  }

  async authenticate(sessionToken: string): Promise<Identity> {
    if (Sealer.purposeOf(sessionToken) === undefined) {
      if (this.#o.acceptIdpTokens) {
        return this.#o.inner.authenticate(sessionToken);
      }
      throw new IdpError("unauthenticated", "a token issued by this gateway is required");
    }
    try {
      const payload = await this.#o.tokens.openAccessToken(sessionToken, this.#o.resource);
      return {
        userId: payload.sub,
        ...(payload.name !== undefined ? { displayName: payload.name } : {}),
        ...(payload.email !== undefined ? { email: payload.email } : {}),
        session: {
          subjectToken: payload.idp.accessToken,
          expiresAt: payload.exp,
          esc: { sid: payload.sid, issuedAt: payload.iat, clientId: payload.cid, sources: payload.src },
        },
      };
    } catch (error) {
      if (error instanceof TokenRejected) {
        this.#o.diagnose?.(`gateway token rejected (${error.kind})`);
        throw new IdpError("unauthenticated", "gateway token is invalid, expired or revoked");
      }
      throw error;
    }
  }

  getCredential(identity: Identity, sourceId: string): Promise<AuthContext> {
    return this.#o.inner.getCredential(identity, sourceId);
  }

  invalidateUser(userId: string): void {
    this.#o.inner.invalidateUser(userId);
  }
}
