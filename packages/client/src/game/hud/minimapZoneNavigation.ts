/** Pure minimap projection/layout. No renderer, manifest mutation or world state. */
export class MinimapViewportMetrics {
  majorPixels = 200;
  halfWidth = 10;
  halfHeight = 10;
  pixelsPerWorld = 10;

  /** One isotropic world scale for camera projection and cached terrain. */
  update(width: number, height: number, halfExtent: number): void {
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      !Number.isFinite(halfExtent) ||
      width <= 0 ||
      height <= 0 ||
      halfExtent <= 0
    )
      throw new Error("Positive finite minimap viewport required");
    this.majorPixels = Math.max(width, height);
    // Ratio first keeps a square viewport's original half-extent exact.
    this.halfWidth = halfExtent * (width / this.majorPixels);
    this.halfHeight = halfExtent * (height / this.majorPixels);
    this.pixelsPerWorld = this.majorPixels / (2 * halfExtent);
  }
}

export type MinimapZoneKind = "safe" | "arena";

export type MinimapZoneArea = {
  readonly id: string;
  readonly safeZone: boolean;
  readonly pvpEnabled?: boolean;
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
};

// The 16px glyph and its outward chevron both fit within this inset.
export const MINIMAP_ZONE_INSET = 13;

export class MinimapZoneMarker {
  id = "";
  kind: MinimapZoneKind = "safe";
  x = 0;
  y = 0;
  directionX = 0;
  directionY = 0;
  offMap = false;
  distanceSquared = Infinity;

  copy(marker: MinimapZoneMarker): void {
    this.id = marker.id;
    this.kind = marker.kind;
    this.x = marker.x;
    this.y = marker.y;
    this.directionX = marker.directionX;
    this.directionY = marker.directionY;
    this.offMap = marker.offMap;
    this.distanceSquared = marker.distanceSquared;
  }
}

/** Per-minimap marker objects are reused; population growth adds storage slots. */
export class MinimapZoneNavigationState {
  readonly markers: MinimapZoneMarker[] = [];
  count = 0;
  readonly projected = new MinimapZoneMarker();
  readonly nearestSafe = new MinimapZoneMarker();
  readonly nearestArena = new MinimapZoneMarker();

  append(marker: MinimapZoneMarker): void {
    const target = (this.markers[this.count] ??= new MinimapZoneMarker());
    target.copy(marker);
    this.count++;
  }
}

export function getMinimapZoneKind(
  area: MinimapZoneArea,
): MinimapZoneKind | null {
  if (area.id === "duel_arena") return "arena";
  // The arena POI represents this whole campus, including its safe grounds.
  // Navigation deduplication does not change zone safety or border rendering.
  if (area.id === "arena_grounds") return null;
  return area.safeZone && !area.pvpEnabled ? "safe" : null;
}

function isNearer(a: MinimapZoneMarker, b: MinimapZoneMarker): boolean {
  return (
    a.distanceSquared < b.distanceSquared ||
    (a.distanceSquared === b.distanceSquared && a.id < b.id)
  );
}

/**
 * Uses the minimap's actual projection-view matrix, including live yaw/zoom.
 * All in-bounds destinations are retained. At most one edge cue represents the
 * nearest off-map destination whose kind is not already visible. Distances are
 * world-XZ distances, never stretched canvas distances; ties use stable IDs.
 */
export function updateMinimapZoneNavigation(
  state: MinimapZoneNavigationState,
  areas: Readonly<Record<string, MinimapZoneArea>>,
  projectionViewElements: readonly number[],
  originX: number,
  originZ: number,
  width: number,
  height: number,
): void {
  state.count = 0;
  state.nearestSafe.distanceSquared = Infinity;
  state.nearestArena.distanceSquared = Infinity;
  if (
    !Number.isFinite(originX) ||
    !Number.isFinite(originZ) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= MINIMAP_ZONE_INSET * 2 ||
    height <= MINIMAP_ZONE_INSET * 2 ||
    projectionViewElements.length !== 16
  )
    return;
  for (const value of projectionViewElements) {
    if (!Number.isFinite(value)) return;
  }

  const e = projectionViewElements;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const innerX = halfWidth - MINIMAP_ZONE_INSET;
  const innerY = halfHeight - MINIMAP_ZONE_INSET;
  let hasVisibleSafe = false;
  let hasVisibleArena = false;

  for (const id in areas) {
    if (!Object.prototype.hasOwnProperty.call(areas, id)) continue;
    const area = areas[id];
    const kind = getMinimapZoneKind(area);
    if (!kind) continue;
    const { minX, maxX, minZ, maxZ } = area.bounds;
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minZ) ||
      !Number.isFinite(maxZ) ||
      minX >= maxX ||
      minZ >= maxZ
    )
      continue;
    const x = minX / 2 + maxX / 2;
    const z = minZ / 2 + maxZ / 2;
    const w = e[3] * x + e[11] * z + e[15];
    if (!Number.isFinite(w) || w <= 0) continue;
    const dx = ((e[0] * x + e[8] * z + e[12]) / w) * halfWidth;
    const dy = -((e[1] * x + e[9] * z + e[13]) / w) * halfHeight;
    const distanceSquared = (x - originX) ** 2 + (z - originZ) ** 2;
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      !Number.isFinite(distanceSquared)
    )
      continue;

    const marker = state.projected;
    marker.id = area.id;
    marker.kind = kind;
    marker.distanceSquared = distanceSquared;
    marker.offMap = Math.abs(dx) > innerX || Math.abs(dy) > innerY;
    const edgeScale = Math.max(1, Math.abs(dx) / innerX, Math.abs(dy) / innerY);
    marker.x = halfWidth + dx / edgeScale;
    marker.y = halfHeight + dy / edgeScale;
    const length = Math.hypot(dx, dy);
    marker.directionX = length > 0 ? dx / length : 0;
    marker.directionY = length > 0 ? dy / length : 0;

    if (!marker.offMap) {
      state.append(marker);
      if (kind === "safe") hasVisibleSafe = true;
      else hasVisibleArena = true;
    } else {
      const nearest = kind === "safe" ? state.nearestSafe : state.nearestArena;
      if (isNearer(marker, nearest)) nearest.copy(marker);
    }
  }

  const safe =
    !hasVisibleSafe && Number.isFinite(state.nearestSafe.distanceSquared)
      ? state.nearestSafe
      : null;
  const arena =
    !hasVisibleArena && Number.isFinite(state.nearestArena.distanceSquared)
      ? state.nearestArena
      : null;
  const nearest =
    safe && arena ? (isNearer(safe, arena) ? safe : arena) : (safe ?? arena);
  if (nearest) state.append(nearest);
}
