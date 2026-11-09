"""生成一份「扫描件」PDF：整页是位图，没有文字层。

用途：验证 DocMate 的框选截图 → 发给识图模型这条链路。
真实场景里，扫描版讲义、拍照的板书、PPT 导出图都属于这一类：能看，但划不了词。
"""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "扫描件-电路例题.pdf")

W, H = 1240, 1754  # A4 @150dpi
FONT = r"C:\Windows\Fonts\msyh.ttc"
MONO = r"C:\Windows\Fonts\consola.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def page(lines):
    img = Image.new("RGB", (W, H), (252, 251, 248))
    d = ImageDraw.Draw(img)
    # 轻微纸纹，让它看起来像扫描件
    for y in range(0, H, 4):
        d.line([(0, y), (W, y)], fill=(250, 249, 245))
    y = 110
    for kind, text in lines:
        if kind == "h1":
            d.text((110, y), text, font=font(FONT, 46), fill=(20, 22, 28))
            y += 78
        elif kind == "h2":
            d.text((110, y), text, font=font(FONT, 32), fill=(30, 34, 42))
            y += 56
        elif kind == "p":
            d.text((110, y), text, font=font(FONT, 25), fill=(45, 48, 56))
            y += 42
        elif kind == "f":
            d.text((150, y), text, font=font(MONO, 28), fill=(20, 22, 28))
            y += 50
        elif kind == "box":
            d.rectangle([110, y, W - 110, y + 150], outline=(60, 70, 90), width=2)
            y += 170
    return img


p1 = page([
    ("h1", "第三章  电路的分析方法（扫描件）"),
    ("p", "说明：本页是位图，没有文字层，只能看不能选。"),
    ("h2", "例 3-1  支路电流法"),
    ("p", "图示电路中，已知 E1 = 12 V，E2 = 6 V，"),
    ("p", "R1 = 2 Ω，R2 = 3 Ω，R3 = 6 Ω，求各支路电流。"),
    ("f", "I1 + I2 = I3"),
    ("f", "E1 - I1 R1 - I3 R3 = 0"),
    ("f", "E2 - I2 R2 - I3 R3 = 0"),
    ("h2", "解"),
    ("p", "联立三式，解得："),
    ("f", "I1 = 2 A,  I2 = -2/3 A,  I3 = 4/3 A"),
    ("p", "I2 < 0 说明实际电流方向与所设方向相反。"),
    ("box", ""),
])

p2 = page([
    ("h1", "例 3-2  叠加定理"),
    ("p", "仅保留 E1，把 E2 短路："),
    ("f", "R2 // R3 = 2 Ω,  U' = 12 x 2/(2+2) = 6 V"),
    ("p", "仅保留 E2，把 E1 短路："),
    ("f", "R1 // R3 = 1.5 Ω,  U'' = 6 x 1.5/(3+1.5) = 2 V"),
    ("p", "两次所得参考方向相同，所以："),
    ("f", "U = U' + U'' = 8 V"),
    ("h2", "注意"),
    ("p", "叠加定理只适用于线性电路，且只能叠加电压和电流，"),
    ("p", "不能直接叠加功率。"),
    ("box", ""),
])

p1.save(OUT, "PDF", resolution=150.0, save_all=True, append_images=[p2])
print("wrote", OUT, os.path.getsize(OUT), "bytes")
