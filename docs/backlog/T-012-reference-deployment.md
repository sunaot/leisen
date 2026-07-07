# T-012: リファレンスデプロイ(Docker Compose)

## 内容
- gateway + keycloak + (検索バックエンドはprofile指定時のみ。エンジンはT-016のPoCで選定後に確定 — ADR-006) を docker compose up で起動できる構成
- deployment.yaml を volume 注入する導入手順を docs/install.md として整備
- アップグレード手順(イメージ差し替え+マイグレーション実行)の骨子

## 受け入れ条件
- [ ] クリーンなマシン相当(CIコンテナ)で起動確認が自動化されている
- [ ] Helm化はスコープ外とし、要件だけ docs に記録
