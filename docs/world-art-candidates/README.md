# World-art candidates (not runtime defaults)

These snapshots preserve reviewed art work without replacing the live server's
manifest. Do not wire this directory into asset loading or copy a snapshot over
the active world until its remaining integration gates pass.

## Southern pond bank v10

`pond-southern-bank-v10.world-areas.json` is the exact private v10 world-area
snapshot (SHA-256 `438cabb6f34e965b708f0276d050cb2cda222252bdc8412123ee0c7e50e210c3`).
Against private v9 (SHA-256
`fdda05c65a178f3cf6dc9eec5187711c251f77b7ff2c0659f0ccce29fa254e7f`),
only the `haven_pond_floor` radial sector at bearing 1.4 / half-width 0.5 changes
its inner radius from 14.8 to 18.5 metres. All other fields are identical.
This snapshot includes earlier private layout work and is **not** a one-field
patch against the current production manifest. The matching world-config,
resource, station and NPC manifests are still part of the private overlay.

Actual native97/v9 and native98/v10 use the same build48 and four 1280×720
Chrome/Metal WebGPU camera views. Both pass original startup/grass gates with
no reported errors. The landing view loses the sharp diagonal bank/depth wedge;
the overhead pond is rounder and loses some headland character. Retain this as
the next private baseline, not final world-art, traversal, fishing, streaming
or performance approval. Tiny settled-exposure and live wind/particle differences
remain. See the launch checklist and local inland-pond qualification receipts.

The later deck-joint normal trial was rejected for insufficient visible gain;
its source was restored. It is not part of this retained candidate.
