# ADR-015: 自律エージェントの権限委譲ポリシー

Status: Accepted(Phase 1の既定)/ Date: 2026-07-05

## 文脈
product-design.md 4.1は「API利用時は呼び出し元エージェントの実行主体となる人間のトークンを引き回す」と定める。人間がその場で操作するチャットと異なり、非同期・定期実行・他者依頼で動くエージェントの本人権限行使には、監査(ADR-011のactor記録)に加えて同意モデルが必要になる。

## 決定
delegated agent execution policyを定義する:
- 実行区分: **human-in-the-loop**(人間の対話セッション内) / **scheduled**(定期実行) / **autonomous**(自律)
- 区分ごとに 許可ソース・スコープ・資格情報TTL・再承認条件・監査上の表示 を設定できる構造をdeployment.yamlに予約する
- **Phase 1では human-in-the-loop のみ許可し、scheduled / autonomous はGatewayが既定拒否する。** 解放は本ポリシーの区分設定と利用者本人の明示同意を実装してから

## 帰結
- ADR-011のactorフィールド(human/agent、on-behalf-ofチェーン)が本ポリシーの監査面を担う
- T-007(Orchestrator)は実行区分をGatewayに申告し、Gatewayが区分と設定を照合して拒否できること
