import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readLedger } from "../src/core/ledger.ts";
import { parseProfile, writeProfile } from "../src/core/profile.ts";
import { CLEAN_CODE, runCli, runHookProc, setupProject, SQL_VIOLATION, tmpDir, write, type RunResult } from "./helpers.ts";

function json(r: RunResult): any {
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

/** Claude Code と同じ順序（pre → 書き込み → post）で Write を再現する */
function writeFile(root: string, session: string, rel: string, content: string): { pre: RunResult; post: RunResult } {
  const file = path.join(root, rel);
  const input = { session_id: session, cwd: root, tool_name: "Write", tool_input: { file_path: file, content } };
  const pre = runHookProc("pre-tool-use", { ...input, hook_event_name: "PreToolUse" }, root);
  write(root, rel, content);
  const post = runHookProc("post-tool-use", { ...input, hook_event_name: "PostToolUse" }, root);
  return { pre, post };
}

function isBlock(r: RunResult): boolean {
  return json(r)?.decision === "block";
}

test("session-start：L0 を additionalContext で返す", () => {
  const { root } = setupProject();
  const r = runHookProc("session-start", { session_id: "s1", hook_event_name: "SessionStart" }, root);
  assert.equal(r.status, 0);
  const out = json(r);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith("# Torus Code：このプロジェクトの設計方針"));
  assert.equal(r.stdout.trim().split("\n").length, 1, "出力は1行");
});

test("session-start：lock と中身が食い違っていれば注意を添える", () => {
  const { root } = setupProject();
  fs.appendFileSync(path.join(root, ".torus", "packs", "maintainable", "pack.yaml"), "\n# 手で編集\n");
  const out = json(runHookProc("session-start", { session_id: "s1" }, root));
  assert.match(out.hookSpecificOutput.additionalContext, /\n注意：maintainable: lock\.json の記録から中身が変わっています/);
});

test("未設定のプロジェクトでは何も出さず、0 で終わる", () => {
  const dir = tmpDir();
  for (const event of ["session-start", "user-prompt-submit", "pre-tool-use", "post-tool-use", "stop"]) {
    const r = runHookProc(event, { session_id: "s1", prompt: "バグを直して", tool_name: "Write" }, dir);
    assert.equal(r.status, 0, event);
    assert.equal(r.stdout, "", event);
  }
});

test("未設定のコードのフォルダ：最初の依頼でだけ初回設定を案内し、ほかのフックは何も出さない", () => {
  const dir = tmpDir();
  write(dir, "src/a.ts", "export const a = 1;\n");
  const env = { HOME: tmpDir() };
  assert.equal(runHookProc("session-start", { session_id: "s1" }, dir, env).stdout, "");

  const first = runHookProc("user-prompt-submit", { session_id: "s1", prompt: "バグを直して" }, dir, env);
  assert.equal(first.status, 0);
  const out = json(first);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("torus-code:init"));

  // 断った場合も含め、同じプロジェクトでは二度と聞かない（別のセッションでも）
  assert.equal(runHookProc("user-prompt-submit", { session_id: "s1", prompt: "次の依頼" }, dir, env).stdout, "");
  assert.equal(runHookProc("user-prompt-submit", { session_id: "s2", prompt: "別のセッション" }, dir, env).stdout, "");
  assert.ok(!fs.existsSync(path.join(dir, ".torus")), "プロジェクトには何も書かない");
});

test("user-prompt-submit：依頼の種類に合わせた手順を返す", () => {
  const { root } = setupProject();
  const out = json(runHookProc("user-prompt-submit", { session_id: "s1", prompt: "ログインのバグを直して" }, root));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("この依頼の進め方（バグ修正）"));
  const risky = json(runHookProc("user-prompt-submit", { session_id: "s1", prompt: "入力の検証は不要です" }, root));
  assert.ok(risky.hookSpecificOutput.additionalContext.includes("[SEC-IV-001]"));
  assert.equal(runHookProc("user-prompt-submit", { session_id: "s1", prompt: "こんにちは" }, root).stdout, "");
});

test("pre-tool-use：ファイルを書く前の確認事項は1ファイルにつき1回だけ", () => {
  const { root } = setupProject();
  const input = { session_id: "s1", tool_name: "Write", tool_input: { file_path: path.join(root, "src/db/users.ts"), content: "" } };
  const first = json(runHookProc("pre-tool-use", input, root));
  assert.equal(first.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
  assert.ok(first.hookSpecificOutput.additionalContext.includes("src/db/users.ts を書くときに確かめること"));
  assert.equal(runHookProc("pre-tool-use", input, root).stdout, "");
});

test("対象外のツール・拡張子・プロジェクト外・exclude_paths は何もしない", () => {
  const { root } = setupProject();
  const cases = [
    { tool_name: "Bash", tool_input: { command: "ls" } },
    { tool_name: "Write", tool_input: { file_path: path.join(root, "README.md"), content: "x" } },
    { tool_name: "Write", tool_input: { file_path: path.join(tmpDir(), "a.ts"), content: SQL_VIOLATION } },
  ];
  for (const c of cases) {
    for (const event of ["pre-tool-use", "post-tool-use"]) {
      const r = runHookProc(event, { session_id: "s1", ...c }, root);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
  }
});

test("Write で SQL の埋め込みを書くと block する", () => {
  const { root } = setupProject();
  const { post } = writeFile(root, "s1", "src/repo.ts", SQL_VIOLATION);
  assert.equal(post.status, 0);
  const out = json(post);
  assert.equal(out.decision, "block");
  assert.ok(out.reason.startsWith("[Torus Code] src/repo.ts に必須原則の違反が入りました。直してから先に進んでください。"));
  assert.ok(out.reason.includes("- L2 [SEC-INJ-002] SQL をテンプレート文字列への埋め込みで組み立てています"));
  assert.ok(out.reason.includes("`torus-allow SEC-INJ-002: 理由`"));
  const events = readLedger({ ledger: path.join(root, ".torus", "ledger.jsonl") } as never);
  const edit = events.find((e) => e.event === "edit") as any;
  assert.equal(edit.file, "src/repo.ts");
  assert.equal(edit.new[0].principle, "SEC-INJ-002");
  assert.equal(edit.new[0].blocking, true);
});

test("直したら block しない", () => {
  const { root } = setupProject();
  writeFile(root, "s1", "src/repo.ts", SQL_VIOLATION);
  const { post } = writeFile(root, "s1", "src/repo.ts", CLEAN_CODE);
  assert.ok(!isBlock(post));
});

test("警告だけなら block せず、additionalContext で知らせる", () => {
  const { root } = setupProject();
  const { post } = writeFile(root, "s1", "src/w.ts", "export const value: any = 1;\n");
  const out = json(post);
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("[MNT-TYPE-006]"));
});

test("すでにある違反は block しない（pre → post の順）", () => {
  const { root } = setupProject();
  write(root, "src/old.ts", SQL_VIOLATION);
  const content = SQL_VIOLATION + "\n" + CLEAN_CODE.replace("add", "sum");
  const { post } = writeFile(root, "s1", "src/old.ts", content);
  assert.ok(!isBlock(post), post.stdout);
  // 行がずれても、同じ違反は新しい違反として扱わない
  const shifted = writeFile(root, "s1", "src/old.ts", "// 先頭に足した\n" + content);
  assert.ok(!isBlock(shifted.post), shifted.post.stdout);
});

test("Edit / MultiEdit でも同じように検査する", () => {
  const { root } = setupProject();
  write(root, "src/e.ts", CLEAN_CODE);
  const file = path.join(root, "src/e.ts");
  const edit = { session_id: "s1", tool_name: "Edit", tool_input: { file_path: file, old_string: "a + b", new_string: "a + b" } };
  runHookProc("pre-tool-use", edit, root);
  write(root, "src/e.ts", CLEAN_CODE + SQL_VIOLATION);
  const post = runHookProc(
    "post-tool-use",
    { session_id: "s1", tool_name: "MultiEdit", tool_input: { file_path: file, edits: [{ old_string: "x", new_string: SQL_VIOLATION }] } },
    root,
  );
  assert.ok(isBlock(post));
});

test("pre が動かなかった場合は、書き込んだ文字列に含まれる違反だけを新しい違反とする", () => {
  const { root } = setupProject();
  write(root, "src/old.ts", SQL_VIOLATION + "export function other(db: Db, n: string) {\n  return db.query(`DELETE FROM t WHERE n = ${n}`);\n}\n");
  const file = path.join(root, "src/old.ts");
  const post = runHookProc(
    "post-tool-use",
    { session_id: "fresh", tool_name: "Edit", tool_input: { file_path: file, old_string: "x", new_string: "db.query(`DELETE FROM t WHERE n = ${n}`)" } },
    root,
  );
  const out = json(post);
  assert.equal(out.decision, "block");
  assert.ok(out.reason.includes("- L5 [SEC-INJ-002]"));
  assert.ok(!out.reason.includes("- L2 [SEC-INJ-002]"));
});

test("同じ違反を3回止めたら、4回目は止めない", () => {
  const { root } = setupProject();
  for (let i = 1; i <= 4; i++) {
    const { post } = writeFile(root, "s1", "src/repo.ts", SQL_VIOLATION);
    if (i <= 3) {
      assert.ok(isBlock(post), `${i} 回目は止める`);
    } else {
      assert.ok(!isBlock(post), "4 回目は止めない");
      const out = json(post);
      assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
      assert.ok(out.hookSpecificOutput.additionalContext.includes("同じ違反を3回止めたため、以後は止めません"));
      assert.ok(out.hookSpecificOutput.additionalContext.includes("[SEC-INJ-002]"));
    }
    writeFile(root, "s1", "src/repo.ts", CLEAN_CODE);
  }
});

test("torus-allow に理由がないと block し、理由が必要だと伝える", () => {
  const { root } = setupProject();
  const code = "export function f(db: Db, id: string) {\n  // torus-allow SEC-INJ-002\n  return db.query(`SELECT * FROM t WHERE id = ${id}`);\n}\n";
  const out = json(writeFile(root, "s1", "src/n.ts", code).post);
  assert.equal(out.decision, "block");
  assert.ok(out.reason.includes("torus-allow には理由が必要です"));
  const ok = writeFile(root, "s1", "src/n.ts", code.replace("SEC-INJ-002", "SEC-INJ-002: 固定値のみ")).post;
  assert.ok(!isBlock(ok));
});

test("stop：残った必須違反で block し、stop_hook_active なら block しない", () => {
  const { root } = setupProject();
  writeFile(root, "s1", "src/repo.ts", SQL_VIOLATION);
  const stop = runHookProc("stop", { session_id: "s1", stop_hook_active: false }, root);
  const out = json(stop);
  assert.equal(out.decision, "block");
  assert.ok(out.reason.startsWith("[Torus Code] 終了する前に、この作業で入った必須原則の違反を直してください：\n- src/repo.ts:L2 [SEC-INJ-002]"));
  assert.equal(runHookProc("stop", { session_id: "s1", stop_hook_active: true }, root).stdout, "");
  // 直せば止まらず、ledger に stop が残る
  writeFile(root, "s1", "src/repo.ts", CLEAN_CODE);
  assert.equal(runHookProc("stop", { session_id: "s1" }, root).stdout, "");
  const ledger = fs.readFileSync(path.join(root, ".torus", "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const stopEvent = ledger.find((e) => e.event === "stop");
  assert.deepEqual(stopEvent.files, ["src/repo.ts"]);
  assert.equal(stopEvent.session, "s1");
});

test("stop：すでにあった違反や、3回を超えて止めた違反では block しない／セッションがなければ何もしない", () => {
  const { root } = setupProject();
  write(root, "src/old.ts", SQL_VIOLATION);
  writeFile(root, "s1", "src/old.ts", SQL_VIOLATION + "\n" + CLEAN_CODE);
  assert.equal(runHookProc("stop", { session_id: "s1" }, root).stdout, "");
  assert.equal(runHookProc("stop", { session_id: "unknown-session" }, root).stdout, "");

  for (let i = 0; i < 4; i++) {
    writeFile(root, "s2", "src/repo.ts", SQL_VIOLATION);
    writeFile(root, "s2", "src/repo.ts", CLEAN_CODE);
  }
  writeFile(root, "s2", "src/repo.ts", SQL_VIOLATION);
  assert.equal(runHookProc("stop", { session_id: "s2" }, root).stdout, "");
});

test("stop：変更が120行以上ならレビュー依頼が1回だけ出る", () => {
  const { root } = setupProject();
  const big = Array.from({ length: 130 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
  const { post } = writeFile(root, "s1", "src/big.ts", big);
  assert.ok(!isBlock(post), post.stdout);
  const first = json(runHookProc("stop", { session_id: "s1" }, root));
  assert.equal(first.decision, "block");
  assert.ok(first.reason.includes("この作業では 130 行を変更しました"));
  assert.ok(first.reason.includes('subagent_type "torus-code:torus-reviewer"'));
  assert.equal(runHookProc("stop", { session_id: "s1" }, root).stdout, "");
});

test("stop：変更が少なければレビューを頼まない。review: off なら大きくても頼まない", () => {
  const small = setupProject();
  writeFile(small.root, "s1", "src/a.ts", CLEAN_CODE);
  assert.equal(runHookProc("stop", { session_id: "s1" }, small.root).stdout, "");

  const off = setupProject({ review: "off" });
  const big = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
  writeFile(off.root, "s1", "src/big.ts", big);
  assert.equal(runHookProc("stop", { session_id: "s1" }, off.root).stdout, "");

  const always = setupProject({ review: "always" });
  writeFile(always.root, "s1", "src/a.ts", CLEAN_CODE);
  assert.equal(json(runHookProc("stop", { session_id: "s1" }, always.root)).decision, "block");
});

test("設定を読めないとき：session-start だけが、自動検査が止まっていることと理由を知らせる。どのフックも 0 で終わり、ログに残す", () => {
  const { root } = setupProject();
  fs.writeFileSync(path.join(root, ".torus", "profile.yaml"), "primary: [\n");
  const start = runHookProc("session-start", { session_id: "s1" }, root);
  assert.equal(start.status, 0);
  const out = json(start);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const text: string = out.hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith("[Torus Code] 設定を読めないため、このセッションでは自動検査が止まっています。"), text);
  assert.match(text, /\n理由：\S/);
  assert.ok(text.includes("torus status"), text);
  assert.equal(start.stdout.trim().split("\n").length, 1, "出力は1行");

  // 依頼や編集のたびには繰り返さない
  const input = { session_id: "s1", cwd: root, prompt: "バグを直して", tool_name: "Write", tool_input: { file_path: path.join(root, "a.ts"), content: SQL_VIOLATION } };
  for (const event of ["user-prompt-submit", "pre-tool-use", "post-tool-use", "stop"]) {
    const r = runHookProc(event, input, root);
    assert.equal(r.status, 0, event);
    assert.equal(r.stdout, "", event);
  }
  const log = fs.readFileSync(path.join(root, ".torus", "cache", "hook-errors.log"), "utf8");
  assert.ok(log.includes("session-start"));
});

test("設定を読めないとき：手で編集した profile.yaml の副スタイルの重複も、理由として知らせる", () => {
  const { root } = setupProject();
  const file = path.join(root, ".torus", "profile.yaml");
  const profile = parseProfile(fs.readFileSync(file, "utf8"));
  writeProfile(file, { ...profile, secondary: [...profile.secondary, ...profile.secondary] });
  const text: string = json(runHookProc("session-start", { session_id: "s1" }, root)).hookSpecificOutput.additionalContext;
  assert.ok(text.includes("自動検査が止まっています"), text);
  assert.ok(text.includes("理由：パック maintainable が重複して選ばれています"), text);
});

test("session-start：lock.json が壊れていても L0 を返し、注意を添える", () => {
  const { root } = setupProject();
  fs.writeFileSync(path.join(root, ".torus", "lock.json"), "{");
  const text: string = json(runHookProc("session-start", { session_id: "s1" }, root)).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith("# Torus Code：このプロジェクトの設計方針"), text);
  assert.match(text, /\n注意：lock\.json を読めません/);
});

test("標準入力が JSON でなくても、0 で終わる", () => {
  const { root } = setupProject();
  const r = runCli(["hook", "pre-tool-use"], { input: "これは JSON ではない", env: { CLAUDE_PROJECT_DIR: root }, cwd: root });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(runCli(["hook", "unknown-event"], { input: "{}", env: { CLAUDE_PROJECT_DIR: root } }).status, 0);
});
