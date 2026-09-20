import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import { createCompactHavenShoulder } from "./CompactHavenShoulder";
import { createCompactCoastalApron } from "./CompactCoastalApron";

/** A bounded inland height recipe in world metres; it never replaces the coast. */
export type CompactSouthernMeadow = Readonly<{
  schemaVersion: 1;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  featherX: number;
  featherZ: number;
  northHeight: number;
  southHeight: number;
  crossFall: number;
  rollAmplitude: number;
  rollWavelength: number;
}>;

/** Self-contained admission and allocation-free sampling for worker emission. */
export function createCompactSouthernMeadow() {
  const operations = {
    fail(field: string): never {
      throw new Error(`Invalid compact southern meadow: ${field}`);
    },
    smooth(value: number): number {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    },
    validate(input: unknown): CompactSouthernMeadow {
      const names = [
        "minX",
        "maxX",
        "minZ",
        "maxZ",
        "featherX",
        "featherZ",
        "northHeight",
        "southHeight",
        "crossFall",
        "rollAmplitude",
        "rollWavelength",
      ] as const;
      if (!input || typeof input !== "object" || Array.isArray(input))
        return operations.fail("record");
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null)
        operations.fail("prototype");
      const expected = ["schemaVersion", ...names];
      const keys = Reflect.ownKeys(input);
      if (
        keys.length !== expected.length ||
        keys.some((key) => typeof key !== "string" || !expected.includes(key))
      )
        operations.fail("keys");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (expected.some((key) => !("value" in descriptors[key])))
        operations.fail("own data fields");
      if (descriptors.schemaVersion.value !== 1)
        operations.fail("schemaVersion");
      const numbers = Object.fromEntries(
        names.map((key) => {
          const value: unknown = descriptors[key].value;
          if (typeof value !== "number" || !Number.isFinite(value))
            return operations.fail("finite number");
          return [key, value === 0 ? 0 : value];
        }),
      ) as Omit<CompactSouthernMeadow, "schemaVersion">;
      const p: CompactSouthernMeadow = Object.freeze({
        schemaVersion: 1,
        ...numbers,
      });
      if (
        p.maxX - p.minX < 80 ||
        p.maxZ - p.minZ < 80 ||
        p.featherX < 20 ||
        p.featherZ < 20 ||
        p.featherX > (p.maxX - p.minX) / 3 ||
        p.featherZ > (p.maxZ - p.minZ) / 3 ||
        Math.abs(p.northHeight - p.southHeight) > 8 ||
        Math.abs(p.crossFall) > 3 ||
        p.rollAmplitude < 0 ||
        p.rollAmplitude > 1.5 ||
        p.rollWavelength < 64 ||
        p.rollWavelength > 240
      )
        operations.fail("broad support/height ranges");
      return p;
    },
    validateSupport(
      p: CompactSouthernMeadow,
      profile: WorldTerrainProfile,
    ): void {
      const ridge = profile.terrace;
      // Stay east of the authored ridge's preservation edge. No profile edit
      // can turn this bounded meadow into a replacement for that landmark.
      const ridgeEast = ridge
        ? profile.island.centerX +
          (ridge.eastPreservationEnd * profile.island.radius) / 165
        : Infinity;
      if (
        p.minX < profile.bounds.minX ||
        p.maxX > profile.bounds.maxX ||
        p.minZ < profile.bounds.minZ ||
        p.maxZ > profile.bounds.maxZ ||
        p.minX < ridgeEast ||
        Math.min(p.northHeight, p.southHeight) -
          Math.abs(p.crossFall) -
          p.rollAmplitude <=
          profile.water.threshold ||
        Math.max(p.northHeight, p.southHeight) +
          Math.abs(p.crossFall) +
          p.rollAmplitude >
          profile.height.maxHeightParameter
      )
        operations.fail("support/height envelope");
    },
    sample(
      x: number,
      z: number,
      base: number,
      noise: { simplex2D(x: number, z: number): number },
      p: CompactSouthernMeadow,
    ): number {
      if (x <= p.minX || x >= p.maxX || z <= p.minZ || z >= p.maxZ) return base;
      const weight =
        operations.smooth((x - p.minX) / p.featherX) *
        operations.smooth((p.maxX - x) / p.featherX) *
        operations.smooth((z - p.minZ) / p.featherZ) *
        operations.smooth((p.maxZ - z) / p.featherZ);
      const u = (x - p.minX) / (p.maxX - p.minX);
      const v = (z - p.minZ) / (p.maxZ - p.minZ);
      // A connected full-width low meadow, not a flattened path or an isolated
      // mound. One long-wave seeded roll avoids repeated parallel embankments.
      const target =
        p.northHeight +
        (p.southHeight - p.northHeight) * operations.smooth(v) -
        p.crossFall * operations.smooth(u) +
        p.rollAmplitude *
          noise.simplex2D(
            (x - p.minX) / p.rollWavelength,
            (z - p.minZ) / p.rollWavelength,
          );
      return base + (target - base) * weight;
    },
  };
  return operations;
}

/**
 * Art-directed compact island, independent of biome noise height functions.
 * Worker emission supplies all authored modifier factories, with no module
 * closure or bundler helpers in the resulting worker source.
 * Broad navigable meadow, western ridge and low headlands share a continuous
 * seabed. This is authored shaping plus detail, not an erosion simulation.
 */
export function createCompactIslandLandform(
  shoulderFactory = createCompactHavenShoulder,
  coastalApronFactory = createCompactCoastalApron,
  southernMeadowFactory = createCompactSouthernMeadow,
) {
  const shoulder = shoulderFactory();
  const coastalApron = coastalApronFactory();
  const southernMeadow = southernMeadowFactory();
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
        if (!profile.coastalApron) return coastMask * (1 - bite);
        // Replace the shared bay factor BEFORE the height path's zero-mask
        // return. A late height overlay would remain clipped by the old seabed.
        // q is an authoring coordinate, not an exact Euclidean signed distance.
        return (
          coastMask *
          coastalApron.blendBay(
            worldX,
            worldZ,
            halfWidth * (distance - 1),
            1 - bite,
            profile.coastalApron,
            coastMask,
          )
        );
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
      const meadowInterior = profile.southernMeadow
        ? southernMeadow.sample(
            worldX,
            worldZ,
            interior + terraceDelta,
            noise,
            profile.southernMeadow,
          )
        : undefined;
      const height =
        profile.water.oceanFloorHeight +
        (interior - profile.water.oceanFloorHeight) * mask;
      // Preserve the original evaluation exactly outside the compact delta.
      // A steep heightfield is not itself an impassable navigation collider.
      const unshapedBase =
        meadowInterior === undefined ||
        meadowInterior === interior + terraceDelta
          ? terraceDelta === 0
            ? height
            : height + terraceDelta * mask
          : profile.water.oceanFloorHeight +
            (meadowInterior - profile.water.oceanFloorHeight) * mask;
      // The optional dry head notch belongs to the canonical heightfield, so
      // terrain, grass and physics workers all receive the same surface. Its
      // floor remains above the shoreline band; it does not reshape the mask.
      const base = profile.coastalApron?.headShoulder
        ? coastalApron.sampleHead(
            worldX,
            worldZ,
            unshapedBase,
            profile.coastalApron,
          )
        : unshapedBase;
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

/** All factories travel together into a fresh worker realm. */
export function buildCompactIslandLandformJS(): string {
  return `(${createCompactIslandLandform.toString()})(${createCompactHavenShoulder.toString()},${createCompactCoastalApron.toString()},${createCompactSouthernMeadow.toString()})`;
}
