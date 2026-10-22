import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { check } from "./core/checker.ts";
import { listPacks } from "./core/packs.ts";
import { BUNDLED_PACKS_DIR, findProjectRoot, projectPaths, relativeToRoot, writeFileAtomic, type ProjectPaths } from "./core/paths.ts";
import { TOOL_VERSION } from "./core/project.ts";
import {
  findPrincipleForExplain,
  renderCheckReport,
  renderExplain,
  renderFileContext,
  renderSessionContext,
  renderStyles,
} from "./core/render.ts";
import { loadCompiled } from "./core/resolve.ts";

const NOT_CONFIGURED = "このプロジェクトは未設定です。/ai-code-wisdom:init で設計スタイルを選べます";

const projectDirProp = { type: "string", description: "プロジェクトのディレクトリ（省略時は現在のプロジェクト）" };

const TOOLS = [
  {
    name: "wisdom_principles",
    description: "このプロジェクトの設計方針（有効な原則と優先順位）を返す。path を渡すと、そのファイルを書くときの確認事項も返す",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: projectDirProp,
        path: { type: "string", description: "これから書く・直すファイルのパス" },
      },
    },
  },
  {
    name: "wisdom_check",
    description: "静的検査を実行して、原則の違反を返す",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: projectDirProp,
        paths: { type: "array", items: { type: "string" }, description: "検査するファイルかディレクトリ（省略時はプロジェクト全体）" },
        diff_base: { type: "string", description: "git の基準（例：HEAD）。指定すると、その後に変えた行の指摘だけを返す" },
      },
    },
  },
  {
    name: "wisdom_explain",
    description: "原則の理由・検査方法・例を返す",
    inputSchema: {
      type: "object",
      properties: { project_dir: projectDirProp, id: { type: "string", description: "原則 ID（例：SEC-INJ-002）" } },
      required: ["id"],
    },
  },
  {
    name: "wisdom_record_decision",
    description: "設計上の判断（原則の衝突の解決・構造の変更など）を .wisdom/decisions.md に1行で記録する",
    inputSchema: {
      type: "object",
      properties: {
        project_dir: projectDirProp,
        decision: { type: "string", description: "判断の内容と理由" },
        principle_ids: { type: "array", items: { type: "string" }, description: "関係する原則 ID" },
      },
      required: ["decision"],
    },
  },
  {
    name: "wisdom_styles",
    description: "選べる設計スタイル（パック）の一覧と特徴を返す",
    inputSchema: { type: "object", properties: {} },
  },
];

type Args = Record<string, any>;

function projectFor(args: Args, env: NodeJS.ProcessEnv): ProjectPaths | null {
  const start = args.project_dir ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const root = findProjectRoot(path.resolve(String(start)));
  return root ? projectPaths(root) : null;
}

function text(t: string, isError = false) {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function callTool(name: string, args: Args, env: NodeJS.ProcessEnv) {
  if (!TOOLS.some((t) => t.name === name)) return text(`不明なツールです：${name}`, true);
  if (name === "wisdom_styles") return text(renderStyles(listPacks(BUNDLED_PACKS_DIR)));

  const paths = projectFor(args, env);
  if (name === "wisdom_explain") {
    if (typeof args.id !== "string" || !args.id.trim()) return text("id を指定してください", true);
    const found = findPrincipleForExplain(paths, paths ? loadCompiled(paths) : null, args.id);
    return found ? text(renderExplain(found)) : text(`原則 ${args.id} は見つかりません`, true);
  }
  if (!paths) return text(NOT_CONFIGURED);
  const compiled = loadCompiled(paths);

  switch (name) {
    case "wisdom_principles": {
      const l0 = renderSessionContext(compiled);
      if (typeof args.path !== "string" || !args.path) return text(l0);
      const rel = relativeToRoot(paths.root, path.resolve(paths.root, args.path));
      if (rel === null) return text(`${args.path} はプロジェクトの外です`, true);
      return text((renderFileContext(compiled, rel) ?? `${rel} に追加で確かめる観点はありません`) + "\n\n" + l0);
    }
    case "wisdom_check": {
      const given = Array.isArray(args.paths) ? args.paths.map(String) : [];
      const result = check(paths, compiled, {
        paths: given,
        diffBase: typeof args.diff_base === "string" && args.diff_base ? args.diff_base : undefined,
      });
      return text(renderCheckReport(result));
    }
    case "wisdom_record_decision": {
      if (typeof args.decision !== "string" || !args.decision.trim()) return text("decision を指定してください", true);
      const ids = Array.isArray(args.principle_ids) ? args.principle_ids.map(String).filter(Boolean) : [];
      const decision = args.decision.replace(/\s*\n\s*/g, " ").trim();
      const line = `- ${today()}：${decision}${ids.length ? `（${ids.join(", ")}）` : ""}`;
      const current = fs.existsSync(paths.decisions) ? fs.readFileSync(paths.decisions, "utf8") : "# 設計判断の記録\n\n";
      writeFileAtomic(paths.decisions, current + (current.endsWith("\n") ? "" : "\n") + line + "\n");
      return text(`記録しました：${line}`);
    }
    default:
      return text(`不明なツールです：${name}`, true);
  }
}

function handle(msg: any, env: NodeJS.ProcessEnv): object | null {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  // id のないものは通知なので、返事をしない
  if (msg.id === undefined) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-code-wisdom", version: TOOL_VERSION },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        return reply(callTool(String(msg.params?.name ?? ""), msg.params?.arguments ?? {}, env));
      } catch (err) {
        return reply(text(`エラー：${(err as Error).message}`, true));
      }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
  }
}

/** 標準入出力で、1行1メッセージの JSON-RPC 2.0 を処理する */
export function runMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let out: object | null;
    try {
      out = handle(JSON.parse(line), process.env);
    } catch (err) {
      out =
        err instanceof SyntaxError
          ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
          : { jsonrpc: "2.0", id: null, error: { code: -32603, message: (err as Error).message } };
    }
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}
