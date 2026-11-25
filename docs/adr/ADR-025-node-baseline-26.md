# ADR-025: 対応する Node.js の下限を 26 に上げる

Status: Accepted(2026-11-25 オーナー決定: 下限を 26 に上げる)/ Date: 2026-11-25

## 文脈

これまでの下限は Node 22.13 だった(ルートの `engines: >=22.13`。CI・リファレンス構成のイメージは Node 22)。22.13 は `node:sqlite` が使える最初の版で、ADR-022 の CredentialStore が `node:sqlite` を使うことが根拠だった。

Node.js のリリース状況(2026-11-24 時点。[nodejs/Release](https://github.com/nodejs/Release) の表と、公式ブログ [Evolving the Node.js Release Schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule)):

| 版 | 状態 | 保守期間に入る日 | サポート終了 |
|---|---|---|---|
| 22 | 保守期間 | 2025-10-21 | 2027-04-30 |
| 24 | 保守期間 | 2026-10-20 | 2028-04-30 |
| 26 | 推奨の長期サポート版 | 2027-10-20 | 2029-04-30 |
| 27 | 試験版(本番向けではない) | なし | 2030-04-30 |

- 22 のサポートは約 5 か月後(2027-04-30)に終わる。導入先が本番で使い始める時期を考えると、22 を前提にした構成はすぐに更新が要る
- 27 からリリースの周期が変わる。メジャー版は年 1 回(4 月)になり、奇数の版も含めて全部が長期サポート版になる。サポートは最初の正式版から 36 か月で、保守期間の段階はない。26 が従来の周期で出る最後の版である
- Node 22 では `node:sqlite` を読み込むと実験的機能の警告が出る。Node 26.13.1 では出ないことを確認した

Dependabot は @types/node 26 への更新(PR #87)を出していた。型の版が実行環境の下限より新しいと、下限の版にない API を使ってもコンパイルが通ってしまう。@types/node のメジャー版は下限と揃えるべきで、下限を決めてから扱うことにしていた。

## 決定

1. **対応する Node.js の下限を 26 にする。** ルートの `engines` は `>=26`。
2. **CI の全ジョブ(`audit` / `build-test` / `keycloak-e2e` / `reference-deploy`)は Node 26 で動かす。**
3. **リファレンス構成のイメージは `node:26-bookworm-slim`**(`deploy/Dockerfile` の `ARG NODE_IMAGE` の既定値)。
4. **@types/node のメジャー版は下限に揃える**(`^26`)。Dependabot は @types/node のメジャー更新を出さない設定にし(`.github/dependabot.yml` の `ignore`)、メジャー版は下限を上げるときに本 ADR の追補とあわせて上げる。minor / patch は従来どおり Dependabot のまとめた PR で上げる。
5. **次の見直しは Node 27 が長期サポート版になる 2027-10 ごろ**とする。26 のサポート終了は 2029-04-30。

## 影響

- **導入先**: コンテナ(リファレンス構成)で動かす場合は、イメージを作り直せば足りる。コンテナを使わずに動かす場合は Node 26 以上が要る。22 / 24 のままでは npm の `engines` の検査で警告が出る(`engine-strict` を設定していれば失敗する)
- **コード**: 変更は要らなかった(Node 26.13.1 で `npm run build`・`npm run lint:imports`・`npm test` が通ることを確認)。`node:sqlite` の遅延読み込み(`packages/gateway/src/credentials/store.ts`)は、sqlite を使わない構成で読み込まないために残す
- **文書**: README・docs/install.md・docs/personal-auth.md の Node の要件を 26 以上に直した。既存の ADR・設計書・日付付きの記録の本文にある Node 22 の記述は当時の記録として書き換えない
- `spikes/mcp-sdk-v2/` はルートの workspaces に含まれない移行スパイクの記録なので変えない
