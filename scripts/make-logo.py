"""把书法「伯」字生成应用 logo（透明背景）与 Windows 图标。

关键：alpha 只由「墨量」决定——
- 原图完全透明的地方保持透明
- 接近纯白的地方透明
- 笔画按亮度压成纯黑，alpha = 255 - 亮度（保留笔锋的浓淡）
"""
from pathlib import Path
from PIL import Image

root = Path(r"D:\agent\bole")
source = root / "assets" / "brand" / "bole-mark-calligraphy.png"

img = Image.open(source).convert("RGBA")
print("原图尺寸:", img.size)

# 1) 按非白像素找包围盒（只考虑 alpha>0 且不是纯白）
gray = img.convert("L")
mask = gray.point(lambda v: 255 if v < 245 else 0)
bbox = mask.getbbox()
print("包围盒:", bbox)
if bbox:
    pad = int(min(img.size) * 0.05)
    img = img.crop((
        max(0, bbox[0] - pad), max(0, bbox[1] - pad),
        min(img.width, bbox[2] + pad), min(img.height, bbox[3] + pad),
    ))

# 2) 方形画布（透明）
side = max(img.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)

# 3) 重算 alpha：透明保持透明，白底透明，笔画纯黑
src = canvas.load()
out = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
dst = out.load()
for y in range(canvas.height):
    for x in range(canvas.width):
        r, g, b, a = src[x, y]
        if a == 0:
            continue  # 原本就透明
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum >= 245:
            continue  # 白底 → 透明
        ink = int(round(255 - lum))
        dst[x, y] = (0, 0, 0, min(255, max(0, ink)))

frontend_dir = root / "frontend" / "public" / "brand"
frontend_dir.mkdir(parents=True, exist_ok=True)
for size, name in ((512, "bole-mark.png"), (192, "bole-mark-192.png"), (64, "bole-mark-64.png")):
    out.resize((size, size), Image.LANCZOS).save(frontend_dir / name)

build_dir = root / "desktop" / "build"
build_dir.mkdir(parents=True, exist_ok=True)
base = out.resize((256, 256), Image.LANCZOS)
base.save(
    build_dir / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
base.save(build_dir / "icon.png")

# 自检：四角必须透明
corners = [out.getpixel(p) for p in ((0, 0), (out.width - 1, 0), (0, out.height - 1), (out.width - 1, out.height - 1))]
print("四角像素:", corners)
assert all(px[3] == 0 for px in corners), "四角应当透明"
print("logo 与 ico 已生成（透明背景）")
