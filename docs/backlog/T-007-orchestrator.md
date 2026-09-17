# T-007: Orchestrator探索戦略v1

## 目的
product-design.md 4.3の探索ループを実装する。品質は単発検索でなく反復で稼ぐ(原則3)。

## 内容
- Claude APIのツール使用でGateway経由のツール群を呼ぶエージェントループ
- システムプロンプトに探索方針(広く→絞る、類義語・英日変換、最大N回、出典必須、不確実性の開示)を実装。プロンプトは `packages/orchestrator/prompts/` にバージョン管理
- **未接続ソースの扱い(ADR-010)**: 資格情報未取得のソースはスキップし、回答に「未接続のため検索していない」旨と接続導線を含める
- **実行区分の申告(ADR-015)**: Gatewayに human-in-the-loop を申告する。scheduled/autonomousは実装しない
- **runId / iteration の申告(ADR-001追補3、ADR-011)**: Orchestratorが探索ループの開始時にrunIdを採番し、全ツール呼び出しの `_meta`(名前空間prefix付きキー)で runId / iteration を申告する。Gateway側のセッション単位自動採番には依存しない(ステートレス前提)。未申告の呼び出しは単発runとして記録され、run内の継続性は保証されない
- 反復上限・タイムアウト・コスト上限を設定注入可能に
- 回答スキーマ: answer, citations[], searchedSources[], skippedSources[](未接続), confidence
- ツール結果はデータとして扱う旨のインジェクション防御プロンプトを含める(T-000cの脅威モデル参照)

## 受け入れ条件
- [ ] モックコネクタに対する再現可能なシナリオテスト(1発ヒット/再検索で到達/未解決/一部ソース未接続)が通る
- [ ] 出典のない断定文を返さないことがテストで担保される
- [ ] 監査ログのAnswerRun(finalOutcome, userFeedback)が利用者フィードバックで更新できる
- [ ] 1回の探索ループ内の全ツール呼び出しが同一runIdと単調増加するiterationで `_meta` に申告され、監査ログのToolInvocationがrunIdで束ねられることがテストされている

## 更新(2026-09-17)
ADR-001追補3(ドラフト、人間レビュー待ち)により、runId / iteration の `_meta` 申告が本タスクの必須要件になった。`_meta` のキー名(prefix)は追補3の承認時に確定する。承認前に着手する場合はGatewayの現行キー(`runId` / `iteration`)で実装し、prefix確定後に追随する。
