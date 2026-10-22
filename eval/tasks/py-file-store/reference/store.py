import subprocess
from pathlib import Path

# アップロードされたファイルの保存先
UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"

# 圧縮形式と、使うコマンド。コマンドはこの表から選び、呼び出し側の文字列は実行しない。
COMPRESSORS = {"gz": "gzip", "bz2": "bzip2"}
COMPRESS_TIMEOUT_SECONDS = 60


def ensure_upload_dir() -> None:
    """保存先ディレクトリがなければ作る。"""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _upload_path(name: str) -> Path:
    """name を UPLOAD_DIR 直下のファイルのパスにする。外へ出る名前は ValueError。"""
    base = Path(UPLOAD_DIR).resolve()
    path = (base / name).resolve()
    if path.parent != base:
        raise ValueError(f"不正なファイル名です: {name!r}")
    return path


def save_upload(name: str, content: bytes) -> None:
    """content（bytes）を UPLOAD_DIR の中の name に保存する。"""
    if not isinstance(content, (bytes, bytearray)):
        raise TypeError("content は bytes にしてください")
    ensure_upload_dir()
    _upload_path(name).write_bytes(content)


def read_upload(name: str) -> bytes:
    """UPLOAD_DIR の中の name の中身を bytes で返す。"""
    return _upload_path(name).read_bytes()


def compress_upload(name: str, fmt: str) -> str:
    """name を fmt（gz か bz2）で圧縮して <name>.<fmt> に保存し、その名前を返す。"""
    if fmt not in COMPRESSORS:
        raise ValueError(f"対応していない圧縮形式です: {fmt!r}")
    source = _upload_path(name)
    if not source.is_file():
        raise FileNotFoundError(f"ファイルがありません: {name}")

    target = source.with_name(f"{source.name}.{fmt}")
    try:
        with open(target, "wb") as out:
            subprocess.run(
                [COMPRESSORS[fmt], "-c", "--", str(source)],
                stdout=out,
                check=True,
                timeout=COMPRESS_TIMEOUT_SECONDS,
            )
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return target.name
