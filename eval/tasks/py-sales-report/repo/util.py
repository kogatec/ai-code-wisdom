def format_yen(amount):
    """円の金額を 3 桁区切りの文字列にする（例：12345 → "12,345円"）。"""
    return f"{amount:,}円"
