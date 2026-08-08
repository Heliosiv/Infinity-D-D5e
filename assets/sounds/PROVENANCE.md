# Sound palette provenance

Infinity D&D5e uses a hybrid sound palette: short recorded CC0 foley takes are
the physical layer, while the project generator adds restrained tonal accents,
space, stereo placement, and mastering. The recorded layer prevents common
menu actions from sounding like repeated oscillator beeps.

## Source boundary

Only the three OpenGameArt packages below are used. Each package's individual
listing identifies it as Creative Commons Zero 1.0 (CC0):

- [10 Book Page Flips](https://opengameart.org/content/10-book-page-flips), by
  StarNinjas.
- [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx),
  by rubberduck.
- [RPG Sound Pack](https://opengameart.org/content/rpg-sound-pack), by
  artisticdude.

CC0 permits copying, modification, and commercial distribution without
required attribution. Credits are retained voluntarily. CC0 supplies no
warranty, and the project does not claim ownership of the source recordings.

No audio from ExpeditionGame's Monument Studios library is used here. That
library is licensed to ExpeditionGame as a separate End Product and is outside
this module's license boundary.

The comments on the metal-and-wood package page question whether some sounds
later appeared in a commercial collection. The OpenGameArt upload predates the
cited commercial listing, but this project's review did not independently
verify the uploader's authorship. The source is therefore retained under the
page's CC0 declaration with that provenance uncertainty recorded here.

## Reproducibility

`foley/manifest.json` records the exact archive URLs, archive sizes and hashes,
selected members and hashes, edit recipe, normalized WAV hashes, and the FFmpeg
version used. The raw third-party archives are not committed. The 14 committed
foley takes are mono 44.1 kHz 16-bit PCM and feed the deterministic renderer in
`scripts/sound-pipeline.mjs`.

The renderer combines different recorded takes for repeated events and writes
the final stereo files in this directory. Run:

```powershell
npm run sound:generate
npm run sound:validate
node scripts/sound-pipeline.mjs preview
```

The preview command writes `output/infinity-dnd5e-sound-preview.wav` for an
ears-on review. Automated signal and hash checks cannot decide whether the mix
feels right in a live Foundry session.
