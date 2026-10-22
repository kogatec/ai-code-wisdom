import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { astGrepBin } from "../src/core/checker.ts";
import { BUNDLED_PACKS_DIR } from "../src/core/paths.ts";

// 各パックの rule-tests を ast-grep で実行する（スナップショットは使わない）
let failed = 0;
const packs = fs
  .readdirSync(BUNDLED_PACKS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(BUNDLED_PACKS_DIR, e.name, "sgconfig.yml")))
  .map((e) => e.name)
  .sort();

for (const id of packs) {
  const run = spawnSync(astGrepBin(), ["test", "--skip-snapshot-tests"], {
    cwd: path.join(BUNDLED_PACKS_DIR, id),
    encoding: "utf8",
  });
  const ok = run.status === 0;
  console.log(`${ok ? "成功" : "失敗"}：${id}`);
  if (!ok) {
    failed++;
    console.log(run.stdout + run.stderr + (run.error ? String(run.error) : ""));
  }
}
console.log(failed === 0 ? `すべてのパックのルールテストが通りました（${packs.length} パック）` : `${failed} パックで失敗しました`);
process.exit(failed === 0 ? 0 : 1);
