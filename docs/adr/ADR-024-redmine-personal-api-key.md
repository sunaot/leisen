# ADR-024: Redmine コネクタと個人 API キーの資格情報表現

Status: Proposed(2026-11-16。決定 5 の「公式コネクタとして初期セットに含める」はオーナー決定。決定 1〜4 は人間レビュー待ち)/ Date: 2026-11-12 / 改訂: 2026-11-16

元は外部からの PR(sunaot/leisen#74、作者 ashie)で ADR-022 として起案された。同じ日に ADR-022(本人資格情報の置き場所)と ADR-023(esa)が採番・Accepted になったため番号を 024 に改め、ADR-022 の決定と整合するように決定を組み替えた。

## 文脈

GitHub のコード検索 API には、パスを指定すれば取れる README が検索で見つからない等の制約がある。検索から出典付きの回答までの流れを別のネイティブ検索で確かめるため、Redmine コネクタを試作した。Redmine の REST API は利用者の API キーを `X-Redmine-API-Key` ヘッダーで受け付け、`/search.json` で本人が閲覧できる Issue・Wiki 等を検索できる。プロジェクト一覧も本人に見える公開・非公開プロジェクトを返す。作者の環境で、OpenCode からの直接検索と `leisen-ask` の両方で Issue のノートを取得し、ノートへの直リンクを確認した。

connector-sdk の `Credential` は `oauth_bearer` と `delegated_identity` だけである。`oauth_bearer` に API キーを入れると、名前と意味が一致せず、コネクタがキーをどう提示するかを型から読み取れない。API キーを connector settings や共有の環境変数に置く方式は、全利用者に共有されるサービスアカウントになり不変条件 1 に反する。

本番の資格情報の経路について、ADR-022 は `connectors[].auth.provider` を `token_vault` / `esc` / `token_exchange`(と開発用の `mock_env`)に限り、決定 11 でクライアントが資格情報を平文で提示する方式を採らないとした。Token Vault の接続は現状 OAuth だけである。ADR-023 も同じ理由で esa の個人アクセストークンを使わなかった。したがって、利用者ごとの Redmine API キーを本番で扱う経路は、現時点で承認されたものがない。

参照する一次資料:

- [Redmine REST API — Authentication](https://www.redmine.org/projects/redmine/wiki/rest_api#Authentication)
- [Redmine REST Search](https://www.redmine.org/projects/redmine/wiki/Rest_Search)
- [Redmine REST Projects](https://www.redmine.org/projects/redmine/wiki/Rest_Projects)
- [Redmine REST Wiki Pages](https://www.redmine.org/projects/redmine/wiki/Rest_WikiPages)

## 決定

1. **`Credential` に `api_key` を加える(connector-sdk v0.5)。** `{ kind: "api_key", apiKey, expiresAt? }`。`apiKey` はログ出力禁止で、`redactAuthContext()` は kind だけを残す。`expiresAt` を省略した(または 0 以下の)資格情報は、Gateway の資格情報キャッシュで設定 TTL だけで失効させる(ADR-016 追補 2026-11-14 の「失効時刻不明」と同じ扱い)。コネクタ共通 IF の変更として本 ADR に記録する(不変条件 5)
2. **`AuthMethod` に新しい分類は加えない。** `AuthMethod` は ADR-010 / ADR-022 の「資格情報をどう得るか」の分類で、今回の取得経路は開発用の `mock_env` だけである。`mock_env` に `credentialKind`(`oauth_bearer` / `api_key`、既定 `oauth_bearer`)を加え、モックが返す資格情報の形式だけを選べるようにする。起案時の `api_key_individual` は採らない
3. **本番の経路はこの ADR の範囲外とし、別の ADR で決める。** 本 ADR で使えるのは開発用の `mock_env`(`NODE_ENV=production` では起動時に拒否)だけである。候補は「残る確認事項」に記す
4. **Redmine コネクタは読み取り専用の `search` / `fetch` / `list` / `describe` に限る。** 本人の資格情報で Redmine API を呼び、アクセス可否の判断や ACL の複製は行わない。キーは `X-Redmine-API-Key` ヘッダーでだけ送り、URL のクエリ・ログ・エラー文・監査本文に含めない。リダイレクトは追従しない。`search` は `/search.json` の Issue・Issue のノート・Wiki ページを返し、ノートは親 Issue を本人のキーで取得して `journals` に含まれる場合に限って返す(直接の `fetch` も同じ検査を通す)。`list` は本人に見えるプロジェクトを列挙する。プロジェクトの公開状態と Issue・ノートの非公開フラグを `scope` に反映し、Gateway の既定 `privateScopes: excluded` で非公開のものを除く
5. **公式コネクタ `@leisen/connector-redmine`(`kind: redmine`)として初期セットに含める(2026-11-16 オーナー決定)。** ADR-021 の許可表に載せ、リファレンスのイメージ(`deploy/Dockerfile`)にも esa と同様に含める。導入実績は 1 社だが、不変条件 9 の例外としてオーナーが判断した

### ページングと不変条件 3

`search` の次ページの有無は Redmine の `total_count` と、Redmine が返した件数(コネクタが除外する前の件数)で決める。コネクタがノートの照合で落としたヒットがあると、そのページは limit より短くなる。落とされるのは Redmine が本人向けに返したうえで、Issue の取得で本人に見えないと分かったものであり、ADR-012 が扱う「Search Backend Adapter の未認可候補」(Leisen 側の索引が持つ候補)とは性質が異なる。件数を外に出すことにもならない(`total_count` は返さない)ため、不変条件 3 の対象外と整理する。

## 検討した代替案

- **`oauth_bearer` に API キーを入れる**: 型の追加を避けられるが、認証方式とフィールド名が誤解を招き、将来 Token Vault 等で Bearer トークンと API キーを区別できなくなるため採らない
- **API キーを connector settings / 共有の環境変数に置く**: サービスアカウントになり不変条件 1 を満たさないため採らない
- **`delegated_identity` を使う**: Redmine は本人の API キー(または後述の OAuth)を要求し、principal だけでは認証できないため採らない

## 帰結

- `Credential` 共用体の追加は Gateway の資格情報キャッシュ・モックの Provider・redaction に及ぶ。`oauth_bearer` だけを受け付ける既存のコネクタ(GitHub・esa)は、`api_key` を受け取ると従来どおりエラーにする(Redmine コネクタは逆に `api_key` 以外を拒否する)
- Redmine の REST Search と Wiki Pages API は Redmine の公式文書で Alpha とされる。結果の形式・検索対象はバージョンやプラグイン(`redmine_full_text_search` 等)で差があり得るため、導入先で確認する(`packages/connector-redmine/README.md`)
- 検索 1 回につきヒットごとに Issue とプロジェクトを取得する。limit を大きくするとソースのレート制限に当たりやすい
- 実疎通の確認は作者の環境の 1 件のみ。リポジトリのテストはモックで行う

## 残る確認事項

- 本番の経路(決定 3)。いまの仕組み(ADR-022)の上での候補は次のとおり
  - **Redmine の OAuth2 プロバイダ + `token_vault`(第一候補)**: Redmine は Doorkeeper による OAuth2 プロバイダを本体に取り込んだ(Feature #24808。6.1 で入ったとされる。版は要確認)。Redmine の権限をスコープに使う。管理者がアプリを登録すれば、`provider: token_vault` の `preset: custom`(端点を指定)で接続ページの OAuth に載り、資格情報は `oauth_bearer`(`Authorization: Bearer`)になる。新しい方式も、クライアントによる平文の提示も要らない。確かめること: 対応する版、更新トークンの発行、失効エンドポイント、本人照合(`/users/current.json` の自分のメールアドレス)、スコープの強制の不具合(Bug #44271)が直っているか
  - **接続ページでの API キーの登録(Redmine 6.1 未満向けの代替)**: 利用者が Gateway の接続ページに自分の API キーを入力し、Token Vault と同じ封筒暗号化で保管する。クライアントが毎回平文で提示するのではないので、ADR-022 決定 11 には当たらない。ただし、OAuth ではない接続を Token Vault に加える変更として新しい ADR が要る。論点は、期限のない全権限のキーを保管すること、Gateway からはソース側で失効させられないこと(利用者が Redmine でキーを再生成する。アカウントのロックでキーは無効になる)、接続時の本人照合
  - `esc` に API キーを封じる案、`token_exchange` は、Redmine が交換に対応しないこと、ローテーションの仕組み(ADR-022 決定 5)に乗らないことから候補にしない
- `redmine_full_text_search` 等のプラグインがある環境とない環境の差の扱い
