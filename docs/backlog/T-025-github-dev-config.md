# T-025: 自分の GitHub で試す開発用設定

## 依存
T-019(GitHub コネクタ。モックテスト済み)、T-010(Deployment Profile)、T-007(kp-ask)

## 前提(人手)
- 手元で試す人の GitHub アカウントの fine-grained PAT(開発専用。読み取りだけ・対象リポジトリを絞る)。GitHub App の承認(T-019)は要らない
- 権限境界の確認まで行う場合は、権限の異なる 2 つ目のアカウントとその PAT

## 背景
手元で動くのは合成コーパス(`dev-fixture`)だけで、実データを本人の権限で検索する体験はまだない。GitHub コネクタは実装・モックテスト済みで、開発経路(`auth.provider: mock_env`、`MockCredentialProvider`)なら本人の PAT で Gateway 経由の search / fetch / list / describe ができる(`packages/connector-github/README.md`「ローカル開発」「deployment.yaml での使い方」)。ただし、そのための設定ファイルと手順がまとまっておらず、すぐには試せない。本番の資格情報(GitHub App の user access token と Token Vault)は T-004 / T-019 の範囲で、このタスクでは扱わない。

## 内容
- **`examples/deployment.dev-github.yaml`**: `examples/deployment.dev.yaml`(モック IdP・`mock_env`・合成コーパス)に GitHub コネクタ(`kind: github`、`id: github`、`auth.provider: mock_env`)を足した開発用設定。秘密情報は書かず、トークンは環境変数 `KP_MOCK_TOKEN_GITHUB`(利用者別は `KP_MOCK_TOKEN_GITHUB__<USERID>`)で渡す。`limits.timeoutMs` と `settings.timeoutMs` の関係、プライベート領域の方針(`privateScopes`、ADR-016 追補2)は README の推奨に合わせる
- **README の手順「自分の GitHub で試す」**(リポジトリ直下の README の「手元で動かす」の続き、または `packages/connector-github/README.md`)
  - PAT の作り方(fine-grained、対象リポジトリを絞る、読み取り権限だけ: Contents / Issues / Pull requests / Metadata、短い有効期限)
  - 渡し方(環境変数だけ。シェル履歴に残さない入力方法、ファイル・ログに書かない。不変条件6)
  - 起動と確認(`kp-gateway validate` → `serve` → curl の search / fetch → kp-ask での質問)
  - 注意
    - PAT は開発経路だけで使い、本番は GitHub App の user access token(ADR-010 方式A)
    - `KP_MOCK_TOKEN_GITHUB` だけだと全モック利用者が同じ権限を共有し、権限境界の確認にならない
    - 個人リポジトリの結果がプライベート領域として扱われる場合の見え方(README の「判定できるか確かめた結果」)
    - レート制限(コード検索 10 req/min)
    - `NODE_ENV=production` では起動を拒否される
- **テスト**: `examples/deployment.dev-github.yaml` が設定検証とコネクタの組み立てを通ることを、ネットワークに出ずに確かめる(既存の `deployment.dev.yaml` のテストと同じ方式)

## 受け入れ条件
- [ ] `examples/deployment.dev-github.yaml` があり、トークン未設定でも `kp-gateway validate` が通る(または未設定を固定文言で知らせる)ことがテストされている
- [ ] 同じ設定が `NODE_ENV=production` では `dev_only_in_production` で拒否されることがテストされている
- [ ] 設定ファイル・README・テストフィクスチャにトークンの値が含まれていない(guard hook の検査が通る)
- [ ] README の手順に沿って、PAT の作成から kp-ask で自分のリポジトリについて質問するところまで、迷わず進められる
- [ ] (人手)オーナーが自分の PAT で search / fetch / kp-ask を通した結果を記録している。記録するのは成否・件数・所要時間だけで、リポジトリの内容は記録しない

## 判断が必要な点
- **手順の置き場所**: リポジトリ直下の README(入口として見つけやすい)か、`packages/connector-github/README.md`(コネクタの詳細とまとまる)か
- **dev-eval を実データに向けるか**: このタスクでは扱わない。dev-eval の表は引用した文書 ID をそのまま出し、AnswerRun の分類を通らないため、実データ向けの評価は T-008 で扱う

## 限界
- 本人の PAT で試すのは開発経路で、本番の資格情報の流れ(GitHub App の認可・Token Vault・失効)の確認にはならない(T-004 / T-019)
- 1 アカウントだけで試す場合、権限境界(他人の private リポジトリが見えないこと)は確認できない(threat-model §5.2 のカナリア検証は T-019 の残作業)
