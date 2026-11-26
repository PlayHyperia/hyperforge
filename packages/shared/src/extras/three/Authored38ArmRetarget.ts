/** Opt-in animation calibration for one exact authored A-rest package. No raw/body edits. */
import {
  Quaternion,
  QuaternionKeyframeTrack,
  NormalAnimationBlendMode,
} from "./three";
import type { Object3D, AnimationClip } from "./three";
import { ARM38_CALIBRATION } from "./Authored38ArmCalibration";

export interface Arm38Humanoid {
  rawRestPose: Record<string, { position?: number[]; rotation?: number[] }>;
  humanBones: Record<string, { node: Object3D }>;
  getNormalizedBoneNode(name: string): Object3D | null | undefined;
  getRawBoneNode(name: string): Object3D | null | undefined;
}
type Entry = {
  name: string;
  node: Object3D;
  left: Quaternion;
  right: Quaternion;
  original: Quaternion;
  calibratedDefault: Quaternion;
};
const same = (a: Quaternion, b: Quaternion) =>
  a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
const preparedClips = new WeakSet<AnimationClip>();
export const ARM38_ACCEPTED_ASSET_SHA256 = Object.freeze([
  ARM38_CALIBRATION.assetSHA256,
  "620e08491e3906e6b84d2a6b05bbc4970c833d82156d792304e2137a7df7bf67",
]);

export class Authored38ArmRetarget {
  private readonly entries: Entry[];
  private initialized = false;
  private disposed = false;
  readonly assetSHA256 = ARM38_CALIBRATION.assetSHA256;

  constructor(humanoid: Arm38Humanoid, verifiedAssetSHA256: string) {
    if (!ARM38_ACCEPTED_ASSET_SHA256.includes(verifiedAssetSHA256))
      throw new Error("Arm38 calibration requires exact verified package hash");
    const rest = ARM38_CALIBRATION.rawRestPose;
    if (
      Object.keys(humanoid.humanBones).length !== 52 ||
      JSON.stringify(Object.keys(humanoid.humanBones).sort()) !==
        JSON.stringify(Object.keys(rest).sort())
    )
      throw new Error("Arm38 original52 mapping differs");
    const qs = ARM38_CALIBRATION.correctionQuaternionsXYZW;
    this.entries = [];
    for (const name of Object.keys(rest) as Array<keyof typeof rest>) {
      const actual = humanoid.rawRestPose[name],
        expected = rest[name];
      for (const field of ["position", "rotation"] as const) {
        if (
          !actual?.[field] ||
          actual[field].length !== expected[field].length ||
          actual[field].some((v, i) => v !== expected[field][i])
        )
          throw new Error(`Arm38 raw rest changed: ${name}.${field}`);
      }
      const raw = humanoid.getRawBoneNode(name),
        parentName = ARM38_CALIBRATION.parents[name];
      if (
        !raw ||
        raw.name !== name ||
        (parentName && raw.parent !== humanoid.getRawBoneNode(parentName))
      )
        throw new Error(`Arm38 raw hierarchy differs: ${name}`);
      const right = new Quaternion().fromArray(qs[name]);
      const left = parentName
        ? new Quaternion().fromArray(qs[parentName]).invert()
        : new Quaternion();
      if (same(right, new Quaternion()) && same(left, new Quaternion()))
        continue;
      const node = humanoid.getNormalizedBoneNode(name);
      if (!node || node === raw)
        throw new Error(`Missing distinct normalized node: ${name}`);
      if (!same(node.quaternion, new Quaternion()))
        throw new Error("Arm38 must initialize before animation activation");
      const calibratedDefault = left.clone().multiply(right);
      // Same absolute hand correction on finger descendants introduces no curl.
      if (parentName && qs[name].every((v, i) => v === qs[parentName][i]))
        calibratedDefault.identity();
      this.entries.push({
        name,
        node,
        left,
        right,
        original: node.quaternion.clone(),
        calibratedDefault,
      });
    }
    if (new Set(this.entries.map((e) => e.node)).size !== this.entries.length)
      throw new Error("Duplicate normalized targets");
  }

  get boneNames(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** Call once, before creating/activating any AnimationMixer actions. */
  initializeNormalizedPose(): void {
    if (this.disposed || this.initialized)
      throw new Error("Arm38 already initialized or disposed");
    for (const e of this.entries)
      if (!same(e.node.quaternion, e.original))
        throw new Error("Arm38 pose changed before initialization");
    for (const e of this.entries) e.node.quaternion.copy(e.calibratedDefault);
    this.initialized = true;
  }

  /** Private tracks only: q'_i=C_parent^-1 q_i C_i, preserving times/interpolation.
   * Constant omitted-bone tracks keep crossfades in the same calibrated space.
   * No per-frame correction or play/stop interception is needed.
   */
  prepareClip(source: AnimationClip): AnimationClip {
    if (!this.initialized || this.disposed || preparedClips.has(source))
      throw new Error(
        "Arm38 requires initialized adapter and unprepared source clip",
      );
    if (
      source.blendMode !== NormalAnimationBlendMode ||
      !Number.isFinite(source.duration) ||
      source.duration <= 0
    )
      throw new Error(
        "Arm38 only supports positive-duration normal-blend clips",
      );
    const clip = source.clone(),
      lookup = new Map(
        this.entries.map((e) => [e.node.name + ".quaternion", e]),
      );
    const covered = new Set<string>();
    const q = new Quaternion();
    for (const track of clip.tracks) {
      const e = lookup.get(track.name);
      if (!e) continue;
      if (
        covered.has(track.name) ||
        (track as typeof track & { ValueTypeName?: string }).ValueTypeName !==
          "quaternion" ||
        track.getValueSize() !== 4 ||
        track.values.length !== track.times.length * 4
      )
        throw new Error("Unsupported or duplicate Arm38 quaternion track");
      if ([...track.times].some((t) => !Number.isFinite(t) || t < 0))
        throw new Error("Invalid Arm38 keyframe times");
      covered.add(track.name);
      for (let i = 0; i < track.values.length; i += 4) {
        q.fromArray(track.values, i);
        if (
          ![q.x, q.y, q.z, q.w].every(Number.isFinite) ||
          Math.abs(q.lengthSq() - 1) > 1e-4
        )
          throw new Error("Nonunit Arm38 source animation quaternion");
        q.premultiply(e.left).multiply(e.right).toArray(track.values, i);
      }
    }
    for (const e of this.entries) {
      const name = e.node.name + ".quaternion";
      if (covered.has(name)) continue;
      clip.tracks.push(
        new QuaternionKeyframeTrack(
          name,
          [0, Math.max(source.duration, 1e-6)],
          [...e.calibratedDefault.toArray(), ...e.calibratedDefault.toArray()],
        ),
      );
    }
    preparedClips.add(clip);
    return clip;
  }

  /** Owner must first stop/uncache its actions. Original raw rest is never edited. */
  dispose(): void {
    for (const e of this.entries) e.node.quaternion.copy(e.original);
    this.disposed = true;
  }
}
