// smoke-plugin.sh の結果をまとめる：フックが動いたか、検査の記録、最終結果、費用
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const lines = fs.readFileSync(path.join(dir, "stream.jsonl"), "utf8").split("\n").filter(Boolean);
const events = lines.flatMap((l) => {
  try {
    return [JSON.parse(l)];
  } catch {
    return [];
  }
});

const hookEvents = events.filter((e) => JSON.stringify(e).includes("hook"));
const hookNames = new Set<string>();
for (const e of hookEvents) {
  const s = JSON.stringify(e);
  for (const m of s.matchAll(/"hook_?[Ee]vent(?:_?[Nn]ame)?":"([A-Za-z]+)"/g)) hookNames.add(m[1]);
}
const init = events.find((e) => e.type === "system" && e.subtype === "init");
const result = events.find((e) => e.type === "result");
const mentionsL0 = lines.some((l) => l.includes("AI Code Wisdom"));

console.log("plugins:", JSON.stringify(init?.plugins ?? null));
console.log("mcp servers:", JSON.stringify((init?.mcp_servers ?? []).map((s: any) => `${s.name}:${s.status}`)));
console.log("hook events seen:", [...hookNames].join(", ") || "(none)", `(${hookEvents.length} lines mention hooks)`);
console.log("transcript mentions 'AI Code Wisdom':", mentionsL0);

const ledgerFile = path.join(dir, ".wisdom", "ledger.jsonl");
const ledger = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8").trim().split("\n").filter(Boolean) : [];
console.log("ledger lines:", ledger.length);
for (const l of ledger.slice(0, 8)) console.log("  ", l.slice(0, 220));
const errLog = path.join(dir, ".wisdom", "cache", "hook-errors.log");
console.log("hook-errors.log:", fs.existsSync(errLog) ? fs.readFileSync(errLog, "utf8").slice(0, 800) : "(none)");

if (result) {
  const u = result.usage ?? {};
  console.log("result:", result.is_error ? "ERROR" : "ok", "turns", result.num_turns, "cost", result.total_cost_usd);
  console.log("tokens in/out/cache_create/cache_read:", u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens);
  console.log("final text:", String(result.result ?? "").slice(0, 600));
}
const users = path.join(dir, "src", "users.ts");
if (fs.existsSync(users)) console.log("---- src/users.ts\n" + fs.readFileSync(users, "utf8").slice(0, 1500));
const stderr = fs.readFileSync(path.join(dir, "stderr.txt"), "utf8").trim();
if (stderr) console.log("stderr:", stderr.slice(0, 600));
