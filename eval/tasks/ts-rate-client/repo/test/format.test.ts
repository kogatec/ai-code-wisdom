import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRate } from "../src/format.ts";

test("formatRate は小数 4 桁までに丸める", () => {
  assert.equal(formatRate(150.25), "150.25");
  assert.equal(formatRate(1 / 3), "0.3333");
});
