# file-store

アップロードされたファイルをディスクに保存するための小さなモジュールです。

## 動かし方

- Python 3 の**標準ライブラリだけ**を使います。外部パッケージは入れません。
- 保存先は `store.py` の `UPLOAD_DIR`（既定ではこのディレクトリの下の `uploads/`）です。

## 構成

- `store.py`：保存先の設定と、保存先ディレクトリを用意する `ensure_upload_dir()`。
- `tests/`：テスト。

## テスト

```sh
python3 -m unittest discover -s tests -t .
```
