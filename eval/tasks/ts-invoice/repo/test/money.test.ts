import { test } from "node:test";
import assert from "node:assert/strict";
import { formatYen } from "../src/money.ts";

test("formatYen は 3 桁ごとにカンマで区切る", () => {
  assert.equal(formatYen(0), "¥0");
  assert.equal(formatYen(12345), "¥12,345");
});
