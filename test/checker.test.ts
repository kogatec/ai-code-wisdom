import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLineRanges, check, diffFingerprints, type Finding } from "../src/core/checker.ts";
import { readProfile, writeProfile } from "../src/core/profile.ts";
import { loadCompiled } from "../src/core/resolve.ts";
import { CLEAN_CODE, git, setupProject, SQL_VIOLATION, write } from "./helpers.ts";

function inj(result: { findings: Finding[] }): Finding[] {
  return result.findings.filter((f) => f.principle === "SEC-INJ-002");
}

test("違反を検出し、位置・必須・指紋を返す", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/repo.ts", SQL_VIOLATION);
  const result = check(paths, compiled);
  assert.deepEqual(result.errors, []);
  assert.ok(result.filesScanned >= 1);
  const [f] = inj(result);
  assert.ok(f);
  assert.equal(f.file, "src/repo.ts");
  assert.equal(f.line, 2);
  assert.equal(f.endLine, 2);
  assert.equal(f.severity, "error");
  assert.equal(f.blocking, true);
  assert.equal(f.ruleId, "sec-inj-002-ts-sql-template");
  assert.match(f.fingerprint, /^[0-9a-f]{12}$/);
  assert.ok(f.snippet.startsWith("`SELECT * FROM users"));
  assert.ok(f.message.length > 0 && f.note);
});

test("違反のないコードでは指摘が出ない", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/math.ts", "/** 足す */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n");
  assert.deepEqual(check(paths, compiled).findings, []);
});

test(".tsx でも検出し、ルール ID に __tsx が付かない", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/view.tsx", "export const q = (id: string) => `SELECT * FROM t WHERE id = ${id}`;\n");
  const [f] = inj(check(paths, compiled));
  assert.ok(f);
  assert.equal(f.file, "src/view.tsx");
  assert.equal(f.ruleId, "sec-inj-002-ts-sql-template");
});

test("Python でも検出する", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "app/repo.py", 'def find(cur, uid):\n    cur.execute(f"SELECT * FROM users WHERE id = {uid}")\n');
  const [f] = inj(check(paths, compiled));
  assert.ok(f);
  assert.equal(f.file, "app/repo.py");
  assert.equal(f.line, 2);
});

test("torus-allow：理由があれば例外、直前の行でも同じ行でもよい", () => {
  const { root, paths, compiled } = setupProject();
  write(
    root,
    "src/a.ts",
    "// torus-allow SEC-INJ-002: 固定の ID だけを渡す内部ツール\n" +
      "export const q1 = (db: Db) => db.query(`SELECT * FROM t WHERE id = ${1}`);\n" +
      "export const q2 = (db: Db) => db.query(`SELECT * FROM t WHERE id = ${2}`); // torus-allow SEC-IV-001, SEC-INJ-002: 同上\n",
  );
  const result = check(paths, compiled);
  assert.equal(inj(result).length, 0);
  assert.equal(result.waived.filter((w) => w.finding.principle === "SEC-INJ-002").length, 2);
  assert.equal(result.waived[0].reason, "固定の ID だけを渡す内部ツール");
  assert.deepEqual(result.invalidAllows, []);
});

test("torus-allow：理由がなければ例外にならず、invalidAllows にも入る", () => {
  const { root, paths, compiled } = setupProject();
  write(
    root,
    "src/b.ts",
    "// torus-allow SEC-INJ-002\n" +
      "export const q1 = (db: Db) => db.query(`SELECT * FROM t WHERE id = ${1}`);\n" +
      "export const q2 = (db: Db) => db.query(`SELECT * FROM t WHERE id = ${2}`); // torus-allow SEC-INJ-002:   \n",
  );
  const result = check(paths, compiled);
  assert.equal(inj(result).length, 2);
  assert.equal(result.waived.length, 0);
  assert.equal(result.invalidAllows.filter((f) => f.principle === "SEC-INJ-002").length, 2);
});

test("torus-allow：別の原則の ID や、離れた行のコメントでは例外にならない", () => {
  const { root, paths, compiled } = setupProject();
  write(
    root,
    "src/c.ts",
    "// torus-allow SEC-IV-001: 別の原則\n" +
      "export const q1 = (db: Db) => db.query(`SELECT * FROM t WHERE id = ${1}`);\n" +
      "// torus-allow SEC-INJ-002: 2行前では効かない\n" +
      "\n" +
      "export const q2 = (db: Db) => db.query(`SELECT * FROM t WHERE id = ${2}`);\n",
  );
  const result = check(paths, compiled);
  assert.equal(inj(result).length, 2);
  assert.equal(result.waived.length, 0);
});

test("profile.exclude_paths に一致するパスは検査しない", () => {
  const { root, paths } = setupProject();
  const profile = readProfile(paths.profile);
  profile.exclude_paths = ["src/legacy/**"];
  writeProfile(paths.profile, profile);
  write(root, "src/legacy/old.ts", SQL_VIOLATION);
  write(root, "src/new.ts", SQL_VIOLATION);
  const result = check(paths, loadCompiled(paths));
  assert.deepEqual(inj(result).map((f) => f.file), ["src/new.ts"]);
});

test("パックの exclude_paths（テストのパス）に一致するパスは、そのルールを検査しない", () => {
  const { root, paths, compiled } = setupProject({ primary: "simple-readable", secondary: [] });
  const code = "export function f(x: number) {\n  if (!x) { return null; } else { return x; }\n}\n";
  write(root, "src/a.ts", code);
  write(root, "tests/a.ts", code);
  write(root, "src/a.test.ts", code);
  const files = check(paths, compiled).findings.filter((f) => f.principle === "SIM-ELSE-008").map((f) => f.file);
  assert.deepEqual(files, ["src/a.ts"]);
});

test("overrides.paths で原則を無効にしたパスは、その原則だけ検査しない", () => {
  const { root, paths } = setupProject();
  const profile = readProfile(paths.profile);
  profile.overrides.paths = { "scripts/**": { disable: ["SEC-INJ-002"] } };
  writeProfile(paths.profile, profile);
  write(root, "scripts/run.ts", SQL_VIOLATION + "export const x: any = 1;\n");
  write(root, "src/run.ts", SQL_VIOLATION);
  const result = check(paths, loadCompiled(paths));
  assert.deepEqual(inj(result).map((f) => f.file), ["src/run.ts"]);
  assert.ok(result.findings.some((f) => f.file === "scripts/run.ts" && f.principle === "MNT-TYPE-006"));
});

test("paths を指定すると、そのファイルだけを検査する（存在しないものや対応外の拡張子は除く）", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  write(root, "src/b.ts", SQL_VIOLATION);
  write(root, "README.md", "SELECT\n");
  const one = check(paths, compiled, { paths: ["src/a.ts", "nothing.ts", "README.md"] });
  assert.deepEqual(inj(one).map((f) => f.file), ["src/a.ts"]);
  assert.equal(one.filesScanned, 1);
  const none = check(paths, compiled, { paths: ["nothing.ts", "README.md"] });
  assert.deepEqual(none, { findings: [], waived: [], invalidAllows: [], filesScanned: 0, errors: [] });
  const dir = check(paths, compiled, { paths: ["src"] });
  assert.equal(inj(dir).length, 2);
});

test("node_modules や .torus の中は検査しない", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "node_modules/x/index.ts", SQL_VIOLATION);
  write(root, "dist/out.ts", SQL_VIOLATION);
  const whole = check(paths, compiled);
  assert.equal(inj(whole).length, 0);
  const explicit = check(paths, compiled, { paths: ["node_modules/x/index.ts"] });
  assert.equal(inj(explicit).length, 0);
});

test("並び順：必須 → severity → ファイル → 行", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/z.ts", SQL_VIOLATION);
  write(root, "src/a.ts", SQL_VIOLATION + "export const w: any = 1;\n");
  const result = check(paths, compiled);
  const blocking = result.findings.filter((f) => f.blocking);
  assert.ok(blocking.length >= 2);
  assert.deepEqual(
    result.findings.slice(0, blocking.length).map((f) => f.blocking),
    blocking.map(() => true),
  );
  assert.deepEqual(blocking.map((f) => f.file), ["src/a.ts", "src/z.ts"]);
  const rank = { error: 0, warning: 1, info: 2, hint: 3 } as const;
  const rest = result.findings.slice(blocking.length);
  for (let i = 1; i < rest.length; i++) assert.ok(rank[rest[i - 1].severity] <= rank[rest[i].severity]);
});

test("指紋は行がずれても変わらない", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  const [before] = inj(check(paths, compiled));
  write(root, "src/a.ts", "// 先頭に足した行\n\n" + SQL_VIOLATION);
  const [after] = inj(check(paths, compiled));
  assert.equal(after.line, before.line + 2);
  assert.equal(after.fingerprint, before.fingerprint);
});

test("diffBase：変更した行の指摘だけ残る", () => {
  const { root, paths, compiled } = setupProject();
  git(root, "init", "-q");
  write(root, "src/a.ts", SQL_VIOLATION);
  git(root, "add", "src");
  git(root, "commit", "-q", "-m", "first");
  // 既存の違反は残したまま、新しい違反を足す
  write(
    root,
    "src/a.ts",
    SQL_VIOLATION + "\nexport function other(db: Db, n: string) {\n  return db.query(`DELETE FROM t WHERE n = ${n}`);\n}\n",
  );
  const all = inj(check(paths, compiled));
  assert.equal(all.length, 2);
  const result = check(paths, compiled, { diffBase: "HEAD" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(inj(result).map((f) => f.line), [6]);
  // 追跡されていないファイルは全行が対象
  write(root, "src/new.ts", SQL_VIOLATION);
  const withNew = check(paths, compiled, { diffBase: "HEAD" });
  assert.deepEqual(inj(withNew).map((f) => `${f.file}:${f.line}`).sort(), ["src/a.ts:6", "src/new.ts:2"]);
  // 変更のないファイルの指摘は出ない
  git(root, "add", "-A", "src");
  git(root, "commit", "-q", "-m", "second");
  assert.equal(inj(check(paths, compiled, { diffBase: "HEAD" })).length, 0);
  assert.equal(inj(check(paths, compiled, { diffBase: "HEAD~1" })).length, 2);
});

test("diffBase：git リポジトリでなければ絞り込まずに知らせる", () => {
  const { root, paths, compiled } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  const result = check(paths, compiled, { diffBase: "HEAD" });
  assert.equal(inj(result).length, 1);
  assert.ok(result.errors.includes("git リポジトリではないため差分での絞り込みをしませんでした"));
});

test("changedLineRanges：変更行・追跡外・git 外", () => {
  const { root } = setupProject();
  assert.equal(changedLineRanges(root, "HEAD", "src/a.ts"), null);
  git(root, "init", "-q");
  write(root, "src/a.ts", "1\n2\n3\n4\n5\n");
  git(root, "add", "src");
  git(root, "commit", "-q", "-m", "first");
  write(root, "src/a.ts", "1\nX\n3\n4\n5\n6\n7\n");
  assert.deepEqual(changedLineRanges(root, "HEAD", "src/a.ts"), [
    [2, 2],
    [6, 7],
  ]);
  write(root, "src/b.ts", "x\n");
  assert.equal(changedLineRanges(root, "HEAD", "src/b.ts"), "all");
  // 削除だけの変更（行数 0）は範囲に含めない
  write(root, "src/a.ts", "1\n2\n4\n5\n");
  assert.deepEqual(changedLineRanges(root, "HEAD", "src/a.ts"), []);
});

function fake(fingerprint: string, line = 1): Finding {
  return {
    ruleId: "r",
    principle: "P",
    severity: "error",
    blocking: false,
    file: "a.ts",
    line,
    endLine: line,
    column: 1,
    message: "m",
    snippet: "s",
    fingerprint,
  };
}

test("diffFingerprints：指紋の出現回数が増えた分だけが新しい指摘", () => {
  const added = diffFingerprints(["a", "a", "c"], [fake("a", 1), fake("a", 2), fake("a", 3), fake("b", 4)]);
  assert.deepEqual(added.map((f) => f.fingerprint).sort(), ["a", "b"]);
  assert.deepEqual(diffFingerprints(["a", "b"], [fake("b"), fake("a")]), []);
  assert.deepEqual(diffFingerprints([], []), []);
  assert.equal(diffFingerprints([], [fake("x"), fake("x")]).length, 2);
});

test("きれいなコードは何も出さない（CLEAN_CODE）", () => {
  const { root, paths, compiled } = setupProject({ primary: "simple-readable", secondary: [] });
  write(root, "src/add.ts", CLEAN_CODE);
  assert.deepEqual(check(paths, compiled).findings, []);
});
