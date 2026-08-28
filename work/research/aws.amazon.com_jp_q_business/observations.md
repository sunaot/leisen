# Observations — awsq
Name: Amazon Q Business (AWS) / URL: https://aws.amazon.com/jp/q/business/ / Ring: A (hyperscaler AI enterprise search/assistant), diversity pick (different price tier / distribution model) / Evidence: AWS scale, listed in enterprise search comparisons / Captured: desktop.png, mobile.png, structure.json, styles.json (this repo, work/research/aws.amazon.com_jp_q_business/)

## First view (desktop)
- R-awsq-1 Headline (H1): "Amazon Q Business"
- R-awsq-2 Sub-headline: "Amazon Q Business を利用して、職場で生成 AI の力を解き放ちましょう"
- R-awsq-3 Headline type: H1 is the bare product name ("other" — brand label, not a claim). The sub-headline that carries the actual promise reads as capability/outcome-adjacent but is abstract ("生成 AI の力を解き放つ" = "unleash the power of generative AI") rather than a concrete outcome claim.
- R-awsq-4 Primary CTA: "Amazon Q Business を今すぐ開始する" (filled dark pill button) | Secondary: "スペシャリストとつながる" (outline pill button)
- R-awsq-5 Visual: right-side product screenshot/illustration — a woman at a laptop with a purple hexagonal "Q" logo icon and a chat panel overlaid showing an assistant reply ("I'm Amazon Q, your AI assistant. Ask me anything...") and three suggested-prompt chips ("Draft a press release and a blog", "Summarize key trends from our sales pipeline", "Create an app to generate our weekly newsletter") in English even though the page is Japanese. Background is a light blue-to-white gradient.
- R-awsq-6 Proof in first view: none (no logos, stats, or customer names above the fold — proof appears later, in the customer/case-study section and the "統合" partner-connector graphic).
- R-awsq-7 Nav: Utility bar (5 items: 日本語, お問い合わせ, AWS Marketplace, サポート, マイアカウント). Main nav row: AWS logo + re:Invent, AWS について知る, 製品, ソリューション, 料金, リソース, 検索, コンソールにサインイン, and a filled CTA button "アカウントの作成" — so yes, CTA in nav. Below that, a product-level sub-nav bar with 4 tabs (概要 / 統合 / 料金 / よくある質問, "概要" active) plus a breadcrumb "生成 AI > Amazon Q > Q Business".

## First view (mobile) — differences only
- Nav collapses to a hamburger icon + centered AWS logo + search icon + account icon (utility bar, main nav links, and the 4-tab product sub-nav are all hidden behind the hamburger / a single dropdown "Amazon Q Business ⌄").
- Breadcrumb shortens to 2 levels ("Amazon Q > Q Business"); the "生成 AI >" top level is not shown.
- Headline, sub-headline, both CTA buttons, and the assistant-screenshot visual are unchanged in text and stack in the same order, full-width, one column.
- The suggested-prompt chips under the chat bubble wrap onto more lines due to narrower width but text is unchanged.

## Structure
- R-awsq-10 Sections (ordered):
  1. Header/nav + breadcrumb
  2. Hero: H1 + sub-headline + 2 CTAs + assistant screenshot
  3. "Amazon Q Business の次の進化" — video/product callout for "Amazon Quick Suite" (successor product) + "Quick にアクセス" link
  4. "Amazon Q Business" — short intro paragraph + product icon graphic
  5. "機能" (Features) — 4-tab pill selector (統合インサイト / アプリケーションを作成 / タスクを完了 / ワークフローを自動化) with detail copy + a "Connects to Box / Zendesk / Jira / Microsoft Sharepoint / Web Crawler" connector-name graphic
  6. "ユースケース" (Use cases) — 5-item accordion list
  7. "セキュリティとプライバシーを念頭に置いてゼロから構築" — 2 sub-blocks: ロールベースの権限 / トピックのフィルタリング
  8. "Amazon Q in QuickSight を使用する" — cross-sell block with "Ask a question about software sales" mini product screenshot
  9. "料金プラン" — short pricing paragraph + link to pricing page
  10. "Amazon Q Business のよくある質問" — 4-item FAQ accordion
  11. "Amazon Q Business で従業員が力を発揮できるようにしているお客様" — customer case-study carousel (Deriv shown; Smartsheet, Bayer Crop Science referenced in headings JSON) + "すべてのお客様を表示" link
  12. "Amazon Q Business を開始する" — 2 link cards (機能を詳しく見る / 料金の詳細を見る)
  13. Feedback banner: "今日お探しの情報は見つかりましたか?" (はい/いいえ)
  14. Footer: 4 link columns (学ぶ / リソース / デベロッパー / ヘルプ) + language selector + "お問い合わせ" + "先頭に戻る"
- R-awsq-11 Section count / screens: 14 labeled sections across a page ~9236px tall at 900px viewport → 10.3 screens (per structure.json `screens`).
- R-awsq-12 CTA recurrence: Primary "開始する" (get started) CTA appears in hero, and again as the section-13 "Amazon Q Business を開始する" link cards; "スペシャリストとつながる" appears once (hero only, not observed recurring later in captured headings/CTAs). Many in-page CTAs are actually accordion/tab toggles (機能, ユースケース, よくある質問 items are counted as "ctas" in structure.json but are disclosure controls, not conversion buttons) — total raw CTA-tagged elements: 41 in the main content section + 48 in the footer/"学ぶ" section per structure.json, but true conversion CTAs are few (get started / contact / sign in / create account).
- R-awsq-13 Conversion ask & friction: No lead-gen form on the page itself (the only "form" detected is the product sub-nav search box "探しているのは..."). Conversion path is external: click "今すぐ開始する" → presumably AWS console/sign-up flow (not captured here). Low on-page friction (no email gate, no multi-field form observed), but the path requires an AWS account/console sign-in, which is a real-world friction point not visible in this capture.

## Message
- R-awsq-20 Core promise (paraphrase): Amazon Q Business is a generative-AI assistant that connects to a company's existing systems/data (documents, apps, databases, data warehouses) so employees can search, get cited answers, create content, automate workflows, and take actions inside their everyday work tools — positioned as being succeeded by/evolving into "Amazon Quick Suite."
- R-awsq-21 Who it speaks to: Not segmented by role/industry in first view or body copy — generic "職場" (the workplace) / "従業員" (employees); one FAQ item explicitly speaks to a second audience, software providers ("ソフトウェアプロバイダーは Amazon Q Business をどのように活用できますか?").
- R-awsq-22 Objections answered: Trust/accuracy — "結果には、透明性を高めるために引用や参考文献が含まれています" (results include citations for transparency). Security/access control — "既存のアイデンティティ、ロール、権限を理解および尊重できます" (role-based permissions) and topic/keyword filtering for admin control. Cost — concrete starting price "ユーザーあたり月額わずか 3 USD で始められます". Integration breadth — named connector list (Box, Zendesk, Jira, Microsoft Sharepoint, Web Crawler) and named apps (Microsoft Edge, Google Chrome, Firefox, Slack, Outlook, Word for Microsoft 365, Microsoft Teams).
- R-awsq-23 Proof types & placement: (1) Named third-party integration/connector logos-as-text mid-page (機能 section). (2) Customer case-study carousel near the bottom with a quantified result ("Deriv が Amazon Q Business でオンボーディング時間を 45% 短縮") and additional named customers in headings (Smartsheet, Bayer Crop Science). No above-the-fold proof; no star ratings, review counts, or analyst-badge proof observed in this capture.

## Copy structures that land (3–5 lines)
- R-awsq-40 "Deriv が Amazon Q Business でオンボーディング時間を 45% 短縮" — structure: operation→result (named customer + quantified metric) | concrete words: Deriv, 45%, オンボーディング時間
- R-awsq-41 "ユーザーあたり月額わずか 3 USD で始められます" — structure: result→effect (concrete price as the "effect" of adopting) | concrete words: ユーザーあたり, 月額, 3 USD
- R-awsq-42 "システムやデータ全体で統合的に検索" — structure: operation→result (feature heading stated as an action + its scope) | concrete words: システム, データ, 統合的に検索
- R-awsq-43 "結果には、透明性を高めるために引用や参考文献が含まれています" — structure: operation→result (mechanism stated, then the trust benefit) | concrete words: 引用, 参考文献, 透明性
- R-awsq-44 "Amazon Q Business を利用して、職場で生成 AI の力を解き放ちましょう" — structure: audience→offer, `abstract` (metaphorical "力を解き放つ" = unleash power; no concrete noun/verb pairing to a specific task or number)

## Visual
- R-awsq-30 Type: H1 font family "Amazon Ember Display" (fallback "Amazon Ember", Helvetica Neue, Helvetica, Arial, sans-serif), 40px, weight 500, color rgb(22, 29, 38). Body/UI text predominantly sans-serif (Amazon Ember Display family with Hiragino Kaku Gothic Pro / ヒラギノ角ゴ Pro W3 as Japanese fallback); most common body sizes are 16px and 14px; a monospace face ("Amazon Ember Mono") appears rarely (weight 7, likely code/price snippets). No serif usage observed.
- R-awsq-31 Colour: Base background is white (rgb(255,255,255)). A dark navy/near-black is used for the top utility bar and footer (rgb(15,20,26) / rgb(51,56,67)). Primary text color rgb(35,43,55) (body/nav), headings rgb(22,29,38). A muted gray rgb(164,164,173) is used for footer/secondary text, and light gray rgb(243,243,247)/rgb(222,222,227) for panel backgrounds and borders. Accent/link blue is rgb(0,108,224) (lowest-weight color, used sparingly for links/active states). Gradients present: a radial dark overlay (used over photo/hero panels), a cyan-to-blue linear gradient and a soft radial white-glow gradient (used in the pink/purple-to-cyan "今日お探しの情報は見つかりましたか?" feedback banner and the "Connects to" glow graphic), and a purple/blue hero background gradient in the hero visual. styles.json flags darkMode:true, corresponding to the dark nav/footer bands rather than a full-page dark theme or user-toggleable mode.
- R-awsq-32 Density: Low-to-medium text density — most sections are short paragraphs (3-6 lines) or accordion/tab lists (feature and use-case detail is hidden behind click-to-expand), with generous white space between the 14 sections across ~10 screens.
- R-awsq-33 Imagery: Mix of (a) a staged photo of a person at a laptop with an overlaid chat-UI screenshot (hero), (b) an abstract product-icon graphic (purple hexagonal "Q"/lightning-bolt logo) used repeatedly, (c) a laptop-with-screen product shot for "Amazon Quick Suite", (d) a small product-UI mockup for "Amazon Q in QuickSight" ("Ask a question about software sales"), and (e) a real city-skyline photograph as the background for the Deriv customer case-study card, with the "deriv" wordmark logo overlaid.
- R-awsq-34 Distinctive: The "Connects to Box / Zendesk / Jira / Microsoft Sharepoint / Web Crawler" element renders partner/connector names as large stacked text (not logo marks) faded in/out over a soft gradient glow, rather than a conventional logo-bar. Border radii used are notably large/pill-shaped (8px common; 24-40px for buttons/cards).

## Inference (kept separate from observation)
- The hero deliberately withholds concrete outcome numbers and proof, leaning on brand trust (AWS/Amazon name) and a broad "unleash AI power" promise — proof and specificity are deferred to mid/lower sections (connectors, security, pricing, case study).
- Surfacing "Amazon Q Business の次の進化" (successor product "Amazon Quick Suite") directly under the hero, before the product's own features/use-cases, suggests the page is maning a mid-lifecycle transition and hedging identity between the current product and its replacement.
- The English-language suggested-prompt chips inside an otherwise fully-localized Japanese page look like an un-localized shared screenshot asset, not a deliberate bilingual choice.
