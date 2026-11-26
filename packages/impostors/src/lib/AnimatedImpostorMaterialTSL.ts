/**
 * Animated Impostor Material (WebGPU/TSL)
 *
 * TSL material for rendering animated octahedral impostors.
 * Uses texture array sampling with frame index for animation.
 *
 * Features:
 * - Vertex shader: billboarding + octahedral sprite selection
 * - Fragment shader: texture array sampling with frame modulo
 */

import * as THREE from "three/webgpu";
import {
  texture,
  uniform,
  Fn,
  positionLocal,
  uv,
  cameraPosition,
  vec3,
  vec2,
  vec4,
  float,
  dot,
  normalize,
  cross,
  mix,
  step,
  floor,
  abs,
  sign,
  min,
  round,
  clamp,
  Discard,
  If,
  select,
  varying,
} from "three/tsl";
import type { AnimatedImpostorMaterialConfig } from "./types";

/**
 * TSL uniform node type with value property
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLUniform<T> = ReturnType<typeof uniform> & { value: T };

/**
 * Uniforms exposed by the animated impostor material
 */
export interface AnimatedImpostorUniforms {
  /** @deprecated Use spritesX and spritesY for asymmetric grids */
  spritesPerSide: TSLUniform<number>;
  /** Number of horizontal sprites (columns) */
  spritesX: TSLUniform<number>;
  /** Number of vertical sprites (rows) */
  spritesY: TSLUniform<number>;
  alphaClamp: TSLUniform<number>;
  frameIndex: TSLUniform<number>;
  frameCount: TSLUniform<number>;
  globalScale: TSLUniform<number>;
  flipYFlag: TSLUniform<number>;
}

/**
 * Extended material type with animated impostor uniforms
 */
export type AnimatedImpostorMaterial = THREE.MeshStandardNodeMaterial & {
  animatedImpostorUniforms: AnimatedImpostorUniforms;
};

/**
 * Create an animated impostor material using TSL for WebGPU.
 *
 * @param arrayTexture - The DataArrayTexture containing all animation frames
 * @param config - Material configuration
 * @returns MeshStandardNodeMaterial with animated impostor support
 */
export function createAnimatedImpostorMaterial(
  arrayTexture: THREE.DataArrayTexture,
  config: AnimatedImpostorMaterialConfig,
): AnimatedImpostorMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.transparent = config.transparent ?? true;
  material.metalness = 0.0;
  material.roughness = 0.7;

  // Support asymmetric grids (more horizontal than vertical views)
  // Backwards compatible: if only spritesPerSide is provided, use it for both
  const spritesXVal =
    (config as { spritesX?: number }).spritesX ?? config.spritesPerSide ?? 16;
  const spritesYVal =
    (config as { spritesY?: number }).spritesY ?? config.spritesPerSide ?? 8;

  // Uniforms (separate X and Y for asymmetric grids)
  const spritesX = uniform(spritesXVal);
  const spritesY = uniform(spritesYVal);
  const alphaClamp = uniform(config.alphaClamp ?? 0.05);
  const useHemiOctahedron = uniform(config.hemisphere ? 1 : 0);
  const frameIndex = uniform(0);
  const frameCount = uniform(config.frameCount);
  const globalScale = uniform(config.scale ?? 1);
  const flipYFlag = uniform(config.flipY ? 1 : 0);

  // Varyings
  const vSprite = varying(vec2(), "vSprite");
  const vSpriteUV = varying(vec2(), "vSpriteUV");

  // Vertex: billboarding + octahedral sprite selection (asymmetric grid)
  material.positionNode = Fn(() => {
    const spritesMinusOneX = spritesX.sub(1.0);
    const spritesMinusOneY = spritesY.sub(1.0);

    const cameraPosLocal = cameraPosition; // impostor at origin in local
    const cameraDir = normalize(
      vec3(cameraPosLocal.x, cameraPosLocal.y, cameraPosLocal.z),
    );

    const up = vec3(0.0, 1.0, 0.0).toVar();
    If(useHemiOctahedron, () => {
      up.assign(mix(up, vec3(-1.0, 0.0, 0.0), step(0.999, cameraDir.y)));
    }).Else(() => {
      up.assign(mix(up, vec3(-1.0, 0.0, 0.0), step(0.999, cameraDir.y)));
      up.assign(mix(up, vec3(1.0, 0.0, 0.0), step(cameraDir.y, -0.999)));
    });

    const tangent = normalize(cross(up, cameraDir));
    const bitangent = cross(cameraDir, tangent);
    const projectedVertex = tangent
      .mul(positionLocal.x.mul(globalScale))
      .add(bitangent.mul(positionLocal.y.mul(globalScale)));

    const grid = vec2().toVar();
    If(useHemiOctahedron, () => {
      const octahedron = cameraDir.div(dot(cameraDir, sign(cameraDir)));
      grid.assign(
        vec2(octahedron.x.add(octahedron.z), octahedron.z.sub(octahedron.x))
          .add(1.0)
          .mul(0.5),
      );
    }).Else(() => {
      const dir = cameraDir.div(dot(abs(cameraDir), vec3(1.0))).toVar();
      If(dir.y.lessThan(0.0), () => {
        const signNotZero = vec2(
          select(dir.x.lessThan(0.0), float(-1.0), float(1.0)),
          select(dir.z.lessThan(0.0), float(-1.0), float(1.0)),
        );
        const oldX = dir.x;
        dir.x.assign(float(1.0).sub(abs(dir.z)).mul(signNotZero.x));
        dir.z.assign(float(1.0).sub(abs(oldX)).mul(signNotZero.y));
      });
      grid.assign(dir.xz.mul(0.5).add(0.5));
    });

    // Asymmetric grid: scale X by spritesX, Y by spritesY
    const spriteGridX = grid.x.mul(spritesMinusOneX);
    const spriteGridY = grid.y.mul(spritesMinusOneY);
    const spriteX = min(round(spriteGridX), spritesMinusOneX);
    const spriteY = min(round(spriteGridY), spritesMinusOneY);
    vSprite.assign(vec2(spriteX, spriteY));
    vSpriteUV.assign(uv());

    return vec4(projectedVertex, 1.0);
  })();

  // Fragment: sample array layer by frameIndex (asymmetric cell sizes)
  material.colorNode = Fn(() => {
    const frameSizeX = float(1.0).div(spritesX);
    const frameSizeY = float(1.0).div(spritesY);
    const uvY = mix(vSpriteUV.y, float(1.0).sub(vSpriteUV.y), flipYFlag);
    const localUV = vec2(vSpriteUV.x, uvY);
    // Calculate UV with asymmetric cell sizes
    const finalUV = vec2(
      frameSizeX.mul(vSprite.x.add(clamp(localUV.x, float(0), float(1)))),
      frameSizeY.mul(vSprite.y.add(clamp(localUV.y, float(0), float(1)))),
    );

    // Wrap frame index to frame count
    const wrappedFrame = floor(frameIndex.mod(frameCount));

    // Sample the texture array at the frame layer
    // For DataArrayTexture, use texture(tex, uv).depth(layer)
    // Pass wrappedFrame as float - TSL should convert internally for WGSL
    const spriteColor = texture(arrayTexture, finalUV).depth(wrappedFrame);

    If(spriteColor.a.lessThanEqual(alphaClamp), () => {
      Discard();
    });

    return spriteColor;
  })();

  // Store uniforms for runtime updates
  // Cast to extended type for property assignment
  const animatedMaterial = material as AnimatedImpostorMaterial;
  animatedMaterial.animatedImpostorUniforms = {
    spritesPerSide: spritesX, // Backwards compatible (uses X)
    spritesX,
    spritesY,
    alphaClamp,
    frameIndex,
    frameCount,
    globalScale,
    flipYFlag,
  };

  return animatedMaterial;
}

/**
 * Instanced animated impostor uniforms for per-instance rendering
 */
export interface InstancedAnimatedImpostorUniforms {
  /** @deprecated Use spritesX and spritesY for asymmetric grids */
  spritesPerSide: { value: number };
  /** Number of horizontal sprites (columns) */
  spritesX: { value: number };
  /** Number of vertical sprites (rows) */
  spritesY: { value: number };
  alphaClamp: { value: number };
  frameIndex: { value: number };
  frameCount: { value: number };
  globalScale: { value: number };
  flipYFlag: { value: number };
  yawSpriteOffset: { value: number };
}

/**
 * Extended material type for instanced animated impostors
 */
export type InstancedAnimatedImpostorMaterial =
  THREE.MeshStandardNodeMaterial & {
    instancedAnimatedUniforms: InstancedAnimatedImpostorUniforms;
    instanceStateStorage: ReturnType<typeof import("three/tsl").storage>;
    instanceOffsetStorage: ReturnType<typeof import("three/tsl").storage>;
    instanceVariantStorage: ReturnType<typeof import("three/tsl").storage>;
  };

/**
 * Configuration for instanced animated impostor material
 */
export interface InstancedAnimatedMaterialConfig extends AnimatedImpostorMaterialConfig {
  instanceCount: number;
  variantCounts?: number[]; // Frame counts per variant
  variantBases?: number[]; // Base layer indices per variant
}
