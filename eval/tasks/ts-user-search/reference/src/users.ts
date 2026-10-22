import type { DatabaseSync } from "node:sqlite";

export interface User {
  id: number;
  name: string;
  email: string;
}

export type SortKey = "name" | "created_at";
export type SortOrder = "asc" | "desc";

export interface SearchOptions {
  sort?: SortKey;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

// ORDER BY に入れてよい文字列はここにあるものだけ。呼び出し側の値は、表を引くキーとして使うだけで SQL には混ぜない。
const ORDER_BY: Record<SortKey | "id", Record<SortOrder, string>> = {
  id: { asc: "id ASC", desc: "id DESC" },
  name: { asc: "name ASC, id ASC", desc: "name DESC, id ASC" },
  created_at: { asc: "created_at ASC, id ASC", desc: "created_at DESC, id ASC" },
};

const SEARCH_SQL = "SELECT id, name, email FROM users WHERE name LIKE ? ESCAPE '\\'";
const NO_LIMIT = -1; // SQLite では LIMIT -1 が「上限なし」

function resolveOrderBy(sort: unknown, order: unknown): string {
  if (sort !== undefined && sort !== "name" && sort !== "created_at") {
    throw new RangeError('sort は "name" か "created_at" にしてください');
  }
  if (order !== undefined && order !== "asc" && order !== "desc") {
    throw new RangeError('order は "asc" か "desc" にしてください');
  }
  return ORDER_BY[sort ?? "id"][order ?? "asc"];
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new RangeError(`${label} は 0 以上の整数にしてください`);
}

/** 名前の部分一致で検索する。% と _ も文字として扱う。 */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

function toUser(row: Record<string, unknown>): User {
  return { id: row.id as number, name: row.name as string, email: row.email as string };
}

/** 名前に name を含むユーザーを返す。既定の並びは id の昇順。 */
export function searchUsers(db: DatabaseSync, name: string, options: SearchOptions = {}): User[] {
  if (typeof name !== "string") throw new TypeError("name は文字列にしてください");
  const orderBy = resolveOrderBy(options.sort, options.order);
  const limit = optionalCount(options.limit, "limit");
  const offset = optionalCount(options.offset, "offset");

  const statement = db.prepare(`${SEARCH_SQL} ORDER BY ${orderBy} LIMIT ? OFFSET ?`);
  return statement.all(likePattern(name), limit ?? NO_LIMIT, offset ?? 0).map(toUser);
}
