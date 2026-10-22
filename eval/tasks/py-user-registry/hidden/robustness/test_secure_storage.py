import base64
import hashlib
import unittest

import db
import registry

# 保存のしかた（パスワードの扱い、トークンの作り方、SQL の組み立て）が安全であることを確かめる。


def stored_values(conn):
    """DB のすべての表のすべての値を、バイト列にして返す。"""
    values = []
    tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    for table in tables:
        quoted = '"' + table.replace('"', '""') + '"'
        for row in conn.execute(f"SELECT * FROM {quoted}"):
            for value in row:
                if isinstance(value, bytes):
                    values.append(value)
                elif value is not None:
                    values.append(str(value).encode("utf-8"))
    return values


def appears_in_db(conn, needle):
    needle = needle.lower() if isinstance(needle, str) else needle
    haystack = [value.lower() for value in stored_values(conn)]
    needle_bytes = needle.encode("utf-8") if isinstance(needle, str) else needle
    return any(needle_bytes in value for value in haystack)


class SecureStorageTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect()
        self.addCleanup(self.conn.close)


class PasswordStorageTest(SecureStorageTestCase):
    def test_パスワードは平文でも_可逆な符号化でも_保存されない(self):
        passwords = {
            "a@example.test": "Zq9-correct horse-staple#1",
            "b@example.test": "Zq9-correct horse-staple#2",
        }
        for email, password in passwords.items():
            registry.register(self.conn, email, password)
        # リセット後の新しいパスワードも同じ
        token = registry.issue_reset_token(self.conn, "a@example.test")
        new_password = "Zq9-brand new secret#3"
        registry.reset_password(self.conn, token, new_password)
        passwords["a-after-reset"] = new_password

        problems = []
        for label, password in passwords.items():
            raw = password.encode("utf-8")
            candidates = {
                "平文": password,
                "16進数": raw.hex(),
                "base64": base64.b64encode(raw).decode("ascii"),
                "URL 用 base64": base64.urlsafe_b64encode(raw).decode("ascii"),
            }
            for kind, text in candidates.items():
                if appears_in_db(self.conn, text):
                    problems.append(f"{label} のパスワードが {kind} で保存されています")
        self.assertEqual(problems, [])

    def test_ソルトなしの単純なハッシュ値でも保存されない(self):
        password = "Zq9-correct horse-staple#1"
        registry.register(self.conn, "a@example.test", password)

        problems = []
        for algorithm in ("md5", "sha1", "sha224", "sha256", "sha384", "sha512"):
            digest = hashlib.new(algorithm, password.encode("utf-8")).hexdigest()
            if appears_in_db(self.conn, digest):
                problems.append(f"{algorithm} の単純なハッシュ値が保存されています")
        self.assertEqual(problems, [])

    def test_同じパスワードでも_ユーザーごとに保存される値が違う(self):
        registry.register(self.conn, "a@example.test", "same password for everyone")
        registry.register(self.conn, "b@example.test", "same password for everyone")
        rows = self.conn.execute("SELECT password_hash FROM users ORDER BY id").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0][0], rows[1][0])
        # どちらも正しく認証できる
        self.assertTrue(registry.authenticate(self.conn, "a@example.test", "same password for everyone"))
        self.assertTrue(registry.authenticate(self.conn, "b@example.test", "same password for everyone"))


class ResetTokenTest(SecureStorageTestCase):
    def test_トークンは毎回違い_16文字以上(self):
        registry.register(self.conn, "a@example.test", "password-a")
        registry.register(self.conn, "b@example.test", "password-b")

        tokens = [registry.issue_reset_token(self.conn, email) for email in ["a@example.test", "b@example.test"] * 10]

        self.assertEqual(len(set(tokens)), len(tokens), "同じトークンが発行されました")
        for token in tokens:
            self.assertGreaterEqual(len(token), 16)

    def test_使い終わったトークンは再利用できない(self):
        registry.register(self.conn, "a@example.test", "old password")
        token = registry.issue_reset_token(self.conn, "a@example.test")
        registry.reset_password(self.conn, token, "first new password")

        with self.assertRaises(registry.InvalidTokenError):
            registry.reset_password(self.conn, token, "second new password")

        self.assertTrue(registry.authenticate(self.conn, "a@example.test", "first new password"))
        self.assertFalse(registry.authenticate(self.conn, "a@example.test", "second new password"))


class SqlInjectionTest(SecureStorageTestCase):
    def test_メールアドレスに引用符やSQLが入っていても登録と認証とリセットができ_注入されない(self):
        emails = ["o'brien@example.test", "x'); DROP TABLE users; --@example.test", 'say"hi"@example.test']
        for email in emails:
            registry.register(self.conn, email, "password for " + email)
        for email in emails:
            self.assertTrue(registry.authenticate(self.conn, email, "password for " + email))
            token = registry.issue_reset_token(self.conn, email)
            registry.reset_password(self.conn, token, "reset " + email)
            self.assertTrue(registry.authenticate(self.conn, email, "reset " + email))

        count = self.conn.execute("SELECT count(*) FROM users").fetchone()[0]
        self.assertEqual(count, len(emails))

        # SQL を混ぜたメールアドレスで、ほかのユーザーとして認証したりトークンをもらったりできない
        attacks = ["' OR '1'='1", "o'brien@example.test' --", "' OR 1=1 --", "x' OR email LIKE '%"]
        for attack in attacks:
            self.assertFalse(registry.authenticate(self.conn, attack, "anything"), attack)
            self.assertFalse(registry.authenticate(self.conn, attack, "' OR '1'='1"), attack)
            try:
                token = registry.issue_reset_token(self.conn, attack)
            except Exception:
                continue  # 拒否するのは正しい
            self.fail(f"{attack!r} に対してトークンが発行されました: {token!r}")


if __name__ == "__main__":
    unittest.main()
