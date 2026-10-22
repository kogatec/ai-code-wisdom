import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesAny, matchesGlob } from "../src/core/glob.ts";

test("**/ は0個以上のディレクトリに一致する", () => {
  assert.ok(matchesGlob("a.test.ts", "**/*.test.ts"));
  assert.ok(matchesGlob("src/a.test.ts", "**/*.test.ts"));
  assert.ok(matchesGlob("src/deep/er/a.test.ts", "**/*.test.ts"));
  assert.ok(!matchesGlob("src/a.ts", "**/*.test.ts"));
  assert.ok(matchesGlob("tests/x.py", "**/tests/**"));
  assert.ok(matchesGlob("pkg/tests/sub/x.py", "**/tests/**"));
  assert.ok(!matchesGlob("pkg/attests/x.py", "**/tests/**"));
});

test("* は / をまたがない", () => {
  assert.ok(matchesGlob("src/a.ts", "src/*.ts"));
  assert.ok(!matchesGlob("src/sub/a.ts", "src/*.ts"));
  assert.ok(matchesGlob("src/sub/a.ts", "src/**"));
  assert.ok(matchesGlob("src/sub/a.ts", "src/**/*.ts"));
});

test("? は / 以外の1文字に一致する", () => {
  assert.ok(matchesGlob("a1.ts", "a?.ts"));
  assert.ok(!matchesGlob("a12.ts", "a?.ts"));
  assert.ok(!matchesGlob("a/.ts", "a?.ts"));
});

test(". などの記号は文字として扱う", () => {
  assert.ok(matchesGlob("a.ts", "a.ts"));
  assert.ok(!matchesGlob("axts", "a.ts"));
  assert.ok(matchesGlob("src/(x)/a.ts", "src/(x)/a.ts"));
});

test("matchesAny はどれか1つに一致すればよい", () => {
  assert.ok(matchesAny("src/a.test.ts", ["docs/**", "**/*.test.ts"]));
  assert.ok(!matchesAny("src/a.ts", ["docs/**", "**/*.test.ts"]));
  assert.ok(!matchesAny("src/a.ts", []));
});
