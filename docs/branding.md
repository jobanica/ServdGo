# Branding

**ServdGo** — *Pabili • Padala Delivery Services*

> **Carried over from Easy Buy Delivery.** The palette and mark described below
> were sampled from the *old* logo — green circle, purple ring, yellow arched
> wordmark, white scooter/cutlery icon — and are still what the apps render.
> They are a placeholder until the ServdGo logo exists: re-sample from it, then
> update the tokens here **and** the matching `:root` block in
> `apps/admin/src/index.css`, `apps/customer-web/src/index.css` and
> `apps/rider/src/index.css` together.

## Palette

Sampled hex values — **approximate**, and from the previous logo.

| Role | Color | Hex (approx) |
|---|---|---|
| Primary | Green | `#6DBE22` |
| Accent / borders | Purple | `#5E2D91` |
| Highlight / CTA text | Yellow | `#F5E400` |
| Icon / surfaces | White | `#FFFFFF` |
| Text on light | Dark neutral | `#1E1E1E` |

## Direction

- **Green** is the dominant brand color — headers, primary buttons.
- **Purple** for structure/borders and secondary actions.
- **Yellow** reserved for high-emphasis moments (main CTA, promos) — it's loud,
  use sparingly.
- Keep the **scooter/delivery iconography** consistent across all three apps so
  customer / rider / admin feel like one product.

## Proposed design tokens

```css
:root {
  --color-primary:      #6DBE22; /* green  — headers, primary buttons */
  --color-accent:       #5E2D91; /* purple — borders, secondary       */
  --color-highlight:    #F5E400; /* yellow — main CTA, promos          */
  --color-surface:      #FFFFFF;
  --color-text:         #1E1E1E;
}
```

> Re-sample from the source logo PNG before committing these as final tokens.
