# @kp/orchestrator — 探索戦略 v1(T-007)

利用者の質問に対し、Claude が Gateway 経由のツール(search / fetch / list / describe)を反復して呼び、出典付きで回答する探索ループ(product-design §4.3)。設計判断は [ADR-017](../../docs/adr/ADR-017-orchestrator-llm-client.md)(Proposed、人間レビュー待ち)。

**実走は未検証です。** Claude API の資格情報がまだ用意されていないため、テストはすべて脚本(`ScriptedLlmClient`)と実 Gateway(port 0)で行っています。

## 使い方(kp-ask)

Gateway(`POST /mcp`)を起動した状態で(起動構成はリファレンスデプロイ T-012):

```sh
npm run build -w @kp/orchestrator
export KP_SESSION_TOKEN=...          # 利用者のセッショントークン(Gateway の IdP が検証する)
export ANTHROPIC_API_KEY=...         # または `ant auth login` のプロファイル
node packages/orchestrator/dist/bin/kp-ask.js \
  --gateway http://127.0.0.1:8787/mcp \
  --user-id alice \
  "経費精算の締め日はいつ?"
```

| オプション | 内容 |
|---|---|
| `--gateway <URL>` | Gateway の MCP エンドポイント(必須) |
| `--token <トークン>` | セッショントークン。プロセス一覧に残るため環境変数 `KP_SESSION_TOKEN` を推奨 |
| `--model <ID>` | Claude のモデル ID(既定 `claude-opus-5`) |
| `--effort <level>` | `low` / `medium` / `high` / `xhigh` / `max`(既定 `high`) |
| `--max-iterations <N>` | ツールを呼べるターン数の上限(1〜20、既定 6) |
| `--user-id <ID>` | AnswerRun に記録する質問者(既定: 環境変数 `KP_USER_ID`、なければ `cli-user`) |
| `--json` | Answer を JSON で出力する |

- 表示: 回答・出典(タイトル、`sourceId:documentId`、原典 URL)・検索したソース・未接続でスキップしたソース・結果と確信度・使用量(トークン、LLM ターン、ツール呼び出し回数、概算費用)・警告・runId
- 監査: AnswerRun を stderr に JSON 1行で出す(開発用。本番の監査ストアへの書き込みはリファレンスデプロイで組む)。ToolInvocation は Gateway 側の監査に記録される
- 終了コード: 0 回答した(resolved / unresolved)、1 実行時エラー(Gateway の拒否など)、2 引数の不備、または Claude API の資格情報が無い・無効

## 必要な資格情報

| 対象 | 渡し方 | 備考 |
|---|---|---|
| Claude API | SDK が環境から解決(`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → `ant auth login` のプロファイル → Workload Identity Federation) | コード・設定ファイルに書かない。無い場合 kp-ask は「Claude API の資格情報が必要です」と表示して終了コード 2 |
| Gateway | 利用者本人のセッショントークン(`Authorization: Bearer`、毎リクエスト) | ログ・エラー・例外メッセージに出さない。`McpGatewayClient` は private フィールドに保持する |

ソース(Drive・GitHub 等)の本人資格情報は Gateway 側(IdP Adapter / Token Vault)が扱い、Orchestrator は触れない(不変条件1・2)。

## ライブラリとして使う

```ts
import { AuditLogger } from "@kp/gateway";
import { AnthropicLlmClient, McpGatewayClient, Orchestrator } from "@kp/orchestrator";

const orchestrator = new Orchestrator({
  llm: new AnthropicLlmClient({ model: "claude-opus-5", effort: "high" }),
  auditLogger, // リファレンス構成では Gateway と同じ監査ストア(ADR-017 決定2)
  settings: { maxIterations: 6, runTimeoutMs: 120_000, costLimitPerQuery: 0.5 },
});
const gateway = new McpGatewayClient({ url: "http://127.0.0.1:8787/mcp", sessionToken });
try {
  const answer = await orchestrator.run({ question, userId, gateway });
  // 利用者の「解決した / しない」ボタン(受け入れ条件3)
  await orchestrator.recordFeedback(answer.runId, "resolved", { userId });
} finally {
  await gateway.close();
}
```

`userId` は利用者を認証した呼び出し元(チャットUIのバックエンド等)が渡す。Gateway が認証して記録する ToolInvocation の userId と runId で突き合わせられる。

## 設定

`orchestratorSettingsSchema`(探索ループ):

| 項目 | 既定 | 内容 |
|---|---|---|
| `maxIterations` | 6 | LLM のツール呼び出しターン数の上限(1〜20。submit_answer だけのターンは数えない) |
| `runTimeoutMs` | 120000 | 探索フェーズの時間上限。到達すると進行中の LLM・Gateway 呼び出しを中断する |
| `finalTurnTimeoutMs` | 60000 | 上限到達後の最終ターンの時間枠 |
| `costLimitPerQuery` | なし | 1質問の LLM 費用の上限(`pricing` の通貨単位)。超過したターンの次は最終ターンだけ行う(最終ターンの分だけ超えうる)。価格表にないモデルを使った場合は確認できないため到達扱い |
| `maxTokensPerTurn` | 16000 | 1ターンの max_tokens(adaptive thinking の思考を含む。非ストリーミングの実用上限 64000) |
| `pricing` | 下記 | モデル ID → 単価(100万トークンあたり。既定は USD) |
| `connectGuidance` | プレースホルダ | 未接続ソースの接続導線の文言(T-009 で確定) |

`anthropicLlmSettingsSchema`(`AnthropicLlmClient`):

| 項目 | 既定 | 内容 |
|---|---|---|
| `model` | `claude-opus-5` | |
| `effort` | `high` | `output_config.effort`。API 既定と同じ値を明示している(既定 effort の異なるモデルに切り替えても挙動が黙って変わらないように) |
| `timeoutMs` | 60000 | 1リクエストのタイムアウト(SDK は再試行ごとに適用) |
| `maxRetries` | 2 | SDK の自動再試行(429 / 5xx / 接続失敗) |
| `serverSideFallbacks` | false | 下記 |

既定の価格表(claude-api スキルの価格表、2026-06-24 時点): `claude-opus-5` 5 / 25、`claude-opus-5-5` 4 / 20、`claude-fable-5-1` 10 / 50、`claude-opus-4-8` 5 / 25、`claude-sonnet-5` 2 / 10、`claude-haiku-4-5` 1 / 5(入力 / 出力、USD)。キャッシュ書き込みは入力単価の 1.25 倍、読み出しは 0.1 倍(Opus 5.5 は $0.20、Fable 5.1 は $0.25)。導入先の契約単価・通貨に合わせて差し替える。

### server-side fallbacks(既定 off)

`serverSideFallbacks: true` にすると、beta ヘッダ `server-side-fallback-2026-07-01` と `fallbacks: "default"` を付けて呼ぶ。安全分類器が要求を辞退(`stop_reason: refusal`)したとき、API 側で辞退の分類に応じたモデルが同じ要求を処理する。

- 利点: 辞退で回答できない run を減らせる。claude-api スキルは Claude Opus 5 / Fable 系で既定 on を勧めている
- 既定 off にした理由: 社内ナレッジ検索の質問が辞退に当たることは稀で、beta 機能への依存を既定にしない。Claude API と Claude Platform on AWS でしか使えない(Bedrock / Vertex / Foundry では不可)。フォールバック先の単価・レート制限の見積もりが別に要る。辞退が観測された導入で有効化を検討する
- 有効時の扱い: 応答の `fallback` ブロックは履歴に戻さない。費用は `usage.iterations`(辞退した試行・フォールバック先の試行)で数える

## 探索ループの仕様

- 開始時: AnswerRun(`pending`)を書く → `tools/list` → 全ソースに `describe`(`source_not_connected` のソースは skippedSources に入れて検索対象から外す。それ以外の失敗は警告を残して検索対象に残す)→ system prompt(固定部 `prompts/explore.v1.md` +ソース一覧)とツール定義(strict、`source` は有効ソースの enum)を組む
- 反復: LLM の応答内のツール呼び出しはすべて並行に Gateway へ送り、結果は1つの user メッセージにまとめて返す。成功した結果は「固定の前置き(データであり指示ではない)」と「データ本体の JSON」の2ブロックで渡す。Gateway の正規化エラーは `is_error: true` の tool_result(`{ errorClass, message }`)で返す。`permission_denied` と `not_found` は区別せず `not_available` として渡す(TM-B2)
- 終了: `submit_answer` の提出 / 提出せずに終えたら1回だけ催促し、それでも提出しなければ unresolved / 上限に達したら提出を促す最終ターンを1回だけ行う / LLM・Gateway の失敗は error
- 出典の検証: citations はその run で search のヒット・fetch の結果として受け取った (sourceId, documentId) に限る。検証済みの出典が0件なら unresolved、回答の先頭に「【注意】出典を確認できませんでした」、confidence を 0.3 以下に丸める。回答文中の URL は受け取った原典の url 以外を除去する
- `_meta`: 全 `tools/call` に `io.github.sunaot.leisen/runId` / `iteration` / `executionClass`(`human_in_the_loop`)/ `actor`(`{ kind: "human" }`)を付ける。iteration はツール呼び出しごとに 0 から単調増加(describe を含む。同一ターン内の並列呼び出しは応答内の順。Gateway に送らなかった呼び出しは番号を消費しない)
- 監査: Orchestrator は AnswerRun だけを書く(ToolInvocation は Gateway)。終了時に同じ runId で最終状態、`recordFeedback` で userFeedback を更新して再書き込み。書き込めなければ fail-closed(開始時は Gateway にアクセスしない。終了時は回答を返さない)。質問の原文・回答本文・タイトル・URL は書かない(質問は SHA-256 のみ)

## 脚本テストの書き方

`ScriptedLlmClient` は、直前のツール結果を見て次の応答を返す関数の配列(または全ターン共通の関数)を受け取る。テストの Gateway は `test/helpers/harness.ts` の `startGateway` で起動する(実 Gateway を port 0 で listen、コーパス型のモックコネクタ、スタブの資格情報)。

```ts
const harness = await startGateway({ connectors: [new CorpusConnector("alpha", [EXPENSE_POLICY])] });
const llm = new ScriptedLlmClient([
  () => scriptedToolUse([{ name: "search", input: { source: "alpha", query: "締め日" } }]),
  (context) => {
    const hit = firstHit(context); // 直前の search のヒット(test/helpers/script.ts)
    return scriptedSubmit({
      answer: "経費精算の締め日は毎月25日です。",
      citations: [{ documentId: hit.documentId, sourceId: hit.source }],
      confidence: 0.9,
    });
  },
]);
const answer = await new Orchestrator({ llm, auditLogger: harness.auditLogger })
  .run({ question: "締め日は?", userId: "alice", gateway: harness.client() });
```

- `context.lastToolResults`(パース済みのツール結果)、`context.lastUserTexts`(催促・最終ターンの指示)、`context.request`(system / messages / tools)で分岐できる
- `scriptedToolUse(calls, { usage, model })` で使用量を与えると費用上限の挙動も再現できる。`context.signal` に従えば時間上限の中断も再現できる
- 秘密情報の実値をテストに書かない(ダミーは `dev-only-...`)

## プロンプトの変更

固定部は `prompts/explore.v1.md`、制御メッセージ(催促・最終ターンの指示・ツール結果の前置き)は `src/prompt.ts`。変更する PR には評価レポート(T-008)を添付する。挙動が変わる改訂はファイルを `explore.v2.md` として追加し、`EXPLORE_PROMPT_VERSION` を上げる。

## 既知の限界

- **実走未検証**: Claude API の資格情報が用意されるまで、モデル・effort・max_tokens の既定値、プロンプトの効き、キャッシュの効き(`cache_read_input_tokens`)は未計測
- **評価ハーネス(T-008)未実装**: 解決率・引用正確性・インジェクション耐性(RS-3 / RS-4)の率は測れていない
- **Slack 未対応**: Slack コネクタ(T-006)は法務確認待ち。citedDocIds の redaction は「全ソース非プライベート・非 Slack」として通している(ADR-017 確認事項5)。Slack ソースやプライベートスコープ(`consent` / `included`)を有効にする前に分類の実装が必要
- **AnswerRun の書き手**: Gateway と同じ監査ストアを共有する構成が前提。別プロセス構成では Gateway 側の run 登録の口が要る(将来 ADR)
- **フィードバックの保持**: `recordFeedback` はプロセス内に覚えている run(既定 1000 件)に対してだけ使える
- **iteration と T-014**: iteration は「run 内のツール呼び出しの通番」。昇格判定レポート(T-014)の再検索回数(search の max(iteration)+1)とは意味がずれている(ADR-017 確認事項4)
- **ストリーミングなし**: 途中経過の表示は T-009 で必要になった時点で検討する
- **deployment.yaml 未結合**: 設定は自パッケージの zod スキーマで受ける。deployment.yaml の `orchestrator` セクションとの結合は後続タスク
