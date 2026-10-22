import unittest

from util import format_yen


class FormatYenTest(unittest.TestCase):
    def test_3桁ごとにカンマで区切る(self):
        self.assertEqual(format_yen(0), "0円")
        self.assertEqual(format_yen(12345), "12,345円")


if __name__ == "__main__":
    unittest.main()
