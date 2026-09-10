# Neutral shorts replacement — implementation and remaining asset gates

Updated 2026-09-05. Full leg garments replace the neutral shorts visual; they
do not delete the shorts asset or hide the body. No existing avatar, equipment
asset or manifest has been opted in or promoted by this change.

## Implemented behavior

- Loading the first garment leaves the original shorts visible. Visibility is
  changed only after successful, structurally validated attachment.
- Replacing validated complete legs retains the old garment while loading.
  Failure retains that covering garment and its original attached item identity;
  readiness remains false for the newly requested item. Without an old complete
  garment, failure leaves the original shorts state intact.
- A successful complete-to-complete swap transfers visibility ownership in the
  same synchronous attachment call. Partial-coverage gear restores the shorts.
- Unequip, avatar invalidation, player cleanup and system destruction restore
  exactly the original shorts visibility, including an originally hidden state.
- Monotonic request tokens reject late loads after unequip, newer requests and
  cleanup/rejoin using the same player ID.
- Attachment ownership is tracked per slot. Equipment arriving on a replacement
  avatar cannot make other slots still attached to the old avatar appear ready.
  Avatar completion removes only stale slots and preserves valid new ones.
- Clothing attached during the local avatar's hidden idle-loading phase is
  requalified on readiness or same-item replay. Repeated events preserve the
  original shorts visibility; hidden garment meshes cannot acquire ownership.

## Explicit asset contract — not automatically granted by the slot

Equipment attachment extras must declare:

```ts
hyperia.clothingReplacement = {
  schemaVersion: 1,
  coverage: "waist-to-ankles",
  replaces: "neutral-shorts",
};
```

The equipment also needs the existing item/avatar fit metadata and compatible
skinned skeleton, including outside the streaming viewport. The attached root
and its skinned meshes must be visible before shorts replacement is permitted.

Avatar scene extras must declare:

```ts
hyperiaNeutralClothing = {
  schemaVersion: 1,
  shortsMeshName: "<exact exported shorts leaf mesh name>",
  bodyMeshNames: ["<exact exported body leaf mesh name>"],
};
```

The separate leaf meshes additionally declare
`userData.hyperiaAvatarSurface = "neutral-shorts"` or `"body"` respectively.
Names must uniquely resolve to nonempty leaf meshes outside the equipment
subtree. Missing, ambiguous, incomplete or invalid contracts leave clothing
unchanged; the implementation does not use substring-based body hiding.
Metadata is an authored claim, not a geometry/coverage certificate.

Implementation: `NeutralShortsWearState.ts`, narrow lifecycle hooks in
`EquipmentVisualSystem.ts`, and the optional type in
`EquipmentVisualHelpers.ts`, under `packages/shared/src/systems/client/`.

## Independently rerun verification

From `packages/shared`, the root reran:

```text
bun x vitest run src/systems/client/__tests__/NeutralShortsWearState.test.ts src/systems/client/__tests__/EquipmentVisualSystem.test.ts src/extras/three/__tests__/createVRMFactory.materials.test.ts src/extras/three/__tests__/createVRMFactory.boneTransform.test.ts
111 tests passed across 4 suites, including 36 new wear-state tests.

bun x tsc --noEmit --pretty false
Passed.

bun x eslint src/systems/client/NeutralShortsWearState.ts src/systems/client/__tests__/NeutralShortsWearState.test.ts src/systems/client/EquipmentVisualHelpers.ts src/systems/client/EquipmentVisualSystem.ts src/systems/client/__tests__/EquipmentVisualSystem.test.ts
Passed.
```

Scoped diff whitespace checks also pass for the modified existing runtime
files and equipment test. Tests use real Three/VRM objects and actual lifecycle methods;
they do not constitute a browser rendering or finished-asset test.

An independent review found the cross-slot avatar-replacement and hidden-avatar
readiness defects after the initial 105-test pass. Six actual-order regressions
were added with the fixes; the reviewer checked them and the root independently
reran the final 111-test set, typecheck and lint. Exact source fingerprints are
recorded in `neutral-shorts-wear-state-verification-2026-09-05.json`.

## Still required before this is visible in the game

- [ ] Finish and qualify complete trousers/armor coverage and deformation.
- [ ] Export and verify the exact separate avatar meshes and metadata in the
  actual canonical avatar and equipment bytes; keep partial items opted out.
- [ ] Verify the actual avatar clone/LOD paths preserve the explicit contract
  and independent per-avatar visibility ownership.
- [ ] Exercise equip/unequip, delayed and failed loads, rapid swaps, avatar
  replacement and mixed loadouts in hardware WebGPU; inspect actual frames for
  flashes, doubled clothing, hidden skin and stale garments.
- [ ] Recheck game/stream readiness and performance with the finished assets.

No complete gear, visual-fit or production-launch gate is closed here.
