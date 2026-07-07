# ADR-007: コネクタIF v0.2 — 3ソースfitting検証に基づく最小拡張

Status: Accepted / Date: 2026-07-04

## 文脈
コネクタIFの消費者(T-005/006/007)が生まれる直前が、IF変更コストが最安の最後の時点である。性質の異なる3ソース(Slack / Google Drive / ファイル共有上のOffice・PDF)の代表値を型で表現するfitting検証(`packages/connector-sdk/test/if-fitness.test.ts`)を行い、不足のみを拡張した。緊急性(「後で壊れる」)ではなく経済性(消費者ゼロの今が最安)が根拠である。

## 採用した変更(v0.1→v0.2)
1. **Credential判別共用体**: `AuthContext.accessToken`(OAuthベアラー前提)を `credential: Credential` に置換。ファイル共有等「本人としてのアクセス試行」で認可されるソースを `delegated_identity`(experimental、semantics未確定)として表現可能に。AuthContextは全コネクタが依存する最も変更コストの高い型であり、認可委譲原則(不変条件1)が「資格情報はソースの認可が理解する形式」を要求するため、今の一般化を正当化した。新kindの追加にはADRを必須とする。
2. **HitAnchor**: 長大文書(PDF/Office)とスレッド(Slack)で、ヒットが「文書」でなく「文書内位置」でないとLLMが原典に降りられない。`SearchHit.anchor?` を追加。
3. **ConnectorCapabilities**: `nativeSearch: full|degraded|none` と `ingest: boolean`。T-010の設定検証(検索層有効化はingest実装コネクタに限る)とOrchestratorのソース選択が消費する。

## 却下した変更(過剰一般化の防止)
- **documentId の構造化**: 複合キー(Slackのchannel:thread_ts)はopaque stringへの符号化で表現可能。IF変更不要
- **snippet のoptional化**: degradedソースでは空文字許容のドキュメント化で足りる
- **`ingest()` の詳細シグネチャ**: 消費者はQ3の検索層のみで期限圧力がなく、実データなしの確定は過剰設計。capabilityフラグの予約に留める
- **コネクタのフル擬似実装**: IF検証には型fittingで十分

## 導入原則の修正(重要)
fitting検証により、ファイル共有のような **index-requiredクラス**(nativeSearch: "none")の存在が判明した。このクラスでは「全導入は検索層OFFで開始し証拠駆動で昇格」(ADR-006)が適用不能である(比較すべきネイティブ検索のベースラインが存在しない)。次の通り修正する:
- 昇格の証拠駆動ゲートは nativeSearch が full/degraded のソースにのみ適用
- nativeSearch: "none" のソースは、導入時に検索層有効化とセットでのみ deployment.yaml 検証を通す(T-010に反映)
- 導入プレイブックの標準工程に「index-requiredソースの初期インデックス構築」を分岐として追加
