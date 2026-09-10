/**
 * createEmoteFactory.ts - Animation Retargeting Factory
 *
 * Retargets Mixamo animations to VRM skeletons for character animation.
 * Handles bone name mapping, scaling, and orientation differences.
 *
 * **Animation Pipeline:**
 * 1. Load Mixamo animation GLB
 * 2. Extract animation clips
 * 3. Filter to only root position and rotations
 * 4. Map Mixamo bone names → VRM bone names
 * 5. Scale animation to match VRM height
 * 6. Generate retargeted AnimationClip
 *
 * **Why Retargeting?**
 * - Mixamo animations use different skeleton structure than VRM
 * - Bone names differ (e.g., 'mixamorigHips' → 'hips')
 * - Mixamo uses different coordinate space
 * - VRMs have varying heights/proportions
 *
 * **Height Adaptation:**
 * - Calculates rootToHips distance from VRM
 * - Scales animation by this ratio
 * - Ensures feet stay on ground
 * - Works with any VRM body proportions
 *
 * **Bone Name Mapping:**
 * Maps ~67 Mixamo bones to VRM standard bones:
 * - Hips, Spine, Chest, Neck, Head
 * - Left/Right Arms, Hands, Fingers
 * - Left/Right Legs, Feet, Toes
 *
 * **Referenced by:** ClientLoader (loads emote animations)
 */

import * as THREE from "./three";
import type { GLBData } from "../../types";

const q1 = new THREE.Quaternion();
const restRotationInverse = new THREE.Quaternion();
const parentRestWorldRotation = new THREE.Quaternion();
const sourceTranslation = new THREE.Vector3();

type KeyframeTrackLike = THREE.KeyframeTrack & {
  ValueTypeName?: string;
  values?: ArrayLike<number>;
};

function splitTrackName(trackName: string) {
  const propertySeparator = trackName.lastIndexOf(".");
  if (propertySeparator <= 0 || propertySeparator === trackName.length - 1) {
    return { boneName: trackName, propertyName: "" };
  }
  return {
    boneName: trackName.slice(0, propertySeparator),
    propertyName: trackName.slice(propertySeparator + 1),
  };
}

function isVectorTrack(
  track: THREE.KeyframeTrack,
): track is THREE.VectorKeyframeTrack {
  const candidate = track as KeyframeTrackLike;
  if (candidate.ValueTypeName === "vector") return true;
  const { propertyName } = splitTrackName(track.name);
  return propertyName === "position" || propertyName === "scale";
}

function isQuaternionTrack(
  track: THREE.KeyframeTrack,
): track is THREE.QuaternionKeyframeTrack {
  const candidate = track as KeyframeTrackLike;
  if (candidate.ValueTypeName === "quaternion") return true;
  return splitTrackName(track.name).propertyName === "quaternion";
}

/**
 * Create Animation Retargeting Factory
 *
 * Processes a Mixamo animation GLB and returns a factory for retargeting to VRM skeletons.
 *
 * @param glb - Loaded animation GLB data
 * @param url - Animation URL used to apply explicit per-clip translation policy
 * @returns Factory object with toClip() method
 */
/**
 * Normalized animation targets
 *
 * The VRM normalized rig compensates source bone axes, not arbitrary anatomical
 * A-rest poses. Such assets need a separately validated target-pose calibration.
 *
 * How it works:
 * 1. Animation targets normalized bones (Normalized_Hips, etc.)
 * 2. vrm.humanoid.update() propagates normalized → raw bones with inverse bind transforms
 * 3. The target avatar must supply a compatible T-rest or explicit calibration
 *
 * Do not apply additional global or unverified per-avatar rotation offsets here.
 */

export function createEmoteFactory(glb: GLBData, url: string) {
  // console.time('emote-init')

  if (!glb.animations || glb.animations.length === 0) {
    throw new Error("[createEmoteFactory] GLB has no animations");
  }

  const clip = glb.animations[0];

  const scale = (glb.scene as THREE.Scene).children[0].scale.x; // armature should be here?
  const preserveHipsVerticalTranslation = /(?:^|[/_-])death(?:[.?_-]|$)/i.test(
    url,
  );

  // no matter what vrm/emote combo we use for some reason avatars
  // levitate roughly 5cm above ground. this is a hack but it works.
  const yOffset = -0.05 / scale;

  // we only keep tracks that are:
  // 1. the root position
  // 2. the quaternions
  // scale and other positions are rejected.
  // NOTE: there is a risk that the first position track is not the root but
  // i haven't been able to find one so far.
  let _haveRoot;

  clip.tracks = clip.tracks.filter((track) => {
    if (isVectorTrack(track)) {
      const { boneName: name, propertyName: type } = splitTrackName(track.name);
      if (type !== "position") return;
      // we need both root and hip bones
      if (name === "Root") {
        _haveRoot = true;
        return true;
      }
      if (
        (normalizedBoneNames as Record<string, string | undefined>)[name] ===
        "hips"
      ) {
        return true;
      }
      return false;
    }
    return true;
  });

  // if (!haveRoot) console.warn(`emote missing root bone: ${url}`)

  // fix new mixamo update normalized bones
  // see: https://github.com/pixiv/three-vrm/pull/1032/files
  clip.tracks.forEach((track) => {
    const { boneName: mixamoRigName } = splitTrackName(track.name);
    const mixamoRigNode = glb.scene.getObjectByName(mixamoRigName);
    if (!mixamoRigNode || !mixamoRigNode.parent) {
      console.warn(`Mixamo rig node not found: ${mixamoRigName}`);
      return;
    }
    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);
    if (isQuaternionTrack(track)) {
      // Retarget rotation of mixamoRig to NormalizedBone.
      for (let i = 0; i < track.values.length; i += 4) {
        const flatQuaternion = track.values.slice(i, i + 4);
        q1.fromArray(flatQuaternion);
        // 親のレスト時ワールド回転 * トラックの回転 * レスト時ワールド回転の逆
        q1.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        q1.toArray(flatQuaternion);
        flatQuaternion.forEach((v, index) => {
          track.values[index + i] = v;
        });
      }
    } else if (isVectorTrack(track)) {
      const vrmBoneName = (
        normalizedBoneNames as Record<string, string | undefined>
      )[mixamoRigName];
      if (preserveHipsVerticalTranslation && vrmBoneName === "hips") {
        const values = (track as KeyframeTrackLike).values;
        if (values) {
          for (let i = 0; i < values.length; i += 3) {
            sourceTranslation
              .fromArray(values, i)
              .applyQuaternion(parentRestWorldRotation);
            values[i] = sourceTranslation.x;
            values[i + 1] = sourceTranslation.y;
            values[i + 2] = sourceTranslation.z;
          }
        }
      } else if (yOffset) {
        const values = (track as KeyframeTrackLike).values;
        if (values) {
          // Keyframe values can be typed arrays; mutate in place to avoid
          // allocation and keep compatibility across three.js module copies.
          for (let i = 1; i < values.length; i += 3) {
            values[i] += yOffset;
          }
        }
      }
    }
  });

  clip.optimize();

  // console.timeEnd('emote-init')

  type EmoteRetargetOptions = {
    rootToHips?: number;
    version?: string;
    getBoneName?: (name: string) => string | undefined;
  };

  return {
    toClip(options: EmoteRetargetOptions = {}) {
      const {
        rootToHips = 1,
        version = "1",
        getBoneName = (name: string) => name,
      } = options;
      // we're going to resize animation to match vrm height
      const height = rootToHips;

      const tracks: THREE.KeyframeTrack[] = [];

      // Temp quaternions for A-pose compensation (reserved for future use)
      const _animQuat = new THREE.Quaternion();
      const _offsetQuat = new THREE.Quaternion();
      const _resultQuat = new THREE.Quaternion();

      clip.tracks.forEach((track) => {
        const { boneName: ogBoneName, propertyName } = splitTrackName(
          track.name,
        );
        const vrmBoneName = (normalizedBoneNames as Record<string, string>)[
          ogBoneName
        ];
        // FUTURE: use vrm.bones[name] not getBoneNode
        const vrmNodeName = getBoneName(vrmBoneName);

        // animations come from mixamo X Bot character
        // and we scale based on height of our VRM.
        // usually this would 0.01 if our VRM was for example the X Bot
        // but since we're applying this to any arbitrary sized VRM we
        // need to scale it by height too.
        // i found that feet-to-hips height scales animations almost perfectly
        // and ensures feet stay on the ground
        const _scaler = height * scale;

        if (vrmNodeName !== undefined) {
          if (isQuaternionTrack(track)) {
            let values = track.values;

            // Apply VRM 0.0 coordinate transformation
            if (version === "0") {
              values = values.map((v, i) => (i % 2 === 0 ? -v : v));
            }

            // Anatomical rest calibration, when explicitly required, is applied
            // to the owned target clip by its avatar factory, not the shared source.

            tracks.push(
              new THREE.QuaternionKeyframeTrack(
                `${vrmNodeName}.${propertyName}`,
                track.times,
                values,
              ),
            );
          } else if (
            isVectorTrack(track) &&
            preserveHipsVerticalTranslation &&
            vrmBoneName === "hips" &&
            propertyName === "position"
          ) {
            // Three's declarations narrow the base track to `never` after the
            // quaternion guard even though vector/quaternion tracks are
            // runtime siblings. Preserve the already-proven vector subtype.
            const vectorTrack = track as THREE.VectorKeyframeTrack;
            const values = new Float32Array(vectorTrack.values.length);
            for (let i = 0; i < vectorTrack.values.length; i += 3) {
              values[i] = 0;
              values[i + 1] = vectorTrack.values[i + 1] * _scaler;
              values[i + 2] = 0;
            }
            tracks.push(
              new THREE.VectorKeyframeTrack(
                `${vrmNodeName}.${propertyName}`,
                vectorTrack.times,
                values,
              ),
            );
            // Horizontal translation stays stripped so the game retains
            // authoritative movement while the death pose can reach ground.
          }
        }
      });

      return new THREE.AnimationClip(
        clip.name, // todo: name variable?
        clip.duration,
        tracks,
      );
    },
  };
}

const normalizedBoneNames = {
  // vrm standard
  hips: "hips",
  spine: "spine",
  chest: "chest",
  upperChest: "upperChest",
  neck: "neck",
  head: "head",
  leftShoulder: "leftShoulder",
  leftUpperArm: "leftUpperArm",
  leftLowerArm: "leftLowerArm",
  leftHand: "leftHand",
  leftThumbMetacarpal: "leftThumbMetacarpal",
  leftThumbProximal: "leftThumbProximal",
  leftThumbIntermediate: "leftThumbIntermediate",
  leftThumbDistal: "leftThumbDistal",
  leftIndexProximal: "leftIndexProximal",
  leftIndexIntermediate: "leftIndexIntermediate",
  leftIndexDistal: "leftIndexDistal",
  leftMiddleProximal: "leftMiddleProximal",
  leftMiddleIntermediate: "leftMiddleIntermediate",
  leftMiddleDistal: "leftMiddleDistal",
  leftRingProximal: "leftRingProximal",
  leftRingIntermediate: "leftRingIntermediate",
  leftRingDistal: "leftRingDistal",
  leftLittleProximal: "leftLittleProximal",
  leftLittleIntermediate: "leftLittleIntermediate",
  leftLittleDistal: "leftLittleDistal",
  rightShoulder: "rightShoulder",
  rightUpperArm: "rightUpperArm",
  rightLowerArm: "rightLowerArm",
  rightHand: "rightHand",
  rightThumbMetacarpal: "rightThumbMetacarpal",
  rightLittleProximal: "rightLittleProximal",
  rightLittleIntermediate: "rightLittleIntermediate",
  rightLittleDistal: "rightLittleDistal",
  rightRingProximal: "rightRingProximal",
  rightRingIntermediate: "rightRingIntermediate",
  rightRingDistal: "rightRingDistal",
  rightMiddleProximal: "rightMiddleProximal",
  rightMiddleIntermediate: "rightMiddleIntermediate",
  rightMiddleDistal: "rightMiddleDistal",
  rightIndexProximal: "rightIndexProximal",
  rightIndexIntermediate: "rightIndexIntermediate",
  rightIndexDistal: "rightIndexDistal",
  rightThumbProximal: "rightThumbProximal",
  rightThumbIntermediate: "rightThumbIntermediate",
  rightThumbDistal: "rightThumbDistal",
  leftUpperLeg: "leftUpperLeg",
  leftLowerLeg: "leftLowerLeg",
  leftFoot: "leftFoot",
  leftToes: "leftToes",
  rightUpperLeg: "rightUpperLeg",
  rightLowerLeg: "rightLowerLeg",
  rightFoot: "rightFoot",
  rightToes: "rightToes",
  // KayKit Rig_Medium names. The wrist nodes are the anatomical hand roots;
  // their hand/handslot children remain attachment helpers, not humanoid bones.
  "upperarm.l": "leftUpperArm",
  "lowerarm.l": "leftLowerArm",
  "wrist.l": "leftHand",
  "upperarm.r": "rightUpperArm",
  "lowerarm.r": "rightLowerArm",
  "wrist.r": "rightHand",
  "upperleg.l": "leftUpperLeg",
  "lowerleg.l": "leftLowerLeg",
  "foot.l": "leftFoot",
  "toes.l": "leftToes",
  "upperleg.r": "rightUpperLeg",
  "lowerleg.r": "rightLowerLeg",
  "foot.r": "rightFoot",
  "toes.r": "rightToes",
  // GLTFLoader sanitizes periods out of animation target node names.
  upperarml: "leftUpperArm",
  lowerarml: "leftLowerArm",
  wristl: "leftHand",
  upperarmr: "rightUpperArm",
  lowerarmr: "rightLowerArm",
  wristr: "rightHand",
  upperlegl: "leftUpperLeg",
  lowerlegl: "leftLowerLeg",
  footl: "leftFoot",
  toesl: "leftToes",
  upperlegr: "rightUpperLeg",
  lowerlegr: "rightLowerLeg",
  footr: "rightFoot",
  toesr: "rightToes",
  // Quaternius Universal humanoid names.
  pelvis: "hips",
  spine_01: "spine",
  spine_02: "chest",
  spine_03: "upperChest",
  neck_01: "neck",
  clavicle_l: "leftShoulder",
  upperarm_l: "leftUpperArm",
  lowerarm_l: "leftLowerArm",
  hand_l: "leftHand",
  thumb_01_l: "leftThumbMetacarpal",
  thumb_02_l: "leftThumbProximal",
  thumb_03_l: "leftThumbDistal",
  index_01_l: "leftIndexProximal",
  index_02_l: "leftIndexIntermediate",
  index_03_l: "leftIndexDistal",
  middle_01_l: "leftMiddleProximal",
  middle_02_l: "leftMiddleIntermediate",
  middle_03_l: "leftMiddleDistal",
  ring_01_l: "leftRingProximal",
  ring_02_l: "leftRingIntermediate",
  ring_03_l: "leftRingDistal",
  pinky_01_l: "leftLittleProximal",
  pinky_02_l: "leftLittleIntermediate",
  pinky_03_l: "leftLittleDistal",
  clavicle_r: "rightShoulder",
  upperarm_r: "rightUpperArm",
  lowerarm_r: "rightLowerArm",
  hand_r: "rightHand",
  thumb_01_r: "rightThumbMetacarpal",
  thumb_02_r: "rightThumbProximal",
  thumb_03_r: "rightThumbDistal",
  index_01_r: "rightIndexProximal",
  index_02_r: "rightIndexIntermediate",
  index_03_r: "rightIndexDistal",
  middle_01_r: "rightMiddleProximal",
  middle_02_r: "rightMiddleIntermediate",
  middle_03_r: "rightMiddleDistal",
  ring_01_r: "rightRingProximal",
  ring_02_r: "rightRingIntermediate",
  ring_03_r: "rightRingDistal",
  pinky_01_r: "rightLittleProximal",
  pinky_02_r: "rightLittleIntermediate",
  pinky_03_r: "rightLittleDistal",
  thigh_l: "leftUpperLeg",
  calf_l: "leftLowerLeg",
  foot_l: "leftFoot",
  ball_l: "leftToes",
  thigh_r: "rightUpperLeg",
  calf_r: "rightLowerLeg",
  foot_r: "rightFoot",
  ball_r: "rightToes",
  // vrm uploaded to mixamo
  // these are latest mixamo bone names
  Hips: "hips",
  Spine: "spine",
  Spine1: "chest",
  Spine2: "upperChest",
  Neck: "neck",
  Head: "head",
  LeftShoulder: "leftShoulder",
  LeftArm: "leftUpperArm",
  LeftForeArm: "leftLowerArm",
  LeftHand: "leftHand",
  LeftHandThumb1: "leftThumbProximal",
  LeftHandThumb2: "leftThumbIntermediate",
  LeftHandThumb3: "leftThumbDistal",
  LeftHandIndex1: "leftIndexProximal",
  LeftHandIndex2: "leftIndexIntermediate",
  LeftHandIndex3: "leftIndexDistal",
  LeftHandMiddle1: "leftMiddleProximal",
  LeftHandMiddle2: "leftMiddleIntermediate",
  LeftHandMiddle3: "leftMiddleDistal",
  LeftHandRing1: "leftRingProximal",
  LeftHandRing2: "leftRingIntermediate",
  LeftHandRing3: "leftRingDistal",
  LeftHandPinky1: "leftLittleProximal",
  LeftHandPinky2: "leftLittleIntermediate",
  LeftHandPinky3: "leftLittleDistal",
  RightShoulder: "rightShoulder",
  RightArm: "rightUpperArm",
  RightForeArm: "rightLowerArm",
  RightHand: "rightHand",
  RightHandPinky1: "rightLittleProximal",
  RightHandPinky2: "rightLittleIntermediate",
  RightHandPinky3: "rightLittleDistal",
  RightHandRing1: "rightRingProximal",
  RightHandRing2: "rightRingIntermediate",
  RightHandRing3: "rightRingDistal",
  RightHandMiddle1: "rightMiddleProximal",
  RightHandMiddle2: "rightMiddleIntermediate",
  RightHandMiddle3: "rightMiddleDistal",
  RightHandIndex1: "rightIndexProximal",
  RightHandIndex2: "rightIndexIntermediate",
  RightHandIndex3: "rightIndexDistal",
  RightHandThumb1: "rightThumbProximal",
  RightHandThumb2: "rightThumbIntermediate",
  RightHandThumb3: "rightThumbDistal",
  LeftUpLeg: "leftUpperLeg",
  LeftLeg: "leftLowerLeg",
  LeftFoot: "leftFoot",
  LeftToeBase: "leftToes",
  RightUpLeg: "rightUpperLeg",
  RightLeg: "rightLowerLeg",
  RightFoot: "rightFoot",
  RightToeBase: "rightToes",
  // these must be old mixamo names, prefixed with "mixamo"
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbProximal",
  mixamorigLeftHandThumb2: "leftThumbIntermediate",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandThumb1: "rightThumbProximal",
  mixamorigRightHandThumb2: "rightThumbIntermediate",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};
