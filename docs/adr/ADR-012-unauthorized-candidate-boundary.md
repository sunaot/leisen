# ADR-012: 未認可候補の境界不変条件

Status: Accepted / Date: 2026-07-05

## 文脈
ADR-003のpost-filteringは「返却前にソース認可APIを本人トークンで照会」と定めるが、「返却前」がどの境界かで安全性が変わる。未認可候補のタイトル・URL・スニペット・documentId・件数がLLMコンテキスト、監査ログ、デバッグログ、メトリクスに漏れる経路を構造的に塞ぐ必要がある。

## 決定
**未認可候補はSearch Backend Adapterの内部にのみ存在する。** 候補取得→認可照会→適応的K拡張はアダプタ内で完結させ、外に出るのは認可済みhitのみとする。内容だけでなく件数も対象とし、Connector / Gateway / Orchestrator / LLM / 監査ログ / デバッグログ / メトリクスのいずれにも出さない。唯一の例外はADR-011が定める分離テレメトリ。

## 帰結
- CLAUDE.mdの不変条件に昇格済み
- 検索層(Q3)の実装・テストは「未認可候補の非流出」を第一級のテスト対象とする(レッドチーム項目・カナリア文書と連動)
- `authzCheck: "native" | "fetch" | "none" | "coarse"` のcapability追加(permission check APIの有無・コストの型表現)はfitting検証(ADR-007の手法)を通してから判断する
