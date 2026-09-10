# Cached GLB actor lifecycle audit — 2026-09-10

Status: follow-up implementation and actual rendered churn tests required. The
independent-skeleton fix in `73df923604bfb1310274ee38d835cff9817ebb98` is pushed;
it is not full actor-lifecycle or cow-animation qualification.

## Confirmed source findings

- `MobEntity.destroy()` stops its GLB mixer but does not uncache the root, clear
  `currentAction`, or explicitly release instance skeletons.
- `Entity.disposeMesh()` disposes every geometry and incorrectly describes it as
  per-entity. ModelCache and skeleton-aware clones share geometry/materials, so
  removal can dispose a resource still used by another actor and the cache.
  Immediate visible corruption is not established by this source audit.
- The GLB is attached before awaited external-animation loading. An animation
  failure can fall through to the capsule fallback and overwrite `this.mesh`
  without releasing the attached GLB. Missing post-await lifetime checks also
  allow late installation after an actor has been destroyed.
- ModelCache's clone count is cumulative statistics, not a reference-counted
  release contract. Template eviction cannot release independent actor skeletons.
  Normal mob death/respawn reuses the existing model; it is not a new clone per
  death. Animation-only model loads also need ownership review.
- Installed Three WebGPU skinning uses the skeleton's bone-matrix buffer. Do not
  report a measured bone-texture leak: the regression explicitly allocates a
  bone texture, while that allocation is not established on the ordinary GLB
  actor path. Render-object/material listener retention and GPU buffer release
  need actual rendered spawn/remove measurements, not just `dispose()` counts.

Separate issue: transform baking resets non-mesh rest transforms. A non-identity
rig must be qualified independently; cloning isolation does not fix its bind pose.

## Required bounded follow-up

- [ ] Establish explicit clone/geometry ownership and idempotent instance release.
  Release owned skeleton state without disposing surviving actors' shared assets.
- [ ] Centralize GLB detach, mixer stop/uncache and action-reference clearing for
  destruction, replacement, failed initialization and stale async completion.
- [ ] Add real GLB/MobEntity lifecycle regressions: two actors and surviving
  deformation, disposal ownership, repeated release, failed animation load,
  delayed completion after destruction, animation-only loads and cache eviction.
- [ ] Measure actual WebGPU spawn/remove churn with material/render-object/buffer
  retention evidence. CPU tests alone cannot certify GPU reclamation.
- [ ] Qualify non-identity rest/bind transforms and embedded idle/walk/attack/death
  animations before accepting a replacement cow model. Extend launch preflight
  to the models referenced by active NPC/mob spawns.

This audit made no runtime changes and added no passing-test claims. The existing
two ModelCache tests prove independent poses and explicit test-managed disposal,
not the unresolved production lifecycle above.
