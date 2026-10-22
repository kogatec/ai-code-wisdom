import { test } from "node:test";
import assert from "node:assert/strict";
import { calcInvoice } from "../../src/invoice.ts";

type Rank = "regular" | "silver" | "gold";

const REGULAR = { rank: "regular" as Rank };
const SILVER = { rank: "silver" as Rank };
const GOLD = { rank: "gold" as Rank };

const item = (unitPrice: number, quantity: number, sku = "SKU") => ({ sku, unitPrice, quantity });

/** 戻り値を plain object にして、キーの過不足も含めて比べる。 */
function invoice(...args: Parameters<typeof calcInvoice>) {
  return { ...calcInvoice(...args) };
}

test("割引がないときは、小計がそのまま合計になる（送料のしきい値の下なので送料 600 円）", () => {
  assert.deepEqual(invoice([item(1000, 2)], REGULAR), { subtotal: 2000, discount: 0, shipping: 600, total: 2600 });
});

test("10 個以上の商品だけが 3% 引きになる", () => {
  assert.deepEqual(invoice([item(500, 10)], REGULAR), { subtotal: 5000, discount: 150, shipping: 600, total: 5450 });
  assert.deepEqual(invoice([item(1000, 9)], REGULAR), { subtotal: 9000, discount: 0, shipping: 0, total: 9000 });
  assert.deepEqual(invoice([item(1000, 10, "A"), item(1000, 2, "B")], REGULAR), {
    subtotal: 12000,
    discount: 300,
    shipping: 0,
    total: 11700,
  });
});

test("会員ランクで silver は 5%、gold は 10% 引きになる", () => {
  assert.deepEqual(invoice([item(10000, 1)], SILVER), { subtotal: 10000, discount: 500, shipping: 0, total: 9500 });
  assert.deepEqual(invoice([item(4000, 1)], GOLD), { subtotal: 4000, discount: 400, shipping: 0, total: 3600 });
});

test("数量割引のあとに、会員割引を重ねる", () => {
  assert.deepEqual(invoice([item(1000, 10)], SILVER), { subtotal: 10000, discount: 785, shipping: 0, total: 9215 });
  assert.deepEqual(invoice([item(1200, 3, "A"), item(800, 10, "B"), item(150, 1, "C")], SILVER), {
    subtotal: 11750,
    discount: 816,
    shipping: 0,
    total: 10934,
  });
});

test("クーポン WELCOME は、小計が 3000 円以上のときだけ 500 円引きになる", () => {
  assert.deepEqual(invoice([item(3000, 1)], REGULAR, "WELCOME"), {
    subtotal: 3000,
    discount: 500,
    shipping: 600,
    total: 3100,
  });
  assert.deepEqual(invoice([item(2999, 1)], REGULAR, "WELCOME"), {
    subtotal: 2999,
    discount: 0,
    shipping: 600,
    total: 3599,
  });
});

test("クーポンの条件は、割引前の小計で判定する", () => {
  // 割引前は 3000 円（条件を満たす）。数量割引のあとは 2910 円になるが、クーポンは使える
  assert.deepEqual(invoice([item(300, 10)], REGULAR, "WELCOME"), {
    subtotal: 3000,
    discount: 590,
    shipping: 600,
    total: 3010,
  });
});

test("クーポンの 500 円引きは、会員割引のあとの金額から引く", () => {
  assert.deepEqual(invoice([item(6000, 1)], SILVER, "WELCOME"), {
    subtotal: 6000,
    discount: 800,
    shipping: 0,
    total: 5200,
  });
  assert.deepEqual(invoice([item(3000, 1)], GOLD, "WELCOME"), {
    subtotal: 3000,
    discount: 800,
    shipping: 0,
    total: 2200,
  });
});

test("WELCOME 以外のクーポンは無視する", () => {
  assert.deepEqual(invoice([item(3000, 1)], REGULAR, "SUMMER"), {
    subtotal: 3000,
    discount: 0,
    shipping: 600,
    total: 3600,
  });
  assert.deepEqual(invoice([item(3000, 1)], REGULAR, undefined), {
    subtotal: 3000,
    discount: 0,
    shipping: 600,
    total: 3600,
  });
});

test("最後の金額の 1 円未満を切り捨てる", () => {
  // 333 × 0.95 = 316.35
  assert.deepEqual(invoice([item(333, 1)], SILVER), { subtotal: 333, discount: 17, shipping: 600, total: 916 });
  // 999 × 0.9 = 899.1
  assert.deepEqual(invoice([item(333, 3)], GOLD), { subtotal: 999, discount: 100, shipping: 0, total: 899 });
  // 3330 × 0.97 × 0.95 = 3068.595
  assert.deepEqual(invoice([item(333, 10)], SILVER), { subtotal: 3330, discount: 262, shipping: 600, total: 3668 });
});

test("送料は、割引後の商品代金が 5000 円未満なら 600 円、5000 円以上なら 0 円", () => {
  assert.deepEqual(invoice([item(3600, 1)], REGULAR), { subtotal: 3600, discount: 0, shipping: 600, total: 4200 });
  assert.deepEqual(invoice([item(4999, 1)], REGULAR), { subtotal: 4999, discount: 0, shipping: 600, total: 5599 });
  assert.deepEqual(invoice([item(5000, 1)], REGULAR), { subtotal: 5000, discount: 0, shipping: 0, total: 5000 });
});

test("gold の会員は、金額が小さくても送料が 0 円", () => {
  assert.deepEqual(invoice([item(100, 1)], GOLD), { subtotal: 100, discount: 10, shipping: 0, total: 90 });
  assert.deepEqual(invoice([item(4000, 1)], GOLD).shipping, 0);
});

test("送料の判定は、割引（クーポンを含む）のあとの金額で行い、discount に送料は含めない", () => {
  // 割引前は 5400 円で送料無料のしきい値を超えるが、クーポンのあとは 4900 円になるので送料がかかる
  assert.deepEqual(invoice([item(5400, 1)], REGULAR, "WELCOME"), {
    subtotal: 5400,
    discount: 500,
    shipping: 600,
    total: 5500,
  });
  // silver の 5% 引きで 5000 円を下回る
  assert.deepEqual(invoice([item(5200, 1)], SILVER), { subtotal: 5200, discount: 260, shipping: 600, total: 5540 });
});

test("戻り値のキーは subtotal / discount / shipping / total の 4 つだけ", () => {
  const result = calcInvoice([item(1000, 1)], REGULAR);
  assert.deepEqual(Object.keys(result).sort(), ["discount", "shipping", "subtotal", "total"]);
});
