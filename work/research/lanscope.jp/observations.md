# Observations — lanscope

Name / URL / ring / evidence / captured: LANSCOPE（エムオーテックス） / https://www.lanscope.jp/ / Ring C — same audience, different product (情シス・セキュリティ責任者が既に買っているIT資産管理/エンドポイントセキュリティ) / evidence: 国内シェア上位・導入社数多数の定番情シス向け製品 / captured via structure.json, styles.json, desktop.png, mobile.png

## First view (desktop)
- R-lanscope-1 Headline: "サイバーセキュリティ任せるなラ、 ランスコープ" (rendered as mixed-scale display type: small text "サイバーセキュリティ任せるなラ、" over a very large "LANSCOPE" wordmark with small ruby-like "ランスコープ" reading beside it). Verbatim per structure.json h2 text; note the JSON string itself contains the odd "なラ、" (не"なら、") — quoted as captured.
- R-lanscope-2 Sub-headline: "累計導入実績 40,000 社以上 ※1"
- R-lanscope-3 Headline type: other (brand-tagline/slogan — frames a situation "誰かにサイバーセキュリティを任せるなら" and resolves it with the brand name itself as the answer; not a benefit/outcome statement, not a question)
- R-lanscope-4 Primary CTA: "お役立ち資料" (dark/black button, header) | Secondary: "無料でお試し" (transparent button, header, red-tinted text/border per screenshot). Additional first-view CTA layered over hero as a popup/video-ad element: "資料ダウンロード（無料）" (red button, bg rgb(230,0,18))
- R-lanscope-5 Visual: giant wordmark typographic lockup (headline) on the left; a rotating/carousel product-ad banner on the right showing a laptop-mockup UI screenshot for "LANSCOPE ID アクセスマネージャー" (dark bg, carousel arrows visible either side); below that, 3 laurel-wreath award badge graphics; below that, a horizontal scrolling client-logo wall
- R-lanscope-6 Proof in first view: number + logos + rating/award (all three present): "累計導入実績 40,000 社以上"; 3 award badges — "クラウドIT資産管理 市場シェアNo.1 ※2", "パブリッククラウド向け脆弱性診断 市場シェアNo.1 ※3", "ITreview顧客評価 6部門LEADER ※4"; client logo strip (E-Guardian, Panasonic, ポッカサッポロ, eat愛媛朝日テレビ, 沖縄銀行, 熊本信用金庫, 京進, 合人社グループ, 松風, MIWA, MASPRO)
- R-lanscope-7 Nav: 5 top-level items visible (プロダクト・サービス／導入事例／セミナー／ブログ／会社情報, the last with a small external-link icon) + 2 CTA buttons in the nav bar (お役立ち資料, 無料でお試し) → CTA in nav: yes

## First view (mobile) — differences only
- Header shows logo "LANSCOPE" + hamburger icon only; no visible nav items and no CTA buttons in the mobile header bar (differs from desktop's 5 nav items + 2 CTA buttons)
- The hero headline/wordmark block ("サイバーセキュリティ任せるなラ、 ランスコープ") is NOT present above the fold on mobile. The first thing shown after the header is the rotating product-ad carousel (same "IDaaS ... LANSCOPE ID アクセスマネージャー" banner as desktop's secondary hero element), immediately followed by "累計導入実績 40,000 社以上" and the 3 award badges. The large "LANSCOPE / ランスコープ" wordmark instead reappears later, inside the "5つのセキュリティ領域" arc-diagram section (mid-page), not in the first view.
- An autoplaying video-ad overlay ("パスワード、複雑すぎて全然覚えられないよ…") plus a cookie-consent modal (「はい」/「いいえ」, 「はい」 styled as blue button rgb(49,116,195)) both sit stacked on top of the above-the-fold content on mobile, occupying a larger relative share of the small viewport than on desktop
- Proof-in-first-view on mobile is the same set as desktop (number + badges), just re-ordered (carousel ad appears before the number/badges rather than beside the headline)

## Structure
- R-lanscope-10 Sections (ordered):
  1. Hero — headline wordmark + rotating product-ad carousel + award badges + client-logo wall
  2. プロダクト・サービス — top 4 product cards (IT資産管理・MDM／セキュリティ診断・ソリューション／AIアンチウイルス・EDR／IDaaS)
  3. MOTEXは、5つのセキュリティ領域で課題解決を支援します — arc/wheel diagram of 5 domains with sub-bullets
  4. LANSCOPEが選ばれる6つの理由 — 6-item numbered reason grid (icons + short claims)
  5. プロダクト・サービス一覧 — full categorized product catalogue (色分けされた5カテゴリ×製品リスト)
  6. 課題から探す — problem/pain-point tile grid linking to solutions
  7. 導入事例 — customer case-study cards (photo + company + quote snippet)
  8. セミナー／イベント — event/webinar card grid
  9. お知らせ — news list
  10. セキュリティ・脆弱性についてのお知らせ — security advisory list
  11. 運営ブログ・公式SNS — blog/SNS link tiles
  12. Footer CTA band — "LANSCOPEの導入実績は40,000社以上 サイバーセキュリティ任せるなら、LANSCOPE" + phone number + resource-download CTA, then site footer/product sub-nav
- R-lanscope-11 Section count / screens: 11 discrete sections in structure.json's section list (+1 footer CTA band) across pageHeight 11642px at 900px viewport ≈ 12.9 screens (value given directly in structure.json)
- R-lanscope-12 CTA recurrence: Two recurring CTA archetypes tailored per product: (a) 資料請求／資料ダウンロード ("お役立ち資料" ×5 occurrences incl. nav + footer + per-product; "資料ダウンロード（無料）"; product-specific "〜の特長がわかる資料ダウンロード" for Aurora Protect / Aurora Focus / Deep Instinct), and (b) 無料体験／トライアル ("無料でお試し" nav; "60日間 無料体験"; "無料体験ダウンロード"; "無料体験版"; "無料体験" ×2). A third, lower-frequency CTA is direct contact/consultation ("お問い合わせ", "オンラインで相談する" in sub-nav, "簡単お見積り" in sub-nav)
- R-lanscope-13 Conversion ask & friction: Primary ask is a low-commitment resource download (資料請求) routed to internal form pages (/request/, /form_documents/top/, per-product /request/); secondary ask is a free trial, several of which route off-domain to a marketing-automation redirector (go.motex.co.jp/l/320351/...) rather than an in-page form — `forms` array in structure.json is empty, meaning no on-page form fields were detected at capture time, so the actual data-entry step happens after a click-through. Friction observed on load: a cookie-consent modal (はい/いいえ) and an autoplaying video ad both overlay the hero simultaneously, before any user action, on both desktop and mobile.

## Message
- R-lanscope-20 Core promise (paraphrase): MOTEX が提供する統合セキュリティ製品群（エンドポイント／クラウド／ネットワーク／ID／脆弱性診断コンサルティングの5領域）を、40,000社超の導入実績と複数のNo.1シェア・顧客評価アワードを裏付けに、情シス・セキュリティ部門の課題解決窓口として一括で任せられる、という約束
- R-lanscope-21 Who it speaks to: 情シス担当者／セキュリティ責任者（企業のIT資産管理・エンドポイント・ID・ネットワーク・クラウド運用を担う社内組織）。ナビゲーションの製品名（IT資産管理・MDM、統合エンドポイントマネジメント、Microsoft 365監査ログ管理、IDaaS、脆弱性診断）と「課題から探す」セクションの具体的な業務課題（PC・スマホの管理、マルウェア対策、EDR構築の相談、Microsoft 365の情報漏洩対策、ヘルプデスク業務、クラウドサービスの不正利用など）から読み取れる
- R-lanscope-22 Objections answered: (1)信頼性／実績への疑問 → 40,000社導入実績＋市場シェアNo.1バッジ×2＋ITreview 6部門LEADER＋多業種のクライアントロゴ壁で回答。(2)「なぜLANSCOPEを選ぶべきか」への疑問 → 専用セクション「LANSCOPEが選ばれる6つの理由」で明示的に回答。(3)「自社の全領域をカバーできるか」への疑問 → 「MOTEXは、5つのセキュリティ領域で課題解決を支援します」の俯瞰図で回答。(4)「自分の困りごとに関係あるか」への疑問 → 「課題から探す」で個別の業務課題から製品へ直接誘導して回答
- R-lanscope-23 Proof types & placement: 数値実績（累計導入実績40,000社＝ヒーロー＋フッターCTAで反復）／受賞・ランキングバッジ（市場シェアNo.1×2、ITreview LEADER×1＝ヒーロー直下）／クライアントロゴ壁（多業種＝ヒーロー直下）／導入事例セクション（顧客写真＋社名＋一言コメント＝中盤）／脚注での出典明記（※1 MOTEX調べ、※2 テクノ・システム・リサーチ、※3 ITR、※4 ITreview＝ヒーロー直下に小さく併記）

## Copy structures that land (3–5 lines)
- R-lanscope-40 "サイバーセキュリティ任せるなラ、 ランスコープ" — structure: audience→offer (situation "誰かに任せるなら" → offer "ランスコープ" as the resolving brand name) | concrete words: none beyond the brand name itself; largely a slogan `abstract`
- R-lanscope-41 "累計導入実績 40,000 社以上" — structure: result→effect (track-record number presented as the payoff/credential) | concrete words: "40,000社"（具体的な数値と単位）
- R-lanscope-42 "MOTEXは、5つのセキュリティ領域で 課題解決を支援します" — structure: operation→result (coverage of 5 domains → outcome of "課題解決を支援") | concrete words: "5つのセキュリティ領域", "課題解決"
- R-lanscope-43 "LANSCOPEが 選ばれる6つの理由" — structure: contrast (implicit "他社ではなくLANSCOPEが選ばれる" comparative framing) | concrete words: "6つの理由"（具体的な件数）
- R-lanscope-44 "課題から探す" — structure: audience-call (invites the visitor to self-identify by their own problem rather than by product name) | concrete words: "課題"（具体的なユーザーの困りごとへの言及だが本文自体は短い誘導ラベル）`abstract`

## Visual
- R-lanscope-30 Type: H1 tag per styles.json is family `Roboto, "Noto Sans JP", メイリオ, Meiryo, "ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", Osaka, "ＭＳ Ｐゴシック", "MS PGothic", Helvetica, Arial, sans-serif`, size 14px, weight 700, color rgb(1,1,1) — note this small/plain H1 does not correspond to the large visual headline seen on screen (that display-type wordmark is tagged h2 in the DOM; the true `<h1>` text is empty, likely the header logo). Body/dominant font across the page: Roboto (weight 4568, by far the top-used family) with Noto Sans JP as the CJK fallback in the stack; secondary fonts seen in low volume: Inter (220), -apple-system (15), Oswald (12), Montserrat (6). Sans-serif throughout; no serif usage observed
- R-lanscope-31 Colour: Background base alternates white `rgb(255,255,255)` (dominant) and near-white light-gray `rgb(247,248,247)` for section striping, plus a light gray `rgb(244,244,244)`. Dark sections are used deliberately (not global dark mode): `rgb(56,56,56)`, `rgb(43,43,43)`, `rgba(34,34,34,0.87)` appear at meaningful weight — matching the dark hero carousel banner and the dark footer CTA band seen in the screenshots. Accent/CTA colours: red `rgb(230,0,18)` (primary conversion CTA, and the red category tag "エンドポイントセキュリティ"), near-black `rgb(51,51,51)` (secondary nav CTA), blue `rgb(49,116,195)` (cookie-modal accept button). Product-category colour-coding is visible in the screenshots (red／teal／green／navy／black used per one of the 5 security domains). No gradients found in styles.json (no gradient values in any list; borderRadii values present — 8px, 4px, 8px 8px 0 0, 6px, 10px — indicating flat card corners with shadow, not gradient fills). `darkMode: false` in styles.json — confirmed as a single fixed light theme, not a prefers-color-scheme dark variant
- R-lanscope-32 Density: Very high — pageHeight 11642px vs 900px viewport (≈12.9 screens per structure.json), 11+ stacked sections each dense with grids (product cards, 5-domain diagram, 6-reason grid, full product catalogue, problem-tile grid, case studies, events, news, blog/SNS links). Text length per section runs into the hundreds of characters (e.g. 課題から探す section textLength 1317). This reads as a full B2B SaaS marketing hub/hompage rather than a short single-offer landing page
- R-lanscope-33 Imagery: Product-UI screenshots inside laptop-mockup frames (e.g. IDaaS carousel banner); laurel-wreath award badge graphics (×2 "No.1", ×1 "LEADER"); real client wordmark logos (Panasonic, ポッカサッポロ, 沖縄銀行, 熊本信用金庫, 京進, MIWA, MASPRO, etc. — broad mix of verticals: manufacturing, food/beverage, broadcasting, banking, credit union, education, dental, security, electronics); simple line/flat icons for the 6-reasons grid and the 5-domain arc diagram (colour-coded per domain); stock photography for case studies (business-attire portraits, a group photo, a mascot/plant-themed shot) further down the page; an autoplaying video ad embedded as an overlay in the hero
- R-lanscope-34 Distinctive: Stacking three proof mechanisms (numeric track record + award badges + client-logo wall) immediately under the headline, before any product explanation; a live rotating product-ad carousel embedded inside the hero itself rather than below it; consistent colour-coded taxonomy for the "5つのセキュリティ領域" framework carried through the hero-adjacent diagram, the nav sub-menus, and the full product catalogue's category bars; heavy above-fold stacking of interruptive elements (cookie modal + autoplaying video ad) on both desktop and mobile at first load

## Inference (kept separate from observation)
- The hero headline reads as a brand-recall / category-leader slogan rather than a benefit or outcome claim — consistent with a Ring C, already-considered-vendor posture where the visitor already understands the product category and the job of the LP is to reassure ("if you're going to trust someone with this, it's us") rather than educate on the problem.
- Dropping the giant wordmark headline from the mobile first view (while keeping the product-ad carousel and the proof badges) suggests the team treats the carousel + numeric/award proof as higher-priority mobile real estate than the brand slogan itself — i.e. proof-first is judged to convert better than brand-statement-first when space is scarce.
- The dual-track CTA system (資料請求 vs 無料体験, repeated per product rather than once globally) implies the page is designed as a hub funneling many distinct product lines to their own dedicated conversion paths, rather than a single-offer LP with one conversion goal — a structural cue that a Ring-C-inspired page for a single narrower offer should compress this into one or two clear asks instead of mirroring the multi-product repetition.
