#!/usr/bin/env bash
# PreToolUse hook: 危険なコマンドをブロックする。
# stdinにhook入力(JSON)が渡る。exit 2 でツール実行をブロック。
set -u
INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null || true)

deny() { echo "BLOCKED by scripts/guard/pre-bash.sh: $1" >&2; exit 2; }

case "$CMD" in
  *"rm -rf /"*|*"git push --force"*|*"git push -f"*) deny "破壊的コマンド" ;;
esac
# 秘密情報らしき値のecho/exportを粗く検知。GitHub のトークン接頭辞は post-edit.sh と
# 同じ集合(classic PAT ghp_・OAuth App gho_・GitHub App の ghu_ / ghs_ / ghr_・
# fine-grained PAT github_pat_)。コマンドでは接頭辞だけで検知する
if printf '%s' "$CMD" | grep -qE '(xoxp-|xoxb-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AIza|-----BEGIN)'; then
  deny "秘密情報らしき文字列を含むコマンド(不変条件6)"
fi
exit 0
