#!/usr/bin/env python3
"""
Sinh icon.png cho extension DWG Previewer.

    python3 assets/make-icon.py

Drawn at 4x resolution, then downscaled with LANCZOS for smooth edges.
Motif: a CAD crosshair snapping to the corner of an L-shaped floor plan, with a
door swing and an overall dimension with extension lines.
"""
from PIL import Image, ImageDraw

OUT = 256          # output icon size
SS = 4             # supersampling factor
S = OUT * SS

# Palette — a dark background that suits both light and dark VS Code themes
BG_TOP = (30, 42, 56)       # #1E2A38
BG_BOTTOM = (14, 22, 32)    # #0E1620
PLAN = (79, 195, 247)       # #4FC3F7  cyan — walls
PLAN_FILL = PLAN + (34,)
DETAIL = (232, 238, 244)    # #E8EEF4  near white — crosshair and door
DIM = (240, 180, 41)        # #F0B429  amber — osnap marker and dimension

WALL = 8
CROSS = 4


def px(v):
    """Converts 256-unit coordinates to the supersampled grid."""
    return round(v * SS)


def pts(points):
    return [(px(x), px(y)) for x, y in points]


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
mask = rounded_mask(S, px(56))
base = vertical_gradient(S, BG_TOP, BG_BOTTOM).convert('RGBA')
base.putalpha(mask)

art = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(art)

# ── Plan ─────────────────────────────────────────────────────────────────────
# The crosshair sits on the tile centre, at the room's outer top-right corner
CX, CY = 128, 100
LEFT, RIGHT, BOT = 56, 200, 180
WING_Y = 128       # top of the right wing
plan = [(LEFT, CY), (CX, CY), (CX, WING_Y), (RIGHT, WING_Y), (RIGHT, BOT), (LEFT, BOT)]
d.polygon(pts(plan), fill=PLAN_FILL)
d.line(pts(plan + [plan[0]]), fill=PLAN, width=px(WALL), joint='curve')

# Door in the left wall: opening cleared, hinged at the lower jamb, leaf swung into the room
DOOR_X, DOOR_TOP, HINGE = LEFT, 124, 156   # centred in the left wall, 24 of wall each side
leaf = HINGE - DOOR_TOP
d.rectangle(pts([(DOOR_X - WALL / 2 - 1, DOOR_TOP), (DOOR_X + WALL / 2 + 1, HINGE)]), fill=(0, 0, 0, 0))
d.line(pts([(DOOR_X, HINGE), (DOOR_X + leaf, HINGE)]), fill=DETAIL, width=px(5))
d.arc(pts([(DOOR_X - leaf, HINGE - leaf), (DOOR_X + leaf, HINGE + leaf)]), 270, 360, fill=DETAIL + (190,), width=px(3))

# ── Crosshair and endpoint osnap marker ──────────────────────────────────────
# Drawn over the walls, as in CAD: where an arm runs along a wall it tracks it
ARM, GAP, MARK = 56, 22, 14
for (ax, ay), (bx, by) in (((-ARM, 0), (-GAP, 0)), ((GAP, 0), (ARM, 0)),
                           ((0, -ARM), (0, -GAP)), ((0, GAP), (0, ARM))):
    d.line(pts([(CX + ax, CY + ay), (CX + bx, CY + by)]), fill=DETAIL, width=px(CROSS))
d.rectangle(pts([(CX - MARK - 2, CY - MARK - 2), (CX + MARK + 2, CY + MARK + 2)]), outline=BG_BOTTOM, width=px(9))
d.rectangle(pts([(CX - MARK, CY - MARK), (CX + MARK, CY + MARK)]), outline=DIM, width=px(5))

# ── Dimension: extension lines from just off the wall, then the dimension line ──
dim_y = BOT + 26
for x in (LEFT, RIGHT):
    d.line(pts([(x, BOT + 9), (x, BOT + 33)]), fill=DIM, width=px(4))
d.line(pts([(LEFT, dim_y), (RIGHT, dim_y)]), fill=DIM, width=px(5))
# 45° ticks at both ends — architectural dimension style
for x in (LEFT, RIGHT):
    d.line(pts([(x - 8, dim_y + 8), (x + 8, dim_y - 8)]), fill=DIM, width=px(5))

base = Image.alpha_composite(base, art)
base.putalpha(Image.composite(base.getchannel('A'), Image.new('L', (S, S), 0), mask))

icon = base.resize((OUT, OUT), Image.Resampling.LANCZOS)
icon.save('icon.png', 'PNG', optimize=True)
print(f'icon.png  {OUT}x{OUT}')

# ── Vector source: the same geometry as icon.svg ─────────────────────────────
# The Marketplace only accepts a PNG `icon`, so package.json keeps icon.png.
# PIL draws a rectangle outline inside its box; the SVG strokes are centred to match.
def rgb(c):
    return '#%02X%02X%02X' % c[:3]


halo_c, mark_c = MARK + 2 - 9 / 2, MARK - 5 / 2
arms = ''.join(
    f'<line x1="{CX + ax}" y1="{CY + ay}" x2="{CX + bx}" y2="{CY + by}"/>'
    for (ax, ay), (bx, by) in (((-ARM, 0), (-GAP, 0)), ((GAP, 0), (ARM, 0)),
                               ((0, -ARM), (0, -GAP)), ((0, GAP), (0, ARM))))
walls = f'M{DOOR_X} {DOOR_TOP} ' + ' '.join(f'L{x} {y}' for x, y in plan) + f' L{DOOR_X} {HINGE}'
ticks = ''.join(f'<line x1="{x - 8}" y1="{dim_y + 8}" x2="{x + 8}" y2="{dim_y - 8}"/>' for x in (LEFT, RIGHT))
exts = ''.join(f'<line x1="{x}" y1="{BOT + 9}" x2="{x}" y2="{BOT + 33}"/>' for x in (LEFT, RIGHT))
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{OUT}" height="{OUT}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{rgb(BG_TOP)}"/>
      <stop offset="1" stop-color="{rgb(BG_BOTTOM)}"/>
    </linearGradient>
    <clipPath id="tile"><rect width="256" height="256" rx="56"/></clipPath>
  </defs>
  <g clip-path="url(#tile)" fill="none" stroke-linecap="butt">
    <rect width="256" height="256" fill="url(#bg)"/>
    <polygon points="{' '.join(f'{x},{y}' for x, y in plan)}" fill="{rgb(PLAN)}" fill-opacity="{PLAN_FILL[3] / 255:.3f}"/>
    <path d="{walls}" stroke="{rgb(PLAN)}" stroke-width="{WALL}" stroke-linejoin="round"/>
    <line x1="{DOOR_X}" y1="{HINGE}" x2="{DOOR_X + leaf}" y2="{HINGE}" stroke="{rgb(DETAIL)}" stroke-width="5"/>
    <path d="M{DOOR_X} {DOOR_TOP} A{leaf} {leaf} 0 0 1 {DOOR_X + leaf} {HINGE}" stroke="{rgb(DETAIL)}" stroke-opacity="{190 / 255:.3f}" stroke-width="3"/>
    <g stroke="{rgb(DETAIL)}" stroke-width="{CROSS}">{arms}</g>
    <rect x="{CX - halo_c}" y="{CY - halo_c}" width="{2 * halo_c}" height="{2 * halo_c}" stroke="{rgb(BG_BOTTOM)}" stroke-width="9"/>
    <rect x="{CX - mark_c}" y="{CY - mark_c}" width="{2 * mark_c}" height="{2 * mark_c}" stroke="{rgb(DIM)}" stroke-width="5"/>
    <g stroke="{rgb(DIM)}">
      <g stroke-width="4">{exts}</g>
      <g stroke-width="5"><line x1="{LEFT}" y1="{dim_y}" x2="{RIGHT}" y2="{dim_y}"/>{ticks}</g>
    </g>
  </g>
</svg>
'''
with open('icon.svg', 'w') as f:
    f.write(svg)
print('icon.svg')

# Previews at the real sidebar display sizes
for size in (32, 64):
    icon.resize((size, size), Image.Resampling.LANCZOS).save(f'assets/preview-{size}.png')
    print(f'assets/preview-{size}.png')
