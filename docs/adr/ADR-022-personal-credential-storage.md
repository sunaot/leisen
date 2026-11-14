# ADR-022: 本人資格情報の置き場所と Token Store の方式

Status: Accepted(2026-11-14 オーナー決定。確認事項 1〜4 に回答)/ Date: 2026-10-20 / 改訂: 2026-11-14

## 文脈

ADR-010 は、本人ごとの OAuth(方式 A: Google Drive / Slack / GitHub / Confluence / Notion)が主経路であると確定し、更新トークンの暗号化保管・ローテーション・失効を担う Token Vault を中核部品とした。T-004 はその実装(KMS 連携、deprovisioning 連動)を内容とする。これに対し、「サーバー側で持たず、もっとローカル(ブラウザの localStorage など)に寄せられないか」という指摘があった。運用者が全利用者分の更新トークンを預かる状態を避けたい、という動機である。

2026-10-14 から 10-20 にかけて、この問いを検討した(検討メモ「個人の認可の実現方式」「資格情報の置き場所」「個人認可の方式比較」。docs/notes/)。本 ADR はその結論を記録し、人間の判断が要る点を確認事項として挙げる。

### 問題の構造

資格情報の置き場所が難しいのは、次の性質による。

- **bearer token は所持が権限である。** 提示した者が誰であれ、トークンが有効ならソースは応じる。問題は「秘密の複製をどこに何個置くか」になる
- **使用点では必ず平文になる。** どこに保管しても、ソース API を呼ぶ瞬間には平文を扱う。暗号化が守るのは保存先と鍵の窃取であり、使用点の乗っ取り(XSS、マルウェア、サーバー侵入)には効かない。Leisen の使用点は不変条件 2 により Gateway である
- **ブラウザの信頼単位はオリジンである。** 同じオリジンで動く JavaScript はすべて同じ主体で、localStorage は XSS から守れない(RFC 10017 / BCP 212 §8.5。同 §6.3 は業務アプリにブラウザ内完結の構成を推奨しない)
- **複製に対する失効は到達を保証できない。** 発行元が拒むことでしか失効できず、ソースへ失効を依頼するにはトークンを手元に持つ必要がある。能動的な一括失効の能力は、秘密を中央で持つことと表裏一体である
- **秘密を使用点以外に置くと、使うたびに運ぶ。** 参照構成の経路(ブラウザ → LibreChat → Orchestrator → Gateway、または MCP クライアント → Orchestrator → Gateway)には中継者がおり、平文を運べば中継者に見える。MCP の認可仕様はクライアントのトークンを上流へそのまま渡すこと(passthrough)を禁じている

これらから、Leisen で取りうる形は「Gateway が保管する」「保管しない(IdP トークンから都度交換)」「クライアントが保持して毎回提示する」の 3 つに限られ、最後の形は提示するものが平文か暗号文かで分かれる。

### 比較した方式

| 方式 | 仕組み | 長命の秘密の置き場所 |
|---|---|---|
| Token Vault(V1) | Gateway が接続ページで OAuth を行い、更新トークンを KMS で封筒暗号化して保管する。呼び出しのたびに取り出し、更新を直列化し、本人の解除と IdP の利用停止でソースへ失効を依頼する | Gateway |
| IdP トークン方式(方式 B) | 保管しない。要求に添えられた本人の IdP トークンを、呼び出しのたびにソースの短命トークンへ交換する(Entra ID の On-Behalf-Of。策定中の ID-JAG / Cross-App Access) | なし |
| キーチェーンと MCP クライアント方式 | Gateway は保管せず、更新トークンを MCP クライアントに渡す。クライアントが端末の OS 保護領域(または改造 UI のブラウザ)に保持し、呼び出しのたびに平文で提示する | 端末(平文) |
| ESC 方式(encrypted self-contained credential) | 同じくクライアントが保持するが、Gateway が自分の鍵で暗号化した自己完結型の暗号文(JWE。本人の `sub` と sourceId を付加データで結び付ける)を提示する。Gateway だけが復号でき、本人の IdP トークンがなければ受け付けない。Gateway は鍵と拒否リストだけを持つ。先例は認可サーバーの自己完結型トークン(RFC 6819 §3.1)、暗号化した Cookie セッション、Kubernetes の Sealed Secrets | 端末(暗号文) |

ESC 方式を標準の MCP クライアントと LibreChat で動かすには、Gateway を MCP の認可サーバー(RFC 9728 / 8414、認可・トークン・失効エンドポイント)にし、発行するアクセストークンそのものを ESC にする必要がある。ADR-018 決定 8 はこれを避けて IdP トークンの直接転送を選んでいる。

### 評価の要点

要件(不変条件 1 / 2 / 4 / 6 / 7 / 8、ADR-010 決定 2・3、ADR-018、docs/direct-connection.md §2、threat-model TM-C4)に対する評価の要点は次のとおり。詳細は検討メモ「個人認可の方式比較」表3。

- **IdP トークン方式は、成立するソースでは最善。** 長命の秘密がどこにもなく、同意の操作もなく、失効は IdP に追随する。現時点で確実なのは Microsoft 365 のみ。ID-JAG の対応ソースが増えれば移すべきソースが増える
- **Token Vault は要件を最も広く満たす。** 弱点は運用者が全員分の秘密を預かること(Gateway と鍵が揃えば全件)だけで、素の LibreChat を含むすべてのクライアントで動く唯一の方式
- **キーチェーン方式(平文提示)は 3 つの要件を同時に落とす。** 端末・中継者のどちらからも長命の秘密が取れる(盗難耐性)、本人が平文を取り出してソースを直接呼べるため docs/direct-connection.md §2 の許可リストの前提(Leisen のアプリを利用者が流用できない)が崩れる(直接接続の統制)、平文が中継者に見える(中継者の信頼)。前 2 つは中継者を信頼する判断では解消しない
- **ESC 方式は Token Vault と同じ統制を保ちながら保管庫を持たない。** 代償は次のとおり
  - 標準の OAuth ではトークンの中身は不変で、クライアントは `refresh_token` グラントでしか新しいトークンを受け取らない。Gateway が呼び出しの途中で更新したソースのトークンは、`401 invalid_token` で引かせて次の `refresh_token` グラントで渡すことになり、更新トークンがローテーションするソース(GitHub)ではその差分を数分保留する状態が戻る
  - 新しいソースの接続が OAuth のやり直し(再接続)になり、「質問の中で接続して同じ質問を再実行する」導線(ADR-010 決定 3 の具体化)が標準クライアントでは成り立たない。自前 UI なら UI 側で導線を作れる
  - 認可サーバーという大きな攻撃面を自前で持ち(Keycloak と二重になる)、MCP クライアントが持つトークンが IdP 発行から Gateway 発行に入れ替わるため、ADR-010 追補の検証契約・`auth-check`・LibreChat の設定・リファレンス構成の realm が一通り変わる。MCP の認可仕様はまだ動いている(ADR-001 追補 3)
  - 鍵の漏えい時は配布済みの全 ESC(中継者のログや DB に残ったものを含む)が平文になり、鍵を替えると全員が再同意する。V1 は鍵を替えて保管庫を再暗号化すれば利用者に見えない
  - IdP での利用停止時に Gateway がソースへ失効を依頼できず(ソース側の経路に委ねる)、接続状態が中央にない
  - 得るものは「Gateway の DB に利用者の資格情報が存在しない」ことに絞られる。運用者が復号できること、使用点で平文を扱うことは V1 と同じ

Orchestrator の経由について、「ESC は中継者に無意味だから渡してよい」「Orchestrator と Gateway は一つの認可ドメイン」のどちらの解釈も、中継者の侵入単独に対してはリスクを拡大しないが、仕様適合の根拠としては弱く、鍵の漏えいと組み合わさる事象では中継者に残った暗号文の分だけ拡大する。正攻法は Orchestrator がクライアントのトークンと `LEISEN_ORCHESTRATOR_CREDENTIAL`(ADR-019)で Gateway 宛ての短命トークンに交換する(RFC 8693)ことで、この場合 ADR-018 決定 8 の再確認事項は「直接転送をやめる」形で決着する。

## 決定(2026-11-14 オーナー決定)

確認事項 1〜4 への回答(2026-11-14、オーナー):

- 確認事項 1: **Gateway を MCP の認可サーバーにする**(認可サーバー化まで実装する)
- 確認事項 2: 「本人の資格情報をサーバーに永続化しない」を**導入先が選べる方式**として扱う。ESC 方式を PoC に留めず、Token Vault・IdP トークン方式と並ぶ選択肢として実装する
- 確認事項 3: **Token Store は Auth Adapter の内側に収める**(ADR-005 の 4 つ目の境界にはしない)。評価の記録は docs/notes/2026-11-14-token-store-boundary.html
- 確認事項 4: **ソース側の失効経路を一次とし、Gateway の失効依頼・拒否は追加の防御とする**

以下、この回答に基づく決定を記す。決定(案)の 1〜8 はここに統合した。

1. **本人資格情報の取得方式はソースごとに選ぶ。** `connectors[].auth.provider` に次の 3 方式を置く(開発用の `mock_env` は従来どおり)
   - `token_exchange`(IdP トークン方式、ADR-010 の方式 B): 要求の本人の IdP トークンを、呼び出しのたびにソースのトークンへ交換する。保管しない。`exchange.kind` は `entra_obo`(Entra ID On-Behalf-Of)と `rfc8693`(汎用の RFC 8693 token exchange。Keycloak 等)
   - `token_vault`(Token Vault、方式 A): Gateway の接続ページで OAuth を行い、更新トークンを封筒暗号化して保管する。呼び出しのたびに取り出し、期限切れならソースの更新を直列化して行う
   - `esc`(ESC 方式、方式 A の別の保管先): Gateway が自分の鍵で暗号化した自己完結型の暗号文(JWE)をクライアントが保持し、毎回提示する。Gateway は鍵と拒否リストだけを持つ
   方式の可否は起動時に検査する。`esc` は認可サーバーの有効化(決定 4)を要し、`token_vault` と `esc` は `gateway.publicBaseUrl` と資格情報の状態 DB(決定 3)を要する
2. **Token Store は Auth Adapter(`CredentialProvider`)の内側に置く(評価メモの A')。** Token Vault のロジック(封筒暗号化、更新の直列化、失効の連動)はコアの 1 実装に固定する。deployment.yaml の enum で選べるのは、その下の 2 層、`KeyProvider`(鍵の包み・解き = KMS)と `CredentialStore`(暗号文と拒否リストの保管先。暗号文しか見ない)だけとする。`module` による外部実装の読み込みは設けず、平文の更新トークンに触れるコードはリポジトリ内のものに限る。保管とソースへの失効依頼は別の層に分ける(保管層はソースの API を知らない)。B(4 つ目の境界)へ移るのは、組み込みの追加で吸収できない差分が出たときに限り、その場合も開くのは `CredentialStore` だけとする(不変条件 8・9)
3. **鍵管理と保管先。** `KeyProvider` は `local`(環境変数のマスター鍵。入れ替え用の旧鍵を受ける)、`aws_kms`(AWS KMS の REST を SigV4 で直接呼ぶ。SDK 依存なし)、`gcp_kms`(Cloud KMS の REST。メタデータサーバーまたはサービスアカウント鍵のファイルでアクセストークンを得る)。データ鍵は資格情報 1 件ごとに生成して AES-256-GCM で暗号化し、付加データに userId・sourceId を結び付ける。保管先は SQLite(`node:sqlite`。Node は 22.13 以上)の 1 ファイルで、Token Vault の行と、ESC・認可サーバーの拒否リスト・使用済みの記録(資格情報を含まない)を置く。KMS への到達のためのサービスアカウントは基盤の資格情報で、ソースへのアクセスには使わない(不変条件 1 の対象外)
4. **Gateway を MCP の認可サーバーにする(`gateway.authorizationServer`)。** 有効にすると次を公開する
   - RFC 9728 の保護リソースメタデータ(`/.well-known/oauth-protected-resource`)と RFC 8414 の認可サーバーメタデータ(`/.well-known/oauth-authorization-server`)。401 応答の `WWW-Authenticate` に `resource_metadata` を付ける
   - `/authorize`(認可コード + PKCE S256 必須、RFC 8707 の `resource` で Gateway / Orchestrator のどちらに向けたトークンかを決める)。利用者のログインは IdP に委ね(Gateway が IdP の OIDC クライアントになる)、続く同意画面で `esc` のソースを接続する
   - `/token`(`authorization_code`、`refresh_token`、RFC 8693 の `token-exchange`。最後は Orchestrator の資格情報を持つ呼び出し元だけ)と `/revoke`(RFC 7009)
   - クライアントは deployment.yaml の事前登録(`clients`)を既定とする。RFC 7591 の動的登録は `allowDynamicRegistration: true` のときだけ受け、登録内容を Gateway の鍵で封じた client_id として返す(登録の保管庫を持たない)。リダイレクト先は https またはループバックに限る
   - 発行するアクセストークンは ESC の束(本人の `sub`、受け手、有効期限、本人の IdP トークン、`esc` のソースのトークン)を JWE(`dir` + `A256GCM`)で封じたもので、Gateway だけが開ける。リフレッシュトークンも同じ形式で、IdP の更新トークンと `esc` のソースの更新トークンを含む
   - 認可サーバーを有効にした構成で IdP のトークンを直接受けるのは `acceptIdpTokens: true` のときだけとする(移行期間・開発用。既定 false)
5. **ESC のローテーションは `refresh_token` グラントでだけ行う。** アクセストークンの有効期限を「設定値」「IdP のアクセストークンの期限」「含まれるソースのアクセストークンの期限」の最小にする。呼び出しの途中でソースのトークンを更新する必要がなくなるため、決定(案)の検討で懸念した「ローテーションの差分を数分保留する状態」を持たない。ソースの更新はすべて `/token` の中で行い、新しいソースの更新トークンは新しいリフレッシュトークンに入れて返す。Gateway のリフレッシュトークンも使うたびに入れ替え、使用済みの再提示を検知したら、そのログイン(sid)の系列全体を拒否リストに入れる(OAuth 2.1 の再利用検知)。応答の消失でソースの更新トークンが失われた場合は、そのソースだけ再接続になる(docs/install.md に記す)
6. **失効の責任分担(確認事項 4)。** ソース側の経路(SCIM・アカウント無効化・CAE)を一次とし、導入チェックリストの前提とする。Gateway は追加の防御として次を行う
   - IdP での利用停止の通知(`POST /admin/deprovision`。運用者の資格情報 `LEISEN_ADMIN_CREDENTIAL` が要る。CLI は `leisen-gateway revoke-user`)を受けて、Token Vault の当該利用者の全トークンをソースへ失効依頼して削除し、ESC は `sub` 単位で「この時刻より前に発行したものを拒否」を拒否リストに入れ、資格情報のキャッシュを捨てる
   - 本人の解除: Token Vault はソースへ失効依頼して削除する。ESC は (sub, sourceId) 単位の拒否を入れ、提示されたトークンに含まれる分はソースへ失効依頼する
   - ESC はソースへの能動的な失効依頼を IdP 起点では行えない(トークンを持たない)。この限界を docs/install.md に記す
7. **接続の体験。** Token Vault のソースは Gateway の接続ページ(`/connections`)で接続する。どのクライアントからも同じ導線で、未接続のソースは `source_not_connected` に接続ページの URL を添えて案内する。ESC のソースは `/authorize` の同意画面で接続し、後から加えるときは再認可(MCP の step-up。`insufficient_scope` と `scope="source:<id>"`)になる。接続ページの OAuth クライアントはシークレットを Gateway に持ちリダイレクト先を固定した機密クライアントとし、利用者が流用できないことでソース側のアプリ許可リストを成り立たせる。Token Vault のトークンをクライアントへ返す API は作らない。接続後の同じ質問の自動再実行は Orchestrator / UI の責務とする(本 ADR の実装範囲外)
8. **接続時に本人照合を行う。** ソース側のアカウントのメールアドレス(検証済みのもの)と IdP のメールアドレスが一致しない接続を拒否する(私用アカウント等の誤接続)。照合できないソースは `identityCheck: none` と `confirmIdentityCheckDisabled: true` の明示が要る(起動時に WARNING)。OAuth 要求は PKCE と、ブラウザのログインセッションに結び付けた `state` を使う。Slack の `authed_user.id` 等の Slack 由来の識別子は照合に使ったのち捨て、保管しない(不変条件 7)
9. **接続・解除・失効を監査の事象として記録する。** 監査レコードに `credential_event`(事象: `connect_started` / `connected` / `connect_failed` / `disconnected` / `revoked` / `deprovisioned` / `refresh_failed` / `token_issued` / `token_refreshed` / `token_reuse_detected`、userId、sourceId、方式、理由コード)を加える(ADR-011 の 2 層モデルの外の、run に属さない事象)。トークンの値・ソース側のアカウント識別子は含めない。不変条件 2 の「全ツール呼び出し」に資格情報の事象を含めて読む
10. **Orchestrator は受けたトークンを交換してから Gateway を呼ぶ。** 認可サーバーを有効にした構成では、LibreChat・MCP クライアントは Orchestrator を受け手(`resource`)とするトークンを Gateway から得る。Orchestrator はそれを Gateway の `/token` で RFC 8693 により Gateway 宛ての短命トークンへ交換し(`LEISEN_ORCHESTRATOR_CREDENTIAL` でクライアント認証)、交換後のトークンで Gateway を呼ぶ。ADR-018 決定 8(IdP トークンの直接転送)は、認可サーバーを有効にした構成ではこの交換に置き換わり、無効の構成では従来どおり残る
11. **キーチェーンと MCP クライアント方式(平文提示)は採らない**(決定(案)4 のまま)

## 帰結

- T-004 の内容と受け入れ条件に、3 方式、Token Store の IF、鍵管理、接続ページ、本人照合、接続事象の監査、認可サーバー、Slack の識別子を保管しないことのテストが加わる
- ADR-010 決定 3(初回同意 UX)は決定 7 で具体化される。ADR-018 決定 8 の再確認事項は、認可サーバーを有効にした構成について決定 10 で決着する
- docs/direct-connection.md §2 の前提(Leisen のアプリを利用者が流用できない)は決定 7・11 で保たれる
- docs/install.md のチェックリストに、ソース側の失効経路(GitHub の SCIM 連携等)を前提として残す。ESC を選んだソースではこれが IdP 起点の唯一の経路になる
- 認可サーバーという攻撃面を Gateway が持つ。Keycloak と Gateway の 2 つがトークンを発行し、MCP クライアントが持つトークンは IdP 発行から Gateway 発行に変わる(認可サーバーを有効にした構成のみ)。MCP の認可仕様の改訂(ADR-001 追補 3)に追随する保守が要る
- ESC の鍵が漏れると、配布済みの全 ESC(中継者のログや DB に残ったものを含む)が開ける。鍵の入れ替えは旧鍵を並べて段階的に行い、旧鍵を外した時点で利用者は再ログインになる
- 本 ADR は不変条件 2 を緩める案(端末常駐エージェントがソースを直接呼ぶ)を扱わない

## 残る確認事項

- 動的登録(RFC 7591)を有効にした構成で、登録の数・頻度を制限するか(現状は登録を保管しないため上限なし。リダイレクト先の制限だけ)
- MCP の Client ID Metadata Documents(クライアント ID を URL にする方式)への対応時期
- 接続後の同じ質問の自動再実行(決定 7)を Orchestrator のどの段で行うか

## 参照

- 検討メモ(docs/notes/): 「個人の認可の実現方式」(2026-10-14-personal-auth-study.html)、「資格情報の置き場所」(2026-10-15-credential-locality.html)、「個人認可の方式比較」(2026-10-19-auth-methods-comparison.html、10-20 改訂)
- ADR-005 / ADR-010(追補を含む)/ ADR-012 / ADR-013 / ADR-014 / ADR-018 / ADR-019、docs/auth-matrix.md §12、docs/direct-connection.md、docs/threat-model.md §7、docs/backlog/T-004
- RFC 10017 / BCP 212(OAuth 2.0 for Browser-Based Applications、2026-08)、RFC 6819 §3.1、RFC 8693、RFC 9728 / 8414、draft-ietf-oauth-identity-assertion-authz-grant-04(2026-05)、MCP Authorization / Security Best Practices(token passthrough の禁止)
