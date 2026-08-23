#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
料理写真を Web 掲載用に整えるツール。

メニューページ（docs/menu.html）の写真差し替えで使う。
元画像はスマホやカメラで撮った 2〜4MB のものが多く、そのままでは重すぎるので、
正方形に切り出して 1000px / 100〜200KB 程度に落とす。

必要なもの: Pillow（pip install Pillow）

--- 使い方 ---

  # 1. 候補写真を一覧にして、どれを使うか選ぶ
  python tools/prep-photo.py sheet ~/Downloads

  # 2. 選んだ1枚の切り出し位置を見比べる（皿が切れない位置を探す）
  python tools/prep-photo.py try ~/Downloads/IMG_1234.JPG

  # 3. 位置を決めて書き出す
  python tools/prep-photo.py make ~/Downloads/IMG_1234.JPG docs/assets/menu/dessert-flan.jpg --pos 0.45

--- 注意点（過去に踏んだ落とし穴）---

* EXIF の回転指定。スマホ写真はファイルの生データが横長でも、EXIF に
  「表示時は90度回せ」と書かれていることがある。ブラウザはこれに従うので、
  生データの向きで切ると黒帯が出たり回転したりする。
  このスクリプトは常に exif_transpose を通してから処理する。

* 円い皿を真上から撮った写真が多いため、既定の切り出しは正方形。
  横長（3:2）にすると皿の上下が欠ける。
"""

import argparse
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageOps

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

EXTS = (".jpg", ".jpeg", ".png", ".webp")

# ラベルに日本語ファイル名が出るので、日本語が出るフォントを優先して探す
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\meiryob.ttc",
    r"C:\Windows\Fonts\meiryo.ttc",
    r"C:\Windows\Fonts\msgothic.ttc",
    r"C:\Windows\Fonts\arialbd.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def open_upright(path):
    """EXIF の回転指定を反映した、ブラウザで見えるとおりの向きで開く。"""
    return ImageOps.exif_transpose(Image.open(path)).convert("RGB")


def collect(paths):
    """ファイルとフォルダの混在を受け取り、画像ファイルの一覧にする。"""
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += [
                os.path.join(p, n)
                for n in sorted(os.listdir(p))
                if n.lower().endswith(EXTS)
            ]
        elif os.path.isfile(p):
            files.append(p)
    return files


def crop_square(im, pos, ratio):
    """
    指定した縦横比で切り出す。pos は「長い方の軸のどこを中心に取るか」を 0〜1 で指定。
    0 が上（左）端、1 が下（右）端、0.5 で中央。
    """
    w, h = im.size
    if w / h > ratio:  # 横長 → 幅を削る
        nw = int(h * ratio)
        x = int((w - nw) * pos)
        return im.crop((x, 0, x + nw, h))
    else:  # 縦長 → 高さを削る
        nh = int(w / ratio)
        y = int((h - nh) * pos)
        return im.crop((0, y, w, y + nh))


def build_sheet(images, labels, cell, cols, out):
    """サムネイルを格子状に並べた確認用シートを作る。"""
    pad, lbl = 10, 32
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new(
        "RGB", (cols * (cell + pad) + pad, rows * (cell + lbl + pad) + pad), (28, 26, 24)
    )
    draw = ImageDraw.Draw(sheet)
    font = load_font(20)
    for i, (im, label) in enumerate(zip(images, labels)):
        thumb = im.copy()
        thumb.thumbnail((cell, cell))
        c, r = i % cols, i // cols
        x, y = pad + c * (cell + pad), pad + r * (cell + lbl + pad)
        sheet.paste(thumb, (x + (cell - thumb.width) // 2, y + (cell - thumb.height) // 2))
        draw.text((x + 4, y + cell + 6), label, fill=(255, 235, 190), font=font)
    sheet.save(out, quality=90)
    print(f"一覧を書き出しました: {out}  ({sheet.width}x{sheet.height})")


def cmd_sheet(args):
    files = collect(args.paths)
    if not files:
        sys.exit("画像が見つかりません")
    images, labels = [], []
    for i, f in enumerate(files, 1):
        im = open_upright(f)
        images.append(im)
        labels.append(f"[{i}] {os.path.basename(f)}")
        print(f"  [{i}] {os.path.basename(f)}  {im.size[0]}x{im.size[1]}")
    build_sheet(images, labels, args.cell, args.cols, args.out)


def cmd_try(args):
    im = open_upright(args.src)
    print(f"表示上の向き: {im.size[0]}x{im.size[1]}")
    positions = [float(v) for v in args.positions.split(",")]
    images = [crop_square(im, p, args.ratio) for p in positions]
    labels = [f"[{i}] pos={p}" for i, p in enumerate(positions, 1)]
    build_sheet(images, labels, args.cell, len(positions), args.out)
    print("良さそうな pos を選んで make に渡してください")


def cmd_make(args):
    im = open_upright(args.src)
    src_w, src_h = im.size
    cropped = crop_square(im, args.pos, args.ratio)

    if cropped.width < args.size:
        print(
            f"注意: 切り出し後 {cropped.width}px しかなく、{args.size}px へ拡大すると"
            f"画質が落ちます。--size {cropped.width} を検討してください。"
        )

    out_h = round(args.size / args.ratio)
    final = cropped.resize((args.size, out_h), Image.LANCZOS)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    final.save(args.out, "JPEG", quality=args.quality, optimize=True, progressive=True)

    kb = os.path.getsize(args.out) // 1024
    print(f"書き出しました: {args.out}")
    print(f"  元: {src_w}x{src_h} → 出力: {final.width}x{final.height}  {kb} KB")
    if kb > 300:
        print("  注意: 300KB を超えています。--quality を下げるか --size を小さくしてください。")


def main():
    ap = argparse.ArgumentParser(
        description="料理写真を Web 掲載用に整える",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sheet", help="候補写真を一覧にして選ぶ")
    s.add_argument("paths", nargs="+", help="画像ファイルまたはフォルダ")
    s.add_argument("-o", "--out", default="_photo-sheet.jpg")
    s.add_argument("--cell", type=int, default=420)
    s.add_argument("--cols", type=int, default=4)
    s.set_defaults(func=cmd_sheet)

    t = sub.add_parser("try", help="切り出し位置の候補を見比べる")
    t.add_argument("src")
    t.add_argument("--positions", default="0.3,0.45,0.6", help="0〜1 をカンマ区切りで")
    t.add_argument("--ratio", type=float, default=1.0)
    t.add_argument("-o", "--out", default="_crop-try.jpg")
    t.add_argument("--cell", type=int, default=420)
    t.set_defaults(func=cmd_try)

    m = sub.add_parser("make", help="決めた位置で本番用に書き出す")
    m.add_argument("src")
    m.add_argument("out")
    m.add_argument("--pos", type=float, default=0.5, help="切り出し位置 0〜1（既定 0.5）")
    m.add_argument("--ratio", type=float, default=1.0, help="縦横比（既定 1.0＝正方形）")
    m.add_argument("--size", type=int, default=1000, help="出力の幅px（既定 1000）")
    m.add_argument("--quality", type=int, default=82, help="JPEG品質（既定 82）")
    m.set_defaults(func=cmd_make)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
