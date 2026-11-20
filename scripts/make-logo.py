"""把书法「伯」字生成 Windows 图标与前端用图。

- desktop/build/icon.ico：多尺寸 ico（electron-builder 会用它做 exe 与安装包图标）
- frontend/public/brand/bole-mark.png：应用内 logo（透明/白底裁切后 512）
- frontend/public/brand/bole-mark-192.png：小尺寸
"""
from pathlib import Path
from PIL import Image

root = Path(r"D:\agent\bole")
source = root / "assets" / "brand" / "bole-mark-calligraphy.png"

img = Image.open(source).convert("RGBA")
print("原图尺寸:", img.size)

# 1) 裁掉四周白边，让字形居中（按非白像素包围盒）
gray = img.convert("L")
mask = gray.point(lambda v: 255 if v < 245 else 0)
bbox = mask.getbbox()
print("包围盒:", bbox)
if bbox:
    # 稍微外扩，避免笔画贴边
    pad = int(min(img.size) * 0.04)
    left = max(0, bbox[0] - pad)
    top = max(0, bbox[1] - pad)
    right = min(img.width, bbox[2] + pad)
    bottom = min(img.height, bbox[3] + pad)
    img = img.crop((left, top, right, bottom))

# 2) 方形补白（保持字形比例）
side = max(img.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)

# 3) 应用内使用：白底转透明，黑字保留
pixels = canvas.load()
for y in range(canvas.height):
    for x in range(canvas.width):
        r, g, b, a = pixels[x, y]
        if r > 245 and g > 245 and b > 245:
            pixels[x, y] = (0, 0, 0, 0)
        else:
            # 笔画压暗，避免灰边
            lum = int(0.299 * r + 0.587 * g + 0.114 * b)
            pixels[x, y] = (0, 0, 0, 255 - min(255, max(0, lum)))

frontend_dir = root / "frontend" / "public" / "brand"
frontend_dir.mkdir(parents=True, exist_ok=True)
for size in (512, 192, 64):
    canvas.resize((size, size), Image.LANCZOS).save(frontend_dir / f"bole-mark{f'' if size == 512 else f'-{size}'}.png")
print("前端 logo 已输出")

# 4) Windows 图标：白底方形（ico 不要透明白底，否则任务栏图标发飘）
white_bg = Image.new("RGBA", canvas.size, (255, 255, 255, 255))
white_bg.paste(canvas, (0, 0), canvas)

build_dir = root / "desktop" / "build"
build_dir.mkdir(parents=True, exist_ok=True)
sizes = [16, 24, 32, 48, 64, 128, 256]
icons = [white_bg.resize((s, s), Image.LANCZOS) for s in sizes]
icons[0].save(build_dir / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes])
white_bg.resize((512, 512), Image.LANCZOS).save(build_dir / "icon.png")
print("icon.ico / icon.png 已输出:", (build_dir / 'icon.ico').stat().st_size, "bytes")
