# ADR-022: Redmine 個人 API キーの資格情報表現

Status: Accepted (2026-11-12, user review) / Date: 2026-11-12

## 文脈

Redmine コネクターのプロトタイプを作り、GitHub と異なるネイティブ検索の品質を評価したい。Redmine の REST API は利用者の API キーを `X-Redmine-API-Key` ヘッダーで受け付け、`/search.json` で本人が閲覧できる Issue・Wiki 等を検索できる。プロジェクト一覧も認証利用者に見える公開・非公開プロジェクトを返す。

Leisen の共通 `Credential` は現在 `oauth_bearer` と `delegated_identity` のみである。`oauth_bearer` を Redmine API キーとして流用すると、名前と意味が一致せず、コネクターがトークンをどう提示するか型から読み取れない。一方、コネクター設定・共有環境変数に API キーを置く方式は、利用者本人の認可を維持する原則に反する。

参照する一次資料:

- [Redmine REST API — Authentication](https://www.redmine.org/projects/redmine/wiki/rest_api#Authentication)
- [Redmine REST Search](https://www.redmine.org/projects/redmine/wiki/Rest_Search)
- [Redmine REST Projects](https://www.redmine.org/projects/redmine/wiki/Rest_Projects)
- [Redmine REST Wiki Pages](https://www.redmine.org/projects/redmine/wiki/Rest_WikiPages)

## 決定

1. `Credential` に `api_key` を追加し、Redmine の個人 API キーを秘密値として保持する。必要なら失効時刻を表現できるようにする。SDK は v0.5 とする。
2. Redmine コネクターは受け取った資格情報を `X-Redmine-API-Key` ヘッダーでのみ送り、URL クエリ、ログ、エラー文、監査本文には含めない。
3. Gateway の Credential Provider が、利用者×sourceId 単位で API キーを供給できる方式を定義する。AuthMethod に `api_key_individual` を追加する。プロトタイプは開発用のユーザー別環境変数でよいが、本番用 Token Vault / Credential Provider の実装は別途明示する。
4. プロトタイプは読み取り専用の `search` / `fetch` / `list` / `describe` に限定する。本人の資格情報で Redmine API を呼び、アクセス可否の判断や ACL の複製は行わない。
5. `search` は Redmine `/search.json` を使い、まず Issue と Wiki ページを対象にする。`list` は本人に見えるプロジェクトを列挙する。検索結果の型ごとに安定した `documentId` を定義し、fetch は Issue 本文または Wiki ページ本文を取得する。

## 検討した代替案

### `oauth_bearer` に Redmine API キーを格納する

型追加を避けられるが、認証方式とフィールド名が誤解を招き、将来の Token Vault・各種 Provider でも「Bearer token」と API key の区別が失われるため採用しない。

### API キーを connector settings / 共通環境変数に置く

サービスアカウントとして全利用者に共有され、本人の権限を使う不変条件を満たさないため採用しない。

### `delegated_identity` を使う

Redmine の API は本人 API キーを要求するため、principal だけではリクエストを認証できない。別の委譲方式を Redmine 側で用意しない限り採用できない。

## 影響

- `Credential` 共用体の追加は Gateway、Credential Cache、Provider、redaction と契約テストに影響する。
- 新しい資格情報方式の追加として ADR-007 の要件を満たす。
- Redmine REST Search は Redmine 側で Alpha とされている。対応バージョン差や検索対象の差を README に記録し、実 Redmine で検索結果を評価する必要がある。
- API キーは利用者ごとに発行・保存・失効できる運用経路が必要。開発用モックの環境変数だけでは本番接続にならない。

## 承認後のプロトタイプ範囲

- `@leisen/connector-redmine` パッケージ、Gateway の公式コネクター許可表、設定例と README。
- 初期の手動評価は既存の Redmine インスタンスに対して行い、利用者権限での Issue / Wiki 検索と出典付き fetch を確認する。
- 本番 Token Vault、OAuth 同意 UX、全件 ingest / 独自インデックス、更新系 API はこのプロトタイプの範囲外。
