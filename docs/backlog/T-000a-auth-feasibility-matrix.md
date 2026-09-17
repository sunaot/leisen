# T-000a: 認可実現性マトリクス【実装前ゲート】

## 目的
ADR-010をAcceptedにする根拠を作る。各ソースで「本人権限アクセス」が実際に成立する方式を確定し、T-004以降の手戻りを防ぐ。

## 前提(人手)
このタスクは調査タスクであり、大半が人間+エージェントの共同調査。各SaaSの公式ドキュメント・管理コンソールへのアクセス。

## 内容
主要10ソース(Google Drive, Slack, GitHub, Confluence/Notion, SharePoint/OneDrive, ファイル共有, 社内DB, その他導入予定)について以下を表化する:
- 本人検索 / 本人fetch / permission check API の有無と方式
- token exchange / on-behalf-of の可否(IdP別)
- 個別OAuthの要否、必要scope、管理者同意の要否
- rate limit、private/shared領域の扱い
- 退職・権限剥奪時の失効経路(IdP連動の有無)
- サービスアカウント系方式(DWD等)の可否と「認可判定が本人に対して行われるか」

## 受け入れ条件
- [x] マトリクスが docs/auth-matrix.md として存在し、各セルに一次情報への参照がある
- [x] ADR-010が調査結果を反映してAccepted化(または修正)されている(2026-07-12 人間レビュー完了)
- [x] T-004の前提欄が実現可能な作業のみになっている
