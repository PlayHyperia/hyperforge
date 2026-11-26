/**
 * Physics.ts - PhysX Physics System
 *
 * Provides realistic physics simulation using NVIDIA PhysX engine.
 * Manages rigid bodies, colliders, raycasts, and character controllers.
 *
 * Key Features:
 * - **Rigid Body Dynamics**: Static, kinematic, and dynamic actors
 * - **Collision Detection**: Continuous collision detection with contact callbacks
 * - **Character Controllers**: Capsule-based character movement
 * - **Raycasting**: Scene queries for line-of-sight, interaction, etc.
 * - **Overlap Queries**: Sphere, box, and capsule overlap tests
 * - **Sweep Tests**: Moving collision detection
 * - **Triggers**: Volume-based events (enter/exit)
 * - **Physics Materials**: Friction, restitution, and bounce
 *
 * Architecture:
 * - Uses PhysX WASM module on client (browser)
 * - Uses PhysX Node.js bindings on server
 * - Deterministic fixed-timestep simulation (30 FPS)
 * - Server is authoritative for all physics state
 * - Client runs local physics for immediate feedback (validated by server)
 *
 * PhysX Integration:
 * - PxFoundation: Core PhysX singleton
 * - PxPhysics: Physics SDK instance
 * - PxScene: Physics world simulation
 * - PxCpuDispatcher: Multi-threaded simulation
 * - PxControllerManager: Character controller factory
 *
 * Collision Layers:
 * Uses Layers system for filtering:
 * - Default (0): General environment geometry
 * - Players (1): Player character capsules
 * - Mobs (2): Enemy creature colliders
 * - Interactables (3): Objects that can be clicked
 * - Projectiles (4): Arrows, magic projectiles
 * - Triggers (5): Volume-based event areas
 *
 * Coordinate System:
 * - Uses three.js coordinate system (Y-up, right-handed)
 * - PhysX also uses Y-up, matches three.js
 * - Position/rotation kept in sync between three.js and PhysX
 *
 * Performance:
 * - Fixed timestep ensures deterministic simulation
 * - CPU dispatcher enables multi-threading
 * - Broad-phase culling reduces collision checks
 * - Sleeping actors don't simulate until moved
 *
 * Usage:
 * ```typescript
 * // Add rigid body to entity
 * const body = world.physics.addBody({
 *   entity: player,
 *   shape: 'capsule',
 *   height: 1.8,
 *   radius: 0.3,
 *   mass: 75,
 *   type: 'dynamic'
 * });
 *
 * // Raycast for ground detection
 * const hit = world.physics.raycast({
 *   origin: { x: 0, y: 10, z: 0 },
 *   direction: { x: 0, y: -1, z: 0 },
 *   maxDistance: 20
 * });
 *
 * // Character controller for player movement
 * const controller = world.physics.createCharacterController({
 *   height: 1.8,
 *   radius: 0.3,
 *   position: { x: 0, y: 0, z: 0 }
 * });
 * ```
 *
 * Related Systems:
 * - Entities: Physics bodies attached to entities
 * - ClientInput: Movement input drives character controllers
 * - CombatSystem: Uses raycasts for hit detection
 * - TerrainSystem: Static collision mesh for ground
 *
 * @see PhysXManager.ts for PhysX initialization
 * @see PhysicsUtils.ts for helper functions
 */

import type {
  Collider,
  Physics as IPhysics,
  RaycastHit as IRaycastHit,
  PhysicsMaterial,
  Quaternion,
  RigidBody,
  Vector3,
  World,
  CharacterController,
  CharacterControllerOptions,
} from "../../../types/index";

import { Layers } from "../../../physics/Layers";
import * as THREE from "../../../extras/three/three";
import {
  createCpuDispatcher,
  getActorsFromHeader,
  vector3ToPxVec3,
  setTransformFromMatrix4,
} from "../../../utils/physics/PhysicsUtils";
import { getPhysX, waitForPhysX } from "../../../physics/PhysXManager.js";
import type {
  ActorHandle,
  ContactEvent,
  InterpolatedPhysicsHandle,
  PhysicsHandle,
  PhysicsOverlapHit,
  PhysicsRaycastHit,
  PhysicsSweepHit,
  TriggerEvent,
} from "../../../types/systems/physics";
// NOTE: Import directly to avoid circular dependency through barrel file
import type { SystemDependencies } from "../infrastructure/System";
import { SystemBase } from "../infrastructure/SystemBase";

const _v3_1 = new THREE.Vector3();
const _v3_2 = new THREE.Vector3();
const _v3_3 = new THREE.Vector3();
const _contact_pos = new THREE.Vector3();
const _contact_nor = new THREE.Vector3();
const _contact_imp = new THREE.Vector3();
// Pre-allocated Vector3 for raycast direction normalization
const _raycastDirNormalized = new THREE.Vector3();
// Cache for sphere geometries to avoid per-overlap allocations
const _sphereGeometryCache = new Map<number, PxSphereGeometry>();

// Import PhysX types
import type PhysX from "@hyperforge/physx-js-webidl";
// Use physx-js-webidl types directly to avoid conflicts
import type {
  PxActor,
  PxContactPair,
  PxController,
  PxControllerFilters,
  PxControllerManager,
  PxCookingParams,
  PxFoundation,
  PxGeometry,
  PxMaterial,
  PxOverlapResult,
  PxPhysics,
  PxQueryFilterData,
  PxRaycastResult,
  PxRigidBody,
  PxRigidDynamic,
  PxRigidStatic,
  PxScene,
  PxShape,
  PxSphereGeometry,
  PxSweepResult,
  PxTolerancesScale,
  PxTransform,
  PxTriggerPair,
  PxVec3,
} from "../../../types/systems/physics";

// All PhysX type extensions are now imported from physx-runtime.d.ts

// All types now imported from physx-webidl.d.ts which uses physx-js-webidl as the source

// Import proper PxVec3 type from physx types - no need for any
// PxVec3 is properly defined in the physx.d.ts file

// Re-export shared physics types for backward compatibility
export type {
  ActorHandle,
  BasePhysicsHandle,
  ContactEvent,
  ContactInfo,
  InterpolatedPhysicsHandle,
  InterpolationData,
  NonInterpolatedPhysicsHandle,
  PhysicsHandle,
  PhysicsOverlapHit,
  PhysicsRaycastHit,
  PhysicsSweepHit,
  TriggerEvent,
  TriggerInfo,
} from "../../../types/systems/physics";

// PhysX type aliases for backward compatibility
export type PhysXActor = PxActor;
export type PhysXTransform = PxTransform;
export type PhysXShape = PxShape;
import type { GeometryPhysXMesh } from "../../../types/systems/physics";
export type PhysXMesh = GeometryPhysXMesh;
export type PhysXMaterial = PxMaterial;
export type PhysXRigidActor = PxActor;
export type PhysXRigidBody = PxRigidBody;
export type PhysXRigidDynamic = PxRigidDynamic;
export type PhysXRigidStatic = PxRigidStatic;
export type PhysXScene = PxScene;
export type PhysXController = PxController;
export type PhysXControllerManager = PxControllerManager;
export type PhysXPhysics = PxPhysics;
export type PhysXGeometry = PxGeometry;
export type PhysXSphereGeometry = PxSphereGeometry;

// Actor with address property for handle lookup
interface PxActorWithAddress extends PxActor {
  _address: number | bigint;
}

// PhysX module type for runtime features
// This interface represents the actual physx-js-webidl module with extensions
type PhysXModule = typeof PhysX & {
  // Additional runtime properties that may be available
  wrapPointer?<T>(ptr: number, type: new (...args: unknown[]) => T): T;
  NativeArrayHelpers?: {
    prototype: {
      getContactPairAt?(pairs: PxContactPair, index: number): PxContactPair;
    };
  };
  SupportFunctions?: {
    prototype: {
      PxScene_getActiveActors?(scene: PxScene): unknown;
    };
  };
};

// Lightweight object pool used for callback structs to minimize allocations
function createPool<T extends { release?: () => void }>(
  factory: () => T,
): () => T {
  const pool: T[] = [];
  return () => {
    const item = pool.pop() || factory();
    // Attach a release method that returns the object to the pool
    item.release = () => {
      pool.push(item);
    };
    return item;
  };
}

// Simple hit result conversion function
function convertHitResult(hit: PhysX.PxRaycastHit | PhysX.PxSweepHit): {
  actor: PxActor;
  position: PhysX.PxVec3;
  normal: PhysX.PxVec3;
  distance: number;
} {
  return {
    actor: hit.actor,
    position: hit.position,
    normal: hit.normal,
    distance: hit.distance,
  };
}

// (Duplicate createPool removed)

// Import additional types

// Internal types for callback pool objects
// Extend ContactEvent/TriggerEvent at runtime with tagging metadata used by our systems
export interface ExtendedContactEvent extends ContactEvent {
  contacts: {
    position: THREE.Vector3;
    normal: THREE.Vector3;
    impulse: THREE.Vector3;
    separation?: number;
  }[];
}

export interface ExtendedTriggerEvent extends TriggerEvent {
  tag: string | null;
  playerId: string | null;
}

export interface InternalContactCallback {
  start: boolean;
  fn0: ((event: ContactEvent) => void) | null;
  event0: ExtendedContactEvent;
  fn1: ((event: ContactEvent) => void) | null;
  event1: ExtendedContactEvent;
  addContact(
    position: THREE.Vector3,
    normal: THREE.Vector3,
    impulse: THREE.Vector3,
  ): void;
  init(start: boolean): this;
  exec(): void;
  release(): void;
}

export interface InternalTriggerCallback {
  fn: ((event: TriggerEvent) => void) | null;
  event: ExtendedTriggerEvent;
  exec(): void;
  release(): void;
}

// Types are now imported from shared physics types

// Internal type aliases for this file
export type OverlapHit = PhysicsOverlapHit;

// Placeholder collider for uninitialized hits
const placeholderCollider: Collider = {
  type: "box",
  isTrigger: false,
  material: undefined,
};

// Static hit objects - initialized with placeholder values
const _raycastHit: PhysicsRaycastHit = {
  handle: undefined,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  distance: 0,
  collider: placeholderCollider,
};

// Placeholder actor for uninitialized hits
const placeholderActor = {} as PhysX.PxActor;

const _sweepHit: PhysicsSweepHit = {
  actor: placeholderActor,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  distance: 0,
  collider: placeholderCollider,
};

const overlapHitPool: OverlapHit[] = [];
const overlapHits: OverlapHit[] = [];

/**
 * Physics System
 *
 * - Runs on both the server and client.
 * - Allows inserting colliders etc into the world.
 * - Simulates physics and handles fixed timestep interpolation.
 *
 */
export class Physics extends SystemBase implements IPhysics {
  scene: PxScene | null = null;
  version: number = 0;
  allocator: unknown;
  errorCb: unknown;
  foundation: PxFoundation | null = null;
  tolerances: PxTolerancesScale | null = null;
  cookingParams: PxCookingParams | null = null;
  cooking: unknown; // Add cooking property
  physics!: PxPhysics;
  defaultMaterial: PxMaterial | null = null;
  callbackQueue: Array<() => void> = [];
  getContactCallback: (() => InternalContactCallback) | null = null;
  contactCallbacks: InternalContactCallback[] = [];
  queueContactCallback: ((cb: InternalContactCallback) => void) | null = null;
  processContactCallbacks: (() => void) | null = null;
  getTriggerCallback: (() => InternalTriggerCallback) | null = null;
  triggerCallbacks: InternalTriggerCallback[] = [];
  queueTriggerCallback: ((cb: InternalTriggerCallback) => void) | null = null;
  processTriggerCallbacks: (() => void) | null = null;
  handles: Map<number | bigint, PhysicsHandle> = new Map();

  // Plugin-specific extensions
  enabled: boolean = true;
  timeStep: number = 1 / 30; // 30 FPS for consistent timing with fixedDeltaTime
  gravity: Vector3 = new THREE.Vector3(0, -9.81, 0);
  controllers: Map<string, CharacterController> = new Map();
  step?: (deltaTime: number) => void;
  createCharacterController?: (
    options: CharacterControllerOptions,
  ) => CharacterController;
  active: Set<PhysicsHandle> = new Set();
  materials: Record<string, PxMaterial> = {};
  raycastResult: PxRaycastResult | null = null;
  sweepPose!: PxTransform;
  sweepResult: PxSweepResult | null = null;
  overlapPose!: PxTransform;
  overlapResult: PxOverlapResult | null = null;
  queryFilterData: PxQueryFilterData | null = null;
  _pv1: PxVec3 | null = null;
  _pv2: PxVec3 | null = null;
  /** Pre-allocated PxVec3 for velocity operations (dedicated to avoid conflicts) */
  _pv_velocity: PxVec3 | null = null;
  transform!: PxTransform;
  // Pre-allocated PxHitFlags to avoid per-raycast/sweep allocations
  _raycastHitFlags: PhysX.PxHitFlags | null = null;
  _sweepHitFlags: PhysX.PxHitFlags | null = null;
  public controllerManager: PxControllerManager | null = null;
  controllerFilters: PxControllerFilters | null = null;
  ignoreSetGlobalPose = false;

  constructor(world: World) {
    super(world, {
      name: "physics",
      dependencies: { required: [], optional: [] },
      autoCleanup: true,
    });
  }

  getDependencies(): SystemDependencies {
    // Physics has no dependencies on other systems
    return {};
  }

  async init(): Promise<void> {
    // Use waitForPhysX to ensure PhysX is loaded
    // Timeout increased to 120s to account for:
    // 1. Script loader retries (3 attempts with exponential backoff)
    // 2. WASM compilation time
    // 3. Heavy main thread work (tree generation) during startup
    const info = await waitForPhysX("Physics", 120000); // 120 second timeout
    this.version = info.version;
    this.allocator = info.allocator;
    this.errorCb = info.errorCb;
    this.foundation = info.foundation;

    // Get the global PHYSX object
    const PHYSX = getPhysX() as PhysXModule;

    // Create physics-specific objects (not shared with other systems)
    this.tolerances = new PHYSX.PxTolerancesScale();
    this.cookingParams = new PHYSX.PxCookingParams(this.tolerances!);

    // Use the physics instance from PhysXManager
    this.physics = info.physics;
    this.cooking = info.cooking; // Initialize cooking (optional)
    this.defaultMaterial = this.physics.createMaterial(0.2, 0.2, 0.2);

    this.setupCallbacks();
    this.setupScene();
    this.setupQueryObjects();
    this.setupControllerManager();

    // Mark physics as initialized
    this.initialized = true;

    // Emit ready event for other systems
    this.emitTypedEvent("physics:ready", {} as Record<string, unknown>);

    this.logger.info("System initialized successfully with PhysX");
  }

  private setupCallbacks(): void {
    // Contact callbacks
    this.getContactCallback = createPool<InternalContactCallback>(() => {
      const _loggerRef = this.logger;

      // OPTIMIZATION: Pre-allocate contact pool to avoid per-contact allocations
      // 64 contacts is plenty for typical physics scenarios
      const CONTACT_POOL_SIZE = 64;
      const contactPool: Array<{
        position: THREE.Vector3;
        normal: THREE.Vector3;
        impulse: THREE.Vector3;
      }> = [];

      // Pre-allocate all contact pool entries upfront
      for (let i = 0; i < CONTACT_POOL_SIZE; i++) {
        contactPool.push({
          position: new THREE.Vector3(),
          normal: new THREE.Vector3(),
          impulse: new THREE.Vector3(),
        });
      }

      const contacts: Array<{
        position: THREE.Vector3;
        normal: THREE.Vector3;
        impulse: THREE.Vector3;
      }> = [];
      let idx = 0;
      return {
        start: false,
        fn0: null as ((event: ContactEvent) => void) | null,
        // Provide an ExtendedContactEvent-shaped object with placeholders
        event0: {
          bodyA: {} as PxActor,
          bodyB: {} as PxActor,
          shapeA: {} as PxShape,
          shapeB: {} as PxShape,
          contacts: [],
          eventType: "contact_found",
          tag: null,
          playerId: null,
        } as ExtendedContactEvent,
        fn1: null as ((event: ContactEvent) => void) | null,
        event1: {
          bodyA: {} as PxActor,
          bodyB: {} as PxActor,
          shapeA: {} as PxShape,
          shapeB: {} as PxShape,
          contacts: [],
          eventType: "contact_found",
          tag: null,
          playerId: null,
        } as ExtendedContactEvent,
        addContact(
          position: THREE.Vector3,
          normal: THREE.Vector3,
          impulse: THREE.Vector3,
        ) {
          if (!contactPool[idx]) {
            contactPool[idx] = {
              position: new THREE.Vector3(),
              normal: new THREE.Vector3(),
              impulse: new THREE.Vector3(),
            };
          }
          const contact = contactPool[idx];
          contact.position.copy(position);
          contact.normal.copy(normal);
          contact.impulse.copy(impulse);
          // Mirror data into ContactEvent.contacts as vector triplets
          // Cast to satisfy type without bringing in specific PhysX point type
          (this.event0 as ExtendedContactEvent).contacts.push({
            position,
            normal,
            impulse,
            separation: 0,
          });
          (this.event1 as ExtendedContactEvent).contacts.push({
            position,
            normal,
            impulse,
            separation: 0,
          });
          contacts.push(contact);
          idx++;
        },
        init(start: boolean) {
          this.start = start;
          this.fn0 = null;
          this.fn1 = null;
          contacts.length = 0;
          idx = 0;
          return this;
        },
        exec() {
          if (this.fn0) {
            this.fn0(this.event0);
          }
          if (this.fn1) {
            this.fn1(this.event1);
          }
          // reset contacts after exec
          if (this.event0.contacts)
            (this.event0 as ExtendedContactEvent).contacts.length = 0;
          if (this.event1.contacts)
            (this.event1 as ExtendedContactEvent).contacts.length = 0;
          this.release();
        },
        release: () => {}, // Set by pool
      };
    });

    this.queueContactCallback = (cb: InternalContactCallback) => {
      this.contactCallbacks.push(cb);
    };

    this.processContactCallbacks = () => {
      for (const cb of this.contactCallbacks) {
        cb.exec();
      }
      this.contactCallbacks.length = 0;
    };

    // Trigger callbacks
    this.getTriggerCallback = createPool<InternalTriggerCallback>(() => {
      const _loggerRef = this.logger;
      return {
        fn: null as ((event: TriggerEvent) => void) | null,
        event: {
          triggerShape: {} as PxShape,
          otherShape: {} as PxShape,
          triggerActor: {} as PxActor,
          otherActor: {} as PxActor,
          eventType: "trigger_enter",
          tag: null,
          playerId: null,
        } as ExtendedTriggerEvent,
        exec() {
          if (this.fn) this.fn(this.event);
          this.release();
        },
        release: () => {}, // Set by pool
      };
    });

    this.queueTriggerCallback = (cb: InternalTriggerCallback) => {
      this.triggerCallbacks.push(cb);
    };

    this.processTriggerCallbacks = () => {
      for (const cb of this.triggerCallbacks) {
        cb.exec();
      }
      this.triggerCallbacks.length = 0;
    };
  }

  private setupScene(): void {
    const PHYSX = getPhysX();
    if (!PHYSX) {
      throw new Error("[Physics] Cannot setup scene - PHYSX not loaded");
    }

    const contactPoints = new PHYSX.PxArray_PxContactPairPoint(64);
    const simulationEventCallback = new PHYSX.PxSimulationEventCallbackImpl();

    // Contact callback
    simulationEventCallback.onContact = (
      pairHeaderPtr: unknown,
      pairs: PxContactPair,
      count: number,
    ) => {
      const physxModule = PHYSX as PhysXModule;
      const pairHeader = physxModule.wrapPointer!(
        pairHeaderPtr as number,
        physxModule.PxContactPairHeader,
      );
      const [actor0, actor1] = getActorsFromHeader(pairHeader);
      if (!actor0 || !actor1) return;
      const actor0Address = getActorAddress(actor0);
      const actor1Address = getActorAddress(actor1);
      if (actor0Address === undefined || actor1Address === undefined) return;

      const handle0 = this.handles.get(actor0Address);
      const handle1 = this.handles.get(actor1Address);
      if (!handle0 || !handle1) return;

      for (let i = 0; i < count; i++) {
        const pair = (
          PHYSX as PhysXModule
        ).NativeArrayHelpers.prototype.getContactPairAt(pairs, i);
        if (pair.events.isSet(PHYSX.PxPairFlagEnum.eNOTIFY_TOUCH_FOUND)) {
          const getCallback = this.getContactCallback;
          if (!getCallback) continue;
          const contactCallback = getCallback().init(true);
          this.contactCallbacks.push(contactCallback);
          const pxContactPoints = pair.extractContacts(
            contactPoints.begin(),
            64,
          );
          if (pxContactPoints > 0) {
            for (let j = 0; j < pxContactPoints; j++) {
              const contact = contactPoints.get(j);
              contactCallback.addContact(
                _contact_pos.set(
                  contact.position.x,
                  contact.position.y,
                  contact.position.z,
                ),
                _contact_nor.set(
                  contact.normal.x,
                  contact.normal.y,
                  contact.normal.z,
                ),
                _contact_imp.set(
                  contact.impulse.x,
                  contact.impulse.y,
                  contact.impulse.z,
                ),
              );
            }
          }
          if (!handle0.contactedHandles.has(handle1)) {
            if (handle0.onContactStart) {
              contactCallback.fn0 = handle0.onContactStart;
              contactCallback.event0.tag = handle1.tag ?? null;
              contactCallback.event0.playerId = handle1.playerId ?? null;
            }
            handle0.contactedHandles.add(handle1);
          }
          if (!handle1.contactedHandles.has(handle0)) {
            if (handle1.onContactStart) {
              contactCallback.fn1 = handle1.onContactStart;
              contactCallback.event1.tag = handle0.tag ?? null;
              contactCallback.event1.playerId = handle0.playerId ?? null;
            }
            handle1.contactedHandles.add(handle0);
          }
        } else if (
          pair.events.isSet(
            (PHYSX as PhysXModule).PxPairFlagEnum.eNOTIFY_TOUCH_LOST,
          )
        ) {
          const getCallback = this.getContactCallback;
          if (!getCallback) continue;
          const contactCallback = getCallback().init(false);
          this.contactCallbacks.push(contactCallback);
          if (handle0.contactedHandles.has(handle1)) {
            if (handle0.onContactEnd) {
              contactCallback.fn0 = handle0.onContactEnd;
              contactCallback.event0.tag = handle1.tag ?? null;
              contactCallback.event0.playerId = handle1.playerId ?? null;
            }
            handle0.contactedHandles.delete(handle1);
          }
          if (handle1.contactedHandles.has(handle0)) {
            if (handle1.onContactEnd) {
              contactCallback.fn1 = handle1.onContactEnd;
              contactCallback.event1.tag = handle0.tag ?? null;
              contactCallback.event1.playerId = handle0.playerId ?? null;
            }
            handle1.contactedHandles.delete(handle0);
          }
        }
      }
    };

    // Trigger callback
    simulationEventCallback.onTrigger = (pairs: unknown, count: number) => {
      const physxModule = getPhysX()!;
      pairs = (physxModule as PhysXModule).wrapPointer?.(
        pairs as number,
        PHYSX.PxTriggerPair,
      );
      for (let i = 0; i < count; i++) {
        const pair = pairs as PxTriggerPair;
        // Ignore pairs if a shape was deleted
        if (
          pair.flags.isSet(
            (PHYSX as PhysXModule).PxTriggerPairFlagEnum.eREMOVED_SHAPE_TRIGGER,
          ) ||
          pair.flags.isSet(
            (PHYSX as PhysXModule).PxTriggerPairFlagEnum.eREMOVED_SHAPE_OTHER,
          )
        ) {
          continue;
        }
        const triggerActor = pair.triggerShape.getActor();
        const otherActor = pair.otherShape.getActor();
        const triggerAddress = triggerActor
          ? getActorAddress(triggerActor)
          : undefined;
        const otherAddress = otherActor
          ? getActorAddress(otherActor)
          : undefined;
        if (!triggerAddress || !otherAddress) continue;
        const triggerHandle = this.handles.get(triggerAddress);
        const otherHandle = this.handles.get(otherAddress);
        if (!triggerHandle || !otherHandle) continue;

        if (
          pair.status ===
          (PHYSX as PhysXModule).PxPairFlagEnum.eNOTIFY_TOUCH_FOUND
        ) {
          if (!otherHandle.triggeredHandles.has(triggerHandle)) {
            if (triggerHandle.onTriggerEnter) {
              const getCallback = this.getTriggerCallback;
              if (!getCallback) continue;
              const cb = getCallback();
              cb.fn = triggerHandle.onTriggerEnter;
              cb.event.tag = otherHandle.tag ?? null;
              cb.event.playerId = otherHandle.playerId ?? null;
              this.triggerCallbacks.push(cb);
            }
            otherHandle.triggeredHandles.add(triggerHandle);
          }
        } else if (
          pair.status ===
          (PHYSX as PhysXModule).PxPairFlagEnum.eNOTIFY_TOUCH_LOST
        ) {
          if (otherHandle.triggeredHandles.has(triggerHandle)) {
            if (triggerHandle.onTriggerLeave) {
              const getCallback = this.getTriggerCallback;
              if (!getCallback) continue;
              const cb = getCallback();
              cb.fn = triggerHandle.onTriggerLeave;
              cb.event.tag = otherHandle.tag ?? null;
              cb.event.playerId = otherHandle.playerId ?? null;
              this.triggerCallbacks.push(cb);
            }
            otherHandle.triggeredHandles.delete(triggerHandle);
          }
        }
      }
    };

    simulationEventCallback.onConstraintBreak = (
      _constraint: unknown,
      _flags: unknown,
    ) => {
      // Constraint break events are not currently handled
      // This callback can be implemented when constraint physics are added
    };

    // Create scene
    const sceneDesc = new PHYSX.PxSceneDesc(this.tolerances!);
    sceneDesc.gravity = new PHYSX.PxVec3(0, -9.81, 0);
    const physxModule = getPhysX()!;
    sceneDesc.cpuDispatcher = createCpuDispatcher(physxModule, 0);
    const physxWithTopLevel = PHYSX as typeof PhysX & {
      DefaultFilterShader(): PhysX.PxSimulationFilterShader;
    };
    sceneDesc.filterShader = physxWithTopLevel.DefaultFilterShader();
    (
      sceneDesc.flags as { raise: (flag: number, value: boolean) => void }
    ).raise(PHYSX.PxSceneFlagEnum.eENABLE_CCD, true);
    (
      sceneDesc.flags as { raise: (flag: number, value: boolean) => void }
    ).raise(PHYSX.PxSceneFlagEnum.eENABLE_ACTIVE_ACTORS, true);
    sceneDesc.solverType = PHYSX.PxSolverTypeEnum.eTGS;
    sceneDesc.simulationEventCallback = simulationEventCallback;
    sceneDesc.broadPhaseType = PHYSX.PxBroadPhaseTypeEnum.eGPU;
    this.scene = this.physics.createScene(sceneDesc);
  }

  private setupQueryObjects(): void {
    const PHYSX = getPhysX();
    if (!PHYSX) {
      throw new Error(
        "[Physics] Cannot setup query objects - PHYSX not loaded",
      );
    }

    this.raycastResult = new PHYSX.PxRaycastResult();
    this.sweepPose = new PHYSX.PxTransform(
      PHYSX.PxIDENTITYEnum.PxIdentity,
    ) as PxTransform;
    this.sweepResult = new PHYSX.PxSweepResult();
    this.overlapPose = new PHYSX.PxTransform(
      PHYSX.PxIDENTITYEnum.PxIdentity,
    ) as PxTransform;
    this.overlapResult = new PHYSX.PxOverlapResult();
    this.queryFilterData = new PHYSX.PxQueryFilterData();

    this._pv1 = new PHYSX.PxVec3() as PxVec3;
    this._pv2 = new PHYSX.PxVec3() as PxVec3;
    this._pv_velocity = new PHYSX.PxVec3() as PxVec3;
    this.transform = new PHYSX.PxTransform(
      PHYSX.PxIDENTITYEnum.PxIdentity,
    ) as PxTransform;

    // Pre-allocate PxHitFlags for raycast and sweep to avoid per-query allocations
    this._raycastHitFlags = new PHYSX.PxHitFlags(
      PHYSX.PxHitFlagEnum.ePOSITION | PHYSX.PxHitFlagEnum.eNORMAL,
    );
    this._sweepHitFlags = new PHYSX.PxHitFlags(PHYSX.PxHitFlagEnum.eDEFAULT);
  }

  private setupControllerManager(): void {
    const PHYSX = getPhysX();
    if (!PHYSX) {
      throw new Error(
        "[Physics] Cannot setup controller manager - PHYSX not loaded",
      );
    }

    // Top-level functions are exposed directly on the PHYSX module in WebIDL bindings
    const physxWithFunctions = PHYSX as PhysXModule & {
      CreateControllerManager: (
        scene: PxScene,
        lockingEnabled?: boolean,
      ) => PxControllerManager;
    };

    this.controllerManager = physxWithFunctions.CreateControllerManager(
      this.scene!,
    );
    this.controllerFilters = new PHYSX.PxControllerFilters();
    if (this.controllerFilters) {
      const filterData = new PHYSX.PxFilterData(
        Layers.player!.group,
        Layers.player!.mask,
        0,
        0,
      );
      this.controllerFilters.mFilterData = filterData;

      const filterCallback = {
        simplePreFilter: (
          filterDataPtr: unknown,
          shapePtr: unknown,
          _actor: unknown,
        ) => {
          const physxModule = getPhysX()!;
          const filterData = (physxModule as PhysXModule).wrapPointer?.(
            filterDataPtr as number,
            PHYSX.PxFilterData,
          );
          const shape = (physxModule as PhysXModule).wrapPointer?.(
            shapePtr as number,
            PHYSX.PxShape,
          );
          if (!shape || !filterData) return PHYSX.PxQueryHitType.eNONE;
          const shapeFilterData = shape.getQueryFilterData();
          if (
            filterData.word0 & shapeFilterData.word1 &&
            shapeFilterData.word0 & filterData.word1
          ) {
            return PHYSX.PxQueryHitType.eBLOCK;
          }
          return PHYSX.PxQueryHitType.eNONE;
        },
      };

      const cctFilterCallback = new PHYSX.PxControllerFilterCallbackImpl();
      cctFilterCallback.filter = (_aPtr: unknown, _bPtr: unknown) => {
        return true; // For now ALL CCTs collide
      };

      this.controllerFilters.mFilterCallback = filterCallback;
      this.controllerFilters.mCCTFilterCallback = cctFilterCallback;
    }
  }

  override start(): void {
    const PHYSX = getPhysX();
    // Check if PhysX is loaded before attempting to use it
    if (!PHYSX || !this.physics || !this.scene) {
      this.logger.info("Skipping ground plane creation - PhysX not loaded");
      return;
    }

    // Create ground plane (large static box) but keep it off gameplay masks
    const size = 1000;
    const halfExtents = new PHYSX.PxVec3(size / 2, 1 / 2, size / 2);
    const geometry = new PHYSX.PxBoxGeometry(
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    );
    const material = this.physics.createMaterial(0.6, 0.6, 0);
    const _flags = new PHYSX.PxShapeFlags(
      PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
        PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE,
    );
    const shape = this.physics.createShape(geometry, material, true, _flags);
    // Keep ground helper isolated from gameplay queries/collisions
    const layer = Layers.ground_helper || { group: 0, mask: 0 };
    // Set query and simulation filters so nothing hits it unless explicitly masked
    const filterData = new PHYSX.PxFilterData(layer.group, 0, 0, 0);
    shape.setQueryFilterData(filterData);
    shape.setSimulationFilterData(filterData);

    const transform = new PHYSX.PxTransform(PHYSX.PxIDENTITYEnum.PxIdentity);
    transform.p.y = -0.5;
    const body = this.physics.createRigidStatic(transform);
    body.attachShape(shape);
    this.scene.addActor(body);
  }

  addActor(
    actor: PxActor | PxRigidDynamic,
    handle: PhysicsHandle,
  ): ActorHandle | null {
    if (!this.scene) {
      this.logger.warn("Cannot add actor - Physics not initialized");
      return null;
    }

    handle.actor = actor;
    handle.contactedHandles = new Set();
    handle.triggeredHandles = new Set();

    // Type guard to ensure interpolation is only set up when onInterpolate exists
    if (handle.onInterpolate) {
      // TypeScript now knows this is an InterpolatedPhysicsHandle
      const interpolatedHandle = handle as InterpolatedPhysicsHandle;
      interpolatedHandle.interpolation = {
        prev: {
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
        },
        next: {
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
        },
        curr: {
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
        },
      };
      const pose =
        "getGlobalPose" in actor
          ? (actor as PxRigidDynamic).getGlobalPose()
          : null;
      if (pose && pose.p && pose.q) {
        interpolatedHandle.interpolation.prev.position.copy(pose.p);
        interpolatedHandle.interpolation.prev.quaternion.copy(pose.q);
        interpolatedHandle.interpolation.next.position.copy(pose.p);
        interpolatedHandle.interpolation.next.quaternion.copy(pose.q);
        interpolatedHandle.interpolation.curr.position.copy(pose.p);
        interpolatedHandle.interpolation.curr.quaternion.copy(pose.q);
      } else {
        this.logger.warn("Actor pose not available during interpolation setup");
      }
    }

    const actorAddress = getActorAddress(actor);
    if (actorAddress !== undefined) {
      this.handles.set(actorAddress, handle);
    }
    if (!handle.controller) {
      this.scene.addActor(actor);
    }

    return {
      move: (matrix: THREE.Matrix4) => {
        if (this.ignoreSetGlobalPose) {
          // Check if it's a dynamic body (not kinematic)
          const dynamicActor = actor as PxRigidDynamic;
          if (dynamicActor.getRigidBodyFlags) {
            const PHYSX = getPhysX();
            if (PHYSX) {
              const isDynamic = !dynamicActor
                .getRigidBodyFlags()
                .isSet(PHYSX.PxRigidBodyFlagEnum.eKINEMATIC);
              if (isDynamic) return;
            }
          }
          return;
        }
        if (matrix.toPxTransform) {
          matrix.toPxTransform(this.transform);
        } else {
          setTransformFromMatrix4(this.transform, matrix);
        }
        if ("setGlobalPose" in actor) {
          (actor as PxRigidDynamic).setGlobalPose(this.transform);
        }
      },
      snap: (pose: PxTransform) => {
        if (!pose || !pose.p || !pose.q) {
          this.logger.warn("Invalid pose provided to snap function");
          return;
        }
        if ("setGlobalPose" in actor) {
          (actor as PxRigidDynamic).setGlobalPose(pose);
        }
        // Type guard: if handle has onInterpolate, it must have interpolation
        if (handle.onInterpolate) {
          const interpolatedHandle = handle as InterpolatedPhysicsHandle;
          interpolatedHandle.interpolation.prev.position.copy(pose.p);
          interpolatedHandle.interpolation.prev.quaternion.copy(pose.q);
          interpolatedHandle.interpolation.next.position.copy(pose.p);
          interpolatedHandle.interpolation.next.quaternion.copy(pose.q);
          interpolatedHandle.interpolation.curr.position.copy(pose.p);
          interpolatedHandle.interpolation.curr.quaternion.copy(pose.q);
          interpolatedHandle.interpolation.skip = true;
        }
      },
      destroy: () => {
        // End any contacts
        if (handle.contactedHandles.size) {
          const getCallback = this.getContactCallback;
          if (!getCallback)
            return { move: () => {}, snap: () => {}, destroy: () => {} };
          const cb = getCallback().init(false);
          for (const otherHandle of handle.contactedHandles) {
            if (otherHandle.onContactEnd) {
              cb.fn0 = otherHandle.onContactEnd;
              cb.event0.tag = handle.tag ?? null;
              cb.event0.playerId = handle.playerId ?? null;
              cb.exec();
            }
            otherHandle.contactedHandles.delete(handle);
          }
        }
        // End any triggers
        if (handle.triggeredHandles.size) {
          const getCallback = this.getTriggerCallback;
          if (getCallback) {
            const cb = getCallback();
            for (const triggerHandle of handle.triggeredHandles) {
              if (triggerHandle.onTriggerLeave) {
                cb.fn = triggerHandle.onTriggerLeave;
                cb.event.tag = handle.tag ?? null;
                cb.event.playerId = handle.playerId ?? null;
                cb.exec();
              }
            }
          }
        }
        // Remove from scene
        if (!handle.controller) {
          this.scene?.removeActor(actor);
        }
        // Delete data
        const actorWithAddress = actor as PxActorWithAddress;
        this.handles.delete(actorWithAddress._address);
      },
    };
  }

  override preFixedUpdate(willFixedUpdate: boolean): void {
    if (willFixedUpdate) {
      // If physics will step, clear active actors so we can repopulate
      this.active.clear();
    }
  }

  override postFixedUpdate(delta: number): void {
    if (!this.scene) return; // Skip if physics not initialized

    // DEBUG: Skip physics simulation on server to test memory leak
    if (this.world.isServer) return;

    this.scene.simulate(delta);
    this.scene.fetchResults(true);

    // Log physics step periodically
    // Commented out verbose physics stepping log
    // if (Math.random() < 0.01) { // Log ~1% of frames
    //   console.log(`[Physics] Stepping physics with delta=${delta.toFixed(4)}`);
    // }
    if (this.processContactCallbacks) this.processContactCallbacks();
    if (this.processTriggerCallbacks) this.processTriggerCallbacks();

    const PHYSX = getPhysX();
    if (!this.scene || !PHYSX) return; // Skip if physics not initialized

    // Check if PhysX has the SupportFunctions module
    if (!PHYSX.SupportFunctions?.PxScene_getActiveActors) return;

    const activeActorsAny = PHYSX.SupportFunctions.PxScene_getActiveActors(
      this.scene,
    ) as unknown;
    const activeActors = activeActorsAny as {
      size(): number;
      get(index: number): { _address: number | bigint };
    };
    const size = activeActors.size();

    // Log active actors periodically
    if (Math.random() < 0.01) {
      // Log ~1% of frames
    }

    for (let i = 0; i < size; i++) {
      const actorPtr = activeActors.get(i)._address;
      const handle = this.handles.get(actorPtr);
      if (!handle || !handle.onInterpolate) {
        continue;
      }
      // TypeScript knows this is an InterpolatedPhysicsHandle
      const interpolatedHandle = handle as InterpolatedPhysicsHandle;
      const lerp = interpolatedHandle.interpolation;

      // No need for runtime checks - TypeScript guarantees these exist
      lerp.prev.position.copy(lerp.next.position);
      lerp.prev.quaternion.copy(lerp.next.quaternion);
      const pose =
        interpolatedHandle.actor && "getGlobalPose" in interpolatedHandle.actor
          ? (interpolatedHandle.actor as PxRigidDynamic).getGlobalPose()
          : null;
      if (pose && pose.p && pose.q) {
        lerp.next.position.copy(pose.p);
        lerp.next.quaternion.copy(pose.q);
        this.active.add(interpolatedHandle);
      } else {
        this.logger.warn("Actor pose not available in postFixedUpdate");
      }
    }
  }

  // PERFORMANCE: Track interpolation count for monitoring
  private _lastInterpolationCount = 0;
  private _interpolationWarningThreshold = 100;

  override preUpdate(alpha: number): void {
    // PERFORMANCE: Physics interpolation must run for visual smoothness,
    // but we track count to detect performance issues
    let interpolated = 0;

    for (const handle of this.active) {
      // Type guard: only handles with onInterpolate have interpolation
      if (!handle.onInterpolate) continue;

      // TypeScript now knows this is an InterpolatedPhysicsHandle
      const interpolatedHandle = handle as InterpolatedPhysicsHandle;
      const lerp = interpolatedHandle.interpolation;

      if (lerp.skip) {
        lerp.skip = false;
        continue;
      }

      // No need for runtime checks - TypeScript guarantees these exist
      lerp.curr.position.lerpVectors(
        lerp.prev.position,
        lerp.next.position,
        alpha,
      );
      lerp.curr.quaternion.slerpQuaternions(
        lerp.prev.quaternion,
        lerp.next.quaternion,
        alpha,
      );
      interpolatedHandle.onInterpolate(
        lerp.curr.position,
        lerp.curr.quaternion,
      );
      interpolated++;
    }

    // Warn if interpolation count is unusually high (potential performance issue)
    if (
      interpolated > this._interpolationWarningThreshold &&
      interpolated > this._lastInterpolationCount * 1.5
    ) {
      console.warn(
        `[Physics] High interpolation count: ${interpolated} active handles (may impact frame rate)`,
      );
    }
    this._lastInterpolationCount = interpolated;

    // Finalize any physics updates immediately
    // but don't listen to any loopback commits from those actor moves
    this.ignoreSetGlobalPose = true;
    // Assume stage exists and has clean method
    this.world.stage.clean();
    this.ignoreSetGlobalPose = false;
  }

  // Internal raycast method with layer mask support
  private _raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number = Infinity,
    layerMask: number = 0xffffffff,
  ): PhysicsRaycastHit | null {
    // Early return if PhysX is not available
    if (!this.initialized || !this.scene) {
      return null;
    }
    // An empty application group mask means no hits. PhysX instead treats an
    // all-zero query filter as unfiltered, so do not submit that special case.
    if (layerMask === 0) return null;
    // Validate inputs and normalize direction to satisfy PhysX requirement (unit vector)
    if (
      !Number.isFinite(origin.x) ||
      !Number.isFinite(origin.y) ||
      !Number.isFinite(origin.z)
    ) {
      throw new Error("[Physics.raycast] Origin contains non-finite values");
    }
    if (
      !Number.isFinite(direction.x) ||
      !Number.isFinite(direction.y) ||
      !Number.isFinite(direction.z)
    ) {
      throw new Error("[Physics.raycast] Direction contains non-finite values");
    }
    const dirLen = Math.sqrt(
      direction.x * direction.x +
        direction.y * direction.y +
        direction.z * direction.z,
    );
    if (dirLen <= 1e-6) {
      throw new Error(
        "[Physics.raycast] Direction vector is too small to normalize",
      );
    }
    // Use pre-allocated Vector3 to avoid per-raycast allocations
    _raycastDirNormalized.set(
      direction.x / dirLen,
      direction.y / dirLen,
      direction.z / dirLen,
    );
    const dirNormalized = _raycastDirNormalized;

    if (this.queryFilterData) {
      // Scene queries OR the same-word intersections, unlike simulation's
      // crossed group/mask rule. Match only shape.word0 (its group), otherwise
      // an excluded shape's broad word1 can hide a later environment hit.
      // This object is shared with sweeps/overlaps: reset every extra word.
      const data = this.queryFilterData.data;
      if (data) {
        data.word0 = layerMask;
        data.word1 = 0;
        data.word2 = 0;
        data.word3 = 0;
      }
    }

    // Try to use enhanced Vector3 methods first

    const originWithMethod = origin as unknown as {
      toPxVec3?: (buffer?: PxVec3) => PxVec3 | null;
    };
    const dirWithMethod = dirNormalized as unknown as {
      toPxVec3?: (buffer?: PxVec3) => PxVec3 | null;
    };

    let pxOrigin: PxVec3 | null =
      originWithMethod.toPxVec3?.(this._pv1 || undefined) || null;

    let pxDirection: PxVec3 | null =
      dirWithMethod.toPxVec3?.(this._pv2 || undefined) || null;

    // If the enhanced method didn't work, use pre-allocated PxVec3 instead of allocating
    if (!pxOrigin && this._pv1) {
      this._pv1.x = origin.x;
      this._pv1.y = origin.y;
      this._pv1.z = origin.z;
      pxOrigin = this._pv1;
    }
    if (!pxDirection && this._pv2) {
      this._pv2.x = dirNormalized.x;
      this._pv2.y = dirNormalized.y;
      this._pv2.z = dirNormalized.z;
      pxDirection = this._pv2;
    }

    if (!pxOrigin || !pxDirection) {
      return null;
    }

    // Use pre-allocated PxHitFlags to avoid per-raycast allocations
    if (!this._raycastHitFlags) {
      return null;
    }
    const didHit =
      this.scene?.raycast(
        pxOrigin,
        pxDirection,
        maxDistance,
        this.raycastResult!,
        this._raycastHitFlags,
        this.queryFilterData || undefined,
      ) || false;

    if (didHit && this.raycastResult) {
      const numHits = (
        this.raycastResult as PxRaycastResult & { getNbAnyHits: () => number }
      ).getNbAnyHits();
      let hit: {
        actor: PxActor;
        position: { x: number; y: number; z: number };
        normal: { x: number; y: number; z: number };
        distance: number;
      } | null = null;
      for (let n = 0; n < numHits; n++) {
        const nHit = (
          this.raycastResult as PxRaycastResult & {
            getAnyHit: (index: number) => PhysX.PxRaycastHit;
          }
        ).getAnyHit(n);
        const convertedHit = convertHitResult(nHit) as {
          actor: PxActor;
          position: { x: number; y: number; z: number };
          normal: { x: number; y: number; z: number };
          distance: number;
        };
        if (!hit || hit.distance > convertedHit.distance) {
          hit = convertedHit;
        }
      }
      if (hit) {
        const actorAddress = getActorAddress(hit.actor);
        _raycastHit.handle =
          actorAddress !== undefined
            ? this.handles.get(actorAddress)
            : undefined;

        // Debug: Check if position is valid
        if (
          !hit.position ||
          (hit.position.x === 0 &&
            hit.position.y === 0 &&
            hit.position.z === 0 &&
            hit.distance > 1)
        ) {
          console.warn(
            "[Physics] Suspicious hit position at origin with distance:",
            hit.distance,
          );
        }

        _raycastHit.point.set(hit.position.x, hit.position.y, hit.position.z);
        _raycastHit.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        _raycastHit.distance = hit.distance;
      }
      return _raycastHit;
    }
    return null;
  }

  // Interface-compliant raycast method
  raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance?: number,
    layerMask?: number,
  ): IRaycastHit | null {
    const hit = this._raycast(
      origin as THREE.Vector3,
      direction as THREE.Vector3,
      maxDistance || Infinity,
      layerMask ?? 0xffffffff,
    );
    if (!hit) return null;

    // Convert internal RaycastHit to interface-compliant RaycastHit
    return {
      point: hit.point,
      normal: hit.normal,
      distance: hit.distance || 0,
      collider: placeholderCollider,
      handle: hit.handle,
    };
  }

  // raycast with layer mask (not in interface)
  raycastWithMask(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    layerMask: number,
  ): PhysicsRaycastHit | null {
    return this._raycast(origin, direction, maxDistance, layerMask);
  }

  sweep(
    geometry: unknown,
    origin: Vector3,
    direction: Vector3,
    maxDistance?: number,
    layerMask?: number,
  ): IRaycastHit | null {
    const PHYSX = getPhysX();
    if (!PHYSX) return null; // Early return if PhysX is not available

    const maxDist = maxDistance !== undefined ? maxDistance : 1000; // Use finite default instead of Infinity
    const mask = layerMask !== undefined ? layerMask : 0xffffffff;

    // Set sweep position
    if (this.sweepPose.p) {
      const pxOrigin = vector3ToPxVec3(
        origin as THREE.Vector3,
        this.sweepPose.p as PxVec3,
      );
      if (!pxOrigin) return null; // Return null if conversion failed
    }
    const sweepDirection = vector3ToPxVec3(
      direction as THREE.Vector3,
      this._pv2 || undefined,
    );
    if (!sweepDirection) return null; // Return null if conversion failed

    if (this.queryFilterData) {
      this.queryFilterData.data.word0 = mask;
      this.queryFilterData.data.word1 = mask;
    }

    // Use pre-allocated PxHitFlags to avoid per-sweep allocations
    if (!this._sweepHitFlags) {
      return null;
    }
    const didHit =
      this.scene?.sweep(
        geometry as PxGeometry,
        this.sweepPose,
        sweepDirection,
        maxDist,
        this.sweepResult as PxSweepResult,
        this._sweepHitFlags,
        this.queryFilterData || undefined,
      ) || false;

    if (didHit && this.sweepResult) {
      const numHits = (
        this.sweepResult as PxSweepResult & { getNbAnyHits: () => number }
      ).getNbAnyHits();
      let hit: {
        actor: PxActor;
        position: { x: number; y: number; z: number };
        normal: { x: number; y: number; z: number };
        distance: number;
      } | null = null;
      for (let n = 0; n < numHits; n++) {
        const nHit = (
          this.sweepResult as PxSweepResult & {
            getAnyHit: (index: number) => PhysX.PxSweepHit;
          }
        ).getAnyHit(n);
        const convertedHit = convertHitResult(nHit) as {
          actor: PxActor;
          position: { x: number; y: number; z: number };
          normal: { x: number; y: number; z: number };
          distance: number;
        };
        if (!hit || hit.distance > convertedHit.distance) {
          hit = convertedHit;
        }
      }
      if (hit) {
        _sweepHit.actor = hit.actor;
        _sweepHit.point.set(hit.position.x, hit.position.y, hit.position.z);
        _sweepHit.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        _sweepHit.distance = hit.distance;
        _sweepHit.collider = placeholderCollider;

        // Convert to RaycastHit format
        return {
          point: _sweepHit.point,
          normal: _sweepHit.normal,
          distance: _sweepHit.distance || 0,
          collider: _sweepHit.collider,
          handle: _sweepHit.actor,
        };
      }
    }
    return null;
  }

  // Internal overlap sphere method with layer mask support
  private _overlapSphere(
    radius: number,
    origin: THREE.Vector3,
    layerMask: number = 0xffffffff,
  ): OverlapHit[] {
    // Use the enhanced Vector3 method if available, otherwise set position manually
    if ((origin as any).toPxVec3 && this.overlapPose.p) {
      (origin as any).toPxVec3(this.overlapPose.p);
    } else if (this.overlapPose.p) {
      this.overlapPose.p.x = origin.x;
      this.overlapPose.p.y = origin.y;
      this.overlapPose.p.z = origin.z;
    }

    const geometry = getSphereGeometry(radius);
    if (this.queryFilterData) {
      this.queryFilterData.data.word0 = layerMask;
      this.queryFilterData.data.word1 = layerMask;
    }

    const didHit =
      this.scene?.overlap(
        geometry,
        this.overlapPose,
        this.overlapResult!,
        this.queryFilterData || undefined,
      ) || false;
    if (!didHit || !this.overlapResult) return [];

    overlapHits.length = 0;
    const numHits = (
      this.overlapResult as PxOverlapResult & { getNbAnyHits: () => number }
    ).getNbAnyHits();
    for (let n = 0; n < numHits; n++) {
      const nHit = (
        this.overlapResult as PxOverlapResult & {
          getAnyHit: (index: number) => { actor: PxActor };
        }
      ).getAnyHit(n);
      const hit = getOrCreateOverlapHit(n);
      hit.actor = nHit.actor;
      const actorAddress = getActorAddress(nHit.actor);
      hit.handle =
        actorAddress !== undefined
          ? (this.handles.get(actorAddress) ?? null)
          : null;
      overlapHits.push(hit);
    }
    return overlapHits;
  }

  // Interface-compliant overlapSphere method
  overlapSphere(_position: Vector3, _radius: number): Collider[] {
    // Note: This returns empty array as we don't have Collider objects in this implementation
    // The actual physics implementation uses OverlapHit objects instead
    return [];
  }

  // overlap sphere with layer mask (not in interface)
  overlapSphereWithMask(
    radius: number,
    origin: THREE.Vector3,
    layerMask: number,
  ): OverlapHit[] {
    return this._overlapSphere(radius, origin, layerMask);
  }

  getMaterial(
    staticFriction: number,
    dynamicFriction: number,
    restitution: number,
  ): PxMaterial | null {
    if (!this.physics) {
      console.warn(
        "[Physics] Cannot create material - Physics not initialized",
      );
      return null;
    }

    // Cache and re-use materials as PhysX has a limit of 64k
    const id = `${staticFriction}${dynamicFriction}${restitution}`;
    let material = this.materials[id];
    if (!material) {
      material = this.physics.createMaterial(
        staticFriction,
        dynamicFriction,
        restitution,
      );
      this.materials[id] = material;
    }
    return material;
  }

  // IPhysics interface methods
  createRigidBody(
    _type: "static" | "dynamic" | "kinematic",
    _position?: Vector3,
    _rotation?: Quaternion,
  ): RigidBody {
    throw new Error("Not implemented - use addActor instead");
  }

  createCollider(
    _geometry: PxGeometry,
    _material?: PhysicsMaterial,
    _isTrigger?: boolean,
  ): PxShape | null {
    throw new Error("Not implemented - use PhysX geometry directly");
  }

  createMaterial(
    staticFriction?: number,
    dynamicFriction?: number,
    restitution?: number,
  ): PhysicsMaterial {
    const _material = this.getMaterial(
      staticFriction || 0.5,
      dynamicFriction || 0.5,
      restitution || 0.5,
    );
    // Convert PhysXMaterial to PhysicsMaterial interface
    return {
      friction: staticFriction || 0.5,
      restitution: restitution || 0.5,
    };
  }

  sphereCast(
    origin: Vector3,
    radius: number,
    direction: Vector3,
    maxDistance?: number,
    layerMask?: number,
  ): import("../../../types").RaycastHit | null {
    const geometry = getSphereGeometry(radius);
    const hit = this.sweep(
      geometry,
      origin,
      direction,
      maxDistance || 1000,
      layerMask || 0xffffffff,
    );
    if (!hit) return null;

    // Convert SweepHit to RaycastHit interface
    return {
      point: hit.point,
      normal: hit.normal,
      distance: hit.distance || 0,
      collider: placeholderCollider, // Will be populated when proper Collider objects are available
      entity: undefined, // Optional entity
    };
  }

  simulate(_deltaTime: number): void {
    // Handled in postFixedUpdate
  }

  // Add missing methods referenced in World.ts
  createLayerMask(...layers: string[]): number {
    // Create a layer mask based on the provided layer names
    let mask = 0;
    for (const layerName of layers) {
      const layer = Layers[layerName];
      if (layer) {
        mask |= layer.group;
      } else {
        console.warn(`[Physics] Unknown layer: ${layerName}`);
      }
    }
    return mask;
  }

  // Add removeCollider method referenced in ColliderComponent.ts
  removeCollider(_collider: PxShape): void {
    // Note: In PhysX, shapes don't have direct references to actors
    // The ColliderComponent should manage the actor removal
    console.warn(
      "[Physics] removeCollider called but shapes do not have actor references - use removeActor instead",
    );
  }

  // Add missing methods from IPhysics interface
  removeActor(actor: PxActor | PxRigidDynamic): void {
    if (actor) {
      const actorAddress = getActorAddress(actor);
      if (actorAddress === undefined) return;

      const handle = this.handles.get(actorAddress);
      if (handle) {
        this.scene?.removeActor(actor);
        this.handles.delete(actorAddress);
      }
    }
  }

  setLinearVelocity(actor: PxRigidDynamic, velocity: Vector3): void {
    // OPTIMIZATION: Use pre-allocated PxVec3 to avoid allocation per velocity set
    if (actor && actor.setLinearVelocity && this._pv_velocity) {
      this._pv_velocity.x = velocity.x;
      this._pv_velocity.y = velocity.y;
      this._pv_velocity.z = velocity.z;
      actor.setLinearVelocity(this._pv_velocity);
    }
  }

  // Missing lifecycle methods
  preTick(): void {}
  fixedUpdate(_dt: number): void {}
  postUpdate(): void {}
  lateUpdate(): void {}
  postLateUpdate(): void {}
  commit(): void {}
  postTick(): void {}
}

// Helper functions
// Cache sphere geometries by radius to avoid per-overlap allocations
function getSphereGeometry(radius: number): PxSphereGeometry {
  // Round radius to 2 decimal places for cache key
  const cacheKey = Math.round(radius * 100) / 100;
  let geo = _sphereGeometryCache.get(cacheKey);
  if (geo) {
    return geo;
  }

  const PHYSX = getPhysX();
  if (!PHYSX) {
    throw new Error("PhysX not loaded");
  }
  geo = new PHYSX.PxSphereGeometry(radius);
  if (!geo) {
    throw new Error("Failed to create sphere geometry");
  }
  _sphereGeometryCache.set(cacheKey, geo);
  return geo;
}

// Helper function to get actor address
function getActorAddress(actor: PxActor): number | bigint | undefined {
  return (actor as PxActorWithAddress)._address;
}

function getOrCreateOverlapHit(idx: number): OverlapHit {
  let hit = overlapHitPool[idx];
  if (!hit) {
    hit = {
      actor: {} as PhysX.PxActor,
      handle: null,
      proxy: {
        get tag() {
          return hit.handle?.tag || null;
        },
        get playerId() {
          return hit.handle?.playerId || null;
        },
      },
    };
    overlapHitPool.push(hit);
  }
  return hit;
}
