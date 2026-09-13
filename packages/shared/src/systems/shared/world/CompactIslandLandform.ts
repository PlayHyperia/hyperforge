import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import { createCompactHavenShoulder } from "./CompactHavenShoulder";

/**
 * Art-directed compact island, independent of biome noise height functions.
 * Worker emission supplies the shoulder factory explicitly, with no module
 * closure or bundler helpers in the resulting worker source.
 * Broad navigable meadow, western ridge and low headlands share a continuous
 * seabed. This is authored shaping plus detail, not an erosion simulation.
 */
export function createCompactIslandLandform(
  shoulderFactory = createCompactHavenShoulder,
) {
  const shoulder = shoulderFactory();
  const helpers = {
    smooth(value: number): number {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    },

    hill(
      x: number,
      z: number,
      cx: number,
      cz: number,
      rx: number,
      rz: number,
    ): number {
      const dx = (x - cx) / rx;
      const dz = (z - cz) / rz;
      return this.smooth(1 - Math.sqrt(dx * dx + dz * dz));
    },
  };

  return {
    mask(
      worldX: number,
      worldZ: number,
      noise: { simplex2D(x: number, z: number): number },
      profile: WorldTerrainProfile,
    ): number {
      const island = profile.island;
      const x = worldX - island.centerX;
      const z = worldZ - island.centerZ;
      const angle = Math.atan2(z, x);
      const authored =
        profile.algorithm === "compact-island-sculpt-v2" ||
        profile.algorithm === "compact-island-sculpt-v3" ||
        profile.algorithm === "compact-island-sculpt-v4" ||
        profile.algorithm === "compact-island-sculpt-v5"
          ? profile.landform
          : undefined;
      if (
        (profile.algorithm === "compact-island-sculpt-v2" ||
          profile.algorithm === "compact-island-sculpt-v3" ||
          profile.algorithm === "compact-island-sculpt-v4" ||
          profile.algorithm === "compact-island-sculpt-v5") &&
        !authored
      )
        throw new Error(
          "Authored sculpt requires admitted landform parameters",
        );
      const headland = authored
        ? authored.westHeadlandStrength *
          helpers.smooth(
            (Math.cos(angle - authored.westHeadlandBearing) -
              Math.cos(authored.westHeadlandHalfWidth)) /
              (1 - Math.cos(authored.westHeadlandHalfWidth)),
          )
        : 0;
      // Periodic angular terms avoid a seam at +/-pi. The same coast controls
      // geometry and water classification, not a separate visual-only mask.
      const variation = Math.max(
        -island.maxCoastVariation,
        Math.min(
          island.maxCoastVariation,
          0.065 * Math.sin(3 * angle + 0.4) +
            0.035 * Math.cos(5 * angle - 1.1) +
            0.018 * noise.simplex2D(Math.cos(angle) * 4, Math.sin(angle) * 4) +
            headland,
        ),
      );
      const coast = island.radius * (1 + variation);
      const t = Math.max(
        0,
        Math.min(
          1,
          (Math.hypot(x, z) - coast + island.falloff) / island.falloff,
        ),
      );
      const coastMask =
        1 - helpers.smooth(Math.pow(t, island.beachProfilePower / 3));
      if (!authored || coastMask === 0) return coastMask;
      // Inward-only open bay: it can remove land, never extend the admitted
      // positive coast envelope. Smooth tip and banks join the same seabed.
      const scale = 165 / island.radius;
      const c = Math.cos(authored.inletBearing),
        s = Math.sin(authored.inletBearing);
      const along = (x * c + z * s) * scale;
      if (
        profile.algorithm === "compact-island-sculpt-v3" ||
        profile.algorithm === "compact-island-sculpt-v4" ||
        profile.algorithm === "compact-island-sculpt-v5"
      ) {
        const bay = profile.bay;
        if (!bay) throw new Error("Sculpt-v3 requires admitted bay parameters");
        // A half-ellipse closes the inner tip. Squared longitudinal distance
        // gives its banks zero longitudinal slope at the widening-channel join.
        // A smooth centerline bend and width share the same progress, keeping
        // |centerline| + halfWidth <= the existing +/- inletHalfWidth envelope.
        const capEnd = authored.inletTipDistance + authored.inletTipTransition;
        const mouth = 165 * (1 + island.maxCoastVariation);
        const progress = helpers.smooth((along - capEnd) / (mouth - capEnd));
        const centerline = bay.centerlineBend * (1 - progress);
        const halfWidth =
          bay.innerHalfWidth +
          (authored.inletHalfWidth - bay.innerHalfWidth) * progress;
        const cross = ((-x * s + z * c) * scale - centerline) / halfWidth;
        const cap = Math.max(0, (capEnd - along) / authored.inletTipTransition);
        const distance = Math.hypot(cap, cross);
        // Continuous side blending avoids a seam through the rounded head when
        // unequal bank softness is applied; no hard left/right branch in height.
        const bankScale =
          bay.leftBankScale +
          (bay.rightBankScale - bay.leftBankScale) *
            helpers.smooth((cross + 1) / 2);
        const bank = (authored.inletBankTransition * bankScale) / halfWidth;
        const bite = helpers.smooth((1 - distance) / bank);
        return coastMask * (1 - bite);
      }
      const across = Math.abs((-x * s + z * c) * scale);
      const bite =
        helpers.smooth(
          (along - authored.inletTipDistance) / authored.inletTipTransition,
        ) *
        helpers.smooth(
          (authored.inletHalfWidth - across) / authored.inletBankTransition,
        );
      return coastMask * (1 - bite);
    },

    height(
      worldX: number,
      worldZ: number,
      noise: { simplex2D(x: number, z: number): number },
      profile: WorldTerrainProfile,
    ): number {
      const mask = this.mask(worldX, worldZ, noise, profile);
      if (mask === 0) return profile.water.oceanFloorHeight;
      const dx = worldX - profile.island.centerX;
      const dz = worldZ - profile.island.centerZ;
      const x = dx / profile.island.radius;
      const z = dz / profile.island.radius;
      // Put the highest relief beside, not beneath, the existing work/duel
      // campus. Its explicit functional grades remain authoritative overlays.
      const legacyRidge = helpers.hill(x, z, -0.59, 0.02, 0.31, 0.69);
      let ridgeHeight = profile.height.terrainScale * legacyRidge;
      let terraceDelta = 0;
      if (
        profile.algorithm === "compact-island-sculpt-v2" ||
        profile.algorithm === "compact-island-sculpt-v3" ||
        profile.algorithm === "compact-island-sculpt-v4" ||
        profile.algorithm === "compact-island-sculpt-v5"
      ) {
        const authored = profile.landform;
        if (!authored)
          throw new Error(
            "Authored sculpt requires admitted landform parameters",
          );
        const ax = x * 165,
          az = z * 165;
        const progress = Math.max(
          0,
          Math.min(
            1,
            (az - authored.ridgeStartZ) /
              (authored.ridgeEndZ - authored.ridgeStartZ),
          ),
        );
        const spineX =
          authored.ridgeBaseX -
          authored.ridgeBend * Math.sin(Math.PI * progress);
        const cross = ax - spineX;
        const width =
          cross < 0 ? authored.ridgeWestWidth : authored.ridgeEastWidth;
        const ends =
          helpers.smooth((az - authored.ridgeStartZ) / authored.ridgeEndFade) *
          helpers.smooth((authored.ridgeEndZ - az) / authored.ridgeEndFade);
        ridgeHeight =
          authored.ridgeHeight *
          helpers.smooth(1 - Math.abs(cross) / width) *
          ends;
        if (
          profile.algorithm === "compact-island-sculpt-v4" ||
          profile.algorithm === "compact-island-sculpt-v5"
        ) {
          const terrace = profile.terrace;
          if (!terrace)
            throw new Error("Sculpt-v4 requires admitted terrace parameters");
          if (
            az > terrace.startZ &&
            az < terrace.endZ &&
            ax < terrace.eastPreservationEnd &&
            cross > terrace.westFoot
          ) {
            const scarpEnd = terrace.crestEnd + terrace.scarpRun;
            const shelfEnd = scarpEnd + terrace.shelfWidth;
            let sculptedCross = cross;
            let ridgeScale = 1;
            const breakup =
              profile.algorithm === "compact-island-sculpt-v5"
                ? profile.ridgeBreakup
                : undefined;
            if (profile.algorithm === "compact-island-sculpt-v5" && !breakup)
              throw new Error("Sculpt-v5 requires admitted ridge breakup");
            if (breakup) {
              // Two compact, non-overlapping saddles split the long face into
              // distinct outcrops. Smooth endpoints retain the shared heightfield.
              const north =
                1 -
                helpers.smooth(
                  Math.abs(az - breakup.northGapZ) / breakup.northGapHalfWidth,
                );
              const south =
                1 -
                helpers.smooth(
                  Math.abs(az - breakup.southGapZ) / breakup.southGapHalfWidth,
                );
              ridgeScale =
                (1 - breakup.northGapDepth * north) *
                (1 - breakup.southGapDepth * south);
              const phase = az * ((Math.PI * 2) / breakup.warpWavelength);
              const warp =
                breakup.lateralWarp *
                (0.65 * Math.sin(phase) + 0.35 * Math.sin(phase * 0.61 + 1.3));
              // Warp fades at the original foot/apron. It cannot introduce a
              // height jump at the old domain boundary or move the coast mask.
              sculptedCross -=
                warp *
                helpers.smooth((cross - terrace.westFoot) / 8) *
                (1 - helpers.smooth((cross - shelfEnd) / terrace.apronWidth));
            }
            let terracedHeight: number;
            if (sculptedCross < terrace.crestStart) {
              terracedHeight =
                terrace.crestHeight *
                helpers.smooth(
                  (sculptedCross - terrace.westFoot) /
                    (terrace.crestStart - terrace.westFoot),
                );
            } else if (sculptedCross <= terrace.crestEnd) {
              terracedHeight = terrace.crestHeight;
            } else if (sculptedCross < scarpEnd) {
              terracedHeight =
                terrace.crestHeight +
                (terrace.shelfHeight - terrace.crestHeight) *
                  helpers.smooth(
                    (sculptedCross - terrace.crestEnd) / terrace.scarpRun,
                  );
            } else if (sculptedCross <= shelfEnd) {
              terracedHeight = terrace.shelfHeight;
            } else {
              terracedHeight =
                terrace.shelfHeight *
                (1 -
                  helpers.smooth(
                    (sculptedCross - shelfEnd) / terrace.apronWidth,
                  ));
            }
            if (breakup) {
              const face =
                helpers.smooth((sculptedCross - terrace.crestEnd) / 2.5) *
                (1 - helpers.smooth((sculptedCross - scarpEnd) / 3));
              terracedHeight =
                terracedHeight * ridgeScale +
                breakup.facetRelief *
                  face *
                  (0.45 + 0.55 * ridgeScale) *
                  noise.simplex2D(
                    ax * breakup.facetScale,
                    az * breakup.facetScale * 0.75,
                  );
            }
            const originalCross =
              authored.ridgeHeight *
              helpers.smooth(1 - Math.abs(cross) / width);
            terraceDelta =
              (terracedHeight - originalCross) *
              ends *
              helpers.smooth((az - terrace.startZ) / terrace.endFade) *
              helpers.smooth((terrace.endZ - az) / terrace.endFade) *
              (1 -
                helpers.smooth(
                  (ax - terrace.eastPreservationStart) /
                    (terrace.eastPreservationEnd -
                      terrace.eastPreservationStart),
                ));
          }
        }
      }
      const northernKnoll = helpers.hill(x, z, 0.3, -0.66, 0.3, 0.27);
      const easternGrove = helpers.hill(x, z, 0.56, -0.13, 0.24, 0.38);
      const southernHeadland = helpers.hill(x, z, -0.21, 0.62, 0.44, 0.32);
      const detailScale = profile.height.featureScale;
      const detail =
        0.55 *
          noise.simplex2D(dx * 0.025 * detailScale, dz * 0.025 * detailScale) +
        0.18 *
          noise.simplex2D(dx * 0.065 * detailScale, dz * 0.065 * detailScale);
      const interior =
        profile.algorithm === "compact-island-sculpt-v2" ||
        profile.algorithm === "compact-island-sculpt-v3" ||
        profile.algorithm === "compact-island-sculpt-v4" ||
        profile.algorithm === "compact-island-sculpt-v5"
          ? profile.height.baseOffset +
            ridgeHeight +
            profile.height.terrainScale *
              (northernKnoll * 0.38 +
                easternGrove * 0.27 +
                southernHeadland * 0.32) +
            detail
          : profile.height.baseOffset +
            profile.height.terrainScale *
              (legacyRidge +
                northernKnoll * 0.38 +
                easternGrove * 0.27 +
                southernHeadland * 0.32) +
            detail;
      // Unlike multiplication around zero, interpolation reaches the seabed
      // continuously, with zero coast-end slope and no height discontinuity.
      const height =
        profile.water.oceanFloorHeight +
        (interior - profile.water.oceanFloorHeight) * mask;
      // Preserve the original evaluation exactly outside the compact delta.
      // A steep heightfield is not itself an impassable navigation collider.
      const base = terraceDelta === 0 ? height : height + terraceDelta * mask;
      if (!profile.havenShoulder) return base;
      const shaped = shoulder.sample(
        worldX,
        worldZ,
        base,
        profile.havenShoulder,
      );
      // Keep any admitted modifier continuous at the coast, including edited
      // profiles. At Haven's interior mask=1, this preserves authored arithmetic.
      return mask === 1 ? shaped : base + (shaped - base) * mask;
    },
  };
}

/** Both factories must travel together into a fresh worker realm. */
export function buildCompactIslandLandformJS(): string {
  return `(${createCompactIslandLandform.toString()})(${createCompactHavenShoulder.toString()})`;
}
