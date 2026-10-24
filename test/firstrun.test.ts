import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { looksLikeCodeProject, takeFirstRunOffer } from "../src/core/firstrun.ts";
import { git, tmpDir, write } from "./helpers.ts";

test("looksLikeCodeProject：git リポジトリ、プロジェクトのファイル、浅い場所の TS / Python があればコードのフォルダ", () => {
  const home = tmpDir();
  assert.equal(looksLikeCodeProject(tmpDir(), home), false, "空のフォルダ");

  const ts = tmpDir();
  write(ts, "src/a.ts", "export const a = 1;\n");
  assert.equal(looksLikeCodeProject(ts, home), true, "src/ の .ts");

  const py = tmpDir();
  write(py, "main.py", "print(1)\n");
  assert.equal(looksLikeCodeProject(py, home), true, "直下の .py");

  const marker = tmpDir();
  write(marker, "pyproject.toml", "[project]\nname = 'x'\n");
  assert.equal(looksLikeCodeProject(marker, home), true, "pyproject.toml");

  const repo = tmpDir();
  git(repo, "init", "-q");
  assert.equal(looksLikeCodeProject(repo, home), true, "git リポジトリ");
});

test("looksLikeCodeProject：深い場所や node_modules の中だけのファイル、ホームそのものはコードのフォルダとみなさない", () => {
  const home = tmpDir();
  const deep = tmpDir();
  write(deep, "docs/notes/old/a.py", "print(1)\n");
  assert.equal(looksLikeCodeProject(deep, home), false, "深い場所の .py");

  const deps = tmpDir();
  write(deps, "node_modules/x/index.ts", "export {};\n");
  assert.equal(looksLikeCodeProject(deps, home), false, "node_modules の中");

  write(home, "script.py", "print(1)\n");
  assert.equal(looksLikeCodeProject(home, home), false, "ホームそのもの");
});

test("takeFirstRunOffer：コードのフォルダで1回目だけ案内を返し、ホームに記録する", () => {
  const home = tmpDir();
  const project = tmpDir();
  write(project, "src/a.ts", "export const a = 1;\n");

  const offer = takeFirstRunOffer(project, home);
  assert.ok(offer, "1回目は案内する");
  assert.ok(offer.startsWith("[Torus Code] このプロジェクトは、まだ設計スタイルが設定されていません"), offer);
  assert.ok(offer.includes("torus-code:init"), offer);
  assert.ok(offer.includes("今は設定しない"), offer);
  assert.ok(offer.includes("/torus-code:style"), offer);
  assert.equal(takeFirstRunOffer(project, home), null, "2回目は聞かない");

  const state = JSON.parse(fs.readFileSync(path.join(home, ".torus-code", "first-run.json"), "utf8"));
  assert.ok(state.projects[fs.realpathSync(project)], "プロジェクトの実パスで記録する");
  assert.ok(!fs.existsSync(path.join(project, ".torus")), "プロジェクトには何も書かない");

  const other = tmpDir();
  write(other, "main.py", "print(1)\n");
  assert.ok(takeFirstRunOffer(other, home), "別のプロジェクトでは、また1回聞く");
});

test("takeFirstRunOffer：コードのないフォルダでは案内も記録もしない。記録が壊れていても案内し、記録し直す", () => {
  const home = tmpDir();
  assert.equal(takeFirstRunOffer(tmpDir(), home), null);
  assert.ok(!fs.existsSync(path.join(home, ".torus-code")));

  const file = path.join(home, ".torus-code", "first-run.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{");
  const project = tmpDir();
  write(project, "src/a.ts", "export const a = 1;\n");
  assert.ok(takeFirstRunOffer(project, home));
  assert.equal(takeFirstRunOffer(project, home), null);
});
