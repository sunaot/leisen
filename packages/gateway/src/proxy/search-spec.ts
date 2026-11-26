/**
 * コネクタの検索の仕様の静的な宣言(Connector.searchSpec)の読み取り(connector-sdk v0.7、
 * ADR-017 追補 1 の B-2、同「セキュリティレビューの記録」M-2・m-6)。
 *
 * - 起動時に 1 回だけ読む(Gateway のコンストラクタと、起動コードの buildConnector)。Gateway は
 *   読んだ値を保持し、describe の射影ではその値だけを付ける(後からプロパティを書き換えても、
 *   describe の戻り値に searchSpec を入れても、出力は変わらない)
 * - 値はデータプロパティの記述子(Object.getOwnPropertyDescriptor)から取り出す。getter などの
 *   accessor は、呼ばれるたびに違う値(利用者・時刻で変わる値)を返せるため拒否する。プロトタイプに
 *   ある宣言も拒否する(クラスのフィールドかオブジェクトリテラルで、インスタンス自身に宣言する)
 * - 値の検査は connector-sdk の checkSearchSpec(Orchestrator と同じ唯一の実装。m-3)
 * - 拒否の理由の文には値を入れない(規則の名前・位置・コードポイントだけ。m-6)
 */
import { checkSearchSpec, describeSearchSpecViolation } from "@leisen/connector-sdk";

const SEARCH_SPEC_KEY = "searchSpec";

export type SearchSpecDeclaration =
  /** value が undefined なら宣言なし(プロパティがない・undefined・空文字) */
  | { readonly ok: true; readonly value: string | undefined }
  /** reason は値を含まない英語の短い文 */
  | { readonly ok: false; readonly reason: string };

/** プロトタイプの連鎖から searchSpec の記述子を探す(自身のものかどうかも返す)。 */
function findDescriptor(
  target: object,
): { readonly descriptor: PropertyDescriptor; readonly own: boolean } | undefined {
  let current: object | null = target;
  let own = true;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, SEARCH_SPEC_KEY);
    if (descriptor !== undefined) {
      return { descriptor, own };
    }
    current = Object.getPrototypeOf(current) as object | null;
    own = false;
  }
  return undefined;
}

/**
 * コネクタ実体の searchSpec の宣言を読み、検査する。プロパティを読むのは記述子の取得だけで、
 * getter を呼ばない。
 */
export function readSearchSpecDeclaration(connector: object): SearchSpecDeclaration {
  const found = findDescriptor(connector);
  if (found === undefined) {
    return { ok: true, value: undefined };
  }
  const { descriptor, own } = found;
  if (!("value" in descriptor)) {
    return {
      ok: false,
      reason: "accessor (searchSpec must be a data property, not a getter or setter)",
    };
  }
  if (!own) {
    if (descriptor.value === undefined) {
      return { ok: true, value: undefined };
    }
    return {
      ok: false,
      reason: "inherited (searchSpec must be declared on the connector instance itself)",
    };
  }
  const check = checkSearchSpec(descriptor.value);
  return check.ok
    ? { ok: true, value: check.value }
    : { ok: false, reason: describeSearchSpecViolation(check.violation) };
}
