# Observations — sei-info.co.jp_quicksolution
Name / URL / ring / evidence / captured: QuickSolution (住友電工情報システム) / https://www.sei-info.co.jp/quicksolution/ / Ring A (国産エンタープライズサーチの定番) / 5,500サーバー超の導入実績を公称、ITトレンド等の比較記事・レビューサイトに常連(ITトレンドレビュー41件) / captured_at 2026-08-28T00:10:26Z

## First view (desktop)
- R-quicksol-1 Headline: Two stacked lines of copy occupy the headline position. Semantic `<h1>` (small, navy, above the big line): "QuickSolution エンタープライズサーチ". Visually dominant large blue line directly below it (not tagged h1 in structure.json, but functions as the headline): "欲しい情報がすぐに見つかる" / "企業内検索システム" (two lines, wraps as shown in capture).
- R-quicksol-2 Sub-headline: No prose sub-sentence. Instead a short connector line "＼Copilotとも連携可能／" sits above two yellow pill/badge labels that read as sub-headline claims: "生成AI連携(RAG)" and "AIエージェント連携(MCP)".
- R-quicksol-3 Headline type: outcome (states the user benefit "欲しい情報がすぐに見つかる" before naming the product category "企業内検索システム").
- R-quicksol-4 Primary CTA: "お問い合わせ／資料請求" (orange button, also duplicated in the sticky header nav) | Secondary: "トライアル" (white button with orange border/text, directly below primary).
- R-quicksol-5 Visual: Right-hand product screenshot (search UI mockup showing a folder tree, file list with thumbnails, and an "AI Chat" control), overlaid with a dark-navy pill badge "オンプレ/クラウドの横断検索＋生成AI回答". Below/behind the screenshot sits a gold circular award-seal graphic "10年連続 シェアNo.1" (富士キメラ総研 検索エンジン パッケージ市場) and a dark-navy stat badge "発売から25周年 導入実績5,700サーバ以上".
- R-quicksol-6 Proof in first view: number + rating-style badge + logos. Numeric/tenure claims ("発売から25周年", "導入実績5,700サーバ以上"), a third-party ranking badge ("10年連続シェアNo.1", cited to 富士キメラ総研), and — within the same 900px fold — a client-logo row (DENSO, SUBARU, 大成建設, OMRON, EPSON, 群馬銀行, COSMO, JTEKT, FUJIFILM, 今治造船, SHIMADZU, oilio, etc.).
- R-quicksol-7 Nav: Two-tier nav. Top thin masthead bar: 4 items (ホーム, 製品情報, 会社情報, 採用情報), no CTA in this row. Below it, a product-level nav bar with 9 links (特長, エンタープライズサーチの選び方, 機能, 生成AI連携, 事例, 価格, サポート, よくある質問, セミナー) plus one CTA-styled button ("お問い合わせ／資料請求") at the far right — 14 total items across both rows per structure.json `nav`, with the CTA present in nav.

## First view (mobile) — differences only
- Nav collapses to logo + hamburger icon only (no visible link list until opened); the two-tier desktop nav is not shown inline.
- Layout stacks vertically: eyebrow line → big blue headline → yellow badge line → connector text → screenshot image → gold award seal → navy stat badge → primary CTA button → secondary CTA button → logo row — all full-width, in that order (desktop places the screenshot/badges to the right of the headline instead of below it).
- Client-logo row wraps to fewer logos per row (observed: 大成建設, OMRON, EPSON, 群馬銀行 before the fold ends) rather than desktop's single wide row.
- Otherwise headline, sub-badges, and CTA copy are identical verbatim to desktop.

## Structure
- R-quicksol-10 Sections (ordered):
  1. Hero — headline, CTA pair, product screenshot, award/stat badges, client-logo row
  2. QuickSolutionの特長 — hub-and-spoke capability diagram + 4 numbered feature cards
  3. QuickSolutionで解決できること — 3 outcome pillars (ナレッジマネジメント／業務効率化／DX推進)
  4. エンタープライズサーチ製品の選び方 — buying-criteria teaser + spec table (対応容量／検索対象／先進機能／セキュリティー)
  5. 機能 — functions grid/list
  6. 導入事例 — expanded client-logo wall + 3 quantified case-study cards
  7. 価格とライセンス — 5-grade pricing/license table + support blurb
  8. お客さまのお困りごとに専門スタッフが迅速に対応します — support/CS reassurance callout
  9. よくある質問 — FAQ accordion (data formats, result display, 動作環境) with embedded OS/browser requirement tables
  10. セミナー — 4 webinar listings, each with its own CTA
  11. イベント・展示会 — events/exhibition listing
  12. 簡単な製品説明をご希望の場合でも お気軽にお問い合わせください — mid/final CTA triad (お問い合わせ／資料請求／トライアル)
  13. コラム — 3 blog articles
  14. ニュース — news list
  15. Footer — sitemap nav + related-product links (Framework3, Workflow3, Document3, SupportSite, View3)
- R-quicksol-11 Section count / screens: 13 body sections per structure.json `sections` (excl. footer) across 13.8 screens (pageHeight 12389px ÷ viewportHeight 900px).
- R-quicksol-12 CTA recurrence: Primary label "お問い合わせ／資料請求" recurs 3× (sticky header, hero, footer-area final CTA block) plus a same-destination "問い合わせする" variant in the final CTA triad — same href throughout (rkhp0020?no=9300). "ウェビナーに申し込む" recurs 3× inside the セミナー section (all same href, rkhp0010?no=960). Footer adds two more distinct soft CTAs ("資料ダウンロード", "トライアル申し込み").
- R-quicksol-13 Conversion ask & friction: Primary ask is 資料請求／お問い合わせ (contact-or-document-request bundled as one CTA); secondary ask is トライアル (leads to a separate `/quicksolution/demo/` page); tertiary is セミナー申込 (webinar signup). structure.json reports `"forms": []` — no inline lead-capture form is embedded on the LP itself; every CTA is a link off-page (either to an external `rkcmServlet` reservation/contact system or to another site path), so conversion requires at least one additional page load before any form is seen.

## Message
- R-quicksol-20 Core promise (paraphrase): 社内に散在する情報(ファイルサーバー、クラウドサービス、Webサイト、独自システム等)を高速・高精度に横断検索でき、生成AI連携(RAG)によってその場で質問応答まで行える、"インターネット検索の社内版"。
- R-quicksol-21 Who it speaks to: 大企業〜中堅企業の情報システム部門／ナレッジマネジメント・DX推進担当者。事例掲載企業がDENSO・SUBARU・OMRON・EPSON・JTEKT・FUJIFILM・大成建設など製造業・重工業中心の大手法人であることから、BtoB大企業のバックオフィス／情シス担当者向けと読み取れる。
- R-quicksol-22 Objections answered:
  - 大量データでの性能: 「社内ファイルサーバからクラウドまで 高速・高精度に横断検索」「対応容量 〜数百TB」
  - 日本語・非テキスト検索の精度: 「複雑な日本語や画像内の文字情報も検索可能」(セマンティック検索・画像OCR検索)
  - 生成AI/エージェント最新動向への対応: 「生成AI連携(RAG)に対応、CopilotなどのAIエージェントとも連携可能」「MCPにも対応」
  - サポート不安: 「純国産製品の強みを活かした安心のサポート体制」「当社製品部門が迅速に対応」
  - 価格の不透明さ: 「用途に合わせて選べるライセンスとモデル」(Grade200〜GradeMaxの5段階表)
  - 技術要件の確認: FAQ内にサーバOS(Windows Server 2016〜2025 / RHEL 8-9-10)・ソフトウェア・ブラウザ対応表
- R-quicksol-23 Proof types & placement: 数値・社歴の権威付け(「発売から25周年」「導入実績5,700サーバ以上」)はヒーロー内バッジと導入事例セクション見出し直下の2箇所で反復。第三者ランキング(「10年連続シェアNo.1」、富士キメラ総研 検索エンジンパッケージ市場)はヒーロー内の金色シールのみ。ロゴウォールはヒーロー直下(ファーストビュー内)と導入事例セクション冒頭の2箇所で反復、20社超のロゴ。定量化事例(3枚のカード: 200TB／月1,000万円相当の人件費削減、220TB・1億3,600万件)は導入事例セクション下段に配置。

## Copy structures that land (3–5 lines)
- R-quicksol-40 "欲しい情報がすぐに見つかる 企業内検索システム" — structure: result→effect (欲しい情報がすぐ見つかるという結果 → 企業内検索システムという製品カテゴリの提示) | concrete words: 欲しい情報, すぐに見つかる, 企業内検索システム
- R-quicksol-41 "社内ファイルサーバからクラウドまで 高速・高精度に横断検索" — structure: operation→result (検索対象範囲の明示 → 横断検索という操作とその速度・精度という結果を一体化) | concrete words: 社内ファイルサーバ, クラウド, 高速, 高精度, 横断検索
- R-quicksol-42 "全文検索×生成AIで、200TBの知見を現場で活かす。月1,000万円相当の人件費削減効果とナレッジ継承を実現。" — structure: operation→result (施策の組み合わせ → 定量化された効果) | concrete words: 全文検索, 生成AI, 200TB, 月1,000万円, 人件費削減, ナレッジ継承
- R-quicksol-43 "220TB、1億3,600万件のファイルサーバから必要とする情報を素早く検索。働き方改革推進のための生産性向上を実現。" — structure: situation→consequence (膨大なデータ量という状況 → 素早い検索・生産性向上という帰結) | concrete words: 220TB, 1億3,600万件, ファイルサーバ, 素早く検索, 生産性向上
- R-quicksol-44 "純国産製品の強みを活かした安心のサポート体制" — structure: contrast (暗に外資製品との対比を示唆し、純国産であることを安心材料として提示) | concrete words: 純国産, サポート体制 — note: "安心" itself is abstract/評価語で、具体的なサポート内容(SLAや対応時間等)はこの見出し単体には無い

## Visual
- R-quicksol-30 Type: H1 (semantic, small eyebrow text) family "Verdana, \"Hiragino Kaku Gothic ProN\", \"Hiragino Sans\", Meiryo, sans-serif", size 16px, weight 700, color rgb(11,49,143). Note: this semantic h1 is NOT the visually dominant headline — the large ~32px blue two-line headline ("欲しい情報がすぐに見つかる／企業内検索システム") is a separately styled element outside the headings list. Body/dominant font family across the page: Verdana (only family entry recorded, weight 3118) with the same Japanese sans fallback stack — sans-serif throughout, no serif observed.
- R-quicksol-31 Colour: Background base alternates white rgb(255,255,255) (heaviest weight) and pale blue-gray rgb(237,245,250) (near-equal weight, used for banding between sections), with rgb(248,248,248) light gray and rgb(255,250,228) pale yellow (badge backgrounds) as minor bases. Accent: orange rgb(255,142,49) for primary CTAs; navy rgb(11,49,143) for headings/product name; dark navy rgb(10,22,46) for header/footer bands. Gradients present: `linear-gradient(rgb(237,245,250) 80%, rgba(0,0,0,0) 100%)` (soft fade-out panel background) and `linear-gradient(90deg, rgb(10,22,46), rgb(10,22,46))` (flat-color band, same navy at both stops). styles.json flags `darkMode: true`, but no user-facing dark-mode toggle was observed in the captures — this likely reflects the dark-navy header/footer bands being picked up as a "dark" background bucket rather than a switchable theme.
- R-quicksol-32 Density: High/dense — 13.8 screens, 13+ sections, heavy use of tables (spec comparison, 5-grade pricing, FAQ server/client requirement tables) and multi-card grids (4 feature cards, 3 use-case pillars, 3 case-study cards, 4 webinar cards), plus two separate client-logo walls.
- R-quicksol-33 Imagery: Product UI screenshot (search results mockup with folder tree/file list/AI Chat panel), an abstract radial hub-and-spoke line-icon diagram (QuickSolution at center connected to Webサイト／クラウドサービス／ワークフローシステム／文書管理システム／独自システム／ファイルサーバ／グループウェア), vector/photographic client-company logos (repeated twice), simple line icons for feature/FAQ/CTA-card labels, small photo/illustration thumbnails for コラム articles.
- R-quicksol-34 Distinctive: The centered hub-and-spoke diagram literally placing "QuickSolution" as the hub connected to 7 labeled data-source icons inside a light-blue circular band, captioned "インターネット検索の社内版"; the gold circular "10年連続シェアNo.1" award-seal graphic; and the double appearance of a wide, uncropped client-logo wall (once in the fold, once again heading the 導入事例 section).

## Inference (kept separate from observation)
- The semantic `<h1>` being a tiny 16px eyebrow line while the true headline is an untagged large div suggests SEO/heading semantics were treated as secondary to the visual hierarchy during redesign.
- Two logo walls plus a repeated tenure/server-count stat and a decade-long ranking badge read as a deliberate "incumbent/safe-choice" positioning strategy aimed at risk-averse enterprise IT buyers rather than a speed- or price-led pitch.
- The absence of any inline form (forms: []) alongside three parallel CTAs (問い合わせ／資料請求／トライアル) implies the LP's job is to route visitors into an external CRM/reservation flow rather than to convert on-page — consistent with a considered, sales-assisted enterprise buying process.
