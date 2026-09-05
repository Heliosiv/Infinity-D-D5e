# Campaign Atlas UI assets

Created for Infinity D&D5e on 2026-09-04.

- `campaign-atlas-v1.webp`: original artwork generated with the built-in OpenAI
  image-generation tool. The selected 2172 × 724 PNG was encoded as WebP at
  quality 84 without resizing or changing its composition.
- `icons/*.svg`: nine original, editable vector emblems authored for this UI:
  the Infinity compass crest, merchant scales, supply camp, downtime hourglass,
  faction banners, injury treatment cross, loot chest, settings astrolabe, and
  calendar. Each uses a 64 × 64 view box and shared line weights.

All assets are decorative. Visible labels and native buttons carry meaning and
actions; CSS masks inherit foreground colours. Forced-colour mode removes the
map image and renders emblems using system colours. There are no font, network,
or third-party asset dependencies. `styles/atlas.css` owns the presentation and
module-relative asset URLs. The UI harness embeds those same asset bytes so
browser checks see the production art.

## Generation prompt

Use case: stylized-concept. Asset type: original production background artwork
for a dark fantasy tabletop RPG toolkit UI named Infinity. Create a premium
panoramic 3:1 image, ideally 1920x640. An adventurer's campaign atlas on a
midnight blue-black leather desk, antique hand-inked topographic map of a
fantastical coastline with tiny mountains, an elegant aged brass compass and a
dark faceted twenty-sided die with unmarked faces on the far RIGHT, a loosely
coiled fine brass chain and restrained wax seal. Illustrated realism, exquisite
tactile engraved brass, parchment fibers, hand-painted ink with restrained warm
candlelight from outside the frame and subtle cool moonlight. TOP DOWN
composition. Keep left two thirds very dark, simple, and quiet so white text may
be overlaid in code; recognizable map details concentrated on right third. Rich
ink navy and desaturated bronze gold, mature atmospheric fantasy art, not
cartoony, no purple. The full central horizontal band must crop well to a shallow
150px banner. No written text, letters, labels, readable numbers, logos, borders,
mockup UI, or watermark. Produce the artwork only.
