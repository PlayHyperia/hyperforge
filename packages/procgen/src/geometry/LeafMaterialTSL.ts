/**
 * Instanced Leaf Material - WebGPU TSL Version
 *
 * Uses Three.js TSL (Three Shading Language) for WebGPU compatibility.
 * Supports instanced rendering with quaternion-based rotation.
 *
 * Features:
 * - Instanced rendering with custom orientation attribute
 * - Quaternion-based rotation for leaf orientation
 * - Procedural leaf alpha shapes (elliptic, ovate, maple, oak, palm, needle)
 * - Per-instance color variation
 * - Responds to scene lights (ambient, directional) via MeshStandardNodeMaterial
 * - Subsurface scattering simulation via emissive with sun direction sync
 */

import * as THREE from "three";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import type { MeshStandardNodeMaterial as MeshStandardNodeMaterialType } from "three/webgpu";
import {
  Fn,
  uv,
  positionLocal,
  instanceIndex,
  attribute,
  uniform,
  float,
  vec3,
  add,
  sub,
  mul,
  dot,
  abs,
  fract,
  sin,
  cos,
  max,
  min,
  normalize,
  cross,
  smoothstep,
  mix,
  select,
  sign,
  sqrt,
  atan,
  floor,
  cameraPosition,
  positionWorld,
  normalWorld,
} from "three/tsl";

/** Leaf shape types for procedural generation */
export type TSLLeafShape =
  "elliptic" | "ovate" | "maple" | "oak" | "palm" | "needle";

/** Options for TSL instanced leaf material */
export type TSLInstancedLeafMaterialOptions = {
  color?: THREE.Color;
  colorVariation?: number;
  alphaTest?: number;
  opacity?: number;
  side?: THREE.Side;
  leafShape?: TSLLeafShape;
  subsurfaceScatter?: number;
  windStrength?: number;
  time?: number;
};

/** TSL Instanced Leaf Material type with update methods */
export type TSLInstancedLeafMaterial = MeshStandardNodeMaterialType & {
  leafUniforms: {
    color: { value: THREE.Color };
    colorVariation: { value: number };
    alphaTest: { value: number };
    opacity: { value: number };
    subsurface: { value: number };
    windStrength: { value: number };
    time: { value: number };
    sunDirection: { value: THREE.Vector3 };
    dayNightMix: { value: number };
  };
  /** Update time for wind animation */
  updateTime: (time: number) => void;
  /** Update lighting parameters for day/night cycle */
  updateLighting: (sunDir: THREE.Vector3, dayMix: number) => void;
};

/**
 * Create a WebGPU TSL instanced leaf material.
 * Supports quaternion-based instance rotation and procedural leaf shapes.
 * Uses MeshStandardNodeMaterial to respond to scene lights (ambient, directional).
 */
export function createInstancedLeafMaterialTSL(
  options: TSLInstancedLeafMaterialOptions = {},
): TSLInstancedLeafMaterial {
  const {
    color = new THREE.Color(0x3d7a3d),
    colorVariation = 0.15,
    alphaTest = 0.5,
    opacity = 1.0,
    side = THREE.DoubleSide,
    leafShape = "elliptic",
    subsurfaceScatter = 0.3,
    windStrength = 0.0,
  } = options;

  // Create material - use MeshStandardNodeMaterial to respond to scene lights
  const material = new MeshStandardNodeMaterial();
  material.side = side;
  material.transparent = false; // Use alpha cutout via alphaTestNode, not transparency
  material.roughness = 0.75; // Matte leaf surface
  material.metalness = 0.0; // Non-metallic
  material.envMapIntensity = 0.2; // Reduce environment reflections

  // ========== UNIFORMS ==========
  const uColor = uniform(color);
  const uColorVariation = uniform(colorVariation);
  const uAlphaTest = uniform(alphaTest);
  const uOpacity = uniform(opacity);
  const uSubsurface = uniform(subsurfaceScatter);
  const uWindStrength = uniform(windStrength);
  const uTime = uniform(0);
  // Lighting uniforms for day/night sync
  const uSunDirection = uniform(new THREE.Vector3(0.5, 1.0, 0.3).normalize());
  const uDayNightMix = uniform(1.0); // 1.0 = full day, 0.0 = night

  // ========== HELPER FUNCTIONS ==========

  // Hash function for randomness
  const hash = Fn(([n]: [Node<"float">]) => {
    return fract(mul(sin(n), 43758.5453123));
  });

  // Hash3 for color variation
  const hash3 = Fn(([n]: [Node<"float">]) => {
    return vec3(hash(n), hash(add(n, 127.1)), hash(add(n, 269.5)));
  });

  // Quaternion rotation: rotate vector v by quaternion q
  const rotateByQuat = Fn(([v, q]: [Node<"vec3">, Node<"vec4">]) => {
    const qxyz = vec3(q.x, q.y, q.z);
    const t = mul(2.0, cross(qxyz, v));
    return add(v, add(mul(q.w, t), cross(qxyz, t)));
  });

  // ========== LEAF SHAPE FUNCTIONS ==========

  // Elliptic leaf shape - improved with proper taper and serration
  const leafShapeElliptic = Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, 0.5);
    const py = sub(uvCoord.y, 0.35);

    // Normalized Y position (0 at stem, 1 at tip)
    const normalizedY = add(mul(py, 1.4), 0.45);

    // Width profile - widest at ~40%, tapers toward tip
    const widthProfile = mul(
      smoothstep(0.0, 0.35, normalizedY),
      sub(1.0, smoothstep(0.35, 1.0, normalizedY)),
    );
    const baseTaper = add(0.25, mul(widthProfile, 0.75));

    // Pointed tip taper
    const tipTaper = smoothstep(0.6, 0.95, normalizedY);
    const effectiveWidth = mul(baseTaper, sub(1.0, mul(tipTaper, 0.65)));

    // Subtle serration on edges
    const serration = mul(
      sin(mul(normalizedY, 28.0)),
      mul(0.06, sub(1.0, tipTaper)),
    );

    // Calculate leaf boundary
    const maxHalfWidth = add(mul(effectiveWidth, 0.42), serration);
    const insideWidth = sub(
      1.0,
      smoothstep(mul(maxHalfWidth, 0.85), maxHalfWidth, abs(px)),
    );

    // Length mask
    const lengthMask = mul(
      smoothstep(-0.1, 0.08, normalizedY),
      smoothstep(1.02, 0.88, normalizedY),
    );

    return mul(insideWidth, lengthMask);
  });

  // Ovate leaf shape - egg-shaped, wider at base
  const leafShapeOvate = Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, 0.5);
    const py = sub(uvCoord.y, 0.3);

    // Normalized Y (0 at stem, 1 at tip)
    const normalizedY = add(mul(py, 1.3), 0.4);

    // Ovate profile - wider at bottom third, tapers toward tip
    const baseWidth = smoothstep(0.0, 0.25, normalizedY);
    const topTaper = sub(1.0, smoothstep(0.25, 1.0, normalizedY));
    const widthProfile = mul(baseWidth, add(0.3, mul(topTaper, 0.7)));

    // Strong tip taper for pointed end
    const tipTaper = smoothstep(0.55, 0.9, normalizedY);
    const effectiveWidth = mul(widthProfile, sub(1.0, mul(tipTaper, 0.75)));

    // Subtle waviness on edges
    const waviness = mul(
      sin(mul(normalizedY, 22.0)),
      mul(0.05, effectiveWidth),
    );

    // Calculate leaf boundary
    const maxHalfWidth = add(mul(effectiveWidth, 0.48), waviness);
    const insideWidth = sub(
      1.0,
      smoothstep(mul(maxHalfWidth, 0.8), maxHalfWidth, abs(px)),
    );

    // Length mask
    const lengthMask = mul(
      smoothstep(-0.12, 0.06, normalizedY),
      smoothstep(1.0, 0.85, normalizedY),
    );

    return mul(insideWidth, lengthMask);
  });

  // Maple leaf shape - 5 pointed lobes with serrated edges
  const leafShapeMaple = Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, 0.5);
    const py = sub(uvCoord.y, 0.45);

    // Convert to polar for lobe calculation
    const r = sqrt(add(mul(px, px), mul(py, py)));
    const angle = atan(py, px);

    // 5 pointed lobes - maple has 5 main points
    const lobeCount = float(5.0);
    // Offset angle so center lobe points up
    const lobeAngle = add(angle, mul(3.14159, 0.5));
    const lobePhase = mul(lobeAngle, lobeCount);

    // Sharp pointed lobes using abs(cos) with power for sharpness
    const lobeRaw = abs(cos(mul(lobePhase, 0.5)));
    const lobeShape = mul(lobeRaw, lobeRaw); // Square for sharper points

    // Lobe radius varies - longer at the 5 main points
    const baseRadius = float(0.25);
    const lobeExtend = mul(0.25, lobeShape);
    const targetRadius = add(baseRadius, lobeExtend);

    // Add serrated edges to the lobes
    const serration = mul(sin(mul(lobeAngle, 25.0)), mul(0.03, lobeShape));
    const finalRadius = add(targetRadius, serration);

    // Inside/outside test with soft edge
    const insideLeaf = sub(
      1.0,
      smoothstep(mul(finalRadius, 0.85), finalRadius, r),
    );

    // Stem notch at bottom
    const stemNotch = mul(
      smoothstep(0.3, 0.35, uvCoord.y),
      add(
        1.0,
        mul(smoothstep(0.35, 0.25, uvCoord.y), smoothstep(0.04, 0.0, abs(px))),
      ),
    );

    // Combine - mask out very bottom
    const bottomMask = smoothstep(0.08, 0.15, uvCoord.y);
    return mul(mul(insideLeaf, bottomMask), stemNotch);
  });

  // Oak leaf shape - with proper rounded lobes
  const leafShapeOak = Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, 0.5);
    const py = sub(uvCoord.y, 0.35);

    // Normalized Y (0 at stem, 1 at tip)
    const normalizedY = add(mul(py, 1.35), 0.45);

    // Oak base width profile
    const widthProfile = mul(
      smoothstep(0.0, 0.2, normalizedY),
      sub(1.0, smoothstep(0.5, 1.0, normalizedY)),
    );
    const baseTaper = add(0.2, mul(widthProfile, 0.8));

    // Rounded lobes - 4 pairs of lobes along the leaf
    const lobeCount = float(4.0);
    const lobePhase = mul(normalizedY, mul(lobeCount, 6.28));
    // Rounded lobe profile (smoothed square wave)
    const lobeRaw = sin(lobePhase);
    const lobeSmooth = mul(sign(lobeRaw), smoothstep(0.0, 0.5, abs(lobeRaw)));
    // Lobes get smaller toward tip
    const lobeSize = mul(0.18, sub(1.0, smoothstep(0.4, 0.9, normalizedY)));
    const lobeOffset = mul(lobeSmooth, lobeSize);

    // Tip taper
    const tipTaper = smoothstep(0.7, 0.95, normalizedY);
    const effectiveWidth = mul(baseTaper, sub(1.0, mul(tipTaper, 0.6)));

    // Calculate lobed boundary
    const maxHalfWidth = add(mul(effectiveWidth, 0.38), lobeOffset);
    const insideWidth = sub(
      1.0,
      smoothstep(mul(maxHalfWidth, 0.8), maxHalfWidth, abs(px)),
    );

    // Length mask with rounded base
    const lengthMask = mul(
      smoothstep(-0.15, 0.1, normalizedY),
      smoothstep(1.0, 0.88, normalizedY),
    );

    return mul(insideWidth, lengthMask);
  });

  // Palm/frond leaf shape - long narrow leaf with parallel veins
  const leafShapePalm = Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, 0.5);
    const py = sub(uvCoord.y, 0.5);

    // Palm frond is long and narrow, tapering at both ends
    const normalizedY = add(mul(py, 2.0), 0.5); // -0.5 to 1.5 range

    // Width tapers at both ends
    const centerDist = abs(sub(normalizedY, 0.5));
    const widthTaper = sub(1.0, mul(centerDist, 1.6));
    const baseWidth = mul(0.12, max(widthTaper, 0.02));

    // Subtle rippled edges (parallel veins create slight bumps)
    const ripple = mul(sin(mul(normalizedY, 40.0)), mul(0.015, widthTaper));
    const effectiveWidth = add(baseWidth, ripple);

    // Inside width test
    const insideWidth = sub(
      1.0,
      smoothstep(mul(effectiveWidth, 0.8), effectiveWidth, abs(px)),
    );

    // Length mask - tapers to points at both ends
    const lengthMask = mul(
      smoothstep(-0.02, 0.1, normalizedY),
      smoothstep(1.02, 0.9, normalizedY),
    );

    return mul(insideWidth, lengthMask);
  });

  // Needle leaf shape - very thin, conifer-style
  const leafShapeNeedle = Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, 0.5);
    const py = sub(uvCoord.y, 0.5);

    // Very long and thin
    const normalizedY = add(mul(py, 2.2), 0.5);

    // Extremely narrow width that tapers to sharp points
    const centerDist = abs(sub(normalizedY, 0.5));
    const widthTaper = sub(1.0, mul(centerDist, 2.2));
    const baseWidth = mul(0.05, max(widthTaper, 0.0));

    // Inside width test
    const insideWidth = sub(
      1.0,
      smoothstep(mul(baseWidth, 0.7), baseWidth, abs(px)),
    );

    // Length mask - very sharp points
    const lengthMask = mul(
      smoothstep(-0.05, 0.08, normalizedY),
      smoothstep(1.05, 0.92, normalizedY),
    );

    return mul(insideWidth, lengthMask);
  });

  // Select leaf shape based on option
  const getLeafAlpha = Fn(([uvCoord]: [Node<"vec2">]) => {
    switch (leafShape) {
      case "ovate":
        return leafShapeOvate(uvCoord);
      case "maple":
        return leafShapeMaple(uvCoord);
      case "oak":
        return leafShapeOak(uvCoord);
      case "palm":
        return leafShapePalm(uvCoord);
      case "needle":
        return leafShapeNeedle(uvCoord);
      case "elliptic":
      default:
        return leafShapeElliptic(uvCoord);
    }
  });

  // Leaf vein pattern - central vein with branching secondary veins
  const leafVeins = Fn(([uvCoord]: [Node<"vec2">]) => {
    const px = sub(uvCoord.x, 0.5);
    const py = uvCoord.y;

    // Central vein - tapers toward tip
    const centralWidth = mul(0.025, sub(1.0, mul(py, 0.6)));
    const centralVein = sub(1.0, smoothstep(0.0, centralWidth, abs(px)));

    // Secondary veins branching from center
    // They angle outward as they go up the leaf
    const veinCount = float(5.0);
    const veinPhase = mul(py, veinCount);
    const veinIndex = floor(veinPhase);
    const veinLocalY = fract(veinPhase);

    // Veins angle outward - calculate expected x position
    const veinAngle = mul(0.4, add(veinIndex, 1.0)); // More angle for higher veins
    const expectedX = mul(veinLocalY, mul(veinAngle, 0.15));

    // Distance from expected vein position (for both sides)
    const distLeft = abs(sub(px, expectedX));
    const distRight = abs(add(px, expectedX));
    const veinDist = min(distLeft, distRight);

    // Secondary vein thickness - thinner than central
    const secondaryWidth = mul(0.012, sub(1.0, mul(veinLocalY, 0.5)));
    const secondaryVein = mul(
      sub(1.0, smoothstep(0.0, secondaryWidth, veinDist)),
      smoothstep(0.0, 0.15, veinLocalY), // Fade in from center
    );

    // Combine veins
    return mul(max(centralVein, mul(secondaryVein, 0.5)), 0.5);
  });

  // ========== VERTEX POSITION NODE ==========
  // Get instance orientation from attribute
  const instanceOrientation = attribute<"vec4">("instanceOrientation", "vec4");

  // Custom position calculation with quaternion rotation
  const customPosition = Fn(() => {
    const pos = positionLocal;
    const quat = instanceOrientation;

    // Apply quaternion rotation to position
    const rotatedPos = rotateByQuat(pos, quat);

    // Wind animation using select (conditional)
    const windPhase = mul(hash(float(instanceIndex)), 6.28);
    const windAmount = mul(mul(uWindStrength, pos.y), 0.1);
    const windX = mul(sin(add(mul(uTime, 2.0), windPhase)), windAmount);
    const windZ = mul(
      mul(cos(add(mul(uTime, 1.5), mul(windPhase, 0.7))), windAmount),
      0.5,
    );

    // Apply wind only if windStrength > 0
    const hasWind = uWindStrength.greaterThan(0.0);
    const finalX = select(hasWind, add(rotatedPos.x, windX), rotatedPos.x);
    const finalZ = select(hasWind, add(rotatedPos.z, windZ), rotatedPos.z);

    return vec3(finalX, rotatedPos.y, finalZ);
  });

  // Set custom position
  material.positionNode = customPosition();

  // ========== DIFFUSE COLOR NODE ==========
  // Only provides the diffuse/albedo color - scene lights handle actual lighting
  const diffuseColorNode = Fn(() => {
    const uvCoord = uv();
    const instIdx = float(instanceIndex);

    // Get procedural leaf alpha for edge darkening
    const alpha = getLeafAlpha(uvCoord);

    // Instance-based color variation
    const variation = sub(mul(hash3(instIdx), 2.0), 1.0);
    const leafColor = add(vec3(uColor.rgb), mul(variation, uColorVariation));

    // Darken edges slightly for depth
    const edgeDark = add(mul(smoothstep(0.3, 0.8, alpha), 0.2), 0.8);
    const darkendColor = mul(leafColor, edgeDark);

    // Add subtle vein pattern (darker)
    const veins = leafVeins(uvCoord);
    const veinedColor = mix(
      darkendColor,
      mul(darkendColor, 0.7),
      mul(veins, 0.3),
    );

    return veinedColor; // Return vec3 - scene lights will handle the rest
  });

  material.colorNode = diffuseColorNode();

  // ========== OPACITY NODE ==========
  // Handles procedural leaf shape cutout
  const opacityNode = Fn(() => {
    const uvCoord = uv();
    const alpha = getLeafAlpha(uvCoord);
    return mul(alpha, uOpacity);
  });

  material.opacityNode = opacityNode();

  // Alpha test node - required for TSL materials to enable alpha cutoff
  // Fragment is discarded when opacity < alphaTestNode
  material.alphaTestNode = uAlphaTest;
  material.alphaTest = alphaTest; // Fallback for non-TSL path

  // ========== EMISSIVE NODE (SUBSURFACE SCATTERING) ==========
  // Simulates light passing through leaves when backlit by the sun
  const emissiveNode = Fn(() => {
    const instIdx = float(instanceIndex);

    // Get base leaf color for subsurface tint
    const variation = sub(mul(hash3(instIdx), 2.0), 1.0);
    const leafColor = add(vec3(uColor.rgb), mul(variation, uColorVariation));

    // View direction (from fragment to camera)
    const worldPos = positionWorld;
    const viewDir = normalize(sub(cameraPosition, worldPos));

    // World normal - for double-sided, we use the geometric normal
    const worldNorm = normalWorld;

    // Check if backlit: light coming through the leaf from behind
    // When view direction and sun direction are roughly opposite, leaf is backlit
    const NdotSun = dot(worldNorm, uSunDirection);
    const VdotSun = dot(viewDir, uSunDirection);

    // Backlit when normal faces away from sun but we're looking toward sun
    // This is a simplified wrap lighting / SSS approximation
    const backlitAmount = max(
      float(0.0),
      mul(mul(NdotSun, -1.0), max(float(0.0), VdotSun)),
    );

    // Subsurface scattering intensity - warmer, brighter color
    const subsurfaceColor = mul(leafColor, vec3(1.3, 1.1, 0.7)); // Warm yellow-green tint
    const sssIntensity = mul(mul(backlitAmount, uSubsurface), uDayNightMix);

    return mul(subsurfaceColor, sssIntensity);
  });

  material.emissiveNode = emissiveNode();

  // Store uniforms for runtime updates
  const tslMaterial = material as TSLInstancedLeafMaterial;
  tslMaterial.leafUniforms = {
    color: uColor,
    colorVariation: uColorVariation,
    alphaTest: uAlphaTest,
    opacity: uOpacity,
    subsurface: uSubsurface,
    windStrength: uWindStrength,
    time: uTime,
    sunDirection: uSunDirection,
    dayNightMix: uDayNightMix,
  };

  // Update methods
  tslMaterial.updateTime = (time: number) => {
    uTime.value = time;
  };

  /**
   * Update lighting parameters for day/night cycle
   * @param sunDir - Direction TO the sun (normalized)
   * @param dayMix - Day/night mix factor (0 = night, 1 = day)
   */
  tslMaterial.updateLighting = (sunDir: THREE.Vector3, dayMix: number) => {
    uSunDirection.value.copy(sunDir);
    uDayNightMix.value = dayMix;
  };

  return tslMaterial;
}

/**
 * Check if a material is a TSL instanced leaf material.
 */
export function isTSLInstancedLeafMaterial(
  material: THREE.Material,
): material is TSLInstancedLeafMaterial {
  return (
    material instanceof MeshStandardNodeMaterial &&
    "leafUniforms" in material &&
    "updateTime" in material
  );
}
