# T-002: IdP Adapter IFとモック実装(旧TokenBroker、T-011を統合)

## 目的
ADR-010のソース別認可方式を吸収するプラグイン境界を最初から確定し、実接続(T-004、人手待ち)をブロックせずに他タスクを進める。

## 内容
- `IdpAdapter` IF: authenticate(セッション検証), getCredential(userId, source)。token exchange / 個別OAuth / delegated_identity の方式差を吸収する
- Token Vault IF(暗号化保管・ローテーション・失効)の骨格定義(実装はT-004)
- モック実装(開発用固定資格情報、環境変数注入)と実装切替のfactory
- 資格情報キャッシュ(ユーザー×ソース、TTL付き、single-flight)。**キャッシュキーにuserIdを必ず含める(不変条件4)**
- Keycloak参照実装とdocker-compose統合(旧T-011)。**注意: このE2Eは「Keycloak発行トークンを受けるモックコネクタ」であり、Drive/Slackの実認可経路は検証しない。この限界をREADMEに明記する**

## 受け入れ条件
- [ ] IFがADR-010の方式差(token exchange / 個別OAuth / delegated_identity)を吸収できる形になっている
- [ ] キャッシュのTTL失効・single-flight・ユーザー分離がテストされている
- [ ] モック資格情報が本番ビルドで無効化される仕組みがある
- [ ] Keycloak起動→資格情報取得→モックコネクタ呼び出しのE2EがCIで通り、検証範囲の限界がREADMEに明記されている
- [ ] アダプタ開発ガイド(docs)のドラフトがある
