import tempfile
import unittest
from pathlib import Path
from unittest import mock

import store


class EnsureUploadDirTest(unittest.TestCase):
    def test_保存先がなければ作る(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "uploads"
            with mock.patch.object(store, "UPLOAD_DIR", target):
                store.ensure_upload_dir()
            self.assertTrue(target.is_dir())


if __name__ == "__main__":
    unittest.main()
