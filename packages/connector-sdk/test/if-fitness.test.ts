/**
 * IF fitting 検証(ADR-007、v0.3への更新はADR-016)。
 *
 * 目的: 性質の異なる3ソース(Slack / Google Drive / ファイル共有上の
 * Office・PDF)の代表値を connector-sdk の型で表現できることを、
 * 実API接続なしにコンパイル時+最小の実行時検証で確認する。
 * ここでのコンパイルエラーが「IFの不足」の検出器である。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SNIPPET_CHARS,
  redactAuthContext,
  type AuthContext,
  type Connector,
  type ConnectorCapabilities,
  type FetchResult,
  type ListResult,
  type SearchHit,
  type SourceDescription,
} from "../src/index.js";

// ---- ケース1: Slack(意味単位=スレッド、複合ID、OAuthベアラー) ----
// 注: 実装はRTS/公式MCP第一候補(ADR-014)。型表現の検証としてのケース。

const slackAuth: AuthContext = {
  userId: "idp|taro.yamada",
  credential: {
    kind: "oauth_bearer",
    accessToken: "test-fixture-not-a-real-token",
    expiresAt: 1_900_000_000_000,
  },
};

const slackHit: SearchHit = {
  // 複合キー(channel + thread_ts)をコネクタ内で符号化: IF変更は不要
  documentId: "C0123456:1719999999.000100",
  title: "#proj-search 検索層の認可設計について",
  snippet: "post-filteringのK拡張は…",
  url: "https://acme.slack.com/archives/C0123456/p1719999999000100",
  anchor: { kind: "message", value: "1720000123.000200" },
  updatedAt: "2026-06-30T09:00:00Z",
};

const slackCaps: ConnectorCapabilities = {
  nativeSearch: "degraded", // RTS採用可否・semantic可否はT-006で評価(ADR-014)
  ingest: false, // ADR-014: Slackの中央インデックス化は原則不可
};

// ---- ケース2: Google Drive(ファイル単位、フルAPI) ----

const driveHit: SearchHit = {
  documentId: "1AbCdEfGhIjK",
  title: "Q3 事業計画レビュー議事録",
  snippet: "検索基盤の予算は…",
  url: "https://docs.google.com/document/d/1AbCdEfGhIjK",
  updatedAt: "2026-06-01T02:00:00Z",
  meta: { mimeType: "application/vnd.google-apps.document" },
};

const driveCaps: ConnectorCapabilities = { nativeSearch: "full", ingest: false };

// ---- ケース3: ファイル共有上の PDF / Office(index-required) ----

// 認可はベアラートークンではなく「本人としてのアクセス試行」。
// oauth_bearer では表現不能 → Credential 共用体の必要性の根拠。
// 具体方式(KCD等)はT-017のスパイクで確定する。
const fileShareAuth: AuthContext = {
  userId: "idp|taro.yamada",
  credential: { kind: "delegated_identity", principal: "taro.yamada@acme.local" },
};

// 長大PDFのヒットは「ファイル」でなく「ファイル内の位置」でないと
// LLMが原典に降りられない → HitAnchor の必要性の根拠。
const pdfHit: SearchHit = {
  documentId: "smb://fs01/share/契約/基本契約書_2025.pdf",
  title: "基本契約書_2025.pdf",
  snippet: "", // ネイティブ検索なし=degraded以下ではスニペット空を許容
  url: "file://fs01/share/%E5%A5%91%E7%B4%84/%E5%9F%BA%E6%9C%AC%E5%A5%91%E7%B4%84%E6%9B%B8_2025.pdf",
  anchor: { kind: "page", value: "34", label: "p.34" },
};

const fileShareCaps: ConnectorCapabilities = {
  nativeSearch: "none", // 検索層必須クラス(ADR-007)
  ingest: true,
};

const fileShareFetch: FetchResult = {
  documentId: "smb://fs01/share/契約/基本契約書_2025.pdf",
  title: "基本契約書_2025.pdf",
  content: "(p.34 抽出テキスト)…",
  url: "file://fs01/share/...",
  nextPageCursor: "page:35", // 既存のページングIFで長大文書を表現可能
};

// ---- Connector 契約全体が3ソースで実装可能かの型検証(擬似実装) ----

function stubConnector(
  sourceId: string,
  capabilities: ConnectorCapabilities,
  hit: SearchHit,
): Connector {
  const description: SourceDescription = {
    sourceId,
    displayName: sourceId,
    summary: "fitting stub",
    topContainers: [],
    supportedFilters: ["updatedAfter"],
  };
  const listResult: ListResult = { entries: [], nextCursor: undefined };
  return {
    sourceId,
    capabilities,
    describe: async () => description,
    // v0.3: SearchOptions(cursor/limit)を受ける
    search: async (_auth, _query, _filters, options) => ({
      hits: [hit].slice(0, options?.limit ?? 1),
    }),
    fetch: async () => fileShareFetch,
    // v0.3: listはカーソル付きのListResultを返す
    list: async () => listResult,
  };
}

describe("IF fitting (ADR-007 / ADR-016)", () => {
  it("expresses OAuth and delegated-identity credentials", () => {
    expect(slackAuth.credential.kind).toBe("oauth_bearer");
    expect(fileShareAuth.credential.kind).toBe("delegated_identity");
  });

  it("expresses in-document positions for long documents", () => {
    expect(pdfHit.anchor?.kind).toBe("page");
    expect(slackHit.anchor?.kind).toBe("message");
    expect(driveHit.anchor).toBeUndefined(); // 不要なソースでは省略可能
  });

  it("classifies native search strength across the three sources", () => {
    const classes = [slackCaps, driveCaps, fileShareCaps].map((c) => c.nativeSearch);
    expect(classes).toEqual(["degraded", "full", "none"]);
  });

  it("all three sources satisfy the Connector contract (v0.3: options / list paging)", async () => {
    const connectors = [
      stubConnector("slack", slackCaps, slackHit),
      stubConnector("gdrive", driveCaps, driveHit),
      stubConnector("fileshare", fileShareCaps, pdfHit),
    ];
    expect(connectors).toHaveLength(3);
    const limited = await connectors[0]!.search(slackAuth, "q", undefined, { limit: 0 });
    expect(limited.hits).toHaveLength(0);
    const listed = await connectors[1]!.list(slackAuth);
    expect(Array.isArray(listed.entries)).toBe(true);
  });

  it("redactAuthContext never leaks token material (不変条件6 / ADR-016)", () => {
    const redacted = JSON.stringify(redactAuthContext(slackAuth));
    expect(redacted).not.toContain("test-fixture-not-a-real-token");
    expect(redacted).toContain('"redacted":true');
    // delegated_identity: principalも文字列化対象から外れる
    const redactedFs = JSON.stringify(redactAuthContext(fileShareAuth));
    expect(redactedFs).not.toContain("taro.yamada@acme.local");
  });

  it("exposes the snippet length contract", () => {
    expect(MAX_SNIPPET_CHARS).toBeGreaterThan(0);
    expect(slackHit.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
  });
});
