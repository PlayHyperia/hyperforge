# Compact pond banks and foliage checkpoint

Implemented development candidate, September10,2026. Actual WebGPU probe17
improves the pond over16, but **art, representative performance and production
approval remain open**. The full scene still looks sparse and unfinished.

## Implemented changes

The authored pond now has bounded irregular shoreline grading with amplitude0.9m.
The shared terrain surface, worker snapshot, type admission and deployment
validator use the same profile. Radial warping fades out at the outer bank,
retaining the existing blend boundary. Pond center343,302, water radius7.5m,
surface27.8m and interaction targets are unchanged. These are localized terrain
changes, not removal of an arena or redistribution of resource trees.

Only the two100m retained leaves centered350,250 and350,350 use128vertices/axis.
Other streaming leaves retain16; the hub detail policy remains64. Across7,921
CPU comparison points the128 candidate has maximum error0.17675727m and
RMS0.02764650m against the authored surface. This is not zero contact error or a
frame-time measurement. Actual probe17 reports66,548triangles and2,690,928geometry
bytes for those two leaves: +49,664triangles and+2,000,896bytes versus64.

The final wet-soil transition ends0.22m above the water with bounded0.06m noise;
wetness fades between0.02m and0.18m. Dry shoulders at0.28m receive no added pond
soil. Main/worker ground-color logic matches the shader policy; the same six
maps and fourteen surface fetch sites are retained. The3m material reach does
not enlarge the actual water footprint. Small compact ponds disable the noisy
foam rim through a per-object uniform without another water material/reflection.

The five-model kit remains32instances/five primitive batches:4boulders,6stones,
8ferns,3bushes,11reeds. Three uneven plant groups preserve the open southern
approach. Private material copies preserve shared maps, alpha cutouts and normal
settings; shared cache geometry/textures are not disposed with the owner.
Rocks use a conservative full-footprint retained-triangle support check. Plants
use actual lower central root geometry, not hanging canopy bounds; full crown
bounds remain available for culling. Missing/replaced surfaces fail closed,
revision updates remain bounded, and late loads cannot reattach after teardown.

The replacement fern is Poly Haven's CC0 Fern02, source variant fern_02_c,
uniformly normalized without decimation. It has2,248triangles, one primitive,
one material, and1,163,648bytes. Source alpha is restored in a768-square base map,
with512-square OpenGL normal and256-square ORM/AO. Estimated RGBA8+mips are
4,893,344bytes. The source geometry correspondence error is below1.46e-7m.
This fern's provenance is documented; provenance for the existing rock/stone/bush
sources remains a separate launch check. Original sources and prior exports are
preserved. [Fern02](https://polyhaven.com/a/fern_02),
[provider license](https://polyhaven.com/license).

Current five GLBs total5,622,276bytes and approximately21.9427MiB estimated decoded
texture/mip storage. At32instances they submit37,068main-pass triangles before
culling, with extra shadow work and alpha cost. This is17,024more submitted
triangles than the previous fern kit. Download and estimated allocation numbers
are not measured GPU residency or performance approval.

Asset commit: `fb41785c68c6324903559552a26af11da07c7143`, branch
`codex/duel-arena-launch-assets`. Only world-areas.json, the kit README and
pond_fern.glb are included. Game source hash admission matches the new fern SHA:
`8d486e7a907ba633a08e79ab00a2c49fe07c8e9e96810db189981a88a51ab86f`.

## Rejected iteration and actual final evidence

Probe16 is retained as a rejected visual iteration. Its overly broad wet-soil
height band created a brown annulus; canopy-footprint support buried much of the
fern/reed geometry. Probe17 narrows the soil band and anchors plants by their
root slice. Neither old evidence nor executed harness files were overwritten.

Evidence is retained locally under
`asset-studio/game-test-integration/compact-world-probe17/`, not included as a
large generated archive in Git. Actual headful Chrome/Metal WebGPU ran at
1280x720/DPR1 from23:13:22.340Z to23:15:38.225Z onSeptember10:135.885seconds.
Eleven camera definitions yield22scene PNGs; all179source/art pins are unchanged.
All45initial/before/after art-state observations pass. Six terrain PNG responses
total9,452,737bytes and five GLB responses total5,622,276bytes; allHTTP200 with
exact expected hashes. Each selected image has its own before/after bracket;
initial measurements are not falsely presented as simultaneous with later PNGs.

The inner study passes; the overall run **fails**. It retains19console errors:
14canonical dagger-fit metadata messages and5cow404-related messages, with one
missing cow model URL. Page and GPU diagnostic errors are zero. The native trace
has68,265begins/ends and22,920finishes without recorded lifecycle violations;
that instrumentation is not a representative performance benchmark.

Cleanup is clean:14attachments/14detachments,4private CPU geometry disposals,
zero pending loads, browser closed, PostgreSQL exited, launcher exit0, no forced
or remaining owned process groups, and ports3333/5555/9236/57831clear. The earlier
probe13 intermittent teardown failure remains historical; later successful runs
do not erase it. This maintenance capture skips real betting/keeper/stream
services and therefore is not production-stream or full-cycle acceptance.

| Artifact              | SHA-256                                                          |
| --------------------- | ---------------------------------------------------------------- |
| report.json           | 034ab29b3f885d114c7ad1bb15008302f3bccc41f4d021a7d90bdbbb88b68053 |
| spatial-study.json    | 03188e9368beaace0beec08d391089fd143116bdfad8553ed5fde665d7621d3e |
| launcher.log          | 7078c6bd68f2107350c068d99a6d79b4325e26ea90db45bda917dbf84db87332 |
| build ID              | c3e3fb0c7c839f120fb7ea8635cc6710d8f759489bef9d19fefbf0a3bb04346e |
| immutable study11.mjs | c23839edc4a7ff811b5a35b9c0b08c6cab617bca520b2f51fdcc8f6159a6e57d |

The quiet-pond uniform is observed through object/metadata and a real NodeFrame
callback test. Public node traversal does not expose the closure's complete
generated graph: its study field is explicitly unavailable/null, not proof of
GPU execution. Actual images establish the absent foam halo separately.

## Verification and remaining work

Final candidate checks pass:552shared tests/42files;128server tests/nine files;
20launch-preflight tests;40study11 tests;4art-pin helper02 tests; shared/client/
server typechecks; scoped29-file lint/format/diff checks; fresh shared+server
builds and client production build. The server suite predates the last client
plant/material correction; no server runtime source changed after that suite.
Tests protect contracts, not the claimed quality of the finished experience.

Primary and independent actual pond/hub/wide review agree: the broad brown ring
is removed, meadow meets the narrow bank, and ferns/reeds are visibly fuller.
The pond still looks bowl-shaped; three small isolated plant groups do not form
a finished habitat. Rocks remain dark/faceted, and fishing markers dominate or
partially intersect the bank. The hub remains lawn with standalone props. Grass
coverage is still only12unique sampled anchors, zero in the campus/pond-bank
regions. The wide view retains six arena pads and visible hospital green stripes.

Next required delivery: one authoritative arena, a composed compact preparation
village/landform, and the existing choppable resource trees distributed across
the island. No separate decorative forest. Preserve harvesting, depletion,
regrowth, tier access and collision/navigation alongside scenery. See
`single-arena-world-composition-plan-20260910.md` and the launch checklist.
Renderer/dependency qualification is separately scoped in
`renderer-dependency-audit-20260910.md`; no dependencies changed here.

Avatar color/armor/animation/fit, missing cow/dagger content, hospital striping,
moving-camera/night/multi-agent frame-time and memory, actual stream A/V and the
complete reliable agent/SOL loop remain unapproved. Neither prettier pond pixels
nor a source checkpoint closes those launch gates.
