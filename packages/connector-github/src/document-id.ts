/**
 * documentId の符号化・復号(ADR-007: 複合キーはコネクタ内で不透明文字列に符号化する)。
 *
 * 形式:
 * - issue:<owner>/<repo>#<number>
 * - pr:<owner>/<repo>#<number>
 * - file:<owner>/<repo>@<ref>:<path>   (ref はコミットSHA等。空ならデフォルトブランチ)
 *
 * documentId は検索結果だけでなく LLM(プロンプトインジェクションを含みうる)
 * からも渡されるため、復号時に厳格に検証する。owner / repo / path はそのまま
 * API パスに入るので、修飾子の混入(空白・コロン)とドットセグメントによる
 * エンドポイントのすり替えを構文で拒否する。
 */
import { ConnectorError } from "@kp/connector-sdk";

export type GitHubDocumentRef =
  | {
      readonly type: "issue" | "pr";
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
    }
  | {
      readonly type: "file";
      readonly owner: string;
      readonly repo: string;
      /** コミットSHA・ブランチ・タグ。空文字はデフォルトブランチ */
      readonly ref: string;
      readonly path: string;
    };

/**
 * ユーザー・組織のログイン名。英数字始まりの英数字・ハイフン・アンダースコア
 * (Enterprise Managed Users は "handle_shortcode" 形式のためアンダースコアを許す)。
 */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** リポジトリ名。英数字・ピリオド・ハイフン・アンダースコア。 */
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;
/**
 * git ref(git check-ref-format が禁じる空白・制御文字・~^:?*[\ を除く)。
 * ":" は documentId の区切りに使うため ref に現れないことが前提。
 */
const REF_PATTERN = /^[^\s\x00-\x1f\x7f~^:?*[\\]{1,255}$/;
const MAX_PATH_LENGTH = 4096;
const MAX_DOCUMENT_ID_LENGTH = 8192;

const INVALID_DOCUMENT_ID =
  "invalid GitHub documentId (expected issue:owner/repo#N, pr:owner/repo#N or file:owner/repo@ref:path)";

export function isValidOwner(value: string): boolean {
  return OWNER_PATTERN.test(value);
}

export function isValidRepoName(value: string): boolean {
  return REPO_PATTERN.test(value) && value !== "." && value !== "..";
}

export function isValidRef(value: string): boolean {
  return (
    REF_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.startsWith("/") &&
    !value.endsWith("/")
  );
}

/** リポジトリ内パス。空セグメント・"."・".."・制御文字を拒否する。 */
export function isValidContentPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) {
    return false;
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** "owner/repo" を分解する。不正なら undefined。 */
export function parseRepoFullName(
  value: string,
): { owner: string; repo: string } | undefined {
  const slash = value.indexOf("/");
  if (slash < 0) {
    return undefined;
  }
  const owner = value.slice(0, slash);
  const repo = value.slice(slash + 1);
  if (!isValidOwner(owner) || !isValidRepoName(repo)) {
    return undefined;
  }
  return { owner, repo };
}

function isEncodableRef(ref: GitHubDocumentRef): boolean {
  if (!isValidOwner(ref.owner) || !isValidRepoName(ref.repo)) {
    return false;
  }
  if (ref.type === "file") {
    return (ref.ref === "" || isValidRef(ref.ref)) && isValidContentPath(ref.path);
  }
  return (
    Number.isInteger(ref.number) &&
    ref.number >= 1 &&
    NUMBER_PATTERN.test(String(ref.number))
  );
}

/** 符号化する。構成要素が不正なら undefined(API応答の異常値を黙って通さない)。 */
export function tryEncodeDocumentId(ref: GitHubDocumentRef): string | undefined {
  if (!isEncodableRef(ref)) {
    return undefined;
  }
  if (ref.type === "file") {
    return `file:${ref.owner}/${ref.repo}@${ref.ref}:${ref.path}`;
  }
  return `${ref.type}:${ref.owner}/${ref.repo}#${ref.number}`;
}

export function encodeDocumentId(ref: GitHubDocumentRef): string {
  const encoded = tryEncodeDocumentId(ref);
  if (encoded === undefined) {
    throw new ConnectorError("invalid_request", INVALID_DOCUMENT_ID);
  }
  return encoded;
}

/**
 * 復号する。不正なら invalid_request(受領値はメッセージにエコーしない)。
 */
export function decodeDocumentId(documentId: string): GitHubDocumentRef {
  const ref = parseDocumentId(documentId);
  if (!ref) {
    throw new ConnectorError("invalid_request", INVALID_DOCUMENT_ID);
  }
  return ref;
}

function parseDocumentId(documentId: string): GitHubDocumentRef | undefined {
  if (documentId.length > MAX_DOCUMENT_ID_LENGTH) {
    return undefined;
  }
  const colon = documentId.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const type = documentId.slice(0, colon);
  const rest = documentId.slice(colon + 1);

  if (type === "issue" || type === "pr") {
    const hash = rest.lastIndexOf("#");
    if (hash < 0) {
      return undefined;
    }
    const repo = parseRepoFullName(rest.slice(0, hash));
    const number = rest.slice(hash + 1);
    if (!repo || !NUMBER_PATTERN.test(number)) {
      return undefined;
    }
    return { type, owner: repo.owner, repo: repo.repo, number: Number(number) };
  }

  if (type === "file") {
    // owner/repo は "@" を含まず、ref は ":" を含まないため、最初の "@" と
    // その後の最初の ":" で一意に分解できる(path は "@" や ":" を含みうる)
    const at = rest.indexOf("@");
    if (at < 0) {
      return undefined;
    }
    const repo = parseRepoFullName(rest.slice(0, at));
    const afterAt = rest.slice(at + 1);
    const separator = afterAt.indexOf(":");
    if (!repo || separator < 0) {
      return undefined;
    }
    const gitRef = afterAt.slice(0, separator);
    const path = afterAt.slice(separator + 1);
    if ((gitRef !== "" && !isValidRef(gitRef)) || !isValidContentPath(path)) {
      return undefined;
    }
    return { type: "file", owner: repo.owner, repo: repo.repo, ref: gitRef, path };
  }

  return undefined;
}

/** "/repos/{owner}/{repo}"(各セグメントをエンコード)。 */
export function repoApiPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** "/repos/{owner}/{repo}/contents/{path}"(path はセグメントごとにエンコード)。 */
export function contentApiPath(owner: string, repo: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${repoApiPath(owner, repo)}/contents/${encodedPath}`;
}
