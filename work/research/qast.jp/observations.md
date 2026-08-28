# Observations — qast

Name: Qast / URL: https://qast.jp/ / Ring: B (adjacent — 国産ナレッジ経営/ナレッジ共有ツール, same buyer different job) / Evidence: 国内比較記事に頻出、大企業導入事例(any社) / Captured: desktop.png (1440x9855), mobile.png (390x11080), structure.json, styles.json

## First view (desktop)
- R-qast-1 Headline: "ナレッジの資産化が、 企業の未来をつくり出す"
- R-qast-2 Sub-headline: "Qastは社内に埋もれる個人の知識や経験を引き出し、 業務の効率化と企業価値の向上を実現する AIナレッジプラットフォームです。"
- R-qast-3 Headline type: outcome (企業の未来をつくり出す — a future/vision-level business outcome, not a specific capability or audience call-out)
- R-qast-4 Primary CTA: "資料をダウンロードする" (dark filled button, hero) | Secondary: "無料デモを申し込む" (outline/light button, hero). Header bar additionally carries "お役立ち資料" / "無料デモ" / "資料請求" / "お問い合わせ" as smaller top-nav CTA links.
- R-qast-5 Visual: product screenshot mockup on a desktop-monitor device frame (app UI showing dashboard/knowledge cards), positioned to the right of the headline text (text-left / image-right split layout)
- R-qast-6 Proof in first view: logos + number — company logo strip ("company-logos" image) directly below hero, paired with H2 "利用ユーザー数98,000人超！ 幅広い業界の企業様にご活用いただいています。" and disclaimer "※上記は導入企業の一例です"; both fall inside the captured above-the-fold text block (viewportHeight 900px)
- R-qast-7 Nav: top utility row = "Qast Clone" / "ナレッジマネジメント情報メディア" / "ログイン" (3 items); main nav row = "Qastとは" / "導入事例" / "お役立ち資料" / "セミナー・イベント" / "料金" (5 link-style items) plus 3 CTA-styled items "無料デモ" / "資料請求" (filled) / "お問い合わせ". CTA is present in nav (multiple: 資料請求 filled button + 無料デモ + お問い合わせ).

## First view (mobile) — differences only
- Headline and sub-headline text identical to desktop (same strings).
- CTA pair "資料をダウンロードする" / "無料デモを申し込む" stacked full-width vertically (desktop shows them as a horizontal pair alongside/under the text block).
- Layout order is text-then-image (headline → sub → 2 CTAs → device mockup image below), whereas desktop uses a side-by-side text-left/image-right split — order/arrangement differs, exact same asset.
- Header nav is collapsed to just the logo mark plus a small icon cluster at top-right; individual nav labels are not legible at capture resolution (not observable in capture whether items are hidden behind a hamburger menu or shown as icons).
- No separate mobile structure.json was captured, so section order/count for mobile is not independently verifiable — visual comparison only.

## Structure
- R-qast-10 Sections (ordered):
  1. Hero — headline/sub/2 CTA + device mockup image
  2. 導入企業ロゴ帯 + 利用ユーザー数98,000人超 (proof band)
  3. 新サービス先行登録開始(2026年秋リリース予定) — "Qast Clone" teaser box
  4. AI × 人によるナレッジマネジメントの最適解 — concept/diagram section
  5. Qastでできること — feature list (1 CTA)
  6. 導入事例 — case studies (logos, customer photos, 1 named case-study link: バンダイ; 7 images, 4 CTAs total in section)
  7. 導入効果 — result stats (3 images, e.g. numeric figures)
  8. (unlabeled CTA repeat band) — "資料をダウンロードする" / "無料デモを申し込む" pair repeated
  9. サポート体制 — support section (3 images)
  10. お客様の声 — testimonials (4 images)
  11. ナレッジマネジメント浸透への取り組み — initiatives (3 images, 3 CTAs)
  12. お知らせ — news (3 images, 4 CTAs)
  13. Footer CTA band — repeats hero headline + Qast Clone teaser + footer nav/CTA links (お役立ち資料/資料請求/無料デモ/お問い合わせ)
- R-qast-11 Section count / screens: 11 headed sections (+2 unlabeled sub-blocks) = 14 raw section entries in structure.json; total page length ≈ 10.9 screens (pageHeight 9855px ÷ viewportHeight 900px)
- R-qast-12 CTA recurrence: the "資料をダウンロードする"(document) / "無料デモを申し込む"(demo) pair repeats 3 times down the page (hero y≈387/465; mid-page band y≈5255/5345 after 導入効果; bottom band y≈8562/8652 before footer). The header link/button set (お役立ち資料/無料デモ/資料請求/お問い合わせ) repeats again in the footer (y≈9429–9509). One case-study-specific link CTA appears once (バンダイ, y≈3909). 導入事例/ナレッジマネジメント浸透/お知らせ sections each carry additional card/"すべて見る"-type CTAs (counts 4/3/4 respectively per structure.json) whose individual link texts were not captured except the バンダイ one.
- R-qast-13 Conversion ask & friction: primary ask is document request/download (資料請求 / 資料をダウンロードする) and free-demo signup (無料デモ / 無料デモを申し込む); お問い合わせ (contact) offered as a lighter-weight nav option. No "無料トライアル" (free trial) ask observed. `forms` array in structure.json is empty — there is no embedded form on the LP itself; every CTA is an `<a>` link that navigates to a separate page/domain (`/document/`, `/resources/`, `/contact/`, or externally to `https://register.qast.jp/`), so conversion always requires leaving the LP.

## Message
- R-qast-20 Core promise (paraphrase): surfacing individual employees' buried tacit knowledge/experience into a reusable company asset, thereby improving operational efficiency and raising overall corporate value, via an AI-assisted knowledge platform.
- R-qast-21 Who it speaks to: broad-industry enterprise buyers ("幅広い業界の企業様") — evidenced by the 98,000-user claim and a large-company logo wall shown in the desktop screenshot (e.g., Panasonic-style large-enterprise logos among others); case studies foreground large, established companies (Bandai case referencing 15 years of accumulated design knowledge).
- R-qast-22 Objections answered: scale/fit doubt ("will this work at a company like mine") answered via user-count + cross-industry logo proof; ROI/effectiveness doubt answered via the named Bandai case (資料探索時間を半減) and the dedicated 導入効果 stats section; rollout/adoption-support doubt answered via the サポート体制 (support system) section; general trust/credibility answered via お客様の声 (customer voice/testimonial) section.
- R-qast-23 Proof types & placement: logo wall + numeric user-count headline placed immediately after the hero (proof band, section 2); named case study with company logos/customer photos and a specific quantified outcome in 導入事例 (section 6); standalone numeric result stats in 導入効果 (section 7); direct customer quotes in お客様の声 (section 10); support-system description in サポート体制 (section 9) as a softer, non-numeric proof of post-sale service.

## Copy structures that land (3–5 lines)
- R-qast-40 "ナレッジの資産化が、 企業の未来をつくり出す" — structure: abstract | concrete words: none (資産化/未来 are abstract nouns; no concrete operation or metric) — marked `abstract`
- R-qast-41 "Qastは社内に埋もれる個人の知識や経験を引き出し、 業務の効率化と企業価値の向上を実現する AIナレッジプラットフォームです。" — structure: situation→consequence | concrete words: 個人の知識や経験, 業務の効率化, 企業価値の向上
- R-qast-42 "利用ユーザー数98,000人超！ 幅広い業界の企業様にご活用いただいています。" — structure: result→effect (numeric proof → breadth claim) | concrete words: 98,000人, 幅広い業界
- R-qast-43 "株式会社バンダイ 過去15年分の設計ナレッジを即活用。資料探索時間を半減させたQast導入事例" — structure: operation→result | concrete words: 過去15年分の設計ナレッジ, 資料探索時間を半減
- R-qast-44 "新サービス先行登録開始(2026年秋リリース予定)" — structure: audience→offer (announcement/pre-registration invite with a dated commitment) | concrete words: 先行登録, 2026年秋リリース

## Visual
- R-qast-30 Type: H1 font-family "YakuHanJP, Lato, \"Noto Sans JP\", sans-serif", size 36px, weight 700, color rgb(0,0,0). Body text sizes observed across the page: 14px/16px/15px/18px/12px/10px (14px and 16px most frequent by weighted count), all sans-serif — no serif family detected anywhere in styles.json.
- R-qast-31 Colour: background base is white (rgb(255,255,255), by far the dominant background weight); a soft pastel diagonal gradient — "linear-gradient(105deg, rgb(244,244,255), rgb(255,242,249) 50%, rgb(255,241,...)" (light blue-lavender into pale pink) — is used as a secondary section background; a solid brand blue-violet rgb(75,75,210) is used both as an accent text/link color and as a solid background (e.g., CTA repeat bands, filled buttons). darkMode flag in styles.json is false — no dark-mode variant observed.
- R-qast-32 Density: not observable in capture as a precise metric; structurally the page is long (≈10.9 screens) and divided into 11 headed sections plus repeated CTA bands, each with generous imagery (7 images in the 導入事例 section alone) — reads as section-dense but each individual section appears image/card-forward rather than text-dense (per-section textLength values mostly under 300 characters).
- R-qast-33 Imagery: hero product screenshot on a desktop-monitor device frame; a horizontal grid of partner/customer company logos; an icon-based conceptual diagram (people icons, a database icon, an "AI" icon) illustrating "AI × 人によるナレッジマネジメント"; customer case-study portrait photographs (headshots) paired with small company logos; numeric stat/card graphics in the 導入効果 section.
- R-qast-34 Distinctive: alternating white and soft pastel-gradient section backgrounds used as visual rhythm breaks; a solid blue-violet (rgb(75,75,210)) CTA band with white headline text repeated three times down the page as a recurring conversion prompt pattern; border-radius values up to 12px on cards and a 50px pill radius appear in the design tokens.

## Inference (kept separate from observation)
- The repeated blue-violet CTA band (3x) combined with zero on-page forms suggests this LP is optimized to hand off to a separate lead-capture flow (register.qast.jp / /document/) rather than to convert directly on-page — a two-step funnel.
- Leading with a 98,000-user count and a cross-industry logo wall immediately after the hero, before any feature explanation, suggests the primary first-view objection this LP is designed to pre-empt is "is this credible/adopted at scale," ahead of "what does it do."
- The "新サービス先行登録開始(2026年秋リリース予定)" teaser sitting this high on the page (section 3, above the core feature/diagram explanation) suggests a deliberate push toward a newer "Qast Clone" product line, positioned as more urgent/novel than the core Qast pitch that follows it.
