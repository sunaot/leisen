import { expect, it, vi } from "vitest";
import type { AuthContext } from "@leisen/connector-sdk";
import { RedmineConnector } from "../src/redmine.js";

const baseUrl = "https://redmine.example.invalid/redmine/";
const query = "v4l2-no-scale-overlay";
const noteText = `Use --enable-${query} for the overlay.`;
const documentId = "issue-note:42:319";
const noteUrl = `${baseUrl}issues/42#change-319`;

function apiKeyAuth(userId: string): AuthContext {
  return { userId, credential: { kind: "api_key", apiKey: `test-key-${userId}`, expiresAt: 0 } };
}

function setup({
  publicProject = true,
  privateIssue = false,
  privateNote = false,
  standardSearch = false,
  notes = noteText,
} = {}) {
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
          results: standardSearch ? [
            { id: 42, type: "issue", title: "Overlay support", description: "Issue description" },
          ] : [
            { id: 108, type: "attachment", title: "overlay.patch" },
            {
              id: 319,
              type: "issue-note",
              title: "Note on #42",
              url: noteUrl,
              description: "Excerpt from the search index",
            },
          ],
          total_count: standardSearch ? 1 : 2,
        });
      case "/redmine/issues/42.json":
        if (!standardSearch) expect(url.searchParams.get("include")).toBe("journals");
        return Response.json({
          issue: {
            id: 42,
            subject: "Overlay support",
            project: { id: 7 },
            is_private: privateIssue,
            journals: url.searchParams.get("include") !== "journals" ? [] : key === "test-key-alice"
              ? [{ id: 319, notes, private_notes: privateNote }]
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

it("follows a standard search issue hit to its notes and then to an anchored note", async () => {
  const { connector } = setup({ standardSearch: true });
  const auth = apiKeyAuth("alice");
  const search = await connector.search(auth, query);
  expect(search.hits[0]?.documentId).toBe("issue:42");
  const issue = await connector.fetch(auth, search.hits[0]!.documentId);
  expect(issue.content).toContain(noteText);
  expect(issue.content).toContain(`documentId: ${documentId}`);
  expect(issue.content).toContain(noteUrl);
  expect(issue.scope).toBe("shared");
  await expect(connector.fetch(auth, documentId)).resolves.toMatchObject({
    content: noteText, url: noteUrl,
  });
});

it("returns only journals visible to the user when fetching the parent issue", async () => {
  const { connector } = setup({ standardSearch: true, privateNote: true });
  const alice = await connector.fetch(apiKeyAuth("alice"), "issue:42");
  expect(alice.content).toContain(noteText);
  expect(alice.scope).toBe("private");
  const bob = await connector.fetch(apiKeyAuth("bob"), "issue:42");
  expect(bob.content).not.toContain(noteText);
  expect(bob.content).not.toContain(documentId);
  expect(bob.content).toContain("Another visible note");
  expect(bob.scope).toBe("shared");
});

it("paginates long issue histories so later notes remain accessible", async () => {
  const notes = "x".repeat(100_000) + " end of note";
  const { connector } = setup({ standardSearch: true, notes });
  const auth = apiKeyAuth("alice");
  const first = await connector.fetch(auth, "issue:42");
  expect(first.content).toHaveLength(100_000);
  expect(first.nextPageCursor).toBe("offset:100000");
  const second = await connector.fetch(auth, "issue:42", first.nextPageCursor);
  expect(first.content + second.content).toContain(notes);
  expect(second.nextPageCursor).toBeUndefined();
  await expect(connector.fetch(auth, "issue:42", "bad-cursor")).rejects.toMatchObject({
    errorClass: "invalid_request",
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
    credential: { kind: "api_key", apiKey: "", expiresAt: 0 },
  }, query)).rejects.toMatchObject({ errorClass: "invalid_request" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([
  ["過去の失効時刻", 1],
  ["有限でない失効時刻", Number.NaN],
])("rejects an API key with %s as auth_expired before contacting Redmine (ADR-024)", async (_label, expiresAt) => {
  const { connector, fetchImpl } = setup();
  await expect(connector.search({
    userId: "alice",
    credential: { kind: "api_key", apiKey: "test-key-alice", expiresAt },
  }, query)).rejects.toMatchObject({ errorClass: "auth_expired" });
  expect(fetchImpl).not.toHaveBeenCalled();
});
