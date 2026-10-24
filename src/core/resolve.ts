import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { hashPackDir, loadPack, type Pack, type Principle, type Severity } from "./packs.ts";
import { readProfile, type Profile } from "./profile.ts";
import { writeFileAtomic, type ProjectPaths } from "./paths.ts";

/** コンパイル結果の形やルールの書き出し方を変えたら上げる（古いキャッシュを捨てるため） */
const COMPILER_VERSION = "1";

export interface ActivePrinciple extends Principle {
  pack: string;
  packName: string;
  weight: number;
  /** 0 が最優先 */
  rank: number;
}

export interface ActiveRule {
  id: string;
  principle: string;
  language: string;
  severity: Severity;
  message: string;
  note?: string;
  /** mandatory の原則の error は、直すまで先に進ませない */
  blocking: boolean;
  excludePaths: string[];
}

/** 逆向きの原則が両方有効な軸と、どちらを優先するか */
export interface AxisResolution {
  axis: string;
  preferred: "more" | "less";
  winners: string[];
  yielding: string[];
}

export interface CompiledPack {
  id: string;
  name: string;
  version: string;
  hash: string;
  weight: number;
  role: "primary" | "secondary";
}

export interface Compiled {
  compilerVersion: string;
  inputsHash: string;
  profile: Profile;
  packs: CompiledPack[];
  principles: ActivePrinciple[];
  skipped: { id: string; reason: string }[];
  axes: AxisResolution[];
  rules: ActiveRule[];
  sgconfig: string;
  warnings: string[];
}

const LEVEL_RANK = { mandatory: 0, default: 1, advisory: 2 } as const;

function vendoredPackDirs(paths: ProjectPaths): string[] {
  if (!fs.existsSync(paths.packsDir)) return [];
  return fs
    .readdirSync(paths.packsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(paths.packsDir, e.name))
    .sort();
}

export function inputsHash(paths: ProjectPaths): string {
  const h = crypto.createHash("sha256").update(COMPILER_VERSION).update("\0");
  h.update(fs.existsSync(paths.profile) ? fs.readFileSync(paths.profile) : "").update("\0");
  for (const dir of vendoredPackDirs(paths)) h.update(path.basename(dir)).update(hashPackDir(dir));
  return h.digest("hex").slice(0, 16);
}

function loadSelectedPacks(paths: ProjectPaths, profile: Profile): { pack: Pack; weight: number }[] {
  const selected = [{ pack: profile.primary, weight: 1 }, ...profile.secondary];
  const seen = new Set<string>();
  return selected.map(({ pack: id, weight }) => {
    if (seen.has(id)) throw new Error(`パック ${id} が重複して選ばれています`);
    seen.add(id);
    const dir = path.join(paths.packsDir, id);
    if (!fs.existsSync(path.join(dir, "pack.yaml"))) {
      throw new Error(`パック ${id} がプロジェクトにありません。torus style set で選び直してください`);
    }
    return { pack: loadPack(dir), weight };
  });
}

function resolveAxes(principles: ActivePrinciple[]): AxisResolution[] {
  const byAxis = new Map<string, { id: string; direction: "more" | "less"; rank: number }[]>();
  for (const p of principles) {
    for (const t of p.tensions ?? []) {
      const list = byAxis.get(t.axis) ?? [];
      list.push({ id: p.id, direction: t.direction, rank: p.rank });
      byAxis.set(t.axis, list);
    }
  }
  const out: AxisResolution[] = [];
  for (const [axis, list] of byAxis) {
    if (new Set(list.map((x) => x.direction)).size < 2) continue;
    list.sort((a, b) => a.rank - b.rank);
    const preferred = list[0].direction;
    out.push({
      axis,
      preferred,
      winners: list.filter((x) => x.direction === preferred).map((x) => x.id),
      yielding: list.filter((x) => x.direction !== preferred).map((x) => x.id),
    });
  }
  return out.sort((a, b) => a.axis.localeCompare(b.axis));
}

/** ast-grep のルールを書き出す。TypeScript のルールは .tsx 用にも複製する */
function writeAstGrepConfig(paths: ProjectPaths, hash: string, packs: Pack[], rules: ActiveRule[]): string {
  const dir = path.join(paths.cacheDir, `sg-${hash}`);
  const sgconfig = path.join(dir, "sgconfig.yml");
  if (fs.existsSync(sgconfig)) return sgconfig;
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "rules"), { recursive: true });
  const configs = new Map(packs.flatMap((p) => p.rules.map((r) => [r.id, r.config] as const)));
  for (const rule of rules) {
    const config = { ...configs.get(rule.id), severity: rule.severity };
    fs.writeFileSync(path.join(tmp, "rules", `${rule.id}.yml`), YAML.stringify(config));
    if (rule.language === "TypeScript") {
      const tsx = { ...config, id: `${rule.id}__tsx`, language: "Tsx" };
      fs.writeFileSync(path.join(tmp, "rules", `${rule.id}__tsx.yml`), YAML.stringify(tsx));
    }
  }
  fs.writeFileSync(path.join(tmp, "sgconfig.yml"), YAML.stringify({ ruleDirs: ["rules"] }));
  try {
    fs.renameSync(tmp, dir);
  } catch {
    // 別のプロセスが同時に書き終えた場合は、そちらを使う
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 古い版の書き出しを片付ける
  for (const e of fs.readdirSync(paths.cacheDir)) {
    if (e.startsWith("sg-") && e !== `sg-${hash}` && !e.endsWith(".tmp")) {
      fs.rmSync(path.join(paths.cacheDir, e), { recursive: true, force: true });
    }
  }
  return sgconfig;
}

export function compile(paths: ProjectPaths): Compiled {
  const profile = readProfile(paths.profile);
  const selected = loadSelectedPacks(paths, profile);
  const warnings: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const disabled = new Set(profile.overrides.disable);
  const seen = new Map<string, string>();
  const candidates: { p: Principle; pack: Pack; weight: number; packIdx: number; idx: number }[] = [];

  selected.forEach(({ pack, weight }, packIdx) => {
    pack.principles.forEach((p, idx) => {
      if (seen.has(p.id)) throw new Error(`原則 ${p.id} が ${seen.get(p.id)} と ${pack.id} の両方にあります`);
      seen.set(p.id, pack.id);
      if (profile.phase === "prototype" && p.level === "advisory") {
        skipped.push({ id: p.id, reason: "prototype 段階のため（advisory）" });
        return;
      }
      if (disabled.has(p.id)) {
        if (p.level === "mandatory") {
          warnings.push(`${p.id} は必須（mandatory）のため無効にできません。overrides.disable から外してください`);
        } else {
          skipped.push({ id: p.id, reason: "overrides.disable で無効" });
          return;
        }
      }
      candidates.push({ p, pack, weight, packIdx, idx });
    });
  });
  for (const id of disabled) {
    if (!seen.has(id)) warnings.push(`overrides.disable の ${id} は、選んだパックにありません`);
  }

  candidates.sort(
    (a, b) =>
      LEVEL_RANK[a.p.level] - LEVEL_RANK[b.p.level] ||
      b.weight - a.weight ||
      a.packIdx - b.packIdx ||
      a.idx - b.idx,
  );
  const principles: ActivePrinciple[] = candidates.map((c, rank) => ({
    ...c.p,
    pack: c.pack.id,
    packName: c.pack.name,
    weight: c.weight,
    rank,
  }));

  const rules: ActiveRule[] = [];
  for (const c of candidates) {
    for (const ruleId of c.p.checks.static ?? []) {
      const r = c.pack.rules.find((x) => x.id === ruleId)!;
      if (profile.phase === "prototype" && r.severity === "info") continue;
      rules.push({
        id: r.id,
        principle: c.p.id,
        language: r.language,
        severity: r.severity,
        message: r.message,
        note: r.note,
        blocking: c.p.level === "mandatory" && r.severity === "error",
        excludePaths: c.pack.exclude_paths,
      });
    }
  }

  const hash = inputsHash(paths);
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  const compiled: Compiled = {
    compilerVersion: COMPILER_VERSION,
    inputsHash: hash,
    profile,
    packs: selected.map(({ pack, weight }, i) => ({
      id: pack.id,
      name: pack.name,
      version: pack.version,
      hash: hashPackDir(pack.dir),
      weight,
      role: i === 0 ? "primary" : "secondary",
    })),
    principles,
    skipped,
    axes: resolveAxes(principles),
    rules,
    sgconfig: writeAstGrepConfig(paths, hash, selected.map((s) => s.pack), rules),
    warnings,
  };
  writeFileAtomic(path.join(paths.cacheDir, "compiled.json"), JSON.stringify(compiled, null, 2));
  return compiled;
}

/** キャッシュが最新ならそれを使い、設定やパックが変わっていれば作り直す */
export function loadCompiled(paths: ProjectPaths): Compiled {
  const file = path.join(paths.cacheDir, "compiled.json");
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as Compiled;
    if (
      cached.compilerVersion === COMPILER_VERSION &&
      cached.inputsHash === inputsHash(paths) &&
      fs.existsSync(cached.sgconfig)
    ) {
      return cached;
    }
  } catch {
    // キャッシュがない・壊れている場合は作り直す
  }
  return compile(paths);
}
