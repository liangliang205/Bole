"""修正 ico 生成：Pillow 要求基准图不小于最大尺寸。"""
from pathlib import Path
from PIL import Image

root = Path(r"D:\agent\bole")
build = root / "desktop" / "build"
img = Image.open(build / "icon-source.png").convert("RGBA")

# 与生成 logo 相同的裁切逻辑
gray = img.convert("L")
mask = gray.point(lambda v: 255 if v < 245 else 0)
bbox = mask.getbbox()
if bbox:
    pad = int(min(img.size) * 0.04)
    img = img.crop((
        max(0, bbox[0] - pad), max(0, bbox[1] - pad),
        min(img.width, bbox[2] + pad), min(img.height, bbox[3] + pad),
    ))

side = max(img.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)

# 白底方形（Windows 图标不要透明底）
white = Image.new("RGBA", canvas.size, (255, 255, 255, 255))
white.paste(canvas, (0, 0), canvas)
base = white.resize((256, 256), Image.LANCZOS)

base.save(
    build / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
base.save(build / "icon.png")
print("icon.ico:", (build / "icon.ico").stat().st_size, "bytes")
print("icon.png:", (build / "icon.png").stat().st_size, "bytes")
