#!/usr/bin/env python3
"""
Sinh icon.png cho extension DWG Previewer.

    python3 assets/make-icon.py

Drawn at 4x resolution, then downscaled with LANCZOS for smooth edges.
Motif: an L-shaped floor plan in technical-drawing style, with a dimension line —
legible even at 32px in the VS Code sidebar.
"""
from PIL import Image, ImageDraw

OUT = 256          # output icon size
SS = 4             # supersampling factor
S = OUT * SS

# Palette — a dark background that suits both light and dark VS Code themes
BG_TOP = (30, 42, 56)       # #1E2A38
BG_BOTTOM = (14, 22, 32)    # #0E1620
GRID = (44, 62, 80)         # #2C3E50
PLAN = (79, 195, 247)       # #4FC3F7  cyan — main lines
PLAN_FILL = (79, 195, 247, 30)
DETAIL = (232, 238, 244)    # #E8EEF4  near white — round detail
DIM = (240, 180, 41)        # #F0B429  amber — dimension line


def px(v):
    """Converts 256-unit coordinates to the supersampled grid."""
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


# ── Background ───────────────────────────────────────────────────────────────
base = vertical_gradient(S, BG_TOP, BG_BOTTOM).convert('RGBA')
base.putalpha(rounded_mask(S, px(56)))

# ── Blueprint grid ───────────────────────────────────────────────────────────
grid = Image.new('RGBA', (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(grid)
for i in range(1, 8):
    p = px(i * 32)
    gd.line([(p, 0), (p, S)], fill=GRID + (70,), width=max(1, SS // 2))
    gd.line([(0, p), (S, p)], fill=GRID + (70,), width=max(1, SS // 2))
grid.putalpha(Image.composite(grid.getchannel('A'), Image.new('L', (S, S), 0), rounded_mask(S, px(56))))
base = Image.alpha_composite(base, grid)

# ── Linework ─────────────────────────────────────────────────────────────────
art = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(art)

# L-shaped plan — the notch is large enough to read at 32px
LEFT, RIGHT, TOP, BOT = 44, 212, 56, 158
NOTCH_X, NOTCH_Y = 120, 104
plan = [(LEFT, BOT), (LEFT, TOP), (NOTCH_X, TOP), (NOTCH_X, NOTCH_Y), (RIGHT, NOTCH_Y), (RIGHT, BOT)]
d.polygon([(px(x), px(y)) for x, y in plan], fill=PLAN_FILL, outline=PLAN, width=px(11))

# Detail circle (column / drill hole) in the right wing
cx, cy, r = 176, 131, 17
d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], outline=DETAIL, width=px(8))

# Dimension: extension lines drop from the plan, then the dimension line
dim_y, ext_top, ext_bot = 188, 166, 196
for x in (LEFT, RIGHT):
    d.line([(px(x), px(ext_top)), (px(x), px(ext_bot))], fill=DIM + (150,), width=px(4))
d.line([(px(LEFT), px(dim_y)), (px(RIGHT), px(dim_y))], fill=DIM, width=px(7))
# 45° ticks at both ends — architectural dimension style
for x in (LEFT, RIGHT):
    d.line([(px(x - 7), px(dim_y + 7)), (px(x + 7), px(dim_y - 7))], fill=DIM, width=px(6))

base = Image.alpha_composite(base, art)

icon = base.resize((OUT, OUT), Image.Resampling.LANCZOS)
icon.save('icon.png', 'PNG', optimize=True)
print(f'icon.png  {OUT}x{OUT}')

# Previews at the real sidebar display sizes
for size in (32, 64):
    icon.resize((size, size), Image.Resampling.LANCZOS).save(f'assets/preview-{size}.png')
    print(f'assets/preview-{size}.png')
