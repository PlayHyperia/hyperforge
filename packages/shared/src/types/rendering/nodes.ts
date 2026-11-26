/**
 * Node-related type definitions
 */

import type * as YogaTypes from "yoga-layout";
import * as THREE from "../../extras/three/three";
import type { Node } from "../../nodes/Node";
// Import from specific files to avoid circular dependency with ../../index
import type { Entity } from "../../entities/Entity";
import type { HotReloadable } from "../systems/physics";
import type { NodeData } from "../core/base-types";
import type { PlayerHitReactionDiagnostics } from "../../extras/three/PlayerHitReactionController";
import type { AvatarAuthoredMotionDiagnostics } from "../../extras/three/AvatarAuthoredMotionDiagnostics";
import type {
  ActorHandle as EngineActorHandle,
  PxRigidBodyFlagEnum,
  PxShape,
  PxTransform,
  PxVec3,
} from "../systems/physics";

// Custom pointer event for internal use (to avoid conflicts with browser PointerEvent)
export interface CustomPointerEvent {
  type: string | null;
  _propagationStopped: boolean;
  set(type: string): void;
  stopPropagation(): void;
}

// Pointer interfaces
export interface PointerNode {
  onPointerEnter?: (event: CustomPointerEvent) => void;
  onPointerLeave?: (event: CustomPointerEvent) => void;
  onPointerDown?: (event: CustomPointerEvent) => void;
  onPointerUp?: (event: CustomPointerEvent) => void;
  cursor?: string;
  parent?: PointerNode;
  getPath?: () => PointerNode[];
  resolveHit?: (hit: unknown) => PointerNode;
}

// Camera system interfaces
export interface PlayerTarget {
  position: THREE.Vector3;
  playerId: string;
  data: { id: string };
  base: THREE.Object3D;
}

export interface RendererWithDomElement {
  domElement: HTMLCanvasElement;
}

// Avatar interfaces
export interface NodeStats {
  bones: number;
  meshes: number;
  materials: number;
  textures: number;
}

export interface AvatarFactory {
  uid: string;
  // Factory create signature used by Avatar node at runtime
  create: (
    matrix: THREE.Matrix4,
    hooks?: AvatarHooks,
    node?: Node,
  ) => VRMAvatarInstance;
}

// VRM-specific avatar factory used by Avatar node at runtime
export interface VRMAvatarFactory {
  uid: string;
  create: (
    matrix: THREE.Matrix4,
    hooks?: AvatarHooks,
    node?: Node,
  ) => VRMAvatarInstance;
}

export interface AvatarHooks {
  onFrame?: (delta: number) => void;
}

export interface AvatarInstance<
  T = Record<string, unknown>,
> extends HotReloadable {
  hooks?: AvatarHooks;
  destroy: () => void;
  set?: <K extends keyof T>(key: K, value: T[K]) => void;
  get?: <K extends keyof T>(key: K) => T[K] | undefined;
}

export interface LoadedAvatar {
  uid: string;
  factory: AvatarFactory;
  toNodes: (customHooks?: Record<string, unknown>) => Map<string, unknown>;
  getStats: () => { fileBytes?: number; [key: string]: unknown };
}

// Loader result types for node-based assets
export interface LoadedModel {
  toNodes: () => Map<string, import("../../nodes/Node").Node>;
  getStats: () => { fileBytes?: number; [key: string]: unknown };
}

export interface LoadedEmote {
  toNodes: () => Map<string, import("../../nodes/Node").Node>;
  getStats: () => { fileBytes?: number; [key: string]: unknown };
  toClip: (options?: {
    rootToHips?: number;
    version?: string;
    getBoneName?: (name: string) => string;
  }) => THREE.AnimationClip | null;
}

// Image interfaces
export interface ImageSceneItem {
  matrix: THREE.Matrix4;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  getEntity: () => Entity | null;
  node: Node;
}

// Joint interfaces
export interface PxSpring {
  stiffness: number;
  damping: number;
}

export interface PxJointLimitCone {
  yAngle: number;
  zAngle: number;
  contactDistance?: number;
}

export interface PxJointAngularLimitPair {
  lower: number;
  upper: number;
  contactDistance?: number;
}

export interface JointLimits {
  linear?: {
    x?: { lower: number; upper: number };
    y?: { lower: number; upper: number };
    z?: { lower: number; upper: number };
  };
  angular?: {
    x?: { lower: number; upper: number };
    y?: { lower: number; upper: number };
    z?: { lower: number; upper: number };
  };
  distance?: {
    min: number;
    max: number;
  };
  cone?: PxJointLimitCone;
}

export interface JointDrive {
  position?: { x?: number; y?: number; z?: number };
  velocity?: { x?: number; y?: number; z?: number };
  angularVelocity?: { x?: number; y?: number; z?: number };
  stiffness?: number;
  damping?: number;
  forceLimit?: number;
}

// Joint flag enums
export enum PxConstraintFlag {
  eBROKEN = 1 << 0,
  ePROJECTION = 1 << 1,
  eCOLLISION_ENABLED = 1 << 2,
  eVISUALIZATION = 1 << 3,
  eDRIVE_LIMITS_ARE_FORCES = 1 << 4,
  eIMPROVED_SLERP = 1 << 7,
  eDISABLE_PREPROCESSING = 1 << 8,
  eENABLE_EXTENDED_LIMITS = 1 << 9,
  eGPU_COMPATIBLE = 1 << 10,
}

export interface PhysXJoint {
  setBreakForce: (force: number, torque: number) => void;
  setConstraintFlag: (flag: PxConstraintFlag | number, value: boolean) => void;
  setDrivePosition?: (position: THREE.Vector3) => void;
  setDriveVelocity?: (velocity: THREE.Vector3) => void;
  setDistanceJointFlag?: (flag: number, value: boolean) => void;
  setMinDistance?: (distance: number | null) => void;
  setMaxDistance?: (distance: number | null) => void;
  setStiffness?: (stiffness: number) => void;
  setDamping?: (damping: number) => void;
  setLimit?: (limit: PxJointAngularLimitPair) => void;
  setLimitCone?: (limit: PxJointLimitCone) => void;
  setLinearLimit?: (axis: number, limit: PxJointAngularLimitPair) => void;
  setAngularLimit?: (axis: number, lower: number, upper: number) => void;
  setSphericalJointFlag?: (flag: number, value: boolean) => void;
  setRevoluteJointFlag?: (flag: number, value: boolean) => void;
  setPrismaticJointFlag?: (flag: number, value: boolean) => void;
  release: () => void;
}

export interface PhysXController {
  getPosition: () => THREE.Vector3;
}

export interface PhysXMoveFlags {
  eDOWN: number;
  eSIDES: number;
  eUP: number;
  eCOLLISION_SIDES: number;
  eCOLLISION_UP: number;
  eCOLLISION_DOWN: number;
  [key: string]: number;
}

export interface Vector3WithPxTransform extends THREE.Vector3 {
  toPxTransform?: (transform: PxTransform) => void;
}

export interface QuaternionWithPxTransform extends THREE.Quaternion {
  toPxTransform?: (transform: PxTransform) => void;
}

export interface JointData extends NodeData {
  type?: "fixed" | "distance" | "spherical" | "revolute" | "prismatic" | "d6";
  connectedBody?: string;
  breakForce?: number;
  breakTorque?: number;
  limits?: JointLimits;
  drive?: JointDrive;
  [key: string]: unknown;
}

// RigidBody flag enums
export enum PxRigidBodyFlag {
  eKINEMATIC = 1 << 0,
  eUSE_KINEMATIC_TARGET_FOR_SCENE_QUERIES = 1 << 1,
  eENABLE_CCD = 1 << 2,
  eENABLE_CCD_FRICTION = 1 << 3,
  eENABLE_POSE_INTEGRATION_PREVIEW = 1 << 4,
  eENABLE_SPECULATIVE_CCD = 1 << 5,
  eENABLE_CCD_MAX_CONTACT_IMPULSE = 1 << 6,
  eRETAIN_ACCELERATIONS = 1 << 7,
}

// RigidBody interfaces
export interface PhysXActor<T = unknown> {
  getGlobalPose: () => PxTransform;
  setGlobalPose: (pose: PxTransform, wakeup?: boolean) => void;
  setRigidBodyFlag?: (
    flag: PxRigidBodyFlagEnum | number,
    value: boolean,
  ) => void;
  setLinearVelocity?: (velocity: PxVec3, wakeup?: boolean) => void;
  getLinearVelocity?: () => PxVec3;
  setAngularVelocity?: (velocity: PxVec3, wakeup?: boolean) => void;
  getAngularVelocity?: () => PxVec3;
  setMass?: (mass: number) => void;
  getMass?: () => number;
  userData?: T;
  release: () => void;
  // Additional methods used by RigidBody
  setCMassLocalPose?: (pose: PxTransform) => void;
  setLinearDamping?: (damping: number) => void;
  setAngularDamping?: (damping: number) => void;
  attachShape?: (shape: PxShape) => void;
  detachShape?: (shape: PxShape) => void;
  isSleeping?: () => boolean;
  addForce?: (force: PxVec3, mode?: number) => void;
  addTorque?: (torque: PxVec3, mode?: number) => void;
  setKinematicTarget?: (transform: PxTransform) => void;
}

export type PhysXActorHandle = EngineActorHandle;

// Physics contact/trigger event types
export interface PhysicsContactEvent {
  bodyA: PhysXActor;
  bodyB: PhysXActor;
  normal?: THREE.Vector3;
  impulse?: THREE.Vector3;
  contactPoint?: THREE.Vector3;
}

export interface PhysicsTriggerEvent {
  trigger: PhysXActor;
  other: PhysXActor;
  isEnter: boolean;
}

export interface RigidBodyData extends Record<string, unknown> {
  type?: "static" | "dynamic" | "kinematic" | string;
  mass?: number;
  linearDamping?: number;
  angularDamping?: number;
  lockPosition?: { x?: boolean; y?: boolean; z?: boolean };
  lockRotation?: { x?: boolean; y?: boolean; z?: boolean };
  tag?: string | null;
  onContactStart?: ((event: PhysicsContactEvent) => void) | null;
  onContactEnd?: ((event: PhysicsContactEvent) => void) | null;
  onTriggerEnter?: ((event: PhysicsTriggerEvent) => void) | null;
  onTriggerLeave?: ((event: PhysicsTriggerEvent) => void) | null;
}

// UI interfaces
export interface UIYogaNode {
  setWidth(width: number): void;
  setHeight(height: number): void;
  setBorder(edge: number, value: number): void;
  setPadding(edge: number, value: number): void;
  setFlexDirection(direction: number): void;
  setJustifyContent(justifyContent: number): void;
  setAlignItems(alignItems: number): void;
  setAlignContent(alignContent: number): void;
  setFlexWrap(flexWrap: number): void;
  setGap(gutter: number, value: number): void;
  calculateLayout(width: number, height: number, direction: number): void;
  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
  free(): void;
}

export interface UISceneItem {
  matrix: THREE.Matrix4;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  getEntity: () => Entity | null;
  node: Node; // Node instance from UI class
  activate?: () => void;
  deactivate?: () => void;
  visible?: boolean;
}

export interface UIProxy {
  [key: string]: unknown;
}

// UI Event types
export interface UIPointerEvent {
  point: THREE.Vector3;
  localPoint?: THREE.Vector2;
  distance: number;
  face?: THREE.Face;
  coords?: { x: number; y: number };
  target?: Node;
  type:
    | "pointerenter"
    | "pointerleave"
    | "pointerdown"
    | "pointerup"
    | "pointerclick";
  button?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export interface UIWheelEvent extends UIPointerEvent {
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
}

export interface UIRaycastHit {
  point: THREE.Vector3;
  distance: number;
  [key: string]: unknown;
}

// RaycastHit moved to index.ts to avoid duplication

export interface UIData extends NodeData {
  space?: string;
  width?: number;
  height?: number;
  size?: number;
  res?: number;

  lit?: boolean;
  doubleside?: boolean;
  billboard?: string;
  pivot?: string;
  offset?: number[];
  scaler?: number[] | null;
  pointerEvents?: boolean;

  transparent?: boolean;
  backgroundColor?: string | null;
  borderWidth?: number;
  borderColor?: string | null;
  borderRadius?: number | number[];
  padding?: number | number[];
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  alignContent?: string;
  flexWrap?: string;
  gap?: number;

  onPointerEnter?: (event: UIPointerEvent) => void;
  onPointerLeave?: (event: UIPointerEvent) => void;
  onPointerDown?: (event: UIPointerEvent) => void;
  onPointerUp?: (event: UIPointerEvent) => void;
  onPointerClick?: (event: UIPointerEvent) => void;
  onWheel?: (event: UIWheelEvent) => void;
  onContextMenu?: (event: UIPointerEvent) => void;

  [key: string]: unknown;

  // Alternative properties for compatibility
  pixelSize?: number;
  interactive?: boolean;
  renderOrder?: number;
}

// Mesh interfaces
export interface MeshSceneItem {
  matrix: THREE.Matrix4;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  getEntity: () => Entity | null;
  node: Node;
}

export interface MeshData extends NodeData {
  type?: string;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  geometry?: THREE.BufferGeometry | string | null;
  material?: THREE.Material | string | null;
  linked?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  visible?: boolean;
  frustumCulled?: boolean;
  [key: string]: unknown;
}

// LOD interfaces
export interface LODData extends NodeData {
  scaleAware?: boolean;
  distances?: number[];
  [key: string]: unknown;
}

export interface LODItem {
  node: Node;
  maxDistance: number;
  // Alternative properties for compatibility
  distance?: number;
  object?: THREE.Object3D;
}

// LOD runtime contract for nodes checked by LOD system
export interface LODNode {
  check(): void;
}

// Controller interfaces
export interface ControllerData extends NodeData {
  type?: "capsule" | "box";
  height?: number;
  radius?: number;
  stepOffset?: number;
  slopeLimit?: number;
  skinWidth?: number;
  minMoveDistance?: number;
  gravity?: boolean;
  visible?: boolean;
  layer?: string;
  tag?: string | number | null;
  onContactStart?: ((event: PhysicsContactEvent) => void) | null;
  onContactEnd?: ((event: PhysicsContactEvent) => void) | null;
}

// Action interfaces
export interface ActionData extends NodeData {
  label?: string | number;
  distance?: number;
  duration?: number;
  onStart?: () => void;
  onTrigger?: () => void;
  onCancel?: () => void;
}

// Audio type enums
export type DistanceModelType = "linear" | "inverse" | "exponential";
export type GroupType = "music" | "sfx";

// Enhanced Audio interfaces
export interface AudioData extends NodeData {
  src?: string | null;
  volume?: number;
  loop?: boolean;
  group?: GroupType;
  spatial?: boolean;
  distanceModel?: DistanceModelType;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  coneInnerAngle?: number;
  coneOuterAngle?: number;
  coneOuterGain?: number;
}

// Enhanced Avatar interfaces
export interface VRMAvatarInstance extends HotReloadable {
  height: number;
  headToHeight: number;
  /** Start an emote, optionally seeking to an exact clip-local time. */
  setEmote: (emote: string | null, startTimeSeconds?: number) => void;
  triggerHitReaction: (intensity?: number, side?: -1 | 1) => void;
  clearHitReaction: () => void;
  getHitReactionDiagnostics: () => PlayerHitReactionDiagnostics;
  getAuthoredMotionDiagnostics: () => AvatarAuthoredMotionDiagnostics;
  move: (matrix: THREE.Matrix4) => void;
  disableRateCheck: () => void;
  destroy: () => void;
  getBoneTransform: (boneName: string) => THREE.Matrix4 | null;
  update: (delta: number) => void;
  /** Get the lowest bone Y position in world space (feet/toes) */
  getLowestBoneY: () => number | null;
  /** Clamp avatar to ground, returns Y adjustment applied */
  clampToGround: (groundY: number) => number;
  /** Store ground adjustment for subsequent move() calls (prevents camera jitter) */
  setGroundAdjustment: (adjustment: number) => void;
  /** Get stored ground adjustment */
  getGroundAdjustment: () => number;
  raw?: {
    scene?: THREE.Object3D;
    userData?: {
      vrm?: {
        humanoid?: {
          getRawBone?: (boneName: string) => { node: THREE.Object3D } | null;
        };
      };
    };
  };
}

export interface AvatarData extends NodeData {
  src?: string | null;
  emote?: string | null;
  onLoad?: Function | null;
  factory?: VRMAvatarFactory;
  hooks?: AvatarHooks;
}

// Collider interfaces
export interface ColliderData extends NodeData {
  type?: string;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  geometry?: THREE.BufferGeometry;
  convex?: boolean;
  trigger?: boolean;
  layer?: string;
  staticFriction?: number;
  dynamicFriction?: number;
  restitution?: number;
}

// Enhanced Image interfaces
export interface ImageData extends NodeData {
  src?: string | null;
  width?: number | null;
  height?: number | null;
  fit?: string;
  color?: string | number;
  pivot?: string;
  lit?: boolean;
  doubleside?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  emissive?: string | number;
  emissiveIntensity?: number;
  opacity?: number;
  transparent?: boolean;
  alphaTest?: number;
}

// Particles interfaces (minimal emitter handle)
export interface ParticleEmitterHandle {
  destroy?: () => void;
  setEmitting?: (emitting: boolean) => void;
}

// Type alias for backward compatibility
export type ParticleEmitter = ParticleEmitterHandle;

export interface ParticlesData extends NodeData {
  emitting?: boolean;
  shape?: unknown[];
  direction?: number;
  rate?: number;
  bursts?: Array<{ time: number; count: number }>;
  duration?: number;
  loop?: boolean;
  max?: number;
  timescale?: number;
  life?: string;
  speed?: string;
  size?: string;
  rotate?: string;
  color?: string;
  alpha?: string;
  emissive?: string;
  image?: string;
  spritesheet?: [number, number, number, number] | null;
  blending?: string;
  lit?: boolean;
  billboard?: string;
  space?: string;
  force?: [number, number, number] | null;
  velocityLinear?: [number, number, number] | null;
  velocityOrbital?: [number, number, number] | null;
  velocityRadial?: number | null;
  rateOverDistance?: number;
  sizeOverLife?: string | null;
  rotateOverLife?: string | null;
  colorOverLife?: string | null;
  alphaOverLife?: string | null;
  emissiveOverLife?: string | null;
  onEnd?: (() => void) | null;
}

// Enhanced SkinnedMesh interfaces
export interface SkinnedMeshData extends NodeData {
  object3d?: THREE.Object3D | null;
  animations?: THREE.AnimationClip[];
  castShadow?: boolean;
  receiveShadow?: boolean;
}

// Sky interfaces
export interface SkyData extends NodeData {
  bg?: string | null;
  hdr?: string | null;
  sunDirection?: [number, number, number] | null;
  sunIntensity?: number | null;
  sunColor?: string | null;
  fogNear?: number | null;
  fogFar?: number | null;
  fogColor?: string | null;
}

// UI Text type definitions
export type DisplayType = "flex" | "none";
export type TextAlign = "left" | "center" | "right";
export type FontWeight = string | number;
export type FlexBasis = number | "auto" | `${number}%`;
export type EdgeValue = number | [number, number, number, number];

// Enhanced UI Text interfaces
export interface UITextData extends NodeData {
  display?: DisplayType;
  absolute?: boolean;
  top?: number | null;
  right?: number | null;
  bottom?: number | null;
  left?: number | null;
  backgroundColor?: string | null;
  borderRadius?: number;
  margin?: EdgeValue;
  padding?: EdgeValue;
  value?: string;
  fontSize?: number;
  color?: string;
  lineHeight?: number;
  textAlign?: TextAlign;
  fontFamily?: string;
  fontWeight?: FontWeight;
  flexBasis?: FlexBasis;
  flexGrow?: number;
  flexShrink?: number;
}

// Enhanced UI View interfaces
export interface UIViewData extends NodeData {
  display?: DisplayType;
  width?: number | null;
  height?: number | null;
  absolute?: boolean;
  top?: number | null;
  right?: number | null;
  bottom?: number | null;
  left?: number | null;
  backgroundColor?: string | null;
  borderWidth?: number;
  borderColor?: string | null;
  borderRadius?: number;
  margin?: EdgeValue;
  padding?: EdgeValue;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  alignContent?: string;
  flexWrap?: string;
  gap?: number;
  flexBasis?: FlexBasis;
  flexGrow?: number;
  flexShrink?: number;
}

// Enhanced UI Image interfaces
export interface UIImageData extends NodeData {
  display?: string;
  src?: string | null;
  width?: number | string | null;
  height?: number | string | null;
  absolute?: boolean;
  top?: number | null;
  right?: number | null;
  bottom?: number | null;
  left?: number | null;
  objectFit?: "fill" | "contain" | "cover" | "none" | "scale-down" | string;
  backgroundColor?: string | null;
  borderRadius?: number | null;
  margin?: number | number[] | null;
}

// UI component interfaces shared across UI nodes
export interface UIYogaNodeContext {
  calculateLayout(width?: number, height?: number, direction?: number): void;
  getComputedLeft(): number;
  getComputedTop(): number;
  getComputedWidth(): number;
  getComputedHeight(): number;
  setDisplay(display: number): void;
  setPositionType(positionType: number): void;
  setPosition(edge: number, value: number): void;
  setWidth(width: number): void;
  setHeight(height: number): void;
  setMargin(edge: number, value: number): void;
  insertChild(child: UIYogaNodeContext, index: number): void;
  removeChild(child: UIYogaNodeContext): void;
  getChildCount(): number;
  markDirty(): void;
  free(): void;
  setMeasureFunc: (
    fn: (
      width: number,
      widthMode: number,
      height: number,
      heightMode: number,
    ) => { width: number; height: number },
  ) => void;
}

export interface UIContext {
  redraw: () => void;
  _res: number;
}

export type UIImageNodeContext =
  | {
      width: number;
      height: number;
      complete?: boolean;
      src?: string;
    }
  | HTMLImageElement;

export interface UIBoxNodeContext {
  [key: string]: unknown;
}

// UIImage interfaces
export interface YogaNode extends YogaTypes.Node {
  calculateLayout: (
    width?: number | "auto",
    height?: number | "auto",
    direction?: YogaTypes.Direction,
  ) => void;
}

export interface UINode {
  yoga: YogaNode;
  type: string;
  props: Record<string, unknown>;
  children: UINode[];
}

export interface UIImageNode {
  complete: boolean;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface UIBoxNode {
  width: number;
  height: number;
  color: string;
}

// Mob instancing types (client-side rendering optimization)
export type MobAnimationState = "idle" | "walk";

export type MobInstancedHandle = {
  id: string;
  modelKey: string;
  state: MobAnimationState;
  variant: number;
  index: number;
  hidden: boolean;
  scale: THREE.Vector3;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  matrix: THREE.Matrix4;
};
