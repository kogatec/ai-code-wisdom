import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ROOT, projectPaths, type ProjectPaths } from "../src/core/paths.ts";
import { initProject, type StyleChoice } from "../src/core/project.ts";
import type { Compiled } from "../src/core/resolve.ts";

export const CLI = path.join(PLUGIN_ROOT, "src", "cli.ts");
export const BIN = path.join(PLUGIN_ROOT, "bin", "torus");

const created: string[] = [];
process.on("exit", () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

export function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "torus-"));
  created.push(dir);
  return dir;
}

export interface TestProject {
  root: string;
  paths: ProjectPaths;
  compiled: Compiled;
}

/** 既定は セキュリティ（主）＋ 保守性（副） */
export function setupProject(choice: Partial<StyleChoice> = {}): TestProject {
  const root = tmpDir();
  const paths = projectPaths(root);
  const compiled = initProject(paths, {
    primary: "security-resilience",
    secondary: [{ pack: "maintainable", weight: 0.5 }],
    ...choice,
  });
  return { root, paths, compiled };
}

export function write(root: string, rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** SQL をテンプレート文字列で組み立てる（SEC-INJ-002 に違反する） */
export const SQL_VIOLATION =
  "export function find(db: Db, id: string) {\n  return db.query(`SELECT * FROM users WHERE id = ${id}`);\n}\n";
export const CLEAN_CODE = "/** 足す */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 子プロセスのホーム。初回設定の記録（~/.torus-code）が、本物のホームに書かれないようにする */
const TEST_HOME = tmpDir();

/** src/cli.ts を子プロセスで実行する */
export function runCli(args: string[], opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { ...process.env, HOME: TEST_HOME, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Claude Code と同じく、標準入力に JSON を渡してフックを実行する */
export function runHookProc(event: string, input: unknown, projectDir: string, env: NodeJS.ProcessEnv = {}): RunResult {
  return runCli(["hook", event], {
    input: JSON.stringify(input),
    env: { CLAUDE_PROJECT_DIR: projectDir, ...env },
    cwd: projectDir,
  });
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} に失敗: ${r.stderr}`);
  return r.stdout;
}
