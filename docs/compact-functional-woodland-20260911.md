# Compact functional woodland qualification

## Intended visible change

Add a first, bounded woodland layer around the preparation campus and one duel
arena. The sixteen new trees are normal general/oak gathering resources, not a
parallel decorative forest. Their distribution follows three authored regions:
west ridge foot, southern meadow and eastern shoulder. Existing terrain, the
original thirteen trees, gathering yields and regrowth rules stay unchanged.

This is an art candidate, not an assertion of AAA quality, launch economy balance
or production readiness. The remaining island still needs architecture, coherent
ground detail, lighting, water, movement and sound.

## Frozen authoring result

The offline study in `asset-studio/compact-resource-groves01` retained sixteen
qualified anchors from a single bounded seed pool: fourteen general and two oak.
The earlier thirty-two-tree request was not forced through. Three geometric
candidates lacked a successful bounded route proof and were excluded; this does
not prove those locations inaccessible. No spacing or route threshold was relaxed.

Candidate03 SHA-256:
`2140ad7dd0db1294dbf763e278385faea06c7e4ac9cf9e6ac04e3917e6275991`.
Its selected anchor-array digest is
`6dfcf06c20e83131b435fe5b67dfb9ec51072af645eb77ec39f8a80efa49cb4c`.
The two authoring tests and all 36 direct source/config/script pins plus 22
consumed GLB hashes were independently checked. This is a direct-input inventory,
not a complete transitive executable archive.

The study used actual terrain/resource classes, baked terrain collision flags,
actual resource blockers and the real BFS pathfinder. It checked bank-to-tree
approaches, cardinal standing tiles and conservative station/path/crown clearance.
It did not run live PhysX movement, harvesting, regrowth, persistence or reconnect.

Selected model LOD0 geometry adds 104,386 triangles per complete geometry pass.
This is not measured GPU work: visibility, material passes and shadows matter.
The existing 800/1,000m tree LOD thresholds keep compact-island views at LOD0;
no cheap distant-LOD claim is made. The model families already exist, but actual
native atlas/batch residency still requires inspection.

## Runtime contract

World-config version 2 explicitly carries `compact-functional-groves-v1`, bound
to the unchanged `compact-duel-island-v4` terrain profile. Startup validation
rejects unsupported structure, non-finite/unsnapped coordinates, wrong species,
duplicate coordinate-derived identities, changed scale and excess population.
The configuration is detached, deeply frozen and included in the existing full
world-content identity; old and new clients must not share an admitted session.

Each tree is appended only to its centered terrain owner after the actual final
ground, water, slope, road and arena checks. A failed anchor rejects that owner's
publication instead of silently relocating, backfilling or dropping the tree.
The existing resource pipeline supplies normal entities, collision and authority.
No `instanceId`, wider network radius, extra forest system or supply-rule change
is introduced. The expected world census is exactly 29 trees: 24 terrain-owned
and five existing authored/network-owned trees.

## Verification status

- Root's first broader run: 368/371 tests passed across 36 files. Three failures
  were the existing residency suite's explicit pre-grove counts (13, 5 and 3),
  now respectively 29, 15 and 11. The failures are retained, not waived. Explicit
  ID/owner expectations were updated, preserving the original thirteen-tree
  subset and every lifecycle assertion; the complete root rerun passes **393/393
  tests across 37 files**. The implementer's focused 125-test run also passes.
- All three normal builds and all three package typechecks passed. The existing
  Vite esbuild/oxc configuration warning remains; it is not a runtime GPU error.
- Seven changed TypeScript files pass scoped ESLint and the diff whitespace check.
- The new integration cases verify the actual 29-resource startup census,
  unchanged original transforms/species/scales, correct tile ownership, unchanged
  harvest data, duplicate-free stationary updates and owner unload/reload.
- Actual full-world Metal/WebGPU probes50 and51 verify the exact 29-tree
  server/client census: 24 terrain-owned and five authored trees, all known
  authoritative states and no depleted trees. All 67 art/lighting observations
  and all 11 HUD restoration leases pass. The original 13-tree probe48 remains
  unchanged. No actual harvest/regrowth/reconnect cycle was performed here.
- Each native study passes, but each whole run still fails the same fourteen
  dagger-fit and five cow/avatar errors. Page/GPU errors are zero and owned
  cleanup is complete. Root reviewed bank and wide images: the groves add useful
  structure but the environment remains well below the art target. Rendering
  cost, motion and final visual approval remain open.
- Probe49 stopped at the normal launch asset validator, before browser creation.
  The validator still requires world-config version 1; the runtime now admits the
  explicit version-2 grove contract. No in-game census, image or GPU result was
  produced. The failed report is preserved
  (`029de9588442027852be2f88598c1aaf86f709e1f9b768fbe079c774a705afcf`);
  compatibility was corrected and tested without bypassing the launch gate.
- The launch validator now accepts only supported versions 1/2 and invokes the
  actual source `DataManager.setWorldConfig` in a bounded, pinned-Bun child before
  the shared build. There is no duplicated grove schema or build dependency.
  Its child has a 10-second timeout, 64KiB output cap and 8MiB input cap; missing
  runtime, invalid output, malformed configuration and child failures reject launch.
  All existing water, road and asset checks remain.
- The first complete validator suite passed 31/32; its sole failure was an old
  test's 140.5m campus depth (the already-admitted single-arena grade is 84.5m).
  Only that expected dimension and its stale comment changed. The active v2 and
  independent rectangular/water-boundary cases subsequently passed; all 32 cases
  are verified across these runs, not represented as one fresh all-pass run.
  Twelve additional launch-safety cases pass. Root independently reproduced the
  same old dimension failure, passed all twelve selected negative/legacy cases,
  then passed the corrected active-v2 process case. Direct Node22 and pinned
  Bun1.3.14 validators pass, as do scoped lint/format checks.

The three pre-build gate files are separately attested, not included in the
world runner's inherited source archive: validator
`1373ba573ead7218f5c59df22a56055bb9bf09ee61cb20a78fd958000b0f286a`,
validator tests `c6c928e48ff5866be5097c9a1cdbfe6d54f905fcf1c382c6b1083d83567d2147`,
unchanged Bun policy `7feeb5b431cd783b1ec5abd72337b4c22480bc4b4d9fa369061d21c082d2acf3`.

Frozen world-config bytes have SHA-256
`43ed4b368a16b970faae2d63bab71c785894833272b1c4ffce239fde9f84d571`.
The complete canonical world-content identity is
`cd977c33cc6723ccf7977c0726f9606fa4c38723c99268b243ab95cac1d43089`.

Probe50 report SHA-256:
`8442a1e96308b98e21eace5ce92d97684bc250a859740e16f453456f941bebce`.
Probe51, including the subsequent compact lighting correction:
`b845a0c8526fa720528aba9aa75ed3b8419ba97e9853f792f031d7f4df651cd0`.
Root independently verifies all468 probe51 current pins and399 archives; all39
original images total37,711,129 bytes at1280×720. Its combined regression run
passes422/422 tests across41 files, plus all three builds/typechecks. See
[lighting evidence](compact-lighting-correction-20260911.md) for the exact
camera-shadow correction, retained error gates and visual/performance limits.

## Remaining acceptance

Further improve grove framing, trunk grounding, crown overlap, shadows, material
response and useful activity visibility beyond this first image review. Test
live harvesting/depletion/regrowth and reconnect, motion/LOD stability,
decoded-stream quality, measured CPU/GPU frame tails and sustained memory.
Existing cow/avatar and dagger content errors remain separate launch blockers.
