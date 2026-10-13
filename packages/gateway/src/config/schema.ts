/**
 * Deployment Profileスキーマ(T-010、ADR-005)。
 *
 * 導入1件の全構成を deployment.yaml 1枚で表現する。個社差分はこの設定と
 * 3つのプラグイン境界(Connector / IdP Adapter / Search Backend)でのみ
 * 吸収し、コアコードに個社分岐を入れない(不変条件8)。
 *
 * - 既定値はすべて「安全側」に倒す(ADR-013): privateScopes=excluded、
 *   audit.failureMode=fail-closed、privateScopeDocIds=hashed。
 * - 全オブジェクトを strictObject にする。導入先管理者の誤設定(AT-5)の
 *   代表例はキー名のtypoであり、未知キーは黙殺せず起動時に拒否する。
 * - このスキーマに秘密情報のフィールドを設けない(不変条件6)。秘密情報は
 *   環境変数名(*Env)で参照し、値の解決は loader の resolveIdpAdapterConfig
 *   が行う。したがって設定オブジェクトやzodエラーはそのままログに出せる。
 *   自由形式の connectors[].settings も同じ規律に従わせる(秘密情報らしいキー名を
 *   拒否する。findSecretLikeSettings)。
 * - 設定内の相対パス(connectors[].module / settings 内のパス / audit.jsonl.*)は
 *   設定ファイルの所在ディレクトリを基準に解決する(起動コードの規約。cwd に
 *   依存させない)。
 */
import { RUN_API_SEGMENT, runApiPathFor } from "../run/path.js";
import { z } from "zod";

/** 現行スキーマバージョン。構造変更時に増分し、migrate.ts に移行関数を足す。 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * 認可照会キャッシュTTLの上限(秒)。TTL内は権限剥奪が反映されないため、
 * 「5〜15分目安」(TM-C5)の上限15分をスキーマ上限とし、超過は起動時拒否
 * (TM-E3)。既定は下限側の5分。
 */
export const MAX_AUTHZ_CACHE_TTL_SEC = 900;
export const DEFAULT_AUTHZ_CACHE_TTL_SEC = 300;

const positiveDays = z.number().int().min(1);

/**
 * コネクタ単位の検索層設定(ADR-006)。全導入は enabled=false で開始し、
 * 昇格判定レポート(T-014)の証拠に基づき有効化する。
 */
const searchLayerSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Search Backendプラグインの識別子(ADR-006、Q3選定)。enabled=true時に必須 */
  backend: z.string().min(1).optional(),
  authzCacheTtlSec: z
    .number()
    .int()
    .min(1)
    .max(MAX_AUTHZ_CACHE_TTL_SEC)
    .default(DEFAULT_AUTHZ_CACHE_TTL_SEC),
});

/** コネクタ呼び出しタイムアウトの既定(ms)。 */
export const DEFAULT_CONNECTOR_TIMEOUT_MS = 30_000;

/**
 * ソース別のタイムアウト・レート制御(T-003)。外部SaaS呼び出しの制限値は
 * コードに埋めず、Gateway設定から注入する(CLAUDE.md開発ルール)。
 * レート制御はソース単位(APIクォータの保護が目的。TM-D3のコスト増幅抑止も
 * orchestrator.maxIterationsと併せてここで受ける)。
 */
const connectorLimitsSchema = z.strictObject({
  /** コネクタ呼び出し1回のタイムアウト(ms) */
  timeoutMs: z.number().int().min(1).default(DEFAULT_CONNECTOR_TIMEOUT_MS),
  /** Gateway側のソース別レート上限(リクエスト/分)。省略時は制限なし */
  maxRequestsPerMinute: z.number().int().min(1).optional(),
});

/**
 * コネクタ実装の識別子(connectors[].kind)の形式。プラグインのモジュール名
 * `@leisen/connector-<kind>` の導出に使うため、npmパッケージ名の一部として安全な
 * 文字(英小文字・数字・ハイフン、先頭は英小文字)に限る。
 */
export const CONNECTOR_KIND_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * connectors[].module(プラグインの import 指定子)の形式: npmパッケージ名
 * (サブパス可)、または `./` `../` `/` で始まるファイルパス。URLスキーム
 * (data: / http: / file: / node: 等)は受けない: 設定値からインラインコードや
 * リモートのコードを読み込む経路を作らない。
 */
const MODULE_SPECIFIER_PATTERN =
  /^(?:\.{1,2}\/|\/)[^\0]+$|^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/;

/** 環境変数名の形式(clientSecretEnv と同じ)。 */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * settings のキー名のうち、秘密情報の値そのものを置いたと推定されるもの
 * (末尾が token / secret / password / apiKey / privateKey / credential(s) /
 * cookie)。秘密はこの形のキーに置かず、`<name>Env` に環境変数名を書く。
 * 例: accessToken / clientSecret / apiKey は拒否、maxTokens / tokenLifetimeMs /
 * clientSecretEnv は許可。
 */
const SECRET_LIKE_SETTINGS_KEY =
  /(?:token|secret|passw(?:or)?d|api[-_]?key|private[-_]?key|credentials?|cookie)$/i;

export interface SecretLikeSetting {
  /** settings 内の位置(ネストを含む) */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * settings に秘密情報が置かれていそうな箇所を列挙する(不変条件6)。
 * 設定ファイル・zodエラー・起動ログに秘密の値を載せない規律を、自由形式の
 * settings にも及ぼすための防波堤(キー名による推定のため網羅ではない。
 * clientSecretEnv の形式強制と同じ「高確率で弾く」方針)。メッセージに値を含めない。
 * - 秘密らしいキー名(SECRET_LIKE_SETTINGS_KEY)は値の型によらず拒否
 * - `<name>Env` の文字列値は環境変数名の形式を要求(秘密の値の誤記を弾く)
 */
export function findSecretLikeSettings(
  value: unknown,
  path: readonly (string | number)[] = [],
): SecretLikeSetting[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findSecretLikeSettings(item, [...path, index]),
    );
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  const findings: SecretLikeSetting[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const at = [...path, key];
    if (key.endsWith("Env")) {
      if (typeof nested === "string" && !ENV_VAR_NAME_PATTERN.test(nested)) {
        findings.push({
          path: at,
          message: `${key} must be an environment variable NAME, not a secret value`,
        });
      }
      continue;
    }
    if (SECRET_LIKE_SETTINGS_KEY.test(key)) {
      findings.push({
        path: at,
        message:
          `settings must not contain secrets (${key}); put the secret in an environment ` +
          `variable and reference its NAME with "${key}Env" (invariant 6)`,
      });
      continue;
    }
    findings.push(...findSecretLikeSettings(nested, at));
  }
  return findings;
}

/**
 * コネクタ固有の秘密でない設定。解釈と検証はコネクタの factory が自分で行う
 * (bootstrap/plugins.ts)。秘密情報は置かない(上記の防波堤で拒否する)。
 */
const connectorSettingsSchema = z
  .record(z.string(), z.unknown())
  .superRefine((settings, ctx) => {
    for (const finding of findSecretLikeSettings(settings)) {
      ctx.addIssue({
        code: "custom",
        path: [...finding.path],
        message: finding.message,
      });
    }
  });

/**
 * コネクタの本人資格情報の取得方式(ADR-010 のソース別 Auth Adapter の選択)。
 * 当面は開発用の mock_env のみ: MockCredentialProvider が環境変数
 * LEISEN_MOCK_TOKEN_<SOURCEID> の固定トークンを本人資格情報として渡す
 * (NODE_ENV=production では起動時に拒否される)。T-004 で oauth_individual
 * (Token Vault)等を追加する。ここにも秘密情報を置かない(環境変数名で参照する)。
 * 有効なコネクタに auth がない構成は起動コードが拒否する
 * (connector_auth_provider_missing。スキーマ検証だけでは拒否しない)。
 */
const connectorAuthSchema = z.strictObject({
  provider: z.enum(["mock_env"]),
});

const connectorSchema = z
  .strictObject({
    /** コネクタの sourceId(Connector.sourceId と一致させる) */
    id: z.string().min(1),
    /**
     * コネクタ実装の識別子。組み込みの `dev-fixture`、またはプラグイン名
     * (モジュール `@leisen/connector-<kind>`)。省略時は id と同じ(下の transform)
     */
    kind: z
      .string()
      .regex(CONNECTOR_KIND_PATTERN, {
        error:
          "kind must be lowercase letters, digits and '-' starting with a letter " +
          "(it names the plugin module @leisen/connector-<kind>)",
      })
      .optional(),
    /**
     * プラグインの import 指定子。省略時は `@leisen/connector-<kind>`。
     * 相対パスは設定ファイルの所在ディレクトリ基準
     */
    module: z
      .string()
      .regex(MODULE_SPECIFIER_PATTERN, {
        error: "module must be an npm package name or a path starting with ./, ../ or /",
      })
      .optional(),
    /** コネクタ固有の秘密でない設定(factory が検証する)。既定 {} */
    settings: connectorSettingsSchema.default({}),
    /** 本人資格情報の取得方式。有効なコネクタでは起動時に必須 */
    auth: connectorAuthSchema.optional(),
    enabled: z.boolean().default(true),
    limits: connectorLimitsSchema.prefault({}),
    /**
     * DM・プライベートチャンネル・個人スコープの扱い(ADR-013 §1)。
     * 既定 excluded。consent は本人オプトイン同意モード。included への変更は
     * confirmPrivateScopesIncluded 必須(TM-E4)+利用規程整備(導入チェックリスト)。
     */
    privateScopes: z.enum(["excluded", "consent", "included"]).default("excluded"),
    /** privateScopes: included の明示確認フラグ。なければ起動拒否(ADR-013 §1) */
    confirmPrivateScopesIncluded: z.boolean().default(false),
    searchLayer: searchLayerSchema.prefault({}),
  })
  // kind の既定は id と同じ。解析後の設定では常に kind が確定している
  .transform(({ kind, ...rest }) => ({ ...rest, kind: kind ?? rest.id }));

/**
 * IdP Adapterプラグインの選択(T-002、ADR-005)。kind の追加はIdP Adapter
 * プラグイン境界内の変更でありコア改変を要しない。
 * 秘密情報(clientSecret)はファイルに書かず、環境変数名で参照する。
 */
const idpAdapterSchema = z.discriminatedUnion("kind", [
  // モックは開発専用。セッション対応表は環境変数 LEISEN_MOCK_SESSIONS から読む
  // (設定ファイルにセッショントークンを書かせない)。本番ビルドでの拒否は
  // idp/factory.ts と MockIdpAdapter が行う。
  z.strictObject({ kind: z.literal("mock") }),
  z.strictObject({
    kind: z.literal("keycloak"),
    baseUrl: z.string().min(1),
    realm: z.string().min(1),
    clientId: z.string().min(1),
    /**
     * clientSecret を保持する環境変数の名前(値ではない)。
     * 環境変数名の形式を強制することで、誤って秘密の値そのものを書いた
     * 場合に高確率で弾き、エラー経由の値エコーを防ぐ(不変条件6)。
     * エラーメッセージにも受領値を含めない。
     */
    clientSecretEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
        error: "clientSecretEnv must be an environment variable NAME, not a secret value",
      }),
    timeoutMs: z.number().int().min(1).optional(),
    /**
     * トークンの発行先(azp)として受け入れるクライアント ID の許可リスト(issue #16)。必須・空不可。
     * 利用者がログインする UI・MCP クライアントを realm に登録し、ここに列挙する。"*" は
     * 任意のクライアントを受け入れる開発専用の逃げ道で(他の項目と混在しても同じ扱い)、
     * NODE_ENV=production では起動コードが dev_only_in_production で拒否し、それ以外でも
     * leisen-gateway validate / serve が WARNING を出す
     */
    allowedClients: z.array(z.string().min(1)).min(1),
    /**
     * true なら aud に自分の clientId が含まれることを要求する(issue #16)。IdP 側で
     * Gateway を audience に加えるマッパー等が要る(リファレンス realm は設定済み)。既定 false
     */
    requireAudience: z.boolean().default(false),
    /**
     * 受け入れる発行者(iss)の明示(issue #16)。省略時は `<baseUrl>/realms/<realm>`。
     * IdP の公開 URL(トークンの iss)がイントロスペクションに使う baseUrl と異なる構成
     * (コンテナ間はサービス名、利用者はホスト名で呼ぶ等)でだけ書く
     */
    allowedIssuers: z
      .array(
        z.url({ error: 'allowedIssuers entries must be absolute URLs ("*" is not a wildcard here)' }),
      )
      .min(1)
      .optional(),
    /**
     * baseUrl が平文 http: でループバック以外を指すときの明示確認フラグ(issue #17)。
     * 省略時は false と同じ扱い(解析結果にはキーを補わない)。イントロスペクションの
     * 往復には clientSecret と利用者のセッショントークンが載るため、平文で内部網に
     * 出す構成は、経路が閉じた網(compose のサービス間ネットワーク等)であることを
     * 確認したうえで true にする。なければ静的検証が拒否する
     * (idp_plain_http_requires_confirmation。gateway.http.confirmExposedHost と同じ規約)
     */
    confirmPlainHttp: z.boolean().optional(),
  }),
]);

/**
 * GatewayのHTTP待ち受け(T-003、MCP Streamable HTTP)。既定はループバックのみ。
 * ループバック以外で待ち受けるには confirmExposedHost: true が必要(リファレンス
 * デプロイ T-012。コンテナでは 0.0.0.0 にし、TLS 終端は前段のリバースプロキシで行う)。
 * listen は起動コードが host / port で行い、path は createGatewayHttpServer
 * (proxy/http.ts)に渡す。
 */
export const DEFAULT_GATEWAY_HTTP_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_HTTP_PORT = 8787;
export const DEFAULT_GATEWAY_HTTP_PATH = "/mcp";
/** 認証不要の死活確認パス。予約済みのためMCPエンドポイントの path に使えない */
export const GATEWAY_HEALTH_PATH = "/healthz";

const gatewayHttpSchema = z.strictObject({
  host: z.string().min(1).default(DEFAULT_GATEWAY_HTTP_HOST),
  /**
   * host がループバック以外(0.0.0.0 等)のときの明示確認フラグ。省略時は false と
   * 同じ扱い(解析結果にはキーを補わない)。Gateway は TLS を終端せず、Origin / Host
   * ヘッダの検証(DNS rebinding 対策)もしない(T-003 レビュー minor-11)。ループバック
   * 以外で待ち受ける構成は、TLS 終端のリバースプロキシを前段に置く前提を確認したうえで
   * true にする。なければ起動コードが拒否する(http_host_exposed_requires_confirmation。
   * 検査は validate.ts の validateGatewayHttpExposure、手順は docs/install.md)
   */
  confirmExposedHost: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).default(DEFAULT_GATEWAY_HTTP_PORT),
  path: z
    .string()
    .regex(/^\/[A-Za-z0-9._~\-/]*$/, {
      error: "path must start with '/' and contain only unreserved URL characters",
    })
    .refine((path) => path !== GATEWAY_HEALTH_PATH, {
      error: `path "${GATEWAY_HEALTH_PATH}" is reserved for the health check`,
    })
    // run API(ADR-019)は MCP のパスと同じディレクトリの runs に置く(run/path.ts)。その位置を
    // MCP のパスにすると run API に到達できなくなるため予約する
    .refine((path) => runApiPathFor(path) !== path, {
      error: `path ending in "/${RUN_API_SEGMENT}" is reserved for the run API (ADR-019)`,
    })
    .default(DEFAULT_GATEWAY_HTTP_PATH),
});

/**
 * run API(ADR-019 決定3・4、T-023)の設定。秘密情報(runId の署名鍵・Orchestrator の
 * 資格情報)は環境変数名で参照する。既定値は T-023 で決めた案。
 */
export const DEFAULT_RUN_ID_KEY_ENV = "LEISEN_RUN_ID_KEY";
export const DEFAULT_RUN_ID_PREVIOUS_KEY_ENV = "LEISEN_RUN_ID_KEY_PREVIOUS";
export const DEFAULT_ORCHESTRATOR_CREDENTIAL_ENV = "LEISEN_ORCHESTRATOR_CREDENTIAL";
/** runId の有効期間の既定(秒)。Orchestrator の runTimeoutMs(既定 120 秒)より長くする */
export const DEFAULT_RUN_ID_TTL_SEC = 900;
/** 発行時刻からフィードバックを受ける期間の既定(秒)。7 日 */
export const DEFAULT_RUN_FEEDBACK_WINDOW_SEC = 7 * 24 * 3600;
/** /runs の本文の上限(バイト)の既定 */
export const DEFAULT_RUN_MAX_BODY_BYTES = 64 * 1024;
/** /runs の利用者ごとの頻度上限(3 経路の合計、リクエスト/分)の既定 */
export const DEFAULT_RUN_MAX_REQUESTS_PER_USER_PER_MINUTE = 60;

const envVarName = (what: string) =>
  z.string().regex(ENV_VAR_NAME_PATTERN, {
    error: `${what} must be an environment variable NAME, not a secret value`,
  });

const gatewayRunsSchema = z.strictObject({
  /**
   * runId の署名鍵(現行)を保持する環境変数の名前。値は 32 バイト以上のランダム値を
   * base64 / base64url / hex で書く(例: `openssl rand -base64 32`)。kid は鍵の SHA-256 の
   * 先頭 8 文字から導出する。欠落・短い・開発用の値は NODE_ENV=production で起動を拒否する。
   * production 以外で未設定なら起動ごとの一時鍵を使う(WARNING。再起動で runId が無効になる)
   */
  signingKeyEnv: envVarName("signingKeyEnv").default(DEFAULT_RUN_ID_KEY_ENV),
  /** 1 つ前の署名鍵(鍵の入れ替え中だけ設定する)。未設定なら現行だけを受ける */
  previousSigningKeyEnv: envVarName("previousSigningKeyEnv").default(
    DEFAULT_RUN_ID_PREVIOUS_KEY_ENV,
  ),
  /**
   * 呼び出し元が Orchestrator であることの資格情報(共有秘密)を保持する環境変数の名前。
   * Orchestrator と Gateway だけが持ち、署名鍵・docId の HMAC 鍵とは別の値にする。
   * 16 文字以上。production 以外で未設定なら開発用の既定値(WARNING)
   */
  orchestratorCredentialEnv: envVarName("orchestratorCredentialEnv").default(
    DEFAULT_ORCHESTRATOR_CREDENTIAL_ENV,
  ),
  /** runId の有効期間(秒)。tools/call と finish はこの間だけ受ける */
  ttlSec: z.number().int().min(1).max(86_400).default(DEFAULT_RUN_ID_TTL_SEC),
  /** 発行時刻からフィードバックを受ける期間(秒) */
  feedbackWindowSec: z
    .number()
    .int()
    .min(1)
    .max(365 * 24 * 3600)
    .default(DEFAULT_RUN_FEEDBACK_WINDOW_SEC),
  limits: z
    .strictObject({
      /** リクエスト本文の上限(バイト)。3 経路すべて */
      maxBodyBytes: z.number().int().min(1024).default(DEFAULT_RUN_MAX_BODY_BYTES),
      /** 質問の最大文字数(POST /runs) */
      maxQuestionChars: z.number().int().min(1).default(4_000),
      /** 引用の最大件数(finish) */
      maxCitations: z.number().int().min(0).default(50),
      /** searchedSources の最大件数(finish) */
      maxSearchedSources: z.number().int().min(0).default(50),
      /** sourceId・documentId・理由コードなど識別子の最大文字数 */
      maxIdChars: z.number().int().min(1).default(512),
      /** 利用者ごとの頻度上限(3 経路の合計、リクエスト/分) */
      maxRequestsPerUserPerMinute: z
        .number()
        .int()
        .min(1)
        .default(DEFAULT_RUN_MAX_REQUESTS_PER_USER_PER_MINUTE),
    })
    .prefault({}),
});

const gatewaySchema = z.strictObject({
  http: gatewayHttpSchema.prefault({}),
  runs: gatewayRunsSchema.prefault({}),
});

const orchestratorSchema = z.strictObject({
  // 上限は探索ループのコスト・API呼び出し増幅の抑止(TM-D3、AT-5の過大設定)
  maxIterations: z.number().int().min(1).max(20).default(6),
  /** 1質問あたりのLLMコスト上限(通貨単位は導入先の課金通貨)。消費者はT-007 */
  costLimitPerQuery: z.number().positive().optional(),
});

/** 起動コード(bootstrap/audit.ts)が解決できる監査シンクの識別子。 */
export const AUDIT_SINK_STDOUT = "stdout";
export const AUDIT_SINK_JSONL = "jsonl";

/**
 * audit.sink: jsonl の出力先(audit/jsonl.ts)。監査レコード(AuditRecord)を
 * 1行1件のJSONで追記する(promotion-report の入力形式)。相対パスは設定ファイルの
 * 所在ディレクトリ基準。rawQueryPath は生クエリ原文の短期保持テーブル
 * (ADR-011 §3)で、監査ログ本体と別ファイルにする。省略時は原文をプロセス内
 * メモリにのみ保持する(再起動で消える)。
 */
const auditJsonlSchema = z.strictObject({
  path: z.string().min(1),
  rawQueryPath: z.string().min(1).optional(),
});

const auditSchema = z.strictObject({
  /**
   * 監査シンクの識別子。収集基盤は導入先の運用に委ねる(product-design-v2)ため
   * 自由文字列とし、実体への解決はGateway組み立て(bootstrap/audit.ts)が行う。
   * 現在解決できるのは "stdout"(開発用。at-least-once非保証。sink.ts参照)と
   * "jsonl"(audit.jsonl.path 必須)。それ以外は起動時に拒否する(unknown_audit_sink)。
   */
  sink: z.string().min(1).default(AUDIT_SINK_STDOUT),
  /** sink: jsonl の出力先。sink: jsonl のとき必須(audit_sink_options_missing) */
  jsonl: auditJsonlSchema.optional(),
  /** 監査書き込み失敗時の挙動(ADR-011 §4)。fail-open は確認フラグ必須(TM-E2) */
  failureMode: z.enum(["fail-closed", "fail-open"]).default("fail-closed"),
  /** failureMode: fail-open の明示確認フラグ。セキュリティポリシー明文化が前提 */
  confirmFailOpen: z.boolean().default(false),
  /** プライベートスコープdocIdの記録方式(ADR-013 §2)。平文の選択肢は提供しない */
  privateScopeDocIds: z.enum(["hashed", "omitted"]).default("hashed"),
  /**
   * hashed の HMAC 鍵(デプロイ固有の秘密)を保持する環境変数の名前。Gateway が run API の
   * finish で引用 docId を不可逆化するときに使う(ADR-019 決定5)。プライベートスコープを
   * 持つソースが有効で hashed のときは起動時に必須(secret_env_missing)
   */
  docIdHmacKeyEnv: envVarName("docIdHmacKeyEnv").default("LEISEN_AUDIT_HMAC_KEY"),
  /** AnswerRun / ToolInvocation(監査ログ本体)の保持日数(ADR-013 §3) */
  retentionDays: positiveDays.default(365),
  /** rawQueryテーブルの保持日数(ADR-011 §3) */
  rawQueryRetentionDays: positiveDays.default(30),
  /** 分離テレメトリの保持日数(ADR-011 §2) */
  telemetryRetentionDays: positiveDays.default(14),
});

const chatHistorySchema = z.strictObject({
  /** チャット履歴の保持日数(ADR-013 §4)。エクスポート・共有機能は実装しない */
  retentionDays: positiveDays.default(90),
});

/**
 * 実行区分ごとの委譲ポリシー(ADR-015の予約)。enabled 以外のフィールドは
 * scheduled / autonomous 解放時のADRでsemanticsを確定するまで解釈されない。
 */
const executionClassSchema = z.strictObject({
  enabled: z.boolean(),
  /** 予約: この区分で呼び出しを許可するソースID */
  allowedSources: z.array(z.string().min(1)).optional(),
  /** 予約: 資格情報TTL(秒) */
  credentialTtlSec: z.number().int().min(1).optional(),
  /** 予約: 再承認条件の識別子 */
  reapproval: z.string().min(1).optional(),
  /** 予約: 監査ログ上の表示名 */
  auditDisplayName: z.string().min(1).optional(),
});

const agentExecutionSchema = z.strictObject({
  humanInTheLoop: executionClassSchema.prefault({ enabled: true }),
  // Phase 1では scheduled / autonomous の有効化を起動時拒否する(ADR-015)。
  // 検証は validate.ts(スキーマでなく検証層に置くのは、解放時にスキーマ変更
  // なしで検証条件だけ差し替えるため)
  scheduled: executionClassSchema.prefault({ enabled: false }),
  autonomous: executionClassSchema.prefault({ enabled: false }),
});

export const deploymentConfigSchema = z.strictObject({
  /** スキーマバージョン。migrate.ts が CURRENT_SCHEMA_VERSION まで移行する */
  schemaVersion: z.number().int().min(1),
  deployment: z.strictObject({
    /** 導入識別名。1デプロイ=1社(マルチテナント機構は実装しない、ADR-005) */
    name: z.string().min(1),
  }),
  idp: z.strictObject({
    adapter: idpAdapterSchema,
  }),
  gateway: gatewaySchema.prefault({}),
  connectors: z.array(connectorSchema).default([]),
  orchestrator: orchestratorSchema.prefault({}),
  audit: auditSchema.prefault({}),
  chatHistory: chatHistorySchema.prefault({}),
  agentExecution: agentExecutionSchema.prefault({}),
});

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
export type ConnectorConfig = DeploymentConfig["connectors"][number];
export type ConnectorLimits = ConnectorConfig["limits"];
export type IdpAdapterConfigSection = DeploymentConfig["idp"]["adapter"];
export type GatewayHttpConfig = DeploymentConfig["gateway"]["http"];
export type AuditConfig = DeploymentConfig["audit"];
export type GatewayRunsConfig = DeploymentConfig["gateway"]["runs"];

/**
 * Slack と分類するコネクタの kind(`slack`、または `slack-` で始まるプラグイン名)。
 * 広めに取るほど記録しない側に倒れる(ADR-013 §2)。永続化不可のソース(不変条件7、
 * ADR-014)の有効化の判定に、Gateway(run API の引用の記録。ADR-019 決定5・7)と
 * Orchestrator(leisen-ask serve。ADR-018 決定5)が同じ規則を使う。
 */
export function isSlackKind(kind: string): boolean {
  return kind === "slack" || kind.startsWith("slack-");
}
export type ConnectorAuthConfig = NonNullable<ConnectorConfig["auth"]>;
export type AgentExecutionConfig = DeploymentConfig["agentExecution"];
