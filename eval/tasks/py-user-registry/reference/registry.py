"""ユーザー登録・認証・パスワードのリセット。"""

import hashlib
import hmac
import secrets
import sqlite3
import time

# scrypt のパラメーター（メモリ 16 MiB 前後を使う、対話的なログイン向けの強さ）
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SALT_BYTES = 16
KEY_BYTES = 32

RESET_TOKEN_BYTES = 32
RESET_TOKEN_TTL_SECONDS = 30 * 60


class DuplicateEmailError(Exception):
    """同じメールアドレスがすでに登録されている。"""


class UnknownEmailError(Exception):
    """登録されていないメールアドレス。"""


class InvalidTokenError(Exception):
    """リセット用のトークンが、存在しない・失効している・使用済み。"""


def _derive_key(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=KEY_BYTES)


def _hash_password(password: str) -> str:
    """salt を付けた scrypt ハッシュを "scrypt$n$r$p$salt$hash" の形の文字列にする。"""
    salt = secrets.token_bytes(SALT_BYTES)
    key = _derive_key(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${key.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, key_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        key = _derive_key(password, bytes.fromhex(salt_hex), int(n), int(r), int(p))
        return hmac.compare_digest(key, bytes.fromhex(key_hex))
    except ValueError:
        return False


# 未登録のメールアドレスでも同じだけ時間をかけ、登録の有無を応答時間から読まれにくくする
_DUMMY_HASH = _hash_password(secrets.token_urlsafe(16))


def _hash_token(token: str) -> str:
    # トークンは十分にランダムなので、salt なしの SHA-256 で保存して問題ない
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def register(conn: sqlite3.Connection, email: str, password: str) -> int:
    """ユーザーを登録して id を返す。同じメールアドレスがあれば DuplicateEmailError。"""
    password_hash = _hash_password(password)
    try:
        with conn:
            cursor = conn.execute(
                "INSERT INTO users (email, password_hash) VALUES (?, ?)", (email, password_hash)
            )
    except sqlite3.IntegrityError:
        raise DuplicateEmailError(email) from None
    return cursor.lastrowid


def authenticate(conn: sqlite3.Connection, email: str, password: str) -> bool:
    """メールアドレスとパスワードが登録内容と一致すれば True。"""
    row = conn.execute("SELECT password_hash FROM users WHERE email = ?", (email,)).fetchone()
    if row is None:
        _verify_password(password, _DUMMY_HASH)
        return False
    return _verify_password(password, row[0])


def issue_reset_token(conn: sqlite3.Connection, email: str) -> str:
    """リセット用のトークンを発行して返す。30 分で失効する。"""
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row is None:
        raise UnknownEmailError(email)

    token = secrets.token_urlsafe(RESET_TOKEN_BYTES)
    expires_at = time.time() + RESET_TOKEN_TTL_SECONDS
    with conn:
        conn.execute(
            "INSERT INTO reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_hash_token(token), row[0], expires_at),
        )
    return token


def reset_password(conn: sqlite3.Connection, token: str, new_password: str) -> None:
    """有効なトークンでパスワードを変更する。トークンは 1 回しか使えない。"""
    with conn:
        row = conn.execute(
            "SELECT user_id, expires_at, used FROM reset_tokens WHERE token_hash = ?",
            (_hash_token(token),),
        ).fetchone()
        if row is None or row[2] or row[1] <= time.time():
            raise InvalidTokenError("トークンが無効か、期限が切れています")
        user_id = row[0]
        conn.execute("UPDATE reset_tokens SET used = 1 WHERE token_hash = ?", (_hash_token(token),))
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (_hash_password(new_password), user_id))
