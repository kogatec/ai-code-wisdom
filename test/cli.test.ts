import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseProfile } from "../src/core/profile.ts";
import { BIN, CLEAN_CODE, git, runCli, setupProject, SQL_VIOLATION, tmpDir, write } from "./helpers.ts";

function initIn(dir: string, ...extra: string[]) {
  return runCli(["init", "--project", dir, "--primary", "security-resilience", "--secondary", "maintainable", ...extra]);
}

test("非対話の init：設定を作り、結果を表示する", () => {
  const dir = tmpDir();
  const r = runCli(["init", "--project", dir, "--primary", "security-resilience", "--secondary", "maintainable:0.7", "--phase", "prototype"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("主スタイル：セキュリティ・障害耐性重視型（security-resilience）"));
  assert.ok(r.stdout.includes("maintainable、重み 0.7"));
  assert.match(r.stdout, /有効な原則：\d+ 件（うち必須 9 件）/);
  assert.ok(r.stdout.includes(".torus/profile.yaml"));
  assert.ok(r.stdout.includes(".torus/packs/maintainable/"), "ディレクトリには / を付ける");
  const profile = parseProfile(fs.readFileSync(path.join(dir, ".torus", "profile.yaml"), "utf8"));
  assert.equal(profile.primary, "security-resilience");
  assert.deepEqual(profile.secondary, [{ pack: "maintainable", weight: 0.7 }]);
  assert.equal(profile.phase, "prototype");
  for (const f of ["lock.json", "decisions.md", ".gitignore", "packs/maintainable/pack.yaml"]) {
    assert.ok(fs.existsSync(path.join(dir, ".torus", f)), f);
  }
});

test("init：二重に実行するとエラー、--force なら上書き。--primary がなく端末でもなければ使い方を出して 2", () => {
  const dir = tmpDir();
  assert.equal(initIn(dir).status, 0);
  const again = initIn(dir);
  assert.equal(again.status, 2);
  assert.ok(again.stderr.includes("torus: エラー：既に設定されています"));
  assert.equal(initIn(dir, "--force").status, 0);
  const none = runCli(["init", "--project", tmpDir()]);
  assert.equal(none.status, 2);
  assert.ok(none.stderr.includes("--primary"));
  assert.ok(none.stderr.includes("使い方：torus"));
  const bad = runCli(["init", "--project", tmpDir(), "--primary", "nope"]);
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.includes("パック nope はありません"));
});

test("init：主スタイルと同じ副スタイルは外す（style set と同じ扱い）", () => {
  const dir = tmpDir();
  const r = runCli(["init", "--project", dir, "--primary", "maintainable", "--secondary", "maintainable", "--secondary", "simple-readable"]);
  assert.equal(r.status, 0, r.stderr);
  const profile = parseProfile(fs.readFileSync(path.join(dir, ".torus", "profile.yaml"), "utf8"));
  assert.equal(profile.primary, "maintainable");
  assert.deepEqual(profile.secondary, [{ pack: "simple-readable", weight: 0.5 }]);
});

test("init：副スタイルが重複していればエラーにし、何も書かない（やり直せる）", () => {
  const dir = tmpDir();
  const r = runCli(["init", "--project", dir, "--primary", "maintainable", "--secondary", "simple-readable", "--secondary", "simple-readable:0.7"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("simple-readable"), r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, ".torus")), "途中までの設定が残っている");
  assert.equal(runCli(["init", "--project", dir, "--primary", "maintainable"]).status, 0);
});

test("style set：副スタイルが重複していればエラーにし、今の設定を壊さない", () => {
  const { root } = setupProject();
  const profileFile = path.join(root, ".torus", "profile.yaml");
  const before = fs.readFileSync(profileFile, "utf8");
  const r = runCli(["style", "set", "--project", root, "--secondary", "simple-readable", "--secondary", "simple-readable"]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("simple-readable"), r.stderr);
  assert.ok(r.stderr.includes("--secondary の指定か、profile.yaml の secondary を直してください"), r.stderr);
  assert.equal(fs.readFileSync(profileFile, "utf8"), before);
  assert.equal(runCli(["status", "--project", root]).status, 0);
});

test("check：必須の違反があれば 1、--fail-on never なら 0、違反がなければ 0", () => {
  const { root } = setupProject();
  write(root, "src/repo.ts", SQL_VIOLATION);
  const r = runCli(["check", "--project", root]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("src/repo.ts:2:"));
  assert.ok(r.stdout.includes("error 必須 [SEC-INJ-002]"));
  assert.equal(runCli(["check", "--project", root, "--fail-on", "never"]).status, 0);
  assert.equal(runCli(["check", "--project", root, "--fail-on", "error"]).status, 1);
  assert.equal(runCli(["check", "--project", root, "--fail-on", "xxx"]).status, 2);

  write(root, "src/repo.ts", CLEAN_CODE);
  const ok = runCli(["check", "--project", root]);
  assert.equal(ok.status, 0);
  assert.ok(ok.stdout.startsWith("指摘はありません"));
});

test("check：warning だけの場合は --fail-on warning のときだけ 1", () => {
  const { root } = setupProject();
  write(root, "src/w.ts", "/** 値 */\nexport const value: any = 1;\n");
  assert.equal(runCli(["check", "--project", root]).status, 0);
  assert.equal(runCli(["check", "--project", root, "--fail-on", "warning"]).status, 1);
  assert.equal(runCli(["check", "--project", root, "--fail-on", "error"]).status, 0);
});

test("check --json：CheckResult をそのまま出す。パスの指定と、サブディレクトリからの実行", () => {
  const { root } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  write(root, "src/b.ts", SQL_VIOLATION);
  const r = runCli(["check", "--json", "src/a.ts"], { cwd: root });
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(result).sort(), ["errors", "filesScanned", "findings", "invalidAllows", "waived"]);
  const files = result.findings.filter((f: any) => f.principle === "SEC-INJ-002").map((f: any) => f.file);
  assert.deepEqual(files, ["src/a.ts"]);
  assert.equal(result.findings[0].blocking, true);
  // サブディレクトリからでも、親にたどって設定を見つける（パスは cwd 基準）
  const sub = runCli(["check", "--json", "b.ts"], { cwd: path.join(root, "src") });
  assert.deepEqual(JSON.parse(sub.stdout).findings.filter((f: any) => f.principle === "SEC-INJ-002").map((f: any) => f.file), ["src/b.ts"]);
});

test("check --diff / --changed：変更した行だけを対象にする", () => {
  const { root } = setupProject();
  git(root, "init", "-q");
  write(root, "src/a.ts", SQL_VIOLATION);
  git(root, "add", "src");
  git(root, "commit", "-q", "-m", "first");
  assert.equal(runCli(["check", "--project", root, "--changed"]).status, 0);
  assert.equal(runCli(["check", "--project", root]).status, 1);
  write(root, "src/a.ts", SQL_VIOLATION + SQL_VIOLATION.replace("find", "find2"));
  const r = runCli(["check", "--project", root, "--diff", "HEAD"]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("src/a.ts:5:"));
  assert.ok(!r.stdout.includes("src/a.ts:2:"));
});

test("未設定のプロジェクトでは、エラーを出して 2", () => {
  const r = runCli(["check", "--project", tmpDir()]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "torus: エラー：未設定です。torus init を実行してください");
});

test("explain：原則の説明。無い ID はエラー。未設定でも同梱パックから探せる", () => {
  const { root } = setupProject();
  const r = runCli(["explain", "SEC-INJ-002", "--project", root]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.startsWith("## [SEC-INJ-002] SQL は文字列で組み立てず"));
  assert.equal(runCli(["explain", "NOPE-1", "--project", root]).status, 2);
  assert.equal(runCli(["explain", "--project", root]).status, 2);
  const unset = runCli(["explain", "SEC-IV-001", "--project", tmpDir()]);
  assert.equal(unset.status, 0);
  assert.ok(unset.stdout.includes("## [SEC-IV-001]"));
});

test("export agents-md：2回実行しても区画は1つで、既存の内容を残す", () => {
  const { root } = setupProject();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# 既存のメモ\n\n手で書いた内容\n");
  assert.equal(runCli(["export", "agents-md", "--project", root]).status, 0);
  assert.equal(runCli(["export", "agents-md", "--project", root]).status, 0);
  const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.equal(text.split("<!-- torus-code:begin -->").length - 1, 1);
  assert.equal(text.split("<!-- torus-code:end -->").length - 1, 1);
  assert.ok(text.startsWith("# 既存のメモ\n\n手で書いた内容\n"));
  assert.ok(text.includes("# Torus Code：このプロジェクトの設計方針"));
  assert.ok(text.includes("- ファイルを書いたら `torus check --changed` を実行し、[必須] の違反を直す"));
  assert.ok(!text.includes("ファイルを書くたびに自動で検査される"));
  // 区画の外の編集は、再実行しても残る
  fs.writeFileSync(path.join(root, "AGENTS.md"), text + "\n追記\n");
  runCli(["export", "agents-md", "--project", root]);
  assert.ok(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").endsWith("\n追記\n"));
});

test("export agents-md：ファイルがなければ作る", () => {
  const { root } = setupProject();
  runCli(["export", "agents-md", "--project", root]);
  const text = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(text.startsWith("<!-- torus-code:begin -->\n# Torus Code"));
  assert.ok(text.endsWith("<!-- torus-code:end -->\n"));
});

test("export cursor", () => {
  const { root } = setupProject();
  assert.equal(runCli(["export", "cursor", "--project", root]).status, 0);
  const text = fs.readFileSync(path.join(root, ".cursor", "rules", "torus-code.mdc"), "utf8");
  assert.ok(text.startsWith("---\ndescription: Torus Code の設計方針\nalwaysApply: true\n---\n# Torus Code"));
});

test("styles・style・style set・status・principles", () => {
  const { root } = setupProject();
  const styles = runCli(["styles"]);
  assert.ok(styles.stdout.includes("### シンプル・可読性重視型（simple-readable）"));
  const json = JSON.parse(runCli(["styles", "--json"]).stdout);
  assert.deepEqual(json.map((p: any) => p.id), ["maintainable", "security-resilience", "simple-readable"]);
  assert.equal(json[1].mandatory, 9);

  assert.ok(runCli(["style", "--project", root]).stdout.includes("主スタイル：セキュリティ・障害耐性重視型"));
  const set = runCli(["style", "set", "--project", root, "--secondary", "simple-readable:0.8", "--phase", "prototype"]);
  assert.equal(set.status, 0, set.stderr);
  assert.ok(set.stdout.includes("simple-readable、重み 0.8"));
  const profile = parseProfile(fs.readFileSync(path.join(root, ".torus", "profile.yaml"), "utf8"));
  assert.deepEqual(profile.secondary, [{ pack: "simple-readable", weight: 0.8 }]);
  assert.equal(profile.phase, "prototype");
  assert.ok(runCli(["style", "set", "--project", root, "--secondary", "none"]).stdout.includes("副スタイル：なし"));
  assert.equal(runCli(["style", "set", "--project", root]).status, 2);
  assert.equal(runCli(["style", "set", "--project", root, "--phase", "xxx"]).status, 2);

  const status = runCli(["status", "--project", root]);
  assert.equal(status.status, 0);
  assert.ok(status.stdout.includes("lock.json：問題なし"));
  assert.ok(status.stdout.includes("security-resilience 版 0.1.2"));

  const list = runCli(["principles", "--project", root]).stdout.trim().split("\n");
  assert.match(list[0], /^\[SEC-IV-001\] 必須 /);
  const pj = JSON.parse(runCli(["principles", "--json", "--project", root]).stdout);
  assert.equal(pj[0].id, "SEC-IV-001");
  assert.equal(pj[0].rank, 0);
});

test("audit：件数・例外・前回からの増減を出し、履歴を追記する", () => {
  const { root } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION + "// torus-allow SEC-INJ-002: 固定値のみ\nexport const q = (db: Db) => db.query(`DELETE FROM t WHERE id = ${1}`);\n// torus-allow SEC-INJ-003\nexport const e = (s: string) => eval(s);\n");
  const first = runCli(["audit", "--project", root]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(first.stdout.includes("- [SEC-INJ-002] 1 件（error 1）"));
  assert.ok(first.stdout.includes("### 例外（torus-allow）1 件\n- src/a.ts:"));
  assert.ok(first.stdout.includes("固定値のみ"));
  assert.ok(first.stdout.includes("### 理由のない例外 1 件"));
  assert.ok(first.stdout.includes("前回の記録はありません"));

  write(root, "src/b.ts", SQL_VIOLATION);
  const second = runCli(["audit", "--project", root]);
  assert.match(second.stdout, /全体：\d+ → \d+（\+2）/);
  assert.ok(second.stdout.includes("- [SEC-INJ-002] +1"));
  const history = fs.readFileSync(path.join(root, ".torus", "audit-history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(history.length, 2);
  assert.equal(history[1].total, history[0].total + 2);
  assert.equal(history[1].byPrinciple["SEC-INJ-002"], 2);

  const json = JSON.parse(runCli(["audit", "--json", "--project", root]).stdout);
  assert.equal(json.byPrinciple["SEC-INJ-002"].total, 2);
  assert.equal(json.waived.length, 1);
  assert.equal(json.invalidAllows.length, 1);
  assert.equal(json.delta, 0);
});

test("update・lock", () => {
  const { root } = setupProject();
  assert.ok(runCli(["update", "--project", root]).stdout.startsWith("更新はありません"));
  const pack = path.join(root, ".torus", "packs", "maintainable", "pack.yaml");
  fs.appendFileSync(pack, "\n# 手で編集\n");
  assert.ok(runCli(["status", "--project", root]).stdout.includes("中身が変わっています"));
  assert.equal(runCli(["lock", "--project", root]).status, 0);
  assert.ok(runCli(["status", "--project", root]).stdout.includes("lock.json：問題なし"));
  const plan = runCli(["update", "--project", root]);
  assert.ok(plan.stdout.includes("maintainable：0.1.2 → 0.1.2"));
  assert.ok(plan.stdout.includes("torus update --yes"));
  assert.ok(runCli(["update", "--yes", "--project", root]).stdout.includes("更新しました"));
  assert.ok(runCli(["update", "--project", root]).stdout.startsWith("更新はありません"));
});

test("review-context：git の変更ファイルごとの観点・静的検査・差分", () => {
  const { root } = setupProject();
  git(root, "init", "-q");
  write(root, "src/db/repo.ts", CLEAN_CODE);
  git(root, "add", "src");
  git(root, "commit", "-q", "-m", "first");
  write(root, "src/db/repo.ts", CLEAN_CODE + SQL_VIOLATION);
  write(root, "src/new.ts", "export const n = 1;\n");
  write(root, "README.md", "# 文書\n");
  const r = runCli(["review-context", "--project", root]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("## src/db/repo.ts\n層：data_access"));
  assert.ok(r.stdout.includes("- [SEC-INJ-002] 動的に変わる部分"));
  assert.match(r.stdout, /- L\d+ error 必須 \[SEC-INJ-002\]/);
  assert.ok(r.stdout.includes("## src/new.ts"));
  assert.ok(!r.stdout.includes("## README.md"));
  assert.ok(r.stdout.includes("## git diff\ndiff --git a/src/db/repo.ts"));
});

test("review-context：git でなければ最新のセッションで触ったファイルを使う", () => {
  const { root } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  const input = { session_id: "s9", tool_name: "Write", tool_input: { file_path: path.join(root, "src/a.ts"), content: SQL_VIOLATION } };
  runCli(["hook", "pre-tool-use"], { input: JSON.stringify(input), env: { CLAUDE_PROJECT_DIR: root } });
  const r = runCli(["review-context", "--project", root]);
  assert.ok(r.stdout.includes("## src/a.ts"));
  assert.ok(!r.stdout.includes("## git diff"));
});

test("--torus-dir：設定の置き場所をプロジェクトの外にできる", () => {
  const root = tmpDir();
  const torusDir = tmpDir();
  write(root, "src/repo.ts", SQL_VIOLATION);
  const init = runCli(["init", "--project", root, "--torus-dir", torusDir, "--primary", "security-resilience"]);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(fs.existsSync(path.join(torusDir, "profile.yaml")));
  assert.ok(!fs.existsSync(path.join(root, ".torus")));
  const r = runCli(["check", "--project", root, "--torus-dir", torusDir, "--json", "--fail-on", "never"]);
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).findings.some((f: any) => f.principle === "SEC-INJ-002" && f.file === "src/repo.ts"));
  assert.equal(runCli(["check", "--project", root, "--torus-dir", tmpDir()]).status, 2);
});

test("help・引数なし・不明なコマンド・不明なオプション", () => {
  assert.ok(runCli([]).stdout.includes("使い方：torus <コマンド>"));
  assert.ok(runCli(["help"]).stdout.includes("check [パス...]"));
  const unknown = runCli(["nope"]);
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.includes("不明なコマンドです：nope"));
  assert.equal(runCli(["check", "--nope"]).status, 2);
});

test("bin/torus：直接でも、シンボリックリンク経由でも動く", () => {
  const direct = spawnSync(BIN, ["help"], { encoding: "utf8" });
  assert.equal(direct.status, 0, direct.stderr);
  assert.ok(direct.stdout.includes("使い方：torus"));
  const dir = tmpDir();
  fs.symlinkSync(BIN, path.join(dir, "torus"));
  fs.symlinkSync(path.join(dir, "torus"), path.join(dir, "torus2"));
  for (const name of ["torus", "torus2"]) {
    const viaLink = spawnSync(path.join(dir, name), ["styles", "--json"], { encoding: "utf8" });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.equal(JSON.parse(viaLink.stdout).length, 3);
  }
  assert.ok(fs.statSync(BIN).mode & 0o111, "実行権限");
});
