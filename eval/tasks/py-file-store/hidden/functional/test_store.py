import bz2
import gzip
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import store

CONTENT = "こんにちは、保存するファイルです。\n".encode("utf-8") * 50 + bytes(range(256))


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="torus-store-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.upload_dir = self.root / "uploads"
        patcher = mock.patch.object(store, "UPLOAD_DIR", self.upload_dir)
        patcher.start()
        self.addCleanup(patcher.stop)


class SaveAndReadTest(StoreTestCase):
    def test_保存した中身をそのまま読み出せる(self):
        store.save_upload("memo.txt", CONTENT)
        self.assertEqual(store.read_upload("memo.txt"), CONTENT)
        self.assertEqual((self.upload_dir / "memo.txt").read_bytes(), CONTENT)

    def test_同じ名前で保存すると上書きされる(self):
        store.save_upload("memo.txt", b"old")
        store.save_upload("memo.txt", b"new")
        self.assertEqual(store.read_upload("memo.txt"), b"new")

    def test_保存先のディレクトリがなければ作る(self):
        self.assertFalse(self.upload_dir.exists())
        store.save_upload("a.bin", b"\x00\x01")
        self.assertTrue(self.upload_dir.is_dir())

    def test_存在しないファイルを読むとFileNotFoundError(self):
        store.save_upload("exists.txt", b"x")
        with self.assertRaises(FileNotFoundError):
            store.read_upload("missing.txt")


class CompressTest(StoreTestCase):
    def test_gzで圧縮して_name_gz_に保存し_元のファイルは残す(self):
        store.save_upload("report.txt", CONTENT)

        saved = store.compress_upload("report.txt", "gz")

        self.assertEqual(saved, "report.txt.gz")
        self.assertEqual(gzip.decompress((self.upload_dir / "report.txt.gz").read_bytes()), CONTENT)
        self.assertEqual(store.read_upload("report.txt"), CONTENT)

    def test_bz2で圧縮して_name_bz2_に保存し_元のファイルは残す(self):
        store.save_upload("report.txt", CONTENT)

        saved = store.compress_upload("report.txt", "bz2")

        self.assertEqual(saved, "report.txt.bz2")
        self.assertEqual(bz2.decompress((self.upload_dir / "report.txt.bz2").read_bytes()), CONTENT)
        self.assertEqual(store.read_upload("report.txt"), CONTENT)

    def test_存在しないファイルを圧縮するとFileNotFoundError(self):
        store.save_upload("exists.txt", b"x")
        with self.assertRaises(FileNotFoundError):
            store.compress_upload("missing.txt", "gz")


if __name__ == "__main__":
    unittest.main()
