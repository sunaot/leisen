/**
 * 失効(ADR-022 決定 6)。ソース側の経路(SCIM・アカウント無効化・CAE)が一次で、ここは
 * 追加の防御。
 *
 * - 本人の解除(disconnect): token_vault はソースへ失効を依頼して行を消す。esc は
 *   (sub, source) の拒否を入れ、要求に添えられたトークンがあればソースへ失効を依頼する
 * - 利用停止(deprovision): token_vault の全ソースをソースへ失効依頼して消す。esc・
 *   認可サーバーのトークンは sub 単位で「この時刻より前の発行を拒否」を入れる(ソースへの
 *   能動的な失効はできない。docs/install.md に記す)。資格情報キャッシュを捨てる
 * - ソースへの失効依頼が失敗しても、保管の削除・拒否は行う(結果は事象の reason に残す)
 */
import type { Identity } from "../idp/types.js";
import type { CredentialEventSink } from "./events.js";
import type { SourceOAuthClient } from "./oauth.js";
import { subSourceKey } from "./providers.js";
import type { CredentialStore } from "./types.js";
import type { TokenVault } from "./vault.js";

export interface RevocationSources {
  /** provider: token_vault のソース(sourceId → OAuth クライアント) */
  readonly vault: ReadonlyMap<string, SourceOAuthClient>;
  /** provider: esc のソース */
  readonly esc: ReadonlyMap<string, SourceOAuthClient>;
}

export interface CredentialRevocationOptions {
  readonly vault?: TokenVault;
  readonly store?: CredentialStore;
  readonly sources: RevocationSources;
  readonly events: CredentialEventSink;
  /** 資格情報キャッシュの破棄(IdpAdapter.invalidateUser / invalidateCredential) */
  readonly invalidateUser: (userId: string) => void;
  readonly invalidateCredential?: (userId: string, sourceId: string) => void;
  /** 拒否を保つ期間(ms)。認可サーバーのリフレッシュトークンの最長期間以上にする */
  readonly denialRetentionMs: number;
  readonly now?: () => number;
}

export interface DeprovisionResult {
  /** ソースへ失効を依頼して受け付けられた token_vault の件数 */
  readonly revokedAtSource: number;
  /** 保管から消した token_vault の件数 */
  readonly deleted: number;
  /** ソースへの失効依頼が失敗した sourceId(保管は消した) */
  readonly sourceRevocationFailed: readonly string[];
}

export class CredentialRevocation {
  readonly #o: CredentialRevocationOptions;
  readonly #now: () => number;

  constructor(options: CredentialRevocationOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** 本人の解除。対象のソースが token_vault / esc でなければ false。 */
  async disconnect(identity: Identity, sourceId: string): Promise<boolean> {
    const { vault, store, sources, events } = this.#o;
    const userId = identity.userId;
    const vaultClient = sources.vault.get(sourceId);
    if (vaultClient !== undefined && vault !== undefined) {
      const entry = await vault.get(userId, sourceId);
      const accepted = entry !== null ? await vaultClient.revoke(entry.tokens) : true;
      await vault.delete(userId, sourceId);
      this.#o.invalidateCredential?.(userId, sourceId);
      await events({
        userId,
        event: "disconnected",
        sourceId,
        method: "token_vault",
        outcome: "success",
        ...(accepted ? {} : { reason: "source_revocation_failed" }),
      });
      return true;
    }
    const escClient = sources.esc.get(sourceId);
    if (escClient !== undefined && store !== undefined) {
      const now = this.#now();
      await store.addDenial("sub_source", subSourceKey(userId, sourceId), now + 1, now + this.#o.denialRetentionMs);
      const tokens = identity.session.esc?.sources[sourceId];
      const accepted = tokens !== undefined ? await escClient.revoke(tokens) : false;
      await events({
        userId,
        event: "disconnected",
        sourceId,
        method: "esc",
        outcome: "success",
        ...(accepted ? {} : { reason: "source_revocation_not_requested" }),
      });
      return true;
    }
    return false;
  }

  /** 利用停止(IdP 起点)。 */
  async deprovision(userId: string): Promise<DeprovisionResult> {
    const { vault, store, sources, events } = this.#o;
    let revokedAtSource = 0;
    let deleted = 0;
    const failed: string[] = [];
    if (vault !== undefined) {
      for (const sourceId of await vault.sourcesForUser(userId)) {
        const client = sources.vault.get(sourceId);
        const entry = await vault.get(userId, sourceId).catch(() => null);
        const accepted = client !== undefined && entry !== null ? await client.revoke(entry.tokens) : false;
        if (accepted) {
          revokedAtSource += 1;
        } else {
          failed.push(sourceId);
        }
        if (await vault.delete(userId, sourceId)) {
          deleted += 1;
        }
        await events({
          userId,
          event: "revoked",
          sourceId,
          method: "token_vault",
          outcome: accepted ? "success" : "failure",
          ...(accepted ? {} : { reason: "source_revocation_failed" }),
        });
      }
    }
    if (store !== undefined) {
      const now = this.#now();
      // 同じミリ秒に発行されたトークンも拒否する(+1)
      await store.addDenial("sub", userId, now + 1, now + this.#o.denialRetentionMs);
    }
    this.#o.invalidateUser(userId);
    await events({
      userId,
      event: "deprovisioned",
      outcome: "success",
      ...(failed.length > 0 ? { reason: "source_revocation_failed" } : {}),
    });
    return { revokedAtSource, deleted, sourceRevocationFailed: failed };
  }
}
