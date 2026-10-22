import tempfile
import unittest
from pathlib import Path

import report

HEADER = "date,department,product,quantity,unit_price\n"

ROWS = [
    "2026-01-05,営業1課,ノートPC,2,98000",  # 196000
    "2026-01-12,営業2課,マウス,10,1500",  # 15000
    "2026-01-31,営業1課,モニター,3,32000",  # 96000
    "2026-02-01,営業2課,ノートPC,1,98000",  # 98000
    "2026-02-14,営業1課,キーボード,5,4800",  # 24000
    "2026-03-01,営業2課,サーバー,1,100000",  # 100000 ちょうど
    "2026-03-02,営業1課,モニター,4,25000",  # 100000 ちょうど
    "2026-03-09,営業1課,ケーブル,1,99999",  # 99999
]


class SalesCsvTestCase(unittest.TestCase):
    def write_csv(self, rows, name="sales.csv"):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / name
        path.write_text(HEADER + "".join(row + "\n" for row in rows), encoding="utf-8")
        return path


class MonthlyTotalsTest(SalesCsvTestCase):
    def test_月ごとに_数量かける単価_を合計する(self):
        path = self.write_csv(ROWS)
        self.assertEqual(
            report.monthly_totals(path),
            {"2026-01": 196000 + 15000 + 96000, "2026-02": 98000 + 24000, "2026-03": 100000 + 100000 + 99999},
        )

    def test_月の境目の日付は正しい月に入る(self):
        path = self.write_csv(["2026-01-31,営業1課,A,1,100", "2026-02-01,営業1課,A,1,200"])
        self.assertEqual(report.monthly_totals(path), {"2026-01": 100, "2026-02": 200})

    def test_pathは文字列でも渡せる(self):
        path = self.write_csv(ROWS)
        self.assertEqual(report.monthly_totals(str(path)), report.monthly_totals(path))

    def test_同じ月の複数の行は合算され_売上のない月は含まれない(self):
        path = self.write_csv(["2026-04-01,営業1課,A,1,100", "2026-04-01,営業1課,A,1,100", "2026-06-15,営業2課,B,2,50"])
        self.assertEqual(report.monthly_totals(path), {"2026-04": 200, "2026-06": 100})


class DepartmentTotalsTest(SalesCsvTestCase):
    def test_部署ごとに合計する(self):
        path = self.write_csv(ROWS)
        self.assertEqual(
            report.department_totals(path),
            {
                "営業1課": 196000 + 96000 + 24000 + 100000 + 99999,
                "営業2課": 15000 + 98000 + 100000,
            },
        )

    def test_行が1つの部署も含まれる(self):
        path = self.write_csv(["2026-01-05,営業3課,A,2,500"])
        self.assertEqual(report.department_totals(path), {"営業3課": 1000})


class LargeTransactionsTest(SalesCsvTestCase):
    def test_100000円以上の行だけを_CSVの順に_決まった形で返す(self):
        path = self.write_csv(ROWS)
        self.assertEqual(
            report.large_transactions(path),
            [
                {"date": "2026-01-05", "department": "営業1課", "product": "ノートPC", "amount": 196000},
                {"date": "2026-03-01", "department": "営業2課", "product": "サーバー", "amount": 100000},
                {"date": "2026-03-02", "department": "営業1課", "product": "モニター", "amount": 100000},
            ],
        )

    def test_該当する行がなければ空のリスト(self):
        path = self.write_csv(["2026-01-05,営業1課,A,1,99999"])
        self.assertEqual(report.large_transactions(path), [])


if __name__ == "__main__":
    unittest.main()
