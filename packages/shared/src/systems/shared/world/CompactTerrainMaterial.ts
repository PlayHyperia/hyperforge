import THREE, {
  texture,
  positionWorld,
  normalWorldGeometry,
  cameraViewMatrix,
  float,
  vec2,
  vec3,
  vec4,
  mix,
  max,
  normalize,
  smoothstep,
} from "../../../extras/three/three";
import type { Node, TextureNode } from "three/webgpu";
import {
  COMPACT_TERRAIN_COMPOSITION,
  type CompactTerrainMacroField,
} from "./CompactTerrainPalette";
import compactTerrainTextureDigests from "../../../data/compact-terrain-textures.json";

export const COMPACT_TERRAIN_MATERIAL = {
  id: "compact-pbr-v1",
  textureSize: 1024,
  // Rock Face 03's published physical width; grass/dirt have separate scales.
  repeatsPerMeter: 1 / 2.7,
  textureCount: 6,
  surfaceSampleCount: 14,
  // Grass004 source covers approximately 1.4m; projection variation stays ±18%.
  grassRepeatsPerMeter: 1 / 1.4,
  dirtRepeatsPerMeter: 0.95,
  groundPatternBands: 32,
  groundPatternBlendStart: 0.18,
  groundPatternBlendEnd: 0.82,
  groundPatternScaleVariation: 0.18,
  normalFadeNear: 45,
  normalFadeFar: 120,
  minimumRoughness: 0.65,
  aoStrength: 0.35,
  loadTimeoutMs: 20_000,
  dirtNormalStrength: 0.25,
  rockNormalStrength: 0.4,
} as const;
export const COMPACT_TERRAIN_BITMAP_OPTIONS = {
  imageOrientation: "flipY",
  premultiplyAlpha: "none",
  colorSpaceConversion: "none",
} as const;

// Paired with the lossless packing manifest: stale CDN maps fail admission.
export const COMPACT_TERRAIN_TEXTURE_SHA256 = Object.freeze({
  ...compactTerrainTextureDigests,
});

const LAYERS = ["grass", "dirt", "rock"] as const;
const CHANNELS = ["albedo-roughness", "normal-ao"] as const;
type Layer = (typeof LAYERS)[number];
type Channel = (typeof CHANNELS)[number];
type Key = `${Layer}-${Channel}`;
type Entry = {
  key: Key;
  url: string;
  node: TextureNode<"vec4">;
  status: "idle" | "loading" | "loaded" | "error" | "disposed";
  error: string | null;
  width: number;
  height: number;
  sha256: string | null;
};

/** Six per-material textures, never global or shared between world lifetimes. */
export class CompactTerrainTextureSet {
  readonly id = COMPACT_TERRAIN_MATERIAL.id;
  private readonly entries = new Map<Key, Entry>();
  private readonly pending = new Map<Key, { cancel(): void }>();
  private promise: Promise<void> | null = null;
  private disposed = false;

  constructor(cdnUrl: string) {
    for (const layer of LAYERS) {
      for (const channel of CHANNELS) {
        const key: Key = `${layer}-${channel}`;
        const fallback =
          channel === "normal-ao"
            ? [128, 128, 255, 255]
            : layer === "grass"
              ? [100, 112, 52, 235]
              : [110, 95, 74, 230];
        const image = new THREE.DataTexture(
          new Uint8Array(fallback),
          1,
          1,
          THREE.RGBAFormat,
        );
        this.configureTexture(image, channel);
        this.entries.set(key, {
          key,
          url: `${cdnUrl.replace(/\/$/, "")}/terrain/textures/compact-pbr/${key}.png`,
          node: texture(image),
          status: "idle",
          error: null,
          width: 1,
          height: 1,
          sha256: null,
        });
      }
    }
  }

  getReceipt() {
    const textures = [...this.entries.values()].map((entry) => ({
      key: entry.key,
      url: entry.url,
      status: entry.status,
      error: entry.error,
      width: entry.width,
      height: entry.height,
      sha256: entry.sha256,
      textureUuid: entry.node.value.uuid,
      colorSpace: entry.node.value.colorSpace,
      flipY: entry.node.value.flipY,
      premultiplyAlpha: entry.node.value.premultiplyAlpha,
    }));
    return {
      id: this.id,
      status: this.disposed
        ? "disposed"
        : textures.some((entry) => entry.status === "error")
          ? "error"
          : textures.every((entry) => entry.status === "loaded")
            ? "ready"
            : this.promise
              ? "loading"
              : "idle",
      textures,
      surfaceSampleCount: COMPACT_TERRAIN_MATERIAL.surfaceSampleCount,
      bitmapOptions: { ...COMPACT_TERRAIN_BITMAP_OPTIONS },
    };
  }

  getNode(layer: Layer, channel: Channel): TextureNode<"vec4"> {
    return this.entries.get(`${layer}-${channel}`)!.node;
  }

  private configureTexture(image: THREE.Texture, channel: Channel): void {
    image.colorSpace =
      channel === "albedo-roughness"
        ? THREE.SRGBColorSpace
        : THREE.NoColorSpace;
    image.wrapS = image.wrapT = THREE.RepeatWrapping;
    image.magFilter = THREE.LinearFilter;
    image.minFilter = THREE.LinearMipmapLinearFilter;
    image.generateMipmaps = true;
    // Bitmap decode performs the single Y flip. Explicitly disable a second
    // WebGPU copy flip, and never premultiply packed roughness/AO into RGB.
    image.flipY = false;
    image.premultiplyAlpha = false;
    image.needsUpdate = true;
  }

  private installTexture(
    entry: Entry,
    image: THREE.Texture,
    sha256: string,
  ): boolean {
    if (this.disposed || entry.status !== "loading") {
      this.disposeTexture(image);
      return false;
    }
    if (sha256 !== COMPACT_TERRAIN_TEXTURE_SHA256[entry.key]) {
      this.disposeTexture(image);
      throw new Error(`Compact terrain texture digest mismatch: ${entry.key}`);
    }
    const source = image.image as
      { width?: number; height?: number } | undefined;
    if (
      source?.width !== COMPACT_TERRAIN_MATERIAL.textureSize ||
      source.height !== COMPACT_TERRAIN_MATERIAL.textureSize
    ) {
      this.disposeTexture(image);
      throw new Error(
        `Invalid compact terrain texture dimensions: ${entry.key}`,
      );
    }
    this.configureTexture(
      image,
      entry.key.endsWith("normal-ao") ? "normal-ao" : "albedo-roughness",
    );
    const previous = entry.node.value;
    // TextureNode.sample() retains a reference to this base node, so every
    // projection follows the new real texture; never stuff an HTML image into
    // a DataTexture or leave a sampled clone pointing at the placeholder.
    entry.node.value = image;
    entry.width = source.width;
    entry.height = source.height;
    entry.sha256 = sha256;
    entry.status = "loaded";
    this.disposeTexture(previous);
    return true;
  }

  load(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Compact terrain textures disposed"));
    if (this.promise) return this.promise;
    const jobs = [...this.entries.values()].map(
      (entry) =>
        new Promise<void>((resolve, reject) => {
          entry.status = "loading";
          const abort = new AbortController();
          const fail = (error: Error) => {
            if (entry.status !== "loading") return;
            entry.status = "error";
            entry.error = error.message;
            abort.abort();
            clearTimeout(timeout);
            this.pending.delete(entry.key);
            reject(error);
          };
          const timeout = setTimeout(
            () =>
              fail(
                new Error(`Compact terrain texture timed out: ${entry.key}`),
              ),
            COMPACT_TERRAIN_MATERIAL.loadTimeoutMs,
          );
          this.pending.set(entry.key, {
            cancel: () =>
              fail(
                new Error(
                  `Compact terrain texture loading cancelled: ${entry.key}`,
                ),
              ),
          });
          const decode = async () => {
            const response = await fetch(entry.url, {
              signal: abort.signal,
              credentials: "omit",
            });
            if (!response.ok)
              throw new Error(
                `Compact terrain texture HTTP ${response.status}: ${entry.key}`,
              );
            const blob = await response.blob();
            if (blob.size > 16 * 1024 * 1024)
              throw new Error(
                `Compact terrain texture exceeds size budget: ${entry.key}`,
              );
            const bytes = await blob.arrayBuffer();
            const digest = await globalThis.crypto.subtle.digest(
              "SHA-256",
              bytes,
            );
            const sha256 = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            if (sha256 !== COMPACT_TERRAIN_TEXTURE_SHA256[entry.key]) {
              throw new Error(
                `Compact terrain texture digest mismatch: ${entry.key}`,
              );
            }
            const bitmap = await globalThis.createImageBitmap(
              blob,
              COMPACT_TERRAIN_BITMAP_OPTIONS,
            );
            return { image: new THREE.Texture(bitmap), sha256 };
          };
          decode().then(
            ({ image, sha256 }) => {
              try {
                if (!this.installTexture(entry, image, sha256)) return;
                clearTimeout(timeout);
                this.pending.delete(entry.key);
                resolve();
              } catch (error) {
                fail(
                  error instanceof Error
                    ? error
                    : new Error(
                        `Invalid compact terrain texture: ${entry.key}`,
                      ),
                );
              }
            },
            (error: unknown) =>
              fail(
                error instanceof Error
                  ? error
                  : new Error(
                      `Compact terrain texture failed to load: ${entry.key}`,
                    ),
              ),
          );
        }),
    );
    this.promise = Promise.allSettled(jobs).then((results) => {
      if (this.disposed)
        throw new Error("Compact terrain textures disposed while loading");
      if (results.some((result) => result.status === "rejected")) {
        throw new Error(
          "Compact terrain PBR texture admission failed; inspect compactTerrainSurface.getReceipt()",
        );
      }
    });
    return this.promise;
  }

  private disposeTexture(image: THREE.Texture): void {
    image.dispose();
    const source = image.image as { close?: () => void } | undefined;
    source?.close?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.cancel();
    this.pending.clear();
    for (const entry of this.entries.values()) {
      this.disposeTexture(entry.node.value);
      entry.status = "disposed";
    }
  }
}

export type CompactTerrainLayer = {
  albedo: Node<"vec3">;
  roughness: Node<"float">;
  ao: Node<"float">;
  worldNormal: Node<"vec3">;
};

/**
 * Broad dry-meadow reflectance variation using the already sampled world noise.
 * This is an art-directed linear-albedo tint, not a lighting bake or a new PBR
 * scan. Normals, roughness and AO retain the original grass layer references.
 */
export function applyCompactMeadowTint(
  grass: CompactTerrainLayer,
  noise: Node<"float">,
  macroDry: Node<"float"> = float(0),
): CompactTerrainLayer {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const dryness = mix(
    float(c.meadowDryLow),
    float(c.meadowDryHigh),
    smoothstep(float(c.meadowDryStart), float(c.meadowDryEnd), noise),
  );
  return {
    ...grass,
    albedo: grass.albedo.mul(
      mix(
        mix(
          vec3(c.meadowFreshRed, c.meadowFreshGreen, c.meadowFreshBlue),
          vec3(c.meadowDryRed, c.meadowDryGreen, c.meadowDryBlue),
          dryness,
        ),
        vec3(c.macroDryRed, c.macroDryGreen, c.macroDryBlue),
        macroDry,
      ),
    ),
  };
}

/**
 * Colour-only ridge field in admitted profile coordinates. One sine and four
 * smoothsteps here, one slope transition in layer weights, no new texture fetch.
 * Noise only perturbs the soft shoulder;
 * there are no height contours, discrete cells or camera-dependent regions.
 */
export function createCompactTerrainMacroWeights(
  worldXZ: Node<"vec2">,
  noise: Node<"float">,
  field: CompactTerrainMacroField | null,
) {
  if (!field) return { dry: float(0), westRock: float(0) };
  const c = COMPACT_TERRAIN_COMPOSITION;
  const ax = worldXZ.x.sub(field.centerX).mul(field.scale);
  const az = worldXZ.y.sub(field.centerZ).mul(field.scale);
  const progress = az
    .sub(field.ridgeStartZ)
    .mul(1 / (field.ridgeEndZ - field.ridgeStartZ))
    .clamp(0, 1);
  const cross = ax.sub(
    float(field.ridgeBaseX).sub(
      progress.mul(Math.PI).sin().mul(field.ridgeBend),
    ),
  );
  const ends = smoothstep(
    float(field.ridgeStartZ),
    float(field.ridgeStartZ + field.ridgeEndFade),
    az,
  ).mul(
    float(1).sub(
      smoothstep(
        float(field.ridgeEndZ - field.ridgeEndFade),
        float(field.ridgeEndZ),
        az,
      ),
    ),
  );
  const west = cross.mul(-1 / field.ridgeWestWidth);
  const across = max(cross.mul(1 / field.ridgeEastWidth), west);
  const shoulder = ends.mul(
    float(1).sub(
      smoothstep(
        float(c.macroShoulderStart),
        float(c.macroShoulderEnd),
        across.add(noise.sub(0.5).mul(c.macroBoundaryNoise)),
      ),
    ),
  );
  return {
    dry: shoulder,
    westRock: shoulder.mul(
      smoothstep(float(c.macroWestStart), float(c.macroWestEnd), west),
    ),
  };
}

/** Same constants/arithmetic as the serializable CPU grass palette factory. */
export function createCompactTerrainLayerWeights(
  noise: Node<"float">,
  geometricSlope: Node<"float">,
  rawRoadInfluence: Node<"float">,
  edgeNoise: Node<"float"> = float(0.5),
  pondSurface: { soil: Node<"float">; wetness: Node<"float"> } = {
    soil: float(0),
    wetness: float(0),
  },
  macroSurface: { dry: Node<"float">; westRock: Node<"float"> } = {
    dry: float(0),
    westRock: float(0),
  },
) {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const slope = geometricSlope.clamp(0, 1);
  const patch = smoothstep(float(c.patchStart), float(c.patchEnd), noise)
    .mul(smoothstep(float(c.flatStart), float(c.flatEnd), slope))
    .mul(c.patchStrength);
  const slopeDirt = smoothstep(
    float(c.slopeDirtStart),
    float(c.slopeDirtPeak),
    slope,
  )
    .mul(smoothstep(float(c.slopeDirtEnd), float(c.slopeDirtFall), slope))
    .mul(c.slopeDirtStrength);
  const wornEdge = edgeNoise
    .sub(0.5)
    .mul(c.pathEdgeNoiseContrast)
    .add(0.5)
    .clamp(0, 1);
  return {
    dirt: float(1).sub(
      float(1)
        .sub(patch)
        .mul(float(1).sub(slopeDirt))
        .mul(float(1).sub(macroSurface.dry.mul(c.macroSoilStrength)))
        .mul(float(1).sub(pondSurface.soil)),
    ),
    cliff: max(
      smoothstep(float(c.cliffStart), float(c.cliffEnd), slope),
      macroSurface.westRock.mul(
        smoothstep(
          float(c.macroRockSlopeStart),
          float(c.macroRockSlopeEnd),
          slope,
        ),
      ),
    ).mul(float(1).sub(pondSurface.soil)),
    road: smoothstep(
      mix(float(c.pathEdgeStartLow), float(c.pathEdgeStartHigh), wornEdge),
      mix(float(c.pathEdgeEndLow), float(c.pathEdgeEndHigh), wornEdge),
      rawRoadInfluence,
    ),
    variation: mix(float(c.variationLow), float(c.variationHigh), noise),
  };
}

/** Existing coastal mineral surface only; does not change grass eligibility. */
export function createCompactCoastWeights(
  world: Node<"vec3">,
  noiseValue: Node<"float">,
  edgeNoise: Node<"float">,
  westRock: Node<"float">,
  field: CompactTerrainMacroField | null,
) {
  if (!field) return { soil: float(0), wetness: float(0) };
  const c = COMPACT_TERRAIN_COMPOSITION;
  const noise = noiseValue.clamp(0, 1),
    edge = edgeNoise.clamp(0, 1);
  const relative = world.y
    .sub(field.seaLevel)
    .div(field.baseElevation - field.seaLevel);
  const coverage = float(1).sub(
    smoothstep(
      mix(float(c.coastFadeStartLow), float(c.coastFadeStartHigh), noise),
      mix(float(c.coastFadeEndLow), float(c.coastFadeEndHigh), noise),
      relative,
    ),
  );
  const delta = vec2(world.x.sub(field.centerX), world.z.sub(field.centerZ));
  const direction = delta.x
    .mul(field.headlandDirectionX)
    .add(delta.y.mul(field.headlandDirectionZ))
    .div(delta.length().max(1e-6));
  const headland = smoothstep(
    float(field.headlandOuterCos),
    float(field.headlandInnerCos),
    direction,
  );
  const patch = smoothstep(
    float(c.coastPatchStart),
    float(c.coastPatchEnd),
    noise.add(edge.sub(0.5).mul(c.coastEdgeNoise)),
  );
  return {
    soil: coverage
      .mul(mix(float(c.coastSoilLow), float(c.coastSoilHigh), patch))
      .mul(float(1).sub(headland.mul(c.coastHeadlandRock)))
      .mul(float(1).sub(westRock.clamp(0, 1).mul(c.coastRidgeRock))),
    wetness: float(1).sub(
      smoothstep(
        float(c.coastWetStart),
        mix(float(c.coastWetEndLow), float(c.coastWetEndHigh), edge),
        relative,
      ),
    ),
  };
}

/** Reuse soil/rock maps together; never tint grass or full path/pond overrides. */
export function applyCompactCoastRock(
  rock: CompactTerrainLayer,
  soil: CompactTerrainLayer,
  coast: { soil: Node<"float">; wetness: Node<"float"> },
): CompactTerrainLayer {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const roughness = mix(rock.roughness, soil.roughness, coast.soil);
  return {
    albedo: mix(rock.albedo, soil.albedo, coast.soil).mul(
      mix(float(1), float(c.coastWetAlbedo), coast.wetness),
    ),
    roughness: mix(
      roughness,
      roughness.min(c.coastWetRoughness),
      coast.wetness,
    ),
    ao: mix(rock.ao, soil.ao, coast.soil),
    worldNormal: normalize(mix(rock.worldNormal, soil.worldNormal, coast.soil)),
  };
}

/** World-space localized soil/wetness; pond = centerX, centerZ, radius, waterY. */
export function createCompactPondSurfaceWeights(
  world: Node<"vec3">,
  noise: Node<"float">,
  pond: Node<"vec4">,
) {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const radial = vec2(world.x.sub(pond.x), world.z.sub(pond.y)).length();
  const end = pond.z.add(c.pondBankReach);
  const region = float(1).sub(
    smoothstep(end.sub(c.pondRadialFade), end, radial),
  );
  const height = world.y.sub(pond.w);
  const noiseHeight = noise.sub(0.5).mul(2 * c.pondBankNoiseHeight);
  return {
    soil: region.mul(
      float(1).sub(
        smoothstep(
          noiseHeight.add(c.pondSoilFullHeight),
          noiseHeight.add(c.pondSoilEndHeight),
          height,
        ),
      ),
    ),
    wetness: region.mul(
      float(1).sub(
        smoothstep(
          float(c.pondWetFullHeight),
          float(c.pondWetEndHeight),
          height,
        ),
      ),
    ),
  };
}

export function applyCompactPondWetness(
  surface: ReturnType<typeof blendCompactTerrainLayers>,
  wetness: Node<"float">,
) {
  return {
    ...surface,
    albedo: surface.albedo.mul(
      mix(float(1), float(COMPACT_TERRAIN_COMPOSITION.pondWetAlbedo), wetness),
    ),
    roughness: mix(
      surface.roughness,
      surface.roughness.min(COMPACT_TERRAIN_COMPOSITION.pondWetRoughness),
      wetness,
    ),
  };
}

/**
 * Two noise-selected projections share one smooth transition. At every band
 * boundary the outgoing B projection is exactly the incoming A projection.
 * Gradients exclude the discrete selection/offset: implicit derivatives across
 * a band would select false coarse mip levels and corrupt the normal frame.
 * See NVIDIA GPU Gems, chapter 20, "Texture Bombing", filtering discussion.
 */
export function createCompactGroundProjections(
  worldXZ: Node<"vec2">,
  patternNoise: Node<"float">,
  repeatsPerMeter: number,
  worldDx: Node<"vec2"> = worldXZ.dFdx(),
  worldDy: Node<"vec2"> = worldXZ.dFdy(),
) {
  const c = COMPACT_TERRAIN_MATERIAL;
  const selector = patternNoise.mul(c.groundPatternBands);
  const index = selector.floor();
  const project = (id: Node<"float">) => {
    const angle = id.mul(2.399963229728653);
    const cosine = angle.cos(),
      sine = angle.sin();
    const scale = id
      .mul(1.61803398875)
      .sin()
      .mul(c.groundPatternScaleVariation)
      .add(1)
      .mul(repeatsPerMeter);
    const rotate = (value: Node<"vec2">) =>
      vec2(
        value.x.mul(cosine).sub(value.y.mul(sine)),
        value.x.mul(sine).add(value.y.mul(cosine)),
      ).mul(scale);
    const offset = vec2(id.mul(3.17).sin(), id.mul(7.13).sin()).mul(17);
    return {
      uv: rotate(worldXZ).add(offset),
      dx: rotate(worldDx),
      dy: rotate(worldDy),
    };
  };
  return {
    a: project(index),
    b: project(index.add(1)),
    weight: smoothstep(
      float(c.groundPatternBlendStart),
      float(c.groundPatternBlendEnd),
      selector.fract(),
    ),
  };
}

/**
 * Derivative cotangent frame from THIS projection's UVs, not geometry.uv.
 * Uses the geometric normal to avoid normalNode -> normalWorld recursion.
 * Neutral normal texels preserve that normal on all axes, including mirrored
 * projections; degenerate edge-on projections have a bounded zero tangent.
 */
export function createCompactProjectedNormal(
  encoded: Node<"vec3">,
  uv: Node<"vec2">,
  strength: Node<"float">,
): Node<"vec3"> {
  return createCompactCotangentNormal(
    encoded,
    normalWorldGeometry,
    positionWorld.dFdx(),
    positionWorld.dFdy(),
    uv.dFdx(),
    uv.dFdy(),
    strength,
  );
}

/** Explicit derivative inputs also permit real arithmetic-node regression tests. */
export function createCompactCotangentNormal(
  encoded: Node<"vec3">,
  n: Node<"vec3">,
  q0: Node<"vec3">,
  q1: Node<"vec3">,
  st0: Node<"vec2">,
  st1: Node<"vec2">,
  strength: Node<"float">,
): Node<"vec3"> {
  const q1perp = q1.cross(n);
  const q0perp = n.cross(q0);
  const tangent = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
  const bitangent = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
  const scale = max(tangent.dot(tangent), bitangent.dot(bitangent))
    .max(1e-12)
    .inverseSqrt();
  const unpacked = encoded.mul(2).sub(1);
  return normalize(
    tangent
      .mul(scale)
      .mul(unpacked.x)
      .mul(strength)
      .add(bitangent.mul(scale).mul(unpacked.y).mul(strength))
      .add(n.mul(unpacked.z.max(0.001))),
  );
}

export function createCompactTerrainLayers(
  textures: CompactTerrainTextureSet,
  distanceSquared: Node<"float">,
  patternNoise: Node<"float"> = float(0.5),
): Record<Layer, CompactTerrainLayer> {
  const controls = COMPACT_TERRAIN_MATERIAL;
  const flatUV = vec2(positionWorld.x, positionWorld.z).mul(
    controls.repeatsPerMeter,
  );
  const sideUV = vec2(positionWorld.z, positionWorld.y).mul(
    controls.repeatsPerMeter,
  );
  const frontUV = vec2(positionWorld.x, positionWorld.y).mul(
    controls.repeatsPerMeter,
  );
  const nearDetail = float(1).sub(
    smoothstep(
      float(controls.normalFadeNear ** 2),
      float(controls.normalFadeFar ** 2),
      distanceSquared,
    ),
  );
  const project = (
    layer: Layer,
    uv: Node<"vec2">,
    normalStrength: number,
    gradients?: { dx: Node<"vec2">; dy: Node<"vec2"> },
  ): CompactTerrainLayer => {
    const sample = (channel: Channel) => {
      const base = textures.getNode(layer, channel);
      return gradients
        ? base.grad(gradients.dx, gradients.dy).sample(uv)
        : base.sample(uv);
    };
    const ar = sample("albedo-roughness");
    const na = sample("normal-ao");
    return {
      albedo: ar.rgb,
      roughness: ar.a.max(controls.minimumRoughness),
      ao: mix(float(1), na.a, float(controls.aoStrength)),
      worldNormal: createCompactCotangentNormal(
        na.rgb,
        normalWorldGeometry,
        positionWorld.dFdx(),
        positionWorld.dFdy(),
        gradients?.dx ?? uv.dFdx(),
        gradients?.dy ?? uv.dFdy(),
        nearDetail.mul(normalStrength),
      ),
    };
  };
  const ground = (
    layer: "grass" | "dirt",
    repeats: number,
    normalStrength: number,
  ): CompactTerrainLayer => {
    const p = createCompactGroundProjections(
      vec2(positionWorld.x, positionWorld.z),
      patternNoise,
      repeats,
    );
    const a = project(layer, p.a.uv, normalStrength, p.a);
    const b = project(layer, p.b.uv, normalStrength, p.b);
    return {
      albedo: mix(a.albedo, b.albedo, p.weight),
      roughness: mix(a.roughness, b.roughness, p.weight),
      ao: mix(a.ao, b.ao, p.weight),
      worldNormal: normalize(mix(a.worldNormal, b.worldNormal, p.weight)),
    };
  };
  const weights = normalWorldGeometry.abs().pow(vec3(4));
  const normalizedWeights = weights.div(
    weights.x.add(weights.y).add(weights.z).max(1e-12),
  );
  const sides = [
    project("rock", sideUV, controls.rockNormalStrength),
    project("rock", flatUV, controls.rockNormalStrength),
    project("rock", frontUV, controls.rockNormalStrength),
  ];
  const blendVector = (
    a: Node<"vec3">,
    b: Node<"vec3">,
    c: Node<"vec3">,
  ): Node<"vec3"> =>
    a
      .mul(normalizedWeights.x)
      .add(b.mul(normalizedWeights.y))
      .add(c.mul(normalizedWeights.z));
  const blendScalar = (
    a: Node<"float">,
    b: Node<"float">,
    c: Node<"float">,
  ): Node<"float"> =>
    a
      .mul(normalizedWeights.x)
      .add(b.mul(normalizedWeights.y))
      .add(c.mul(normalizedWeights.z));
  return {
    grass: ground("grass", controls.grassRepeatsPerMeter, 1),
    dirt: ground(
      "dirt",
      controls.dirtRepeatsPerMeter,
      controls.dirtNormalStrength,
    ),
    rock: {
      albedo: blendVector(sides[0].albedo, sides[1].albedo, sides[2].albedo),
      roughness: blendScalar(
        sides[0].roughness,
        sides[1].roughness,
        sides[2].roughness,
      ),
      ao: blendScalar(sides[0].ao, sides[1].ao, sides[2].ao),
      worldNormal: normalize(
        blendVector(
          sides[0].worldNormal,
          sides[1].worldNormal,
          sides[2].worldNormal,
        ),
      ),
    },
  };
}

export function blendCompactTerrainLayers(
  layers: Record<Layer, CompactTerrainLayer>,
  dirt: Node<"float">,
  cliff: Node<"float">,
  road: Node<"float">,
) {
  const blendVector = (
    grass: Node<"vec3">,
    ground: Node<"vec3">,
    rock: Node<"vec3">,
  ): Node<"vec3"> =>
    mix(mix(mix(grass, ground, dirt), rock, cliff), ground, road);
  const blendScalar = (
    grass: Node<"float">,
    ground: Node<"float">,
    rock: Node<"float">,
  ): Node<"float"> =>
    mix(mix(mix(grass, ground, dirt), rock, cliff), ground, road);
  return {
    albedo: blendVector(
      layers.grass.albedo,
      layers.dirt.albedo,
      layers.rock.albedo,
    ),
    roughness: blendScalar(
      layers.grass.roughness,
      layers.dirt.roughness,
      layers.rock.roughness,
    ),
    ao: blendScalar(layers.grass.ao, layers.dirt.ao, layers.rock.ao),
    normal: compactTerrainNormalToView(
      blendVector(
        layers.grass.worldNormal,
        layers.dirt.worldNormal,
        layers.rock.worldNormal,
      ),
    ),
  };
}

/** Matrix-first TSL multiplication converts world normals into view space. */
export function compactTerrainNormalToView(
  worldNormal: Node<"vec3">,
  viewMatrix: Node<"mat4"> = cameraViewMatrix,
): Node<"vec3"> {
  // Vector-first transformDirection uses the inverse camera rotation; it can
  // turn upward terrain normals away from the light in a steep overhead view.
  return viewMatrix.mul(vec4(normalize(worldNormal), 0)).xyz.normalize();
}
