/**
 * 乱数の種を固定した合成コーパスの生成(開発用コネクタ dev-fixture の評価用)。
 *
 * 検索の適合率の問題は、同じ語を含む無関係な文書が多数あるときに現れる。手で書いた正解文書
 * (examples/fixtures/*.yaml)に、ここで生成した「同じ語を含むが質問の答えにならない文書」
 * (議事録・週報・問い合わせ・pull request・コード・お知らせ)を足して規模を作る。
 *
 * - 決定的: 同じ seed と count からは常に同じ文書列を返す(mulberry32。Math.random を使わない)
 * - 内容は架空の社内文書(日本語)。実在の会社名・個人名・秘密情報を含めない(人は部署・チーム名
 *   だけで表す。URL は予約ドメイン example.test)
 * - 生成した文書は質問の正解にしない。答えられない質問(examples/eval/search-questions.json の
 *   mustNotAppear)の語を含めないことはテストで確かめる
 * - documentId は noise-0001 形式(正解文書と衝突しない接頭辞)
 */
import type { DevFixtureDocumentKind } from "./search-modes.js";

/** 生成できる文書数の上限(評価の規模として十分な数百〜数千件)。 */
export const MAX_SYNTHETIC_DOCUMENTS = 5000;
/** 生成した文書の documentId の接頭辞。 */
export const SYNTHETIC_ID_PREFIX = "noise-";

export interface SyntheticCorpusOptions {
  readonly seed: number;
  readonly count: number;
}

/** 生成する文書(fixture-connector の DevFixtureDocument と同じ形)。 */
export interface SyntheticDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly url: string;
  readonly container: string;
  readonly author: string;
  readonly updatedAt: string;
  readonly kind: DevFixtureDocumentKind;
}

/** mulberry32(32 ビットの種から [0, 1) の列を作る)。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TEAMS: readonly { readonly name: string; readonly container: string }[] = [
  { name: "第1開発チーム", container: "開発" },
  { name: "第2開発チーム", container: "開発" },
  { name: "基盤チーム", container: "開発" },
  { name: "勤怠チーム", container: "開発" },
  { name: "経理チーム", container: "総務" },
  { name: "総務チーム", container: "総務" },
  { name: "人事チーム", container: "人事" },
  { name: "情報システムチーム", container: "情報システム" },
  { name: "営業企画チーム", container: "経営企画" },
  { name: "品質管理チーム", container: "ナレッジ" },
];

/** 正解文書と語を共有する話題(答えにはならない文脈で使う)。 */
const TOPICS: readonly string[] = [
  "経費精算システム",
  "経費精算",
  "VPN",
  "VPN 接続",
  "勤怠システム",
  "勤怠 CSV 出力",
  "出張手配システム",
  "出張精算",
  "社内ポータル",
  "障害対応",
  "障害報告書",
  "休暇の申請",
  "有給休暇",
  "在宅勤務",
  "アカウント発行",
  "入社手続き",
  "入社チェックリスト",
  "複合機",
  "貸与PC",
  "PC の修理",
  "代替機の在庫",
  "情報セキュリティ規程",
  "検索",
  "キャッシュ",
  "バッチ処理",
  "リトライ",
  "引き継ぎ",
  "承認フロー",
  "テンプレート",
  "議事録の共有",
];

const STATUSES: readonly string[] = [
  "の進捗を共有した",
  "の課題を洗い出した",
  "の改善案を検討した",
  "の問い合わせ件数を確認した",
  "の担当を決めた",
  "の見直しを継続して検討する",
  "の画面の改修方針を確認した",
  "の利用状況を報告した",
];

const ACTIONS: readonly string[] = [
  "論点を整理する",
  "見積もりを出す",
  "関係部署に確認する",
  "資料を更新する",
  "試験環境で確認する",
  "次回の議題に入れる",
];

const SYMPTOMS: readonly string[] = [
  "表示が遅い",
  "ボタンが押せないことがある",
  "エラーが出ることがある",
  "文字化けする",
  "検索結果が古い",
  "ログインに時間がかかる",
];

const FIXES: readonly string[] = [
  "表示崩れを修正",
  "エラー処理を整理",
  "ログ出力を追加",
  "設定値の読み込みを修正",
  "テストを追加",
  "不要なコードを削除",
];

const EVENTS: readonly string[] = [
  "定期メンテナンス",
  "画面の変更",
  "利用ルールの改定",
  "説明会",
  "アンケート",
];

const MODULES: readonly string[] = [
  "expense",
  "attendance",
  "travel",
  "portal",
  "search",
  "batch",
  "account",
  "incident",
];

const FILES: readonly string[] = ["handler", "service", "client", "config", "util", "report"];

/** 生成する日付の範囲(2025-01-01〜2026-11-20、日本時間) */
const DATE_FROM_MS = Date.UTC(2025, 0, 1);
const DATE_DAYS = 689;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * 合成コーパスを生成する。同じ seed と count からは常に同じ文書列を返す。count は 1〜
 * MAX_SYNTHETIC_DOCUMENTS(範囲外は RangeError)。
 */
export function generateSyntheticCorpus(options: SyntheticCorpusOptions): SyntheticDocument[] {
  const { seed, count } = options;
  if (!Number.isInteger(count) || count < 1 || count > MAX_SYNTHETIC_DOCUMENTS) {
    throw new RangeError(`count must be an integer in 1..${MAX_SYNTHETIC_DOCUMENTS}`);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("seed must be an unsigned 32-bit integer");
  }
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const width = String(MAX_SYNTHETIC_DOCUMENTS).length;
  const documents: SyntheticDocument[] = [];
  for (let index = 1; index <= count; index += 1) {
    const team = pick(TEAMS);
    const topic = pick(TOPICS);
    const other = pick(TOPICS);
    const day = new Date(DATE_FROM_MS + Math.floor(random() * DATE_DAYS) * 86_400_000);
    const ymd = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1, 2)}-${pad(day.getUTCDate(), 2)}`;
    const ymdJa = `${day.getUTCFullYear()}年${day.getUTCMonth() + 1}月${day.getUTCDate()}日`;
    const hour = 9 + Math.floor(random() * 9);
    const updatedAt = `${ymd}T${pad(hour, 2)}:00:00+09:00`;
    const id = `${SYNTHETIC_ID_PREFIX}${pad(index, width)}`;
    const shape = Math.floor(random() * 6);
    let kind: DevFixtureDocumentKind = "issue";
    let title: string;
    let content: string;
    switch (shape) {
      case 0:
        title = `${team.name}定例 議事録 ${ymd}`;
        content =
          `日時: ${ymdJa}。出席: ${team.name}のメンバー。` +
          `議題1: ${topic}${pick(STATUSES)}。議題2: ${other}${pick(STATUSES)}。` +
          `次回までに${topic}について${pick(ACTIONS)}。`;
        break;
      case 1:
        title = `週報 ${team.name} ${ymd}`;
        content =
          `今週は${topic}${pick(STATUSES)}。あわせて${other}${pick(STATUSES)}。` +
          `来週は${pick(ACTIONS)}予定。特記事項なし。`;
        break;
      case 2:
        title = `[問い合わせ] ${topic}で${pick(SYMPTOMS)}`;
        content =
          `問い合わせ: ${topic}を使っていると${pick(SYMPTOMS)}。発生日: ${ymdJa}。` +
          `対応状況: ${team.name}が調査中。${other}との関係は未確認。`;
        break;
      case 3: {
        kind = "pull_request";
        // 番号は 1000〜1899(手書きの正解文書の #1287 とは重ねない。番号は一意なので)
        const drawn = 1000 + Math.floor(random() * 900);
        const number = drawn === 1287 ? 1899 : drawn;
        title = `#${number} ${topic}の${pick(FIXES)}`;
        content =
          `${topic}の${pick(FIXES)}した。${other}への影響はない。` +
          `レビュー観点: 既存の${topic}の挙動が変わらないこと。`;
        break;
      }
      case 4: {
        kind = "code";
        const module = pick(MODULES);
        const file = pick(FILES);
        title = `src/${module}/${file}-${pad(index, width)}.ts`;
        content =
          `// ${topic}の${file}(${team.name})\n` +
          `// TODO: ${other}の扱いを${pick(ACTIONS).replace(/する$/u, "")}こと\n` +
          `export function ${module}${file[0]?.toUpperCase() ?? ""}${file.slice(1)}${index}() {\n` +
          `  return "${module}";\n}`;
        break;
      }
      default:
        title = `お知らせ: ${topic}の${pick(EVENTS)}(${ymd})`;
        content =
          `${ymdJa}に${topic}の${pick(EVENTS)}を行います。期間中は${other}の一部の機能が使えない` +
          `ことがあります。詳細は${team.name}までお問い合わせください。`;
        break;
    }
    documents.push({
      id,
      title,
      content,
      url: `https://intranet.example.test/noise/${pad(index, width)}`,
      container: team.container,
      author: team.name,
      updatedAt,
      kind,
    });
  }
  return documents;
}
