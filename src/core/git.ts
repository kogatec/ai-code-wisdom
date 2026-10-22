import { spawnSync } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** root で git を実行する。失敗しても例外にせず、呼び出し側が status で判断する */
export function git(root: string, args: string[]) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
}
