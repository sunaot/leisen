/**
 * IdpAdapter の共通骨格: ソース別 CredentialProvider への委譲と
 * 資格情報キャッシュ(userId×sourceId、single-flight)を実装する。
 * 認証方式(モック / Keycloak / 各社IdP)は authenticate() の実装差のみ。
 */
import type { AuthContext } from "@kp/connector-sdk";
import { CredentialCache, type CredentialCacheOptions } from "./cache.js";
import {
  IdpError,
  type CredentialProvider,
  type Identity,
  type IdpAdapter,
} from "./types.js";

export abstract class CredentialResolvingIdpAdapter implements IdpAdapter {
  private readonly providers = new Map<string, CredentialProvider>();
  private readonly cache: CredentialCache;

  constructor(
    providers: readonly CredentialProvider[],
    cacheOptions: CredentialCacheOptions = {},
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.sourceId)) {
        throw new IdpError(
          "misconfigured",
          `duplicate credential provider for source: ${provider.sourceId}`,
        );
      }
      this.providers.set(provider.sourceId, provider);
    }
    this.cache = new CredentialCache(cacheOptions);
  }

  abstract authenticate(sessionToken: string): Promise<Identity>;

  async getCredential(
    identity: Identity,
    sourceId: string,
  ): Promise<AuthContext> {
    const provider = this.providers.get(sourceId);
    if (!provider) {
      throw new IdpError(
        "misconfigured",
        `no credential provider registered for source: ${sourceId}`,
      );
    }
    const credential = await this.cache.getOrLoad(
      identity.userId,
      sourceId,
      () => provider.getCredential(identity),
    );
    return { userId: identity.userId, credential };
  }

  invalidateUser(userId: string): void {
    this.cache.invalidateUser(userId);
  }

  /** 単一ソースの失効(コネクタの auth_expired 検知時等)。 */
  invalidateCredential(userId: string, sourceId: string): void {
    this.cache.invalidate(userId, sourceId);
  }
}
