/**
 * RigidBody.ts - Physics-Enabled Node
 *
 * Node with PhysX rigid body physics. Supports static, dynamic, and kinematic modes.
 */

import * as THREE from "../extras/three/three";
import type { RigidBodyData, PhysXActor } from "../types/rendering/nodes";
import type {
  ActorHandle as EngineActorHandle,
  PhysicsHandle,
} from "../types/systems/physics";
import type {
  PxActor,
  PxQuat,
  PxRigidBody,
  PxRigidDynamic,
  PxRigidStatic,
  PxShape,
  PxTransform,
  PxVec3,
} from "../types/systems/physics";
import type { EntityData } from "../types/core/base-types";
import { Node } from "./Node";
import { vector3ToPxVec3 } from "../utils/physics/PhysicsUtils";

type RuntimePhysX = {
  PxTransform: new (identity: unknown) => PxTransform;
  PxVec3: new (x: number, y: number, z: number) => PxVec3;
  PxQuat: new (x: number, y: number, z: number, w: number) => PxQuat;
  PxIDENTITYEnum: { PxIdentity: unknown };
  destroy: (obj: unknown) => void;
  PxRigidBodyExt?: {
    setMassAndUpdateInertia: (actor: unknown, mass: number) => void;
    addForceAtPos: (
      actor: unknown,
      force: PxVec3,
      pos: PxVec3,
      mode: number,
      wakeup: boolean,
    ) => void;
    addForceAtLocalPos: (
      actor: unknown,
      force: PxVec3,
      pos: PxVec3,
      mode: number,
      wakeup: boolean,
    ) => void;
    getVelocityAtPos: (actor: PxRigidBody, pos: PxVec3) => PxVec3;
    getLocalVelocityAtLocalPos: (actor: PxRigidBody, pos: PxVec3) => PxVec3;
  };
};

function getRuntimePhysX(): RuntimePhysX | null {
  return (
    (globalThis as typeof globalThis & { PHYSX?: RuntimePhysX }).PHYSX ?? null
  );
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _defaultScale = new THREE.Vector3(1, 1, 1);

// Pre-allocated temps for onInterpolate to avoid per-frame allocations
const _interpComposePos = new THREE.Vector3();
const _interpComposeQuat = new THREE.Quaternion();
const _interpComposeScale = new THREE.Vector3();
const _interpDecomposePos = new THREE.Vector3();
const _interpDecomposeQuat = new THREE.Quaternion();
const _interpDecomposeScale = new THREE.Vector3();

const types = ["static", "kinematic", "dynamic"];

const defaults = {
  type: "static",
  mass: 1,
  linearDamping: 0, // physx default
  angularDamping: 0.05, // phyx default
  tag: null,
  onContactStart: null,
  onContactEnd: null,
  onTriggerEnter: null,
  onTriggerLeave: null,
};

let forceModes: Record<string, number> | undefined;
function getForceMode(mode: string | number): number {
  const physx = getRuntimePhysX();
  if (!physx) {
    console.warn("[rigidbody] PHYSX not initialized, cannot get force mode");
    return 0;
  }
  if (!forceModes) {
    forceModes = {
      force: 0, // PxForceMode.eFORCE
      impulse: 1, // PxForceMode.eIMPULSE
      acceleration: 3, // PxForceMode.eACCELERATION
      velocityChange: 2, // PxForceMode.eVELOCITY_CHANGE
    };
  }
  return forceModes[mode] || forceModes.force;
}

export class RigidBody extends Node {
  shapes: Set<unknown>;
  _tm: PxTransform | null = null;
  tempVec3: THREE.Vector3;
  tempQuat: THREE.Quaternion;
  needsRebuild: boolean = false;
  transform: PxTransform | null = null;
  _type: string = defaults.type;
  actor:
    | ((PxRigidDynamic | PxRigidStatic | PxRigidBody) & Partial<PhysXActor>)
    | null = null;
  _centerOfMass: THREE.Vector3 | null = null;
  actorHandle: EngineActorHandle | null = null;
  _tag: string | null = null;
  _onContactStart: Function | null = null;
  _onContactEnd: Function | null = null;
  _onTriggerEnter: Function | null = null;
  _onTriggerLeave: Function | null = null;
  _pv1!: THREE.Vector3;
  _pv2!: THREE.Vector3;
  _mass: number = defaults.mass;
  _linearDamping: number = defaults.linearDamping;
  _angularDamping: number = defaults.angularDamping;
  private nativePhysX: RuntimePhysX | null = null;

  constructor(data: RigidBodyData = {}) {
    super(data);
    this.name = "rigidbody";

    this.shapes = new Set();

    this.type = data.type ?? defaults.type;
    this.mass = data.mass ?? defaults.mass;
    this.linearDamping = data.linearDamping ?? defaults.linearDamping;
    this.angularDamping = data.angularDamping ?? defaults.angularDamping;
    this.tag = data.tag ?? null;
    this.onContactStart = data.onContactStart ?? null;
    this.onContactEnd = data.onContactEnd ?? null;
    this.onTriggerEnter = data.onTriggerEnter ?? null;
    this.onTriggerLeave = data.onTriggerLeave ?? null;

    // Initialize PhysX objects only when PhysX is available
    this._tm = null; // Will be initialized in mount()

    this.tempVec3 = new THREE.Vector3();
    this.tempQuat = new THREE.Quaternion();
  }

  mount() {
    this.needsRebuild = false;
    if (this.ctx!.moving) return; // physics ignored when moving apps around

    // Stream/spectator worlds intentionally omit physics and must not probe or
    // warn about a runtime they will never use.
    if (!this.ctx?.physics) {
      return;
    }

    const physx = getRuntimePhysX();
    if (!physx) {
      console.warn(
        "[rigidbody] PHYSX not initialized yet, skipping physics setup",
      );
      return;
    }

    if (this.actor) return;
    this.nativePhysX = physx;
    try {
      // Initialize PhysX objects now that PHYSX is available
      if (!this._tm) {
        this._tm = new physx.PxTransform(
          physx.PxIDENTITYEnum.PxIdentity,
        ) as PxTransform;
      }

      // Force decompose using temporary plain vectors
      const plainPos = new THREE.Vector3();
      const plainQuat = new THREE.Quaternion();
      const plainScale = new THREE.Vector3();
      const plainMatrix = new THREE.Matrix4().copy(this.matrixWorld);
      plainMatrix.decompose(plainPos, plainQuat, plainScale);
      _v1.copy(plainPos);
      _q1.copy(plainQuat);
      _v2.copy(plainScale);

      // Create transform and set position/rotation
      this.transform = new physx.PxTransform(
        physx.PxIDENTITYEnum.PxIdentity,
      ) as PxTransform;
      // Set position
      if (this.transform.p) {
        this.transform.p.x = _v1.x;
        this.transform.p.y = _v1.y;
        this.transform.p.z = _v1.z;
      }
      // Set rotation
      if (this.transform.q) {
        this.transform.q.x = _q1.x;
        this.transform.q.y = _q1.y;
        this.transform.q.z = _q1.z;
        this.transform.q.w = _q1.w;
      }

      if (this._type === "static") {
        this.actor = this.ctx!.physics.physics.createRigidStatic(
          this.transform,
        ) as PxRigidStatic;
      } else if (this._type === "kinematic") {
        const dynamicActor = this.ctx!.physics.physics.createRigidDynamic(
          this.transform,
        ) as PxRigidDynamic;
        this.actor = dynamicActor;
        if (dynamicActor.setRigidBodyFlag) {
          dynamicActor.setRigidBodyFlag(1, true); // PxRigidBodyFlag.eKINEMATIC
        }
        if (physx.PxRigidBodyExt?.setMassAndUpdateInertia) {
          physx.PxRigidBodyExt.setMassAndUpdateInertia(
            dynamicActor,
            this._mass,
          );
        }
      } else if (this._type === "dynamic") {
        const dynamicActor = this.ctx!.physics.physics.createRigidDynamic(
          this.transform,
        ) as PxRigidDynamic;
        this.actor = dynamicActor;
        if (physx.PxRigidBodyExt?.setMassAndUpdateInertia) {
          physx.PxRigidBodyExt.setMassAndUpdateInertia(
            dynamicActor,
            this._mass,
          );
        }
        if (this._centerOfMass) {
          const pose = new physx.PxTransform(
            physx.PxIDENTITYEnum.PxIdentity,
          ) as PxTransform;
          try {
            // Set center of mass position
            if (pose.p) {
              pose.p.x = this._centerOfMass.x;
              pose.p.y = this._centerOfMass.y;
              pose.p.z = this._centerOfMass.z;
            }
            // PhysXActor interface includes setCMassLocalPose
            if (dynamicActor && "setCMassLocalPose" in dynamicActor) {
              (dynamicActor as PhysXActor).setCMassLocalPose?.(pose);
            }
          } finally {
            physx.destroy(pose);
          }
        }
        dynamicActor.setLinearDamping?.(this._linearDamping);
        dynamicActor.setAngularDamping?.(this._angularDamping);
      }

      // Convert Set to Array for compatibility with older TypeScript targets
      const shapesArray = Array.from(this.shapes);
      for (const shape of shapesArray) {
        if (this.actor && "attachShape" in this.actor) {
          // PhysXActor interface includes attachShape
          (this.actor as PhysXActor).attachShape?.(shape as PxShape);
        }
      }

      const entity = this.ctx!.entity as
        { isPlayer?: boolean; data?: EntityData } | undefined;
      // Strong type assumption - entity.data is always EntityData if entity exists
      const playerId = entity?.isPlayer && entity.data ? entity.data.id : null;
      const handleOptions = {
        onInterpolate:
          this._type === "kinematic" || this._type === "dynamic"
            ? this.onInterpolate
            : null,
        node: this,
        tag: this._tag,
        playerId: playerId,
        onContactStart: this._onContactStart,
        onContactEnd: this._onContactEnd,
        onTriggerEnter: this._onTriggerEnter,
        onTriggerLeave: this._onTriggerLeave,
        contactedHandles: new Set(),
        triggeredHandles: new Set(),
        controller: false,
      } as PhysicsHandle;
      // Physics.addActor is properly typed now
      if (!this.actor) {
        this.unmount();
        return;
      }
      const handle = this.ctx!.physics.addActor(
        this.actor as PxActor,
        handleOptions,
      );
      this.actorHandle = handle ?? null;
    } catch (error) {
      // Retire partially constructed native ownership without replacing the
      // original mount failure if teardown also encounters an error.
      try {
        this.unmount();
      } catch {
        // The original failure remains authoritative.
      }
      throw error;
    }
  }

  commit(didMove: boolean) {
    if (this.needsRebuild) {
      this.unmount();
      this.mount();
      return;
    }
    if (didMove && this.actorHandle?.move) {
      this.actorHandle.move(this.matrixWorld);
    }
  }

  onInterpolate = (position: THREE.Vector3, quaternion: THREE.Quaternion) => {
    if (this.parent) {
      // Use pre-allocated temps to avoid per-frame allocations
      _interpComposePos.copy(position);
      _interpComposeQuat.copy(quaternion);
      _interpComposeScale.copy(_defaultScale);
      _m1.compose(_interpComposePos, _interpComposeQuat, _interpComposeScale);
      _m2.copy(this.parent.matrixWorld).invert();
      _m3.multiplyMatrices(_m2, _m1);
      _m3.decompose(
        _interpDecomposePos,
        _interpDecomposeQuat,
        _interpDecomposeScale,
      );
      this.position.copy(_interpDecomposePos);
      this.quaternion.copy(_interpDecomposeQuat);
      _v1.copy(_interpDecomposeScale);
      // this.matrix.copy(_m3)
      // this.matrixWorld.copy(_m1)
    } else {
      this.position.copy(position);
      this.quaternion.copy(quaternion);
      // this.matrix.compose(this.position, this.quaternion, this.scale)
      // this.matrixWorld.copy(this.matrix)
    }
  };

  unmount() {
    const actor = this.actor;
    const handle = this.actorHandle;
    const transform = this.transform;
    const target = this._tm;
    const physx = this.nativePhysX;
    this.actor = null;
    this.actorHandle = null;
    this.transform = null;
    this._tm = null;
    this.nativePhysX = null;
    try {
      handle?.destroy();
    } finally {
      try {
        actor?.release();
      } finally {
        // These are standalone constructors owned by this node. Their p/q
        // fields are borrowed native member views and must not be destroyed.
        try {
          if (transform) physx?.destroy(transform);
        } finally {
          if (target) physx?.destroy(target);
        }
      }
    }
  }

  addShape(shape: unknown) {
    if (!shape) return;
    this.shapes.add(shape);
    if (this.actor && "attachShape" in this.actor) {
      // PhysXActor interface includes attachShape
      (this.actor as PhysXActor).attachShape?.(shape as PxShape);
    }
  }

  removeShape(shape: unknown) {
    if (!shape) return;
    this.shapes.delete(shape);
    if (this.actor && "detachShape" in this.actor) {
      // PhysXActor interface includes detachShape
      (this.actor as PhysXActor).detachShape?.(shape as PxShape);
    }
  }

  copy(source: RigidBody, recursive: boolean) {
    super.copy(source, recursive);
    this._type = source._type;
    this._mass = source._mass;
    this._tag = source._tag;
    this._onContactStart = source._onContactStart;
    this._onContactEnd = source._onContactEnd;
    this._onTriggerEnter = source._onTriggerEnter;
    this._onTriggerLeave = source._onTriggerLeave;
    return this;
  }

  get type() {
    return this._type;
  }

  set type(value: string) {
    if (this._type === value) return;
    this._type = value;
    this.needsRebuild = true;
    this.setDirty();
  }

  get mass() {
    return this._mass;
  }

  set mass(value: number) {
    this._mass = value;
    this.needsRebuild = true;
    this.setDirty();
  }

  get linearDamping() {
    return this._linearDamping;
  }

  set linearDamping(value: number) {
    this._linearDamping = value;
    this.needsRebuild = true;
    this.setDirty();
  }

  get angularDamping() {
    return this._angularDamping;
  }

  set angularDamping(value: number) {
    this._angularDamping = value;
    this.needsRebuild = true;
    this.setDirty();
  }

  get tag() {
    return this._tag;
  }

  set tag(value: string | null) {
    this._tag = value;
  }

  get onContactStart() {
    return this._onContactStart;
  }

  set onContactStart(value: Function | null) {
    this._onContactStart = value;
  }

  get onContactEnd() {
    return this._onContactEnd;
  }

  set onContactEnd(value: Function | null) {
    this._onContactEnd = value;
  }

  get onTriggerEnter() {
    return this._onTriggerEnter;
  }

  set onTriggerEnter(value: Function | null) {
    this._onTriggerEnter = value;
  }

  get onTriggerLeave() {
    return this._onTriggerLeave;
  }

  set onTriggerLeave(value: Function | null) {
    this._onTriggerLeave = value;
  }

  get sleeping() {
    if (!this.actor) return false;
    // PhysXActor interface includes isSleeping
    return (this.actor as PhysXActor).isSleeping?.() ?? false;
  }

  addForce(force: THREE.Vector3, mode: string | number) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return;
    const forceMode = getForceMode(mode) || 0;
    // PhysXActor interface includes addForce - convert THREE.Vector3 to PxVec3
    const pxForce = vector3ToPxVec3(force);
    (this.actor as PhysXActor).addForce?.(pxForce, forceMode);
  }

  addForceAtPos(
    force: THREE.Vector3,
    pos: THREE.Vector3,
    mode: string | number,
  ) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return;
    const pxForce = _v1.set(force.x, force.y, force.z);
    const pxPos = _v2.set(pos.x, pos.y, pos.z);
    const forceMode = getForceMode(mode) || 0;
    if (physx.PxRigidBodyExt?.addForceAtPos) {
      // Create proper PxVec3 instances from THREE.Vector3
      const pxForceVec = vector3ToPxVec3(pxForce);
      const pxPosVec = vector3ToPxVec3(pxPos);
      physx.PxRigidBodyExt.addForceAtPos(
        this.actor as PxRigidBody,
        pxForceVec,
        pxPosVec,
        forceMode,
        true,
      );
    }
  }

  addForceAtLocalPos(
    force: THREE.Vector3,
    pos: THREE.Vector3,
    mode: string | number,
  ) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return;
    const pxForce = _v1.set(force.x, force.y, force.z);
    const pxPos = _v2.set(pos.x, pos.y, pos.z);
    const forceMode = getForceMode(mode) || 0;
    if (physx.PxRigidBodyExt?.addForceAtLocalPos) {
      // Create proper PxVec3 instances from THREE.Vector3
      const pxForceVec = vector3ToPxVec3(pxForce);
      const pxPosVec = vector3ToPxVec3(pxPos);
      physx.PxRigidBodyExt.addForceAtLocalPos(
        this.actor as PxRigidBody,
        pxForceVec,
        pxPosVec,
        forceMode,
        true,
      );
    }
  }

  addTorque(torque: THREE.Vector3, mode: string | number) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return;
    const forceMode = getForceMode(mode) || 0;
    // PhysXActor interface includes addTorque - convert THREE.Vector3 to PxVec3
    const pxTorque = vector3ToPxVec3(torque);
    (this.actor as PhysXActor).addTorque?.(pxTorque, forceMode);
  }

  getPosition(vec3?: THREE.Vector3) {
    if (!vec3) vec3 = this.tempVec3;
    if (!this.actor) return vec3.set(0, 0, 0);
    const pose = this.actor.getGlobalPose();
    if (pose && pose.p) {
      vec3.set(pose.p.x, pose.p.y, pose.p.z);
    }
    return vec3;
  }

  setPosition(vec3: THREE.Vector3) {
    if (!this.actor) return;
    const pose = this.actor.getGlobalPose();
    if (vec3.toPxTransform) {
      vec3.toPxTransform(pose);
    } else {
      // Manually set position if toPxTransform is not available
      if (pose.p) {
        pose.p.x = vec3.x;
        pose.p.y = vec3.y;
        pose.p.z = vec3.z;
      }
    }
    this.actor.setGlobalPose!(pose);
    this.position.copy(vec3);
  }

  getQuaternion(quat?: THREE.Quaternion) {
    if (!quat) quat = this.tempQuat;
    if (!this.actor) return quat.set(0, 0, 0, 1); // Fix quaternion set call
    const pose = this.actor.getGlobalPose();
    if (pose && pose.q) {
      quat.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
    }
    return quat;
  }

  setQuaternion(quat: THREE.Quaternion) {
    if (!this.actor) return;
    const pose = this.actor.getGlobalPose();
    // Manually set quaternion using direct property access
    const poseAny = pose as {
      q?: { x: number; y: number; z: number; w: number };
    };
    if (poseAny.q) {
      poseAny.q.x = quat.x;
      poseAny.q.y = quat.y;
      poseAny.q.z = quat.z;
      poseAny.q.w = quat.w;
    }
    this.actor.setGlobalPose(pose);
    this.quaternion.copy(quat);
  }

  getLinearVelocity(vec3?: THREE.Vector3) {
    if (!vec3) vec3 = this.tempVec3;
    if (!this.actor) return vec3.set(0, 0, 0);
    // PhysXActor interface includes getLinearVelocity
    const pxVelocity = (this.actor as PhysXActor).getLinearVelocity?.();
    if (pxVelocity) {
      vec3.set(pxVelocity.x, pxVelocity.y, pxVelocity.z);
    } else {
      vec3.set(0, 0, 0);
    }
    return vec3;
  }

  setLinearVelocity(vec3: THREE.Vector3) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return;
    // PhysXActor interface includes setLinearVelocity - convert THREE.Vector3 to PxVec3
    const pxVec = vector3ToPxVec3(vec3);
    (this.actor as PhysXActor).setLinearVelocity?.(pxVec);
  }

  getAngularVelocity(vec3?: THREE.Vector3) {
    if (!vec3) vec3 = this.tempVec3;
    if (!this.actor) return vec3.set(0, 0, 0);
    // PhysXActor interface includes getAngularVelocity
    const pxVelocity = (this.actor as PhysXActor).getAngularVelocity?.();
    if (pxVelocity) {
      vec3.set(pxVelocity.x, pxVelocity.y, pxVelocity.z);
    } else {
      vec3.set(0, 0, 0);
    }
    return vec3;
  }

  setAngularVelocity(vec3: THREE.Vector3) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return;
    // PhysXActor interface includes setAngularVelocity - convert THREE.Vector3 to PxVec3
    const pxVec = vector3ToPxVec3(vec3);
    (this.actor as PhysXActor).setAngularVelocity?.(pxVec);
  }

  getVelocityAtPos(pos: THREE.Vector3, vec3: THREE.Vector3) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return vec3.set(0, 0, 0);
    const pxPos = vector3ToPxVec3(pos);
    const result = physx.PxRigidBodyExt?.getVelocityAtPos(
      this.actor as PxRigidBody,
      pxPos,
    );
    if (result && typeof result === "object") {
      const vel = result as { x: number; y: number; z: number };
      vec3.set(vel.x || 0, vel.y || 0, vel.z || 0);
    }
    return vec3;
  }

  getLocalVelocityAtLocalPos(pos: THREE.Vector3, vec3: THREE.Vector3) {
    const physx = getRuntimePhysX();
    if (!this.actor || !physx) return vec3.set(0, 0, 0);
    const pxPos = vector3ToPxVec3(pos);
    const result = physx.PxRigidBodyExt?.getLocalVelocityAtLocalPos(
      this.actor as PxRigidBody,
      pxPos,
    );
    if (result && typeof result === "object") {
      const vel = result as { x: number; y: number; z: number };
      vec3.set(vel.x || 0, vel.y || 0, vel.z || 0);
    }
    return vec3;
  }

  setCenterOfMass(pos: THREE.Vector3) {
    this._centerOfMass = pos.clone();
    this.needsRebuild = true;
    this.setDirty();
  }

  setKinematicTarget(position: THREE.Vector3, quaternion: THREE.Quaternion) {
    const physx = this.nativePhysX;
    if (this._type !== "kinematic" || !this.actor || !physx) {
      return; // Early return for non-kinematic bodies
    }
    if (!this._tm) {
      this._tm = new physx.PxTransform(
        physx.PxIDENTITYEnum.PxIdentity,
      ) as PxTransform;
    }
    if (
      (position as { toPxTransform?: (tm: PxTransform) => void }).toPxTransform
    ) {
      (position as { toPxTransform: (tm: PxTransform) => void }).toPxTransform(
        this._tm,
      );
    }
    if (
      (quaternion as { toPxTransform?: (tm: PxTransform) => void })
        .toPxTransform
    ) {
      (
        quaternion as { toPxTransform: (tm: PxTransform) => void }
      ).toPxTransform(this._tm);
    }
    // PhysXActor interface includes setKinematicTarget
    (this.actor as PhysXActor).setKinematicTarget?.(this._tm!);
  }

  getProxy(): Record<string, unknown> {
    if (!this.proxy) {
      const self = this;
      let proxy = {
        get type() {
          return self.type;
        },
        set type(value) {
          self.type = value;
        },
        get mass() {
          return self.mass;
        },
        set mass(value) {
          self.mass = value;
        },
        set linearDamping(value: number) {
          self.linearDamping = value;
        },
        set angularDamping(value: number) {
          self.angularDamping = value;
        },
        get tag() {
          return self.tag;
        },
        set tag(value) {
          self.tag = value;
        },
        get onContactStart() {
          return self.onContactStart;
        },
        set onContactStart(value) {
          self.onContactStart = value;
        },
        get onContactEnd() {
          return self.onContactEnd;
        },
        set onContactEnd(value) {
          self.onContactEnd = value;
        },
        get onTriggerEnter() {
          return self.onTriggerEnter;
        },
        set onTriggerEnter(value) {
          self.onTriggerEnter = value;
        },
        get onTriggerLeave() {
          return self.onTriggerLeave;
        },
        set onTriggerLeave(value) {
          self.onTriggerLeave = value;
        },
        get sleeping() {
          return self.sleeping;
        },
        addForce(force: THREE.Vector3, mode: string | number) {
          self.addForce(force, mode);
        },
        addForceAtPos(
          force: THREE.Vector3,
          pos: THREE.Vector3,
          mode: string | number,
        ) {
          self.addForceAtPos(force, pos, mode);
        },
        addForceAtLocalPos(
          force: THREE.Vector3,
          pos: THREE.Vector3,
          mode: string | number,
        ) {
          self.addForceAtLocalPos(force, pos, mode);
        },
        addTorque(torque: THREE.Vector3, mode: string | number) {
          self.addTorque(torque, mode);
        },
        getPosition(vec3?: THREE.Vector3) {
          return self.getPosition(vec3);
        },
        setPosition(vec3: THREE.Vector3) {
          self.setPosition(vec3);
        },
        getQuaternion(quat?: THREE.Quaternion) {
          return self.getQuaternion(quat);
        },
        setQuaternion(quat: THREE.Quaternion) {
          self.setQuaternion(quat);
        },
        getLinearVelocity(vec3?: THREE.Vector3) {
          return self.getLinearVelocity(vec3);
        },
        setLinearVelocity(vec3: THREE.Vector3) {
          self.setLinearVelocity(vec3);
        },
        getAngularVelocity(vec3?: THREE.Vector3) {
          self.getAngularVelocity(vec3);
        },
        setAngularVelocity(vec3: THREE.Vector3) {
          self.setAngularVelocity(vec3);
        },
        getVelocityAtPos(pos: THREE.Vector3, vec3: THREE.Vector3) {
          return self.getVelocityAtPos(pos, vec3);
        },
        getLocalVelocityAtLocalPos(pos: THREE.Vector3, vec3: THREE.Vector3) {
          return self.getLocalVelocityAtLocalPos(pos, vec3);
        },
        setCenterOfMass(pos: THREE.Vector3) {
          self.setCenterOfMass(pos);
        },
        setKinematicTarget(
          position: THREE.Vector3,
          quaternion: THREE.Quaternion,
        ) {
          self.setKinematicTarget(position, quaternion);
        },
      };
      proxy = Object.defineProperties(
        proxy,
        Object.getOwnPropertyDescriptors(super.getProxy()),
      ); // inherit Node properties
      this.proxy = proxy;
    }
    return this.proxy;
  }
}

function _isType(value: string) {
  return types.includes(value);
}
