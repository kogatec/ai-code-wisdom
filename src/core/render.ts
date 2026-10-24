import fs from "node:fs";
import path from "node:path";
import type { CheckResult, Finding } from "./checker.ts";
import { listPacks, type Level, type Pack, type Principle } from "./packs.ts";
import { BUNDLED_PACKS_DIR, languageOf, type ProjectPaths } from "./paths.ts";
import type { ActivePrinciple, Compiled } from "./resolve.ts";

export function levelLabel(level: Level): string {
  return { mandatory: "必須", default: "既定", advisory: "推奨" }[level];
}

const LAYER_PATTERNS: [string, RegExp][] = [
  ["test", /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/],
  ["api_handler", /(^|\/)(routes?|handlers?|controllers?|api|endpoints?|views?)(\/|$)/],
  ["data_access", /(^|\/)(repositor(y|ies)|db|dao|models?|persistence|migrations?)(\/|$)|(repository|repo|dao|db)\.[a-z]+$/],
  ["external_call", /(^|\/)(clients?|gateways?|integrations?|adapters?|external)(\/|$)|client\.[a-z]+$/],
  ["service", /(^|\/)(services?|usecases?|application)(\/|$)/],
  ["domain", /(^|\/)(domain|entities|core)(\/|$)/],
  ["cli_entry", /(^|\/)(cli|bin|scripts?|commands?)(\/|$)|(^|\/)(main|cli|__main__)\.[a-z]+$/],
];

/** パスから、そのファイルが属しそうな層をすべて推測する */
export function guessLayers(relFile: string): string[] {
  const p = relFile.toLowerCase();
  return LAYER_PATTERNS.filter(([, re]) => re.test(p)).map(([layer]) => layer);
}

const AXES: Record<string, { name: string; more: string; less: string }> = {
  abstraction: { name: "抽象化の量", more: "増やす", less: "減らす" },
  verbosity: { name: "記述量", more: "多く", less: "少なく" },
  simplicity: { name: "単純さ", more: "多く", less: "少なく" },
};

function axisName(axis: string): string {
  return AXES[axis]?.name ?? axis;
}

function directionLabel(axis: string, dir: "more" | "less"): string {
  return AXES[axis]?.[dir] ?? (dir === "more" ? "多く" : "少なく");
}

const PHASE_LABEL = { production: "本番（production）", prototype: "試作（prototype）" };

export function renderSessionContext(compiled: Compiled): string {
  const primary = compiled.packs.find((p) => p.role === "primary");
  const secondary = compiled.packs.filter((p) => p.role === "secondary");
  const secondaryText = secondary.length ? secondary.map((p) => `${p.name}（重み ${p.weight}）`).join("、") : "なし";
  const lines: string[] = [
    "# Torus Code：このプロジェクトの設計方針",
    `主スタイル：${primary?.name ?? compiled.profile.primary} ／ 副スタイル：${secondaryText} ／ 段階：${PHASE_LABEL[compiled.profile.phase]}`,
    "",
  ];
  const mandatory = compiled.principles.filter((p) => p.level === "mandatory");
  const others = compiled.principles.filter((p) => p.level !== "mandatory");
  if (mandatory.length) {
    lines.push("## 必須（どのスタイルでも外せない）");
    for (const p of mandatory) lines.push(`- [${p.id}] ${p.summary}`);
    lines.push("依頼がこれらに反する場合は、実装せずに理由と安全な代替案を示し、ユーザーの判断を仰ぐ。", "");
  }
  if (others.length) {
    lines.push("## 優先して守る原則（上ほど優先）");
    for (const p of others.slice(0, 12)) lines.push(`- [${p.id}] ${p.summary}`);
    if (others.length > 12) {
      lines.push(`- ほか ${others.length - 12} 件（torus_principles ツールか \`torus principles\` で確認）`);
    }
    lines.push("");
  }
  if (compiled.axes.length) {
    lines.push("## 原則がぶつかったとき");
    for (const a of compiled.axes) {
      lines.push(
        `- ${axisName(a.axis)}：「${directionLabel(a.axis, a.preferred)}」を優先（${a.winners.join(", ")}）。${a.yielding.join(", ")} は、それと矛盾しない範囲で適用`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## 進め方",
    "- ファイルを書くたびに自動で検査される。[必須] の違反は直すまで先に進めない",
    "- 例外が本当に必要な箇所だけ、その行か直前の行に `torus-allow <ID>: 理由` を書き、ユーザーに伝える",
    "- 設計上の判断（原則の衝突・構造の変更）は .torus/decisions.md に1行で記録する",
    "- 作業の最後に「適用した原則／検査の結果／未解決」を短く報告する",
  );
  return lines.join("\n");
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s*\n\s*/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** そのファイルの言語・層に当てはまる有効な原則（rank 順）。layers は無視するか選べる */
function applicablePrinciples(compiled: Compiled, relFile: string, useLayers: boolean): ActivePrinciple[] {
  const lang = languageOf(relFile);
  if (!lang) return [];
  const layers = guessLayers(relFile);
  return compiled.principles.filter((p) => {
    const langs = p.applies_when?.languages;
    if (langs && langs.length && !langs.includes(lang)) return false;
    if (!useLayers) return true;
    const want = p.applies_when?.layers;
    if (!want || want.length === 0 || want.includes("any")) return true;
    return want.some((l) => layers.includes(l));
  });
}

export function renderFileContext(compiled: Compiled, relFile: string): string | null {
  const picked = applicablePrinciples(compiled, relFile, true)
    .filter((p) => p.checks.review)
    .slice(0, 5);
  if (picked.length === 0) return null;
  return [
    `[Torus Code] ${relFile} を書くときに確かめること（機械では検査できない部分）：`,
    ...picked.map((p) => `- [${p.id}] ${oneLine(p.checks.review!, 160)}`),
  ].join("\n");
}

/** レビュー役に渡す観点。renderFileContext が空なら、必須原則の review を使う */
export function reviewPointsFor(compiled: Compiled, relFile: string): string {
  const ctx = renderFileContext(compiled, relFile);
  if (ctx) return ctx;
  const mandatory = applicablePrinciples(compiled, relFile, false).filter(
    (p) => p.level === "mandatory" && p.checks.review,
  );
  if (mandatory.length === 0) return "確かめる観点はありません";
  return ["必須原則の確認観点：", ...mandatory.map((p) => `- [${p.id}] ${oneLine(p.checks.review!, 160)}`)].join("\n");
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };

function findingLine(f: Finding, withSnippet: boolean): string {
  return `- L${f.line} [${f.principle}] ${f.message}${withSnippet ? `（${f.snippet}）` : ""}`;
}

export function renderFindingsFeedback(
  file: string,
  findings: Finding[],
): { blocking: string | null; advisory: string | null } {
  const blocking = findings.filter((f) => f.blocking);
  const rest = findings
    .filter((f) => !f.blocking)
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.line - b.line);

  let blockingText: string | null = null;
  if (blocking.length) {
    const ids = [...new Set(blocking.map((f) => f.principle))];
    const lines = [`[Torus Code] ${file} に必須原則の違反が入りました。直してから先に進んでください。`];
    for (const f of blocking) {
      lines.push(findingLine(f, true));
      if (f.note) lines.push(`  → ${f.note}`);
    }
    lines.push(
      `本当に例外が必要なら、その行に \`torus-allow ${ids.length === 1 ? ids[0] : "<原則ID>"}: 理由\` を書き、ユーザーに説明してください。`,
    );
    blockingText = lines.join("\n");
  }

  let advisoryText: string | null = null;
  if (rest.length) {
    const high = rest.filter((f) => f.severity === "error" || f.severity === "warning");
    const low = rest.filter((f) => f.severity !== "error" && f.severity !== "warning");
    const lines = [`[Torus Code] ${file} の検査結果（止めはしませんが、直せるなら直してください）：`];
    for (const f of high) {
      lines.push(findingLine(f, false));
      if (f.note) lines.push(`  → ${f.note}`);
    }
    for (const f of low.slice(0, 5)) lines.push(findingLine(f, false));
    if (low.length > 5) lines.push(`- ほか ${low.length - 5} 件`);
    advisoryText = lines.join("\n");
  }
  return { blocking: blockingText, advisory: advisoryText };
}

export function renderCheckReport(result: CheckResult): string {
  const lines: string[] = [];
  if (result.findings.length === 0) {
    lines.push(`指摘はありません（${result.filesScanned} ファイル）`);
    if (result.waived.length) lines.push(`例外 ${result.waived.length}`);
  } else {
    const byFile = new Map<string, Finding[]>();
    for (const f of result.findings) {
      const list = byFile.get(f.file) ?? [];
      list.push(f);
      byFile.set(f.file, list);
    }
    for (const file of [...byFile.keys()].sort()) {
      for (const f of byFile.get(file)!.sort((a, b) => a.line - b.line || a.column - b.column)) {
        lines.push(`${f.file}:${f.line}:${f.column} ${f.severity}${f.blocking ? " 必須" : ""} [${f.principle}] ${f.message}`);
      }
    }
    const count = (pred: (f: Finding) => boolean) => result.findings.filter(pred).length;
    lines.push(
      "",
      `必須の違反 ${count((f) => f.blocking)} ／ error ${count((f) => f.severity === "error")} ／ warning ${count((f) => f.severity === "warning")} ／ info ${count((f) => f.severity === "info" || f.severity === "hint")} ／ 例外 ${result.waived.length} ／ 理由のない例外 ${result.invalidAllows.length}`,
    );
  }
  for (const e of result.errors) lines.push(`注意：${e}`);
  return lines.join("\n");
}

export function renderExplain(p: Principle & { pack?: string; packName?: string }): string {
  const lines: string[] = [`## [${p.id}] ${p.title}`, ""];
  const meta = [`レベル：${levelLabel(p.level)}`];
  if (p.pack) meta.push(`パック：${p.packName ?? p.pack}（${p.pack}）`);
  lines.push(meta.join(" ／ "), "", p.summary, "");
  if (p.rationale) lines.push("### 理由", p.rationale, "");
  if (p.not_when && p.not_when.length) {
    lines.push("### 当てはまらない場合", ...p.not_when.map((s) => `- ${s}`), "");
  }
  const checks: string[] = [];
  if (p.checks.static && p.checks.static.length) checks.push(`- 静的検査：${p.checks.static.join(", ")}`);
  if (p.checks.review) checks.push(`- レビューの観点：${p.checks.review}`);
  if (p.checks.tests) checks.push(`- テスト：${p.checks.tests}`);
  for (const e of p.checks.external ?? []) checks.push(`- 外部ツール：${e.engine}（${e.rule}）`);
  if (checks.length) lines.push("### 検査", ...checks, "");
  if (p.example) {
    lines.push("### 例", "悪い例：", "```", String(p.example.bad).trim(), "```", "良い例：", "```", String(p.example.good).trim(), "```", "");
  }
  if (p.tensions && p.tensions.length) {
    lines.push(
      "### 衝突しやすい軸",
      ...p.tensions.map((t) => `- ${axisName(t.axis)}：${directionLabel(t.axis, t.direction)}`),
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

export function renderStyles(packs: Pack[]): string {
  return packs
    .map((pack) => {
      const mandatory = pack.principles.filter((p) => p.level === "mandatory").length;
      const lines = [`### ${pack.name}（${pack.id}）`, pack.description, ""];
      lines.push(`重視する価値：${pack.values.join("、")}`);
      if (pack.suited_for.length) lines.push("向いているプロジェクト：", ...pack.suited_for.map((s) => `- ${s}`));
      if (pack.tradeoffs.length) lines.push("トレードオフ：", ...pack.tradeoffs.map((s) => `- ${s}`));
      lines.push(`原則の数：${pack.principles.length}（うち必須 ${mandatory}）`);
      const verification = Object.entries(pack.verification ?? {});
      if (verification.length) {
        lines.push("検証の状況：", ...verification.map(([k, v]) => `- ${k}：${String(v)}`));
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** 有効な原則 → プロジェクトのパック → 同梱パックの順で、原則を探す */
export function findPrincipleForExplain(
  paths: ProjectPaths | null,
  compiled: Compiled | null,
  id: string,
): (Principle & { pack?: string; packName?: string }) | null {
  const want = id.trim().toUpperCase();
  const active = compiled?.principles.find((p) => p.id === want);
  if (active) return active;
  const dirs = [paths?.packsDir, BUNDLED_PACKS_DIR].filter((d): d is string => !!d && fs.existsSync(path.resolve(d)));
  for (const dir of dirs) {
    for (const pack of listPacks(dir)) {
      const found = pack.principles.find((p) => p.id === want);
      if (found) return { ...found, pack: pack.id, packName: pack.name };
    }
  }
  return null;
}
