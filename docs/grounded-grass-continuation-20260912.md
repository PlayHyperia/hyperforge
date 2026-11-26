# Grounded grass continuation foundation — 2026-09-12

This checkpoint prepares reliable grass-to-terrain contact. It does **not**
enable per-blade GPU correction, increase meadow density or constitute a visible
quality/performance approval. Those require the complete installation lifecycle
below, followed by native motion and cost evidence.

## Implemented

- One numerical grounding core now serves both the synchronous offline API and
  a resumable production job. Validation, mask traversal, exact triangle/edge
  checks, stable interval sorting and compaction have continuation points.
- Retained terrain offers a caller-owned triangle cursor over its actual
  Float32 grid and original face order. It avoids per-face tuple allocation and
  repeated cell lookup; this structural reduction is not a measured speedup.
- The job caps each advance at 8,192 charged steps with a cooperative 2 ms
  target, checking time every 64 steps. One million total steps or 250 ms summed
  active-slice elapsed time terminates the request. These are work protections,
  not preemptible deadlines or proven production budgets.
- Missing/overlapping support waits without repeatedly restarting. Invalid
  input and exhausted work remain explicit failures. Cancellation releases
  suspended state and never publishes partial output.
- The actual terrain manager can lease every admitted surface intersecting a
  closed world-space region, including mixed-size neighbors. Revalidation
  catches new arrivals, replacement, attribute/index changes, unload and
  destruction without per-check arrays. Unrelated region changes do not cancel
  it. Capacity overflow fails explicitly instead of returning a partial set.
- Transitional parent meshes cannot certify contact while children may overlap
  them. A region lease owns geometry only—not roads, masks, water or coverage.

## Verification so far

- 944 shared tests pass across 74 files, including real geometry, native worker
  and native physics regressions. Focused lint and shared typecheck pass.
- 15 separate tests pass against the immutable original synchronous algorithm,
  including all three LODs, slice sizes 1/7/64/1024/8192 and actual native worker
  output for six current v5 island leaves.
- Raw counts remain 271/520/139/532/493/343 (2,298). The algorithm retains
  257/511/131/521/483/337 (2,240), exactly matching the original reference. The
  58 removals are 57 swept pad exclusions and one terrain-edge rejection—not
  changes to sampling, seed, spacing or arbitrary quality reduction.
- Every retained instance buffer, correction, source index, dependency and
  non-time receipt matches. The production snapshot validator handles its full
  32,768-tile mask through continuation points and remains worker-serializable.
- A real terrain-manager/grounding-job test covers missing support, sleeping,
  neighbor arrival, completion and later invalidation with the own leaf intact.
- A recorded CPU run spans 25.110–84.823 ms accumulated active-slice elapsed
  per leaf, 13–46 slices, with a 2.197 ms longest slice. Prior prototype runs
  exceeded this. Scheduling/GC are included; this is not isolated CPU-thread
  time, a browser benchmark, GPU cost or a reliable sub-2 ms bound.

## Native scene regression

Shared/client/server and external typechecks, scoped lint, client/shared build
then server build pass. Capture-harness checks pass 94/94 after build output is
stable. An earlier concurrent-build check correctly rejected bundle drift;
that failed attempt was not accepted or bypassed.

Native67 uses the same nonfallback WebGPU renderer, 1280×720/DPR1 and exact
native64 camera/daylight reference. Root verifies 592 source pins, 523 archives,
all 24 PNGs, 48 fog brackets and 18 matched pairs, plus 27 prelaunch root pins.
Both island censuses pass with the current live anchor-only grass. No page,
GPU or cleanup errors occur. The same 19 cow/dagger content errors remain,
keeping the overall run failed. Owned browser, launcher and service ports closed.

All six no-2D-HUD scenic views were reviewed. No apparent still-image regression
was found; the flat lawn, sparse ground cover, continuous exposed scarp and
dominant rectangular platforms remain below the requested art standard. This
run does not exercise live per-blade correction or qualify motion/performance.
The report explicitly retains performanceEligible=false and productionApproved=false.

Native67 report SHA256:
`e973e0685cfe01bc9567fffe29594f8597f7b8022cd64a24b2f3cdc70e1ad61d`.

## Required before live correction / denser meadow

1. Wire complete terrain-region **and constraint** ownership to compact grass
   tickets. Snapshot/query/invalidation envelopes must cover every transformed
   blade through fade and wind, not just the existing 0.5 m normal-sample halo.
2. Integrate bounded projection and resumable jobs into the manager's single
   upload-per-frame path. Waiting/failure/cancellation must appear in readiness;
   stable missing support must not spin or become successful empty coverage.
3. Remap computed-height/ecological-normal provenance as well as GPU attributes;
   retain accepted swept bounds for culling. Revalidate before installation and
   retire already displayed dependent grass before stale terrain is rendered.
4. Use chunk-owned read-only storage corrections after all existing vertex
   transforms, with exact indexed-vertex addressing and unchanged shared lighting
   uniforms. Register and dispose storage/geometry/material/mesh ownership once;
   representative precompile must exercise that actual graph.
5. Preserve ordinary/fixed profiles and current compact spacing, shape, seed,
   horizon and lighting. Measure all resident leaves, loading, upload/memory
   retirement, motion and GPU/presented-frame behavior on actual WebGPU.

No new textures, render passes, avatar changes, terrain heights or resource
placement changes are included. Whole-scene art, performance and launch gates
remain open; numerical agreement alone does not certify GPU contact or appearance.
