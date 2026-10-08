/**
 * T-019 テスト用の GitHub REST API フェイクとフィクスチャ。
 *
 * - FakeGitHub: 注入 fetch(FetchLike)として動作し、全リクエスト(URL・ヘッダ)を
 *   記録する。ルートは pathname の正規表現で登録する
 * - トークンは dev-only のダミー値のみを使う(不変条件6)。実トークン形式の
 *   文字列はフィクスチャに書かない
 */
import type { AuthContext } from "@kp/connector-sdk";
import {
  createGitHubConnector,
  type FetchLike,
  type GitHubConnectorOptions,
} from "../../src/index.js";

/** テストの基準時刻(固定)。 */
export const NOW = Date.UTC(2026, 8, 27, 3, 0, 0);
export const NOW_EPOCH_SEC = Math.floor(NOW / 1000);

export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly signal: AbortSignal | undefined;
  readonly redirect: RequestRedirect | undefined;
}

export type RouteHandler = (
  request: RecordedRequest,
) => Response | Promise<Response>;

export interface ResponseSpec {
  status?: number;
  headers?: Record<string, string>;
}

export function jsonResponse(body: unknown, spec: ResponseSpec = {}): Response {
  return new Response(JSON.stringify(body), {
    status: spec.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...spec.headers,
    },
  });
}

export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: { pattern: RegExp; handler: RouteHandler }[] = [];

  /** pathname に一致するルートを登録する(後から登録したものが優先)。 */
  on(pattern: RegExp, handler: RouteHandler): this {
    this.routes.unshift({ pattern, handler });
    return this;
  }

  onJson(pattern: RegExp, body: unknown, spec: ResponseSpec = {}): this {
    return this.on(pattern, () => jsonResponse(body, spec));
  }

  readonly fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const request: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      signal: init.signal ?? undefined,
      redirect: init.redirect,
    };
    this.requests.push(request);
    const route = this.routes.find((r) => r.pattern.test(url.pathname));
    if (!route) {
      return jsonResponse({ message: "Not Found" }, { status: 404 });
    }
    return route.handler(request);
  };

  requestsTo(pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => pattern.test(r.url.pathname));
  }
}

export class FakeClock {
  constructor(public current: number = NOW) {}
  readonly now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

export function devToken(userId: string): string {
  return `dev-only-token-${userId}`;
}

export function bearerAuth(
  userId: string,
  overrides: { accessToken?: string; expiresAt?: number } = {},
): AuthContext {
  return {
    userId,
    credential: {
      kind: "oauth_bearer",
      accessToken: overrides.accessToken ?? devToken(userId),
      expiresAt: overrides.expiresAt ?? NOW + 60 * 60 * 1000,
    },
  };
}

export const ALICE = bearerAuth("alice");
export const BOB = bearerAuth("bob");
export const DELEGATED: AuthContext = {
  userId: "carol",
  credential: { kind: "delegated_identity", principal: "carol@corp.example" },
};

export function setup(options: GitHubConnectorOptions = {}) {
  const github = new FakeGitHub();
  const clock = new FakeClock();
  const connector = createGitHubConnector({
    fetchImpl: github.fetchImpl,
    now: clock.now,
    ...options,
  });
  return { github, clock, connector };
}

/** 検索クエリ q(デコード済み)。 */
export function qOf(request: RecordedRequest): string {
  return request.url.searchParams.get("q") ?? "";
}

export function bearerOf(request: RecordedRequest): string | null {
  return request.headers.get("authorization");
}

// ---- フィクスチャ(GitHub REST API のレスポンス形状の最小部分) ----

export const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

export interface IssueFixture {
  owner?: string;
  repo?: string;
  number: number;
  title?: string;
  body?: string | null;
  pullRequest?: boolean;
  mergedAt?: string | null;
  state?: string;
  login?: string;
  comments?: number;
  updatedAt?: string;
  labels?: string[];
}

export function issueItem(f: IssueFixture): Record<string, unknown> {
  const owner = f.owner ?? "acme";
  const repo = f.repo ?? "app";
  const kind = f.pullRequest ? "pull" : "issues";
  return {
    url: `https://api.github.com/repos/${owner}/${repo}/issues/${f.number}`,
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
    html_url: `https://github.com/${owner}/${repo}/${kind}/${f.number}`,
    number: f.number,
    title: f.title ?? `Issue title ${f.number}`,
    body: f.body === undefined ? `Body of ${f.number}` : f.body,
    state: f.state ?? "open",
    user: { login: f.login ?? "octo-dev" },
    labels: (f.labels ?? []).map((name) => ({ name })),
    comments: f.comments ?? 0,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: f.updatedAt ?? "2026-09-20T00:00:00Z",
    ...(f.pullRequest
      ? {
          pull_request: {
            url: `https://api.github.com/repos/${owner}/${repo}/pulls/${f.number}`,
            html_url: `https://github.com/${owner}/${repo}/pull/${f.number}`,
            merged_at: f.mergedAt ?? null,
          },
        }
      : {}),
  };
}

export interface CodeFixture {
  owner?: string;
  repo?: string;
  path: string;
  ref?: string;
  fragments?: string[];
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function codeItem(f: CodeFixture): Record<string, unknown> {
  const owner = f.owner ?? "acme";
  const repo = f.repo ?? "app";
  const ref = f.ref ?? COMMIT_SHA;
  return {
    name: f.path.split("/").at(-1),
    path: f.path,
    sha: "fedcba9876543210fedcba9876543210fedcba98",
    url: `https://api.github.com/repositories/42/contents/${encodePath(f.path)}?ref=${ref}`,
    html_url: `https://github.com/${owner}/${repo}/blob/${ref}/${encodePath(f.path)}`,
    repository: {
      full_name: `${owner}/${repo}`,
      name: repo,
      owner: { login: owner },
      private: true,
    },
    score: 1,
    ...(f.fragments
      ? {
          text_matches: f.fragments.map((fragment) => ({
            object_type: "FileContent",
            property: "content",
            fragment,
            matches: [],
          })),
        }
      : {}),
  };
}

/**
 * 検索レスポンス。total_count にはカナリア値を入れ、SearchResult に
 * 件数が流出しないこと(ADR-012)の検査に使う。
 */
export const TOTAL_COUNT_CANARY = 987_654;

export function searchResponse(
  items: unknown[],
  options: { next?: boolean; headers?: Record<string, string> } = {},
): Response {
  return jsonResponse(
    {
      total_count: TOTAL_COUNT_CANARY,
      incomplete_results: false,
      items,
    },
    {
      headers: {
        ...(options.next
          ? {
              link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next", <https://api.github.com/search/issues?q=x&page=9>; rel="last"',
            }
          : {}),
        ...options.headers,
      },
    },
  );
}

export function linkNext(): Record<string, string> {
  return {
    link: '<https://api.github.com/user/repos?per_page=100&page=2>; rel="next", <https://api.github.com/user/repos?per_page=100&page=3>; rel="last"',
  };
}

export function fileContentResponse(
  path: string,
  bytes: Uint8Array | string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const buffer =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  // GitHub は 60 文字ごとに改行を挟んだ base64 を返す
  const base64 = buffer.toString("base64").replace(/(.{60})/g, "$1\n");
  return {
    type: "file",
    encoding: "base64",
    size: buffer.length,
    name: path.split("/").at(-1),
    path,
    content: base64,
    sha: "fedcba9876543210fedcba9876543210fedcba98",
    html_url: `https://github.com/acme/app/blob/${COMMIT_SHA}/${encodePath(path)}`,
    ...extra,
  };
}
