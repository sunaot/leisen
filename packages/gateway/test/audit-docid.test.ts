import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIVATE_SCOPE_DOC_ID_POLICY,
  redactDocIdForAudit,
  redactDocIdsForAudit,
  type DocIdAuditConfig,
} from "../src/audit/index.js";

const hashedConfig: DocIdAuditConfig = {
  privateScopeDocIds: "hashed",
  hmacKey: "deployment-secret-key",
};

describe("docId redaction for audit (ADR-013 §2)", () => {
  it("defaults to hashed policy", () => {
    expect(DEFAULT_PRIVATE_SCOPE_DOC_ID_POLICY).toBe("hashed");
  });

  it("records public-scope docIds as-is", () => {
    const out = redactDocIdForAudit(
      "gdrive:doc-123",
      { privateScope: false, slackOrigin: false },
      hashedConfig,
    );
    expect(out).toBe("gdrive:doc-123");
  });

  it("hashes private-scope docIds with the deployment key", () => {
    const out = redactDocIdForAudit(
      "gdrive:private-doc",
      { privateScope: true, slackOrigin: false },
      hashedConfig,
    );
    expect(out).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(out).not.toContain("private-doc");
    // 同一デプロイ鍵では安定(参照頻度集計を保つ)、鍵が違えば異なる
    const again = redactDocIdForAudit(
      "gdrive:private-doc",
      { privateScope: true, slackOrigin: false },
      hashedConfig,
    );
    expect(again).toBe(out);
    const otherKey = redactDocIdForAudit(
      "gdrive:private-doc",
      { privateScope: true, slackOrigin: false },
      { privateScopeDocIds: "hashed", hmacKey: "other-key" },
    );
    expect(otherKey).not.toBe(out);
  });

  it("omits private-scope docIds under the omitted policy", () => {
    const out = redactDocIdForAudit(
      "gdrive:private-doc",
      { privateScope: true, slackOrigin: false },
      { privateScopeDocIds: "omitted" },
    );
    expect(out).toBeNull();
  });

  it("never records Slack-origin docIds, regardless of policy (ADR-014, invariant 7)", () => {
    for (const config of [
      hashedConfig,
      { privateScopeDocIds: "omitted" } satisfies DocIdAuditConfig,
    ]) {
      for (const privateScope of [true, false]) {
        const out = redactDocIdForAudit(
          "slack:C123:1699999999.000100",
          { privateScope, slackOrigin: true },
          config,
        );
        expect(out).toBeNull();
      }
    }
  });

  it("fails closed when hashed policy has no key (no plaintext fallback)", () => {
    expect(() =>
      redactDocIdForAudit(
        "gdrive:private-doc",
        { privateScope: true, slackOrigin: false },
        { privateScopeDocIds: "hashed" },
      ),
    ).toThrow(/hmacKey/);
  });

  it("filters omitted docIds out of citedDocIds arrays", () => {
    const out = redactDocIdsForAudit(
      [
        { docId: "gdrive:doc-1", origin: { privateScope: false, slackOrigin: false } },
        { docId: "slack:C1:1.2", origin: { privateScope: false, slackOrigin: true } },
        { docId: "gdrive:priv-1", origin: { privateScope: true, slackOrigin: false } },
      ],
      hashedConfig,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("gdrive:doc-1");
    expect(out[1]).toMatch(/^hmac:/);
    expect(out.join(",")).not.toContain("slack:");
  });
});
