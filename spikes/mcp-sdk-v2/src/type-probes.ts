/**
 * [スパイク] (v) の型検査プローブ。実行はしない(tsc --noEmit の対象にするだけ)。
 * v1 1.29.0/1.30.1 で exactOptionalPropertyTypes と噛み合わなかった箇所
 * (ADR-001追補3「HTTP配線PRへの申し送り」)が v2 で解消したかを確かめる。
 * v2 で残った不整合は http.ts の toNodeHandler 呼び出し(TS2379)の1箇所。
 */
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

export async function probeServerTransports(): Promise<void> {
  const server = new Server({ name: "probe", version: "0.0.0" });
  // v1 では `{ sessionIdGenerator: undefined }` が型エラーだった。v2 の型は `| undefined` を明示している
  const web = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(web);

  // v1 では `as Transport` が要った(onclose / sessionId の型が噛み合わない)。
  // v2 は Node ラッパーもそのまま Transport IF に渡せる(実測: エラーなし)
  const node = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(node);
}
