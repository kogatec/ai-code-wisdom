export type Rank = "regular" | "silver" | "gold";

export interface Item {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export interface Customer {
  rank: Rank;
}

export interface Invoice {
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
}

const BULK_QUANTITY = 10;
const BULK_DISCOUNT_PERCENT = 3;
const RANK_DISCOUNT_PERCENT: Record<Rank, number> = { regular: 0, silver: 5, gold: 10 };

const WELCOME_COUPON = "WELCOME";
const WELCOME_MIN_SUBTOTAL = 3000;
const WELCOME_DISCOUNT = 500;

const FREE_SHIPPING_FROM = 5000;
const SHIPPING_FEE = 600;

// 割引の途中計算は「1 円の 1 / 10000」を単位にした整数で行い、% の計算で浮動小数点の誤差を出さない。
// 割引は 2 段（数量・会員）まで % で、どちらも 100 で割り切れる範囲に収まる。
const UNITS_PER_YEN = 10_000;

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} は 0 以上の整数にしてください`);
  }
}

function sumSubtotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

function percentOff(units: number, percent: number): number {
  return (units * (100 - percent)) / 100;
}

function itemUnitsAfterBulkDiscount(item: Item): number {
  const units = item.unitPrice * item.quantity * UNITS_PER_YEN;
  return item.quantity >= BULK_QUANTITY ? percentOff(units, BULK_DISCOUNT_PERCENT) : units;
}

function shippingFee(goodsTotal: number, rank: Rank): number {
  if (rank === "gold" || goodsTotal >= FREE_SHIPPING_FROM) return 0;
  return SHIPPING_FEE;
}

/** 注文の請求金額を計算する。割引は数量 → 会員 → クーポンの順に重ね、最後に 1 円未満を切り捨てる。 */
export function calcInvoice(items: Item[], customer: Customer, coupon?: string): Invoice {
  for (const item of items) {
    assertCount(item.unitPrice, "unitPrice");
    assertCount(item.quantity, "quantity");
  }

  const subtotal = sumSubtotal(items);

  let units = items.reduce((sum, item) => sum + itemUnitsAfterBulkDiscount(item), 0);
  units = percentOff(units, RANK_DISCOUNT_PERCENT[customer.rank]);
  if (coupon === WELCOME_COUPON && subtotal >= WELCOME_MIN_SUBTOTAL) {
    units -= WELCOME_DISCOUNT * UNITS_PER_YEN;
  }

  const goodsTotal = Math.floor(units / UNITS_PER_YEN);
  const shipping = shippingFee(goodsTotal, customer.rank);
  return { subtotal, discount: subtotal - goodsTotal, shipping, total: goodsTotal + shipping };
}
