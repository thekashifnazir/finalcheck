# FinalCheck — brand spec (from the designer, 13 Oct)

Logo: `logo.png` (1024×341, transparent) — shield with check, wordmark,
tagline "Your AI Agent. Our Fraud Protection."

## Palette

| Token | Hex | Use |
|---|---|---|
| Trust Navy (primary) | `#062B62` | consumer-page base, headings, primary text on light; the "trust" colour |
| Check Blue (primary) | `#1685EE` | links, buttons, interactive accents, info states |
| Safe Mint (secondary) | `#2FC69B` | pass states, receipts verified, "protected" pill — the check in the shield |
| Calm Slate (secondary) | `#496B84` | secondary text, borders, muted labels |

## Applying it to the two screens

- **Screen A (consumer `/`)** — light. White/off-white base, Trust Navy headings,
  Calm Slate body secondary, Check Blue for links/buttons, Safe Mint for pass/ok
  states and the protected badge. Should feel like a calm fintech page, not a SOC.
- **Screen B (ops `/ops`)** — stays dark (projector legibility is the point), but
  tint toward navy: deep desaturated navy background (`#062B62` darkened ~60–70%,
  e.g. `#041A3B`/`#051E44`), Safe Mint for pass verdicts, Check Blue for links/
  tokens. Text stays near-white.
- **Missing from palette — derive, don't improvise:** warning amber and refusal red.
  Nearest sane complements: refusal `#D64545`-family, warning `#E8A33D`-family on dark;
  darken ~15% on light surfaces. Ask the designer if they want named tokens for these.
- Tagline for captions/README: "Your AI Agent. Our Fraud Protection." (logo's own
  line — use it; the longer "last checkpoint before an AI agent spends your money"
  stays as the explainer line.)

## What this means for the build

Stream 3 (surfaces) owns `public/styles.css` — put the four hexes in as CSS variables
(`--navy`, `--blue`, `--mint`, `--slate`) at the top, map existing accent/pass colours
onto them, keep the dark ops theme. Don't redesign mid-hackathon — tokenise and tint.
