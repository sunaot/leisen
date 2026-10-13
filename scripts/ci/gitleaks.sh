#!/usr/bin/env bash
# git 履歴全体の秘密情報スキャン(T-013、issue #32)。CI の secret-scan ジョブと手元で使う。
# 版を固定した gitleaks のバイナリを公式リリースから取得し、配布元のチェックサムで検証してから
# 実行する。検出値は --redact で伏せ、ログに秘密を出さない(不変条件6)。
# 使い方: scripts/ci/gitleaks.sh [リポジトリのパス(既定: .)]
# 前提: 履歴全体が取得済みであること(actions/checkout は fetch-depth: 0)。
set -euo pipefail

GITLEAKS_VERSION="8.28.0"
# gitleaks_8.28.0_checksums.txt の linux_x64 の行
GITLEAKS_SHA256="a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb"

repo="${1:-.}"
config="$(cd "$(dirname "$0")/../.." && pwd)/.gitleaks.toml"

if [ "$(git -C "$repo" rev-parse --is-shallow-repository)" = "true" ]; then
  echo "gitleaks.sh: 浅いクローンでは履歴全体を検査できない(fetch-depth: 0 で取得する)" >&2
  exit 2
fi

# 許可は .gitleaks.toml に一本化する。gitleaks は -i の指定によらず検査対象の直下にある
# .gitleaksignore も読むため、置かれていたら検査せずに失敗させる。
if [ -e "$repo/.gitleaksignore" ]; then
  echo "gitleaks.sh: .gitleaksignore は使わない(許可は .gitleaks.toml に理由付きで書く)" >&2
  exit 2
fi

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "gitleaks.sh: Linux x86_64 専用(手元の他環境では gitleaks を各自入れて同じ設定で実行する)" >&2
  exit 2
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
curl -sSfL --retry 3 -o "$workdir/$archive" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}"
echo "${GITLEAKS_SHA256}  $workdir/$archive" | sha256sum -c - >&2
tar -xzf "$workdir/$archive" -C "$workdir" gitleaks

# 行内の gitleaks:allow は無視する。-i は空の作業ディレクトリに向ける(上の .gitleaksignore の拒否と併せて、
# 許可を .gitleaks.toml だけにする)。-v は検出の場所(ファイル・コミット・ルール)を
# ログに出す。値は --redact で伏せられる。
# 注: gitleaks git はマージコミット自身の差分(衝突解決で入れた内容)は走査しない。
"$workdir/gitleaks" git --no-banner --redact -v --ignore-gitleaks-allow \
  --gitleaks-ignore-path "$workdir" --config "$config" --exit-code 1 "$repo"
