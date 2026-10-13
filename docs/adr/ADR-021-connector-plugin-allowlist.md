# ADR-021: コネクタプラグインの解決を公式の許可表と明示指定に限る

Status: Accepted(2026-10-13 オーナー指示で採用。issue #32 の推奨対応)/ Date: 2026-10-13

## 文脈

Gateway はコネクタ実装を deployment.yaml の `connectors[]` から解決する(ADR-005 の Connector プラグイン境界、`packages/gateway/src/bootstrap/plugins.ts`)。これまでは `connectors[].module` を省略すると、kind から `@leisen/connector-<kind>` というパッケージ名を導いて動的 import していた(ADR-020 決定 4 で接頭辞を `@kp` から変更)。kind を省略すると id がそのまま kind になる。

この命名規則による暗黙の解決には、次の問題がある(issue #32)。

- 導入先の管理者が意図していないパッケージが、名前の一致だけで Gateway の中で動く。Gateway は全利用者の資格情報を扱うので、混入したコードはそれらに届く
- kind の書き間違いや、id から導いた kind が、別人の公開パッケージ名と一致しうる。npm の組織 `leisen` を確保するまでは、`@leisen/connector-*` を第三者が公開する余地もある
- deployment.yaml を読んでも、どのコードが読み込まれるかが書かれていない。レビューで気づけない

プラグイン境界全体の見直し(IdP Adapter や資格情報方式を動的に読み込むか。issue #23)は別の論点として残す。本 ADR は Connector の解決規則だけを扱う。

## 決定

1. **`connectors[].module` を省略できるのは、公式コネクタの許可表に載っている kind だけとする。** 許可表は Gateway のコードが持つ kind → パッケージ名の対応(`OFFICIAL_CONNECTOR_PACKAGES`)で、現在は `github` → `@leisen/connector-github` の 1 行だけ。
2. **許可表にない kind で `module` がなければ、読み込みを試みずに起動を拒否する**(`unknown_connector_kind`。`leisen-gateway validate` でも列挙される)。命名規則から導いたパッケージ名を import しない。kind を省略して id から導いた場合も同じ。
3. **それ以外のコネクタは `module` を明示する。** パッケージ名(サブパス可)か、`./` `../` `/` で始まるパスを書く(従来どおり。URL スキームは拒否)。何を読み込むかが deployment.yaml に書かれ、導入先の管理者がレビューして選ぶ。個社のコネクタはこの経路で足りる(ADR-005、不変条件 8)。
4. **許可表に行を足すのは、公式コネクタ(このリポジトリの `packages/connector-*`)を追加する PR に限る。** T-005(Google Drive)・T-006(Slack)などで公式コネクタが入るときに、その PR で行を足す。
5. 解決順は変えない。プログラム登録 → 組み込み(`dev-fixture`)→ プラグインの順で、組み込みの kind と `module` の併用は従来どおり拒否する。
6. 許可表の照合は自身のプロパティだけを見る。`constructor` などの継承プロパティを表の行と誤認しない。

## 帰結

- 公式でないコネクタは、すべて deployment.yaml に読み込み先が明記される。命名の一致だけで第三者のコードが Gateway に入る経路はなくなる
- `module` の明示そのものは、引き続き設定から任意のコードを読み込む経路である。deployment.yaml とプラグインの置き場所の書き込み権限を管理者に限る運用は変わらない(docs/install.md)
- `examples/deployment.yaml` の gdrive / slack は、公式コネクタが入るまで validate で `unknown_connector_kind` になる。読み込みの失敗が理由だった以前と、コードは同じ
- 互換: 公式でない kind を `module` なしで使っていた構成は起動しなくなる。公開前で外部の導入はなく、リポジトリ内の該当はテストだけだった(`module` を明示する形に更新した)

## 残る確認事項

- npm の組織 `leisen` の確保(ADR-020、オーナーの作業)。許可表の行は `@leisen/*` を指すので、確保は引き続き必要
- IdP Adapter など、他の境界での動的読み込みの扱い(issue #23)
