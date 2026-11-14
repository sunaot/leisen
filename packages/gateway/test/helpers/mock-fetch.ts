/** テスト用の fetch(URL ごとの応答と、受けた要求の記録)。 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  form(): URLSearchParams;
  json(): unknown;
}

export type MockHandler = (request: RecordedRequest) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function mockFetch(routes: Record<string, MockHandler>) {
  const requests: RecordedRequest[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === "string" ? init.body : "";
    const request: RecordedRequest = {
      method,
      url,
      headers,
      body,
      form: () => new URLSearchParams(body),
      json: () => JSON.parse(body) as unknown,
    };
    requests.push(request);
    const path = url.split("?")[0] as string;
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${url}`] ?? routes[path];
    if (handler === undefined) {
      return new Response("not found", { status: 404 });
    }
    return handler(request);
  }) as typeof fetch;
  return { impl, requests };
}
