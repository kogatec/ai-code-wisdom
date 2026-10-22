from pathlib import Path

# アップロードされたファイルの保存先
UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"


def ensure_upload_dir():
    """保存先ディレクトリがなければ作る。"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
