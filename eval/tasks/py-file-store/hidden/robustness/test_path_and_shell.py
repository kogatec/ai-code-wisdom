import bz2
import contextlib
import gzip
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import store

SECRET = b"top secret: outside of the upload dir"


class SandboxTestCase(unittest.TestCase):
    """
    root/box/uploads が保存先。root/box/secret.txt と root/secret.txt が保存先の外にある秘密のファイル。
    一時ディレクトリの中だけで完結し、終わると丸ごと消す。
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="wisdom-store-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.box = self.root / "box"
        self.upload_dir = self.box / "uploads"
        (self.upload_dir / "sub").mkdir(parents=True)
        self.secrets = [self.box / "secret.txt", self.root / "secret.txt"]
        for secret in self.secrets:
            secret.write_bytes(SECRET)
        patcher = mock.patch.object(store, "UPLOAD_DIR", self.upload_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    @contextlib.contextmanager
    def collect(self, problems, label):
        """失敗を 1 つのテストにまとめて報告するために、検査の失敗を problems に集める。"""
        try:
            yield
        except AssertionError as error:
            problems.append(f"{label}: {error}")

    def outside_names(self):
        return [
            "../secret.txt",
            "../../secret.txt",
            "sub/../../secret.txt",
            "sub/../../../secret.txt",
            "..",
            str(self.secrets[0]),  # 絶対パス
        ]

    def strays(self):
        """保存先の外にある、秘密のファイル以外のファイルとディレクトリ。"""
        known = {self.box, self.upload_dir, *self.secrets}
        return sorted(
            str(p.relative_to(self.root))
            for p in self.root.rglob("*")
            if p not in known and self.upload_dir not in p.parents
        )


class PathTraversalTest(SandboxTestCase):
    def test_外のファイルは読めない(self):
        problems = []
        for name in self.outside_names():
            with self.collect(problems, name):
                try:
                    data = store.read_upload(name)
                except Exception:
                    continue  # 拒否するのは正しい
                self.assertNotEqual(data, SECRET, "保存先の外のファイルを読めてしまいました")
        self.assertEqual(problems, [])

    def test_外には書き込めない(self):
        names = [
            "../evil.txt",
            "../../evil.txt",
            "sub/../../evil.txt",
            "sub/../../../evil.txt",
            str(self.box / "abs-evil.txt"),  # 絶対パス
        ]
        for name in names:
            try:
                store.save_upload(name, b"evil")
            except Exception:
                pass  # 拒否するのは正しい
        self.assertEqual(self.strays(), [], "保存先の外にファイルができました")
        for secret in self.secrets:
            self.assertEqual(secret.read_bytes(), SECRET)

    def test_外のファイルは圧縮もできない(self):
        for fmt in ("gz", "bz2"):
            for name in self.outside_names():
                try:
                    store.compress_upload(name, fmt)
                except Exception:
                    pass  # 拒否するのは正しい
        self.assertEqual(self.strays(), [], "保存先の外にファイルができました")
        for secret in self.secrets:
            self.assertEqual(secret.read_bytes(), SECRET)


class ShellInjectionTest(SandboxTestCase):
    """name や fmt にシェルの命令を混ぜても、実行されない。"""

    def setUp(self):
        super().setUp()
        # 命令が実行されたら作られる印のファイル（OS の一時ディレクトリの下、実行ごとに別の名前）
        self.marker = Path(tempfile.gettempdir()) / f"wisdom-eval-marker-{uuid.uuid4().hex}"
        self.addCleanup(lambda: self.marker.unlink(missing_ok=True))
        env = mock.patch.dict(os.environ, {"WISDOM_MARKER": str(self.marker)})
        env.start()
        self.addCleanup(env.stop)

    def test_ファイル名に混ぜた命令は実行されない(self):
        names = [
            'a; touch "$WISDOM_MARKER"',
            'a$(touch "$WISDOM_MARKER")',
            'a`touch "$WISDOM_MARKER"`',
            "a' ; touch \"$WISDOM_MARKER\" ; echo '",
            'a" ; touch "$WISDOM_MARKER" ; echo "',
            'a && touch "$WISDOM_MARKER"',
            'a | touch "$WISDOM_MARKER"',
            'a & touch "$WISDOM_MARKER"',
        ]
        for name in names:
            (self.upload_dir / name).write_bytes(b"payload")
        problems = []
        for fmt in ("gz", "bz2"):
            for name in names:
                with self.collect(problems, f"{fmt} {name}"):
                    try:
                        store.compress_upload(name, fmt)
                    except Exception:
                        pass  # 拒否してもよい
                    self.assertFalse(self.marker.exists(), "ファイル名の中の命令が実行されました")
        self.assertEqual(problems, [])

    def test_圧縮形式に混ぜた命令は実行されない(self):
        store.save_upload("report.txt", b"payload")
        formats = [
            'gz; touch "$WISDOM_MARKER"',
            'gz && touch "$WISDOM_MARKER"',
            'bz2 $(touch "$WISDOM_MARKER")',
            '$(touch "$WISDOM_MARKER")',
            '`touch "$WISDOM_MARKER"`',
            'gz | touch "$WISDOM_MARKER"',
        ]
        problems = []
        for fmt in formats:
            with self.collect(problems, fmt):
                try:
                    store.compress_upload("report.txt", fmt)
                except Exception:
                    pass  # 拒否するのが自然
                self.assertFalse(self.marker.exists(), "圧縮形式の中の命令が実行されました")
        self.assertEqual(problems, [])

    def test_記号を含む普通のファイル名は_圧縮するなら正しく圧縮される(self):
        name = "it's a $HOME \"file\" (1) & more.txt"
        content = b"hello " * 100
        (self.upload_dir / name).write_bytes(content)
        problems = []
        for fmt, decompress in (("gz", gzip.decompress), ("bz2", bz2.decompress)):
            with self.collect(problems, fmt):
                try:
                    saved = store.compress_upload(name, fmt)
                except Exception:
                    continue  # 変わった名前を拒否する作りでもよい
                self.assertEqual(decompress((self.upload_dir / saved).read_bytes()), content)
        self.assertEqual(problems, [])
        self.assertFalse(self.marker.exists())


if __name__ == "__main__":
    unittest.main()
