import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { check, type CheckResult, type Finding } from "./core/checker.ts";
import { exportAgentsMd, exportCursorRules, exportGitHook } from "./core/exporters.ts";
import { git } from "./core/git.ts";
import { listPacks } from "./core/packs.ts";
import {
  BUNDLED_PACKS_DIR,
  findProjectRoot,
  languageOf,
  projectPaths,
  relativeToRoot,
  type ProjectPaths,
} from "./core/paths.ts";
import type { Phase } from "./core/profile.ts";
import {
  applyUpdate,
  checkLock,
  initProject,
  planUpdate,
  relock,
  setStyle,
  type StyleChoice,
} from "./core/project.ts";
import {
  findPrincipleForExplain,
  guessLayers,
  levelLabel,
  renderCheckReport,
  renderExplain,
  renderStyles,
  reviewPointsFor,
} from "./core/render.ts";
import { loadCompiled, type Compiled } from "./core/resolve.ts";
import { listFileStates } from "./core/session.ts";
import { runHook } from "./hooks.ts";
import { runMcpServer } from "./mcp.ts";

const USAGE = `AI Code Wisdom（wisdom）：選んだ設計スタイルを、AI が開発から保守まで守り続けるための道具

使い方：wisdom <コマンド> [オプション]

設定
  init [--primary ID] [--secondary ID[:重み]]... [--phase production|prototype]
       [--review auto|off|always] [--force]     設計スタイルを選んで、このプロジェクトを設定する
  styles [--json]                               選べるスタイルの一覧
  style                                         今の設定を表示する
  style set [--primary ID] [--secondary ID[:重み]...|none] [--phase ...] [--review ...]
                                                設定を変える
  status                                        設定・パック・lock の状態を確認する
  principles [--json]                           有効な原則を優先順に表示する
  explain <ID>                                  原則の理由・検査方法・例を表示する
  update [--yes]                                同梱パックの新しい版との差分を見る（--yes で適用）
  lock                                          手で編集したパックを lock.json に記録し直す

検査
  check [パス...] [--diff <ref>] [--changed] [--json] [--fail-on blocking|error|warning|never]
                                                静的検査（既定は必須の違反があれば終了コード 1）
  audit [--json]                                全体を検査して、原則ごとの件数・例外・前回からの増減を表示する
  review-context [--diff <ref>]                 レビュー役のための材料を表示する

連携
  export agents-md|cursor|git-hook              Claude Code 以外の環境向けの設定を書き出す
  hook <event>                                  Claude Code のフック（標準入力に JSON）
  mcp                                           MCP サーバーとして動く（標準入出力）

共通オプション
  --project <dir>       プロジェクトのディレクトリ（既定は現在のディレクトリ。init 以外は親へたどって探す）
  --wisdom-dir <dir>    設定の置き場所を変える（指定時は --project をそのままルートにする）
`;

type Values = Record<string, any>;

// head などに繋いで途中で閉じられても、エラーを出さずに終わる
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

const COMMON_OPTIONS = {
  project: { type: "string" },
  "wisdom-dir": { type: "string" },
} as const;

function parse(args: string[], options: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {}) {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { ...COMMON_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Values, positionals };
  } catch (err) {
    throw new Error(`オプションを解釈できません：${(err as Error).message}`);
  }
}

function out(text = ""): void {
  process.stdout.write(text + "\n");
}

function startDir(values: Values): string {
  return path.resolve(values.project ?? process.cwd());
}

/** 設定済みのプロジェクトの paths。見つからなければエラー */
function configuredPaths(values: Values): ProjectPaths {
  const start = startDir(values);
  if (values["wisdom-dir"]) {
    const paths = projectPaths(start, path.resolve(values["wisdom-dir"]));
    if (!fs.existsSync(paths.profile)) throw new Error("未設定です。wisdom init を実行してください");
    return paths;
  }
  const root = findProjectRoot(start);
  if (!root) throw new Error("未設定です。wisdom init を実行してください");
  return projectPaths(root);
}

function parseSecondary(items: string[]): { pack: string; weight: number }[] {
  return items.map((item) => {
    const [pack, w] = item.split(":");
    const weight = w === undefined ? 0.5 : Number(w);
    if (!pack || !(weight > 0 && weight < 1)) {
      throw new Error(`副スタイル ${item} の指定が正しくありません（ID または ID:重み。重みは 0 より大きく 1 より小さい値）`);
    }
    return { pack, weight };
  });
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} は ${allowed.join(" / ")} のどれかです（${value}）`);
  return value as T;
}

const PHASES = ["production", "prototype"] as const;
const REVIEWS = ["auto", "off", "always"] as const;
const PHASE_LABEL: Record<Phase, string> = { production: "本番（production）", prototype: "試作（prototype）" };

function describeSetup(compiled: Compiled): string[] {
  const primary = compiled.packs.find((p) => p.role === "primary");
  const secondary = compiled.packs.filter((p) => p.role === "secondary");
  const mandatory = compiled.principles.filter((p) => p.level === "mandatory").length;
  return [
    `主スタイル：${primary?.name}（${primary?.id}）`,
    `副スタイル：${secondary.length ? secondary.map((p) => `${p.name}（${p.id}、重み ${p.weight}）`).join("、") : "なし"}`,
    `段階：${PHASE_LABEL[compiled.profile.phase]} ／ レビュー：${compiled.profile.review}`,
    `有効な原則：${compiled.principles.length} 件（うち必須 ${mandatory} 件） ／ 静的検査のルール：${compiled.rules.length} 本`,
  ];
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

async function promptChoice(): Promise<StyleChoice> {
  const packs = listPacks(BUNDLED_PACKS_DIR);
  out(renderStyles(packs));
  out();
  out("選べるスタイル：");
  packs.forEach((p, i) => out(`  ${i + 1}. ${p.name}（${p.id}）`));
  out();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pick = (answer: string): string => {
      const byNumber = packs[Number(answer) - 1];
      const found = byNumber ?? packs.find((p) => p.id === answer);
      if (!found) throw new Error(`「${answer}」というスタイルはありません`);
      return found.id;
    };
    const primary = pick(await ask(rl, "主スタイルの番号（1つ）："));
    const secondaryAnswer = await ask(rl, "副スタイルの番号（カンマ区切り、空なら副スタイルなし）：");
    const secondary = secondaryAnswer
      ? secondaryAnswer.split(",").map((s) => ({ pack: pick(s.trim()), weight: 0.5 }))
      : [];
    const phaseAnswer = await ask(rl, "段階（1=本番 2=試作、空なら本番）：");
    const phase: Phase = phaseAnswer === "2" || phaseAnswer === "prototype" ? "prototype" : "production";
    return { primary, secondary, phase };
  } finally {
    rl.close();
  }
}

async function cmdInit(args: string[]): Promise<number> {
  const { values } = parse(args, {
    primary: { type: "string" },
    secondary: { type: "string", multiple: true },
    phase: { type: "string" },
    review: { type: "string" },
    force: { type: "boolean" },
  });
  const root = startDir(values);
  const paths = projectPaths(root, values["wisdom-dir"] ? path.resolve(values["wisdom-dir"]) : undefined);
  let choice: StyleChoice;
  if (values.primary) {
    choice = {
      primary: values.primary,
      secondary: parseSecondary(values.secondary ?? []),
      phase: oneOf(values.phase, PHASES, "--phase"),
      review: oneOf(values.review, REVIEWS, "--review"),
    };
  } else if (process.stdin.isTTY) {
    choice = await promptChoice();
    choice.review = oneOf(values.review, REVIEWS, "--review");
  } else {
    process.stderr.write("wisdom: エラー：--primary で主スタイルを指定してください（例：wisdom init --primary security-resilience）\n\n" + USAGE);
    return 2;
  }
  const compiled = initProject(paths, choice, { force: values.force === true });
  out("設定しました。");
  for (const line of describeSetup(compiled)) out(line);
  out("作ったファイル：");
  const shown = (f: string) => relativeToRoot(paths.root, f) ?? f;
  for (const f of [paths.profile, paths.lock, paths.decisions, path.join(paths.wisdomDir, ".gitignore")]) out(`  ${shown(f)}`);
  for (const p of compiled.packs) out(`  ${shown(path.join(paths.packsDir, p.id))}/`);
  return 0;
}

function cmdStyles(args: string[]): number {
  const { values } = parse(args, { json: { type: "boolean" } });
  const packs = listPacks(BUNDLED_PACKS_DIR);
  if (values.json) {
    out(
      JSON.stringify(
        packs.map((p) => ({
          id: p.id,
          version: p.version,
          name: p.name,
          description: p.description,
          values: p.values,
          suited_for: p.suited_for,
          tradeoffs: p.tradeoffs,
          principles: p.principles.length,
          mandatory: p.principles.filter((x) => x.level === "mandatory").length,
          verification: p.verification ?? {},
        })),
        null,
        2,
      ),
    );
  } else {
    out(renderStyles(packs));
  }
  return 0;
}

function cmdStyle(args: string[]): number {
  const { values, positionals } = parse(args, {
    primary: { type: "string" },
    secondary: { type: "string", multiple: true },
    phase: { type: "string" },
    review: { type: "string" },
  });
  const paths = configuredPaths(values);
  const sub = positionals[0];
  if (sub === undefined) {
    for (const line of describeSetup(loadCompiled(paths))) out(line);
    return 0;
  }
  if (sub !== "set") throw new Error(`style のサブコマンドは set だけです（${sub}）`);
  const change: Partial<StyleChoice> = {};
  if (values.primary) change.primary = values.primary;
  if (values.secondary) {
    const items: string[] = values.secondary;
    change.secondary = items.length === 1 && items[0] === "none" ? [] : parseSecondary(items);
  }
  change.phase = oneOf(values.phase, PHASES, "--phase");
  change.review = oneOf(values.review, REVIEWS, "--review");
  if (!change.primary && !change.secondary && !change.phase && !change.review) {
    throw new Error("変更する項目を指定してください（--primary / --secondary / --phase / --review）");
  }
  const compiled = setStyle(paths, change);
  out("変更しました。");
  for (const line of describeSetup(compiled)) out(line);
  return 0;
}

function cmdStatus(args: string[]): number {
  const { values } = parse(args);
  const paths = configuredPaths(values);
  const compiled = loadCompiled(paths);
  out(`プロジェクト：${paths.root}`);
  out(`設定：${paths.profile}`);
  for (const line of describeSetup(compiled)) out(line);
  out("パック：");
  for (const p of compiled.packs) {
    out(`  - ${p.id} 版 ${p.version}（ハッシュ ${p.hash}、${p.role === "primary" ? "主" : `副、重み ${p.weight}`}）`);
  }
  const lock = checkLock(paths);
  out(lock.ok ? "lock.json：問題なし" : "lock.json：");
  for (const problem of lock.problems) out(`  - ${problem}`);
  if (compiled.warnings.length) {
    out("注意：");
    for (const w of compiled.warnings) out(`  - ${w}`);
  }
  if (compiled.skipped.length) {
    out("外した原則：");
    for (const s of compiled.skipped) out(`  - ${s.id}：${s.reason}`);
  }
  return 0;
}

function cmdPrinciples(args: string[]): number {
  const { values } = parse(args, { json: { type: "boolean" } });
  const compiled = loadCompiled(configuredPaths(values));
  if (values.json) {
    out(
      JSON.stringify(
        compiled.principles.map((p) => ({
          id: p.id,
          level: p.level,
          summary: p.summary,
          title: p.title,
          pack: p.pack,
          rank: p.rank,
        })),
        null,
        2,
      ),
    );
  } else {
    for (const p of compiled.principles) out(`[${p.id}] ${levelLabel(p.level)} ${p.summary}`);
  }
  return 0;
}

function cmdExplain(args: string[]): number {
  const { values, positionals } = parse(args);
  const id = positionals[0];
  if (!id) throw new Error("原則の ID を指定してください（例：wisdom explain SEC-INJ-002）");
  let paths: ProjectPaths | null = null;
  try {
    paths = configuredPaths(values);
  } catch {
    // 未設定でも、同梱パックから探せる
  }
  const found = findPrincipleForExplain(paths, paths ? loadCompiled(paths) : null, id);
  if (!found) throw new Error(`原則 ${id} は見つかりません`);
  out(renderExplain(found));
  return 0;
}

function failsOn(result: CheckResult, failOn: string): boolean {
  const any = (pred: (f: Finding) => boolean) => result.findings.some(pred);
  switch (failOn) {
    case "never":
      return false;
    case "error":
      return any((f) => f.blocking || f.severity === "error");
    case "warning":
      return any((f) => f.blocking || f.severity === "error" || f.severity === "warning");
    default:
      return any((f) => f.blocking);
  }
}

function cmdCheck(args: string[]): number {
  const { values, positionals } = parse(args, {
    diff: { type: "string" },
    changed: { type: "boolean" },
    json: { type: "boolean" },
    "fail-on": { type: "string" },
  });
  const failOn = oneOf(values["fail-on"], ["blocking", "error", "warning", "never"] as const, "--fail-on") ?? "blocking";
  const paths = configuredPaths(values);
  const compiled = loadCompiled(paths);
  const result = check(paths, compiled, {
    paths: positionals.map((p) => path.resolve(p)),
    diffBase: values.diff ?? (values.changed ? "HEAD" : undefined),
  });
  out(values.json ? JSON.stringify(result, null, 2) : renderCheckReport(result));
  return failsOn(result, failOn) ? 1 : 0;
}

interface AuditRecord {
  ts: string;
  total: number;
  byPrinciple: Record<string, number>;
}

function readLastAudit(file: string): AuditRecord | null {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as AuditRecord;
    } catch {
      // 壊れた行は飛ばして、その前を見る
    }
  }
  return null;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function cmdAudit(args: string[]): number {
  const { values } = parse(args, { json: { type: "boolean" } });
  const paths = configuredPaths(values);
  const result = check(paths, loadCompiled(paths));
  const previous = readLastAudit(paths.auditHistory);

  const byPrinciple: Record<string, number> = {};
  const bySeverity: Record<string, Record<string, number>> = {};
  for (const f of result.findings) {
    byPrinciple[f.principle] = (byPrinciple[f.principle] ?? 0) + 1;
    const sev = (bySeverity[f.principle] ??= {});
    sev[f.severity] = (sev[f.severity] ?? 0) + 1;
  }
  const record: AuditRecord = { ts: new Date().toISOString(), total: result.findings.length, byPrinciple };
  fs.mkdirSync(path.dirname(paths.auditHistory), { recursive: true });
  fs.appendFileSync(paths.auditHistory, JSON.stringify(record) + "\n");

  const waived = result.waived.map((w) => ({
    file: w.finding.file,
    line: w.finding.line,
    principle: w.finding.principle,
    reason: w.reason,
  }));
  const invalid = result.invalidAllows.map((f) => ({ file: f.file, line: f.line, principle: f.principle }));
  if (values.json) {
    out(
      JSON.stringify(
        {
          ts: record.ts,
          filesScanned: result.filesScanned,
          total: record.total,
          byPrinciple: Object.fromEntries(
            Object.entries(byPrinciple).map(([id, total]) => [id, { total, ...bySeverity[id] }]),
          ),
          waived,
          invalidAllows: invalid,
          previous: previous ? { ts: previous.ts, total: previous.total } : null,
          delta: previous ? record.total - previous.total : null,
          errors: result.errors,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`## 監査結果（${result.filesScanned} ファイル）`);
  out(`指摘 ${record.total} 件 ／ 必須の違反 ${result.findings.filter((f) => f.blocking).length} 件`);
  out();
  out("### 原則ごとの件数");
  const ids = Object.keys(byPrinciple).sort((a, b) => byPrinciple[b] - byPrinciple[a] || a.localeCompare(b));
  if (ids.length === 0) out("- 指摘はありません");
  for (const id of ids) {
    const sev = ["error", "warning", "info", "hint"]
      .filter((s) => bySeverity[id][s])
      .map((s) => `${s} ${bySeverity[id][s]}`)
      .join(" / ");
    out(`- [${id}] ${byPrinciple[id]} 件（${sev}）`);
  }
  out();
  out(`### 例外（wisdom-allow）${waived.length} 件`);
  for (const w of waived) out(`- ${w.file}:${w.line} [${w.principle}] ${w.reason}`);
  if (invalid.length) {
    out();
    out(`### 理由のない例外 ${invalid.length} 件（例外として扱われていません）`);
    for (const w of invalid) out(`- ${w.file}:${w.line} [${w.principle}]`);
  }
  out();
  if (previous) {
    out(`### 前回（${previous.ts}）からの増減`);
    out(`全体：${previous.total} → ${record.total}（${signed(record.total - previous.total)}）`);
    const all = new Set([...Object.keys(previous.byPrinciple), ...ids]);
    for (const id of [...all].sort()) {
      const d = (byPrinciple[id] ?? 0) - (previous.byPrinciple[id] ?? 0);
      if (d !== 0) out(`- [${id}] ${signed(d)}`);
    }
  } else {
    out("### 前回からの増減\n前回の記録はありません（今回が最初の監査です）");
  }
  for (const e of result.errors) out(`注意：${e}`);
  return 0;
}

function cmdUpdate(args: string[]): number {
  const { values } = parse(args, { yes: { type: "boolean" } });
  const paths = configuredPaths(values);
  const plans = planUpdate(paths);
  if (plans.length === 0) {
    out("更新はありません（プロジェクトのパックは同梱の版と同じです）");
    return 0;
  }
  for (const plan of plans) {
    out(`${plan.pack}：${plan.from} → ${plan.to}`);
    out(`  追加：${plan.diff.added.join(", ") || "なし"}`);
    out(`  削除：${plan.diff.removed.join(", ") || "なし"}`);
    out(`  変更：${plan.diff.changed.join(", ") || "なし"}`);
    out(`  検査ルールの変更：${plan.diff.rulesChanged ? "あり" : "なし"}`);
  }
  if (values.yes) {
    applyUpdate(paths, plans.map((p) => p.pack));
    out("更新しました。");
  } else {
    out("適用するには wisdom update --yes を実行してください");
  }
  return 0;
}

function cmdLock(args: string[]): number {
  const { values } = parse(args);
  relock(configuredPaths(values));
  out("lock.json を記録し直しました");
  return 0;
}

function cmdExport(args: string[]): number {
  const { values, positionals } = parse(args);
  const target = positionals[0];
  if (!["agents-md", "cursor", "git-hook"].includes(target ?? "")) {
    throw new Error("export の対象は agents-md / cursor / git-hook のどれかです");
  }
  const paths = configuredPaths(values);
  let file: string;
  if (target === "git-hook") file = exportGitHook(paths);
  else if (target === "cursor") file = exportCursorRules(paths, loadCompiled(paths));
  else file = exportAgentsMd(paths, loadCompiled(paths));
  out(`書き出しました：${file}`);
  return 0;
}

function gitLines(root: string, args: string[]): string[] {
  const r = git(root, args);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function latestSessionFiles(paths: ProjectPaths): string[] {
  if (!fs.existsSync(paths.sessionsDir)) return [];
  const dirs = fs
    .readdirSync(paths.sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(paths.sessionsDir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return dirs.length ? listFileStates(paths, dirs[0].name).map((s) => s.file) : [];
}

function cmdReviewContext(args: string[]): number {
  const { values } = parse(args, { diff: { type: "string" } });
  const paths = configuredPaths(values);
  const compiled = loadCompiled(paths);
  const ref: string = values.diff ?? "HEAD";
  const inGit = git(paths.root, ["rev-parse", "--is-inside-work-tree"]).status === 0;

  let candidates: string[];
  if (inGit) {
    const diffNames = git(paths.root, ["diff", "--name-only", "--relative", ref]);
    // 最初のコミット前など、基準がないときは追跡中のファイルすべてを対象にする
    const changed = diffNames.status === 0 ? diffNames.stdout.split("\n").filter(Boolean) : gitLines(paths.root, ["ls-files"]);
    candidates = [...changed, ...gitLines(paths.root, ["ls-files", "--others", "--exclude-standard"])];
  } else {
    candidates = latestSessionFiles(paths);
  }
  const files = [...new Set(candidates)].filter(
    (f) => languageOf(f) && fs.existsSync(path.join(paths.root, f)) && !f.startsWith(".wisdom/"),
  );
  if (files.length === 0) {
    out("レビュー対象のファイルはありません（対応言語の変更が見つかりませんでした）");
    return 0;
  }

  const result = check(paths, compiled, { paths: files });
  out(`# レビューの材料（${files.length} ファイル）`);
  for (const file of files) {
    out();
    out(`## ${file}`);
    const layers = guessLayers(file);
    out(`層：${layers.length ? layers.join("、") : "判定なし"}`);
    out(reviewPointsFor(compiled, file));
    const mine = result.findings.filter((f) => f.file === file);
    out("静的検査：");
    if (mine.length === 0) out("- 指摘なし");
    for (const f of mine) out(`- L${f.line} ${f.severity}${f.blocking ? " 必須" : ""} [${f.principle}] ${f.message}`);
  }
  for (const e of result.errors) out(`注意：${e}`);
  if (inGit) {
    const diff = git(paths.root, ["diff", ref, "--", ...files]);
    const lines = diff.status === 0 ? diff.stdout.split("\n") : [];
    out();
    out("## git diff");
    if (lines.length > 400) {
      out(lines.slice(0, 400).join("\n"));
      out(`（400 行で打ち切りました。全体は ${lines.length} 行です）`);
    } else {
      out(lines.join("\n").trimEnd() || "（差分はありません。未追跡のファイルは上の一覧を参照してください）");
    }
  }
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** フックは何があっても利用者のセッションを壊さない。例外はログに残して 0 で終わる */
async function cmdHook(args: string[]): Promise<number> {
  let event = "";
  try {
    event = args[0] ?? "";
    let input: any = {};
    try {
      input = JSON.parse(await readStdin());
    } catch {
      input = {};
    }
    const result = runHook(event, input, process.env);
    if (result.stdout) process.stdout.write(result.stdout + "\n");
    return result.exitCode;
  } catch (err) {
    try {
      const root = findProjectRoot(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
      if (root) {
        const log = path.join(projectPaths(root).cacheDir, "hook-errors.log");
        fs.mkdirSync(path.dirname(log), { recursive: true });
        fs.appendFileSync(log, `${new Date().toISOString()}\t${event}\t${(err as Error).stack ?? err}\n`);
      }
    } catch {
      // ログも書けないときは黙って終わる
    }
    return 0;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(USAGE.trimEnd());
      return 0;
    case "init":
      return cmdInit(rest);
    case "styles":
      return cmdStyles(rest);
    case "style":
      return cmdStyle(rest);
    case "status":
      return cmdStatus(rest);
    case "principles":
      return cmdPrinciples(rest);
    case "explain":
      return cmdExplain(rest);
    case "check":
      return cmdCheck(rest);
    case "audit":
      return cmdAudit(rest);
    case "update":
      return cmdUpdate(rest);
    case "lock":
      return cmdLock(rest);
    case "export":
      return cmdExport(rest);
    case "review-context":
      return cmdReviewContext(rest);
    case "hook":
      return cmdHook(rest);
    case "mcp":
      runMcpServer();
      return -1;
    default:
      throw new Error(`不明なコマンドです：${command}（wisdom help で使い方を確認できます）`);
  }
}

try {
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exitCode = code;
} catch (err) {
  process.stderr.write(`wisdom: エラー：${(err as Error).message}\n`);
  process.exitCode = 2;
}
