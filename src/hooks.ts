import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, diffFingerprints, type CheckResult, type Finding } from "./core/checker.ts";
import { takeFirstRunOffer } from "./core/firstrun.ts";
import { matchesAny } from "./core/glob.ts";
import { appendLedger } from "./core/ledger.ts";
import { findProjectRoot, languageOf, projectPaths, relativeToRoot, type ProjectPaths } from "./core/paths.ts";
import { checkLock } from "./core/project.ts";
import { renderFileContext, renderFindingsFeedback, renderSessionContext } from "./core/render.ts";
import { loadCompiled, type Compiled } from "./core/resolve.ts";
import {
  cleanupOldSessions,
  listFileStates,
  readFileState,
  readMeta,
  writeFileState,
  writeMeta,
  type FileState,
} from "./core/session.ts";
import { classifyPrompt, renderTaskContext, riskyPrinciples } from "./core/tasks.ts";

export interface HookResult {
  stdout?: string;
  exitCode: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
/** 同じ違反でこの回数を超えて止めたら、以後は止めない */
const MAX_BLOCKS = 3;
const REVIEW_LINE_THRESHOLD = 120;

function additionalContext(hookEventName: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

interface Target {
  rel: string;
  abs: string;
}

/** 検査の対象になる Edit / Write / MultiEdit か */
function editTarget(input: any, paths: ProjectPaths, compiled: Compiled): Target | null {
  if (!EDIT_TOOLS.has(input?.tool_name)) return null;
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath) return null;
  const abs = path.resolve(typeof input.cwd === "string" ? input.cwd : paths.root, filePath);
  const rel = relativeToRoot(paths.root, abs);
  if (!rel || !languageOf(abs)) return null;
  if (matchesAny(rel, compiled.profile.exclude_paths)) return null;
  return { rel, abs };
}

function checkFile(paths: ProjectPaths, compiled: Compiled, rel: string): CheckResult {
  return check(paths, compiled, { paths: [rel] });
}

/** 書き込んだ文字列（Write の content、Edit の new_string、MultiEdit の各 new_string） */
function writtenStrings(input: any): string[] {
  const ti = input?.tool_input ?? {};
  const out: string[] = [];
  if (typeof ti.content === "string") out.push(ti.content);
  if (typeof ti.new_string === "string") out.push(ti.new_string);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) if (typeof e?.new_string === "string") out.push(e.new_string);
  }
  return out;
}

function countLines(s: string): number {
  if (s === "") return 0;
  return s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
}

function newState(rel: string, existedAtStart: boolean, baseline: string[]): FileState {
  return {
    file: rel,
    existedAtStart,
    firstBaseline: baseline,
    lastBaseline: baseline,
    blockedCounts: {},
    changedLines: 0,
    contextShown: false,
  };
}

function preToolUse(input: any, paths: ProjectPaths, compiled: Compiled): HookResult {
  const target = editTarget(input, paths, compiled);
  if (!target) return { exitCode: 0 };
  const session = input.session_id ?? "unknown";
  const exists = fs.existsSync(target.abs);
  const before = exists ? checkFile(paths, compiled, target.rel) : null;
  // 検査そのものが失敗したときは基準を作らない（後で既存の違反を新しいものと取り違えるため）
  if (before && before.errors.length > 0) return { exitCode: 0 };
  const fingerprints = before ? before.findings.map((f) => f.fingerprint) : [];
  const state = readFileState(paths, session, target.rel) ?? newState(target.rel, exists, fingerprints);
  state.lastBaseline = fingerprints;
  let context: string | null = null;
  if (!state.contextShown) {
    context = renderFileContext(compiled, target.rel);
    state.contextShown = true;
  }
  writeFileState(paths, session, state);
  return context ? { stdout: additionalContext("PreToolUse", context), exitCode: 0 } : { exitCode: 0 };
}

function postToolUse(input: any, paths: ProjectPaths, compiled: Compiled): HookResult {
  const target = editTarget(input, paths, compiled);
  if (!target) return { exitCode: 0 };
  const session = input.session_id ?? "unknown";
  const written = writtenStrings(input);
  const checked = fs.existsSync(target.abs) ? checkFile(paths, compiled, target.rel) : null;
  if (checked && checked.errors.length > 0) return { exitCode: 0 };
  const after = checked?.findings ?? [];
  let state = readFileState(paths, session, target.rel);
  let added: Finding[];
  if (state) {
    added = diffFingerprints(state.lastBaseline, after);
  } else {
    // 直前のフックが動かなかった場合：書き込んだ文字列に含まれる指摘だけを新しいものとみなす
    added = after.filter((f) => f.snippet !== "" && written.some((s) => s.includes(f.snippet)));
    const addedSet = new Set(added);
    state = newState(
      target.rel,
      input.tool_name !== "Write",
      after.filter((f) => !addedSet.has(f)).map((f) => f.fingerprint),
    );
  }
  state.changedLines += written.reduce((sum, s) => sum + countLines(s), 0);

  const blocking: Finding[] = [];
  const advisory: Finding[] = [];
  const demoted: Finding[] = [];
  const counted = new Set<string>();
  for (const f of added) {
    if (!f.blocking) {
      advisory.push(f);
      continue;
    }
    if (!counted.has(f.fingerprint)) {
      counted.add(f.fingerprint);
      state.blockedCounts[f.fingerprint] = (state.blockedCounts[f.fingerprint] ?? 0) + 1;
    }
    if (state.blockedCounts[f.fingerprint] > MAX_BLOCKS) {
      demoted.push(f);
      advisory.push({ ...f, blocking: false });
    } else {
      blocking.push(f);
    }
  }
  state.lastBaseline = after.map((f) => f.fingerprint);
  writeFileState(paths, session, state);
  appendLedger(paths, {
    event: "edit",
    session,
    file: target.rel,
    new: added.map((f) => ({ principle: f.principle, ruleId: f.ruleId, line: f.line, blocking: f.blocking })),
    after: after.length,
  });

  const feedback = renderFindingsFeedback(target.rel, [...blocking, ...advisory]);
  let advisoryText = feedback.advisory;
  if (advisoryText && demoted.length) {
    advisoryText +=
      "\n同じ違反を3回止めたため、以後は止めません。直せない理由をユーザーに説明するか、torus-allow を書いてください";
  }
  if (feedback.blocking) {
    const invalid = new Set((checked?.invalidAllows ?? []).map((f) => f.fingerprint));
    let reason = feedback.blocking;
    if (blocking.some((b) => invalid.has(b.fingerprint))) reason += "\ntorus-allow には理由が必要です。`torus-allow ID: 理由` の形で書いてください。";
    if (advisoryText) reason += "\n\n" + advisoryText;
    return { stdout: JSON.stringify({ decision: "block", reason }), exitCode: 0 };
  }
  if (advisoryText) return { stdout: additionalContext("PostToolUse", advisoryText), exitCode: 0 };
  return { exitCode: 0 };
}

function stop(input: any, paths: ProjectPaths, compiled: Compiled): HookResult {
  if (input.stop_hook_active === true) return { exitCode: 0 };
  const session = input.session_id ?? "unknown";
  const states = listFileStates(paths, session).filter((s) => fs.existsSync(path.join(paths.root, s.file)));
  if (states.length === 0) return { exitCode: 0 };

  const result = check(paths, compiled, { paths: states.map((s) => s.file) });
  const remaining: Finding[] = [];
  for (const s of states) {
    const mine = result.findings.filter((f) => f.file === s.file);
    for (const f of diffFingerprints(s.firstBaseline, mine)) {
      if (f.blocking && (s.blockedCounts[f.fingerprint] ?? 0) <= MAX_BLOCKS) remaining.push(f);
    }
  }
  if (remaining.length > 0) {
    const lines = remaining.map((f) => `- ${f.file}:L${f.line} [${f.principle}] ${f.message}`);
    const reason = `[Torus Code] 終了する前に、この作業で入った必須原則の違反を直してください：\n${lines.join("\n")}`;
    return { stdout: JSON.stringify({ decision: "block", reason }), exitCode: 0 };
  }

  const changedLines = states.reduce((sum, s) => sum + s.changedLines, 0);
  const meta = readMeta(paths, session);
  const mode = compiled.profile.review;
  if ((mode === "always" || (mode === "auto" && changedLines >= REVIEW_LINE_THRESHOLD)) && !meta.reviewRequested) {
    meta.reviewRequested = true;
    writeMeta(paths, session, meta);
    const reason = `[Torus Code] この作業では ${changedLines} 行を変更しました。終了する前に Agent ツールで subagent_type "torus-code:torus-reviewer" を呼んでレビューを受け、必要な修正をしてから、最後に「適用した原則／検査の結果／未解決」を報告してください。`;
    return { stdout: JSON.stringify({ decision: "block", reason }), exitCode: 0 };
  }
  appendLedger(paths, { event: "stop", session, files: states.map((s) => s.file), changedLines });
  return { exitCode: 0 };
}

function sessionStart(paths: ProjectPaths, compiled: Compiled): HookResult {
  cleanupOldSessions(paths);
  let text = renderSessionContext(compiled);
  const notes = [...compiled.warnings, ...checkLock(paths).problems];
  if (notes.length) text += "\n\n" + notes.map((n) => `注意：${n}`).join("\n");
  return { stdout: additionalContext("SessionStart", text), exitCode: 0 };
}

function userPromptSubmit(input: any, compiled: Compiled): HookResult {
  if (typeof input.prompt !== "string" || !input.prompt) return { exitCode: 0 };
  const text = renderTaskContext(classifyPrompt(input.prompt), riskyPrinciples(input.prompt), compiled);
  return text ? { stdout: additionalContext("UserPromptSubmit", text), exitCode: 0 } : { exitCode: 0 };
}

/** 未設定のプロジェクトでは、最初の依頼でだけ初回設定を案内する（以後は /torus-code:style などで変える） */
function firstRunOffer(dir: string): HookResult {
  const text = takeFirstRunOffer(dir, os.homedir());
  return text ? { stdout: additionalContext("UserPromptSubmit", text), exitCode: 0 } : { exitCode: 0 };
}

/** 設定を読めないと検査が黙って止まるので、セッションの開始時にだけ理由を知らせる（依頼や編集のたびには繰り返さない） */
function configErrorNotice(err: unknown): HookResult {
  const reason = err instanceof Error ? err.message : String(err);
  const text = [
    "[Torus Code] 設定を読めないため、このセッションでは自動検査が止まっています。",
    `理由：${reason}`,
    "`torus status` で確認し、.torus/profile.yaml などを直してください。直すまで、ファイルを書いても検査されません。",
  ].join("\n");
  return { stdout: additionalContext("SessionStart", text), exitCode: 0 };
}

function logHookError(root: string | null, event: string, err: unknown): void {
  if (!root) return;
  try {
    const paths = projectPaths(root);
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    fs.appendFileSync(path.join(paths.cacheDir, "hook-errors.log"), `${new Date().toISOString()}\t${event}\t${detail}\n`);
  } catch {
    // ログを書けなくても、セッションは壊さない
  }
}

/** どんな例外もここで受け止め、何も出さずに 0 で終わる */
export function runHook(event: string, input: any, env: NodeJS.ProcessEnv): HookResult {
  let root: string | null = null;
  try {
    input = input ?? {};
    const start = env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
    root = findProjectRoot(start);
    if (!root) return event === "user-prompt-submit" ? firstRunOffer(start) : { exitCode: 0 };
    const paths = projectPaths(root);
    let compiled: Compiled;
    try {
      compiled = loadCompiled(paths);
    } catch (err) {
      logHookError(root, event, err);
      return event === "session-start" ? configErrorNotice(err) : { exitCode: 0 };
    }
    switch (event) {
      case "session-start":
        return sessionStart(paths, compiled);
      case "user-prompt-submit":
        return userPromptSubmit(input, compiled);
      case "pre-tool-use":
        return preToolUse(input, paths, compiled);
      case "post-tool-use":
        return postToolUse(input, paths, compiled);
      case "stop":
        return stop(input, paths, compiled);
      default:
        return { exitCode: 0 };
    }
  } catch (err) {
    logHookError(root, event, err);
    return { exitCode: 0 };
  }
}
