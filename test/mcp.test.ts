import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../src/core/paths.ts";
import { TOOL_VERSION } from "../src/core/project.ts";
import { runCli, setupProject, SQL_VIOLATION, tmpDir, write } from "./helpers.ts";

/** 1行1メッセージで送り、返ってきた行を JSON として返す（標準入力を閉じるとサーバーは終わる） */
function converse(messages: unknown[], cwd: string, rawLines: string[] = []): any[] {
  const input = [...messages.map((m) => JSON.stringify(m)), ...rawLines].join("\n") + "\n";
  const r = runCli(["mcp"], { input, cwd, env: { CLAUDE_PROJECT_DIR: cwd } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const call = (id: number, name: string, args: unknown) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

test("plugin.json がこの MCP サーバーを登録し、プラグイン直下に .mcp.json を置かない", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(manifest.mcpServers, {
    wisdom: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", "mcp"] },
  });
  // 直下の .mcp.json は、このディレクトリをプロジェクトとして開いたときにプロジェクトの MCP 設定としても読まれ、
  // ${CLAUDE_PLUGIN_ROOT} が定まらずに起動に失敗する
  assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, ".mcp.json")));
});

test("plugin.json・package.json・TOOL_VERSION の版がそろっている（plugin update は plugin.json の版で更新を判断する）", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(TOOL_VERSION, pkg.version);
});

test("initialize → tools/list → tools/call", () => {
  const { root } = setupProject();
  write(root, "src/repo.ts", SQL_VIOLATION);
  const replies = converse(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "wisdom_explain", { id: "SEC-INJ-002" }),
      call(4, "wisdom_check", {}),
    ],
    root,
  );
  assert.equal(replies.length, 4, "通知には返事をしない");
  const [init, list, explain, checked] = replies;
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual(init.result.serverInfo, { name: "ai-code-wisdom", version: TOOL_VERSION });

  assert.deepEqual(
    list.result.tools.map((t: any) => t.name),
    ["wisdom_principles", "wisdom_check", "wisdom_explain", "wisdom_record_decision", "wisdom_styles"],
  );
  for (const t of list.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description);
  }

  assert.equal(explain.result.isError, undefined);
  assert.ok(explain.result.content[0].text.startsWith("## [SEC-INJ-002] SQL は文字列で組み立てず"));
  assert.ok(checked.result.content[0].text.includes("src/repo.ts:2:"));
  assert.ok(checked.result.content[0].text.includes("[SEC-INJ-002]"));
});

test("initialize：protocolVersion が無ければ既定値を返す", () => {
  const { root } = setupProject();
  const [init] = converse([{ jsonrpc: "2.0", id: "a", method: "initialize", params: {} }], root);
  assert.equal(init.id, "a");
  assert.equal(init.result.protocolVersion, "2025-06-18");
});

test("ping・未知のメソッド・壊れた行", () => {
  const { root } = setupProject();
  const replies = converse(
    [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "nope/nope" },
    ],
    root,
    ["{これは JSON ではない"],
  );
  assert.deepEqual(replies[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } });
  assert.equal(replies[2].id, null);
  assert.equal(replies[2].error.code, -32700);
});

test("wisdom_principles：path があればそのファイル向けの確認事項と L0 を返す", () => {
  const { root } = setupProject();
  const [plain, withPath, outside] = converse(
    [call(1, "wisdom_principles", {}), call(2, "wisdom_principles", { path: "src/db/users.ts" }), call(3, "wisdom_principles", { path: "/etc/passwd" })],
    root,
  );
  assert.ok(plain.result.content[0].text.startsWith("# AI Code Wisdom：このプロジェクトの設計方針"));
  const text = withPath.result.content[0].text;
  assert.ok(text.startsWith("[AI Code Wisdom] src/db/users.ts を書くときに確かめること"));
  assert.ok(text.includes("# AI Code Wisdom：このプロジェクトの設計方針"));
  assert.equal(outside.result.isError, true);
});

test("wisdom_check：paths と diff_base", () => {
  const { root } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  write(root, "src/b.ts", "export const ok = 1;\n");
  const [one, none, bad] = converse(
    [
      call(1, "wisdom_check", { paths: ["src/a.ts"] }),
      call(2, "wisdom_check", { paths: ["src/b.ts"] }),
      call(3, "wisdom_check", { diff_base: "HEAD" }),
    ],
    root,
  );
  assert.ok(one.result.content[0].text.includes("必須の違反 1"));
  assert.ok(none.result.content[0].text.startsWith("指摘はありません（1 ファイル）"));
  assert.ok(bad.result.content[0].text.includes("注意：git リポジトリではないため差分での絞り込みをしませんでした"));
});

test("wisdom_explain：有効な原則 → 同梱パックの順に探し、無ければエラー", () => {
  const { root } = setupProject({ primary: "maintainable", secondary: [] });
  const [active, bundled, missing, noId] = converse(
    [
      call(1, "wisdom_explain", { id: "MNT-TYPE-006" }),
      call(2, "wisdom_explain", { id: "SEC-INJ-002" }),
      call(3, "wisdom_explain", { id: "XXX-999" }),
      call(4, "wisdom_explain", {}),
    ],
    root,
  );
  assert.ok(active.result.content[0].text.includes("## [MNT-TYPE-006]"));
  assert.ok(bundled.result.content[0].text.includes("## [SEC-INJ-002]"));
  assert.equal(missing.result.isError, true);
  assert.equal(noId.result.isError, true);
});

test("wisdom_record_decision：decisions.md に1行追記する", () => {
  const { root } = setupProject();
  const [a, b] = converse(
    [
      call(1, "wisdom_record_decision", { decision: "検索は\nLIKE をやめて前方一致にする", principle_ids: ["SEC-INJ-002", "SIM-ABS-010"] }),
      call(2, "wisdom_record_decision", { decision: "ID は文字列で扱う" }),
    ],
    root,
  );
  assert.ok(a.result.content[0].text.startsWith("記録しました："));
  assert.ok(!b.result.isError);
  const lines = fs.readFileSync(path.join(root, ".wisdom", "decisions.md"), "utf8").trimEnd().split("\n");
  assert.match(lines.at(-2)!, /^- \d{4}-\d{2}-\d{2}：検索は LIKE をやめて前方一致にする（SEC-INJ-002, SIM-ABS-010）$/);
  assert.match(lines.at(-1)!, /^- \d{4}-\d{2}-\d{2}：ID は文字列で扱う$/);
});

test("wisdom_styles：同梱パックの一覧（未設定のプロジェクトでも動く）", () => {
  const dir = tmpDir();
  const [styles, explain, principles, unknown] = converse(
    [
      call(1, "wisdom_styles", {}),
      call(2, "wisdom_explain", { id: "SEC-IV-001" }),
      call(3, "wisdom_principles", {}),
      call(4, "wisdom_nothing", {}),
    ],
    dir,
  );
  assert.ok(styles.result.content[0].text.includes("### 保守性・長期運用重視型（maintainable）"));
  assert.ok(explain.result.content[0].text.includes("## [SEC-IV-001]"));
  assert.equal(principles.result.content[0].text, "このプロジェクトは未設定です。/ai-code-wisdom:init で設計スタイルを選べます");
  assert.equal(unknown.result.isError, true);
});

test("project_dir を指定すると、そのプロジェクトを使う", () => {
  const { root } = setupProject();
  write(root, "src/a.ts", SQL_VIOLATION);
  const elsewhere = tmpDir();
  const [reply] = converse([call(1, "wisdom_check", { project_dir: root })], elsewhere);
  assert.ok(reply.result.content[0].text.includes("src/a.ts"));
});
