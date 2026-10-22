import unittest

import db


class ConnectTest(unittest.TestCase):
    def test_connectはusers表を作る(self):
        conn = db.connect()
        self.addCleanup(conn.close)

        conn.execute("INSERT INTO users (email, password_hash) VALUES (?, ?)", ("a@example.test", "hash"))
        row = conn.execute("SELECT email, password_hash FROM users").fetchone()

        self.assertEqual(row, ("a@example.test", "hash"))


if __name__ == "__main__":
    unittest.main()
