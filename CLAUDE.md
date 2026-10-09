# CLAUDE.md — 社内ナレッジ検索基盤

このリポジトリは、社内ナレッジをLLMが権限透過で検索できるようにするOSS基盤(MCP Gateway + コネクタ群 + Orchestrator + 汎用検索層)のモノレポである。複数社がそれぞれシングルテナントで導入する。作業前に必ず `docs/product-design.md` の「2. プロダクト原則」、`docs/product-design-v2.md`(OSS化・複数社導入の差分)、`docs/product-design-v3.md`(2026-07-05レビュー反映差分: 認可方式・監査・プライバシー・Slack)を読むこと。

## 不変条件(違反するコードは書かない)

1. **認可は常にデータソースに委譲する。** 独自の権限モデル・ACLの複製や同期を実装しない。ソースAPIの呼び出しは必ず利用者本人の資格情報で行う。資格情報の取得方式はソースごとに異なる(ADR-010)。認可判定が本人に対して行われることが本質であり、サービスアカウント系資格情報(例: ドメインワイド委任)の使用はADRで明示的に承認された方式に限る。
2. **全ツール呼び出しを監査ログに記録する。** Gatewayを経由しないソースアクセス経路を作らない。監査ログの書き込み失敗時の挙動はADR-011に従う。
3. **未認可候補をSearch Backend Adapterの外に出さない(ADR-012)。** 内容だけでなく件数も対象。Connector / Gateway / Orchestrator / LLM / 監査ログ / デバッグログ / メトリクスのいずれにも出さない。唯一の例外はADR-011が定める分離テレメトリ。
4. **キャッシュキーには必ずuserIdを含める。** 検索結果・fetch結果・認可照会結果をユーザー間で共有しない。
5. **コネクタのツールIF(`search`/`fetch`/`list`/`describe`)を変更する場合は必ずADRを書く。** 内部実装の差し替え(ネイティブ検索→検索層)でIFを壊さないことがPhase 2の前提。
6. **秘密情報(トークン、APIキー)をログ・コード・テストフィクスチャに含めない。** `AuthContext` / `Credential` を `JSON.stringify` 等で直接シリアライズしない。ログ・エラー・デバッグ出力には必ず `redactAuthContext()` を使う。
7. **Slack(RTS/公式MCP)経由で取得したデータを永続化しない(ADR-014)。** 本文・スニペットに限らず、permalink・channel名/ID・user名/ID・file名・timestamp(thread_ts含む)等のSlack由来メタデータも対象。監査ログ・評価ログ・キャッシュ・カタログ/マップ生成の入力・最終回答の永続履歴のいずれにも含めない。documentId等がSlackメタデータ由来の場合は不可逆化する。
8. **個社差分をコアに入れない(ADR-005)。** 差分は deployment.yaml と3つのプラグイン境界(Connector / IdP Adapter / Search Backend)でのみ吸収する。マルチテナント機構は実装しない(1デプロイ=1社)。
9. **2社以上で再現した要件のみコア化する。** 1社要件は contrib/ またはその導入のフォークで対応する。

## リポジトリ構成

- `packages/connector-sdk` — コネクタ共通IF・型定義(v0.4、ADR-016 追補2)。全コネクタはここに依存する
- `packages/gateway` — MCP Gateway(認証、IdP Adapter、監査ログ、ルーティング)
- `packages/connector-*` — 各データソースのMCPサーバー(今後追加)
- `docs/adr/` — アーキテクチャ決定記録。設計変更時は必ず追記。ADR-009は欠番(削除済み番号の再利用を避ける)
- `docs/backlog/` — タスク定義。各タスクに受け入れ条件がある
- `.claude/` — サブエージェント定義とhooks(ガードレール)
- `scripts/guard/` — hooks から呼ばれる検査スクリプト

## 開発ルール

- TypeScript strict。`any` の使用は理由コメント必須
- テスト: vitest。新規モジュールはユニットテスト必須。認可分岐(トークン欠落、権限外)のテストを最優先で書く
- 単一パッケージのテスト実行: `npm test -w @kp/gateway` / `npm test -w @kp/connector-sdk`
- コミット前に `npm run build && npm test` が通ること
- 外部SaaSのAPIクライアントは必ず薄いラッパー越しに使い、レート制限・タイムアウトをGateway設定から注入可能にする
- 1タスク=1ブランチ=1PR。PRにはbacklogのタスクID(T-xxx)を含め、`.github/PULL_REQUEST_TEMPLATE.md` のチェックリストを埋める

## タスクの進め方

1. `docs/backlog/` の該当タスクを読み、受け入れ条件を確認する
2. 設計判断が必要ならまずADRドラフトを書き、人間のレビューを求めて停止する
3. 実装 → テスト → 受け入れ条件のセルフチェック結果をPR説明に記載する

## 現在のフェーズ

**実装前ゲート(T-000a/b/c)は完了(2026-07-12、ADR-010/013 Accepted)。Gateway土台(T-001 / T-002 / T-010 / T-003)と昇格判定レポート(T-014)はmainにマージ済み。** 現在はコネクタ・Orchestrator・リファレンスデプロイに進む段階。順序と制約:

**2026-09-27 更新(ブランチ `claude/loving-edison-3yad2v`、PR #14、mainへは未マージ):** T-003 の HTTP 配線、起動コード(`kp-gateway serve/validate`、README「手元で動かす(5分)」)、T-019 GitHub コネクタ(モックテスト済み・実疎通は GitHub App 承認待ち)、T-007 Orchestrator(`packages/orchestrator`、`kp-ask` CLI。脚本化 LLM でのシナリオテスト済み・**実走は Claude API 資格情報待ち**)が入り、モック IdP + 開発用コネクタで Gateway が手元で起動する。T-012(リファレンスデプロイ: `deploy/`、`docs/install.md`、CI の `reference-deploy` ジョブ)は実装済みで、PR #14 の CI でイメージのビルド・compose 起動・スモークまで成功を確認した(ブランチ単体には CI が走らない)。Orchestrator の LLM バックエンドは設定で選ぶプラグイン境界(Anthropic / OpenAI 互換。llama.cpp + Qwen2.5-3B でこの環境の実モデル疎通を確認済み。LM Studio・Claude API は人間の手元で確認)。ADR-017 は書き直し版が Proposed で人間レビュー待ち。**2026-09-28: 利用者向けの面(5 観点レビューの高リスク)として、ADR-018(Proposed、オーナー決定: 方式 A + LibreChat)に基づき Orchestrator を MCP サーバー化(`kp-ask serve`、ツール `ask` / `feedback`、認証は Gateway に委譲)し、リファレンス構成に LibreChat overlay(`deploy/compose/docker-compose.librechat.yml`、`docs/ui-librechat.md`)を追加した(T-021)。コンテナの実起動は CI で確認する。**T-003 レビューの minor-6(リクエスト期限)・minor-7(拒否応答の connection: close)は `http.ts` 未変更のまま残り、公開前はリバースプロキシで緩和する(docs/install.md §6)。**2026-10-09(issue #17、オーナー決定)**: `audit.sink: stdout` は `NODE_ENV=production` で拒否、IdP への平文 http はループバック以外で `idp.adapter.confirmPlainHttp: true` 必須、`examples/deployment.yaml` は `jsonl`、出力の規則「stdout = 結果、stderr = ログ、監査 = ファイル」を docs/install.md §7.1 に明文化(ADR-011 追記)。

- 着手可能(人手の前提なし): T-012(リファレンスデプロイ)、T-007(Orchestrator。実走のみClaude APIキーが必要)
- 着手可能(実疎通は人手の前提待ち): T-019(GitHub App承認)、T-005(GCP OAuthクライアント承認)、T-004(IdPサンドボックス+KMS)。API薄ラッパーをモックした実装とテストは先行してよい
- **MCP実装は仕様2026-07-28版(ステートレス)を設計前提とする(ADR-001追補3、2026-09-27 Accepted)。** Gateway の HTTPトランスポート配線(T-003 残作業)は着手可能。`@modelcontextprotocol/sdk` は 1.30.1 に更新済み(1.30.x は2026-07-28版に非対応のため、新仕様固有の必須項目は保留。ADR-001追補3「SDK更新の検証結果」)。HTTP配線PRへ進む。`_meta` の独自キーは暫定prefix `io.github.sunaot.leisen/` を使う(最終確定はT-013)
- Slackコネクタ(T-006)は RTS/公式MCP を第一候補とし(ADR-014)、着手前に導入形態の法務確認(人間タスク)が必要。法務確認が終わるまで着手しない
- delegated_identity 認可スパイク(T-017)は Q2 に前倒し。ただし文書検索モジュール本体の実装は Q3 着手(ADR-006/008)であり、まだ書かない
- 構造化クエリモダリティ(text-to-query)は v1.0 スコープ外(ADR-008)。マップ生成(Phase 3)も同様。Source Catalog(T-018)は Phase 1.5 として例外的にスコープ内
- 人間の未決事項: ADR-004(ライセンス)、OSS公開時期(T-013の前提)、Slack導入形態の法務確認(ADR-014)、ADR-017(Orchestrator の LLM クライアント・既定モデル・AnswerRun の書き手。Proposed)、T-003 レビューの H1(未申告呼び出しを human_in_the_loop とする既定の受容再確認)、MCP SDK v2系(`@modelcontextprotocol/server` 等、仕様2026-07-28版対応)への移行時期(ADR-001追補3「SDK更新の検証結果」追記とスパイク `docs/spikes/mcp-sdk-v2-migration-spike.md`。HTTP配線はv1で完了済み、SDK依存部は隔離済み)
