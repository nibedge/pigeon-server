#!/usr/bin/env python3
"""
从 App 图标生成站点图标，写进 src/icon.ts（base64 内嵌）。

Worker 没有静态资源管线，图标直接嵌进代码；32px 用于标签页，180px 用于
iOS「添加到主屏幕」。四角套 iOS 风格圆角并透明，这样在标签页里不是一块方砖。

改完 App 图标后重跑：  python3 scripts/make_favicon.py
"""
import base64
import pathlib
from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent.parent
SRC = HERE.parent / "ios/Pigeon/Assets.xcassets/AppIcon.appiconset/icon-1024.png"

def render(src: Image.Image, size: int) -> bytes:
    im = src.resize((size * 4, size * 4), Image.LANCZOS)
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, im.size[0] - 1, im.size[1] - 1], radius=int(im.size[0] * 0.22), fill=255)
    im.putalpha(mask)
    tmp = pathlib.Path(f"/tmp/_favicon_{size}.png")
    im.resize((size, size), Image.LANCZOS).save(tmp, optimize=True)
    return tmp.read_bytes()

def main() -> None:
    src = Image.open(SRC).convert("RGB")
    b32, b180 = render(src, 32), render(src, 180)
    print(f"  32x32 {len(b32)} 字节 / 180x180 {len(b180)} 字节")
    mod = (HERE / "src/icon.ts").read_text()
    import re
    mod = re.sub(r'const B32 =\n  "[^"]*";',
                 'const B32 =\n  "%s";' % base64.b64encode(b32).decode(), mod)
    mod = re.sub(r'const B180 =\n  "[^"]*";',
                 'const B180 =\n  "%s";' % base64.b64encode(b180).decode(), mod)
    (HERE / "src/icon.ts").write_text(mod)
    print("  ✓ src/icon.ts 已更新")

if __name__ == "__main__":
    main()
