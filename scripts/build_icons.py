#!/usr/bin/env python3
"""Build every app icon from the one brand logo.

Source of truth is ``apps/customer-web/public/icons/logo-source.png`` — the
ServdGo pin-and-arrow mark, orange on transparency. Everything else is derived
here, so a new logo means re-running this once rather than hand-editing two
dozen PNGs across two apps.

    pip install pillow && python3 scripts/build_icons.py

To change the logo, replace logo-source.png (square, transparent, ideally 1024px
or larger) and re-run. It is rendered from ``docs/brand/servdgo-mark.svg``:

    npx sharp-cli -i docs/brand/servdgo-mark.svg -o . resize 1024 1024

The customer app keeps the mark on white, as the logo was drawn. The rider app
puts it on brand charcoal with RIDER beneath, so a rider carrying both apps can
tell them apart on the home screen. Below 96px the wordmark is dropped — it
would be an unreadable smudge, and the charcoal field already distinguishes it.
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'apps/customer-web/public/icons/logo-source.png')
CUSTOMER_ICONS = os.path.join(ROOT, 'apps/customer-web/public/icons')
CUSTOMER_PUBLIC = os.path.join(ROOT, 'apps/customer-web/public')
RIDER_RES = os.path.join(ROOT, 'apps/rider/android/app/src/main/res')
CUSTOMER_RES = os.path.join(ROOT, 'apps/customer-web/android/app/src/main/res')
# Committed, not built into an app: these are uploaded by hand to Play Console.
OUT_STORE = os.path.join(ROOT, 'docs/store-assets')

WHITE = (255, 255, 255, 255)
CHARCOAL = (35, 38, 43, 255)   # brand-charcoal, the wordmark's black
ORANGE = (232, 85, 47, 255)    # brand-orange, the mark's colour

# Anti-aliasing: masks and text are drawn at this multiple, then downsampled.
SS = 4


def load_mark() -> Image.Image:
    """The mark, trimmed to its artwork and padded back out to a square.

    The source is drawn on transparency, so the bounding box of the alpha
    channel is the artwork — no colour-key guessing, and no assumption that the
    file was exported with even margins.
    """
    im = Image.open(SOURCE).convert('RGBA')
    box = im.getchannel('A').getbbox()
    if box is None:
        raise SystemExit(f'{SOURCE} is fully transparent')
    art = im.crop(box)

    side = max(art.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.alpha_composite(art, ((side - art.width) // 2, (side - art.height) // 2))
    return square


MARK = load_mark()


def font(px: int):
    for path in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                 '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
                 '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'):
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    return ImageFont.load_default()


def tile(size: int, *, bg, shape: str, badge_ratio: float, label: str | None = None,
         label_colour=ORANGE) -> Image.Image:
    """One icon: a background shape, the mark, and an optional wordmark under it.

    ``badge_ratio`` is the mark's width as a fraction of the icon — the lever
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

    img.alpha_composite(MARK.resize((bw, bw), Image.LANCZOS), (int((size - bw) / 2), top))

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
# The mark on transparency, for in-app use where the surface is already coloured
# (the welcome medallion, the sign-in header) — a white-backed icon would show
# its square corners there.
save(tile(512, bg=None, shape='square', badge_ratio=1.0), f'{CUSTOMER_ICONS}/mark-512.png')

DENSITIES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}

print('customer android launcher')
# The mark on white, as the logo was drawn — the customer app carries no label.
for name, px in DENSITIES.items():
    out = f'{CUSTOMER_RES}/mipmap-{name}'
    save(tile(px, bg=WHITE, shape='rounded', badge_ratio=0.88), f'{out}/ic_launcher.png')
    save(tile(px, bg=WHITE, shape='circle', badge_ratio=0.80), f'{out}/ic_launcher_round.png')
    fg = int(px * 108 / 48)
    save(tile(fg, bg=None, shape='square', badge_ratio=0.56), f'{out}/ic_launcher_foreground.png')

print('rider app')
for name, px in DENSITIES.items():
    out = f'{RIDER_RES}/mipmap-{name}'
    save(tile(px, bg=CHARCOAL, shape='rounded', badge_ratio=0.72, label='RIDER'),
         f'{out}/ic_launcher.png')
    save(tile(px, bg=CHARCOAL, shape='circle', badge_ratio=0.66, label='RIDER'),
         f'{out}/ic_launcher_round.png')
    # Adaptive foreground: a 108dp canvas whose middle 66% is all that's safe.
    fg = int(px * 108 / 48)
    save(tile(fg, bg=None, shape='square', badge_ratio=0.46, label='RIDER'),
         f'{out}/ic_launcher_foreground.png')

print('splashes')
import glob  # noqa: E402 — only needed for the splash sweep
# The customer splash is the mark on white; the rider's is charcoal with RIDER.
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
    canvas = Image.new('RGBA', (w, h), CHARCOAL)
    short = min(w, h)
    art = tile(int(short * 0.5), bg=None, shape='square', badge_ratio=0.78,
               label='RIDER')
    canvas.alpha_composite(art, (int((w - art.width) / 2), int((h - art.height) / 2)))
    canvas.convert('RGB').save(path)
print('  ', len(glob.glob(f'{RIDER_RES}/drawable*/splash.png')), 'splash images')

print('play store listing icons (512x512, no transparency)')
save(tile(512, bg=WHITE, shape='square', badge_ratio=0.96),
     f'{OUT_STORE}/customer-play-512.png', flatten=(255, 255, 255))
save(tile(512, bg=CHARCOAL, shape='square', badge_ratio=0.72, label='RIDER'),
     f'{OUT_STORE}/rider-play-512.png', flatten=(35, 38, 43))
print('done')
