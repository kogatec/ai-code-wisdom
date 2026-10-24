#!/bin/sh
# 実際の Claude Code（ヘッドレス）でプラグインのフックが動くかを確かめる小さな試験。
# 使い方: sh scripts/smoke-plugin.sh   （claude にログイン済みの端末で実行する）
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/torus-plugin-smoke-XXXXXX")
cd "$W"
git init -q
git config user.email eval@example.invalid
git config user.name eval
printf '{ "type": "module" }\n' > package.json
mkdir -p src
cat > src/db.ts <<'EOF'
import { DatabaseSync } from "node:sqlite";

export function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)");
  db.exec("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com'), ('Bob', 'bob@example.com')");
  return db;
}
EOF
node "$ROOT/src/cli.ts" init --project "$W" --primary security-resilience --secondary maintainable > /dev/null
git add -A
git commit -qm init
PROMPT='src/users.ts に、名前の部分一致でユーザーを検索する関数 searchUsers(db, name) を作って。戻り値は { id, name, email } の配列にして。'
claude -p "$PROMPT" --model sonnet --output-format stream-json --verbose \
  --permission-mode acceptEdits --setting-sources project --plugin-dir "$ROOT" \
  --allowedTools Read Edit Write Glob Grep "Bash(node:*)" "Bash(torus:*)" > "$W/stream.jsonl" 2> "$W/stderr.txt" || true
echo "workdir: $W"
node "$ROOT/scripts/smoke-report.ts" "$W"
