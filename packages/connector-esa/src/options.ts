/**
 * 設定値の検証ヘルパ。誤設定は構築時に拒否する(黙って既定値に倒さない)。
 * メッセージには設定名と許容範囲のみを含め、受領値はエコーしない。
 */
export function integerOption(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
