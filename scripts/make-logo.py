"""把书法「伯」字生成应用 logo（透明背景）与 Windows 图标。

输出两套：
- bole-mark*.png        黑墨，用于浅色主题
- bole-mark-invert*.png 白墨，用于暗色主题（同一份 alpha，只换颜色，保证字形完全一致）
"""
from pathlib import Path
from PIL import Image

root = Path(r"D:\agent\bole")
source = root / "assets" / "brand" / "bole-mark-calligraphy.png"

img = Image.open(source).convert("RGBA")
print("原图尺寸:", img.size)

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

side = max(img.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)

src = canvas.load()
black = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
white = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
bp, wp = black.load(), white.load()

for y in range(canvas.height):
    for x in range(canvas.width):
        r, g, b, a = src[x, y]
        if a == 0:
            continue
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum >= 245:
            continue
        ink = min(255, max(0, int(round(255 - lum))))
        bp[x, y] = (0, 0, 0, ink)
        wp[x, y] = (255, 255, 255, ink)

frontend_dir = root / "frontend" / "public" / "brand"
frontend_dir.mkdir(parents=True, exist_ok=True)
for size, suffix in ((512, ""), (192, "-192"), (64, "-64")):
    black.resize((size, size), Image.LANCZOS).save(frontend_dir / f"bole-mark{suffix}.png")
    white.resize((size, size), Image.LANCZOS).save(frontend_dir / f"bole-mark-invert{suffix}.png")

# Windows 图标：白底 + 黑字（浅色任务栏与深色任务栏都能看清）
flat = Image.new("RGBA", black.size, (255, 255, 255, 255))
flat.paste(black, (0, 0), black)
build_dir = root / "desktop" / "build"
build_dir.mkdir(parents=True, exist_ok=True)
base = flat.resize((256, 256), Image.LANCZOS)
base.save(build_dir / "icon.ico", format="ICO",
          sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
base.save(build_dir / "icon.png")

for im, name in ((black, "黑墨"), (white, "白墨")):
    corners = [im.getpixel(p) for p in ((0, 0), (im.width - 1, im.height - 1))]
    assert all(px[3] == 0 for px in corners), f"{name} 四角应透明"
print("logo（黑/白两套）与 ico 已生成")
