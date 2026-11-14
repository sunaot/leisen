/**
 * 接続ページ・ログイン・同意画面の HTML(ADR-022 決定 7)。外部の CSS / JS は読み込まない。
 * 値はすべて escapeHtml を通す。トークン・メールアドレス以外の個人情報は出さない
 * (メールアドレスは本人照合の失敗の案内で本人にだけ見せる)。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--accent:#1d4ed8;--ok:#15803d;--warn:#b45309;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--accent:#93c5fd;--ok:#86efac;--warn:#fcd34d;--err:#fca5a5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}h1{font-size:1.4rem;margin:0 0 8px}p.lead{color:var(--muted);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 12px}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.name{font-weight:600}.meta{color:var(--muted);font-size:.9rem}
.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}@media (prefers-color-scheme:dark){button.primary{color:#1c1917}}
form{margin:0}input[type=text],input[type=password]{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);width:100%;background:var(--card);color:var(--fg)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function messagePage(title: string, message: string, tone: "ok" | "err" | "warn" = "err", link?: { href: string; label: string }): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><div class="card"><p class="${tone}">${escapeHtml(message)}</p>${
      link !== undefined ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : ""
    }</div>`,
  );
}

export function mockLoginPage(action: string, state: string): string {
  return page(
    "開発用ログイン",
    `<h1>開発用ログイン(モック IdP)</h1><p class="lead">LEISEN_MOCK_SESSIONS のセッショントークンを入力してください。本番では使えません。</p>
<div class="card"><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="state" value="${escapeHtml(state)}">
<label>セッショントークン<input type="password" name="token" autocomplete="off" required></label>
<div class="actions"><button class="primary" type="submit">ログイン</button></div></form></div>`,
  );
}

export type SourceStatus = "connected" | "not_connected" | "automatic" | "in_client";

export interface ConnectionRow {
  readonly sourceId: string;
  readonly method: "token_vault" | "esc" | "token_exchange" | "mock_env";
  readonly status: SourceStatus;
  readonly connectedAt?: number;
}

const METHOD_LABEL: Record<ConnectionRow["method"], string> = {
  token_vault: "Leisen が保管",
  esc: "クライアントが暗号化して保持",
  token_exchange: "ログインから自動で交換",
  mock_env: "開発用",
};

export function connectionsPage(input: {
  displayName: string;
  rows: readonly ConnectionRow[];
  csrf: string;
  notice?: { tone: "ok" | "err" | "warn"; text: string };
  highlight?: string;
}): string {
  const rows = input.rows
    .map((row) => {
      let status: string;
      let actions = "";
      const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><input type="hidden" name="source" value="${escapeHtml(row.sourceId)}">`;
      switch (row.status) {
        case "connected":
          status = `<span class="ok">接続済み</span>${row.connectedAt !== undefined ? `<span class="meta">(${escapeHtml(new Date(row.connectedAt).toISOString().slice(0, 10))})</span>` : ""}`;
          actions = `<form method="post" action="/connections/disconnect">${hidden}<button type="submit">解除</button></form>`;
          break;
        case "not_connected":
          status = `<span class="warn">未接続</span>`;
          actions = `<form method="post" action="/connections/start">${hidden}<button class="primary" type="submit">接続する</button></form>`;
          break;
        case "automatic":
          status = `<span class="ok">ログインに連動</span>`;
          break;
        case "in_client":
          status = `<span class="meta">クライアントのログイン時に接続します</span>`;
          actions = `<form method="post" action="/connections/disconnect">${hidden}<button type="submit">すべてのクライアントで解除</button></form>`;
          break;
      }
      const mark = input.highlight === row.sourceId ? ` style="border-color:var(--accent)"` : "";
      return `<div class="card"${mark}><div class="row"><div><div class="name">${escapeHtml(row.sourceId)}</div><div class="meta">${escapeHtml(METHOD_LABEL[row.method])}</div></div><div>${status}</div>${actions}</div></div>`;
    })
    .join("");
  const notice =
    input.notice !== undefined ? `<div class="card"><p class="${input.notice.tone}">${escapeHtml(input.notice.text)}</p></div>` : "";
  return page(
    "Leisen のソース接続",
    `<h1>ソースの接続</h1><p class="lead">${escapeHtml(input.displayName)} さんとして検索に使うソースを接続します。権限はそれぞれのソースがあなた本人に対して判定します。</p>${notice}${rows}
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><div class="actions"><button type="submit">ログアウト</button></div></form>`,
  );
}

export interface ConsentSourceRow {
  readonly sourceId: string;
  readonly connected: boolean;
  readonly requested: boolean;
}

export function consentPage(input: {
  clientName: string;
  resourceLabel: string;
  displayName: string;
  tx: string;
  csrf: string;
  sources: readonly ConsentSourceRow[];
  notice?: { tone: "ok" | "err" | "warn"; text: string };
}): string {
  const sources = input.sources
    .map((row) => {
      const mark = row.requested && !row.connected ? ` style="border-color:var(--accent)"` : "";
      const action = row.connected
        ? `<span class="ok">このログインで接続済み</span>`
        : `<form method="post" action="/authorize/connect"><input type="hidden" name="tx" value="${escapeHtml(input.tx)}"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><input type="hidden" name="source" value="${escapeHtml(row.sourceId)}"><button${row.requested ? ' class="primary"' : ""} type="submit">接続する</button></form>`;
      return `<div class="card"${mark}><div class="row"><div class="name">${escapeHtml(row.sourceId)}</div>${action}</div></div>`;
    })
    .join("");
  const notice =
    input.notice !== undefined ? `<div class="card"><p class="${input.notice.tone}">${escapeHtml(input.notice.text)}</p></div>` : "";
  return page(
    "Leisen へのアクセスの許可",
    `<h1>${escapeHtml(input.clientName)} に Leisen へのアクセスを許可しますか</h1>
<p class="lead">${escapeHtml(input.displayName)} さんとして ${escapeHtml(input.resourceLabel)} を使います。検索はあなた本人の権限で行われます。</p>${notice}
${input.sources.length > 0 ? `<p>このクライアントに持たせるソース(必要なものだけ接続してください。資格情報は Leisen だけが開ける形に暗号化してクライアントが保持します)</p>${sources}` : ""}
<form method="post" action="/authorize/decision"><input type="hidden" name="tx" value="${escapeHtml(input.tx)}"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<div class="actions"><button class="primary" type="submit" name="decision" value="allow">許可する</button><button type="submit" name="decision" value="deny">拒否する</button></div></form>`,
  );
}
