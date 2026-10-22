/** 円の金額を 3 桁区切りの文字列にする（例：12345 → "¥12,345"）。 */
export function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}
