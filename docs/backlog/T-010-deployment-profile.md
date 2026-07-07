# T-010: Deployment Profileスキーマとローダー【T-003より先に実施】

## 目的
ADR-005の設定駆動アーキテクチャの中核。導入1件=deployment.yaml 1枚を成立させる。T-003は本タスクのスキーマの最小サブセットに依存する(sources.yamlは作らない)。

## 前提
**T-000b(プライバシー方針、ADR-013)の決定。**

## 内容
- `packages/gateway/src/config/` にスキーマ(zod)、ローダー、静的検証を実装
- 項目: idp.adapter, connectors[](enabled, **privateScopes: excluded|consent|included(既定excluded)**, searchLayer.enabled/backend/authzCacheTtlSec), orchestrator(maxIterations, costLimit), audit(sink, **failureMode: fail-closed|fail-open(既定fail-closed)**, **rawQueryRetentionDays**), **agentExecution(ADR-015の区分設定の予約)**
- スキーマバージョンフィールドと将来のマイグレーション枠組み
- 危険設定の起動時拒否: searchLayer.enabled=true かつ対象コネクタがingest capability未実装、authzCacheTtlSecの上限超過、audit.failureMode=fail-openかつ確認フラグなし 等

## 受け入れ条件
- [ ] 妥当な設定のサンプル(examples/deployment.yaml)が同梱され、READMEから参照される
- [ ] 危険設定パターンごとに起動拒否のテストがある
- [ ] ConnectorCapabilities連動の検証: searchLayer.enabled=trueはingest:trueのコネクタのみ許可、nativeSearch:"none"のコネクタはsearchLayer.enabled=trueとセットでのみ許可(ADR-007)
- [ ] privateScopesの既定がexcludedであることがテストされている
