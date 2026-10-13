# ADR-020: 配布名・CLI 名・設定名を leisen に統一する

Status: Accepted(2026-10-13 オーナー決定: `kp` をやめて `leisen` に統一、CLI は `leisen-ask` / `leisen-gateway`。決定 5〜8 は同日の提案をオーナーが ADR 化を指示して採用)/ Date: 2026-10-13

## 文脈

パッケージ・CLI・環境変数は `kp`(knowledge-platform の略)を接頭辞にしてきた。一方でリポジトリ名とプロダクト名は leisen であり、MCP `_meta` の独自キーの prefix(`io.github.sunaot.leisen/`、ADR-001 追補3 決定4)も leisen を含む。名前が二系統に割れている。

OSS 公開をすぐに行う(T-013、2026-10-13 オーナー判断)。npm での配布は将来の可能性としてある。名前は外部に依存が生まれた後に変えると高くつく。特にコネクタ SDK のパッケージ名は、第三者がコネクタを書くときの依存先、つまり公開 API になる。外部の利用者がいない公開前が、最も安く改名できる時期である。

npm レジストリの確認(2026-10-13): `@kp/*` で公開されたパッケージはない。`@kp` は 2 文字で、スコープの持ち主の有無はここからは確認できなかった。`@leisen/*`、`leisen`、`leisen-ask`、`leisen-gateway`、`leisen-promotion-report` はいずれも未登録だった。npm の組織 `leisen` の有無は確認できていない。

## 決定

1. **プロダクト名・配布名は `leisen` に統一し、`kp` は使わない。** 既存の ADR・設計書の本文にある `kp-*` / `@kp/*` / `KP_*` は当時の記録として書き換えず、本 ADR 以降は `leisen` の名前に読み替える。手順書・README・コード・設定例は改名 PR で更新する。
2. **npm スコープは `@leisen`。**

   | 旧 | 新 |
   |---|---|
   | `@kp/audit` | `@leisen/audit` |
   | `@kp/connector-sdk` | `@leisen/connector-sdk` |
   | `@kp/connector-github` | `@leisen/connector-github` |
   | `@kp/gateway` | `@leisen/gateway` |
   | `@kp/orchestrator` | `@leisen/orchestrator` |
   | `@kp/promotion-report` | `@leisen/promotion-report` |
   | ルートの `knowledge-platform`(private) | `leisen`(private のまま) |

3. **CLI 名。** サブコマンドと引数は変えない。

   | 旧 | 新 |
   |---|---|
   | `kp-gateway` | `leisen-gateway` |
   | `kp-ask` | `leisen-ask` |
   | `kp-promotion-report` | `leisen-promotion-report` |

   **`leisen-query` ではなく `leisen-ask` とする。**
   - 中身と合う。このコマンドは質問を受け、LLM が Gateway のツールで探索し、出典付きの回答を返す。「query」は検索クエリや結果の一覧を連想させ、回答が返ることが伝わりにくい
   - 既存の語彙と揃う。`serve` が公開する MCP ツールの名前は `ask` であり、ADR-018 も「ask / feedback の API」としている
   - 「query」はすでに別の意味で使っている。search ツールの引数、生クエリ表、v1.0 の範囲外とした text-to-query(ADR-008)である
   - 将来、Gateway の search を直接呼んで結果の一覧を返す CLI を作る場合に、`leisen-query` の名前を残せる
4. **コネクタの既定の解決規則は `@leisen/connector-<kind>` とする。** `connectors[].module` の明示は従来どおり優先する。命名規則で第三者のパッケージを拾う経路を塞ぐ許可表方式(issue #32)は、プラグイン境界の変更なので ADR-005 の改訂(issue #23)で別に決める。本 ADR は接頭辞だけを変える。**追記(2026-10-13)**: 許可表方式は、実際には ADR-005 の改訂ではなく新しい ADR-021 で決めた(ADR-005 には追補で参照を足した。issue #23 の境界全体の見直しは別に残る)。`module` を省略できるのは公式コネクタの許可表にある kind だけになり、`@leisen/connector-<kind>` の命名規則による解決はなくなった。
5. **環境変数の接頭辞は `KP_` から `LEISEN_` に変える**(例: `KP_DEPLOYMENT_CONFIG` → `LEISEN_DEPLOYMENT_CONFIG`、`KP_ORCHESTRATOR_CREDENTIAL` → `LEISEN_ORCHESTRATOR_CREDENTIAL`)。テスト・スモーク専用のものを含む全 36 種類(2026-10-13 時点)が対象。旧名の読み替えはしない。外部の利用者がいない公開前であり、読み替えを持つと設定の正が二つになるため。
6. **線上と内部の名前も揃える。**
   - HTTP ヘッダ: `x-kp-orchestrator-credential` → `x-leisen-orchestrator-credential`(Orchestrator から Gateway の run API と tools/call へ)。テストで任意ヘッダの例に使う `x-kp-route` も揃える
   - MCP の serverInfo / clientInfo の name: `kp-gateway` → `leisen-gateway`、`kp-orchestrator` → `leisen-orchestrator`
   - Gateway 内部の authInfo の追加キー: `kp.gateway/*` → `leisen.gateway/*`
   - いずれも送り手と受け手がこのリポジトリの中にあるので、同じ PR で両側を変える
7. **開発用・参照構成の名前も揃える。**
   - コンテナイメージ: `kp-gateway:local` → `leisen:local`。Gateway と Orchestrator の両方が入っているため、片方の名前にしない
   - compose のプロジェクト名とボリューム名: `kp-reference`、`kp-audit` など → `leisen-*`
   - Keycloak の realm: `kp` → `leisen`
   - 設定例のクライアント名: `kp-chat-ui` → `leisen-chat-ui`
   - ボリューム名が変わるため、手元の評価用構成の監査ボリュームは引き継がれない(開発用のデータのみ)
8. **改名は 1 本の PR でまとめて行い、旧名の別名は残さない**(T-013 の一部)。手元の `.env` は `.env.example` から作り直す。改名 PR では、ビルド、全テスト、CI の keycloak-e2e と reference-deploy の通過に加え、旧名が残っていないことを検索で確かめる。対象外は、本 ADR と既存 ADR の本文、日付付きの記録(docs/eval、docs/release、docs/spikes)である。

## 変えないもの

- MCP `_meta` の独自キーの prefix `io.github.sunaot.leisen/`。名前の部分はすでに leisen で揃っている。逆ドメインの所有者部分(GitHub の個人アカウント)を含めた最終確定は、配布サイトと併せて T-013 で行う(ADR-001 追補3 決定4)
- ツール名(`search` / `fetch` / `list` / `describe`、`ask` / `feedback`)と、監査レコードのスキーマ

## 帰結

- 公開時点でプロダクト名・パッケージ名・CLI 名・設定名が一致し、利用者が二系統の名前を覚えずに済む
- 第三者のコネクタ作者は、最初から `@leisen/connector-sdk` に依存できる
- 改名 PR は 270 程度のファイルにまたがる。置換は機械的だが、lock・Dockerfile・compose・CI・Keycloak の realm を含むため、CI の全ジョブで確かめる

## 残る確認事項

- **npm の組織 `leisen` の確保(人手、公開前):** 組織は無料で作れる。npm に配布するかどうかによらず、先に確保して第三者の取得を防ぐ
- **スコープなしの CLI 名:** `leisen-ask` などは `@leisen/orchestrator` の中のコマンド名で、npm 上のパッケージ名ではない。入れていない環境で `npx leisen-ask` を実行すると、npm は同名のパッケージをレジストリから取りに行く。npm 配布を始めるときに、同名の空パッケージで塞ぐか、文書でスコープ付きの名前を案内する
- **商標の確認:** 保留(T-013、2026-10-13 オーナー判断)
- **コネクタの許可表方式:** ADR-005 の改訂(issue #23 / #32)
