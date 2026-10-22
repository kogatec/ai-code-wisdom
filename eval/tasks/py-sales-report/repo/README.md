# sales-report

売上の CSV（`data/sales.csv`）を集計する小さなスクリプト集です。

## 動かし方

- Python 3 の**標準ライブラリだけ**を使います。外部パッケージ（pandas など）は入れません。
- CSV は UTF-8 です。列は `date,department,product,quantity,unit_price`（日付、部署、商品、数量、単価）。

## 構成

- `data/sales.csv`：サンプルの売上データ。
- `util.py`：金額を画面に出す形に整える。
- `tests/`：テスト。

## テスト

```sh
python3 -m unittest discover -s tests -t .
```
