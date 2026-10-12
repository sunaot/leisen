# kp-gateway のコンテナイメージ(T-012 リファレンスデプロイ、T-021)
#
#   docker build -f deploy/Dockerfile -t kp-gateway:local .    # リポジトリルートで実行
#
# 1つのイメージに次の3つを含める(いずれも同じ依存・同じビルド成果物から動く):
#   - Gateway(kp-gateway serve): 既定のエントリポイント
#   - Orchestrator(kp-ask serve、T-021): 利用者向けの面として MCP サーバーで公開する
#     (ADR-018)。compose の overlay(deploy/compose/docker-compose.librechat.yml)が
#     別のエントリポイント(node packages/orchestrator/dist/bin/kp-ask.js)で起動する
#   - 昇格判定レポート(promotion-report): 運用 CLI(docs/install.md §7)
#
# ビルドコンテキストはリポジトリルート(ルートの package-lock.json と npm workspaces を
# 使うため)。コンテキストから除外するものはルートの .dockerignore(.env、node_modules、
# dist、.claude 等)。deploy/compose/docker-compose.yml も同じ指定でビルドする。
# 手順は docs/install.md(UI から使う場合は docs/ui-librechat.md)。
#
# 構成(multi-stage。両ステージとも同じベースイメージ):
#   build    ルートの package-lock.json で全 workspace の依存(devDependencies を含む)を
#            入れ、npm run build で packages/*/dist を作る
#   runtime  npm ci --omit=dev で本番依存だけの node_modules を作り直し、build から
#            各 workspace の dist だけをコピーする
#
# runtime の node_modules を build からコピーして prune するのではなく、npm ci --omit=dev
# で作り直す理由:
#   - @kp/* は npm workspaces のシンボリックリンク(node_modules/@kp/gateway →
#     ../../packages/gateway)で解決される。作り直せば npm がイメージ内の
#     /app/packages/* を指す相対リンクとして張るため、リンクが壊れない。dist は
#     リンク先(packages/<name>/dist)に置くので、パッケージ間の import もそのまま解決する
#   - lockfile からの決定的なインストールになり、devDependencies(typescript / vitest 等)
#     がイメージに残らない(workspaces での npm prune は取りこぼしが起きやすい)
#   - 依存のダウンロードは BuildKit のキャッシュマウント(/root/.npm)で build と共有する
#
# workspace を追加したら、build ステージの package.json の COPY に1行足すこと。build は
# `npm run build`(全 workspace)を実行するため、manifest のない workspace があると
# その依存が入らずビルドが失敗する(orchestrator の追加時に CI の reference-deploy で
# 実際に起きた: `Cannot find module '@anthropic-ai/sdk'`)。
# runtime ステージにはイメージに含める workspace(gateway と、それが読み込む
# audit / connector-sdk / connector-github、orchestrator、運用 CLI の promotion-report)だけを置く。
# orchestrator を含めるため、本番依存に @anthropic-ai/sdk が加わる(ADR-018 帰結)。
# npm ci は manifest のない workspace を無視するので、runtime の manifest を減らしても
# lockfile との整合検査は通る(CI で確認済み)。
#
# 実行時にソースツリーから読むファイル: orchestrator は system prompt の固定部
# (packages/orchestrator/prompts/*.md)を import.meta.url 基準で読むため、dist と並べて
# prompts もコピーする。.dockerignore は **/*.md を除外しているので、prompts だけを
# 否定パターンで戻している(戻し忘れると build ステージに prompts が入らず、COPY が失敗する)。
#
# 実行時:
#   - 非 root(uid/gid 1000 = node イメージの node ユーザー)。Kubernetes の runAsNonRoot が
#     検証できるよう数値で指定する。アプリのファイルは root 所有で、実行ユーザーは
#     書き換えられない
#   - 設定は /etc/kp/deployment.yaml(KP_DEPLOYMENT_CONFIG)を読み取り専用で注入する
#   - 監査ログ(audit.sink: jsonl)は /var/lib/kp/audit、生クエリ原文(audit.jsonl.rawQueryPath)は
#     /var/lib/kp/rawquery に書く。保持期間・閲覧経路が異なる(ADR-011 §3、ADR-013 §3)ため
#     別ボリュームにする。所有者は実行ユーザー、権限 0700(ファイルは 0600 で作られる)
#   - node が PID 1 で動く。kp-gateway serve は SIGTERM / SIGINT を自分で処理し、処理中の
#     リクエストを待って(最大 10 秒)監査バッファを flush してから終了する。停止猶予は
#     それより長く取ること(compose の stop_grace_period: 30s)
#   - NODE_ENV=production では開発用の部品(mock IdP / mock_env / dev-fixture / audit.sink: stdout)が
#     起動時に拒否される。評価用のリファレンス compose は NODE_ENV=development で上書きしている
#   - HEALTHCHECK は GET /healthz(待ち受けの死活のみ。監査 sink の状態は含まない —
#     docs/install.md「未実装事項」)。イメージに curl がないため node で確認する。
#     待ち受けのポートを変えたら KP_HEALTHCHECK_URL も合わせる。orchestrator として
#     起動するコンテナは compose 側で healthcheck を上書きする(kp-ask serve の /healthz)
#   - orchestrator(kp-ask serve)は監査ストアに書かない(ADR-019)。run(AnswerRun)は Gateway の
#     run API に申告し、Gateway が /var/lib/kp/audit に記録する。compose の overlay は orchestrator
#     に設定だけを読み取り専用でマウントし、Gateway の監査ログ・生クエリ原文のボリュームは
#     マウントしない(Orchestrator から Gateway の監査ログを読めない・書けない)。VOLUME の
#     宣言により、orchestrator の /var/lib/kp/audit 等には空の匿名ボリュームが付くが、名前付き
#     ボリュームとは別物で、何も書かれない

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/audit/package.json packages/audit/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/connector-github/package.json packages/connector-github/
COPY packages/gateway/package.json packages/gateway/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/promotion-report/package.json packages/promotion-report/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund

COPY packages/ packages/
RUN npm run build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    KP_DEPLOYMENT_CONFIG=/etc/kp/deployment.yaml \
    KP_HEALTHCHECK_URL=http://127.0.0.1:8787/healthz
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/audit/package.json packages/audit/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/connector-github/package.json packages/connector-github/
COPY packages/gateway/package.json packages/gateway/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/promotion-report/package.json packages/promotion-report/
# 本番依存にはインストールスクリプトを要するものがない。依存のスクリプトを実行しない
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --from=build /app/packages/audit/dist packages/audit/dist
COPY --from=build /app/packages/connector-sdk/dist packages/connector-sdk/dist
COPY --from=build /app/packages/connector-github/dist packages/connector-github/dist
COPY --from=build /app/packages/gateway/dist packages/gateway/dist
COPY --from=build /app/packages/orchestrator/dist packages/orchestrator/dist
# system prompt の固定部(実行時に dist/ から ../prompts/ を読む)
COPY --from=build /app/packages/orchestrator/prompts packages/orchestrator/prompts
COPY --from=build /app/packages/promotion-report/dist packages/promotion-report/dist

RUN mkdir -p /etc/kp /var/lib/kp/audit /var/lib/kp/rawquery \
    && chown 1000:1000 /var/lib/kp/audit /var/lib/kp/rawquery \
    && chmod 0700 /var/lib/kp/audit /var/lib/kp/rawquery
# 空の名前付きボリュームは初回マウント時にこのディレクトリの所有者・権限を引き継ぐ
VOLUME ["/var/lib/kp/audit", "/var/lib/kp/rawquery"]

USER 1000:1000
# 8787: Gateway(既定)、8790: orchestrator(kp-ask serve、compose overlay の --listen)
EXPOSE 8787 8790
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch(process.env.KP_HEALTHCHECK_URL,{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]

ENTRYPOINT ["node", "packages/gateway/dist/bin/kp-gateway.js"]
CMD ["serve"]
