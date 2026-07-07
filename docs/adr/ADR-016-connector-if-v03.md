# ADR-016: コネクタIF v0.3 — レビュー指摘に基づく最小拡張

Status: Accepted / Date: 2026-07-05

## 文脈
実装前レビューにより、Phase 1の消費者(T-005/006/007)が実際に必要とする不足と、セキュリティ上の規約不足が特定された。ADR-007と同じ経済性基準(消費者が生まれる直前が変更コスト最安)で最小拡張を行う。

## 採用した変更(v0.2→v0.3)
1. **search options**: `SearchOptions { cursor?, limit? }`。Orchestratorの結果件数制御とページングを1引数に集約
2. **list のページング**: 戻り値を `ListResult { entries, nextCursor? }` に変更。Driveフォルダ数千件・Slackチャンネル一覧はページング必須
3. **snippet長の規約**: `MAX_SNIPPET_CHARS`(既定500)をSDK定数として輸出し、Gatewayが強制truncateする。型コメントだけでは本文流入を防げない
4. **redaction標準化**: `redactAuthContext()` を追加。AuthContext/Credentialの直接シリアライズを禁止し(CLAUDE.md不変条件6)、fitting testでトークン非流出を検証

## 却下・保留した変更(fitting検証待ち)
- fetchのanchor指定 — pageCursorへの符号化で表現可能(ADR-007の複合ID方式と同型)
- FetchResultのmimeType — metaで表現可能
- エラークラス追加(quota_exceeded等)— 消費者不在
- `authzCheck` capability(ADR-012)、`contentPersistence` capability(ADR-014)— 必要性は認識済みだが、semanticsは検索層/Slackコネクタの実装時にfitting検証を通して確定する

## 追補: SearchResult.totalCount の削除(2026-07-05)
レビュー指摘により、`SearchResult.totalCount` を削除した。ネイティブ検索の総件数であっても、Phase 2で検索層が内部実装に入った際にpost-filtering前候補数が混入すると、返却hitとの差分でexistence leak(ADR-012)になる。現時点で消費者が存在しないため、返す前に削除するのが最も安全(ADR-007の却下基準)。件数提示が必要になった場合は「認可済み返却可能件数のみ」を意味する専用フィールドを別ADRで定義する。
