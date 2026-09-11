/**
 * three.ts - Three.js WebGPU Extensions
 *
 * Enhanced Three.js import with WebGPU renderer and BVH raycasting.
 * Exports WebGPU build of Three.js with TSL (Three Shading Language) functions.
 *
 * TSL API Notes:
 * - TSL functions are in THREE_NAMESPACE.TSL, not direct exports from three/webgpu
 * - Node materials (MeshStandardNodeMaterial, etc.) ARE direct exports
 * - Bloom effect is in three/examples/jsm/tsl/display/BloomNode.js
 * - TSL graphs can be constructed in Node.js; GPU execution uses WebGPU only
 *
 * Browser Requirements:
 * - Chrome 113+, Edge 113+, Safari 17+ for WebGPU support
 * - See RendererFactory.isWebGPUAvailable() for detection
 */

import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from "three-mesh-bvh";
import * as THREE_CORE from "three";

// Ensure WebGPU constants exist in Node/test runtimes before loading three/webgpu.
import "./webgpu-polyfills";

// Import WebGPU build of Three.js
import * as THREE_NAMESPACE from "three/webgpu";

// TSL functions are exported under the TSL namespace in three/webgpu.
// Explicit property types keep declaration output tied to Three's public API
// instead of expanding anonymous implementation types that cannot be named.
export const Fn: typeof THREE_NAMESPACE.TSL.Fn = THREE_NAMESPACE.TSL.Fn;
export const If: typeof THREE_NAMESPACE.TSL.If = THREE_NAMESPACE.TSL.If;
export const uv: typeof THREE_NAMESPACE.TSL.uv = THREE_NAMESPACE.TSL.uv;
export const positionLocal: typeof THREE_NAMESPACE.TSL.positionLocal =
  THREE_NAMESPACE.TSL.positionLocal;
export const positionWorld: typeof THREE_NAMESPACE.TSL.positionWorld =
  THREE_NAMESPACE.TSL.positionWorld;
export const positionView: typeof THREE_NAMESPACE.TSL.positionView =
  THREE_NAMESPACE.TSL.positionView;
export const normalLocal: typeof THREE_NAMESPACE.TSL.normalLocal =
  THREE_NAMESPACE.TSL.normalLocal;
export const normalWorld: typeof THREE_NAMESPACE.TSL.normalWorld =
  THREE_NAMESPACE.TSL.normalWorld;
export const normalWorldGeometry: typeof THREE_NAMESPACE.TSL.normalWorldGeometry =
  THREE_NAMESPACE.TSL.normalWorldGeometry;
export const normalView: typeof THREE_NAMESPACE.TSL.normalView =
  THREE_NAMESPACE.TSL.normalView;
export const cameraPosition: typeof THREE_NAMESPACE.TSL.cameraPosition =
  THREE_NAMESPACE.TSL.cameraPosition;
export const cameraProjectionMatrix: typeof THREE_NAMESPACE.TSL.cameraProjectionMatrix =
  THREE_NAMESPACE.TSL.cameraProjectionMatrix;
export const cameraViewMatrix: typeof THREE_NAMESPACE.TSL.cameraViewMatrix =
  THREE_NAMESPACE.TSL.cameraViewMatrix;
export const cameraNear: typeof THREE_NAMESPACE.TSL.cameraNear =
  THREE_NAMESPACE.TSL.cameraNear;
export const cameraFar: typeof THREE_NAMESPACE.TSL.cameraFar =
  THREE_NAMESPACE.TSL.cameraFar;
export const modelViewMatrix: typeof THREE_NAMESPACE.TSL.modelViewMatrix =
  THREE_NAMESPACE.TSL.modelViewMatrix;
export const modelWorldMatrix: typeof THREE_NAMESPACE.TSL.modelWorldMatrix =
  THREE_NAMESPACE.TSL.modelWorldMatrix;
export const modelNormalMatrix: typeof THREE_NAMESPACE.TSL.modelNormalMatrix =
  THREE_NAMESPACE.TSL.modelNormalMatrix;
export const instanceIndex: typeof THREE_NAMESPACE.TSL.instanceIndex =
  THREE_NAMESPACE.TSL.instanceIndex;
export const uniform: typeof THREE_NAMESPACE.TSL.uniform =
  THREE_NAMESPACE.TSL.uniform;
export const attribute: typeof THREE_NAMESPACE.TSL.attribute =
  THREE_NAMESPACE.TSL.attribute;
export const instancedBufferAttribute: typeof THREE_NAMESPACE.TSL.instancedBufferAttribute =
  THREE_NAMESPACE.TSL.instancedBufferAttribute;
export const vertexColor: typeof THREE_NAMESPACE.TSL.vertexColor =
  THREE_NAMESPACE.TSL.vertexColor;
export const float: typeof THREE_NAMESPACE.TSL.float =
  THREE_NAMESPACE.TSL.float;
export const int: typeof THREE_NAMESPACE.TSL.int = THREE_NAMESPACE.TSL.int;
export const uint: typeof THREE_NAMESPACE.TSL.uint = THREE_NAMESPACE.TSL.uint;
export const vec2: typeof THREE_NAMESPACE.TSL.vec2 = THREE_NAMESPACE.TSL.vec2;
export const vec3: typeof THREE_NAMESPACE.TSL.vec3 = THREE_NAMESPACE.TSL.vec3;
export const vec4: typeof THREE_NAMESPACE.TSL.vec4 = THREE_NAMESPACE.TSL.vec4;
export const mat2: typeof THREE_NAMESPACE.TSL.mat2 = THREE_NAMESPACE.TSL.mat2;
export const mat3: typeof THREE_NAMESPACE.TSL.mat3 = THREE_NAMESPACE.TSL.mat3;
export const mat4: typeof THREE_NAMESPACE.TSL.mat4 = THREE_NAMESPACE.TSL.mat4;
export const add: typeof THREE_NAMESPACE.TSL.add = THREE_NAMESPACE.TSL.add;
export const sub: typeof THREE_NAMESPACE.TSL.sub = THREE_NAMESPACE.TSL.sub;
export const mul: typeof THREE_NAMESPACE.TSL.mul = THREE_NAMESPACE.TSL.mul;
export const div: typeof THREE_NAMESPACE.TSL.div = THREE_NAMESPACE.TSL.div;
export const mod: typeof THREE_NAMESPACE.TSL.mod = THREE_NAMESPACE.TSL.mod;
export const abs: typeof THREE_NAMESPACE.TSL.abs = THREE_NAMESPACE.TSL.abs;
export const acos: typeof THREE_NAMESPACE.TSL.acos = THREE_NAMESPACE.TSL.acos;
export const asin: typeof THREE_NAMESPACE.TSL.asin = THREE_NAMESPACE.TSL.asin;
export const atan: typeof THREE_NAMESPACE.TSL.atan = THREE_NAMESPACE.TSL.atan;
export const ceil: typeof THREE_NAMESPACE.TSL.ceil = THREE_NAMESPACE.TSL.ceil;
export const clamp: typeof THREE_NAMESPACE.TSL.clamp =
  THREE_NAMESPACE.TSL.clamp;
export const cos: typeof THREE_NAMESPACE.TSL.cos = THREE_NAMESPACE.TSL.cos;
export const cross: typeof THREE_NAMESPACE.TSL.cross =
  THREE_NAMESPACE.TSL.cross;
export const degrees: typeof THREE_NAMESPACE.TSL.degrees =
  THREE_NAMESPACE.TSL.degrees;
export const distance: typeof THREE_NAMESPACE.TSL.distance =
  THREE_NAMESPACE.TSL.distance;
export const dot: typeof THREE_NAMESPACE.TSL.dot = THREE_NAMESPACE.TSL.dot;
export const exp: typeof THREE_NAMESPACE.TSL.exp = THREE_NAMESPACE.TSL.exp;
export const exp2: typeof THREE_NAMESPACE.TSL.exp2 = THREE_NAMESPACE.TSL.exp2;
export const floor: typeof THREE_NAMESPACE.TSL.floor =
  THREE_NAMESPACE.TSL.floor;
export const fract: typeof THREE_NAMESPACE.TSL.fract =
  THREE_NAMESPACE.TSL.fract;
export const inversesqrt: typeof THREE_NAMESPACE.TSL.inversesqrt =
  THREE_NAMESPACE.TSL.inversesqrt;
export const length: typeof THREE_NAMESPACE.TSL.length =
  THREE_NAMESPACE.TSL.length;
export const log: typeof THREE_NAMESPACE.TSL.log = THREE_NAMESPACE.TSL.log;
export const log2: typeof THREE_NAMESPACE.TSL.log2 = THREE_NAMESPACE.TSL.log2;
export const max: typeof THREE_NAMESPACE.TSL.max = THREE_NAMESPACE.TSL.max;
export const min: typeof THREE_NAMESPACE.TSL.min = THREE_NAMESPACE.TSL.min;
export const mix: typeof THREE_NAMESPACE.TSL.mix = THREE_NAMESPACE.TSL.mix;
export const normalize: typeof THREE_NAMESPACE.TSL.normalize =
  THREE_NAMESPACE.TSL.normalize;
export const pow: typeof THREE_NAMESPACE.TSL.pow = THREE_NAMESPACE.TSL.pow;
export const radians: typeof THREE_NAMESPACE.TSL.radians =
  THREE_NAMESPACE.TSL.radians;
export const reflect: typeof THREE_NAMESPACE.TSL.reflect =
  THREE_NAMESPACE.TSL.reflect;
export const refract: typeof THREE_NAMESPACE.TSL.refract =
  THREE_NAMESPACE.TSL.refract;
export const round: typeof THREE_NAMESPACE.TSL.round =
  THREE_NAMESPACE.TSL.round;
export const saturate: typeof THREE_NAMESPACE.TSL.saturate =
  THREE_NAMESPACE.TSL.saturate;
export const sign: typeof THREE_NAMESPACE.TSL.sign = THREE_NAMESPACE.TSL.sign;
export const sin: typeof THREE_NAMESPACE.TSL.sin = THREE_NAMESPACE.TSL.sin;
export const smoothstep: typeof THREE_NAMESPACE.TSL.smoothstep =
  THREE_NAMESPACE.TSL.smoothstep;
export const sqrt: typeof THREE_NAMESPACE.TSL.sqrt = THREE_NAMESPACE.TSL.sqrt;
export const step: typeof THREE_NAMESPACE.TSL.step = THREE_NAMESPACE.TSL.step;
export const tan: typeof THREE_NAMESPACE.TSL.tan = THREE_NAMESPACE.TSL.tan;
export const texture: typeof THREE_NAMESPACE.TSL.texture =
  THREE_NAMESPACE.TSL.texture;
export const texture3D: typeof THREE_NAMESPACE.TSL.texture3D =
  THREE_NAMESPACE.TSL.texture3D;
export const Discard: typeof THREE_NAMESPACE.TSL.Discard =
  THREE_NAMESPACE.TSL.Discard;
export const output: typeof THREE_NAMESPACE.TSL.output =
  THREE_NAMESPACE.TSL.output;
export const renderOutput: typeof THREE_NAMESPACE.TSL.renderOutput =
  THREE_NAMESPACE.TSL.renderOutput;
export const pass: typeof THREE_NAMESPACE.TSL.pass = THREE_NAMESPACE.TSL.pass;
export const mrt: typeof THREE_NAMESPACE.TSL.mrt = THREE_NAMESPACE.TSL.mrt;
export const reflector: typeof THREE_NAMESPACE.TSL.reflector =
  THREE_NAMESPACE.TSL.reflector;
export const viewportCoordinate: typeof THREE_NAMESPACE.TSL.viewportCoordinate =
  THREE_NAMESPACE.TSL.viewportCoordinate;
export const screenUV: typeof THREE_NAMESPACE.TSL.screenUV =
  THREE_NAMESPACE.TSL.screenUV;
export const viewportSize: typeof THREE_NAMESPACE.TSL.viewportSize =
  THREE_NAMESPACE.TSL.viewportSize;
export const viewportDepthTexture: typeof THREE_NAMESPACE.TSL.viewportDepthTexture =
  THREE_NAMESPACE.TSL.viewportDepthTexture;
export const linearDepth: typeof THREE_NAMESPACE.TSL.linearDepth =
  THREE_NAMESPACE.TSL.linearDepth;
export const hash: typeof THREE_NAMESPACE.TSL.hash = THREE_NAMESPACE.TSL.hash;
export const rotate: typeof THREE_NAMESPACE.TSL.rotate =
  THREE_NAMESPACE.TSL.rotate;
export const time: typeof THREE_NAMESPACE.TSL.time = THREE_NAMESPACE.TSL.time;
export const PI: typeof THREE_NAMESPACE.TSL.PI = THREE_NAMESPACE.TSL.PI;
export const PI2: typeof THREE_NAMESPACE.TSL.PI2 = THREE_NAMESPACE.TSL.PI2;
export const INFINITY: typeof THREE_NAMESPACE.TSL.INFINITY =
  THREE_NAMESPACE.TSL.INFINITY;
export const EPSILON: typeof THREE_NAMESPACE.TSL.EPSILON =
  THREE_NAMESPACE.TSL.EPSILON;
export const remap: typeof THREE_NAMESPACE.TSL.remap =
  THREE_NAMESPACE.TSL.remap;
export const storage: typeof THREE_NAMESPACE.TSL.storage =
  THREE_NAMESPACE.TSL.storage;
export const instancedArray: typeof THREE_NAMESPACE.TSL.instancedArray =
  THREE_NAMESPACE.TSL.instancedArray;
export const negate: typeof THREE_NAMESPACE.TSL.negate =
  THREE_NAMESPACE.TSL.negate;
export const oneMinus: typeof THREE_NAMESPACE.TSL.oneMinus =
  THREE_NAMESPACE.TSL.oneMinus;
export const dFdx: typeof THREE_NAMESPACE.TSL.dFdx = THREE_NAMESPACE.TSL.dFdx;
export const dFdy: typeof THREE_NAMESPACE.TSL.dFdy = THREE_NAMESPACE.TSL.dFdy;
export const select: typeof THREE_NAMESPACE.TSL.select =
  THREE_NAMESPACE.TSL.select;
export const element: typeof THREE_NAMESPACE.TSL.element =
  THREE_NAMESPACE.TSL.element;
export const tangentLocal: typeof THREE_NAMESPACE.TSL.tangentLocal =
  THREE_NAMESPACE.TSL.tangentLocal;
export const tangentWorld: typeof THREE_NAMESPACE.TSL.tangentWorld =
  THREE_NAMESPACE.TSL.tangentWorld;
export const tangentView: typeof THREE_NAMESPACE.TSL.tangentView =
  THREE_NAMESPACE.TSL.tangentView;
export const bitangentLocal: typeof THREE_NAMESPACE.TSL.bitangentLocal =
  THREE_NAMESPACE.TSL.bitangentLocal;
export const bitangentWorld: typeof THREE_NAMESPACE.TSL.bitangentWorld =
  THREE_NAMESPACE.TSL.bitangentWorld;
export const bitangentView: typeof THREE_NAMESPACE.TSL.bitangentView =
  THREE_NAMESPACE.TSL.bitangentView;
export const TBNViewMatrix: typeof THREE_NAMESPACE.TSL.TBNViewMatrix =
  THREE_NAMESPACE.TSL.TBNViewMatrix;

// Loop control for compute shaders - explicitly typed for declaration generation
export const Loop = THREE_NAMESPACE.TSL
  .Loop as typeof import("three/src/nodes/utils/LoopNode.js").Loop;
export const Break = THREE_NAMESPACE.TSL
  .Break as typeof import("three/src/nodes/utils/LoopNode.js").Break;
export const Continue = THREE_NAMESPACE.TSL
  .Continue as typeof import("three/src/nodes/utils/LoopNode.js").Continue;

// Re-export Node Materials (these ARE directly on three/webgpu)
export {
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  SpriteNodeMaterial,
  LineBasicNodeMaterial,
} from "three/webgpu";

// CSM (Cascaded Shadow Maps) for WebGPU
export { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
export { CSMHelper } from "three/addons/csm/CSMHelper.js";

// Export the THREE namespace object as the default export
export default THREE_NAMESPACE;

// Re-export the full three.js surface so `import THREE from '../extras/three'` works
export * from "three/webgpu";

/**
 * Type for TSL shader node accumulators.
 * Use this when a variable will be reassigned with results from add(), mul(), etc.
 * These operations return different node types that aren't directly assignable to each other.
 *
 * ShaderNodeObject<Node> provides swizzle properties (.x, .y, .z, .w, .xy, .rgb, etc.)
 * and is the return type of all TSL operations. All TSL functions accept ShaderNodeObject
 * as parameters.
 *
 * For function parameters that accept any shader node, use ShaderNodeInput instead.
 */
import type { Node } from "three/webgpu";
export type ShaderNode = Node;

/**
 * Typed TSL node aliases for use as variable types in TSL shader code.
 * These extract the proper parameterized Node types so that TSL operations
 * like add(), mul(), mix() accept them without overload errors.
 */
export type TSLNodeFloat = ReturnType<typeof THREE_NAMESPACE.TSL.float>;
export type TSLNodeVec2 = ReturnType<typeof THREE_NAMESPACE.TSL.vec2>;
export type TSLNodeVec3 = ReturnType<typeof THREE_NAMESPACE.TSL.vec3>;
export type TSLNodeVec4 = ReturnType<typeof THREE_NAMESPACE.TSL.vec4>;

/**
 * Type for TSL function parameters that accept any shader node.
 * This is more permissive than ShaderNode and allows uniforms, attributes, etc.
 */
export type ShaderNodeInput = Node;

// Pre-allocated temp objects for utility functions to avoid per-call allocations
const _safeDecomposePos = new THREE_NAMESPACE.Vector3();
const _safeDecomposeQuat = new THREE_NAMESPACE.Quaternion();
const _safeDecomposeScale = new THREE_NAMESPACE.Vector3();
const _safeComposePos = new THREE_NAMESPACE.Vector3();
const _safeComposeQuat = new THREE_NAMESPACE.Quaternion();
const _safeComposeScale = new THREE_NAMESPACE.Vector3();

// Vector3 compatibility utilities
export function toTHREEVector3(
  v: THREE_NAMESPACE.Vector3 | { x: number; y: number; z: number },
  target?: THREE_NAMESPACE.Vector3,
): THREE_NAMESPACE.Vector3 {
  if (target) {
    return target.set(v.x, v.y, v.z);
  }
  return new THREE_NAMESPACE.Vector3(v.x, v.y, v.z);
}

// Utility to ensure Matrix decompose operations work correctly
export function safeMatrixDecompose(
  matrix: THREE_NAMESPACE.Matrix4,
  position: THREE_NAMESPACE.Vector3,
  quaternion: THREE_NAMESPACE.Quaternion,
  scale: THREE_NAMESPACE.Vector3,
): void {
  matrix.decompose(_safeDecomposePos, _safeDecomposeQuat, _safeDecomposeScale);
  position.copy(_safeDecomposePos);
  quaternion.copy(_safeDecomposeQuat);
  scale.copy(_safeDecomposeScale);
}

// Utility for Matrix compose operations
export function safeMatrixCompose(
  matrix: THREE_NAMESPACE.Matrix4,
  position: THREE_NAMESPACE.Vector3 | { x: number; y: number; z: number },
  quaternion:
    THREE_NAMESPACE.Quaternion | { x: number; y: number; z: number; w: number },
  scale: THREE_NAMESPACE.Vector3 | { x: number; y: number; z: number },
): void {
  _safeComposePos.set(position.x, position.y, position.z);
  _safeComposeQuat.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  _safeComposeScale.set(scale.x, scale.y, scale.z);
  matrix.compose(_safeComposePos, _safeComposeQuat, _safeComposeScale);
}

// Install three-mesh-bvh for accelerated raycasting.
// Patch both "three/webgpu" and "three" module instances to avoid prototype
// mismatches when loaders/materials come from mixed entrypoints.
function installBvhExtensions(
  ns: typeof THREE_NAMESPACE | typeof THREE_CORE,
): void {
  const geometryProto = ns.BufferGeometry
    .prototype as typeof THREE_NAMESPACE.BufferGeometry.prototype & {
    computeBoundsTree?: typeof computeBoundsTree;
    disposeBoundsTree?: typeof disposeBoundsTree;
  };
  const meshProto = ns.Mesh
    .prototype as typeof THREE_NAMESPACE.Mesh.prototype & {
    raycast?: typeof acceleratedRaycast;
  };

  geometryProto.computeBoundsTree = computeBoundsTree;
  geometryProto.disposeBoundsTree = disposeBoundsTree;
  meshProto.raycast = acceleratedRaycast;
}

installBvhExtensions(THREE_NAMESPACE);
installBvhExtensions(THREE_CORE);

// Interface for InstancedMesh with resize method
interface InstancedMeshWithResize extends THREE_NAMESPACE.InstancedMesh {
  resize?: (size: number) => void;
  instanceMatrix: THREE_NAMESPACE.InstancedBufferAttribute;
}

// Utility to resize instanced mesh buffers
(THREE_NAMESPACE.InstancedMesh.prototype as InstancedMeshWithResize).resize =
  function (this: InstancedMeshWithResize, size: number) {
    const prevSize = (this.instanceMatrix.array as Float32Array).length / 16;
    if (size <= prevSize) return;
    const array = new Float32Array(size * 16);
    array.set(this.instanceMatrix.array as Float32Array);
    const attrib = new THREE_NAMESPACE.InstancedBufferAttribute(array, 16);
    this.instanceMatrix = attrib;
    this.instanceMatrix.needsUpdate = true;
  };
