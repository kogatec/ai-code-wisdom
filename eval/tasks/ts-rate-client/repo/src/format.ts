/** レートを小数 4 桁までの文字列にする（例：150.25 → "150.25"、1 / 3 → "0.3333"）。 */
export function formatRate(rate: number): string {
  return String(Math.round(rate * 10_000) / 10_000);
}
