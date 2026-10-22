import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { astGrepBin } from "../src/core/checker.ts";
import { listPacks } from "../src/core/packs.ts";
import { BUNDLED_PACKS_DIR } from "../src/core/paths.ts";

const packs = listPacks(BUNDLED_PACKS_DIR);

test("同梱パックがすべて読める", () => {
  assert.deepEqual(
    packs.map((p) => p.id),
    ["maintainable", "security-resilience", "simple-readable"],
  );
  for (const p of packs) {
    assert.ok(p.principles.length > 0, p.id);
    assert.ok(p.rules.length > 0, p.id);
    assert.ok(p.name && p.description, p.id);
  }
});

test("パックの YAML の一覧はすべて文字列（「: 」を含む文を引用符で囲み忘れると、マップになり [object Object] と表示される）", () => {
  const LIST_KEYS = ["values", "suited_for", "tradeoffs", "exclude_paths", "principles", "not_when"];
  for (const p of packs) {
    const files = ["pack.yaml", ...p.principles.map((x) => `principles/${x.id}.yaml`)];
    for (const rel of files) {
      const raw = YAML.parse(fs.readFileSync(path.join(p.dir, rel), "utf8"));
      const lists = [...LIST_KEYS.map((k) => [k, raw[k]] as const), ["checks.static", raw.checks?.static] as const];
      for (const [key, list] of lists) {
        for (const item of Array.isArray(list) ? list : []) {
          assert.equal(typeof item, "string", `${p.id}/${rel} の ${key}：${JSON.stringify(item)}`);
        }
      }
    }
  }
});

test("原則 ID とルール ID が重複しない", () => {
  const principleIds = packs.flatMap((p) => p.principles.map((x) => x.id));
  assert.equal(new Set(principleIds).size, principleIds.length, "原則 ID が重複");
  const ruleIds = packs.flatMap((p) => p.rules.map((r) => r.id));
  assert.equal(new Set(ruleIds).size, ruleIds.length, "ルール ID が重複");
});

test("ルールは同じパックの原則に結びつき、原則の static はルールを参照できる", () => {
  for (const p of packs) {
    const own = new Set(p.principles.map((x) => x.id));
    const ruleIds = new Set(p.rules.map((r) => r.id));
    for (const r of p.rules) assert.ok(own.has(r.principle), `${p.id}: ${r.id} の原則 ${r.principle} がパックにない`);
    for (const x of p.principles) {
      for (const id of x.checks.static ?? []) assert.ok(ruleIds.has(id), `${x.id} の ${id}`);
    }
  }
});

for (const pack of packs) {
  test(`${pack.id}：ast-grep test --skip-snapshot-tests が通る`, () => {
    const r = spawnSync(astGrepBin(), ["test", "--skip-snapshot-tests"], {
      cwd: path.join(BUNDLED_PACKS_DIR, pack.id),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}
