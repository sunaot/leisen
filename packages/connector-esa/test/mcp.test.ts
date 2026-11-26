import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConnectorError } from "@leisen/connector-sdk";
import { EsaMcpClient, READ_ONLY_TOOLS, checkMcpUrl, readToolResult } from "../src/mcp.js";
import { GOOD_TOKEN, startFakeEsaMcp, type FakeEsaMcp } from "./helpers/fake-esa-mcp.js";

let fake: FakeEsaMcp;

beforeAll(async () => {
  fake = await startFakeEsaMcp();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.calls.length = 0;
  fake.httpStatuses.length = 0;
  fake.forceStatus(undefined);
  fake.hang(false);
  fake.setTool("esa_search_posts", () => ({ text: JSON.stringify([{ url: "https://t.esa.io/posts/1", category_and_title_and_tags: "a/b" }]) }));
  fake.setTool("esa_get_post", () => ({ text: 'Error: {\n  "error": "not_found",\n  "message": "Not Found"\n}', isError: true }));
});

async function expectClass(promise: Promise<unknown>, errorClass: string): Promise<ConnectorError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  expect((error as ConnectorError).errorClass).toBe(errorClass);
  return error as ConnectorError;
}

describe("EsaMcpClient(認可の分岐)", () => {
  it("本人のトークンを Authorization: Bearer で送る", async () => {
    const client = new EsaMcpClient({ url: fake.url, timeoutMs: 5_000 });
    const result = await client.callTool(GOOD_TOKEN, "esa_search_posts", { teamName: "t", query: "x" });
    expect(Array.isArray(result)).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.authorization).toBe(`Bearer ${GOOD_TOKEN}`);
    expect(fake.calls[0]?.args).toEqual({ teamName: "t", query: "x" });
  });

  it("トークンが空なら上流を呼ばずに auth_expired", async () => {
    const client = new EsaMcpClient({ url: fake.url, timeoutMs: 5_000 });
    await expectClass(client.callTool("", "esa_search_posts", {}), "auth_expired");
    expect(fake.httpStatuses).toHaveLength(0);
  });

  it("上流の 401 は auth_expired(応答本文・トークンをメッセージに含めない)", async () => {
    const client = new EsaMcpClient({ url: fake.url, timeoutMs: 5_000 });
    const error = await expectClass(client.callTool("someone-elses-token", "esa_search_posts", {}), "auth_expired");
    expect(error.message).not.toContain("someone-elses-token");
    expect(error.message).not.toContain("Missing or invalid");
  });

  it("403 は permission_denied、429 は rate_limited、5xx は source_unavailable", async () => {
    const client = new EsaMcpClient({ url: fake.url, timeoutMs: 5_000 });
    for (const [status, errorClass] of [
      [403, "permission_denied"],
      [429, "rate_limited"],
      [503, "source_unavailable"],
    ] as const) {
      fake.forceStatus(status);
      const error = await expectClass(client.callTool(GOOD_TOKEN, "esa_search_posts", {}), errorClass);
      expect(error.message).not.toContain("secret-looking");
    }
  });

  it("書き込み系のツールは型の外から渡されても上流を呼ばずに拒否する", async () => {
    const client = new EsaMcpClient({ url: fake.url, timeoutMs: 5_000 });
    // 実行時の防御の試験: 型の外の値を渡す
    const name = "esa_create_post" as unknown as (typeof READ_ONLY_TOOLS)[number];
    await expectClass(client.callTool(GOOD_TOKEN, name, {}), "invalid_request");
    expect(fake.httpStatuses).toHaveLength(0);
  });

  it("ツールのエラー(isError)は esa のコードで分類する", async () => {
    const client = new EsaMcpClient({ url: fake.url, timeoutMs: 5_000 });
    await expectClass(client.callTool(GOOD_TOKEN, "esa_get_post", { postNumber: 1 }), "not_found");
  });

  it("期限を過ぎたら source_unavailable", async () => {
    fake.hang(true);
    const client = new EsaMcpClient({ url: fake.url, timeoutMs: 1_000 });
    const error = await expectClass(client.callTool(GOOD_TOKEN, "esa_search_posts", {}), "source_unavailable");
    expect(error.message).toContain("timed out");
  });
});

describe("readToolResult / checkMcpUrl", () => {
  it("structuredContent を優先し、text の JSON を読む", () => {
    expect(readToolResult({ content: [], structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(readToolResult({ content: [{ type: "text", text: '{"b":2}' }] })).toEqual({ b: 2 });
  });

  it("JSON でない・空の結果は source_unavailable(黙って空にしない)", () => {
    expect(() => readToolResult({ content: [{ type: "text", text: "hello" }] })).toThrow(ConnectorError);
    expect(() => readToolResult({ content: [] })).toThrow(ConnectorError);
  });

  it("isError のコードの対応(unauthorized → auth_expired、未知 → source_unavailable)", () => {
    const classOf = (text: string) => {
      try {
        readToolResult({ content: [{ type: "text", text }], isError: true });
      } catch (error) {
        return (error as ConnectorError).errorClass;
      }
      return undefined;
    };
    expect(classOf('Error: {"error":"unauthorized"}')).toBe("auth_expired");
    expect(classOf('Error: {"error":"forbidden"}')).toBe("permission_denied");
    expect(classOf('Error: {"error":"too_many_requests"}')).toBe("rate_limited");
    expect(classOf("Error: boom")).toBe("source_unavailable");
  });

  it("URL は https(平文はループバックだけ)、資格情報入りは拒否", () => {
    expect(checkMcpUrl("https://mcp.esa.io/").host).toBe("mcp.esa.io");
    expect(() => checkMcpUrl("http://mcp.esa.io/")).toThrow(RangeError);
    expect(() => checkMcpUrl("https://u:p@mcp.esa.io/")).toThrow(RangeError);
    expect(checkMcpUrl("http://127.0.0.1:9/").protocol).toBe("http:");
  });
});
