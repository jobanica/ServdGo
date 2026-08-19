#!/usr/bin/env python3
"""Build every app icon from the one brand logo.

Source of truth is ``apps/customer-web/public/icons/logo-source.jpg`` — the
circular badge as supplied. Everything else is derived here, so a new logo means
re-running this once rather than hand-editing two dozen PNGs across two apps.

    pip install pillow && python3 scripts/build_icons.py

The customer app keeps the badge on white, as the logo was drawn. The rider app
puts it on brand purple with RIDER beneath, so a rider carrying both apps can
tell them apart on the home screen. Below 96px the wordmark is dropped — it
would be an unreadable smudge, and the purple field already distinguishes it.
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'apps/customer-web/public/icons/logo-source.jpg')
CUSTOMER_ICONS = os.path.join(ROOT, 'apps/customer-web/public/icons')
CUSTOMER_PUBLIC = os.path.join(ROOT, 'apps/customer-web/public')
RIDER_RES = os.path.join(ROOT, 'apps/rider/android/app/src/main/res')
CUSTOMER_RES = os.path.join(ROOT, 'apps/customer-web/android/app/src/main/res')
# Committed, not built into an app: these are uploaded by hand to Play Console.
OUT_STORE = os.path.join(ROOT, 'docs/store-assets')

WHITE = (255, 255, 255, 255)
PURPLE = (94, 45, 145, 255)
YELLOW = (247, 199, 33, 255)

# Anti-aliasing: masks and text are drawn at this multiple, then downsampled.
SS = 4


def load_badge() -> Image.Image:
    """The badge, cut out of its sheet with a clean anti-aliased circular edge."""
    im = Image.open(SOURCE).convert('RGB')
    w, h = im.size
    px = im.load()

    # Find the circle by scanning the middle row and column for ink, rather than
    # trusting the sheet's margins to be even.
    ink = lambda p: sum(p) < 700  # noqa: E731 — anything that isn't the white sheet
    row = [x for x in range(w) if ink(px[x, h // 2])]
    col = [y for y in range(h) if ink(px[w // 2, y])]
    cx, cy = (row[0] + row[-1]) / 2, (col[0] + col[-1]) / 2
    # Pull in a hair: JPEG ringing leaves a pale halo right on the outer edge.
    r = min(row[-1] - row[0], col[-1] - col[0]) / 2 - 1

    size = int(r * 2)
    box = (int(cx - r), int(cy - r), int(cx - r) + size, int(cy - r) + size)
    cropped = im.crop(box).convert('RGBA')

    mask = Image.new('L', (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size * SS - 1, size * SS - 1], fill=255)
    cropped.putalpha(mask.resize((size, size), Image.LANCZOS))
    return cropped


BADGE = load_badge()


def font(px: int):
    for path in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                 '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
                 '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'):
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    return ImageFont.load_default()


def tile(size: int, *, bg, shape: str, badge_ratio: float, label: str | None = None,
         label_colour=YELLOW) -> Image.Image:
    """One icon: a background shape, the badge, and an optional wordmark under it.

    ``badge_ratio`` is the badge's diameter as a fraction of the icon — the lever
    that keeps artwork inside a maskable icon's safe zone or an adaptive icon's
    inner 66%.
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    if bg is not None:
        layer = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        if shape == 'circle':
            d.ellipse([0, 0, size * SS - 1, size * SS - 1], fill=bg)
        elif shape == 'rounded':
            d.rounded_rectangle([0, 0, size * SS - 1, size * SS - 1],
                                radius=int(size * SS * 0.22), fill=bg)
        else:
            d.rectangle([0, 0, size * SS - 1, size * SS - 1], fill=bg)
        img.alpha_composite(layer.resize((size, size), Image.LANCZOS))

    # A wordmark only earns its place when it can actually be read.
    label = label if (label and size >= 96) else None

    d = ImageDraw.Draw(img)
    bw = int(size * badge_ratio)
    f = font(max(9, int(size * 0.15))) if label else None
    text_h = 0
    if label:
        tb = d.textbbox((0, 0), label, font=f)
        text_h = tb[3] - tb[1]
    gap = int(size * 0.035) if label else 0
    top = int((size - (bw + gap + text_h)) / 2)

    img.alpha_composite(BADGE.resize((bw, bw), Image.LANCZOS), (int((size - bw) / 2), top))

    if label:
        tb = d.textbbox((0, 0), label, font=f)
        d.text(((size - (tb[2] - tb[0])) / 2 - tb[0], top + bw + gap - tb[1]),
               label, font=f, fill=label_colour)
    return img


def save(img: Image.Image, path: str, *, flatten=None) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if flatten:
        base = Image.new('RGB', img.size, flatten)
        base.paste(img, mask=img.split()[3])
        base.save(path)
    else:
        img.save(path)
    print('  ', os.path.relpath(path, ROOT))


print('customer app')
# Full-bleed square: Android and iOS apply their own rounding to these.
save(tile(192, bg=WHITE, shape='square', badge_ratio=0.96), f'{CUSTOMER_ICONS}/pwa-192x192.png')
save(tile(512, bg=WHITE, shape='square', badge_ratio=0.96), f'{CUSTOMER_ICONS}/pwa-512x512.png')
# Maskable: the launcher may crop to a circle of 80% — keep everything inside it.
save(tile(512, bg=WHITE, shape='square', badge_ratio=0.76), f'{CUSTOMER_ICONS}/maskable-512x512.png')
save(tile(180, bg=WHITE, shape='square', badge_ratio=0.96), f'{CUSTOMER_ICONS}/apple-touch-icon.png')
save(tile(64, bg=None, shape='square', badge_ratio=1.0), f'{CUSTOMER_PUBLIC}/favicon.png')

DENSITIES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}

print('customer android launcher')
# The badge on white, as the logo was drawn — the customer app carries no label.
for name, px in DENSITIES.items():
    out = f'{CUSTOMER_RES}/mipmap-{name}'
    save(tile(px, bg=WHITE, shape='rounded', badge_ratio=0.88), f'{out}/ic_launcher.png')
    save(tile(px, bg=WHITE, shape='circle', badge_ratio=0.80), f'{out}/ic_launcher_round.png')
    fg = int(px * 108 / 48)
    save(tile(fg, bg=None, shape='square', badge_ratio=0.56), f'{out}/ic_launcher_foreground.png')

print('rider app')
for name, px in DENSITIES.items():
    out = f'{RIDER_RES}/mipmap-{name}'
    save(tile(px, bg=PURPLE, shape='rounded', badge_ratio=0.72, label='RIDER'),
         f'{out}/ic_launcher.png')
    save(tile(px, bg=PURPLE, shape='circle', badge_ratio=0.66, label='RIDER'),
         f'{out}/ic_launcher_round.png')
    # Adaptive foreground: a 108dp canvas whose middle 66% is all that's safe.
    fg = int(px * 108 / 48)
    save(tile(fg, bg=None, shape='square', badge_ratio=0.46, label='RIDER'),
         f'{out}/ic_launcher_foreground.png')

print('splashes')
import glob  # noqa: E402 — only needed for the splash sweep
# The customer splash is the badge on white; the rider's is purple with RIDER.
for path in glob.glob(f'{CUSTOMER_RES}/drawable*/splash.png'):
    w, h = Image.open(path).size
    canvas = Image.new('RGBA', (w, h), WHITE)
    short = min(w, h)
    art = tile(int(short * 0.5), bg=None, shape='square', badge_ratio=0.92)
    canvas.alpha_composite(art, (int((w - art.width) / 2), int((h - art.height) / 2)))
    canvas.convert('RGB').save(path)
print('  ', len(glob.glob(f'{CUSTOMER_RES}/drawable*/splash.png')), 'customer splash images')

for path in glob.glob(f'{RIDER_RES}/drawable*/splash.png'):
    w, h = Image.open(path).size
    canvas = Image.new('RGBA', (w, h), PURPLE)
    short = min(w, h)
    art = tile(int(short * 0.5), bg=None, shape='square', badge_ratio=0.78,
               label='RIDER', label_colour=YELLOW)
    canvas.alpha_composite(art, (int((w - art.width) / 2), int((h - art.height) / 2)))
    canvas.convert('RGB').save(path)
print('  ', len(glob.glob(f'{RIDER_RES}/drawable*/splash.png')), 'splash images')

print('play store listing icons (512x512, no transparency)')
save(tile(512, bg=WHITE, shape='square', badge_ratio=0.96),
     f'{OUT_STORE}/customer-play-512.png', flatten=(255, 255, 255))
save(tile(512, bg=PURPLE, shape='square', badge_ratio=0.72, label='RIDER'),
     f'{OUT_STORE}/rider-play-512.png', flatten=(94, 45, 145))
print('done')
