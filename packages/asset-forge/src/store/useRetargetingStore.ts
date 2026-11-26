import * as THREE from "three";
import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

export type RetargetingStep = "select-models" | "adjust-bones" | "export";
export type RigType =
  "mixamo-human" | "mixamo-quadruped" | "mixamo-bird" | "custom";

interface BoneMapping {
  [sourceBoneName: string]: string; // maps to target bone name
}

interface RetargetingState {
  // Source model (from Meshy)
  sourceModelUrl: string | null;
  sourceModelAssetId: string | null;
  sourceSkeleton: THREE.Skeleton | null;

  // Target rig (Mixamo, etc)
  targetRigType: RigType | null;
  targetRigUrl: string | null;
  targetRigAssetId: string | null;
  targetSkeleton: THREE.Skeleton | null;

  // Retargeting state
  isRetargeted: boolean;
  retargetedModelUrl: string | null;

  // Bone mapping
  boneMapping: BoneMapping;

  // 3D Editor UI state
  showSkeleton: boolean;
  boneEditingEnabled: boolean;
  skeletonScale: number;

  // Animation
  loadedAnimations: Array<{ name: string; url: string }>;
  currentAnimation: string | null;

  // UI state
  currentStep: RetargetingStep;
  mirrorEnabled: boolean;
  transformMode: "translate" | "rotate";
  transformSpace: "world" | "local";

  // Processing state
  isLoading: boolean;
  lastError: string | null;

  // Actions
  setSourceModel: (url: string, assetId: string) => void;
  setTargetRig: (type: RigType, url: string, assetId: string) => void;
  setSourceSkeleton: (skeleton: THREE.Skeleton | null) => void;
  setTargetSkeleton: (skeleton: THREE.Skeleton | null) => void;
  setRetargeted: (retargeted: boolean, modelUrl?: string) => void;
  setBoneMapping: (mapping: BoneMapping) => void;
  updateBoneMapping: (sourceBone: string, targetBone: string) => void;
  removeBoneMapping: (sourceBone: string) => void;
  setShowSkeleton: (show: boolean) => void;
  setBoneEditingEnabled: (enabled: boolean) => void;
  setSkeletonScale: (scale: number) => void;
  setCurrentStep: (step: RetargetingStep) => void;
  setMirrorEnabled: (enabled: boolean) => void;
  setTransformMode: (mode: "translate" | "rotate") => void;
  setTransformSpace: (space: "world" | "local") => void;
  addAnimation: (name: string, url: string) => void;
  setCurrentAnimation: (name: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  reset: () => void;
  resetToStep: (step: RetargetingStep) => void;

  // Computed selectors
  canRetarget: () => boolean;
  canEditBones: () => boolean;
  canExport: () => boolean;
  getMappedBonesCount: () => number;
}

interface StoreHook<T> {
  (): T;
  <U>(selector: (state: T) => U): U;
}

const initialState = {
  sourceModelUrl: null,
  sourceModelAssetId: null,
  sourceSkeleton: null,
  targetRigType: null,
  targetRigUrl: null,
  targetRigAssetId: null,
  targetSkeleton: null,
  isRetargeted: false,
  retargetedModelUrl: null,
  boneMapping: {},
  showSkeleton: false,
  boneEditingEnabled: false,
  skeletonScale: 0.95,
  loadedAnimations: [],
  currentAnimation: null,
  currentStep: "select-models" as RetargetingStep,
  mirrorEnabled: false,
  transformMode: "translate" as "translate" | "rotate",
  transformSpace: "world" as "world" | "local",
  isLoading: false,
  lastError: null,
};

const retargetingStore = create<RetargetingState>()(
  devtools(
    persist(
      subscribeWithSelector(
        immer((set, get) => ({
          ...initialState,

          // Source model actions
          setSourceModel: (url, assetId) =>
            set((state) => {
              state.sourceModelUrl = url;
              state.sourceModelAssetId = assetId;
              state.sourceSkeleton = null; // Will be loaded by viewer
              state.lastError = null;
              console.log("[Store] Source model set:", { url, assetId });
            }),

          setTargetRig: (type, url, assetId) =>
            set((state) => {
              state.targetRigType = type;
              state.targetRigUrl = url;
              state.targetRigAssetId = assetId;
              state.targetSkeleton = null; // Will be loaded by viewer
              state.lastError = null;
              console.log("[Store] Target rig set:", { type, url, assetId });
            }),

          setSourceSkeleton: (skeleton) =>
            set((state) => {
              state.sourceSkeleton = skeleton as any;
              console.log(
                "[Store] Source skeleton updated:",
                skeleton ? `${skeleton.bones.length} bones` : "null",
              );
            }),

          setTargetSkeleton: (skeleton) =>
            set((state) => {
              state.targetSkeleton = skeleton as any;
              console.log(
                "[Store] Target skeleton updated:",
                skeleton ? `${skeleton.bones.length} bones` : "null",
              );
            }),

          setRetargeted: (retargeted, modelUrl) =>
            set((state) => {
              state.isRetargeted = retargeted;
              if (modelUrl) state.retargetedModelUrl = modelUrl;
              console.log("[Store] Retargeted:", retargeted);
            }),

          // Bone mapping actions
          setBoneMapping: (mapping) =>
            set((state) => {
              state.boneMapping = mapping;
              console.log(
                "[Store] Bone mapping set:",
                Object.keys(mapping).length,
                "mappings",
              );
            }),

          updateBoneMapping: (sourceBone, targetBone) =>
            set((state) => {
              state.boneMapping[sourceBone] = targetBone;
              console.log(
                "[Store] Added mapping:",
                sourceBone,
                "→",
                targetBone,
              );
            }),

          removeBoneMapping: (sourceBone) =>
            set((state) => {
              delete state.boneMapping[sourceBone];
              console.log("[Store] Removed mapping:", sourceBone);
            }),

          // 3D Editor UI actions
          setShowSkeleton: (show) =>
            set((state) => {
              state.showSkeleton = show;
              console.log("[Store] Show skeleton:", show);
            }),

          setBoneEditingEnabled: (enabled) =>
            set((state) => {
              state.boneEditingEnabled = enabled;
              console.log("[Store] Bone editing enabled:", enabled);
            }),

          setSkeletonScale: (scale) =>
            set((state) => {
              state.skeletonScale = scale;
              console.log("[Store] Skeleton scale:", scale);
            }),

          setCurrentStep: (step) =>
            set((state) => {
              state.currentStep = step;
              console.log("[Store] Current step:", step);
            }),

          setMirrorEnabled: (enabled) =>
            set((state) => {
              state.mirrorEnabled = enabled;
              console.log("[Store] Mirror enabled:", enabled);
            }),

          setTransformMode: (mode) =>
            set((state) => {
              state.transformMode = mode;
              console.log("[Store] Transform mode:", mode);
            }),

          setTransformSpace: (space) =>
            set((state) => {
              state.transformSpace = space;
              console.log("[Store] Transform space:", space);
            }),

          // Animation actions
          addAnimation: (name, url) =>
            set((state) => {
              const exists = state.loadedAnimations.find((a) => a.url === url);
              if (!exists) {
                state.loadedAnimations.push({ name, url });
                console.log("[Store] Animation added:", name);
              }
            }),

          setCurrentAnimation: (name) =>
            set((state) => {
              state.currentAnimation = name;
              console.log("[Store] Current animation:", name);
            }),

          // Loading and error actions
          setLoading: (loading) =>
            set((state) => {
              state.isLoading = loading;
            }),

          setError: (error) =>
            set((state) => {
              state.lastError = error;
              console.error("[Store] Error:", error);
            }),

          clearError: () =>
            set((state) => {
              state.lastError = null;
            }),

          // Reset actions
          reset: () =>
            set((state) => {
              Object.assign(state, initialState);
              console.log("[Store] Complete reset");
            }),

          resetToStep: (step) =>
            set((state) => {
              // Reset everything after this step
              switch (step) {
                case "select-models":
                  Object.assign(state, initialState);
                  break;
                case "adjust-bones":
                  state.boneMapping = {};
                  state.boneEditingEnabled = false;
                  state.loadedAnimations = [];
                  state.currentAnimation = null;
                  break;
                case "export":
                  // Nothing to reset - we're at the end
                  break;
              }
              state.currentStep = step;
              console.log("[Store] Reset to step:", step);
            }),

          // Computed selectors
          canRetarget: () => {
            const state = get();
            return !!(state.sourceModelUrl && state.targetRigUrl);
          },

          canEditBones: () => {
            const state = get();
            return (
              state.isRetargeted &&
              !!(state.sourceSkeleton && state.targetSkeleton)
            );
          },

          canExport: () => {
            const state = get();
            return state.isRetargeted;
          },

          getMappedBonesCount: () => {
            const state = get();
            return Object.keys(state.boneMapping).length;
          },
        })),
      ),
      {
        name: "retargeting-storage",
        partialize: (state) => ({
          // Only persist UI preferences, not actual data
          showSkeleton: state.showSkeleton,
          mirrorEnabled: state.mirrorEnabled,
          transformMode: state.transformMode,
          transformSpace: state.transformSpace,
        }),
      },
    ),
    { name: "RetargetingStore" },
  ),
);

export const useRetargetingStore: StoreHook<RetargetingState> =
  retargetingStore;

// Convenience selector exports
export const useCanRetarget = () =>
  useRetargetingStore((state) => state.canRetarget());
export const useCanEditBones = () =>
  useRetargetingStore((state) => state.canEditBones());
export const useCanExport = () =>
  useRetargetingStore((state) => state.canExport());
export const useMappedBonesCount = () =>
  useRetargetingStore((state) => state.getMappedBonesCount());
