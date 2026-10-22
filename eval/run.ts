// 評価ハーネス：同じ依頼を「プラグインなし（baseline）」と「あり（wisdom）」の Claude に実行させ、
// 原則の違反・隠しテストの通過・トークンを比べる。使い方は --help。

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";

// ---------------------------------------------------------------- 定数

const EVAL_DIR = import.meta.dirname;
const PLUGIN_ROOT = path.resolve(EVAL_DIR, "..");
const TASKS_DIR = path.join(EVAL_DIR, "tasks");
const CLI = path.join(PLUGIN_ROOT, "src", "cli.ts");

// 1 ステップの上限は 15 分。動作確認のためだけに環境変数 EVAL_STEP_TIMEOUT_MS で短くできる
const STEP_TIMEOUT_MS = Number(process.env.EVAL_STEP_TIMEOUT_MS) || 15 * 60_000;
const SETUP_TIMEOUT_MS = 2 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 5 * 60_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

const CONDITIONS = ["baseline", "wisdom"] as const;
type Condition = (typeof CONDITIONS)[number];

/** 課題を並べる順（仕様の表の順）。ここにないものは名前順で最後に付ける */
const TASK_ORDER = ["ts-user-search", "ts-rate-client", "py-sales-report", "py-file-store", "ts-invoice", "py-user-registry"];

const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Agent",
  "Bash(node --test:*)",
  "Bash(node:*)",
  "Bash(python3 -m unittest:*)",
  "Bash(python3:*)",
  "Bash(ls:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
];
const WISDOM_TOOL = "Bash(wisdom:*)";

const SEVERITY_WEIGHT: Record<string, number> = { error: 3, warning: 2, info: 1, hint: 0 };

const USAGE = `使い方：node eval/run.ts [オプション]

  --tasks a,b          実行する課題（既定：すべて）
  --conditions a,b     baseline, wisdom（既定：両方）
  --reps N             課題×条件ごとの繰り返し回数（既定：1）
  --model NAME         claude に渡すモデル（既定：sonnet）
  --concurrency N      同時に動かす実行の数（既定：3）
  --out DIR            結果の出力先（既定：eval/results/<日時>）
  --dry-run            claude を呼ばず、reference/ を work に上書きして、測定と隠しテストだけを行う
                       （ネットワークは使わない。隠しテストが正しいことの確認用）
  --help               この説明`;

// ---------------------------------------------------------------- 型

interface Options {
  tasks: string[];
  conditions: Condition[];
  reps: number;
  model: string;
  concurrency: number;
  out: string;
  dryRun: boolean;
}

interface Task {
  id: string;
  title: string;
  language: "typescript" | "python";
  primary: string;
  /** "ID" または "ID:重み"（wisdom init の --secondary にそのまま渡す） */
  secondary: string[];
  steps: string[];
  expected: { functional: number; robustness: number };
  dir: string;
}

interface Job {
  task: Task;
  condition: Condition;
  rep: number;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface StepResult {
  step: number;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  isError: boolean | null;
  wallMs: number;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  usage: Usage;
  error?: string;
}

interface TestResult {
  expected: number;
  pass: number;
  fail: number;
  total: number;
  /** pass / expected。expected が 0 のとき null */
  rate: number | null;
  error?: string;
}

interface Measure {
  ok: boolean;
  error?: string;
  total: number;
  bySeverity: Record<string, number>;
  blocking: number;
  byPrinciple: Record<string, number>;
  score: number;
  waived: number;
  invalidAllows: number;
  filesScanned: number;
  checkErrors: string[];
}

interface RunResult {
  id: string;
  task: string;
  condition: Condition;
  rep: number;
  dryRun: boolean;
  dir: string;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  baseCommit: string | null;
  changedFiles: string[];
  steps: StepResult[];
  totals: { tokens: number; usage: Usage; costUsd: number; durationMs: number; turns: number };
  measure: Measure;
  tests: { functional: TestResult; robustness: TestResult };
  ledgerLines: number | null;
  errors: string[];
}

interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
}

// ---------------------------------------------------------------- 小さな道具

const activeChildren = new Set<ChildProcess>();
let interrupted = false;

function fail(message: string): never {
  console.error(`eval: エラー：${message}`);
  process.exit(2);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max = 400): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function log(message: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] ${message}`);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function timestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function fmtLimit(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分` : `${Math.round(ms / 1000)} 秒`;
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal); // detached で起動したので、プロセスグループごと止める
  } catch {
    child.kill(signal); // グループがすでにないときは、本体だけ止める
  }
}

/** コマンドを（シェルを通さずに）動かす。タイムアウトで止め、失敗しても例外にせず結果として返す */
function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;
    const timers: NodeJS.Timeout[] = [];

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, spawnError: messageOf(error) });
      return;
    }
    activeChildren.add(child);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      activeChildren.delete(child);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        durationMs: Date.now() - started,
        spawnError,
      });
    };

    timers.push(
      setTimeout(() => {
        timedOut = true;
        killTree(child, "SIGTERM");
        timers.push(
          setTimeout(() => {
            killTree(child, "SIGKILL");
            timers.push(setTimeout(() => finish(null, "SIGKILL"), 3_000));
          }, 5_000),
        );
      }, options.timeoutMs),
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes < MAX_CAPTURE_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes < MAX_CAPTURE_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("error", (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** 並行数を絞って順に処理する。1 件の失敗（例外）がほかを止めないよう、worker 側で握る */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (!interrupted) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]);
      } catch (error) {
        console.error(`eval: 予期しないエラー：${messageOf(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

// ---------------------------------------------------------------- 引数と課題

function parseOptions(argv: string[]): Options {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        tasks: { type: "string" },
        conditions: { type: "string" },
        reps: { type: "string" },
        model: { type: "string" },
        concurrency: { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
    }).values;
  } catch (error) {
    return fail(`${messageOf(error)}\n\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const positiveInt = (name: string, raw: unknown, fallback: number): number => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return fail(`--${name} は 1 以上の整数にしてください（${String(raw)}）`);
    return value;
  };
  const list = (raw: unknown): string[] =>
    String(raw)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");

  const known = listTaskIds();
  const tasks = values.tasks === undefined ? known : list(values.tasks);
  for (const id of tasks) {
    if (!known.includes(id)) return fail(`課題 ${id} がありません（${known.join(", ")}）`);
  }
  const conditions = values.conditions === undefined ? [...CONDITIONS] : list(values.conditions);
  for (const condition of conditions) {
    if (!(CONDITIONS as readonly string[]).includes(condition)) return fail(`条件 ${condition} は使えません（${CONDITIONS.join(", ")}）`);
  }
  if (tasks.length === 0 || conditions.length === 0) return fail("課題と条件は 1 つ以上必要です");

  const dryRun = values["dry-run"] === true;
  const defaultOut = path.join(EVAL_DIR, "results", `${timestamp()}${dryRun ? "-dry" : ""}`);
  return {
    tasks,
    conditions: conditions as Condition[],
    reps: positiveInt("reps", values.reps, 1),
    model: typeof values.model === "string" ? values.model : "sonnet",
    concurrency: positiveInt("concurrency", values.concurrency, 3),
    out: path.resolve(typeof values.out === "string" ? values.out : defaultOut),
    dryRun,
  };
}

function listTaskIds(): string[] {
  const found = fs.existsSync(TASKS_DIR)
    ? fs.readdirSync(TASKS_DIR).filter((name) => fs.existsSync(path.join(TASKS_DIR, name, "task.yaml")))
    : [];
  const rank = (id: string) => (TASK_ORDER.includes(id) ? TASK_ORDER.indexOf(id) : TASK_ORDER.length);
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function loadTask(id: string): Task {
  const dir = path.join(TASKS_DIR, id);
  const raw = asRecord(YAML.parse(fs.readFileSync(path.join(dir, "task.yaml"), "utf8")));
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`${id}/task.yaml: ${what}`);
  };
  need(raw.id === id, "id がディレクトリ名と一致しません");
  need(raw.language === "typescript" || raw.language === "python", "language は typescript か python です");
  const profile = asRecord(raw.profile);
  need(typeof profile.primary === "string", "profile.primary がありません");
  const secondary = (Array.isArray(profile.secondary) ? profile.secondary : []).map((item: unknown) => {
    if (typeof item === "string") return item;
    const entry = asRecord(item);
    need(typeof entry.pack === "string", "profile.secondary の各項目には pack が必要です");
    return entry.weight === undefined ? String(entry.pack) : `${String(entry.pack)}:${String(entry.weight)}`;
  });
  const steps = Array.isArray(raw.steps) ? raw.steps.map((step: unknown) => String(step).trim()) : [];
  need(steps.length > 0, "steps がありません");
  const test = asRecord(raw.test);
  const functional = num(test.functional);
  const robustness = num(test.robustness);
  need(functional !== null && robustness !== null, "test.functional と test.robustness（隠しテストの件数）が必要です");
  for (const dirName of ["repo", "reference", path.join("hidden", "functional")]) {
    need(fs.existsSync(path.join(dir, dirName)), `${dirName}/ がありません`);
  }
  return {
    id,
    title: String(raw.title ?? id),
    language: raw.language as Task["language"],
    primary: profile.primary as string,
    secondary,
    steps,
    expected: { functional: functional ?? 0, robustness: robustness ?? 0 },
    dir,
  };
}

// ---------------------------------------------------------------- 1 回の実行

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "eval",
  GIT_AUTHOR_EMAIL: "eval@example.invalid",
  GIT_COMMITTER_NAME: "eval",
  GIT_COMMITTER_EMAIL: "eval@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null", // 利用者の git 設定（署名・フックなど）を持ち込まない
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function emptyTest(expected: number, error?: string): TestResult {
  return { expected, pass: 0, fail: 0, total: 0, rate: expected === 0 ? null : 0, error };
}

function emptyMeasure(error: string): Measure {
  return {
    ok: false,
    error,
    total: 0,
    bySeverity: {},
    blocking: 0,
    byPrinciple: {},
    score: 0,
    waived: 0,
    invalidAllows: 0,
    filesScanned: 0,
    checkErrors: [],
  };
}

function totalTokens(usage: Usage): number {
  return usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
}

async function git(work: string, args: string[]): Promise<CommandResult> {
  return runCommand("git", args, { cwd: work, env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
}

async function mustGit(work: string, args: string[]): Promise<string> {
  const result = await git(work, args);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} に失敗しました：${clip(result.spawnError ?? result.stderr)}`);
  }
  return result.stdout.trim();
}

function initArgs(task: Task, work: string, wisdomDir?: string): string[] {
  const args = [CLI, "init", "--project", work];
  if (wisdomDir !== undefined) args.push("--wisdom-dir", wisdomDir);
  args.push("--primary", task.primary);
  for (const secondary of task.secondary) args.push("--secondary", secondary);
  return args;
}

function claudeArgs(prompt: string, model: string, condition: Condition): string[] {
  const args = ["-p", prompt, "--output-format", "json", "--model", model, "--permission-mode", "acceptEdits", "--setting-sources", "project"];
  if (condition === "wisdom") args.push("--plugin-dir", PLUGIN_ROOT);
  args.push("--allowedTools", ...ALLOWED_TOOLS, ...(condition === "wisdom" ? [WISDOM_TOOL] : []));
  return args;
}

function claudeEnv(condition: Condition): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 親のセッションの情報を持ち込まない
  for (const name of ["CLAUDECODE", "CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT"]) delete env[name];
  if (condition === "wisdom") {
    // プラグインの bin/ にある wisdom コマンドを Bash から呼べるようにする
    env.PATH = `${path.join(PLUGIN_ROOT, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  return env;
}

/** `claude -p --output-format json` の標準出力から、最後の result を取り出す */
function parseClaudeOutput(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (text === "") return null;
  const candidates = [text, ...text.split("\n").reverse()];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const results = parsed.map(asRecord).filter((item) => item.type === "result");
        if (results.length > 0) return results[results.length - 1];
        continue;
      }
      if (typeof parsed === "object" && parsed !== null) return asRecord(parsed);
    } catch {
      // この候補は JSON ではない。次の候補（最後の行など）を試す
    }
  }
  return null;
}

async function runStep(job: Job, options: Options, work: string, runDir: string, step: number): Promise<StepResult> {
  const prompt = job.task.steps[step - 1];
  const result = await runCommand("claude", claudeArgs(prompt, options.model, job.condition), {
    cwd: work,
    env: claudeEnv(job.condition),
    timeoutMs: STEP_TIMEOUT_MS,
  });
  fs.writeFileSync(path.join(runDir, `step-${step}.json`), result.stdout);
  if (result.stderr.trim() !== "") fs.writeFileSync(path.join(runDir, `step-${step}.stderr.txt`), result.stderr);

  const parsed = parseClaudeOutput(result.stdout);
  const usage = emptyUsage();
  const rawUsage = asRecord(parsed?.usage);
  for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] = num(rawUsage[key]) ?? 0;

  const subtype = typeof parsed?.subtype === "string" ? parsed.subtype : "";
  const isError = parsed === null ? null : parsed.is_error === true || subtype.startsWith("error");
  const outcome: StepResult = {
    step,
    ok: false,
    exitCode: result.code,
    timedOut: result.timedOut,
    isError,
    wallMs: result.durationMs,
    durationMs: num(parsed?.duration_ms),
    numTurns: num(parsed?.num_turns),
    costUsd: num(parsed?.total_cost_usd) ?? num(parsed?.cost_usd),
    usage,
  };
  if (result.spawnError !== undefined) outcome.error = `claude を起動できませんでした：${result.spawnError}`;
  else if (result.timedOut) outcome.error = `${fmtLimit(STEP_TIMEOUT_MS)}のタイムアウトで止めました`;
  else if (parsed === null) outcome.error = `出力を JSON として読めませんでした（終了コード ${result.code}）：${clip(result.stderr || result.stdout)}`;
  else if (isError) outcome.error = `claude がエラーを返しました（${subtype || "is_error"}）：${clip(String(parsed.result ?? ""))}`;
  else if (result.code !== 0) outcome.error = `終了コード ${result.code}：${clip(result.stderr)}`;
  outcome.ok = outcome.error === undefined;
  return outcome;
}

async function measureViolations(task: Task, work: string, runDir: string, base: string): Promise<Measure> {
  if (!fs.existsSync(CLI)) return emptyMeasure("src/cli.ts がまだありません（measure_error）");
  const wisdomDir = path.join(runDir, "measure");
  const env = { ...process.env, NO_COLOR: "1" };

  const init = await runCommand("node", initArgs(task, work, wisdomDir), { cwd: PLUGIN_ROOT, env, timeoutMs: SETUP_TIMEOUT_MS });
  if (init.code !== 0) return emptyMeasure(`測定用の init に失敗しました：${clip(init.spawnError ?? (init.stderr || init.stdout))}`);

  const checkArgs = [CLI, "check", "--project", work, "--wisdom-dir", wisdomDir, "--diff", base, "--json", "--fail-on", "never"];
  const check = await runCommand("node", checkArgs, { cwd: PLUGIN_ROOT, env, timeoutMs: SETUP_TIMEOUT_MS });
  fs.writeFileSync(path.join(runDir, "check.json"), check.stdout);
  if (check.code !== 0) return emptyMeasure(`測定用の check に失敗しました：${clip(check.spawnError ?? (check.stderr || check.stdout))}`);

  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(check.stdout));
  } catch (error) {
    return emptyMeasure(`check の出力を JSON として読めませんでした：${messageOf(error)}`);
  }
  if (!Array.isArray(parsed.findings)) return emptyMeasure("check の出力に findings がありません");

  const measure: Measure = {
    ok: true,
    total: 0,
    bySeverity: {},
    blocking: 0,
    byPrinciple: {},
    score: 0,
    waived: Array.isArray(parsed.waived) ? parsed.waived.length : 0,
    invalidAllows: Array.isArray(parsed.invalidAllows) ? parsed.invalidAllows.length : 0,
    filesScanned: num(parsed.filesScanned) ?? 0,
    checkErrors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [],
  };
  for (const item of parsed.findings) {
    const finding = asRecord(item);
    const severity = String(finding.severity);
    const principle = String(finding.principle);
    measure.total += 1;
    measure.bySeverity[severity] = (measure.bySeverity[severity] ?? 0) + 1;
    measure.byPrinciple[principle] = (measure.byPrinciple[principle] ?? 0) + 1;
    if (finding.blocking === true) measure.blocking += 1;
    measure.score += SEVERITY_WEIGHT[severity] ?? 0;
  }
  return measure;
}

/** node --test の出力（tap でも spec でも）から件数を読む */
function parseNodeTest(text: string): { pass: number; fail: number; total: number } | null {
  const grab = (name: string): number | null => {
    const match = text.match(new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  };
  const pass = grab("pass");
  const fail = grab("fail");
  if (pass === null || fail === null) return null;
  return { pass, fail, total: grab("tests") ?? pass + fail };
}

/** python3 -m unittest の出力から件数を読む */
function parseUnittest(text: string): { pass: number; fail: number; total: number } | null {
  const ran = text.match(/^Ran (\d+) tests? in /m);
  if (!ran) return null;
  const total = Number(ran[1]);
  const summary = text.match(/^(?:OK|FAILED)\b.*$/m)?.[0] ?? "";
  const field = (name: string): number => Number(summary.match(new RegExp(`${name}=(\\d+)`))?.[1] ?? 0);
  const bad = field("failures") + field("errors");
  return { pass: Math.max(0, total - bad - field("skipped")), fail: bad, total };
}

async function runHiddenTests(task: Task, work: string, kind: "functional" | "robustness"): Promise<TestResult> {
  const expected = task.expected[kind];
  if (expected === 0 && !fs.existsSync(path.join(work, "hidden_tests", kind))) return emptyTest(0);

  const python = task.language === "python";
  const command = python ? "python3" : "node";
  const args = python
    ? ["-m", "unittest", "discover", "-s", `hidden_tests/${kind}`, "-t", "."]
    : ["--test", "--test-reporter=tap", `hidden_tests/${kind}/**/*.test.ts`];
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" };
  delete env.NODE_OPTIONS;

  const result = await runCommand(command, args, { cwd: work, env, timeoutMs: TEST_TIMEOUT_MS });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.spawnError !== undefined) return emptyTest(expected, `テストを起動できませんでした：${result.spawnError}`);
  if (result.timedOut) return emptyTest(expected, `${fmtLimit(TEST_TIMEOUT_MS)}のタイムアウトで止めました`);

  const counts = python ? parseUnittest(output) : parseNodeTest(output);
  if (counts === null) return emptyTest(expected, `テストの出力を読めませんでした：${clip(output)}`);
  const pass = Math.min(counts.pass, expected > 0 ? expected : counts.pass);
  const test: TestResult = {
    expected,
    pass,
    fail: counts.fail,
    total: counts.total,
    rate: expected === 0 ? null : pass / expected,
  };
  if (counts.total !== expected) test.error = `テストの件数が task.yaml と合いません（実際 ${counts.total}、task.yaml ${expected}）`;
  return test;
}

function countLines(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").length;
}

async function executeRun(job: Job, options: Options): Promise<RunResult> {
  const id = `${job.task.id}__${job.condition}__${job.rep}`;
  const runDir = path.join(options.out, "runs", id);
  const work = path.join(runDir, "work");
  const startedAt = new Date();
  const result: RunResult = {
    id,
    task: job.task.id,
    condition: job.condition,
    rep: job.rep,
    dryRun: options.dryRun,
    dir: runDir,
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    wallMs: 0,
    baseCommit: null,
    changedFiles: [],
    steps: [],
    totals: { tokens: 0, usage: emptyUsage(), costUsd: 0, durationMs: 0, turns: 0 },
    measure: emptyMeasure("測定に進みませんでした"),
    tests: { functional: emptyTest(job.task.expected.functional), robustness: emptyTest(job.task.expected.robustness) },
    ledgerLines: null,
    errors: [],
  };

  try {
    await prepare(job, options, result, runDir, work);
    if (result.baseCommit !== null) {
      await runSteps(job, options, result, runDir, work);
      await finalize(job, result, runDir, work);
    }
  } catch (error) {
    result.errors.push(`予期しないエラー：${messageOf(error)}`);
  }

  result.finishedAt = new Date().toISOString();
  result.wallMs = Date.now() - startedAt.getTime();
  try {
    fs.writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    result.errors.push(`run.json を書けませんでした：${messageOf(error)}`);
  }
  return result;
}

/** repo/ を複製し、git の基準 commit を作る（wisdom 条件では先に init する） */
async function prepare(job: Job, options: Options, result: RunResult, runDir: string, work: string): Promise<void> {
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.cpSync(path.join(job.task.dir, "repo"), work, { recursive: true });

  try {
    await mustGit(work, ["init", "-q"]);
    if (job.condition === "wisdom") {
      const init = await runCommand("node", initArgs(job.task, work), { cwd: PLUGIN_ROOT, timeoutMs: SETUP_TIMEOUT_MS });
      if (init.code !== 0) {
        const detail = clip(init.spawnError ?? (init.stderr || init.stdout));
        if (!options.dryRun) throw new Error(`wisdom init に失敗したため、この実行は行いません：${detail}`);
        result.errors.push(`init_error：wisdom init に失敗しました（--dry-run なので続けます）：${detail}`);
      }
    }
    await mustGit(work, ["add", "-A"]);
    await mustGit(work, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "baseline"]);
    result.baseCommit = await mustGit(work, ["rev-parse", "HEAD"]);
  } catch (error) {
    result.errors.push(messageOf(error));
  }
}

async function runSteps(job: Job, options: Options, result: RunResult, runDir: string, work: string): Promise<void> {
  if (options.dryRun) {
    fs.cpSync(path.join(job.task.dir, "reference"), work, { recursive: true, force: true });
    return;
  }
  for (let step = 1; step <= job.task.steps.length; step += 1) {
    if (interrupted) {
      result.errors.push("中断されました");
      return;
    }
    log(`${result.id}：ステップ ${step}/${job.task.steps.length} を実行中`);
    const outcome = await runStep(job, options, work, runDir, step);
    result.steps.push(outcome);
    if (!outcome.ok) result.errors.push(`ステップ ${step}：${outcome.error ?? "失敗"}`);
  }
}

/** 測定（隠しテストを置く前に）→ 隠しテスト → 台帳の行数 */
async function finalize(job: Job, result: RunResult, runDir: string, work: string): Promise<void> {
  for (const step of result.steps) {
    result.totals.costUsd += step.costUsd ?? 0;
    result.totals.durationMs += step.durationMs ?? step.wallMs;
    result.totals.turns += step.numTurns ?? 0;
    for (const key of Object.keys(step.usage) as (keyof Usage)[]) result.totals.usage[key] += step.usage[key];
  }
  result.totals.tokens = totalTokens(result.totals.usage);

  const status = await git(work, ["status", "--porcelain", "-uall"]);
  result.changedFiles = status.stdout.split("\n").filter((line) => line.trim() !== "").slice(0, 60);
  if (job.condition === "wisdom") result.ledgerLines = countLines(path.join(work, ".wisdom", "ledger.jsonl"));

  result.measure = await measureViolations(job.task, work, runDir, result.baseCommit ?? "HEAD");
  if (!result.measure.ok) result.errors.push(`measure_error：${result.measure.error ?? "不明"}`);

  fs.cpSync(path.join(job.task.dir, "hidden"), path.join(work, "hidden_tests"), { recursive: true });
  result.tests.functional = await runHiddenTests(job.task, work, "functional");
  result.tests.robustness = await runHiddenTests(job.task, work, "robustness");
  for (const kind of ["functional", "robustness"] as const) {
    const error = result.tests[kind].error;
    if (error !== undefined) result.errors.push(`隠しテスト（${kind}）：${error}`);
  }
}

// ---------------------------------------------------------------- 集計

interface Cell {
  task: string;
  condition: Condition;
  runs: number;
  runsWithErrors: number;
  functional: { pass: number; expected: number };
  robustness: { pass: number; expected: number };
  measuredRuns: number;
  blocking: number;
  score: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
  turns: number;
  ledgerLines: number | null;
}

interface Verdict {
  comparable: boolean;
  note: string;
  scoreReduction: number | null;
  functionalDiff: number | null;
  costIncrease: number | null;
  tokenIncrease: number | null;
  halvedScore: boolean | null;
  functionalHeld: boolean | null;
  costWithinLimit: boolean | null;
  achieved: boolean | null;
}

interface Aggregate {
  cells: Cell[];
  overall: Record<Condition, Cell | null>;
  principles: Record<string, Record<Condition, number>>;
  verdict: Verdict;
}

function hasRunErrors(run: RunResult): boolean {
  // 件数の食い違いだけの注意は、結果の信頼性には関わらないので除く
  return run.errors.some((error) => !error.startsWith("隠しテスト"));
}

function makeCell(task: string, condition: Condition, runs: RunResult[]): Cell {
  const measured = runs.filter((run) => run.measure.ok);
  return {
    task,
    condition,
    runs: runs.length,
    runsWithErrors: runs.filter(hasRunErrors).length,
    functional: {
      pass: sum(runs.map((run) => run.tests.functional.pass)),
      expected: sum(runs.map((run) => run.tests.functional.expected)),
    },
    robustness: {
      pass: sum(runs.map((run) => run.tests.robustness.pass)),
      expected: sum(runs.map((run) => run.tests.robustness.expected)),
    },
    measuredRuns: measured.length,
    blocking: mean(measured.map((run) => run.measure.blocking)),
    score: mean(measured.map((run) => run.measure.score)),
    tokens: mean(runs.map((run) => run.totals.tokens)),
    costUsd: mean(runs.map((run) => run.totals.costUsd)),
    durationMs: mean(runs.map((run) => run.totals.durationMs)),
    turns: mean(runs.map((run) => run.totals.turns)),
    ledgerLines: condition === "wisdom" ? mean(runs.map((run) => run.ledgerLines ?? 0)) : null,
  };
}

/** 課題ごとの平均を足し合わせて、条件ごとの全体を作る */
function sumCells(condition: Condition, cells: Cell[]): Cell | null {
  if (cells.length === 0) return null;
  return {
    task: "(全体)",
    condition,
    runs: sum(cells.map((cell) => cell.runs)),
    runsWithErrors: sum(cells.map((cell) => cell.runsWithErrors)),
    functional: {
      pass: sum(cells.map((cell) => cell.functional.pass)),
      expected: sum(cells.map((cell) => cell.functional.expected)),
    },
    robustness: {
      pass: sum(cells.map((cell) => cell.robustness.pass)),
      expected: sum(cells.map((cell) => cell.robustness.expected)),
    },
    measuredRuns: sum(cells.map((cell) => cell.measuredRuns)),
    blocking: sum(cells.map((cell) => cell.blocking)),
    score: sum(cells.map((cell) => cell.score)),
    tokens: sum(cells.map((cell) => cell.tokens)),
    costUsd: sum(cells.map((cell) => cell.costUsd)),
    durationMs: sum(cells.map((cell) => cell.durationMs)),
    turns: sum(cells.map((cell) => cell.turns)),
    ledgerLines: condition === "wisdom" ? sum(cells.map((cell) => cell.ledgerLines ?? 0)) : null,
  };
}

function rateOf(part: { pass: number; expected: number }): number | null {
  return part.expected === 0 ? null : part.pass / part.expected;
}

function judge(overall: Record<Condition, Cell | null>, dryRun: boolean): Verdict {
  const base = overall.baseline;
  const wisdom = overall.wisdom;
  const verdict: Verdict = {
    comparable: false,
    note: "",
    scoreReduction: null,
    functionalDiff: null,
    costIncrease: null,
    tokenIncrease: null,
    halvedScore: null,
    functionalHeld: null,
    costWithinLimit: null,
    achieved: null,
  };
  if (dryRun) {
    verdict.note = "--dry-run は reference を適用しただけなので、判定しません（隠しテストが正しいかの確認用です）";
    return verdict;
  }
  if (base === null || wisdom === null) {
    verdict.note = "baseline と wisdom の両方を実行したときだけ判定します";
    return verdict;
  }
  verdict.comparable = true;
  if (base.score > 0) verdict.scoreReduction = 1 - wisdom.score / base.score;
  const baseRate = rateOf(base.functional);
  const wisdomRate = rateOf(wisdom.functional);
  if (baseRate !== null && wisdomRate !== null) verdict.functionalDiff = wisdomRate - baseRate;
  if (base.costUsd > 0) verdict.costIncrease = wisdom.costUsd / base.costUsd - 1;
  if (base.tokens > 0) verdict.tokenIncrease = wisdom.tokens / base.tokens - 1;

  verdict.halvedScore = base.score > 0 ? wisdom.score <= base.score / 2 : null;
  verdict.functionalHeld = verdict.functionalDiff === null ? null : verdict.functionalDiff >= -1e-9;
  verdict.costWithinLimit = verdict.costIncrease === null ? null : verdict.costIncrease <= 0.2;
  const checks = [verdict.halvedScore, verdict.functionalHeld, verdict.costWithinLimit];
  if (checks.some((check) => check === false)) verdict.achieved = false;
  else if (checks.every((check) => check === true)) verdict.achieved = true;
  if (base.score === 0) verdict.note = "baseline の違反点が 0 なので、減少率は判定できません";
  return verdict;
}

function aggregate(runs: RunResult[], options: Options, taskIds: string[]): Aggregate {
  const cells: Cell[] = [];
  for (const task of taskIds) {
    for (const condition of options.conditions) {
      const group = runs.filter((run) => run.task === task && run.condition === condition);
      if (group.length > 0) cells.push(makeCell(task, condition, group));
    }
  }
  const overall = {
    baseline: sumCells("baseline", cells.filter((cell) => cell.condition === "baseline")),
    wisdom: sumCells("wisdom", cells.filter((cell) => cell.condition === "wisdom")),
  };
  const principles: Record<string, Record<Condition, number>> = {};
  for (const run of runs) {
    for (const [principle, count] of Object.entries(run.measure.byPrinciple)) {
      principles[principle] ??= { baseline: 0, wisdom: 0 };
      principles[principle][run.condition] += count;
    }
  }
  return { cells, overall, principles, verdict: judge(overall, options.dryRun) };
}

// ---------------------------------------------------------------- summary.md

function fmtRate(part: { pass: number; expected: number }): string {
  const rate = rateOf(part);
  if (rate === null) return "—";
  return `${part.pass}/${part.expected}（${Math.round(rate * 100)}%）`;
}

function fmtNum(value: number, digits = 1): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function fmtCost(value: number, dryRun: boolean): string {
  return dryRun ? "—" : `$${value.toFixed(3)}`;
}

function fmtTokens(value: number, dryRun: boolean): string {
  return dryRun ? "—" : Math.round(value).toLocaleString("en-US");
}

function fmtSeconds(ms: number, dryRun: boolean): string {
  return dryRun ? "—" : String(Math.round(ms / 1000));
}

function fmtPercent(value: number | null, signed = false): string {
  if (value === null) return "—";
  const text = `${Math.round(value * 1000) / 10}%`;
  return signed && value > 0 ? `+${text}` : text;
}

function mark(value: boolean | null): string {
  if (value === null) return "判定不能";
  return value ? "○ 達成" : "× 未達";
}

function cellRow(cell: Cell, dryRun: boolean): string {
  const errors = cell.runsWithErrors > 0 ? ` ⚠${cell.runsWithErrors}` : "";
  const violations = cell.measuredRuns === 0 ? ["測定なし", "測定なし"] : [fmtNum(cell.blocking), fmtNum(cell.score)];
  return [
    cell.condition,
    `${cell.runs}${errors}`,
    fmtRate(cell.functional),
    fmtRate(cell.robustness),
    ...violations,
    fmtTokens(cell.tokens, dryRun),
    fmtCost(cell.costUsd, dryRun),
    fmtSeconds(cell.durationMs, dryRun),
    dryRun ? "—" : fmtNum(cell.turns),
    cell.ledgerLines === null ? "—" : fmtNum(cell.ledgerLines),
  ].join(" | ");
}

const TABLE_HEAD =
  "| 条件 | 回数 | 機能テスト | 堅牢さテスト | 必須違反 | 違反点 | トークン合計 | 費用 | 時間(秒) | ターン数 | 台帳の行数 |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|";

function renderSummary(runs: RunResult[], options: Options, tasks: Task[], result: Aggregate, finishedAt: Date): string {
  const lines: string[] = [];
  const dry = options.dryRun;
  lines.push("# AI Code Wisdom 評価結果", "");
  lines.push(`- 実行：${options.dryRun ? "dry-run（claude は呼ばず、reference を適用）" : "通常実行"} ／ 終了 ${finishedAt.toLocaleString("ja-JP")}`);
  lines.push(`- モデル：${dry ? "—" : options.model} ／ 条件：${options.conditions.join(", ")} ／ 繰り返し：${options.reps} ／ 課題：${tasks.length} 件`);
  lines.push(`- 出力先：${options.out}`);
  lines.push("- 表の読み方：機能テスト・堅牢さテストは隠しテストの通過数／件数。必須違反は blocking な指摘の数。違反点は error×3 ＋ warning×2 ＋ info×1（例外コメントで除いた指摘は含まない）。トークンは入力・出力・キャッシュ作成・キャッシュ読み込みの合計。複数回の実行は平均（テストは合算）。⚠ はエラーのあった実行の数。");
  lines.push("");

  lines.push("## 課題ごとの結果", "");
  for (const task of tasks) {
    const cells = result.cells.filter((cell) => cell.task === task.id);
    if (cells.length === 0) continue;
    lines.push(`### ${task.id} — ${task.title}`, "", TABLE_HEAD);
    for (const cell of cells) lines.push(`| ${cellRow(cell, dry)} |`);
    lines.push("");
  }

  lines.push("## 全体", "");
  const { baseline, wisdom } = result.overall;
  lines.push(TABLE_HEAD);
  for (const cell of [baseline, wisdom]) if (cell !== null) lines.push(`| ${cellRow(cell, dry)} |`);
  lines.push("");

  const verdict = result.verdict;
  lines.push("### 完了条件の判定", "");
  if (!verdict.comparable) {
    lines.push(`判定：対象外。${verdict.note}`, "");
  } else {
    lines.push("| 条件 | 値 | 判定 |", "|---|---|---|");
    lines.push(`| 違反点が半分以下（減少率） | ${fmtPercent(verdict.scoreReduction)} | ${mark(verdict.halvedScore)} |`);
    lines.push(`| 機能テストの通過率が下がらない（差） | ${verdict.functionalDiff === null ? "—" : `${fmtNum(verdict.functionalDiff * 100)} ポイント`} | ${mark(verdict.functionalHeld)} |`);
    lines.push(`| 費用の増加が 20% 以内 | ${fmtPercent(verdict.costIncrease, true)} | ${mark(verdict.costWithinLimit)} |`);
    lines.push("");
    lines.push(`参考：トークンの増加 ${fmtPercent(verdict.tokenIncrease, true)}。`);
    const overallMark = verdict.achieved === null ? "判定不能（判定できない項目があります）" : verdict.achieved ? "達成" : "未達";
    lines.push("", `**総合判定：${overallMark}**${verdict.note ? `（${verdict.note}）` : ""}`, "");
    const brokenRuns = runs.filter((run) => run.steps.some((step) => !step.ok)).length;
    if (brokenRuns > 0) lines.push(`注意：${brokenRuns} 件の実行で claude のステップが失敗しています。費用・トークン・テストの比較にはその結果も含まれています。`, "");
  }

  const principleNames = Object.keys(result.principles).sort();
  if (principleNames.length > 0) {
    lines.push("### 原則ごとの違反数（全実行の合計）", "", "| 原則 | baseline | wisdom |", "|---|---|---|");
    for (const name of principleNames) {
      lines.push(`| ${name} | ${result.principles[name].baseline} | ${result.principles[name].wisdom} |`);
    }
    lines.push("");
  }

  lines.push("## 実行ごとの記録", "", "| 実行 | 機能 | 堅牢さ | 必須違反 | 違反点 | 例外 | 費用 | 注意 |", "|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    const f = run.tests.functional;
    const r = run.tests.robustness;
    const m = run.measure;
    lines.push(
      `| ${run.id} | ${f.pass}/${f.expected} | ${r.expected === 0 ? "—" : `${r.pass}/${r.expected}`} | ${m.ok ? m.blocking : "—"} | ${m.ok ? m.score : "—"} | ${m.ok ? m.waived : "—"} | ${fmtCost(run.totals.costUsd, dry)} | ${run.errors.length === 0 ? "" : `${run.errors.length} 件`} |`,
    );
  }
  lines.push("");

  const withErrors = runs.filter((run) => run.errors.length > 0);
  if (withErrors.length > 0) {
    lines.push("## エラーと注意", "");
    for (const run of withErrors) {
      lines.push(`### ${run.id}`, "");
      for (const error of run.errors) lines.push(`- ${error}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- 出力

function writeOutputs(runs: RunResult[], options: Options, tasks: Task[], startedAt: Date, finished: boolean, claudeVersion: string | null): Aggregate {
  const result = aggregate(runs, options, tasks.map((task) => task.id));
  const finishedAt = new Date();
  const ordered = [...runs].sort((a, b) => a.id.localeCompare(b.id));
  const json = {
    meta: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      finished,
      dryRun: options.dryRun,
      model: options.dryRun ? null : options.model,
      claudeVersion,
      conditions: options.conditions,
      reps: options.reps,
      concurrency: options.concurrency,
      tasks: tasks.map((task) => task.id),
      pluginRoot: PLUGIN_ROOT,
    },
    runs: ordered,
    aggregate: result,
  };
  fs.mkdirSync(options.out, { recursive: true });
  fs.writeFileSync(path.join(options.out, "results.json"), `${JSON.stringify(json, null, 2)}\n`);
  fs.writeFileSync(path.join(options.out, "summary.md"), renderSummary(ordered, options, tasks, result, finishedAt));
  return result;
}

function describeRun(run: RunResult): string {
  const f = run.tests.functional;
  const r = run.tests.robustness;
  const measured = run.measure.ok ? `必須違反 ${run.measure.blocking}／違反点 ${run.measure.score}` : "測定なし";
  const robust = r.expected === 0 ? "" : `／堅牢さ ${r.pass}/${r.expected}`;
  const errors = run.errors.length > 0 ? `／注意 ${run.errors.length} 件` : "";
  return `${run.id}：機能 ${f.pass}/${f.expected}${robust}／${measured}${errors}`;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const tasks: Task[] = [];
  for (const id of options.tasks) {
    try {
      tasks.push(loadTask(id));
    } catch (error) {
      return fail(messageOf(error));
    }
  }

  const startedAt = new Date();
  fs.mkdirSync(options.out, { recursive: true });
  let claudeVersion: string | null = null;
  if (!options.dryRun) {
    const version = await runCommand("claude", ["--version"], { cwd: PLUGIN_ROOT, timeoutMs: 30_000 });
    claudeVersion = version.code === 0 ? version.stdout.trim() : null;
    if (claudeVersion === null) console.error(`eval: 注意：claude --version に失敗しました（${clip(version.spawnError ?? version.stderr)}）。各ステップがエラーになる可能性があります。`);
  }

  const jobs: Job[] = [];
  for (const task of tasks) {
    for (const condition of options.conditions) {
      for (let rep = 1; rep <= options.reps; rep += 1) jobs.push({ task, condition, rep });
    }
  }
  log(`${jobs.length} 件の実行を始めます（同時 ${options.concurrency}）${options.dryRun ? " [dry-run]" : ""} → ${options.out}`);

  const runs: RunResult[] = [];
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    console.error("\neval: 中断します。動いている処理を止めて、ここまでの結果を書き出します。");
    for (const child of activeChildren) killTree(child, "SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await runPool(jobs, options.concurrency, async (job) => {
    log(`開始：${job.task.id}__${job.condition}__${job.rep}`);
    const run = await executeRun(job, options);
    runs.push(run);
    log(`完了：${describeRun(run)}`);
    try {
      writeOutputs(runs, options, tasks, startedAt, false, claudeVersion);
    } catch (error) {
      console.error(`eval: 途中結果を書けませんでした：${messageOf(error)}`);
    }
  });

  const result = writeOutputs(runs, options, tasks, startedAt, !interrupted, claudeVersion);
  console.log(`\n${fs.readFileSync(path.join(options.out, "summary.md"), "utf8")}`);
  log(`results.json と summary.md を書きました：${options.out}`);

  if (interrupted) return 130;
  if (options.dryRun) {
    // reference がすべての隠しテストを通ることが、dry-run の合格条件
    const cells = result.cells;
    const allPass = cells.every((cell) => cell.functional.pass === cell.functional.expected && cell.robustness.pass === cell.robustness.expected);
    const clean = runs.every((run) => run.errors.every((error) => error.startsWith("measure_error") || error.startsWith("init_error")));
    if (!allPass || !clean) {
      console.error("eval: dry-run：reference が隠しテストをすべては通っていません。上の表とエラーを確認してください。");
      return 1;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`eval: 予期しないエラー：${messageOf(error)}`);
    process.exit(2);
  },
);
