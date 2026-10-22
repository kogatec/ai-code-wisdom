import assert from "node:assert/strict";
import { test } from "node:test";
import { relativeToRoot } from "../src/core/paths.ts";

test("relativeToRoot：プロジェクトの中は / 区切りの相対パス、外は null", () => {
  assert.equal(relativeToRoot("/p", "/p/src/a.ts"), "src/a.ts");
  assert.equal(relativeToRoot("/p", "src/a.ts"), "src/a.ts");
  assert.equal(relativeToRoot("/p", "/p"), "");
  assert.equal(relativeToRoot("/p", "/other/a.ts"), null);
  assert.equal(relativeToRoot("/p", "/p/../a.ts"), null);
  assert.equal(relativeToRoot("/p/sub", "/p"), null);
});

test("relativeToRoot：.. で始まる名前のファイルやディレクトリは、プロジェクトの中として扱う", () => {
  assert.equal(relativeToRoot("/p", "/p/..foo/a.ts"), "..foo/a.ts");
  assert.equal(relativeToRoot("/p", "/p/..a.ts"), "..a.ts");
});
