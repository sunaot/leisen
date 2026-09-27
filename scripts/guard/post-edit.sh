#!/usr/bin/env bash
# PostToolUse hook: 編集後の不変条件チェック(軽量)。
# 検出時はexit 2でClaudeにフィードバックされる。
set -u
cd "$(dirname "$0")/../.." || exit 0
VIOLATIONS=""

# 不変条件6: AuthContext/Credentialの直接シリアライズ禁止
HITS=$(grep -rn --include='*.ts' -E 'JSON\.stringify\((auth|authContext|credential)\b' packages/ 2>/dev/null | grep -v redact || true)
[ -n "$HITS" ] && VIOLATIONS="$VIOLATIONS\n[不変条件6] AuthContext/Credentialの直接シリアライズ:\n$HITS"

# 不変条件6: 実トークンらしき文字列のハードコード。GitHub は classic PAT(ghp_)に加え、
# OAuth App(gho_)・GitHub App の user-to-server(ghu_)/ installation(ghs_)/
# refresh(ghr_)・fine-grained PAT(github_pat_)の各接頭辞を対象にする
# (検出条件はいずれも「接頭辞+英数字20文字以上」)
HITS=$(grep -rn --include='*.ts' -E '(xoxp-[0-9]|xoxb-[0-9]|(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9]{20,})' packages/ 2>/dev/null || true)
[ -n "$HITS" ] && VIOLATIONS="$VIOLATIONS\n[不変条件6] トークンらしき文字列のハードコード:\n$HITS"

# 不変条件3: 監査系コードにpre-filter件数らしきフィールドを入れない(粗い検知)。
# フィールド宣言(`name:` 型注釈)または代入(`name =` / `name:` オブジェクトリテラル値)
# のみを対象とし、FORBIDDEN_KEYS等の「禁止リスト定義」行(文字列リテラル)は除外する。
HITS=$(grep -rn --include='*.ts' -iE '\b(preFilter(ed)?HitCount|candidateCount|rawHitCount)\b[[:space:]]*[:=]' packages/gateway/src/audit 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*"' || true)
[ -n "$HITS" ] && VIOLATIONS="$VIOLATIONS\n[不変条件3/ADR-011] 監査ログにpre-filter候補件数の疑い:\n$HITS"

if [ -n "$VIOLATIONS" ]; then
  printf "guard/post-edit.sh: 不変条件違反の疑いを検出しました。CLAUDE.mdを確認してください。%b\n" "$VIOLATIONS" >&2
  exit 2
fi
exit 0
