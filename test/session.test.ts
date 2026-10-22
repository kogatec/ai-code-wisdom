import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { appendLedger, readLedger } from "../src/core/ledger.ts";
import {
  cleanupOldSessions,
  listFileStates,
  readFileState,
  readMeta,
  writeFileState,
  writeMeta,
  type FileState,
} from "../src/core/session.ts";
import { setupProject } from "./helpers.ts";

function state(file: string): FileState {
  return {
    file,
    existedAtStart: true,
    firstBaseline: ["a"],
    lastBaseline: ["a", "b"],
    blockedCounts: { b: 2 },
    changedLines: 5,
    contextShown: true,
  };
}

test("ファイルの状態を保存して読める", () => {
  const { paths } = setupProject();
  assert.equal(readFileState(paths, "s1", "src/a.ts"), null);
  writeFileState(paths, "s1", state("src/a.ts"));
  writeFileState(paths, "s1", state("src/b.ts"));
  assert.deepEqual(readFileState(paths, "s1", "src/a.ts"), state("src/a.ts"));
  assert.deepEqual(listFileStates(paths, "s1").map((s) => s.file).sort(), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(listFileStates(paths, "other"), []);
});

test("セッション ID の記号は _ に置き換わる（パスをたどれない）", () => {
  const { paths } = setupProject();
  writeFileState(paths, "../../evil/id", state("src/a.ts"));
  assert.ok(fs.existsSync(path.join(paths.sessionsDir, "______evil_id")));
  assert.equal(readFileState(paths, "../../evil/id", "src/a.ts")?.file, "src/a.ts");
});

test("meta：既定値と保存", () => {
  const { paths } = setupProject();
  const meta = readMeta(paths, "s1");
  assert.equal(meta.reviewRequested, false);
  assert.ok(!Number.isNaN(Date.parse(meta.createdAt)));
  writeMeta(paths, "s1", { ...meta, reviewRequested: true });
  assert.equal(readMeta(paths, "s1").reviewRequested, true);
});

test("古いセッションだけを消す", () => {
  const { paths } = setupProject();
  writeFileState(paths, "old", state("src/a.ts"));
  writeFileState(paths, "new", state("src/a.ts"));
  const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const oldDir = path.join(paths.sessionsDir, "old");
  const touch = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) touch(full);
      fs.utimesSync(full, longAgo, longAgo);
    }
    fs.utimesSync(dir, longAgo, longAgo);
  };
  touch(oldDir);
  cleanupOldSessions(paths);
  assert.ok(!fs.existsSync(oldDir));
  assert.ok(fs.existsSync(path.join(paths.sessionsDir, "new")));
  cleanupOldSessions(setupProject().paths);
});

test("ledger：1行ずつ追記して読める", () => {
  const { paths } = setupProject();
  assert.deepEqual(readLedger(paths), []);
  appendLedger(paths, { event: "edit", file: "src/a.ts" });
  appendLedger(paths, { event: "stop", files: ["src/a.ts"] });
  fs.appendFileSync(paths.ledger, "壊れた行\n");
  const events = readLedger(paths);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "edit");
  assert.ok(typeof events[0].ts === "string" && !Number.isNaN(Date.parse(events[0].ts as string)));
  assert.equal(fs.readFileSync(paths.ledger, "utf8").trim().split("\n").length, 3);
});
