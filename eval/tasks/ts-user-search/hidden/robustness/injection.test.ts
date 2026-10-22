import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { searchUsers } from "../../src/users.ts";

// 呼び出し側の値（検索語・sort・order・limit・offset）に SQL を混ぜても、
// 意図しない行が返らず、表も壊れないことを確かめる。

const SEEDS = [
  { name: "Charlie Tanaka", email: "charlie@example.test", createdAt: "2026-02-10T09:00:00.000Z" },
  { name: "Alice Tanaka", email: "alice@example.test", createdAt: "2026-03-01T09:00:00.000Z" },
  { name: "Bob Tanaka", email: "bob@example.test", createdAt: "2026-01-15T09:00:00.000Z" },
  { name: "Dave Sato", email: "dave@example.test", createdAt: "2026-04-01T09:00:00.000Z" },
  { name: "Eve Suzuki", email: "eve@example.test", createdAt: "2026-01-02T09:00:00.000Z" },
];

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  const insert = db.prepare("INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)");
  for (const seed of SEEDS) insert.run(seed.name, seed.email, seed.createdAt);
  return db;
}

const ids = (rows: unknown[]): number[] => rows.map((row) => (row as { id: number }).id);

function snapshot(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT id, name, email, created_at FROM users ORDER BY id").all());
}

/** 例外で拒否してもよいし、受け付けるなら正しい結果でなければならない。 */
function tryOrReject<T>(run: () => T): { rejected: true } | { rejected: false; value: T } {
  try {
    return { rejected: false, value: run() };
  } catch {
    return { rejected: true };
  }
}

test("検索語に ' OR '1'='1 などを入れても、全件が返らない", () => {
  const db = makeDb();
  const before = snapshot(db);
  for (const name of ["' OR '1'='1", "%' OR 1=1 --", "' OR ''='", "x'; DELETE FROM users; --"]) {
    assert.deepEqual(searchUsers(db, name), [], `検索語 ${JSON.stringify(name)} で行が返りました`);
  }
  assert.equal(snapshot(db), before);
});

test("検索語に UNION を入れても、他の列の値が結果に混ざらない", () => {
  const db = makeDb();
  const attack = "zzz' UNION SELECT id, email, name FROM users --";
  assert.deepEqual(searchUsers(db, attack), []);
  assert.deepEqual(searchUsers(db, `zzz%' UNION SELECT 1, 'x', 'y' WHERE '1'='1`), []);
});

test("名前に引用符や記号が入っていても、その名前で検索できる", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  const insert = db.prepare("INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)");
  const names = ["Pat O'Brien", 'Say "hi" Lee', "a--b; c", "back\\slash", "plain"];
  names.forEach((name, index) => insert.run(name, `u${index}@example.test`, "2026-01-01T00:00:00.000Z"));

  assert.deepEqual(ids(searchUsers(db, "O'Brien")), [1]);
  assert.deepEqual(ids(searchUsers(db, 'Say "hi"')), [2]);
  assert.deepEqual(ids(searchUsers(db, "a--b; c")), [3]);
  assert.deepEqual(ids(searchUsers(db, "back\\slash")), [4]);
});

test("sort に SQL を入れても実行されず、表も壊れない", () => {
  const db = makeDb();
  const before = snapshot(db);
  const defaultIds = ids(searchUsers(db, "Tanaka"));
  const attacks = ["email DESC", "name DESC", "name; DROP TABLE users; --", "(SELECT 1)", "created_at ASC", "constructor"];
  for (const sort of attacks) {
    const outcome = tryOrReject(() => searchUsers(db, "Tanaka", { sort: sort as never }));
    if (!outcome.rejected) {
      // 受け付けるなら、SQL として解釈せず既定の並びで返すこと
      assert.deepEqual(ids(outcome.value), defaultIds, `sort ${JSON.stringify(sort)} が SQL として解釈されました`);
    }
  }
  assert.equal(snapshot(db), before);
});

test("order に SQL を入れても実行されず、表も壊れない", () => {
  const db = makeDb();
  const before = snapshot(db);
  const nameAsc = ids(searchUsers(db, "Tanaka", { sort: "name" }));
  const attacks = ["desc, email", "asc; DROP TABLE users; --", "ASC, (SELECT 1)", "descending"];
  for (const order of attacks) {
    const outcome = tryOrReject(() => searchUsers(db, "Tanaka", { sort: "name", order: order as never }));
    if (!outcome.rejected) {
      assert.deepEqual(ids(outcome.value), nameAsc, `order ${JSON.stringify(order)} が SQL として解釈されました`);
    }
  }
  assert.equal(snapshot(db), before);
});

test("limit と offset に SQL を入れても実行されず、一致した行以外は返らない", () => {
  const db = makeDb();
  const before = snapshot(db);
  const tanakaIds = new Set(ids(searchUsers(db, "Tanaka")));
  const attacks: { limit?: unknown; offset?: unknown }[] = [
    { limit: "1; DROP TABLE users" },
    { limit: "(SELECT count(*) FROM users)" },
    { limit: "1 UNION SELECT id, email, name FROM users" },
    { offset: "0; DELETE FROM users" },
    { offset: "(SELECT 1)" },
    { limit: 2, offset: "1 OR 1=1" },
  ];
  for (const options of attacks) {
    const outcome = tryOrReject(() => searchUsers(db, "Tanaka", options as never));
    if (!outcome.rejected) {
      assert.ok(Array.isArray(outcome.value));
      for (const id of ids(outcome.value)) {
        assert.ok(tanakaIds.has(id), `一致していない行（id=${id}）が返りました`);
      }
    }
  }
  // SQL として評価されていれば件数が変わる値。受け付けるなら、その値を無視した結果でなければならない
  const limited = tryOrReject(() => searchUsers(db, "Tanaka", { limit: "(SELECT 1)" as never }));
  if (!limited.rejected) assert.notEqual(limited.value.length, 1, "limit の中の SQL が評価されました");
  const skipped = tryOrReject(() => searchUsers(db, "Tanaka", { offset: "(SELECT 3)" as never }));
  if (!skipped.rejected) assert.notEqual(skipped.value.length, 0, "offset の中の SQL が評価されました");
  assert.equal(snapshot(db), before);
});
