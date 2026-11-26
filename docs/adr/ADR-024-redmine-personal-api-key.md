# ADR-024: Redmine コネクタと個人 API キーの資格情報表現

Status: Accepted(2026-11-24 オーナー決定。決定 5 は 2026-11-16 オーナー決定)/ Date: 2026-11-12 / 改訂: 2026-11-16、2026-11-24、2026-11-25(追補)

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

1. **`Credential` に `api_key` を加える(connector-sdk v0.5)。** `{ kind: "api_key", apiKey, expiresAt }`。`apiKey` はログ出力禁止で、`redactAuthContext()` は kind だけを残す。`expiresAt` は `oauth_bearer` と同じ取り決めにそろえて必須とし、0 以下を「失効時刻不明」とする(ADR-016 追補3)。期限のない固定キーは 0 を入れ、Gateway の資格情報キャッシュは設定 TTL だけで失効させる。起案時は省略可としていたが、同じ概念の表し方が 2 通りになるため改めた(2026-11-16)。コネクタ共通 IF の変更として本 ADR に記録する(不変条件 5)
2. **`AuthMethod` に新しい分類は加えない。** `AuthMethod` は ADR-010 / ADR-022 の「資格情報をどう得るか」の分類で、今回の取得経路は開発用の `mock_env` だけである。`mock_env` に `credentialKind`(`oauth_bearer` / `api_key`、既定 `oauth_bearer`)を加え、モックが返す資格情報の形式だけを選べるようにする。起案時の `api_key_individual` は採らない。`credentialKind: api_key` では、全利用者で共有される `LEISEN_MOCK_TOKEN_<SOURCEID>` へのフォールバックを認めず、利用者別の `LEISEN_MOCK_TOKEN_<SOURCEID>__<USERID>` だけを使う(期限のない全権限の個人キーを他の利用者に使わせないため。開発用でも不変条件 1 の形を保つ)
3. **本番の経路はこの ADR の範囲外とし、別の ADR で決める。** 本 ADR で使えるのは開発用の `mock_env`(`NODE_ENV=production` では起動時に拒否)だけである。候補は「残る確認事項」に記す
4. **Redmine コネクタは読み取り専用の `search` / `fetch` / `list` / `describe` に限る。** 本人の資格情報で Redmine API を呼び、アクセス可否の判断や ACL の複製は行わない。キーは `X-Redmine-API-Key` ヘッダーでだけ送り、URL のクエリ・ログ・エラー文・監査本文に含めない。リダイレクトは追従しない。`search` は `/search.json` の Issue・Issue のノート・Wiki ページを返し、ノートは親 Issue を本人のキーで取得して `journals` に含まれる場合に限って返す(直接の `fetch` も同じ検査を通す)。標準の検索(全文検索プラグインなし)はノートに一致しても親の Issue だけを返すため、Issue の `fetch` は本人のキーで取得した `journals` のノート本文・ノートの documentId・直リンクを含め、長い場合は `nextPageCursor` で続きを返す(2026-11-24 追記。プラグイン `redmine_full_text_search` がある環境では `issue-note` が直接返る)。`list` は本人に見えるプロジェクトを列挙する。Wiki の documentId は project・title の `.` / `..` を拒否する(同じオリジンの別の端点を指さないため)
   - **全結果を `shared` とする(2026-11-24 オーナー決定)。** `privateScopeHandling: classified`。ADR-016 追補2 の private は DM・プライベートチャンネル・個人スコープを指す。Redmine にはこれに当たる領域がなく、非公開プロジェクト・非公開 Issue・非公開ノート(`private_notes`)は、ロールと担当者で閲覧範囲を限る Redmine の ACL である。閲覧の可否は本人の API キーで呼ぶ Redmine が判定する。GitHub の組織の private リポジトリを shared とした整理(ADR-016 追補2 決定 7)と同じ。既定の `privateScopes: excluded` でも、本人が見られる非公開プロジェクトの内容は検索・取得の対象になる
   - 起案時と 2026-11-24 の改訂前は、プロジェクトの公開状態と Issue・ノートの非公開フラグを `scope` に写していた。セキュリティレビューで次の 2 点が指摘されたため改めた。(1) 標準の検索では、非公開ノートにだけ一致した Issue が `shared` のヒットとして返り、続く `fetch` が `private` で拒否されることで「非公開ノートに一致した」ことが分かる。(2) Issue の `is_private` が欠けると `shared` に倒れる(ノート・プロジェクトは逆)。全結果を shared とすることで両方とも生じなくなり、分類のためのプロジェクトの取得(検索 1 回でヒットごとの要求)もなくなった
5. **公式コネクタ `@leisen/connector-redmine`(`kind: redmine`)として初期セットに含める(2026-11-16 オーナー決定)。** ADR-021 の許可表に載せ、リファレンスのイメージ(`deploy/Dockerfile`)にも esa と同様に含める。導入実績は 1 社だが、不変条件 9 の例外としてオーナーが判断した

### ページングと不変条件 3

`search` の次ページの有無は Redmine の `total_count` と、Redmine が返した件数(コネクタが除外する前の件数)で決める。コネクタがノートの照合で落としたヒットがあると、そのページは limit より短くなる。落とされるのは Redmine が本人向けに返したうえで、Issue の取得で本人に見えないと分かったものであり、ADR-012 が扱う「Search Backend Adapter の未認可候補」(Leisen 側の索引が持つ候補)とは性質が異なる。件数を外に出すことにもならない(`total_count` は返さない)ため、不変条件 3 の対象外と整理する。

## 検討した代替案

- **`oauth_bearer` に API キーを入れる**: 型の追加を避けられるが、認証方式とフィールド名が誤解を招き、将来 Token Vault 等で Bearer トークンと API キーを区別できなくなるため採らない
- **API キーを connector settings / 共有の環境変数に置く**: サービスアカウントになり不変条件 1 を満たさないため採らない
- **`delegated_identity` を使う**: Redmine は本人の API キー(または後述の OAuth)を要求し、principal だけでは認証できないため採らない

## 帰結

- `Credential` 共用体の追加は Gateway の資格情報キャッシュ・モックの Provider・redaction に及ぶ。`oauth_bearer` だけを受け付ける既存のコネクタ(GitHub・esa)は、`api_key` を受け取ると従来どおりエラーにする(Redmine コネクタは `api_key` と `oauth_bearer` を受け、それ以外を拒否する。追補)
- Redmine の REST Search と Wiki Pages API は Redmine の公式文書で Alpha とされる。結果の形式・検索対象はバージョンやプラグイン(`redmine_full_text_search` 等)で差があり得るため、導入先で確認する(`packages/connector-redmine/README.md`)
- 検索 1 回につき Issue のヒットごとに Issue を取得する(ノートの閲覧の確認)。limit を大きくするとソースのレート制限に当たりやすい
- 実疎通の確認は作者の環境の 1 件のみ。リポジトリのテストはモックで行う

## 追補(2026-11-25): Redmine の OAuth2 による本番の経路(オーナー決定)

Redmine 6.1.6(公式の Docker イメージ `redmine:6.1`)を立て、OAuth2 プロバイダを実機で確かめた。結果に基づき、本番の経路を **Redmine の OAuth2 + `token_vault` / `esc`** とし、次を決めた(2026-11-25 オーナー決定)。

**実機での確認結果**(テスト用の利用者・非公開プロジェクト・ノート付きの Issue・OAuth アプリを入れて確認):

| 項目 | 結果 |
|---|---|
| プロバイダ | 本体に組み込み(Doorkeeper 5.8)。管理者がアプリを登録する。認可コード方式だけ(`grant_flows ['authorization_code']`) |
| PKCE | S256 で通る |
| アクセストークン | Bearer、2 時間(`expires_in: 7200`) |
| リフレッシュトークン | 発行される(`use_refresh_token`)。更新で新しい組が返る |
| 失効 | `/oauth/revoke`(RFC 7009)。失効したトークンは 401 |
| スコープ | Redmine の権限名。登録したアプリの範囲を超える要求は認可で拒否。閲覧スコープだけのトークンでの更新(PUT)は 403。`view_project` がないとプロジェクト一覧が空 |
| 端点のメタデータ | `/.well-known/oauth-authorization-server`・`openid-configuration` とも 404 |
| `/users/current.json` | `login` は返る。`mail` は本人が「メールアドレスを隠す」を外したときだけ返る(既定は隠す)。検証済みの印はない |
| Gateway 経由の通し(本追補の実装) | Token Vault で接続 → 検索・ノートの取得ができた。ログイン名の不一致は `identity_mismatch` で拒否し、得たトークンは Redmine で失効した。接続の解除で Redmine のトークンが失効した |

**決定:**

6. **Redmine コネクタは `oauth_bearer` も受ける。** `Authorization: Bearer` で送る(`api_key` は従来どおり `X-Redmine-API-Key`)。失効時刻の扱いは両方とも同じ(0 以下は不明)
7. **Gateway の OAuth プリセットに `redmine` を加える。** 自前で運用するインスタンスなので、端点は `endpoints.apiBaseUrl`(Redmine の基点 URL)から導く(`/oauth/authorize`・`/oauth/token`・`/oauth/revoke`)。`apiBaseUrl` は必須
8. **本人照合の属性に `username` を加え、redmine はこれだけを使う(ADR-022 決定 8 の具体化)。** 接続時に `/users/current.json` の `login` と IdP のログイン名(OIDC の `preferred_username`)を、大文字小文字を区別しない完全一致で比べる。メールアドレスは既定で隠され、利用者が変えられ、検証済みの印もないため使わない(redmine の `identityCheck: email` は起動時に拒否する)。ログイン名は管理者が決め、利用者は変えられない。`username` は redmine 以外では拒否する(他のソースはメールアドレスで照合できるため)。redmine の `identityCheck` の既定は `username`
   - `Identity` に `username`(個人情報。ログ・監査に出さない)を加え、Keycloak アダプタは `preferred_username` を、モック IdP は `username=` 属性を入れる。ブラウザのセッションと ESC のトークンにも `email` と同じく載せる
   - 前提は IdP の `preferred_username` と Redmine のログイン名がそろうこと(LDAP / SSO の同じ ID)。ドメイン付きの UPN とドメインなしのログイン名を寄せる変換は設けない(必要になったら別に決める)
   - 照合が意味を持つのは、ログイン名を利用者が選べない場合だけである(メールアドレスの照合と同じ性質)。Keycloak でユーザー名の編集・ブローカーの初回ログインでの選択を許さないこと、Redmine の自己登録を無効にする(またはログイン名を LDAP / SSO から作る)ことを導入の前提とし、docs/personal-auth.md に記す。コードでは検査できない
   - 比べるのは印字可能な ASCII(空白を除く)だけで、それ以外は不一致とする(Unicode の大文字小文字の畳み込みで別の名前が一致しないように)
   - ESC の接続では取引の本人の属性だけを使い、同じブラウザの別の利用者のセッションに寄せない(メールアドレスの照合も同じに改めた)
   - `preset: redmine` は `kind: redmine` のコネクタに限り、`endpoints.apiBaseUrl` はコネクタの `settings.baseUrl` と同じ Redmine(origin とパス。認証情報・クエリ・断片なし)でなければ起動時に拒否する(本人のトークンを OAuth を行った Redmine 以外へ送らないため)
9. **API キーの位置づけ。** 本番の経路が OAuth2 に決まったので、`api_key`(決定 1)は開発用の `mock_env` と、OAuth2 のない Redmine(6.1 未満)を試すためのものになる。6.1 未満を本番で扱う「接続ページでの API キー登録」は、必要になったときに別の ADR で決める

## 残る確認事項

- 本番の経路(決定 3)。いまの仕組み(ADR-022)の上での候補は次のとおり
  - **Redmine の OAuth2 プロバイダ + `token_vault` / `esc`**: 追補(2026-11-25)で採用した。残るのは、スコープの強制の不具合(Bug #44271: `add_issue_notes` を持つアプリで Issue の編集ができた報告)が 6.1 の各版で直っているかの確認。コネクタは書き込み系のスコープを求めないため影響は小さい
  - **接続ページでの API キーの登録(Redmine 6.1 未満向けの代替)**: 利用者が Gateway の接続ページに自分の API キーを入力し、Token Vault と同じ封筒暗号化で保管する。クライアントが毎回平文で提示するのではないので、ADR-022 決定 11 には当たらない。ただし、OAuth ではない接続を Token Vault に加える変更として新しい ADR が要る。論点は、期限のない全権限のキーを保管すること、Gateway からはソース側で失効させられないこと(利用者が Redmine でキーを再生成する。アカウントのロックでキーは無効になる)、接続時の本人照合
  - `esc` に API キーを封じる案、`token_exchange` は、Redmine が交換に対応しないこと、ローテーションの仕組み(ADR-022 決定 5)に乗らないことから候補にしない
- 本番の経路の実機確認は追補(2026-11-25)で行った(Docker の Redmine 6.1.6)。実運用の Redmine(LDAP / SSO 連携、リバースプロキシ配下)での確認と、Gateway 経由のトークンの更新(2 時間の失効後)の通しは未確認
- ESC での通しは未確認(OAuth の前提は Token Vault と同じで、リフレッシュトークンがあるため成り立つ見込み)
