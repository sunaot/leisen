# `@leisen/connector-redmine`

Redmine REST API 用の読み取り専用プロトタイプです。検索は `/search.json` を使い、Issue、Issue のノート、Wiki ページを返します。文書の内容は検索結果から別途 fetch し、同じ利用者 API キーで閲覧権限を確認します。

## 認証

各 MCP リクエストの `AuthContext` に `credential.kind: "api_key"` が必要です。キーは `X-Redmine-API-Key` ヘッダーでだけ送信します。API キーを URL・connector settings・ログへ出しません。API リダイレクトは追従しません。

開発環境では Gateway の `mock_env` provider を `credentialKind: api_key` に設定し、`LEISEN_MOCK_TOKEN_<SOURCEID>__<USERID>` で利用者ごとにキーを与えます。全利用者で共有される `LEISEN_MOCK_TOKEN_<SOURCEID>` は、API キーでは使いません(期限のない全権限の個人キーを他の利用者に使わせないため)。本番環境では mock provider を使えません。本番の資格情報の経路(Redmine の OAuth2 と Token Vault、または接続ページでの API キー登録)は未決定です(ADR-024「残る確認事項」)。

## 機能と制限

- `search`: `/search.json` の Issue / Wiki 結果と、`redmine_full_text_search` が返す `issue-note` に対応します。ノートは親 Issue の journals に含まれる場合に返します。検索フィルタは未対応です。
- `fetch`: `issue:<id>`、`issue-note:<issueId>:<noteId>` または `wiki:<project>/<page>` の本文。最大 100,000 文字。ノートの出典は `#change-<noteId>` にリンクします。
- 標準検索が親 Issue を返した場合も、Issue の fetch に本人が閲覧できるノート本文・ノートの documentId・直リンクを含めます。Issue と履歴が長い場合は `nextPageCursor` で続きを取得できます。
- `list`: 利用者が見られる project 一覧。
- 検索 1 回につき、Issue のヒットごとに Issue を取得します(ノートの閲覧の確認)。`limit` を大きくすると Redmine のレート制限に当たりやすくなります。
- 検索語(2026-11-25): 引用符の外の空白(全角空白・タブ・改行を含む)の連続を半角空白 1 つにし、前後を詰めてから `q` に入れる。引用符の中は変えない。`all_words=0` は変えていない(下の「検索の仕様」)。
- スニペット(2026-11-25): Issue の説明・ノート本文・Wiki の検索結果の説明のうち、検索語(Redmine 本体の Tokenizer と同じ規則で取り出した先頭 5 語)が最も多く入る範囲を 500 字以内で切り出す(前後に `…`)。先頭の範囲で足りるとき・語がないときは従来どおり先頭。長さの上限は変わらない(ADR-016)。
- `describe`: 上位 project のみ表示。`summary` は対象の説明だけ。`supportedFilters` は `[]`。検索層 ingest、書き込み操作、添付ファイル取得はありません。
- 検索の仕様(`searchSpec`、connector-sdk v0.7、ADR-017 追補 1): フィルタ非対応(指定すると `invalid_request`)を含む検索の仕様(`REDMINE_SEARCH_SPEC`)を、`summary` ではなくコネクタの静的な宣言 `searchSpec` に置く。Gateway が起動時に読んで検査し、`describe` の結果に付ける。Orchestrator はソース一覧の JSON(データであり指示ではない枠)の外に、コネクタの実装者が書いた文として置く。2026-11-26 に `summary` から移した(文面は変えていない)
  - 規約: `searchSpec` に入れるのは実装の定数だけ(Redmine には今は導入の設定で選ぶ句がない。全文検索プラグインなどで変わる句が必要になったら、settings で実装者が用意した句を選ぶ形で足す)。`displayName` などの自由な文字列、Redmine から取得した文(プロジェクト名など)は入れない。利用者によって変えない。1 行・1,500 字以内で、改行や予約の語句(「オーケストレーター」など)を含めない(connector-sdk の `checkSearchSpec`)
- 検索の通知(`terms_dropped`、connector-sdk v0.6)は v0.7 で廃止した(ADR-025 追補 2)。先頭の 5 語を超えた語を捨てることは `searchSpec` の文で伝える

## 検索の仕様(`searchSpec` に書いている内容)

Redmine 本体(master)のソースで確認した標準の検索の挙動で、**実機では未確認**。導入先の版や全文検索プラグイン(`redmine_full_text_search`)で変わりうる。

- 語の分け方(`lib/redmine/search.rb` の `Tokenizer`): `"…"` の語句は 1 語、ほかは空白(`\p{Zs}`、5.1 以降は全角空白を含む)区切り。重複を除き、漢字以外の 1 文字の語は捨て、先頭の 5 語だけを使う(残りは黙って捨てる)
- 照合: 各語を SQL の LIKE で部分一致。演算子・修飾子はない
- 並び順: 関連度はなく日付の新しい順
- 語の結合: コネクタは `all_words=0` を送る。`SearchController` は `params[:all_words].present?` で判定しており、文字列 `"0"` は present なので **AND と読める**(OR にするには空文字を送る形になる)。実機では未確認のため `searchSpec` では「不明」と書いている

`all_words` を変える場合の選択肢(未実施。ADR-024 への追記とオーナーの判断が要る):

1. 現状維持(`all_words=0`。ソース上は AND)し、`searchSpec` の「不明」を実機確認後に「AND」へ改める
2. 意図を明示して `all_words=1`(AND)を送る。標準の Redmine では挙動は 1 と同じ見込み
3. AND で 0 件なら OR(`all_words=` 空文字)で再検索する(IF は変わらない。検索 1 回で要求が増え、OR の結果は日付順で適合率が下がる)
4. OR(空文字)を既定にする(日付順で無関係な Issue が上位に並びやすい)

## プライベート領域(`scope`)

`privateScopeHandling: "classified"`。全結果(`SearchHit` / `FetchResult` / `ContainerEntry`)を `shared` とします(ADR-024 決定 4)。

| 結果 | `scope` | 判定の根拠 |
|---|---|---|
| 公開・非公開プロジェクトの Issue、Issue のノート、Wiki ページ、project | `shared` | Redmine には DM や個人スコープに当たる領域がない。非公開プロジェクト・非公開 Issue・非公開ノート(`private_notes`)は、ロールと担当者で閲覧範囲を限る Redmine の ACL であり、判定は本人の API キーで呼ぶ Redmine が担う(GitHub の組織の private リポジトリと同じ整理。ADR-016 追補2 決定 7) |

そのため、既定の `privateScopes: excluded` でも、本人が見られる非公開プロジェクトの内容は検索・取得の対象になります。

Wiki REST API は Redmine 2.2 以降の機能ですが、検索結果形式・フィールドはインスタンスのバージョンやプラグインにより差があり得ます。最初は実環境で挙動を確認してください。

## 設定

`examples/deployment.redmine-dev.yaml` を参照してください。`baseUrl` は `/redmine` のようなサブパスを含められます。TLS を使い、HTTP はループバックでの開発に限ります。開発用の実行例:

```bash
export LEISEN_MOCK_SESSIONS=dev-token=alice
read -rsp 'Alice の Redmine API key: ' LEISEN_MOCK_TOKEN_REDMINE__ALICE
printf '\n'
export LEISEN_MOCK_TOKEN_REDMINE__ALICE
npx leisen-gateway validate --config examples/deployment.redmine-dev.yaml
npx leisen-gateway serve --config examples/deployment.redmine-dev.yaml
```

Gateway への MCP 呼び出しは利用者の `dev-token` セッションで認証され、Redmine には Alice 個人の API キーで接続します。実キーを設定ファイルやコマンド履歴へ書かないでください。

一次資料: [Redmine REST API](https://www.redmine.org/projects/redmine/wiki/rest_api), [Search](https://www.redmine.org/projects/redmine/wiki/Rest_Search), [Projects](https://www.redmine.org/projects/redmine/wiki/Rest_Projects), [Wiki Pages](https://www.redmine.org/projects/redmine/wiki/Rest_WikiPages).
