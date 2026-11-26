import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { HandRiggingResult } from "../services/hand-rigging/HandRiggingService";
import { SimpleHandRiggingResult } from "../services/hand-rigging/SimpleHandRiggingService";
import type { Asset } from "../types";

export type ProcessingStage =
  | "idle"
  | "detecting-wrists"
  | "creating-bones"
  | "applying-weights"
  | "complete"
  | "error";

export interface HandData {
  fingerCount: number;
  confidence: number;
  bonesAdded: number;
}

export interface ProcessingStep {
  id: ProcessingStage;
  name: string;
  description: string;
  icon: React.ReactNode;
  status: "pending" | "active" | "complete" | "error" | "skipped";
}

interface HandRiggingState {
  // Asset management
  selectedAvatar: Asset | null;
  selectedFile: File | null; // Keep for backwards compatibility
  modelUrl: string | null;

  // Processing state
  processingStage: ProcessingStage;
  serviceInitialized: boolean;
  isFitting: boolean;

  // Hand data
  leftHandData: HandData | null;
  rightHandData: HandData | null;

  // Results
  riggingResult: HandRiggingResult | SimpleHandRiggingResult | null;
  modelInfo: { vertices: number; faces: number; materials: number } | null;

  // Configuration
  useSimpleMode: boolean;

  // Visualization
  showSkeleton: boolean;
  showDebugImages: boolean;
  debugImages: {
    left?: string;
    right?: string;
    [key: string]: string | undefined;
  };

  // UI state
  showExportModal: boolean;

  // Error handling
  error: string | null;

  // Actions
  setSelectedAvatar: (asset: Asset | null) => void;
  setSelectedFile: (file: File | null) => void;
  setModelUrl: (url: string | null) => void;
  setProcessingStage: (stage: ProcessingStage) => void;
  setServiceInitialized: (initialized: boolean) => void;
  setIsFitting: (fitting: boolean) => void;
  setLeftHandData: (data: HandData | null) => void;
  setRightHandData: (data: HandData | null) => void;
  setRiggingResult: (
    result: HandRiggingResult | SimpleHandRiggingResult | null,
  ) => void;
  setModelInfo: (
    info: { vertices: number; faces: number; materials: number } | null,
  ) => void;
  setUseSimpleMode: (simple: boolean) => void;
  setShowSkeleton: (show: boolean) => void;
  setShowDebugImages: (show: boolean) => void;
  setDebugImages: (images: {
    left?: string;
    right?: string;
    [key: string]: string | undefined;
  }) => void;
  setShowExportModal: (show: boolean) => void;
  setError: (error: string | null) => void;

  // Complex actions
  reset: () => void;
  updateProcessingProgress: (
    stage: ProcessingStage,
    leftHand?: HandData,
    rightHand?: HandData,
  ) => void;
  toggleSkeleton: () => void;
  toggleDebugImages: () => void;

  // Computed values
  getProcessingSteps: (useSimpleMode: boolean) => ProcessingStep[];
  isProcessing: () => boolean;
  canStartProcessing: () => boolean;
  canExport: () => boolean;
}

interface StoreHook<T> {
  (): T;
  <U>(selector: (state: T) => U): U;
}

const handRiggingStore = create<HandRiggingState>()(
  devtools(
    persist(
      subscribeWithSelector(
        immer((set, get) => ({
          // Initial state
          selectedAvatar: null,
          selectedFile: null,
          modelUrl: null,
          processingStage: "idle",
          serviceInitialized: false,
          isFitting: false,
          leftHandData: null,
          rightHandData: null,
          riggingResult: null,
          modelInfo: null,
          useSimpleMode: true,
          showSkeleton: false,
          showDebugImages: false,
          debugImages: {},
          showExportModal: false,
          error: null,

          // Basic actions
          setSelectedAvatar: (asset) =>
            set((state) => {
              state.selectedAvatar = asset;
              if (!asset) {
                state.modelUrl = null;
                state.modelInfo = null;
                state.selectedFile = null;
              }
            }),

          setSelectedFile: (file) =>
            set((state) => {
              state.selectedFile = file;
              if (!file) {
                state.modelUrl = null;
                state.modelInfo = null;
                state.selectedAvatar = null;
              }
            }),

          setModelUrl: (url) =>
            set((state) => {
              // Revoke old blob URL if it exists
              if (state.modelUrl && state.modelUrl.startsWith("blob:")) {
                URL.revokeObjectURL(state.modelUrl);
              }
              state.modelUrl = url;
            }),

          setProcessingStage: (stage) =>
            set((state) => {
              state.processingStage = stage;
              state.isFitting =
                stage !== "idle" && stage !== "complete" && stage !== "error";
            }),

          setServiceInitialized: (initialized) =>
            set((state) => {
              state.serviceInitialized = initialized;
            }),

          setIsFitting: (fitting) =>
            set((state) => {
              state.isFitting = fitting;
            }),

          setLeftHandData: (data) =>
            set((state) => {
              state.leftHandData = data;
            }),

          setRightHandData: (data) =>
            set((state) => {
              state.rightHandData = data;
            }),

          setRiggingResult: (result) =>
            set((state) => {
              state.riggingResult = result;
            }),

          setModelInfo: (info) =>
            set((state) => {
              state.modelInfo = info;
            }),

          setUseSimpleMode: (simple) =>
            set((state) => {
              state.useSimpleMode = simple;
              // Reset service initialization when mode changes
              state.serviceInitialized = false;
            }),

          setShowSkeleton: (show) =>
            set((state) => {
              state.showSkeleton = show;
            }),

          setShowDebugImages: (show) =>
            set((state) => {
              state.showDebugImages = show;
            }),

          setDebugImages: (images) =>
            set((state) => {
              state.debugImages = images;
            }),

          setShowExportModal: (show) =>
            set((state) => {
              state.showExportModal = show;
            }),

          setError: (error) =>
            set((state) => {
              state.error = error;
              if (error) {
                state.processingStage = "error";
              }
            }),

          // Complex actions
          reset: () =>
            set((state) => {
              // Revoke blob URL if it exists
              if (state.modelUrl && state.modelUrl.startsWith("blob:")) {
                URL.revokeObjectURL(state.modelUrl);
              }

              state.selectedAvatar = null;
              state.selectedFile = null;
              state.modelUrl = null;
              state.processingStage = "idle";
              state.leftHandData = null;
              state.rightHandData = null;
              state.error = null;
              state.showSkeleton = false;
              state.riggingResult = null;
              state.debugImages = {};
              state.modelInfo = null;
              state.isFitting = false;
            }),

          updateProcessingProgress: (stage, leftHand, rightHand) =>
            set((state) => {
              state.processingStage = stage;
              if (leftHand) state.leftHandData = leftHand;
              if (rightHand) state.rightHandData = rightHand;
              state.isFitting =
                stage !== "idle" && stage !== "complete" && stage !== "error";
            }),

          toggleSkeleton: () =>
            set((state) => {
              state.showSkeleton = !state.showSkeleton;
            }),

          toggleDebugImages: () =>
            set((state) => {
              state.showDebugImages = !state.showDebugImages;
            }),

          // Computed values
          getProcessingSteps: (useSimpleMode) => {
            const { processingStage } = get();

            const steps: Omit<ProcessingStep, "icon">[] = [
              {
                id: "detecting-wrists",
                name: "Detecting Wrist Bones",
                description: "Finding existing wrist bones in the model",
                status:
                  processingStage === "detecting-wrists"
                    ? "active"
                    : [
                          "creating-bones",
                          "applying-weights",
                          "complete",
                        ].includes(processingStage)
                      ? "complete"
                      : "pending",
              },
              {
                id: "creating-bones",
                name: useSimpleMode
                  ? "Creating Simple Hand Bones"
                  : "Detecting Hand Poses",
                description: useSimpleMode
                  ? "Adding palm and finger bones for basic grabbing"
                  : "Using AI to detect finger positions",
                status:
                  processingStage === "creating-bones"
                    ? "active"
                    : ["applying-weights", "complete"].includes(processingStage)
                      ? "complete"
                      : "pending",
              },
              {
                id: "applying-weights",
                name: "Applying Vertex Weights",
                description: useSimpleMode
                  ? "Distributing weights for smooth deformation"
                  : "Calculating smooth skin weights for each finger",
                status:
                  processingStage === "applying-weights"
                    ? "active"
                    : processingStage === "complete"
                      ? "complete"
                      : "pending",
              },
            ];

            return steps as ProcessingStep[];
          },

          isProcessing: () => {
            const { processingStage } = get();
            return (
              processingStage !== "idle" &&
              processingStage !== "complete" &&
              processingStage !== "error"
            );
          },

          canStartProcessing: () => {
            const {
              selectedAvatar,
              selectedFile,
              serviceInitialized,
              processingStage,
            } = get();
            return (
              (!!selectedAvatar || !!selectedFile) &&
              serviceInitialized &&
              (processingStage === "idle" || processingStage === "complete")
            );
          },

          canExport: () => {
            const { processingStage, riggingResult } = get();
            return (
              processingStage === "complete" &&
              !!riggingResult &&
              !!riggingResult.riggedModel
            );
          },
        })),
      ),
      {
        name: "hand-rigging-store",
        partialize: (state) => ({
          useSimpleMode: state.useSimpleMode,
          showDebugImages: state.showDebugImages,
        }),
      },
    ),
    {
      name: "HandRiggingStore",
    },
  ),
);

export const useHandRiggingStore: StoreHook<HandRiggingState> =
  handRiggingStore;
