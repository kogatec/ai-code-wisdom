import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type Level = "mandatory" | "default" | "advisory";
export type Severity = "error" | "warning" | "info" | "hint";

export interface Principle {
  id: string;
  version: string;
  title: string;
  summary: string;
  level: Level;
  styles: Record<string, number>;
  applies_when?: { languages?: string[]; layers?: string[] };
  not_when?: string[];
  rationale: string;
  checks: {
    static?: string[];
    review?: string;
    tests?: string;
    external?: { engine: string; rule: string }[];
  };
  example?: { bad: string; good: string };
  tensions?: { axis: string; direction: "more" | "less" }[];
  evidence?: Record<string, unknown>;
}

export interface RuleDoc {
  id: string;
  language: string;
  severity: Severity;
  message: string;
  note?: string;
  principle: string;
  /** ast-grep のルール設定そのもの（コンパイル時に書き出す） */
  config: Record<string, unknown>;
}

export interface Pack {
  id: string;
  version: string;
  name: string;
  description: string;
  values: string[];
  suited_for: string[];
  tradeoffs: string[];
  exclude_paths: string[];
  principles: Principle[];
  rules: RuleDoc[];
  verification?: Record<string, string>;
  dir: string;
}

const LEVELS: readonly Level[] = ["mandatory", "default", "advisory"];

function readYaml(file: string): unknown {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} を読めません: ${(err as Error).message}`);
  }
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** 「なし」は空として扱う（原則ファイルで項目がないことを明示するため） */
function optionalText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" || t === "なし" ? undefined : t;
}

function loadPrinciple(file: string): Principle {
  const raw = readYaml(file) as Record<string, any>;
  if (!raw || typeof raw.id !== "string") throw new Error(`${file}: id がありません`);
  if (!LEVELS.includes(raw.level)) throw new Error(`${file}: level が不正です（${raw.level}）`);
  const checks = raw.checks ?? {};
  return {
    id: raw.id,
    version: String(raw.version ?? "0.0.0"),
    title: String(raw.title ?? raw.id),
    summary: String(raw.summary ?? raw.title ?? raw.id),
    level: raw.level,
    styles: raw.styles ?? {},
    applies_when: raw.applies_when,
    not_when: asStringList(raw.not_when),
    rationale: String(raw.rationale ?? "").trim(),
    checks: {
      static: asStringList(checks.static),
      review: optionalText(checks.review),
      tests: optionalText(checks.tests),
      external: Array.isArray(checks.external) ? checks.external : [],
    },
    example: raw.example,
    tensions: Array.isArray(raw.tensions) ? raw.tensions : [],
    evidence: raw.evidence,
  };
}

function loadRules(rulesDir: string): RuleDoc[] {
  if (!fs.existsSync(rulesDir)) return [];
  const rules: RuleDoc[] = [];
  for (const f of fs.readdirSync(rulesDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const file = path.join(rulesDir, f);
    for (const doc of YAML.parseAllDocuments(fs.readFileSync(file, "utf8"))) {
      if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0].message}`);
      const config = doc.toJS() as Record<string, any>;
      if (!config?.id) continue;
      const principle = config.metadata?.principle;
      if (typeof principle !== "string") throw new Error(`${file}: ${config.id} に metadata.principle がありません`);
      rules.push({
        id: config.id,
        language: config.language,
        severity: config.severity ?? "warning",
        message: config.message ?? "",
        note: config.note,
        principle,
        config,
      });
    }
  }
  return rules;
}

/** dir のパックを読む。原則ファイルの欠け・ID の食い違い・存在しないルールへの参照はエラーにする */
export function loadPack(dir: string): Pack {
  const meta = readYaml(path.join(dir, "pack.yaml")) as Record<string, any>;
  if (!meta?.id) throw new Error(`${dir}/pack.yaml: id がありません`);
  const order = asStringList(meta.principles);
  const principles = order.map((id) => {
    const file = path.join(dir, "principles", `${id}.yaml`);
    if (!fs.existsSync(file)) throw new Error(`${meta.id}: 原則ファイル ${id}.yaml がありません`);
    const p = loadPrinciple(file);
    if (p.id !== id) throw new Error(`${file}: id が一致しません（${p.id}）`);
    return p;
  });
  const rules = loadRules(path.join(dir, "rules"));
  const ruleIds = new Set(rules.map((r) => r.id));
  for (const p of principles) {
    for (const r of p.checks.static ?? []) {
      if (!ruleIds.has(r)) throw new Error(`${meta.id}: ${p.id} が存在しないルール ${r} を参照しています`);
    }
  }
  return {
    id: meta.id,
    version: String(meta.version ?? "0.0.0"),
    name: String(meta.name ?? meta.id),
    description: String(meta.description ?? ""),
    values: asStringList(meta.values),
    suited_for: asStringList(meta.suited_for),
    tradeoffs: asStringList(meta.tradeoffs),
    exclude_paths: asStringList(meta.exclude_paths),
    principles,
    rules,
    verification: meta.verification,
    dir,
  };
}

/** dir 直下で pack.yaml を持つディレクトリをすべて読む */
export function listPacks(dir: string): Pack[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "pack.yaml")))
    .map((e) => loadPack(path.join(dir, e.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** パックとして配る（プロジェクトに複製する）ファイル。ルールのテストは含めない */
export function isPackContent(rel: string): boolean {
  return rel === "pack.yaml" || /^(principles|rules)\/[^/]+\.ya?ml$/.test(rel);
}

export function listFiles(dir: string, filter: (rel: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const walk = (sub: string) => {
    for (const e of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (filter(rel)) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

/** パックの中身から作るハッシュ。lock.json で「勝手に変わっていないか」を確かめるのに使う */
export function hashPackDir(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(dir, isPackContent)) {
    h.update(rel).update("\0").update(fs.readFileSync(path.join(dir, rel))).update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export function copyPack(srcDir: string, destDir: string): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  for (const rel of listFiles(srcDir, isPackContent)) {
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcDir, rel), dest);
  }
}

export interface PackDiff {
  added: string[];
  removed: string[];
  changed: string[];
  rulesChanged: boolean;
}

/** 2つの版のパックを原則単位で比べる（wisdom update で差分を見せるため） */
export function diffPacks(oldPack: Pack, newPack: Pack): PackDiff {
  const key = (p: Principle) => JSON.stringify(p);
  const oldMap = new Map(oldPack.principles.map((p) => [p.id, key(p)]));
  const newMap = new Map(newPack.principles.map((p) => [p.id, key(p)]));
  const ruleKey = (pack: Pack) => JSON.stringify(pack.rules.map((r) => r.config));
  return {
    added: [...newMap.keys()].filter((id) => !oldMap.has(id)),
    removed: [...oldMap.keys()].filter((id) => !newMap.has(id)),
    changed: [...newMap.keys()].filter((id) => oldMap.has(id) && oldMap.get(id) !== newMap.get(id)),
    rulesChanged: ruleKey(oldPack) !== ruleKey(newPack),
  };
}
