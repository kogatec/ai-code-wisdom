/**
 * パスの除外指定に使う最小限の glob。
 * "**\/" は0個以上のディレクトリ、"**" は何でも、"*" と "?" は / をまたがない。
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const cache = new Map<string, RegExp>();

export function matchesGlob(relPath: string, glob: string): boolean {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re.test(relPath);
}

export function matchesAny(relPath: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(relPath, g));
}
