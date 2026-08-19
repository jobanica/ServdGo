# Branding

**ServdGo** — *Pabili • Padala Delivery Services*

The mark is an orange location pin whose head holds a white plate with a fork,
with three speed lines running into it from the left — the bottom one an arrow
that passes in front of the pin. The wordmark sets **SERVD** in near-black and
**GO** in orange, in a heavy italic condensed sans.

## The source file

`docs/brand/servdgo-mark.svg` is the mark, and every icon in both apps is
derived from it:

```
npx sharp-cli -i docs/brand/servdgo-mark.svg -o apps/customer-web/public/icons \
  resize 1024 1024                       # -> logo-source.png
pip install pillow && python3 scripts/build_icons.py
```

> **The SVG is a redraw, not the original artwork.** It was traced by eye from
> the supplied logo image to unblock the icon pipeline, and it is close but not
> identical — proportions and the corner radii are approximations. If you have
> the original vector or a high-resolution PNG, drop it in as
> `apps/customer-web/public/icons/logo-source.png` (square, transparent) and
> re-run `build_icons.py`; nothing else needs to change. The wordmark's typeface
> is not in the repository at all, so the horizontal lockup has to come from the
> original file.

## Palette

| Role | Colour | Hex | Token |
|---|---|---|---|
| Primary — headers, primary buttons, the mark | Orange | `#E8552F` | `brand-orange` |
| Structure, secondary surfaces, the wordmark's black | Charcoal | `#23262B` | `brand-charcoal` |
| Body text | Dark neutral | `#1E1E1E` | `brand-ink` |
| Surfaces | White | `#FFFFFF` | — |

Supporting shades, used only for gradients and hover states:

| Role | Hex |
|---|---|
| Orange, lighter (gradient top) | `#F2825E` |
| Orange, darker (gradient bottom, chart series) | `#C4451F` |
| Slate (second chart series) | `#5B6270` |
| Page background, warm neutral | `#F8F6F4` |

`brand-yellow` (`#F5E400`) is still defined and still used, but it is **not a
brand colour** — it is the warning/attention tint, always paired with Tailwind's
`text-yellow-800`/`900`. Leave it alone when changing the palette.

## Direction

- **Orange** is the dominant colour — headers, primary buttons, the rider pin on
  a map, the customer hero.
- **Charcoal** carries structure and anything that has to sit against orange:
  secondary buttons, the store pin, the rider app's icon field.
- Keep the **pin-and-fork mark** consistent across all three apps so customer /
  rider / admin read as one product. The rider app is the same mark on charcoal
  with RIDER beneath, so a rider carrying both apps can tell them apart.

## Design tokens

Defined identically in `apps/admin/src/index.css`,
`apps/customer-web/src/index.css` and `apps/rider/src/index.css` — change all
three together.

```css
@theme {
  --color-brand-orange:   #e8552f; /* primary  — headers, primary buttons */
  --color-brand-charcoal: #23262b; /* structure, secondary surfaces       */
  --color-brand-yellow:   #f5e400; /* warning tint, not a brand colour    */
  --color-brand-ink:      #1e1e1e; /* body text                           */
}
```
