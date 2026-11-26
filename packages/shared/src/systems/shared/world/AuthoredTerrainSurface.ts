import type { FlatZone } from "../../../types/world/terrain";

/** Validated, ordered spatial candidates; callers deduplicate zone IDs. */
export type AuthoredTerrainZone = FlatZone & { excludeGrass?: boolean };

export interface AuthoredTerrainSurfaceOperations {
  resolveHeight(
    zones: readonly AuthoredTerrainZone[],
    x: number,
    z: number,
    getProceduralHeight: () => number,
    arenaFloorIds: ReadonlySet<string>,
    arenaGradeHeight: number | null,
  ): number | null;
  isGrassExcluded(
    zones: readonly AuthoredTerrainZone[],
    x: number,
    z: number,
  ): boolean;
  resolveRadialPondTerrainHeight(
    zone: FlatZone,
    x: number,
    z: number,
    getUnderlyingHeight: () => number,
  ): number | null;
  resolveDuelArenaFloorHeight(
    zone: FlatZone,
    x: number,
    z: number,
    baseHeight: number,
  ): number | null;
}

/**
 * One numeric implementation for authored surfaces on the main thread and in
 * generated workers. Inputs are validated before this hot sampling path.
 *
 * Keep all runtime dependencies inside this factory. Object method syntax also
 * avoids bundlers adding external function-name helpers inside its source, so
 * a worker can embed `createAuthoredTerrainSurfaceOperations.toString()`.
 * Main-thread callers invoke this factory directly, without source evaluation.
 */
export function createAuthoredTerrainSurfaceOperations(): AuthoredTerrainSurfaceOperations {
  const helpers = {
    smoothstep(value: number): number {
      return value * value * (3 - 2 * value);
    },

    coreDistance(zone: FlatZone, x: number, z: number): number | null {
      const dx = Math.abs(x - zone.centerX);
      const dz = Math.abs(z - zone.centerZ);
      const halfWidth = zone.width / 2;
      const halfDepth = zone.depth / 2;
      if (zone.tileMask) {
        if (!zone.tileMask.has(`${Math.floor(x)},${Math.floor(z)}`)) {
          return null;
        }
      } else if (dx > halfWidth || dz > halfDepth) {
        return null;
      }
      return Math.max(
        halfWidth > 0 ? dx / halfWidth : 0,
        halfDepth > 0 ? dz / halfDepth : 0,
      );
    },

    tileMaskBlendFactor(zone: FlatZone, x: number, z: number): number | null {
      if (!zone.tileMaskTiles?.length || zone.blendRadius <= 0) return null;
      const bounds = zone.tileMaskBounds;
      if (
        bounds &&
        (x < bounds.minX - zone.blendRadius ||
          x > bounds.maxX + 1 + zone.blendRadius ||
          z < bounds.minZ - zone.blendRadius ||
          z > bounds.maxZ + 1 + zone.blendRadius)
      ) {
        return null;
      }
      let bestDistance = Infinity;
      for (const tile of zone.tileMaskTiles) {
        const maxX = tile.x + 1;
        const maxZ = tile.z + 1;
        const dx = x < tile.x ? tile.x - x : x > maxX ? x - maxX : 0;
        const dz = z < tile.z ? tile.z - z : z > maxZ ? z - maxZ : 0;
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance < bestDistance) {
          bestDistance = distance;
          if (bestDistance === 0) break;
        }
      }
      return bestDistance <= zone.blendRadius
        ? bestDistance / zone.blendRadius
        : null;
    },

    // Only call after ruling out this zone's core.
    blendFactor(zone: FlatZone, x: number, z: number): number | null {
      if (zone.tileMask) return helpers.tileMaskBlendFactor(zone, x, z);
      const dx = Math.abs(x - zone.centerX);
      const dz = Math.abs(z - zone.centerZ);
      const halfWidth = zone.width / 2;
      const halfDepth = zone.depth / 2;
      if (
        dx > halfWidth + zone.blendRadius ||
        dz > halfDepth + zone.blendRadius
      ) {
        return null;
      }
      if (zone.blendShape === "rounded") {
        const distance = Math.hypot(
          Math.max(0, dx - halfWidth),
          Math.max(0, dz - halfDepth),
        );
        return distance <= zone.blendRadius
          ? distance / zone.blendRadius
          : null;
      }
      return Math.max(
        dx > halfWidth ? (dx - halfWidth) / zone.blendRadius : 0,
        dz > halfDepth ? (dz - halfDepth) / zone.blendRadius : 0,
      );
    },
  };

  const operations: AuthoredTerrainSurfaceOperations = {
    resolveRadialPondTerrainHeight(zone, x, z, getUnderlyingHeight) {
      const profile = zone.radialPond;
      if (!profile) return null;
      const dx = x - zone.centerX,
        dz = z - zone.centerZ;
      let radius = Math.hypot(dx, dz);
      const angle = Math.atan2(dz, dx);
      const amplitude = profile.shorelineAmplitude ?? 0;
      if (amplitude > 0 && radius < profile.bankOuterRadius) {
        // Fixed low-frequency lobes give the basin a deliberate silhouette.
        // Keep the original radius warp and indexing envelope. Optional paired
        // sector knots can reshape the bank without extending this warp.
        const innerFade = helpers.smoothstep(
          Math.min(1, radius / (profile.bedRadius * 0.5)),
        );
        const outerFade =
          1 -
          helpers.smoothstep(
            Math.max(
              0,
              (radius - profile.bankInnerRadius) /
                (profile.bankOuterRadius - profile.bankInnerRadius),
            ),
          );
        const lobe =
          0.55 * Math.sin(2 * angle + 0.7) +
          0.3 * Math.sin(3 * angle - 0.4) +
          0.15 * Math.sin(5 * angle + 1.2);
        radius -= amplitude * lobe * innerFade * outerFade;
      }
      if (radius <= profile.bedRadius) return zone.height;
      const effectRadius = profile.bankOuterRadius + zone.blendRadius;
      let pairedSectorContributes = false;
      if (profile.bankSectors?.length && radius < effectRadius) {
        for (const sector of profile.bankSectors) {
          if (sector.outerRadius === undefined) continue;
          const difference = Math.abs(angle - sector.bearing);
          const distance = Math.min(difference, 2 * Math.PI - difference);
          if (
            distance < sector.halfWidth &&
            1 - helpers.smoothstep(distance / sector.halfWidth) > 0
          ) {
            pairedSectorContributes = true;
            break;
          }
        }
      }
      if (pairedSectorContributes) {
        // Cache the actual underlying owner only if a contributing span needs
        // it. This may include authored core/floor/union grades, not just noise.
        let underlyingHeight: number | undefined;
        const heights = {
          underlying(): number {
            if (underlyingHeight === undefined)
              underlyingHeight = getUnderlyingHeight();
            return underlyingHeight;
          },
          legacy(): number {
            if (radius <= profile.bankOuterRadius) {
              const progress = Math.min(
                1,
                (radius - profile.bedRadius) /
                  (profile.bankInnerRadius - profile.bedRadius),
              );
              return (
                zone.height +
                (profile.bankHeight - zone.height) *
                  helpers.smoothstep(progress)
              );
            }
            const progress =
              (radius - profile.bankOuterRadius) / zone.blendRadius;
            return (
              profile.bankHeight +
              (heights.underlying() - profile.bankHeight) *
                helpers.smoothstep(progress)
            );
          },
        };
        let weightSum = 0;
        let weightedHeight = 0;
        for (const sector of profile.bankSectors!) {
          const difference = Math.abs(angle - sector.bearing);
          const distance = Math.min(difference, 2 * Math.PI - difference);
          if (distance >= sector.halfWidth) continue;
          const weight = 1 - helpers.smoothstep(distance / sector.halfWidth);
          if (weight <= 0) continue;
          let sectorHeight: number;
          if (
            sector.outerRadius !== undefined &&
            sector.outerHeight !== undefined
          ) {
            if (radius > sector.outerRadius) {
              const progress =
                (radius - sector.outerRadius) /
                (effectRadius - sector.outerRadius);
              sectorHeight =
                sector.outerHeight +
                (heights.underlying() - sector.outerHeight) *
                  helpers.smoothstep(progress);
            } else {
              const beforeKnot = radius < sector.innerRadius;
              const startRadius = beforeKnot
                ? profile.bedRadius
                : sector.innerRadius;
              const endRadius = beforeKnot
                ? sector.innerRadius
                : sector.outerRadius;
              const startHeight = beforeKnot ? zone.height : sector.innerHeight;
              const endHeight = beforeKnot
                ? sector.innerHeight
                : sector.outerHeight;
              sectorHeight =
                startHeight +
                (endHeight - startHeight) *
                  helpers.smoothstep(
                    (radius - startRadius) / (endRadius - startRadius),
                  );
            }
          } else if (radius < profile.bankOuterRadius) {
            // A four-field sector keeps its existing arithmetic inside the
            // bank and rejoins the existing outer blend, never a new plateau.
            const beforeKnot = radius < sector.innerRadius;
            const startRadius = beforeKnot
              ? profile.bedRadius
              : sector.innerRadius;
            const endRadius = beforeKnot
              ? sector.innerRadius
              : profile.bankOuterRadius;
            const startHeight = beforeKnot ? zone.height : sector.innerHeight;
            const endHeight = beforeKnot
              ? sector.innerHeight
              : profile.bankHeight;
            sectorHeight =
              startHeight +
              (endHeight - startHeight) *
                helpers.smoothstep(
                  (radius - startRadius) / (endRadius - startRadius),
                );
          } else sectorHeight = heights.legacy();
          weightSum += weight;
          weightedHeight += weight * sectorHeight;
        }
        // Angular weights remain a convex blend. A raised outer shoulder can
        // roll down into the real grade; water crossings are validated against
        // the selected pond, not inferred from global radial monotonicity.
        return weightSum >= 1
          ? weightedHeight / weightSum
          : heights.legacy() * (1 - weightSum) + weightedHeight;
      }
      // Preserve the historical four-field branch and callback laziness exactly
      // when no paired sector contributes at this point.
      if (profile.bankSectors?.length && radius < profile.bankOuterRadius) {
        const legacyProgress = Math.min(
          1,
          (radius - profile.bedRadius) /
            (profile.bankInnerRadius - profile.bedRadius),
        );
        const legacyHeight =
          zone.height +
          (profile.bankHeight - zone.height) *
            helpers.smoothstep(legacyProgress);
        let weightSum = 0;
        let weightedHeight = 0;
        for (const sector of profile.bankSectors) {
          const difference = Math.abs(angle - sector.bearing);
          const distance = Math.min(difference, 2 * Math.PI - difference);
          if (distance >= sector.halfWidth) continue;
          const weight = 1 - helpers.smoothstep(distance / sector.halfWidth);
          const beforeKnot = radius < sector.innerRadius;
          const startRadius = beforeKnot
            ? profile.bedRadius
            : sector.innerRadius;
          const endRadius = beforeKnot
            ? sector.innerRadius
            : profile.bankOuterRadius;
          const startHeight = beforeKnot ? zone.height : sector.innerHeight;
          const endHeight = beforeKnot
            ? sector.innerHeight
            : profile.bankHeight;
          const sectorHeight =
            startHeight +
            (endHeight - startHeight) *
              helpers.smoothstep(
                (radius - startRadius) / (endRadius - startRadius),
              );
          weightSum += weight;
          weightedHeight += weight * sectorHeight;
        }
        // Preserve exact historical arithmetic outside every authored sector.
        if (weightSum > 0) {
          return weightSum > 1
            ? weightedHeight / weightSum
            : legacyHeight * (1 - weightSum) + weightedHeight;
        }
      }
      if (radius < profile.bankInnerRadius) {
        const progress =
          (radius - profile.bedRadius) /
          (profile.bankInnerRadius - profile.bedRadius);
        const weight = helpers.smoothstep(progress);
        return zone.height + (profile.bankHeight - zone.height) * weight;
      }
      if (radius <= profile.bankOuterRadius) return profile.bankHeight;
      if (radius >= effectRadius) return null;
      const progress = (radius - profile.bankOuterRadius) / zone.blendRadius;
      const weight = helpers.smoothstep(progress);
      return (
        profile.bankHeight +
        (getUnderlyingHeight() - profile.bankHeight) * weight
      );
    },

    resolveDuelArenaFloorHeight(zone, x, z, baseHeight) {
      const dx = Math.abs(x - zone.centerX);
      const dz = Math.abs(z - zone.centerZ);
      const halfWidth = zone.width / 2;
      const halfDepth = zone.depth / 2;
      if (dx <= halfWidth && dz <= halfDepth) return zone.height;
      if (
        zone.blendRadius <= 0 ||
        dx > halfWidth + zone.blendRadius ||
        dz > halfDepth + zone.blendRadius
      ) {
        return null;
      }
      const factor = Math.max(
        0,
        (dx - halfWidth) / zone.blendRadius,
        (dz - halfDepth) / zone.blendRadius,
      );
      return (
        zone.height + (baseHeight - zone.height) * helpers.smoothstep(factor)
      );
    },

    resolveHeight(
      zones,
      x,
      z,
      getProceduralHeight,
      arenaFloorIds,
      arenaGradeHeight,
    ) {
      let radialZone: FlatZone | null = null;
      let radialDistance = Infinity;
      let coreZone: FlatZone | null = null;
      let coreDistance = Infinity;
      let blendZone: FlatZone | null = null;
      let blendFactor = Infinity;
      let hasSmoothUnion = false;
      let arenaFloorHeight: number | null = null;

      for (const zone of zones) {
        if (arenaGradeHeight !== null && arenaFloorIds.has(zone.id)) {
          const height = operations.resolveDuelArenaFloorHeight(
            zone,
            x,
            z,
            arenaGradeHeight,
          );
          if (height !== null) {
            arenaFloorHeight =
              arenaFloorHeight === null
                ? height
                : Math.max(arenaFloorHeight, height);
          }
          continue;
        }
        if (zone.radialPond) {
          const distance = Math.hypot(x - zone.centerX, z - zone.centerZ);
          if (
            distance < zone.radialPond.bankOuterRadius + zone.blendRadius &&
            distance < radialDistance
          ) {
            radialZone = zone;
            radialDistance = distance;
          }
          continue;
        }
        const distance = helpers.coreDistance(zone, x, z);
        if (distance !== null) {
          if (distance < coreDistance) {
            coreZone = zone;
            coreDistance = distance;
          }
          continue;
        }
        const factor = helpers.blendFactor(zone, x, z);
        if (factor !== null && zone.blendComposition === "smooth-union")
          hasSmoothUnion = true;
        if (factor !== null && factor < blendFactor) {
          blendZone = zone;
          blendFactor = factor;
        }
      }

      const underlying = {
        getHeight(): number {
          if (arenaFloorHeight !== null) return arenaFloorHeight;
          if (coreZone) return coreZone.height;
          const proceduralHeight = getProceduralHeight();
          if (!blendZone) return proceduralHeight;
          if (hasSmoothUnion) {
            // Preserve original target-height selection and all core/floor/pond
            // priorities. Only equal-datum opted-in influences multiply. The
            // legacy cohort keeps its original minimum rather than being
            // globally reinterpreted when a distant candidate is registered.
            let legacyOutside = 1;
            let unionOutside = 1;
            for (const zone of zones) {
              if (
                zone.height !== blendZone.height ||
                zone.radialPond ||
                (arenaGradeHeight !== null && arenaFloorIds.has(zone.id))
              )
                continue;
              const factor = helpers.blendFactor(zone, x, z);
              if (factor === null) continue;
              const outside = helpers.smoothstep(factor);
              if (zone.blendComposition === "smooth-union")
                unionOutside *= outside;
              else legacyOutside = Math.min(legacyOutside, outside);
            }
            // An absent/noncontributing option uses the exact original path.
            // At a union boundary its factor reaches one with zero derivative.
            if (unionOutside !== 1)
              return (
                blendZone.height +
                (proceduralHeight - blendZone.height) *
                  (legacyOutside * unionOutside)
              );
          }
          return (
            blendZone.height +
            (proceduralHeight - blendZone.height) *
              helpers.smoothstep(blendFactor)
          );
        },
      };
      if (radialZone) {
        const radialHeight = operations.resolveRadialPondTerrainHeight(
          radialZone,
          x,
          z,
          underlying.getHeight,
        );
        if (radialHeight !== null) return radialHeight;
      }
      if (arenaFloorHeight !== null) return arenaFloorHeight;
      if (coreZone) return coreZone.height;
      if (blendZone) return underlying.getHeight();
      return null;
    },

    isGrassExcluded(zones, x, z) {
      for (const zone of zones) {
        // An allowed broad grade never overrides a separate station/floor pad.
        if (zone.excludeGrass === false) continue;
        if (zone.grassExclusionBounds) {
          const bounds = zone.grassExclusionBounds;
          if (
            x >= bounds.minX &&
            x <= bounds.maxX &&
            z >= bounds.minZ &&
            z <= bounds.maxZ
          )
            return true;
          continue;
        }
        if (zone.radialPond) {
          if (
            Math.hypot(x - zone.centerX, z - zone.centerZ) <
            zone.radialPond.bankOuterRadius + zone.blendRadius
          ) {
            return true;
          }
          continue;
        }
        if (
          helpers.coreDistance(zone, x, z) !== null ||
          helpers.blendFactor(zone, x, z) !== null
        ) {
          return true;
        }
      }
      return false;
    },
  };
  return operations;
}
