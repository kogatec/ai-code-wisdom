import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.ts";
import { matchesAny, matchesGlob } from "./glob.ts";
import type { Severity } from "./packs.ts";
import { languageOf, PLUGIN_ROOT, relativeToRoot, type ProjectPaths } from "./paths.ts";
import type { Compiled } from "./resolve.ts";

export interface Finding {
  ruleId: string;
  principle: string;
  severity: Severity;
  blocking: boolean;
  file: string;
  line: number;
  endLine: number;
  column: number;
  message: string;
  note?: string;
  snippet: string;
  fingerprint: string;
}
export interface Waiver {
  finding: Finding;
  reason: string;
}
export interface CheckOptions {
  paths?: string[];
  diffBase?: string;
}
export interface CheckResult {
  findings: Finding[];
  waived: Waiver[];
  invalidAllows: Finding[];
  filesScanned: number;
  errors: string[];
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
const EXCLUDE_GLOBS = ["node_modules", ".git", "dist", "build", ".venv", "venv", "__pycache__", ".wisdom"].map(
  (d) => `!**/${d}/**`,
);
const EXCLUDED_DIR_RE = /(^|\/)(node_modules|\.git|dist|build|\.venv|venv|__pycache__|\.wisdom)\//;

const ID_RE = "[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*";
const ALLOW_RE = new RegExp(`wisdom-allow\\s+(${ID_RE}(?:\\s*,\\s*${ID_RE})*)(?:\\s*[:：]\\s*(.*))?`);

export function astGrepBin(): string {
  const local = path.join(PLUGIN_ROOT, "node_modules", ".bin", "ast-grep");
  return fs.existsSync(local) ? local : "ast-grep";
}

/** git diff の変更行の範囲。追跡されていないファイルは "all"、git リポジトリでなければ null */
export function changedLineRanges(root: string, base: string, relFile: string): [number, number][] | "all" | null {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return null;
  if (git(root, ["ls-files", "--error-unmatch", "--", relFile]).status !== 0) return "all";
  const diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", base, "--", relFile]);
  // 基準のコミットがない（最初のコミット前）など、差分を取れないときは絞り込まない
  if (diff.status !== 0) return "all";
  const ranges: [number, number][] = [];
  for (const m of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

/** before より多く現れた指紋の指摘だけを返す（多重集合の差） */
export function diffFingerprints(before: string[], after: Finding[]): Finding[] {
  const remaining = new Map<string, number>();
  for (const fp of before) remaining.set(fp, (remaining.get(fp) ?? 0) + 1);
  const added: Finding[] = [];
  for (const f of after) {
    const n = remaining.get(f.fingerprint) ?? 0;
    if (n > 0) remaining.set(f.fingerprint, n - 1);
    else added.push(f);
  }
  return added;
}

interface RawMatch {
  ruleId: string;
  severity?: string;
  message?: string;
  note?: string;
  file: string;
  text: string;
  range: { start: { line: number; column: number }; end: { line: number } };
  metadata?: { principle?: string };
}

function fingerprintOf(ruleId: string, text: string): string {
  return crypto
    .createHash("sha1")
    .update(ruleId + "\0" + text.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 12);
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    Number(b.blocking) - Number(a.blocking) ||
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.column - b.column
  );
}

type AllowVerdict = { kind: "none" } | { kind: "invalid" } | { kind: "waived"; reason: string };

/** その行か直前の行の wisdom-allow を調べる */
function allowFor(lines: string[], finding: Finding): AllowVerdict {
  let invalid = false;
  for (const idx of [finding.line - 1, finding.line - 2]) {
    const m = ALLOW_RE.exec(lines[idx] ?? "");
    if (!m) continue;
    const ids = m[1].split(/\s*,\s*/);
    if (!ids.includes(finding.principle)) continue;
    const reason = (m[2] ?? "").replace(/\s*(\*\/|-->)\s*$/, "").trim();
    if (reason) return { kind: "waived", reason };
    invalid = true;
  }
  return invalid ? { kind: "invalid" } : { kind: "none" };
}

export function check(paths: ProjectPaths, compiled: Compiled, opts: CheckOptions = {}): CheckResult {
  const result: CheckResult = { findings: [], waived: [], invalidAllows: [], filesScanned: 0, errors: [] };
  const root = paths.root;
  const targets: string[] = [];
  let wholeProject = true;
  if (opts.paths && opts.paths.length > 0) {
    wholeProject = false;
    for (const p of opts.paths) {
      const abs = path.resolve(root, p);
      const rel = relativeToRoot(root, abs);
      if (rel === null || !fs.existsSync(abs)) continue;
      if (fs.statSync(abs).isFile() && !languageOf(abs)) continue;
      const target = rel === "" ? "." : rel;
      if (!targets.includes(target)) targets.push(target);
    }
    if (targets.length === 0) return result;
  }

  const args = ["scan", "-c", compiled.sgconfig, "--json=stream", "--include-metadata", "--inspect", "summary"];
  for (const g of EXCLUDE_GLOBS) args.push("--globs", g);
  args.push(...targets);
  const run = spawnSync(astGrepBin(), args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error) {
    result.errors.push(`ast-grep を実行できませんでした：${run.error.message}`);
    return result;
  }
  if (run.status !== 0 && run.status !== 1) {
    result.errors.push(`ast-grep が失敗しました（終了コード ${run.status}）：${(run.stderr ?? "").trim()}`);
    return result;
  }
  const scanned = /scannedFileCount=(\d+)/.exec(run.stderr ?? "");
  result.filesScanned = scanned ? Number(scanned[1]) : wholeProject ? 0 : targets.length;

  const ruleById = new Map(compiled.rules.map((r) => [r.id, r]));
  const profile = compiled.profile;
  const found: Finding[] = [];
  for (const line of run.stdout.split("\n")) {
    if (!line.trim()) continue;
    let raw: RawMatch;
    try {
      raw = JSON.parse(line) as RawMatch;
    } catch {
      continue;
    }
    const ruleId = raw.ruleId.replace(/__tsx$/, "");
    const rule = ruleById.get(ruleId);
    if (!rule) continue;
    const file = relativeToRoot(root, path.resolve(root, raw.file));
    if (file === null || EXCLUDED_DIR_RE.test(file + "/")) continue;
    const principle = raw.metadata?.principle ?? rule.principle;
    if (matchesAny(file, profile.exclude_paths) || matchesAny(file, rule.excludePaths)) continue;
    const overridden = Object.entries(profile.overrides.paths).some(
      ([glob, v]) => matchesGlob(file, glob) && v.disable.includes(principle),
    );
    if (overridden) continue;
    found.push({
      ruleId,
      principle,
      severity: (raw.severity ?? rule.severity) as Severity,
      blocking: rule.blocking,
      file,
      line: raw.range.start.line + 1,
      endLine: raw.range.end.line + 1,
      column: raw.range.start.column + 1,
      message: raw.message ?? rule.message,
      note: raw.note ?? rule.note,
      snippet: raw.text.split("\n")[0].trim().slice(0, 120),
      fingerprint: fingerprintOf(ruleId, raw.text),
    });
  }

  let kept = found;
  if (opts.diffBase !== undefined && found.length > 0) {
    const insideGit = git(root, ["rev-parse", "--is-inside-work-tree"]).status === 0;
    if (!insideGit) {
      result.errors.push("git リポジトリではないため差分での絞り込みをしませんでした");
    } else {
      const rangesByFile = new Map<string, [number, number][] | "all" | null>();
      kept = found.filter((f) => {
        if (!rangesByFile.has(f.file)) rangesByFile.set(f.file, changedLineRanges(root, opts.diffBase!, f.file));
        const ranges = rangesByFile.get(f.file);
        if (ranges === "all" || ranges === null || ranges === undefined) return true;
        return ranges.some(([from, to]) => f.line <= to && f.endLine >= from);
      });
    }
  }

  const linesByFile = new Map<string, string[]>();
  const linesOf = (file: string): string[] => {
    let lines = linesByFile.get(file);
    if (!lines) {
      try {
        lines = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
      } catch {
        lines = [];
      }
      linesByFile.set(file, lines);
    }
    return lines;
  };
  for (const f of kept) {
    const verdict = allowFor(linesOf(f.file), f);
    if (verdict.kind === "waived") {
      result.waived.push({ finding: f, reason: verdict.reason });
      continue;
    }
    result.findings.push(f);
    if (verdict.kind === "invalid") result.invalidAllows.push(f);
  }
  result.findings.sort(compareFindings);
  result.invalidAllows.sort(compareFindings);
  result.waived.sort((a, b) => compareFindings(a.finding, b.finding));
  return result;
}
