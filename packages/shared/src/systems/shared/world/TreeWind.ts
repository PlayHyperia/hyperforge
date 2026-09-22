import THREE from "../../../extras/three/three";
import type { Node } from "three/webgpu";
import {
  Fn,
  attribute,
  batchIndirectIndex,
  clamp,
  float,
  instanceIndex,
  int,
  ivec2,
  max,
  min,
  normalLocal,
  positionLocal,
  sin,
  storage,
  tangentGeometry,
  tangentLocal,
  textureLoad,
  vec3,
  vec4,
} from "three/tsl";

/** No material integration here. The caller owns every cloned geometry and
 * retains the existing renderer/texture/storage lifetimes. r186 applies this
 * position node AFTER batching/instancing, with the pool at world identity.
 * Instance transforms must remain upright yaw + positive uniform scale. */
export const TREE_WIND_ATTRIBUTE = "treeWindHeight";
export const TREE_WIND_MAX_DISPLACEMENT = 0.36;
export type TreeWindMode = "legacy-leaf-v1" | "connected-v1";
export interface TreeWindPoolOptions {
  readonly windMode?: TreeWindMode;
}
const MAX_VERTICES = 2_000_000;
const IDENTITY = new THREE.Matrix4();

export interface TreeWindDescriptor {
  readonly schemaVersion: 1;
  readonly rootY: number;
  readonly topY: number;
  readonly height: number;
}

function positions(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  if (
    !position ||
    position.itemSize !== 3 ||
    !Number.isInteger(position.count) ||
    position.count < 1 ||
    position.count > MAX_VERTICES
  ) {
    throw new Error("Tree wind requires bounded vec3 positions");
  }
  return position;
}

function finiteCoordinate(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) {
    throw new Error("Tree wind has invalid baked coordinates");
  }
  return value;
}

/** Actual baked full LOD0 union, not cached Box3 values or one bark/leaf part.
 * rootY is explicit: current batched assets use 0; single-model placement uses
 * its actual minimum Y. Reuse this SAME descriptor for all parts and LODs. */
export function deriveTreeWindDescriptor(
  geometries: readonly THREE.BufferGeometry[],
  rootY: number,
): TreeWindDescriptor {
  finiteCoordinate(rootY);
  if (geometries.length < 1 || geometries.length > 64) {
    throw new Error("Tree wind requires 1..64 baked LOD0 parts");
  }
  let topY = -Infinity;
  let count = 0;
  for (const geometry of geometries) {
    const position = positions(geometry);
    count += position.count;
    if (count > MAX_VERTICES) throw new Error("Tree wind union exceeds bound");
    for (let index = 0; index < position.count; index++) {
      finiteCoordinate(position.getX(index));
      topY = Math.max(topY, finiteCoordinate(position.getY(index)));
      finiteCoordinate(position.getZ(index));
    }
  }
  const height = topY - rootY;
  if (height < 0.0001 || height > 1000) {
    throw new Error("Tree wind requires positive bounded height above root");
  }
  return Object.freeze({ schemaVersion: 1, rootY, topY, height });
}

/** Adds [UNCLAMPED authored height above root, shared full height]. Clamping is
 * in the shader so above-top LOD vertices have the correct zero cap derivative.
 * Never edits source geometry, attributes, cached bounds, or collision data. */
export function cloneGeometryWithTreeWind(
  source: THREE.BufferGeometry,
  descriptor: TreeWindDescriptor,
): THREE.BufferGeometry {
  if (
    !Object.isFrozen(descriptor) ||
    descriptor.schemaVersion !== 1 ||
    !Number.isFinite(descriptor.rootY) ||
    descriptor.height !== descriptor.topY - descriptor.rootY ||
    descriptor.height < 0.0001 ||
    descriptor.height > 1000
  ) {
    throw new Error("Tree wind requires its immutable height descriptor");
  }
  if (source.hasAttribute(TREE_WIND_ATTRIBUTE)) {
    throw new Error("Tree wind geometry already has metadata");
  }
  const position = positions(source);
  const data = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index++) {
    finiteCoordinate(position.getX(index));
    data[index * 2] = finiteCoordinate(position.getY(index)) - descriptor.rootY;
    data[index * 2 + 1] = descriptor.height;
    finiteCoordinate(position.getZ(index));
  }
  const owned = source.clone();
  owned.setAttribute(TREE_WIND_ATTRIBUTE, new THREE.BufferAttribute(data, 2));
  return owned;
}

/** Call at instance insertion/LOD migration; no per-frame scan or matrix write.
 * Pool world matrices must separately remain identity for the entire lifetime. */
export function assertTreeWindInstanceMatrix(matrix: THREE.Matrix4): void {
  const e = matrix.elements;
  if (e.some((value) => !Number.isFinite(value))) {
    throw new Error("Tree wind instance matrix must be finite");
  }
  const scale = e[5];
  const tolerance = 0.00001 * Math.max(1, Math.abs(scale));
  if (
    scale < 0.0001 ||
    scale > 10000 ||
    [e[1], e[2] + e[8], e[3], e[4], e[6], e[7], e[9], e[11]].some(
      (value) => Math.abs(value) > tolerance,
    ) ||
    Math.abs(e[0] - e[10]) > tolerance ||
    Math.abs(Math.hypot(e[0], e[2]) - scale) > tolerance ||
    e[15] !== 1
  ) {
    throw new Error(
      "Tree wind supports only upright yaw and uniform positive scale",
    );
  }
}

export interface TreeWindFrameNodes {
  readonly root: Node<"vec3">;
  readonly scale: Node<"float">;
}

export interface TreeWindInstanceNodes extends TreeWindFrameNodes {
  readonly transformTangent: (authored: Node<"vec3">) => Node<"vec3">;
}

/** Resolve the actual render object, never a material's first batch. Batch IDs
 * are native indirect IDs, not drawIndex; slot compaction cannot change phase.
 * Native r186 owns these matrices. This helper allocates NO texture/buffer data.
 * Only production storage instancing is admitted: a second ordinary uniform
 * BufferNode could create a duplicate GPU binding/allocation. */
export function createTreeWindFrameNodes(
  object: THREE.Object3D,
): TreeWindInstanceNodes {
  if (!object.matrixWorld.equals(IDENTITY)) {
    throw new Error("Tree wind pool world matrix must be identity");
  }
  if (object instanceof THREE.BatchedMesh) {
    const matrices: unknown = Reflect.get(object, "_matricesTexture");
    if (
      THREE.REVISION !== "186" ||
      !(matrices instanceof THREE.DataTexture) ||
      !(matrices.image.data instanceof Float32Array) ||
      matrices.type !== THREE.FloatType ||
      matrices.format !== THREE.RGBAFormat ||
      matrices.image.width < 4 ||
      matrices.image.width % 4 !== 0 ||
      matrices.image.data.length !==
        matrices.image.width * matrices.image.height * 4
    ) {
      throw new Error("Tree wind requires native r186 batching matrices");
    }
    const width = int(matrices.image.width);
    const start = int(batchIndirectIndex).mul(4).toVar();
    const x = start.mod(width).toVar();
    const y = start.div(width).toVar();
    const up = textureLoad(matrices, ivec2(x.add(1), y)).xyz.toVar();
    const root = textureLoad(matrices, ivec2(x.add(3), y)).xyz;
    return {
      root,
      scale: up.length(),
      transformTangent: (authored) => {
        // One extra existing texture column ONLY for tangent-bearing geometry.
        // Upright yaw + positive uniform scale gives Z = (-X.z, 0, X.x).
        const right = textureLoad(matrices, ivec2(x, y)).xyz.toVar();
        return right
          .mul(authored.x)
          .add(up.mul(authored.y))
          .add(vec3(right.z.mul(-1), 0, right.x).mul(authored.z));
      },
    };
  }
  if (object instanceof THREE.InstancedMesh) {
    const matrices = object.instanceMatrix;
    if (
      matrices.itemSize !== 16 ||
      matrices.count < 1 ||
      matrices.count > 512 ||
      !(matrices.array instanceof Float32Array) ||
      !(matrices instanceof THREE.StorageInstancedBufferAttribute)
    ) {
      throw new Error(
        "Tree wind requires bounded native storage instance matrices",
      );
    }
    const matrix = storage(matrices, "mat4", matrices.count).element(
      instanceIndex,
    );
    return {
      root: matrix.mul(vec4(0, 0, 0, 1)).xyz,
      scale: matrix.mul(vec4(0, 1, 0, 0)).xyz.length(),
      transformTangent: (authored) => matrix.mul(vec4(authored, 0)).xyz,
    };
  }
  throw new Error("Tree wind requires BatchedMesh or InstancedMesh");
}

export interface TreeWindInputs {
  readonly time: Node<"float">;
  readonly strength: Node<"float">;
  readonly direction: Node<"vec2">;
}

/** Root-only phase, so matching wood/leaf coordinates share EXACT deformation.
 * World amplitude <=.36 m, direction magnitude <=1; no secondary leaf motion.
 * h² has zero displacement/slope at root. The upper clamp has zero slope above
 * top; the exact top uses the capped (zero) one-sided derivative convention. */
export function createTreeWindBendNodes(
  heightData: Node<"vec2">,
  frame: TreeWindFrameNodes,
  wind: TreeWindInputs,
): { displacement: Node<"vec2">; derivative: Node<"vec2"> } {
  const h = clamp(heightData.x.div(heightData.y), 0, 1).toVar();
  const phase = frame.root.x.mul(0.013).add(frame.root.z.mul(0.017)).toVar();
  const wave = sin(wind.time.mul(0.8).add(phase))
    .mul(0.7)
    .add(sin(wind.time.mul(1.31).add(phase.mul(0.6))).mul(0.3))
    .toVar();
  const amplitude = clamp(wind.strength, 0, 2)
    .mul(min(heightData.y.mul(frame.scale).mul(0.018), 0.18))
    .mul(wave)
    .toVar();
  const direction = wind.direction.div(max(wind.direction.length(), 1)).toVar();
  const active = heightData.x
    .greaterThan(0)
    .and(heightData.x.lessThan(heightData.y));
  const slope = active
    .select(
      amplitude.mul(h).mul(2).div(heightData.y.mul(frame.scale)),
      float(0),
    )
    .toVar();
  return {
    displacement: direction.mul(amplitude.mul(h).mul(h)),
    derivative: direction.mul(slope),
  };
}

/** Native r186 has already transformed position/normal, but storage instancing
 * leaves tangents authored-space and batching uses vector * matrix for them.
 * Explicitly transform the AUTHORED tangent once with matrix * vector before J;
 * normals use J^-T. Preserve handedness in the unchanged geometry W component.
 * Native r186 shadow override forwards this same positionNode automatically. */
export function createTreeWindPositionNode(wind: TreeWindInputs): Node<"vec3"> {
  return Fn((builder) => {
    const metadata = builder.geometry.getAttribute(TREE_WIND_ATTRIBUTE);
    if (
      !metadata ||
      metadata.itemSize !== 2 ||
      !builder.geometry.hasAttribute("normal")
    ) {
      throw new Error("Tree wind requires owned height metadata and normals");
    }
    const frame = createTreeWindFrameNodes(builder.object);
    const bend = createTreeWindBendNodes(
      attribute(TREE_WIND_ATTRIBUTE, "vec2"),
      frame,
      wind,
    );
    const derivative = bend.derivative.toVar();
    const normal = normalLocal.toVar();
    normalLocal.assign(
      vec3(
        normal.x,
        normal.y
          .sub(derivative.x.mul(normal.x))
          .sub(derivative.y.mul(normal.z)),
        normal.z,
      ).normalize(),
    );
    if (builder.geometry.hasAttribute("tangent")) {
      const tangent = frame.transformTangent(tangentGeometry.xyz).toVar();
      tangentLocal.assign(
        vec3(
          tangent.x.add(derivative.x.mul(tangent.y)),
          tangent.y,
          tangent.z.add(derivative.y.mul(tangent.y)),
        ).normalize(),
      );
    }
    const displacement = bend.displacement.toVar();
    return positionLocal.add(vec3(displacement.x, 0, displacement.y));
  })();
}

/** CPU oracle of the documented equations, not an alternative runtime path. */
export function evaluateTreeWindBend(input: {
  heightAboveRoot: number;
  fullHeight: number;
  scale: number;
  rootX: number;
  rootZ: number;
  time: number;
  strength: number;
  directionX: number;
  directionZ: number;
}): {
  displacement: readonly [number, number];
  derivative: readonly [number, number];
} {
  if (
    Object.values(input).some((value) => !Number.isFinite(value)) ||
    input.fullHeight < 0.0001 ||
    input.fullHeight > 1000 ||
    input.scale < 0.0001 ||
    input.scale > 10000
  )
    throw new Error("Invalid tree wind numeric input");
  const h = Math.min(1, Math.max(0, input.heightAboveRoot / input.fullHeight));
  const phase = input.rootX * 0.013 + input.rootZ * 0.017;
  const wave =
    Math.sin(input.time * 0.8 + phase) * 0.7 +
    Math.sin(input.time * 1.31 + phase * 0.6) * 0.3;
  const amplitude =
    Math.min(2, Math.max(0, input.strength)) *
    Math.min(input.fullHeight * input.scale * 0.018, 0.18) *
    wave;
  const divisor = Math.max(1, Math.hypot(input.directionX, input.directionZ));
  const dx = input.directionX / divisor;
  const dz = input.directionZ / divisor;
  const slope =
    input.heightAboveRoot > 0 && input.heightAboveRoot < input.fullHeight
      ? (amplitude * h * 2) / (input.fullHeight * input.scale)
      : 0;
  return {
    displacement: [dx * amplitude * h * h, dz * amplitude * h * h],
    derivative: [dx * slope, dz * slope],
  };
}
