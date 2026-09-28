# T-021: 利用者向けの面 — Orchestrator の MCP サーバー化と LibreChat 接続

## 依存
T-007(Orchestrator)、T-012(リファレンスデプロイ)、ADR-018

## 前提(人手)
なし(手元での実走には LM Studio などの LLM バックエンドが要る。CI は認証と配線の確認まで)

## 内容
- `kp-ask serve`: Orchestrator を MCP サーバー(Streamable HTTP、ステートレス)として公開する。ツールは `ask` と `feedback`。全リクエストで Bearer を要求し、有効性は Gateway の `tools/list` で確かめる(ADR-018 決定1〜3)
- AnswerRun は `--answer-run-jsonl` に追記し、昇格判定レポートは `--audit` を複数回受け付ける(決定4)
- deployment.yaml(`--config`、必須)に Slack kind のソースが有効なら起動を拒否する。`--allow-non-persistable-sources` で解除(決定5)
- 回答の出力契約: Markdown 本文 + 「出典」節、`structuredContent` に Answer(決定6)
- 上限: `--max-concurrent-runs`(既定 4)、`--max-question-chars`(既定 4,000)、ループバック以外は `--confirm-exposed-host`(決定7)
- リファレンス構成の overlay `deploy/compose/docker-compose.librechat.yml`(orchestrator + librechat + mongodb)、`deploy/compose/librechat/librechat.yaml`、`.env.example` の追記、realm への LibreChat クライアント追加(決定8、11)
- 文書 `docs/ui-librechat.md`: 「LibreChat の場合 / MCP クライアントの場合 / それ以外の場合」の 3 区分だけを示す

## 受け入れ条件
- [x] Bearer なし・無効な Bearer の `initialize` / `tools/list` / `tools/call` が 401(IdP 不達は 503)で拒否され、LLM 呼び出しもソースへのツール呼び出しも起きないことがテストされている(`packages/orchestrator/test/server-auth.test.ts`)
- [x] 有効な Bearer の `ask` が Gateway 経由で回答し、AnswerRun.userId が Gateway の認証した userId で、AnswerRun が JSONL に追記されることがテストされている(実 Gateway + 脚本 LLM の e2e。`test/server-ask.test.ts`、`test/server-answer-run-jsonl.test.ts`)
- [x] `feedback` は run の利用者本人だけが更新でき、他人の run は拒否されることがテストされている(`test/server-feedback.test.ts`)
- [x] Slack kind のソースが有効な deployment.yaml では起動を拒否し、`--allow-non-persistable-sources` で起動することがテストされている(`test/serve-cli.test.ts`)
- [x] 同時実行上限と質問長の上限が固定文言のエラーで効くことがテストされている(`test/server-limits.test.ts`)
- [x] 昇格判定レポートが Gateway と Orchestrator の 2 つの JSONL を読んで結合できることがテストされている(`packages/promotion-report/test/cli.test.ts`)
- [ ] `docker compose -f docker-compose.yml -f docker-compose.librechat.yml config` が通り(確認済み)、CI で orchestrator が起動して「トークンなしは 401、Keycloak のトークンで `tools/list` が通る」ことが確認される。LibreChat コンテナが healthy になる — **CI の実行結果は PR #14 で確認する**(この環境に Docker デーモンがない)
- [x] docs/ui-librechat.md に 3 区分の手順があり、LibreChat の場合は `.env` と `librechat.env` の雛形を写すだけで接続できる(ブラウザでの通し確認は人手)

## 残課題
- LibreChat の 👍👎 と `feedback` の自動連携(v1 は手動)
- 進捗のストリーミング(MCP の progress 通知)
- UI 経由でも出典が保たれるかを評価ハーネス(T-008)で測る

## 実装状況(2026-09-28)
- `kp-ask serve`(`packages/orchestrator/src/server/`、`src/bin/serve.ts`): ツール `ask` / `feedback`、preflight(利用者のトークンで Gateway の `tools/list`)、AnswerRun の JSONL シンク、上限、停止時の待ち合わせ。`--allow-insecure-upstream`(評価用構成。production では拒否)を追加。bin シム `bin/kp-ask.js`
- promotion-report: `--audit` を複数回受け付ける
- overlay: `deploy/compose/docker-compose.librechat.yml`(orchestrator / librechat v0.8.7 / mongodb / keycloak-tls)、`deploy/compose/librechat/`(librechat.yaml、librechat.env.example、Caddyfile、keycloak-tls.sh)。LibreChat の OpenID クライアントが https の発行者を要求するため、Keycloak の前段に Caddy の TLS 終端(内部 CA)を置き `https://keycloak.localhost:8443` を発行者にする。realm にクライアント `librechat`(Gateway の audience マッパー付き)
- CI: `reference-deploy` に overlay の起動と `scripts/smoke/orchestrator-smoke.sh` / `librechat-smoke.sh` を追加
- 未確認: この環境に Docker デーモンがないため、コンテナの実起動・ブラウザからのログイン・実 LM Studio は未確認(CI と人手)
