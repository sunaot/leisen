/**
 * 上流(Gateway・LLM バックエンド)への平文 http の許可 — `--allow-insecure-upstream`
 * (環境変数 KP_ALLOW_INSECURE_UPSTREAM=1)。T-021。kp-ask(1問)と kp-ask serve の両方で受ける。
 *
 * - 既定では Gateway の URL(parseGatewayUrl)も LLM のベース URL(httpBaseUrlSchema)も、
 *   ループバック以外は https 必須。compose のネットワーク内の Gateway(http://gateway:8787/mcp)や、
 *   コンテナからホストの LM Studio(http://host.docker.internal:1234/v1)は非ループバックの http に
 *   なるため、開発・評価用途に限ってこのフラグで許す。検証関数は変えず、検証の入口で分岐する
 *   (parseInsecureGatewayUrl / insecureHttpBaseUrlSchema。資格情報・クエリ等の規則は同じ)
 * - 平文の http では利用者のトークン・検索結果・会話(利用者の権限で取得した文書の本文)が経路上で
 *   読める。NODE_ENV=production ではフラグ自体を固定文言で拒否する(終了コード 2。Gateway の
 *   dev_only_in_production と同じ考え方。渡された環境に加えてプロセスの環境も見る)
 * - 有効時は、平文 http で接続する上流をホスト名だけで列挙した WARNING を1行出す
 */
import { httpBaseUrlSchema, type LlmBackendConfigInput } from "../config.js";
import { isPlainHttpBeyondLoopback, parseInsecureGatewayUrl } from "../gateway/mcp-client.js";

/** NODE_ENV=production で --allow-insecure-upstream を拒否するときの表示(固定文言)。 */
export const INSECURE_UPSTREAM_IN_PRODUCTION_MESSAGE =
  "--allow-insecure-upstream(環境変数 KP_ALLOW_INSECURE_UPSTREAM)は NODE_ENV=production では使えません。本番では Gateway と LLM バックエンドに https(またはループバック)で接続してください。";

/** USAGE に足す行。 */
export const INSECURE_UPSTREAM_USAGE_LINE =
  "  [--allow-insecure-upstream](環境変数 KP_ALLOW_INSECURE_UPSTREAM=1)Gateway・LLM のループバック以外の http を許す(開発・評価用途。NODE_ENV=production では使えない)";

/** 既定の規則で拒否されたときに添える案内(非ループバックの http だったとき)。 */
export const INSECURE_UPSTREAM_HINT =
  "開発・評価用途で別ホストの http に接続する場合は --allow-insecure-upstream を付けます(本番では使えません)。";

type Env = Readonly<Record<string, string | undefined>>;

export type InsecureUpstreamOption =
  | { readonly ok: true; readonly enabled: boolean }
  | { readonly ok: false; readonly message: string };

function isProduction(env: Env): boolean {
  return env["NODE_ENV"] === "production" || process.env["NODE_ENV"] === "production";
}

/**
 * フラグと環境変数を解釈する。環境変数は 1 / true で有効、0 / false / 空で無効、それ以外は誤記と
 * して拒否する(黙って有効・無効にしない)。有効で NODE_ENV=production なら拒否する。
 */
export function parseInsecureUpstreamOption(
  flag: boolean | undefined,
  env: Env,
): InsecureUpstreamOption {
  let enabled: boolean;
  if (flag === true) {
    enabled = true;
  } else {
    const raw = (env["KP_ALLOW_INSECURE_UPSTREAM"] ?? "").trim().toLowerCase();
    if (raw === "1" || raw === "true") {
      enabled = true;
    } else if (raw === "" || raw === "0" || raw === "false") {
      enabled = false;
    } else {
      return {
        ok: false,
        message: "環境変数 KP_ALLOW_INSECURE_UPSTREAM は 1(有効)または 0(無効)で指定してください。",
      };
    }
  }
  if (enabled && isProduction(env)) {
    return { ok: false, message: INSECURE_UPSTREAM_IN_PRODUCTION_MESSAGE };
  }
  return { ok: true, enabled };
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Gateway の URL が非ループバックの http か(既定の規則で拒否された理由がそれなら案内を添える)。 */
export function isInsecureGatewayUrl(raw: string): boolean {
  try {
    return isPlainHttpBeyondLoopback(parseInsecureGatewayUrl(raw));
  } catch {
    return false;
  }
}

/** 平文 http(ループバック以外)で接続する上流を、ホスト名だけで列挙する。 */
export function plainHttpUpstreams(input: {
  readonly gatewayUrl: string;
  readonly llm: LlmBackendConfigInput;
}): string[] {
  const upstreams: string[] = [];
  const gateway = parsedUrl(input.gatewayUrl);
  if (gateway !== undefined && isPlainHttpBeyondLoopback(gateway)) {
    upstreams.push(`Gateway: ${gateway.hostname}`);
  }
  if (input.llm.provider === "openai_compatible") {
    const llm = parsedUrl(input.llm.baseUrl);
    if (
      llm !== undefined &&
      llm.protocol === "http:" &&
      !httpBaseUrlSchema.safeParse(input.llm.baseUrl).success
    ) {
      upstreams.push(`LLM: ${llm.hostname}`);
    }
  }
  return upstreams;
}

/**
 * --allow-insecure-upstream が有効なときに起動ログへ出す WARNING(1行)。平文 http の上流がなければ
 * undefined(フラグがあっても https・ループバックなら経路上に平文で出ない)。ホスト名だけを出し、
 * パス・クエリ・ポート・キーは出さない。
 */
export function insecureUpstreamWarning(input: {
  readonly gatewayUrl: string;
  readonly llm: LlmBackendConfigInput;
}): string | undefined {
  const upstreams = plainHttpUpstreams(input);
  if (upstreams.length === 0) {
    return undefined;
  }
  return (
    `WARNING: 上流への接続が平文 http です(${upstreams.join("、")})。` +
    "利用者のトークンと会話(利用者の権限で取得した文書の本文)が経路上で読めます。" +
    "開発・評価用途に限ってください(--allow-insecure-upstream。本番では使えません)"
  );
}
