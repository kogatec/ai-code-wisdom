import { DatabaseSync } from "node:sqlite";

export interface NewUser {
  name: string;
  email: string;
}

/** users 表を持つ DB を開く。path を省略するとメモリ上の DB になる。 */
export function openDb(path: string = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

/** ユーザーを追加して、採番された id を返す。 */
export function addUser(db: DatabaseSync, user: NewUser, createdAt: string = new Date().toISOString()): number {
  const result = db
    .prepare("INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)")
    .run(user.name, user.email, createdAt);
  return Number(result.lastInsertRowid);
}
