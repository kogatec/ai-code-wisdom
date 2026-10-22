import assert from "node:assert/strict";
import { test } from "node:test";
import { readProfile, writeProfile } from "../src/core/profile.ts";
import { compile, loadCompiled } from "../src/core/resolve.ts";
import { setupProject } from "./helpers.ts";

test("必須の原則が先頭に並ぶ", () => {
  const { compiled } = setupProject();
  const levels = compiled.principles.map((p) => p.level);
  const firstOther = levels.findIndex((l) => l !== "mandatory");
  assert.ok(firstOther > 0, "必須の原則がある");
  assert.ok(levels.slice(firstOther).every((l) => l !== "mandatory"), "必須は先頭にまとまっている");
  assert.deepEqual(
    compiled.principles.map((p) => p.rank),
    compiled.principles.map((_, i) => i),
  );
});

test("同じレベルでは主スタイルが副スタイルより先に来る", () => {
  const { compiled } = setupProject();
  const rankOf = (id: string) => compiled.principles.find((p) => p.id === id)!.rank;
  const primary = compiled.principles.filter((p) => p.pack === "security-resilience" && p.level === "default");
  const secondary = compiled.principles.filter((p) => p.pack === "maintainable" && p.level === "default");
  assert.ok(primary.length > 0 && secondary.length > 0);
  assert.ok(Math.max(...primary.map((p) => rankOf(p.id))) < Math.min(...secondary.map((p) => rankOf(p.id))));
});

test("主と副を入れ替えると、優先も入れ替わる", () => {
  const { compiled } = setupProject({ primary: "maintainable", secondary: [{ pack: "security-resilience", weight: 0.5 }] });
  const rankOf = (id: string) => compiled.principles.find((p) => p.id === id)!.rank;
  const mnt = compiled.principles.filter((p) => p.pack === "maintainable" && p.level === "default");
  const sec = compiled.principles.filter((p) => p.pack === "security-resilience" && p.level === "default");
  assert.ok(Math.max(...mnt.map((p) => rankOf(p.id))) < Math.min(...sec.map((p) => rankOf(p.id))));
  // 必須は主副に関係なく先頭
  assert.equal(compiled.principles[0].level, "mandatory");
});

test("必須の原則を disable しても外れず、warning が出る", () => {
  const { paths } = setupProject();
  const profile = readProfile(paths.profile);
  profile.overrides.disable = ["SEC-INJ-002", "MNT-TYPE-006"];
  writeProfile(paths.profile, profile);
  const compiled = compile(paths);
  assert.ok(compiled.principles.some((p) => p.id === "SEC-INJ-002"), "必須は残る");
  assert.ok(compiled.warnings.some((w) => w.includes("SEC-INJ-002")));
  assert.ok(!compiled.principles.some((p) => p.id === "MNT-TYPE-006"), "default は外れる");
  assert.ok(compiled.skipped.some((s) => s.id === "MNT-TYPE-006"));
});

test("prototype では advisory の原則と info のルールが外れる", () => {
  const production = setupProject({ primary: "simple-readable", secondary: [{ pack: "maintainable", weight: 0.5 }] });
  assert.ok(production.compiled.principles.some((p) => p.level === "advisory"));
  assert.ok(production.compiled.rules.some((r) => r.severity === "info"));

  const prototype = setupProject({
    primary: "simple-readable",
    secondary: [{ pack: "maintainable", weight: 0.5 }],
    phase: "prototype",
  });
  assert.ok(prototype.compiled.principles.every((p) => p.level !== "advisory"));
  assert.ok(prototype.compiled.rules.every((r) => r.severity !== "info"));
  assert.ok(prototype.compiled.skipped.some((s) => s.reason.includes("prototype")));
});

test("原則の向きが逆なら、優先される側が軸の勝者になる", () => {
  // 必須の SEC-IV-001（抽象化を増やす）が、SIM-ABS-010（減らす）より先に来る
  const security = setupProject({ primary: "security-resilience", secondary: [{ pack: "simple-readable", weight: 0.5 }] });
  const abstraction = security.compiled.axes.find((a) => a.axis === "abstraction");
  assert.ok(abstraction);
  assert.equal(abstraction.preferred, "more");
  assert.ok(abstraction.winners.includes("SEC-IV-001"));
  assert.ok(abstraction.yielding.includes("SIM-ABS-010"));

  // どの軸でも、勝つのは「最も優先度の高い原則」の向き
  for (const combo of [
    { primary: "simple-readable", secondary: [{ pack: "maintainable", weight: 0.5 }] },
    { primary: "maintainable", secondary: [{ pack: "simple-readable", weight: 0.5 }] },
  ]) {
    const { compiled } = setupProject(combo);
    assert.ok(compiled.axes.length > 0);
    for (const axis of compiled.axes) {
      const onAxis = compiled.principles
        .filter((p) => p.tensions?.some((t) => t.axis === axis.axis))
        .sort((a, b) => a.rank - b.rank);
      const top = onAxis[0].tensions!.find((t) => t.axis === axis.axis)!.direction;
      assert.equal(axis.preferred, top);
      assert.ok(axis.winners.includes(onAxis[0].id));
      assert.ok(axis.yielding.length > 0);
    }
  }
});

test("loadCompiled は設定が変わると作り直す", () => {
  const { paths } = setupProject();
  const before = loadCompiled(paths);
  assert.equal(loadCompiled(paths).inputsHash, before.inputsHash);
  const profile = readProfile(paths.profile);
  profile.phase = "prototype";
  writeProfile(paths.profile, profile);
  const after = loadCompiled(paths);
  assert.notEqual(after.inputsHash, before.inputsHash);
  assert.equal(after.profile.phase, "prototype");
});
