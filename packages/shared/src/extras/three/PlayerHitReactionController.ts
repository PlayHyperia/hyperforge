import type { VRMHumanBoneName } from "@pixiv/three-vrm";

import {
  getPlayerHitReactionEnvelope,
  PLAYER_HIT_REACTION_DURATION_SECONDS,
  type HitReactionSide,
} from "../../utils/rendering/HitReaction";
import THREE from "./three";

interface NormalizedHumanoid {
  getNormalizedBoneNode?: (
    boneName: string,
  ) => THREE.Object3D | null | undefined;
}

interface HitReactionBone {
  node: THREE.Object3D;
  pitch: number;
  roll: number;
  applied: THREE.Quaternion;
}

export interface PlayerHitReactionDiagnostics {
  schemaVersion: 1;
  availableBoneCount: number;
  triggerCount: number;
  active: boolean;
  elapsedSeconds: number | null;
  currentWeight: number;
  lastIntensity: number;
  lastSide: HitReactionSide;
}

export const PLAYER_HIT_REACTION_BONES = [
  { bone: "spine", pitch: -0.045, roll: 0.018 },
  { bone: "chest", pitch: -0.075, roll: 0.03 },
  { bone: "upperChest", pitch: -0.11, roll: 0.045 },
  { bone: "neck", pitch: 0.045, roll: 0.025 },
  { bone: "head", pitch: 0.06, roll: 0.035 },
] as const satisfies ReadonlyArray<{
  bone: VRMHumanBoneName;
  pitch: number;
  roll: number;
}>;

/**
 * Adds a short upper-body recoil on top of the current authored animation.
 * It never changes the avatar root, locomotion state, or active mixer action.
 */
export class PlayerHitReactionController {
  private readonly bones: HitReactionBone[];
  private readonly euler = new THREE.Euler();
  private readonly undo = new THREE.Quaternion();
  private readonly identity = new THREE.Quaternion();
  private elapsedSeconds = Number.POSITIVE_INFINITY;
  private intensity = 0;
  private side: HitReactionSide = 1;
  private triggerCount = 0;
  private currentWeight = 0;

  constructor(humanoid: NormalizedHumanoid | null | undefined) {
    this.bones = PLAYER_HIT_REACTION_BONES.flatMap(
      ({ bone, pitch, roll }): HitReactionBone[] => {
        const node = humanoid?.getNormalizedBoneNode?.(bone);
        return node
          ? [
              {
                node,
                pitch,
                roll,
                applied: new THREE.Quaternion(),
              },
            ]
          : [];
      },
    );
  }

  get available(): boolean {
    return this.bones.length > 0;
  }

  trigger(intensity = 1, side: HitReactionSide = 1): boolean {
    if (!Number.isFinite(intensity) || intensity <= 0 || !this.available) {
      return false;
    }
    this.elapsedSeconds = 0;
    this.intensity = Math.min(Math.max(intensity, 0), 1.25);
    this.side = side === -1 ? -1 : 1;
    this.triggerCount += 1;
    this.currentWeight = 0;
    return true;
  }

  /** Restore the mixer-authored pose before advancing the next animation frame. */
  beforeMixerUpdate(): void {
    for (const entry of this.bones) {
      if (entry.applied.angleTo(this.identity) <= 1e-8) continue;
      this.undo.copy(entry.applied).invert();
      entry.node.quaternion.multiply(this.undo);
      entry.applied.identity();
    }
  }

  /** Apply the additive pose after the mixer has written the current frame. */
  afterMixerUpdate(deltaSeconds: number): number {
    if (!Number.isFinite(this.elapsedSeconds)) return 0;

    this.elapsedSeconds += Math.max(0, deltaSeconds);
    const weight =
      getPlayerHitReactionEnvelope(this.elapsedSeconds) * this.intensity;
    this.currentWeight = weight;
    if (weight <= 0) {
      if (this.elapsedSeconds >= PLAYER_HIT_REACTION_DURATION_SECONDS) {
        this.elapsedSeconds = Number.POSITIVE_INFINITY;
        this.intensity = 0;
      }
      return 0;
    }

    for (const entry of this.bones) {
      this.euler.set(
        entry.pitch * weight,
        0,
        entry.roll * weight * this.side,
        "XYZ",
      );
      entry.applied.setFromEuler(this.euler);
      entry.node.quaternion.multiply(entry.applied);
    }
    return weight;
  }

  clear(): void {
    this.beforeMixerUpdate();
    this.elapsedSeconds = Number.POSITIVE_INFINITY;
    this.intensity = 0;
    this.currentWeight = 0;
  }

  getDiagnostics(): PlayerHitReactionDiagnostics {
    return {
      schemaVersion: 1,
      availableBoneCount: this.bones.length,
      triggerCount: this.triggerCount,
      active: Number.isFinite(this.elapsedSeconds),
      elapsedSeconds: Number.isFinite(this.elapsedSeconds)
        ? this.elapsedSeconds
        : null,
      currentWeight: this.currentWeight,
      lastIntensity: this.intensity,
      lastSide: this.side,
    };
  }
}
