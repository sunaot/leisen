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
- `describe`: 上位 project のみ表示。検索層 ingest、書き込み操作、添付ファイル取得はありません。

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
