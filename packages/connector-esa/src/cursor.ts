/**
 * 不透明なカーソル(ADR-016 追補2 決定4)。中身は用途の印とページ番号だけで、結果の
 * 識別子・本文の断片・private の情報を符号化しない。用途の違うカーソル(検索・一覧・本文の
 * ページ)の取り違えは invalid_request にする
 */
import { ConnectorError } from "@leisen/connector-sdk";

export type CursorKind = "s" | "l" | "f";

export function encodeCursor(kind: CursorKind, page: number): string {
  return Buffer.from(`esa1:${kind}:${page}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, kind: CursorKind): number {
  if (typeof cursor !== "string" || cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new ConnectorError("invalid_request", "cursor is malformed");
  }
  const match = /^esa1:([slf]):(\d{1,4})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (match === null || match[1] !== kind) {
    throw new ConnectorError("invalid_request", "cursor is malformed");
  }
  const page = Number(match[2]);
  if (page < 0 || page > 10_000) {
    throw new ConnectorError("invalid_request", "cursor is malformed");
  }
  return page;
}
