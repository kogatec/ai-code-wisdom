import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { searchUsers } from "../../src/users.ts";

interface Seed {
  name: string;
  email: string;
  createdAt: string;
}

// id は 1 から順に振られる。created_at の順（3, 1, 2）と name の順（2, 3, 1）が id の順とずれるようにしてある。
const SEEDS: Seed[] = [
  { name: "Charlie Tanaka", email: "charlie@example.test", createdAt: "2026-02-10T09:00:00.000Z" },
  { name: "Alice Tanaka", email: "alice@example.test", createdAt: "2026-03-01T09:00:00.000Z" },
  { name: "Bob Tanaka", email: "bob@example.test", createdAt: "2026-01-15T09:00:00.000Z" },
  { name: "Dave Sato", email: "dave@example.test", createdAt: "2026-04-01T09:00:00.000Z" },
  { name: "Eve Suzuki", email: "eve@example.test", createdAt: "2026-01-02T09:00:00.000Z" },
];

function makeDb(seeds: Seed[] = SEEDS): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  const insert = db.prepare("INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)");
  for (const seed of seeds) insert.run(seed.name, seed.email, seed.createdAt);
  return db;
}

const ids = (rows: unknown[]): number[] => rows.map((row) => (row as { id: number }).id);

test("名前の部分一致で検索でき、{ id, name, email } だけを id の昇順で返す", () => {
  const rows = searchUsers(makeDb(), "Tanaka");

  assert.ok(Array.isArray(rows));
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { id: 1, name: "Charlie Tanaka", email: "charlie@example.test" },
      { id: 2, name: "Alice Tanaka", email: "alice@example.test" },
      { id: 3, name: "Bob Tanaka", email: "bob@example.test" },
    ],
  );
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["email", "id", "name"]);
  }
});

test("名前の先頭・途中・末尾のどこに一致しても見つかる", () => {
  const db = makeDb();
  assert.deepEqual(ids(searchUsers(db, "Charlie")), [1]);
  assert.deepEqual(ids(searchUsers(db, "lie T")), [1]);
  assert.deepEqual(ids(searchUsers(db, "Sato")), [4]);
  assert.deepEqual(ids(searchUsers(db, "Eve Suzuki")), [5]);
});

test("一致するユーザーがいなければ空の配列を返す", () => {
  assert.deepEqual(searchUsers(makeDb(), "Nobody"), []);
});

test("日本語の名前でも部分一致で検索できる", () => {
  const db = makeDb([
    { name: "山田太郎", email: "taro@example.test", createdAt: "2026-01-01T00:00:00.000Z" },
    { name: "佐藤花子", email: "hanako@example.test", createdAt: "2026-01-02T00:00:00.000Z" },
    { name: "山田次郎", email: "jiro@example.test", createdAt: "2026-01-03T00:00:00.000Z" },
  ]);
  assert.deepEqual(ids(searchUsers(db, "山田")), [1, 3]);
  assert.deepEqual(ids(searchUsers(db, "花")), [2]);
});

test("sort: name で名前順に並べ、order で昇順・降順を選べる（order の既定は asc）", () => {
  const db = makeDb();
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { sort: "name" })), [2, 3, 1]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { sort: "name", order: "asc" })), [2, 3, 1]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { sort: "name", order: "desc" })), [1, 3, 2]);
});

test("sort: created_at で作成日時順に並べ、order で昇順・降順を選べる", () => {
  const db = makeDb();
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { sort: "created_at" })), [3, 1, 2]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { sort: "created_at", order: "desc" })), [2, 1, 3]);
});

test("limit で返す件数を絞れる", () => {
  const db = makeDb();
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { limit: 2 })), [1, 2]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { limit: 10 })), [1, 2, 3]);
  assert.deepEqual(searchUsers(db, "Tanaka", { limit: 0 }), []);
});

test("limit と offset でページ分けができる", () => {
  const db = makeDb();
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { limit: 2, offset: 0 })), [1, 2]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { limit: 2, offset: 2 })), [3]);
  assert.deepEqual(searchUsers(db, "Tanaka", { limit: 2, offset: 5 }), []);
});

test("offset だけを指定すると、先頭を読み飛ばして残りをすべて返す", () => {
  const db = makeDb();
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { offset: 1 })), [2, 3]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { offset: 3 })), []);
});

test("並び替えと件数の指定を組み合わせられ、オプションなしの呼び方は今までどおり", () => {
  const db = makeDb();
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { sort: "name", order: "desc", limit: 1, offset: 1 })), [3]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", { sort: "created_at", limit: 2 })), [3, 1]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka", {})), [1, 2, 3]);
  assert.deepEqual(ids(searchUsers(db, "Tanaka")), [1, 2, 3]);
});
