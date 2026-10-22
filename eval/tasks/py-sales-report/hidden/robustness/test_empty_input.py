import tempfile
import unittest
from pathlib import Path

import report

HEADER = "date,department,product,quantity,unit_price\n"


class EmptyInputTest(unittest.TestCase):
    """データ行がない CSV でも、例外にならず空の結果を返す。"""

    def write(self, text):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "sales.csv"
        path.write_text(text, encoding="utf-8")
        return path

    def test_ヘッダーだけのCSVは空の結果になる(self):
        path = self.write(HEADER)
        self.assertEqual(report.monthly_totals(path), {})
        self.assertEqual(report.department_totals(path), {})
        self.assertEqual(report.large_transactions(path), [])

    def test_ヘッダーだけで末尾の改行もないCSVでも空の結果になる(self):
        path = self.write(HEADER.rstrip("\n"))
        self.assertEqual(report.monthly_totals(path), {})
        self.assertEqual(report.department_totals(path), {})
        self.assertEqual(report.large_transactions(path), [])

    def test_末尾や途中に空行があっても読み飛ばす(self):
        path = self.write(HEADER + "\n2026-01-05,営業1課,A,2,50000\n\n2026-01-06,営業1課,B,1,100000\n\n\n")
        self.assertEqual(report.monthly_totals(path), {"2026-01": 200000})
        self.assertEqual(report.department_totals(path), {"営業1課": 200000})
        self.assertEqual(len(report.large_transactions(path)), 2)


if __name__ == "__main__":
    unittest.main()
