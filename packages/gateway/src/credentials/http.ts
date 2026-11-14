/**
 * 外部 HTTP 呼び出しの薄いラッパー(CLAUDE.md 開発ルール: 外部 SaaS・KMS の API は
 * 薄いラッパー越しに使い、タイムアウトを設定から注入可能にする)。
 *
 * - fetch は注入可能(テストでモックする)
 * - タイムアウトは AbortSignal.timeout。超過・到達不能は HttpCallError("unreachable")
 * - 応答本文を読むのは呼び出し側。エラーに URL のクエリ・本文・ヘッダを含めない
 *   (トークン・コードが載りうる。不変条件6)
 */
export type FetchLike = typeof fetch;

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export interface HttpClientOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export class HttpCallError extends Error {
  constructor(
    public readonly kind: "unreachable" | "timeout",
    /** 呼び出し先の説明(ホスト名まで。クエリ・本文は含めない) */
    target: string,
  ) {
    super(`${kind === "timeout" ? "timed out calling" : "could not reach"} ${target}`);
    this.name = "HttpCallError";
  }
}

/** 呼び出し先の説明(origin のみ)。 */
export function describeTarget(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid url)";
  }
}

export class HttpClient {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: HttpClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      throw new HttpCallError(
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable",
        describeTarget(url),
      );
    }
  }

  /** application/x-www-form-urlencoded の POST(OAuth のトークンエンドポイント等)。 */
  postForm(
    url: string,
    form: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    return this.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    });
  }
}

/** JSON 応答を読む(読めなければ undefined)。 */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
