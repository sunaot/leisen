# ADR-016: コネクタIF v0.3 — レビュー指摘に基づく最小拡張

Status: Accepted / Date: 2026-07-05

## 文脈
実装前レビューにより、Phase 1の消費者(T-005/006/007)が実際に必要とする不足と、セキュリティ上の規約不足が特定された。ADR-007と同じ経済性基準(消費者が生まれる直前が変更コスト最安)で最小拡張を行う。

## 採用した変更(v0.2→v0.3)
1. **search options**: `SearchOptions { cursor?, limit? }`。Orchestratorの結果件数制御とページングを1引数に集約
2. **list のページング**: 戻り値を `ListResult { entries, nextCursor? }` に変更。Driveフォルダ数千件・Slackチャンネル一覧はページング必須
3. **snippet長の規約**: `MAX_SNIPPET_CHARS`(既定500)をSDK定数として輸出し、Gatewayが強制truncateする。型コメントだけでは本文流入を防げない
4. **redaction標準化**: `redactAuthContext()` を追加。AuthContext/Credentialの直接シリアライズを禁止し(CLAUDE.md不変条件6)、fitting testでトークン非流出を検証

## 却下・保留した変更(fitting検証待ち)
- fetchのanchor指定 — pageCursorへの符号化で表現可能(ADR-007の複合ID方式と同型)
- FetchResultのmimeType — metaで表現可能
- エラークラス追加(quota_exceeded等)— 消費者不在
- `authzCheck` capability(ADR-012)、`contentPersistence` capability(ADR-014)— 必要性は認識済みだが、semanticsは検索層/Slackコネクタの実装時にfitting検証を通して確定する

## 追補1(2026-07-05): SearchResult.totalCount の削除
レビュー指摘により、`SearchResult.totalCount` を削除した。ネイティブ検索の総件数であっても、Phase 2で検索層が内部実装に入った際にpost-filtering前候補数が混入すると、返却hitとの差分でexistence leak(ADR-012)になる。現時点で消費者が存在しないため、返す前に削除するのが最も安全(ADR-007の却下基準)。件数提示が必要になった場合は「認可済み返却可能件数のみ」を意味する専用フィールドを別ADRで定義する。

## 追補2(2026-10-01): プライベート領域の方針の伝達と結果ごとの領域分類(コネクタIF v0.4、issue #19)

Status: Accepted(オーナー決定 2026-10-08、issue #19: 方針 C で進める。確認点 2〜6 は本追補の推奨どおり)/ Date: 2026-10-01(Accepted: 2026-10-08)/ 起点: issue #19(5 観点レビュー 2026-09-27、程度「高」、ドメイン R1)

本追補はコネクタ IF を v0.3 から v0.4 に変える提案であり、不変条件5 が求める ADR を兼ねる。オーナーの決定(2026-10-01、issue #19 のコメント): 「方針の伝え方と強制の位置」は未記入のため、本追補で推奨を示してレビューを求める。`consent` の同意状態をどこで持つかは機能設計がまだないため、#42 に分けて先送りする。CLAUDE.md「タスクの進め方」2 に従い、実装は本追補の承認後に行う。

### 文脈

ADR-013 §1 は `connectors[].privateScopes`(既定 `excluded`: DM・プライベートチャンネル・個人スコープを検索対象外)を、§2 はプライベートスコープの docId を `hashed` / `omitted` でしか記録しないことを定める。現在の実装では、この方針はコネクタに届かず、強制する箇所もない(行番号は 0a959d9 時点):

- `packages/gateway/src/config/schema.ts:215` — `privateScopes: z.enum(["excluded", "consent", "included"]).default("excluded")`
- `packages/gateway/src/bootstrap/plugins.ts:55-62` — `ConnectorFactoryInit` は `sourceId` / `settings` / `configDir` の 3 つだけ。`:310-314` の factory 呼び出しも方針を渡さない。冒頭のコメント(`:32-33`)は、この契約を起動コード側のものとし、connector-sdk の IF は変更しないとしている
- `packages/gateway/src/config/validate.ts:110-125` — 方針を読むのは `included` の確認フラグの検査だけ。`consent` は確認フラグなしで通る(`packages/gateway/test/config-validate.test.ts:248-254`)
- `packages/connector-sdk/src/index.ts:90-110`、`packages/gateway/src/proxy/gateway.ts:491-510` — `SearchHit` に領域の分類がなく、Gateway の射影は既知のフィールドだけを残す(TM-A1)。Gateway には結果がプライベート領域のものかを知る手段がない
- `packages/orchestrator/src/audit.ts:220-233` — citedDocIds の分類は `privateScopes !== "excluded"` のソースだけをプライベートスコープとする(`:227`)。`excluded` のソースの docId は、コネクタが実際に除外したかを確かめずに平文で記録される
- `packages/gateway/src/audit/docid.ts:31` — `DocIdOrigin` のコメントは「判定はコネクタのメタデータに基づきGateway(T-003)が行う」としているが、そのメタデータが IF にない

方針はどの値でもコネクタの動作を変えない。このまま Google Drive(T-005)・Slack(T-006)を実装すると、`excluded` でもプライベート領域が検索対象になり、その docId が平文で監査に残りうる(ADR-013 違反)。`consent` の実態は「確認フラグの要らない `included`」になっている。現行のコネクタ(GitHub、開発用 `dev-fixture`)では顕在化していない(GitHub の扱いは決定7)。

### 選択肢

- **A**: 方針を `ConnectorFactoryInit` でコネクタに渡し、除外はコネクタが実装する。結果に分類は付けない
- **B**: コネクタは結果ごとに領域(private / shared)を付けるだけにし、`excluded` の除外は Gateway が行う。コネクタは方針を知らない
- **C**: A と B の両方。コネクタは方針に従ってソース側で除外し、かつ結果に領域を付ける。Gateway は方針と分類を突き合わせて強制し、監査の分類にも使う

| 観点 | A | B | C |
|---|---|---|---|
| 強制の位置 | コネクタだけ(コネクタごとに実装) | Gateway(全コネクタに一律) | コネクタ(ソース側)+ Gateway(一律の保証) |
| 自己申告への依存 | 除外の実装を全面的に信頼する。Gateway は検査できない | 分類を信頼する。分類の誤りはそのまま漏れになる | 分類を信頼する。ただし分類の誤りだけでは漏れず、ソース側の除外も同時に失敗したときに漏れる |
| 監査の docId 分類の正しさ | 「excluded なら除外済み」の前提が残る(現在の欠陥のまま) | 結果ごとの分類で決まる。分類のない結果は private とみなす | B と同じ。加えて excluded のソースの private の結果は Gateway で落ち、監査に届かない |
| IF 変更の大きさ | 小(factory の引数、能力の宣言) | 中(結果 3 型への分類、能力の宣言、エラー分類 1 つ) | B + factory の引数(B との差は小さい) |
| T-005(Drive)への影響 | クエリで表しきれない「個人スコープ」は、コネクタ内で結果ごとに判定して落とす実装が要る(分類の仕事は結局生じる) | 結果ごとの分類だけ。クエリで除外できる分まで取得してから落とすため、取得量が増え、返却件数が欠ける | 分類は B と同じ。クエリで除外できる分はソース側で除く |
| T-006(Slack)への影響 | OAuth スコープの絞り込み(資格情報の取得側、T-004)と、可能ならクエリ条件で除外できる見込み(auth-matrix §3)。分類は要らない | クエリ条件での除外はしない(OAuth スコープの絞り込みは T-004 で可能)。会話の種別を結果ごとに判定する方法を着手時の fitting 検証で決める | A の除外と B の分類の両方。分類の方法は B と同じく fitting 検証で決める |
| 分類できないソース(fail-closed) | 除外を実装できないことを自己申告させ、起動時に拒否する | 分類のない結果を private とみなすと excluded では全件が落ちる。能力の宣言で起動時に拒否する | B と同じ(`unsupported` の宣言で起動時に拒否) |
| `consent`(利用者ごとの方針)への拡張 | 呼び出しごとに方針を渡す口が別に要る(再度の IF 変更) | Gateway が利用者の同意状態で落とせる(コネクタの変更なし) | B と同じ。ソース側の除外は、利用者ごとのトークンのスコープで表せるソースがある(Slack の private 系スコープ等) |

T-005 の注: Drive の「個人スコープ」をマイドライブ全体とするか、本人だけが見られる文書とするかで、クエリで除外できる範囲が変わる(auth-matrix §2: マイドライブと共有ドライブは API のパラメータ(`corpora` 等)で区別できる)。後者はクエリで表せず、結果ごとの判定が要る。定義は T-005 の設計判断として人間のレビューを受ける。

### 推奨: C

1. 監査の分類を「除外済み」という前提から切り離せるのは、結果ごとの分類を持つ B と C だけである(issue #19 の推奨対応)。A では現在の欠陥が残る
2. B だけでは、ソース側で除外できるものまで取得して Gateway で落とすことになり、プライベート領域の結果(タイトル・スニペット、fetch では本文)が Gateway のメモリまで来る。取得量が増え、返却件数も欠ける。方針をコネクタまで届け、外せるものはソース側で外す方がよい
3. C ではコネクタの除外漏れを Gateway が落とし、分類の誤りをソース側の除外が補う。両方が同時に失敗したときだけ漏れる。ただし同じ判定ロジックを両方に使うと失敗が相関するため、コネクタは除外の根拠(OAuth スコープ・クエリ条件)と分類の根拠(結果のメタデータ)をできるだけ別にする
4. `consent`(#42)は利用者ごとの方針で、導入単位で factory に渡す方針では表せない。Gateway が結果ごとに強制する仕組みは、利用者ごとの方針へそのまま広げられる
5. `enforced`(決定3)を宣言したコネクタから private の結果が来たら、契約違反として検知できる。B では落とすことが日常の動作になり、違反と区別できない
6. 規約をコネクタに示し、Gateway が一律に強制する形は、本 ADR の採用変更3(snippet 長: SDK の定数で示し、Gateway が強制 truncate する)と同じである

不変条件との関係:

- **未認可候補ではない(不変条件3、ADR-012)。** プライベート領域の結果は、ソースが本人の資格情報で認可した、本人が見てよい文書である。Gateway が落とした件数に不変条件3 は適用されない
- **Gateway の除外は方針の強制であり、認可判定ではない(不変条件1 と矛盾しない)。** 誰が何を見てよいかはソースが本人の資格情報で決めたままで、Gateway は認可済みの結果を導入先の方針(deployment.yaml)で絞るだけである。分類もコネクタがソースのメタデータから付けるもので、Gateway は権限モデルも ACL の複製も持たない
- **落とした件数は通常の監査にもデバッグログにも出さない(ADR-013)。** 利用者やクエリと結び付くと「その利用者のプライベート領域にクエリに一致する文書がある」ことを示すためである。記録は利用者・クエリ・docId と結合できない分離テレメトリに限る。性質は ADR-011 決定2 と同じだが、不変条件3 の例外として使うのではない

### 決定案

1. **方針の伝え方。** connector-sdk に導入単位の方針 `SourcePolicy` を置き、`ConnectorFactoryInit.policy` で factory に渡す。値は deployment.yaml の `privateScopes` で、`consent` は決定6 で拒否するため渡らない。OAuth スコープの絞り込み(例: Slack の private 系スコープを要求しない)は資格情報の取得側(T-004 の Auth Adapter / Token Vault)が同じ方針から行い、コネクタは方針ごとに必要なスコープを README に書く。#22 で SourceProfile を定めるときは、コネクタに渡す部分としてこの型を拡張し、フィールド名 `policy` は保つ
2. **結果ごとの分類。** `SearchHit` / `FetchResult` / `ContainerEntry`(list と describe の topContainers)に `scope: "private" | "shared"` を必須で付ける。private は ADR-013 §1 のプライベート領域(DM・プライベートチャンネル・個人スコープ)を指す。何を private とするかの対応表と判定の根拠はコネクタの README に書き、契約テストで固定する。対応表は各コネクタのタスクの設計判断として人間のレビューを受ける。判定に迷うものは private とする。fetch を含めるのは、LLM が任意の documentId(利用者が貼った DM のリンク等)で fetch を呼べるため、search を絞るだけでは方針を守れないからである
3. **能力の宣言と起動時の照合(fail-closed)。** `ConnectorCapabilities.privateScopeHandling` を足す。`describe(auth)` は利用者の資格情報がないと呼べないため、validate / 起動時に使える静的な宣言(`validate.ts:79-86` の `capabilities`)に置く
   - `enforced`: excluded のとき private の結果を返さない(ソースへの要求の段階で除く。資格情報のスコープによる除外を含む)。全結果に scope を付ける
   - `classified`: ソース側では除かない(除けない)。全結果に scope を付け、除外は Gateway に任せる
   - `unsupported`: 分類できない。宣言がないもの(v0.3 のプラグイン)もこれとみなす
   - `kp-gateway validate` / `serve` は、有効なコネクタの方針が `excluded` で能力が `unsupported` なら起動を拒否する(コード例: `private_scopes_unenforceable`)。`included`(確認フラグ付き)はどの能力でも通す
4. **Gateway の強制。** Gateway は実行時に各ソースの設定を持っている(`gateway.ts:74-81` の `RegistryEntry.config`)ので、方針の取得に新しい経路は要らない。射影(`gateway.ts:491-510`・`:521-531`・`:533-550`)で `scope` を読み、`"shared"` 以外(欠落・未知の値)は private とみなす。方針が `excluded` のとき:
   - search / list / describe: private の結果を落とす。`returnedHitCount` は落とした後の件数(利用者に返した件数)とする。ToolInvocation は limit も続きの有無も記録しないので、差から落とした件数は復元できない。LLM・利用者には落とした事実も件数も返さない
   - fetch: private の結果は本文を捨て、新設のエラー分類 `private_scope_excluded`(LLM・利用者には固定文言)で失敗させる。`enforced` のコネクタは自ら同じ分類で拒否してよい。本人が取得できない文書には従来どおり `not_found` / `permission_denied` を返し、この分類を存在の推定に使わせない(会話 ID の形式だけで判定できる場合は、ソースを呼ばずに拒否してよい)
   - 監査の errorClass には `private_scope_excluded` だけを残し、docId は残さない
   - 落とした・拒否した事実は分離テレメトリに記録する。日単位の集計とし、sourceId・ツール・宣言した能力・件数のバケット(1-10 / 11+)だけを持つ。userId・runId・requestId・queryDigest・docId・時刻は持たない(ToolInvocation と時刻で突き合わせて利用者を推定させない)。`enforced` のソースで発生したものは契約違反として扱う。分離テレメトリの書き込み先は未実装(保持期間の設定 `audit.telemetryRetentionDays` だけがある)のため、実装までは落とす処理だけを行う。Slack 由来のソースをテレメトリに記録してよいかは #22 の決定に従い、それまでは記録しない(不変条件7 を安全側に解釈する)
   - 任意: tools/list のソース説明に「プライベート領域は対象外」と書く。導入単位の情報で、利用者によって変わらない(ADR-001 追補3 決定5)
5. **監査の docId 分類。** Orchestrator の証拠台帳(`packages/orchestrator/src/citations.ts` の `EvidenceLedger`)に結果ごとの scope を記録し(欠落・未知の値は private、同じ文書が複数回現れたら private を優先)、`citedDocIdsForAudit` に引用ごとの scope を渡す。ソース単位の分類(`docIdClassifierFromConnectors` / `docIdAuditFromDeployment`、`audit.ts:220-249`)は方針と Slack の判定のために残す。プライベートスコープかどうかは「結果の scope が shared でない」または「ソースの方針が excluded でない」の論理和で決める
   - `excluded` のソース: shared は平文、private は `hashed` / `omitted`(Gateway が落とすので通常は届かない)
   - `included` のソース: 従来どおり全 docId を `hashed` / `omitted` にする。shared の結果まで平文にしないのは、コネクタの分類の誤りがそのまま平文の記録になるのを避けるためである(T-014 の参照頻度集計は HMAC 値でできる)
   - 分類できないソースと Slack の扱い(`audit.ts:122-124`、`isSlackKind`)は変えない。Slack の判定は #22 に残す
   - Gateway と Orchestrator の設定がずれても、private の結果は平文にならない(ADR-018 決定2 の preflight はソースの一覧しか照合しない)
   - scope は Answer の citations(ADR-018 の `ask` の出力)には載せず、台帳の中に留める
   - **採りうる選択肢(2026-10-09 追記、issue #19)。** 決定 5 の個別規則にはそれぞれ代替があり、いずれも「分類の誤りや欠落がそのまま平文の記録にならない」側に倒して選んだ:
     1. 結果の scope が欠落・未知のとき: (a) private 扱い【採用】/ (b) shared 扱い / (c) その結果を監査に記録しない、または run を失敗させる。(a) は v0.3 のプラグインや型の外から来た値でも平文にならない(fail-closed)。(b) は分類漏れがそのまま平文の記録になる。(c) は監査が欠けるか可用性を落とす
     2. 同じ文書が複数回(search と fetch、複数ページ)現れ scope が食い違うとき: (a) 一度でも private なら private【採用】/ (b) 最後の値 / (c) 最初の値。食い違い自体がコネクタの分類の不安定さを示すため、安全側に固定する (a) を選んだ
     3. `included` のソースの shared の結果: (a) 全件 hashed / omitted【採用】/ (b) 結果ごとに分類し shared は平文。(b) は監査の閲覧者が shared の文書を docId で特定できる利点があるが、コネクタの分類の誤りがそのまま平文になる。`included` は導入側が確認フラグ付きで選ぶ構成なので監査上は安全側に倒した。T-014 の参照頻度集計は HMAC 値でできるため損なわれない
     4. 論理和の規則(scope ≠ shared ∨ 方針 ≠ excluded → hashed / omitted)は 1〜3 の帰結で、代替は「scope だけで決める」(方針を見ない。3-(b) と同じ問題)
6. **`consent` の暫定拒否。** #42 で同意状態の持ち方(と、ADR-013 §1 の同意状態の変更の記録。#30)を設計するまで、`kp-gateway validate` / `serve` は `consent` を拒否する(コード例: `private_scopes_consent_not_supported`)。`included` の確認フラグと同じく、無効化済みのコネクタでも宣言時点で拒否する。`kp-ask` / `kp-ask serve` も同じ静的検証(`packages/gateway/src/config/loader.ts:63`)を通るため、同様に拒否される。スキーマの列挙値は残し、解放は検証の緩和として行う(`validate.ts:209-219` の agentExecution と同じやり方)。理由: 現状は方針がコネクタに届かないため、`consent` を指定しても除外されず、`included` に要る確認フラグも要らない。これは ADR-013 §1 に反する
7. **既存コネクタの移行。**
   - connector-github: GitHub には DM に当たる領域がない。組織のリポジトリ(private / internal を含む)は組織が管理する業務の領域で、閲覧範囲の限定は GitHub の認可が担うため shared とする(private リポジトリを ADR-013 の「プライベートチャンネル」に当たるとみる解釈もありうるため、確認事項6 とする)。個人アカウントの非公開リポジトリは個人スコープに当たりうるが、GitHub App の user access token は app のインストール範囲と本人の権限の積集合(auth-matrix §4)なので、app を組織にだけインストールする構成では検索に現れない。移行では `classified` を宣言して全結果を shared とし、「app は組織にだけインストールする」を README の前提表と導入チェックリストに加える。検索結果から所有者が個人アカウントかを判定できるなら、その結果を private にする(開発用 PAT の経路で個人の非公開リポジトリが現れる場合への備え)。判定できるかは移行タスクで確かめる
   - dev-fixture(`packages/gateway/src/dev/fixture-connector.ts`): コーパスの文書に任意の `scope`(既定 shared)を足し、`enforced` として実装する(excluded では private の文書を search / list / fetch から外す)。Gateway が落とす経路は、方針を無視する試験用のコネクタで検証する
   - リポジトリ外のプラグインに互換期間は設けない。OSS 公開(T-013)の前で、外部のプラグインはまだない。v0.3 のプラグインは決定3 で `unsupported` とみなされ、`excluded` では起動を拒否される。`included` では全結果が private として扱われる

### 型の変更案(connector-sdk v0.4)

```ts
/** 結果の領域(ADR-013 §1)。private = DM・プライベートチャンネル・個人スコープ等 */
export type DocumentScope = "private" | "shared";

/** deployment.yaml 由来の、導入単位のソース方針。#22 の SourceProfile に吸収する予定 */
export interface SourcePolicy {
  /** consent は #42 の設計まで起動時に拒否するため渡らない */
  readonly privateScopes: "excluded" | "included";
}

/** 置き場所(connector-sdk に移すか)は #33 で決める。現在は gateway の plugins.ts */
export interface ConnectorFactoryInit {
  readonly sourceId: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly configDir: string;
  /** 追加 */
  readonly policy: SourcePolicy;
}

export interface SearchHit {
  // documentId / title / snippet / url / anchor? / updatedAt? / meta?(既存)
  /** 追加。判定できないものは "private" を付ける */
  scope: DocumentScope;
}
// FetchResult と ContainerEntry(list と describe の topContainers)にも同じ scope を足す

export interface ConnectorCapabilities {
  readonly nativeSearch: "full" | "degraded" | "none";
  readonly ingest: boolean;
  /** 追加。宣言がないもの(v0.3)は "unsupported" とみなす */
  readonly privateScopeHandling: "enforced" | "classified" | "unsupported";
}

export type ConnectorErrorClass =
  | "auth_expired"
  | "permission_denied"
  | "rate_limited"
  | "not_found"
  | "source_unavailable"
  | "invalid_request"
  /** 追加: 方針(excluded)によるプライベート領域の拒否 */
  | "private_scope_excluded";
```

- 型では必須にし、リポジトリ内のコネクタの付け忘れをコンパイル時に検出する。実行時の欠落は Gateway が private とみなす(決定4)
- fitting 検証(`packages/connector-sdk/test/if-fitness.test.ts`、ADR-007 の手法)の 3 ソースで、scope と能力の宣言を表現できることを確かめる(Slack の DM は private、Drive の個人スコープは private 等)
- 検索層(Phase 2)が内部実装に入っても、索引に scope を持たせて同じ IF で返す。`excluded` のソースのプライベート領域は ingest しない(中央索引も永続化の一種である)
- エラー分類の追加は本 ADR で「消費者不在」として退けたが、今回は Gateway の強制・監査と Orchestrator の案内という消費者がある
- パッケージの版は `@kp/connector-sdk` 0.4.0 とする。#40(AbortSignal)は保留中のため束ねない

### 時期

T-005 / T-006 の着手(モックでの先行実装を含む)より前に Accepted にすることを推奨する。v0.4 の型がコネクタの形を決めるため、後から入れると両コネクタを書き直すことになる。Slack の法務確認(ADR-014)とは独立しており、並走できる。決定6(`consent` の暫定拒否)は他と独立した小さな変更なので、本追補全体の承認を待たずに先に入れてもよい。

### 関連 issue との関係

- #22(ソースの性質を 1 つの概念に): `SourcePolicy` は SourceProfile のうちコネクタに渡す部分の先行実装である。Slack の判定(`isSlackKind`)と非永続化は #22 に残す
- #33(中核モデルの置き場所): `ConnectorFactory` / `ConnectorFactoryInit` を connector-sdk に移せば、`packages/connector-github/src/index.ts:28-39` の再定義がなくなり、`policy` の追加も 1 か所で済む。v0.4 の PR に相乗りできるが、移すかどうかは #33 で決める。移さない場合は両方の定義に `policy` を足す
- #30(監査スキーマの版、同意状態の記録): 本追補は監査レコードのスキーマを変えない(errorClass の値が 1 つ増えるだけで、分離テレメトリは別ストア)。同意状態の変更の記録は #42 と一緒に扱う
- #23(プラグイン境界): Connector プラグインの契約(`plugins.ts:4-33`)に方針の受け取りと能力の宣言が加わる。factory の契約もコネクタ IF の一部になるため、`plugins.ts:32-33` の記述(この契約では connector-sdk の IF を変更しない)は改める。ADR-005 を改訂するときは「Connector プラグインの契約 = connector-sdk v0.4」と書く

### オーナーに確認してほしい点

1. 強制の位置を C(コネクタがソース側で除外 + 結果ごとの分類 + Gateway で強制)とするか。fetch / list / describe も対象に含めること、エラー分類 `private_scope_excluded` を足すことを含む
2. `consent` を #42 の設計まで validate / serve で拒否してよいか。決定6 だけを先に入れてよいか
3. 時期: T-005 / T-006 の着手(モックでの先行実装を含む)より前に Accepted にするか
4. v0.4 の進め方: SDK・Gateway・既存 2 コネクタの移行を 1 つの PR で変える(ビルドとテストが通る単位がそこで閉じる)こと、リポジトリ外の v0.3 プラグインに互換期間を設けないこと、#33 を相乗りさせるか
5. 監査の分類で、`included` のソースは shared の結果も含めて従来どおり全件を private として扱う(`hashed` / `omitted`)安全側の規則でよいか
6. GitHub の組織のリポジトリ(private / internal を含む)を「プライベートチャンネル」に当たらない shared とする定義でよいか。個人アカウントの非公開リポジトリは「app を組織にだけインストールする」前提で扱ってよいか
   - **回答(2026-10-09、issue #19)**: よい(組織のリポジトリは shared、個人アカウントの非公開リポジトリは「app を組織にだけインストールする」前提。issue / PR・fetch で repo API を追加で呼ぶ判定は入れない)

### 実装タスクの分割案(番号は backlog 登録時に採番)

- T-xxx `consent` の暫定拒否: validate.ts の宣言時拒否、テストの更新(`config-validate.test.ts:248-254` を拒否の期待に変え、Orchestrator のテストで `consent` を使う設定(`packages/orchestrator/test/cli.test.ts:302` 等)を直す)、docs/install.md と examples の記述。小さく、他と独立
- T-xxx コネクタ IF v0.4: connector-sdk の型と fitting 検証、Gateway(factory への `policy`、`isConnector` の能力の検査、射影での scope の正規化と除外、fetch の拒否、validate の能力の照合)、connector-github と dev-fixture の移行、方針を無視する試験用コネクタでの強制のテスト。#33 を相乗りする場合は ConnectorFactory の移設も含む
- T-xxx 監査の docId 分類の結果単位化: 証拠台帳への scope の記録、`citedDocIdsForAudit` の論理和の規則、`packages/orchestrator/test/cited-docids.test.ts` の更新
- T-xxx 分離テレメトリの最小実装: 日単位の集計・バケット化・`audit.telemetryRetentionDays` での削除・閲覧の限定(ADR-013 §3)。ADR-011 決定2 に用途(方針の強制の発動)を追記する
- T-xxx 文書と脅威モデル: threat-model に TM-E8(既定の `excluded` がコネクタで実装されない)を追加、各コネクタの README に領域の対応表、T-005 / T-006 の受け入れ条件に「scope の対応表・能力の宣言・契約テスト」を追加
