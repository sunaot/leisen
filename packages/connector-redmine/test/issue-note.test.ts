import { expect, it, vi } from "vitest";
import type { AuthContext } from "@leisen/connector-sdk";
import { RedmineConnector } from "../src/redmine.js";

const baseUrl = "https://redmine.example.invalid/redmine/";
const query = "v4l2-no-scale-overlay";
const noteText = `Use --enable-${query} for the overlay.`;
const documentId = "issue-note:42:319";
const noteUrl = `${baseUrl}issues/42#change-319`;

function apiKeyAuth(userId: string): AuthContext {
  return { userId, credential: { kind: "api_key", apiKey: `test-key-${userId}` } };
}

function setup({ publicProject = true, privateIssue = false, privateNote = false } = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const key = headers.get("X-Redmine-API-Key");
    expect(["test-key-alice", "test-key-bob"]).toContain(key);
    expect(headers.has("Authorization")).toBe(false);
    expect(url.origin).toBe(new URL(baseUrl).origin);
    expect(url.searchParams.has("key")).toBe(false);

    switch (url.pathname) {
      case "/redmine/search.json":
        expect(url.searchParams.get("q")).toBe(query);
        return Response.json({
          // Simulate an index hit that still needs to be checked against the issue API.
          results: [
            { id: 108, type: "attachment", title: "overlay.patch" },
            {
              id: 319,
              type: "issue-note",
              title: "Note on #42",
              url: noteUrl,
              description: "Excerpt from the search index",
            },
          ],
          total_count: 2,
        });
      case "/redmine/issues/42.json":
        expect(url.searchParams.get("include")).toBe("journals");
        return Response.json({
          issue: {
            id: 42,
            subject: "Overlay support",
            project: { id: 7 },
            is_private: privateIssue,
            journals: key === "test-key-alice"
              ? [{ id: 319, notes: noteText, private_notes: privateNote }]
              : [{ id: 320, notes: "Another visible note", private_notes: false }],
          },
        });
      case "/redmine/projects/7.json":
        return Response.json({ project: { id: 7, is_public: publicProject } });
      default:
        throw new Error(`Unexpected Redmine path: ${url.pathname}`);
    }
  });
  const connector = new RedmineConnector({ sourceId: "redmine", baseUrl, fetchImpl });
  return { connector, fetchImpl };
}

it.each([
  { publicProject: true, privateIssue: false, privateNote: false, scope: "shared" },
  { publicProject: false, privateIssue: false, privateNote: false, scope: "private" },
  { publicProject: true, privateIssue: true, privateNote: false, scope: "private" },
  { publicProject: true, privateIssue: false, privateNote: true, scope: "private" },
])("searches and fetches an issue note with scope $scope (project public=$publicProject, issue private=$privateIssue, note private=$privateNote)", async ({ scope, ...options }) => {
  const { connector } = setup(options);
  const auth = apiKeyAuth("alice");
  const result = await connector.search(auth, query);
  expect(result.hits).toEqual([
    { documentId, title: "Note on #42", snippet: noteText, url: noteUrl, scope },
  ]);
  await expect(connector.fetch(auth, result.hits[0]!.documentId)).resolves.toMatchObject({
    documentId,
    content: noteText,
    url: noteUrl,
    scope,
  });
});

it("requires the note to appear in the journals visible to the calling user", async () => {
  const { connector, fetchImpl } = setup({ privateNote: true });
  const alice = apiKeyAuth("alice");
  const bob = apiKeyAuth("bob");

  await expect(connector.search(alice, query)).resolves.toMatchObject({
    hits: [expect.objectContaining({ documentId })],
  });
  await expect(connector.search(bob, query)).resolves.toEqual({ hits: [] });
  await expect(connector.fetch(bob, documentId)).rejects.toMatchObject({ errorClass: "not_found" });

  const keys = fetchImpl.mock.calls.map(([, init]) =>
    new Headers(init?.headers).get("X-Redmine-API-Key"),
  );
  expect(keys).toEqual([
    "test-key-alice", "test-key-alice",
    "test-key-bob", "test-key-bob", "test-key-bob",
  ]);
});

it("rejects an empty API key before contacting Redmine", async () => {
  const { connector, fetchImpl } = setup();
  await expect(connector.search({
    userId: "alice",
    credential: { kind: "api_key", apiKey: "" },
  }, query)).rejects.toMatchObject({ errorClass: "invalid_request" });
  expect(fetchImpl).not.toHaveBeenCalled();
});
