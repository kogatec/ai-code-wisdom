import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLEAN_CODE, git, runCli, setupProject, SQL_VIOLATION, tmpDir, write } from "./helpers.ts";

test("export git-hook：pre-commit を書き、自分のものでなければ上書きしない。git でなければエラー", () => {
  const { root } = setupProject();
  const notGit = runCli(["export", "git-hook", "--project", root]);
  assert.equal(notGit.status, 2);
  assert.ok(notGit.stderr.includes("git リポジトリではない"));

  git(root, "init", "-q");
  assert.equal(runCli(["export", "git-hook", "--project", root]).status, 0);
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  const text = fs.readFileSync(hook, "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"));
  assert.ok(text.includes("torus-code"));
  assert.ok(text.includes('check --project "$(git rev-parse --show-toplevel)" --diff HEAD --fail-on blocking'));
  assert.ok(fs.statSync(hook).mode & 0o100, "実行権限");
  assert.equal(runCli(["export", "git-hook", "--project", root]).status, 0, "自分が書いたものは更新できる");

  fs.writeFileSync(hook, "#!/bin/sh\necho 他の人のフック\n");
  const refused = runCli(["export", "git-hook", "--project", root]);
  assert.equal(refused.status, 2);
  assert.ok(fs.readFileSync(hook, "utf8").includes("他の人のフック"));
});

test("git の pre-commit フックが、必須の違反のあるコミットを止める", () => {
  const { root } = setupProject();
  git(root, "init", "-q");
  runCli(["export", "git-hook", "--project", root]);
  write(root, "src/repo.ts", SQL_VIOLATION);
  git(root, "add", "src");
  const blocked = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x"], { cwd: root, encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.ok((blocked.stdout + blocked.stderr).includes("[SEC-INJ-002]"));
  write(root, "src/repo.ts", CLEAN_CODE);
  git(root, "add", "src");
  git(root, "commit", "-q", "-m", "x");
});

test("git の pre-commit フック：設定がリポジトリのサブディレクトリにあっても、そこを検査する", () => {
  const repo = tmpDir();
  git(repo, "init", "-q");
  // 空白と ' を含む名前でも、sh の引用が崩れない
  const app = path.join(repo, "my app's dir");
  assert.equal(runCli(["init", "--project", app, "--primary", "security-resilience"]).status, 0);
  assert.equal(runCli(["export", "git-hook"], { cwd: app }).status, 0);
  const commit = () =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x"], { cwd: repo, encoding: "utf8" });

  write(app, "src/ok.ts", CLEAN_CODE);
  git(repo, "add", "-A");
  const ok = commit();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  write(app, "src/repo.ts", SQL_VIOLATION);
  git(repo, "add", "-A");
  const blocked = commit();
  assert.notEqual(blocked.status, 0);
  assert.ok((blocked.stdout + blocked.stderr).includes("[SEC-INJ-002]"), blocked.stdout + blocked.stderr);

  // 設定のあるディレクトリを移すと検査できない。そのときは、やり直し方を案内する
  fs.renameSync(app, path.join(repo, "moved"));
  git(repo, "add", "-A");
  const moved = commit();
  assert.notEqual(moved.status, 0);
  assert.ok(moved.stderr.includes("torus export git-hook"), moved.stderr);
});

test("git の pre-commit フック：--torus-dir で設定を外に置いても、その設定で検査する", () => {
  const repo = tmpDir();
  git(repo, "init", "-q");
  const torusDir = path.join(tmpDir(), "torus");
  assert.equal(runCli(["init", "--project", repo, "--torus-dir", torusDir, "--primary", "security-resilience"]).status, 0);
  assert.equal(runCli(["export", "git-hook", "--project", repo, "--torus-dir", torusDir]).status, 0);
  write(repo, "src/repo.ts", SQL_VIOLATION);
  git(repo, "add", "-A");
  const blocked = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "x"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.ok((blocked.stdout + blocked.stderr).includes("[SEC-INJ-002]"), blocked.stdout + blocked.stderr);
});
