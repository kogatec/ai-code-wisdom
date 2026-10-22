import unittest
from unittest import mock

import db
import registry

EMAIL = "taro@example.test"
PASSWORD = "correct horse battery staple"


class RegistryTestCase(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect()
        self.addCleanup(self.conn.close)


class RegisterAndAuthenticateTest(RegistryTestCase):
    def test_登録するとidが返り_同じパスワードで認証できる(self):
        user_id = registry.register(self.conn, EMAIL, PASSWORD)
        self.assertIsInstance(user_id, int)
        self.assertTrue(registry.authenticate(self.conn, EMAIL, PASSWORD))

    def test_パスワードが違えばFalse(self):
        registry.register(self.conn, EMAIL, PASSWORD)
        self.assertFalse(registry.authenticate(self.conn, EMAIL, PASSWORD + "x"))
        self.assertFalse(registry.authenticate(self.conn, EMAIL, ""))

    def test_未登録のメールアドレスはFalse(self):
        registry.register(self.conn, EMAIL, PASSWORD)
        self.assertFalse(registry.authenticate(self.conn, "other@example.test", PASSWORD))

    def test_同じメールアドレスを登録するとDuplicateEmailError(self):
        registry.register(self.conn, EMAIL, PASSWORD)
        with self.assertRaises(registry.DuplicateEmailError):
            registry.register(self.conn, EMAIL, "another password")
        # 先に登録した内容は変わらない
        self.assertTrue(registry.authenticate(self.conn, EMAIL, PASSWORD))
        self.assertFalse(registry.authenticate(self.conn, EMAIL, "another password"))

    def test_複数のユーザーを別々に登録できる(self):
        first = registry.register(self.conn, "a@example.test", "password-a")
        second = registry.register(self.conn, "b@example.test", "password-b")
        self.assertNotEqual(first, second)
        self.assertTrue(registry.authenticate(self.conn, "a@example.test", "password-a"))
        self.assertTrue(registry.authenticate(self.conn, "b@example.test", "password-b"))
        self.assertFalse(registry.authenticate(self.conn, "a@example.test", "password-b"))

    def test_日本語や長いパスワードも使える(self):
        for password in ["パスワード🔑秘密", "x" * 1000]:
            email = f"{len(password)}@example.test"
            registry.register(self.conn, email, password)
            self.assertTrue(registry.authenticate(self.conn, email, password))
            self.assertFalse(registry.authenticate(self.conn, email, password[:-1]))


class ResetPasswordTest(RegistryTestCase):
    def setUp(self):
        super().setUp()
        registry.register(self.conn, EMAIL, PASSWORD)

    def test_トークンでパスワードを変更できる(self):
        token = registry.issue_reset_token(self.conn, EMAIL)
        self.assertIsInstance(token, str)

        registry.reset_password(self.conn, token, "new password 123")

        self.assertTrue(registry.authenticate(self.conn, EMAIL, "new password 123"))
        self.assertFalse(registry.authenticate(self.conn, EMAIL, PASSWORD))

    def test_未登録のメールアドレスにはトークンを発行しない(self):
        with self.assertRaises(registry.UnknownEmailError):
            registry.issue_reset_token(self.conn, "nobody@example.test")

    def test_でたらめなトークンはInvalidTokenError(self):
        registry.issue_reset_token(self.conn, EMAIL)
        for token in ["", "not-a-token", "A" * 43]:
            with self.assertRaises(registry.InvalidTokenError):
                registry.reset_password(self.conn, token, "new password 123")
        self.assertTrue(registry.authenticate(self.conn, EMAIL, PASSWORD))

    def test_発行から30分以内なら使える(self):
        issued_at = 1_800_000_000.0
        with mock.patch("time.time", return_value=issued_at):
            token = registry.issue_reset_token(self.conn, EMAIL)
        with mock.patch("time.time", return_value=issued_at + 29 * 60):
            registry.reset_password(self.conn, token, "new password 123")
        self.assertTrue(registry.authenticate(self.conn, EMAIL, "new password 123"))

    def test_発行から30分を過ぎるとInvalidTokenErrorで_パスワードは変わらない(self):
        issued_at = 1_800_000_000.0
        with mock.patch("time.time", return_value=issued_at):
            token = registry.issue_reset_token(self.conn, EMAIL)
        with mock.patch("time.time", return_value=issued_at + 31 * 60):
            with self.assertRaises(registry.InvalidTokenError):
                registry.reset_password(self.conn, token, "new password 123")
        self.assertTrue(registry.authenticate(self.conn, EMAIL, PASSWORD))
        self.assertFalse(registry.authenticate(self.conn, EMAIL, "new password 123"))


if __name__ == "__main__":
    unittest.main()
