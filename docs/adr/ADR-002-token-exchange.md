# ADR-002: 権限透過はIdP起点のToken Exchangeで実現する

Status: Superseded予定(ADR-010のAccepted化と同時。docs/auth-matrix.md の人間レビュー待ち) / Date: 2026-07-04

## 文脈
検索は必ず利用者本人の権限で行う(プロダクト原則1)。実現方式として (a) 各ソースへの個別OAuth接続をユーザーごとに保持、(b) IdP(Okta/Entra ID)を起点とするToken Exchange(RFC 8693)/on-behalf-ofフロー、の2案。

## 決定
(b)を基本方式とする。IdPが対象ソースとのフェデレーションを持たない場合のみ、(a)の個別OAuth接続(Gatewayが暗号化保管するリフレッシュトークン)にフォールバックする。

## 理由
- ユーザーごとのトークン保管を最小化でき、退職・権限変更がIdPで一元的に反映される
- 監査上「誰の権限で呼んだか」がIdPのIDに一意に紐づく

## 帰結
- Gatewayに TokenBroker モジュールを置き、`getToken(userId, source)` の背後で方式差を吸収する
- トークンキャッシュはユーザー×ソース単位、TTLはトークン有効期間内。永続化する場合は暗号化必須
- フォールバック(a)を使うソースは docs/adr に追記して管理する

## 追補(2026-07-05)
本ADRの基本方式(RFC 8693)はPhase 1主要対象(Google Drive / Slack)で前提化できないことが判明した。**ADR-010(ソース別Auth Adapter + Token Vault)による改訂を提案中**であり、T-000a完了をもって本ADRはSupersededとなる予定。それまで本ADRを根拠にtoken exchange前提のコードを書かないこと。

## 追補(2026-07-09)
T-000a(docs/auth-matrix.md)の調査完了により、本ADRの基本方式が前提化できないことは一次情報で確定した。auth-matrix.md の人間レビュー完了(ゲート解除)をもって本ADRは **ADR-010 に Superseded** となる。認可方式の正は ADR-010 と auth-matrix.md を参照。
