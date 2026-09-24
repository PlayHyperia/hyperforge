/** Selection only: these limits do not enable a renderer or qualify its cost. */
export const GRASS_MEADOW_DETAIL_BUDGET = Object.freeze({
  capacity: 640,
  fullDetailDistance: 3.5,
  coarseDistance: 5,
  prepareDistance: 6,
} as const);

/** An existing, currently admitted clump. Identity must include its generation
 * and placement owner; an old source index alone is not a reusable identity. */
export type GrassMeadowDetailClump = Readonly<{
  id: string;
  x: number;
  z: number;
}>;

/** Every live allocation consumes a slot, even while retiring or awaiting a
 * result. A replacement and its retiring predecessor therefore consume two. */
export type GrassMeadowDetailSlot = Readonly<{
  slotId: string;
  clumpId: string;
  phase: "pending" | "active" | "retiring";
}>;

export type GrassMeadowDetailTarget = Readonly<{
  clumpId: string;
  /** Null only for a proposed preparation, never an inferred live allocation. */
  slotId: string | null;
  /** Null means the occupied identity is absent from current admitted clumps. */
  distanceSquared: number | null;
  /** Desired endpoint, not permission to render an unready result or pop to it. */
  targetWeight: number;
}>;

export type GrassMeadowDetailSelection = Readonly<{
  targets: readonly GrassMeadowDetailTarget[];
  prepareIds: readonly string[];
  occupiedSlots: number;
  /** Free slots if the caller atomically reserves every proposed preparation. */
  remainingSlots: number;
}>;

function validId(id: string): boolean {
  return typeof id === "string" && id.length > 0;
}

function compareTargets(
  a: GrassMeadowDetailTarget,
  b: GrassMeadowDetailTarget,
): number {
  if (a.distanceSquared !== b.distanceSquared) {
    if (a.distanceSquared === null) return 1;
    if (b.distanceSquared === null) return -1;
    return a.distanceSquared - b.distanceSquared;
  }
  // Deliberately independent of host locale and input iteration order.
  return a.clumpId < b.clumpId ? -1 : a.clumpId > b.clumpId ? 1 : 0;
}

function weight(distanceSquared: number): number {
  const { fullDetailDistance, coarseDistance } = GRASS_MEADOW_DETAIL_BUDGET;
  if (distanceSquared <= fullDetailDistance ** 2) return 1;
  if (distanceSquared >= coarseDistance ** 2) return 0;
  const t =
    (Math.sqrt(distanceSquared) - fullDetailDistance) /
    (coarseDistance - fullDetailDistance);
  return 1 - t * t * (3 - 2 * t);
}

/** Pure reservation-aware choice among caller-admitted clumps. No placement,
 * visibility, ground fit, allocation, release or publication is performed.
 * Existing active/pending slots remain explicit zero-weight targets outside
 * the detail band or after their identity becomes stale. The lifecycle owner
 * decides how to morph out, preserve coarse fallback and release those slots.
 *
 * New choices cannot evict live slots, reactivate retiring slots, or borrow
 * their capacity early. Apply results only against the same occupancy epoch;
 * concurrent callers cannot reserve independently against this snapshot. */
export function selectGrassMeadowDetail(input: {
  camera: Readonly<{ x: number; z: number }>;
  clumps: readonly GrassMeadowDetailClump[];
  occupied: readonly GrassMeadowDetailSlot[];
}): GrassMeadowDetailSelection {
  const { camera, clumps, occupied } = input;
  const { capacity, prepareDistance } = GRASS_MEADOW_DETAIL_BUDGET;
  if (
    !Number.isFinite(camera.x) ||
    !Number.isFinite(camera.z) ||
    occupied.length > capacity
  )
    throw new Error("Invalid meadow detail camera or occupied capacity");

  const occupiedIds = new Set<string>();
  const slotIds = new Set<string>();
  const eligibleSlots = new Map<string, GrassMeadowDetailSlot>();
  for (const slot of occupied) {
    if (
      !validId(slot.slotId) ||
      !validId(slot.clumpId) ||
      slotIds.has(slot.slotId) ||
      !["pending", "active", "retiring"].includes(slot.phase)
    )
      throw new Error("Invalid meadow detail slot identity or phase");
    slotIds.add(slot.slotId);
    occupiedIds.add(slot.clumpId);
    if (slot.phase !== "retiring") {
      if (eligibleSlots.has(slot.clumpId))
        throw new Error("Duplicate meadow detail active/pending ownership");
      eligibleSlots.set(slot.clumpId, slot);
    }
  }

  const available = capacity - occupied.length;
  const seenClumps = new Set<string>();
  const retained: GrassMeadowDetailTarget[] = [];
  // Keep at most available candidates, even for unusually dense caller input.
  const prepare: GrassMeadowDetailTarget[] = [];
  for (const clump of clumps) {
    if (
      !validId(clump.id) ||
      seenClumps.has(clump.id) ||
      !Number.isFinite(clump.x) ||
      !Number.isFinite(clump.z)
    )
      throw new Error("Invalid or duplicate meadow detail clump");
    seenClumps.add(clump.id);
    const dx = clump.x - camera.x;
    const dz = clump.z - camera.z;
    const distanceSquared = dx * dx + dz * dz;
    if (!Number.isFinite(distanceSquared))
      throw new Error("Invalid meadow detail distance overflow");
    const slot = eligibleSlots.get(clump.id);
    if (
      !slot &&
      (available === 0 ||
        occupiedIds.has(clump.id) ||
        distanceSquared > prepareDistance ** 2)
    )
      continue;
    const target: GrassMeadowDetailTarget = {
      clumpId: clump.id,
      slotId: slot?.slotId ?? null,
      distanceSquared,
      targetWeight: weight(distanceSquared),
    };
    if (slot) {
      retained.push(target);
      continue;
    }
    if (
      prepare.length === available &&
      compareTargets(target, prepare[prepare.length - 1]) >= 0
    )
      continue;
    let low = 0;
    let high = prepare.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareTargets(target, prepare[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    prepare.splice(low, 0, target);
    if (prepare.length > available) prepare.pop();
  }
  for (const [clumpId, slot] of eligibleSlots) {
    if (!seenClumps.has(clumpId))
      retained.push({
        clumpId,
        slotId: slot.slotId,
        distanceSquared: null,
        targetWeight: 0,
      });
  }

  const targets = [...retained, ...prepare].sort(compareTargets);
  return Object.freeze({
    targets: Object.freeze(targets.map((target) => Object.freeze(target))),
    prepareIds: Object.freeze(prepare.map((target) => target.clumpId)),
    occupiedSlots: occupied.length,
    remainingSlots: available - prepare.length,
  });
}
