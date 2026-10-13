# 公開チェックリスト 実施記録(2026-10-13)

T-013 受け入れ条件「公開チェックリスト(秘密情報スキャン、履歴確認、`_meta` prefix 最終確定)の実施記録」。
対象は main(dcbb120)に本記録の PR の変更を加えた状態。リポジトリはこの時点で private。

**公開(可視性の切り替え)の直前に、CI の `secret-scan` が main の最新で緑であることを確かめ直す。** 本記録以降のコミットは、CI がその都度検査する。

## 1. 秘密情報スキャン(git 履歴全体)

| 項目 | 結果 |
|---|---|
| 道具 | gitleaks 8.28.0(公式リリース、配布元のチェックサムで検証)。既定ルール |
| 範囲 | 全 ref の全コミット(`--log-opts=--all`)と作業ツリー |
| 既定ルールでの検出 | 6 件。いずれも意図して置いた開発用のダミー値で、本物の秘密はなかった |
| `.gitleaks.toml` 適用後 | 0 件 |

検出の内訳と判定(値はここに書かない):

| ルール | 場所 | 判定 |
|---|---|---|
| generic-api-key | `packages/gateway/src/bootstrap/runs.ts` の `DEV_RUN_ID_KEY_EXAMPLE`(T-023 の途中の版) | runId 署名鍵の例。復号すると `dev-only-` で始まる 32 バイトの公開済みダミーで、本番では起動時に拒否される(dev_only_in_production) |
| generic-api-key ×2 | `deploy/compose/librechat/librechat.env.example` の `CREDS_KEY` / `CREDS_IV` | LibreChat の鍵の形式を満たすだけの連番の 16 進ダミー。ファイル内に「ダミー。手元では生成して置き換える」と明記 |
| curl-auth-header ×3 | `README.md` の curl 例 | モック IdP の開発用トークン `dev-token` |

`.gitleaks.toml` は値の形(`dev-only-` で始まる値とその base64 形、`dev-token`、連番の 16 進)だけを許可し、ファイル単位では外していない。ランダムに生成した値を置いた使い捨てのリポジトリで、許可の後も検出されることを確かめた。

CI: `secret-scan` ジョブ(`scripts/ci/gitleaks.sh`、`fetch-depth: 0`)が PR と main への push のたびに履歴全体を検査する。

## 2. 履歴確認(秘密情報以外)

| 観点 | 結果 |
|---|---|
| 過去にコミットされた秘密を含みうるファイル(`.env`、鍵、証明書など) | `deploy/compose/.env.example`(ダミーのみ)だけ。実際の `.env` はコミットされていない |
| 社名・社内ホスト名・私設 IP | 社名・社内ホスト名はなし。私設 IP(`10.0.0.x`)と `example.co.jp` はテストの入力値のみ |
| コミットの作者・コミッターのアドレス | オーナーの個人アドレス、`noreply@anthropic.com`、`noreply@github.com` の 3 種。公開でオーナーの個人アドレスが見えるようになる(NOTICE の著作権者を個人名とした判断と整合) |

## 3. `_meta` prefix の最終確定

**保留(2026-10-13 オーナー判断)。** 配布名(プロジェクト名・商標・`@kp` スコープ・`kp-ask`)の決定を時期尚早として保留したため、公開は暫定値 `io.github.sunaot.leisen/` のまま行う。確定時は Gateway と Orchestrator を同時に更新し、移行期間中は旧 prefix も受ける(ADR-001 追補3 決定4)。

## 4. 依存の脆弱性(npm audit)

| 項目 | 結果 |
|---|---|
| 本番依存(`npm audit --omit=dev`) | 実施前 7 件(critical 1、high 3、moderate 3)→ 0 件 |
| 対応 | 推移的依存は lock の更新だけ。`@modelcontextprotocol/sdk` は 1.30.1 → 1.32.1(SDK 自身の high。ADR-001 追補3「SDK更新の検証結果(2026-10-13、1.32.1)」) |
| CI | `audit` ジョブ(`npm audit --omit=dev --audit-level=high`) |

開発依存は対象外(vitest 系など、配布物に入らない)。

## 本記録の範囲外(公開前に判断が要るもの)

issue #32 の残り。公開時の供給網の強さに関わるが、本記録では扱っていない。

- Actions の SHA 固定、Dependabot、ベースイメージの digest 固定
- 各ワークスペースの `private` / `publishConfig` と、Gateway の kind → パッケージの許可表(`@kp` を確保しないまま公開するため、npm への誤公開と同名パッケージの混入を防ぐ手当て)
- pre-commit での secret scan(T-013「内容」。CI は導入済み)
- GitHub の設定(公開時にオーナーが行う): Secret scanning と push protection、Private vulnerability reporting の有効化
