/**
 * Gatewayサーバーのエントリポイント(T-012、リファレンスデプロイ)。
 *
 * 環境変数:
 * - KP_DEPLOYMENT_CONFIG: deployment.yaml のパス(既定 /etc/kp/deployment.yaml)
 * - KP_GATEWAY_HOST / KP_GATEWAY_PORT: 待受アドレス(既定 0.0.0.0:3000)
 * - (deployment.yaml が参照する秘密情報の環境変数。例: KP_KEYCLOAK_CLIENT_SECRET)
 *
 * コネクタ実体は現時点で未登録(コネクタ実装はT-005以降)。コネクタ
 * パッケージの追加時に、この組み立てへ Connector / CredentialProvider を
 * 登録する。deployment.yaml に宣言されたが実体のないコネクタIDは
 * assembleGateway(unknown_connector_id)が起動時に拒否する。
 *
 * ログの規約: 監査レコード(audit.sink: stdout)は標準出力へ、運用ログは
 * 標準エラーへ分離する。運用ログに秘密情報・文書内容を書かない(不変条件6)。
 */
import { pathToFileURL } from "node:url";
import { assembleGateway } from "./assemble.js";
import { startGatewayHttpServer } from "./http.js";

const DEFAULT_CONFIG_PATH = "/etc/kp/deployment.yaml";
const DEFAULT_PORT = 3000;

function opsLog(event: string, detail: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ kind: "ops", event, ...detail }) + "\n");
}

export async function main(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const configPath = env["KP_DEPLOYMENT_CONFIG"] ?? DEFAULT_CONFIG_PATH;
  // 既定0.0.0.0はコンテナ実行+ネットワーク側のingress制限(docs/install.md)が
  // 前提。コンテナ外で直接起動する場合は KP_GATEWAY_HOST=127.0.0.1 を指定する
  const host = env["KP_GATEWAY_HOST"] ?? "0.0.0.0";
  const portRaw = env["KP_GATEWAY_PORT"];
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`KP_GATEWAY_PORT must be an integer port number`);
  }

  const assembled = assembleGateway({ configPath, env });
  if (assembled.config.audit.sink === "stdout") {
    // stdoutシンクはat-least-once非保証(sink.ts)。本番導入への注意を残す
    opsLog("audit_sink_stdout_notice", {
      message:
        "audit.sink 'stdout' does not guarantee at-least-once delivery; " +
        "use a persistent sink for production (docs/install.md)",
    });
  }

  const started = await startGatewayHttpServer(assembled.gateway, {
    host,
    port,
  });
  opsLog("started", {
    deployment: assembled.config.deployment.name,
    host,
    port: started.port,
    sources: assembled.gateway.enabledSourceIds(),
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    opsLog("shutdown_begin", { signal });
    void (async () => {
      try {
        await started.close();
        // 監査バッファを永続化しきる。しきれない場合は異常終了で欠落に
        // 気づけるようにする(TM-F2)
        await assembled.shutdown();
        opsLog("shutdown_complete");
        process.exit(0);
      } catch (error) {
        opsLog("shutdown_failed", {
          message: error instanceof Error ? error.message : "unknown error",
        });
        process.exit(1);
      }
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error: unknown) => {
    // 設定・組み立てエラーのメッセージは秘密情報を含まない規約
    // (config/schema.ts、不変条件6)のためそのまま出力できる
    opsLog("startup_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
