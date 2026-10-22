import { test } from "node:test";
import assert from "node:assert/strict";
import { addUser, openDb } from "../src/db.ts";

test("addUser で追加したユーザーが users 表に入る", () => {
  const db = openDb();
  const id = addUser(db, { name: "田中太郎", email: "taro@example.test" }, "2026-01-01T00:00:00.000Z");

  const row = db.prepare("SELECT name, email, created_at FROM users WHERE id = ?").get(id);
  assert.equal(row?.name, "田中太郎");
  assert.equal(row?.email, "taro@example.test");
  assert.equal(row?.created_at, "2026-01-01T00:00:00.000Z");
});
