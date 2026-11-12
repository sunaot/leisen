# `@leisen/connector-redmine`

Redmine REST API 用の読み取り専用プロトタイプです。検索は `/search.json` を使い、Issue、Issue のノート、Wiki ページを返します。文書の内容は検索結果から別途 fetch し、同じ利用者 API キーで閲覧権限を確認します。

## 認証

各 MCP リクエストの `AuthContext` に `credential.kind: "api_key"` が必要です。キーは `X-Redmine-API-Key` ヘッダーでだけ送信します。API キーを URL・connector settings・ログへ出しません。API リダイレクトは追従しません。

開発環境では Gateway の `mock_env` provider を `credentialKind: api_key` に設定し、`LEISEN_MOCK_TOKEN_<SOURCEID>__<USERID>` で利用者ごとにキーを与えます。共有の `LEISEN_MOCK_TOKEN_<SOURCEID>` は開発用の簡易 fallback です。本番環境では mock provider を使えません。Token Vault / API キー登録 UX は未実装です。

## 機能と制限

- `search`: `/search.json` の Issue / Wiki 結果と、`redmine_full_text_search` が返す `issue-note` に対応します。ノートは親 Issue の journals に含まれる場合に返します。検索フィルタは未対応です。
- `fetch`: `issue:<id>`、`issue-note:<issueId>:<noteId>` または `wiki:<project>/<page>` の本文。最大 100,000 文字。ノートの出典は `#change-<noteId>` にリンクし、プロジェクト、Issue、ノートの公開状態を `scope` に反映します。
- `list`: 利用者が見られる project 一覧。project が公開かどうかと Issue の `is_private` を `scope` に反映し、Gateway の既定 `privateScopes: excluded` で非公開 project / Issue を除外します。
- `describe`: 上位 project のみ表示。検索層 ingest、書き込み操作、添付ファイル取得はありません。

Wiki REST API は Redmine 2.2 以降の機能ですが、検索結果形式・公開状態フィールドはインスタンスのバージョンやプラグインにより差があり得ます。最初は実環境で挙動を確認してください。

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
