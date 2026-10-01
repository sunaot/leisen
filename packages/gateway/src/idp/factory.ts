/**
 * IdpAdapter 実装切替のfactory(T-002)。
 * deployment.yaml(T-010)の idp セクションがこの設定型に対応する。
 * kind の追加(各社IdP)はIdP Adapterプラグイン境界内の変更であり
 * コア改変を要しない(ADR-005)。
 */
import { CredentialResolvingIdpAdapter } from "./adapter.js";
import type { CredentialCacheOptions } from "./cache.js";
import {
  assertNotProduction,
  MockIdpAdapter,
  type MockUser,
} from "./mock.js";
import {
  KeycloakIdpAdapter,
  type KeycloakIdpAdapterConfig,
} from "./keycloak.js";
import { IdpError, type CredentialProvider } from "./types.js";

export type IdpAdapterConfig =
  | {
      readonly kind: "mock";
      /** 未指定時は環境変数 KP_MOCK_SESSIONS から読む */
      readonly sessions?: Readonly<Record<string, MockUser>>;
    }
  | ({ readonly kind: "keycloak" } & KeycloakIdpAdapterConfig);

export interface CreateIdpAdapterDeps {
  readonly providers: readonly CredentialProvider[];
  readonly cache?: CredentialCacheOptions;
  /**
   * 稼働中の警告の出力先(秘密情報を渡さない。現状はモックのセッション表が空のときの
   * 拒否だけを通知する。issue #38)
   */
  readonly warn?: (message: string) => void;
}

export function createIdpAdapter(
  config: IdpAdapterConfig,
  deps: CreateIdpAdapterDeps,
): CredentialResolvingIdpAdapter {
  switch (config.kind) {
    case "mock":
      // モックは本番ビルドで無効(MockIdpAdapter内でも検査するが、
      // factory層でも設定不備として明示的に拒否する)
      assertNotProduction("idp adapter kind 'mock'");
      return new MockIdpAdapter(deps.providers, {
        ...(config.sessions !== undefined ? { sessions: config.sessions } : {}),
        ...(deps.cache !== undefined ? { cache: deps.cache } : {}),
        ...(deps.warn !== undefined ? { warn: deps.warn } : {}),
      });
    case "keycloak": {
      const { kind: _kind, ...keycloakConfig } = config;
      return new KeycloakIdpAdapter(
        keycloakConfig,
        deps.providers,
        deps.cache ?? {},
      );
    }
    default: {
      // 網羅性チェック(設定ファイル由来の値は型を通らない可能性がある)。
      // configオブジェクト全体をメッセージに入れるとclientSecret等が
      // ログへ漏れるため、kindフィールドのみをエコーする(不変条件6)
      const unknown: never = config;
      const kind = (unknown as { kind?: unknown }).kind;
      throw new IdpError(
        "misconfigured",
        `unknown idp adapter kind: ${JSON.stringify(kind)}`,
      );
    }
  }
}
