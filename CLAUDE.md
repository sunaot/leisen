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

**main の状態(2026-10-08 更新):** PR #14(2026-10-08 マージ)で、T-003 の HTTP 配線、起動コード(`kp-gateway serve/validate`、README「手元で動かす(5分)」)、T-019 GitHub コネクタ(モックテスト済み・実疎通は GitHub App 承認待ち)、T-007 Orchestrator(`packages/orchestrator`、`kp-ask` CLI)、T-012 リファレンスデプロイ(`deploy/`、`docs/install.md`、CI の `reference-deploy` でイメージのビルド・compose 起動・スモークを確認)、T-021(ADR-018 に基づく Orchestrator の MCP サーバー化 `kp-ask serve` と LibreChat overlay)が main に入った。モック IdP + 開発用コネクタで Gateway と kp-ask が手元で動く。**2026-10-08: 実モデルで出典付きの回答を初めて確認した**(LM Studio + Qwen3.6 27B 系、合成コーパスの 4 問、探索プロンプト v3 で 4 / 4 合格。`docs/eval/2026-10-08-explore-v3.md`、PR #43 / #44)。手元の回帰チェックは dev-eval(`packages/orchestrator/README.md`)。Claude API での実走は未確認(資格情報待ち)。Orchestrator の LLM バックエンドは設定で選ぶプラグイン境界(Anthropic / OpenAI 互換)。ADR-017・ADR-018 は Proposed で人間レビュー待ち。LibreChat overlay のブラウザでの通し確認(ログイン → ask → feedback)は人手。T-003 レビューの minor-6(リクエスト期限)・minor-7(拒否応答の connection: close)は `http.ts` 未変更のまま残り、公開前はリバースプロキシで緩和する(docs/install.md §6)。**2026-10-09(issue #17、オーナー決定)**: `audit.sink: stdout` は `NODE_ENV=production` で拒否、IdP への平文 http はループバック以外で `idp.adapter.confirmPlainHttp: true` 必須、`examples/deployment.yaml` は `jsonl`、出力の規則「stdout = 結果、stderr = ログ、監査 = ファイル」を docs/install.md §7.1 に明文化(ADR-011 追記)。**2026-10-09(issue #16、オーナー決定)**: Keycloak アダプタは `active` に加えて `iss` / `typ`(`Bearer` のみ)/ `azp`(`idp.adapter.allowedClients`、必須)/ `aud`(`requireAudience`)を検証し、`allowedClients: ["*"]` は開発専用の明示の逃げ道(WARNING、本番では `dev_only_in_production`)、理由はサーバーログにクレーム名だけ、切り分けは `kp-gateway auth-check`(ADR-010 追補、docs/idp-adapter-guide.md「受け手・種別・発行者の検証」、`examples/deployment.keycloak.yaml`)。

- 着手可能(人手の前提なし): T-023(ADR-019 段階 1: Gateway の run API と署名付き runId。監査ストアに書くのは Gateway だけにし、Orchestrator は申告者になる。2026-10-09 Accepted。実装までは ADR-018 決定4 の別 JSONL で運用)、T-024(探索プロンプト v4。T-022 の計測で v3 は 20 問 × 2 回で 37 / 40、不合格は複数文書の質問のみ。改訂の評価には v4 より前に固定した新しい質問を使う。実走は LLM)、T-025(自分の GitHub で試す開発用設定。本人の fine-grained PAT と `mock_env` の開発経路で、GitHub App の承認は不要)、T-007 / T-021 の改善。Claude API での実走のみ API キーが必要
- 着手可能(実疎通は人手の前提待ち): T-019(GitHub App承認)、T-005(GCP OAuthクライアント承認)、T-004(IdPサンドボックス+KMS)。API薄ラッパーをモックした実装とテストは先行してよい
- **MCP実装は仕様2026-07-28版(ステートレス)を設計前提とする(ADR-001追補3、2026-09-27 Accepted)。** Gateway の HTTP トランスポート配線は完了(SDK v1)。`@modelcontextprotocol/sdk` は 1.30.1 に更新済み(1.30.x は2026-07-28版に非対応のため、新仕様固有の必須項目は保留。ADR-001追補3「SDK更新の検証結果」)。`_meta` の独自キーは暫定prefix `io.github.sunaot.leisen/` を使う(最終確定はT-013)
- Slackコネクタ(T-006)は RTS/公式MCP を第一候補とし(ADR-014)、着手前に導入形態の法務確認(人間タスク)が必要。法務確認が終わるまで着手しない
- delegated_identity 認可スパイク(T-017)は Q2 に前倒し。ただし文書検索モジュール本体の実装は Q3 着手(ADR-006/008)であり、まだ書かない
- 構造化クエリモダリティ(text-to-query)は v1.0 スコープ外(ADR-008)。マップ生成(Phase 3)も同様。Source Catalog(T-018)は Phase 1.5 として例外的にスコープ内
- 人間の未決事項: ADR-004(ライセンス)、OSS公開時期(T-013の前提)、Slack導入形態の法務確認(ADR-014)、ADR-017(Orchestrator の LLM クライアント・既定モデル。Proposed。AnswerRun の書き手は ADR-019 で決着)、ADR-019 の確認事項 1〜4(run API の Orchestrator 資格情報、Slack 有効時の引用の記録、不変条件2 の文言に run の事象を含めるか、fail-open の適用範囲。いずれも安全側の既定で Accepted 済み)、T-003 レビューの H1(未申告呼び出しを human_in_the_loop とする既定の受容再確認)、MCP SDK v2系(`@modelcontextprotocol/server` 等、仕様2026-07-28版対応)への移行時期(ADR-001追補3「SDK更新の検証結果」追記とスパイク `docs/spikes/mcp-sdk-v2-migration-spike.md`。HTTP配線はv1で完了済み、SDK依存部は隔離済み)
