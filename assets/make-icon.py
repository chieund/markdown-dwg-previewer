#!/usr/bin/env python3
"""
Sinh icon.png cho extension DWG Previewer.

    python3 assets/make-icon.py

Vẽ ở độ phân giải gấp 4 lần rồi thu nhỏ bằng LANCZOS để cạnh mượt.
Motif: một mặt bằng hình chữ L kiểu bản vẽ kỹ thuật, kèm đường kích thước —
đọc được cả ở 32px trên thanh sidebar của VS Code.
"""
from PIL import Image, ImageDraw

OUT = 256          # kích thước icon xuất ra
SS = 4             # hệ số supersampling
S = OUT * SS

# Bảng màu — nền tối hợp cả theme sáng lẫn tối của VS Code
BG_TOP = (30, 42, 56)       # #1E2A38
BG_BOTTOM = (14, 22, 32)    # #0E1620
GRID = (44, 62, 80)         # #2C3E50
PLAN = (79, 195, 247)       # #4FC3F7  cyan — nét chính
PLAN_FILL = (79, 195, 247, 30)
DETAIL = (232, 238, 244)    # #E8EEF4  gần trắng — chi tiết tròn
DIM = (240, 180, 41)        # #F0B429  hổ phách — đường kích thước


def px(v):
    """Đổi toạ độ trong hệ 256 sang hệ đã supersample."""
    return v * SS


def rounded_mask(size, radius):
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    grad = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / (size - 1)
        grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return grad.resize((size, size), Image.Resampling.BILINEAR)


# ── Nền ────────────────────────────────────────────────────────────────────
base = vertical_gradient(S, BG_TOP, BG_BOTTOM).convert('RGBA')
base.putalpha(rounded_mask(S, px(56)))

# ── Lưới blueprint ─────────────────────────────────────────────────────────
grid = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grid)
for i in range(1, 8):
    p = px(i * 32)
    gd.line([(p, 0), (p, S)], fill=GRID + (70,), width=max(1, SS // 2))
    gd.line([(0, p), (S, p)], fill=GRID + (70,), width=max(1, SS // 2))
grid.putalpha(Image.composite(grid.getchannel('A'), Image.new('L', (S, S), 0), rounded_mask(S, px(56))))
base = Image.alpha_composite(base, grid)

# ── Nét vẽ ─────────────────────────────────────────────────────────────────
art = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(art)

# Mặt bằng hình chữ L — góc khuyết đủ lớn để còn nhận ra ở 32px
LEFT, RIGHT, TOP, BOT = 44, 212, 56, 158
NOTCH_X, NOTCH_Y = 120, 104
plan = [(LEFT, BOT), (LEFT, TOP), (NOTCH_X, TOP), (NOTCH_X, NOTCH_Y), (RIGHT, NOTCH_Y), (RIGHT, BOT)]
d.polygon([(px(x), px(y)) for x, y in plan], fill=PLAN_FILL, outline=PLAN, width=px(11))

# Hình tròn chi tiết (cột / lỗ khoan) trong cánh phải
cx, cy, r = 176, 131, 17
d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], outline=DETAIL, width=px(8))

# Đường kích thước: extension line kéo từ bản vẽ xuống, rồi tới dimension line
dim_y, ext_top, ext_bot = 188, 166, 196
for x in (LEFT, RIGHT):
    d.line([(px(x), px(ext_top)), (px(x), px(ext_bot))], fill=DIM + (150,), width=px(4))
d.line([(px(LEFT), px(dim_y)), (px(RIGHT), px(dim_y))], fill=DIM, width=px(7))
# Gạch chéo 45° ở hai đầu — ký hiệu kích thước kiểu kiến trúc
for x in (LEFT, RIGHT):
    d.line([(px(x - 7), px(dim_y + 7)), (px(x + 7), px(dim_y - 7))], fill=DIM, width=px(6))

base = Image.alpha_composite(base, art)

icon = base.resize((OUT, OUT), Image.Resampling.LANCZOS)
icon.save('icon.png', 'PNG', optimize=True)
print(f'icon.png  {OUT}x{OUT}')

# Bản xem thử ở kích thước hiển thị thật trên sidebar
for size in (32, 64):
    icon.resize((size, size), Image.Resampling.LANCZOS).save(f'assets/preview-{size}.png')
    print(f'assets/preview-{size}.png')
