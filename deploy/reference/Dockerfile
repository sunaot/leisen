# Gatewayのリファレンスイメージ(T-012)。
# ビルドコンテキストはリポジトリルート:
#   docker build -f deploy/reference/Dockerfile .
# 秘密情報はイメージに焼き込まない。実行時に環境変数で注入する(不変条件6)。

FROM node:22-alpine AS build
WORKDIR /app
# 依存解決に必要なmanifestのみを先にコピーしてlayer cacheを効かせる
COPY package.json package-lock.json ./
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/gateway/package.json packages/gateway/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# 実行に必要なもののみ: 本番依存 + 各パッケージのdist。
# node_modules/@kp/* はworkspaceシンボリックリンクで packages/ を指すため、
# ディレクトリ配置をビルド段と同一に保つ
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/connector-sdk/package.json packages/connector-sdk/
COPY --from=build /app/packages/connector-sdk/dist packages/connector-sdk/dist
COPY --from=build /app/packages/gateway/package.json packages/gateway/
COPY --from=build /app/packages/gateway/dist packages/gateway/dist
USER node
EXPOSE 3000
# deployment.yaml は /etc/kp/deployment.yaml にvolume注入する(docs/install.md)
CMD ["node", "packages/gateway/dist/server/main.js"]
