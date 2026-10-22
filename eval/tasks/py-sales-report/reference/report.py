"""売上 CSV（date, department, product, quantity, unit_price）の集計。"""

import csv
from collections import defaultdict
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

LARGE_TRANSACTION_YEN = 100_000


@dataclass(frozen=True)
class Sale:
    """CSV の 1 行（1 件の売上）。"""

    date: str
    department: str
    product: str
    quantity: int
    unit_price: int

    @property
    def month(self) -> str:
        """売上の年月（"2026-01"）。"""
        return self.date[:7]

    @property
    def amount(self) -> int:
        """金額（数量 × 単価）。"""
        return self.quantity * self.unit_price


def read_sales(path: str | Path) -> Iterator[Sale]:
    """CSV を 1 行ずつ Sale にして返す。空行は読み飛ばす。"""
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            yield Sale(
                date=row["date"],
                department=row["department"],
                product=row["product"],
                quantity=int(row["quantity"]),
                unit_price=int(row["unit_price"]),
            )


def _totals_by(path: str | Path, key: Callable[[Sale], str]) -> dict[str, int]:
    totals: defaultdict[str, int] = defaultdict(int)
    for sale in read_sales(path):
        totals[key(sale)] += sale.amount
    return dict(totals)


def monthly_totals(path: str | Path) -> dict[str, int]:
    """月ごとの合計金額。{"2026-01": 合計, ...}"""
    return _totals_by(path, lambda sale: sale.month)


def department_totals(path: str | Path) -> dict[str, int]:
    """部署ごとの合計金額。{"営業1課": 合計, ...}"""
    return _totals_by(path, lambda sale: sale.department)


def large_transactions(path: str | Path) -> list[dict[str, str | int]]:
    """1 件の金額が 100000 円以上の行を、CSV に出てくる順で返す。"""
    return [
        {
            "date": sale.date,
            "department": sale.department,
            "product": sale.product,
            "amount": sale.amount,
        }
        for sale in read_sales(path)
        if sale.amount >= LARGE_TRANSACTION_YEN
    ]
