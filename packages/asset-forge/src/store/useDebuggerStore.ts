import * as THREE from "three";
import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { MeshFittingParameters } from "../types/fitting";
import { DebugConfiguration } from "../types/service-types";

// Types for available models
interface ModelOption {
  id: string;
  name: string;
  path: string;
  description?: string;
  bodyType?: string;
  characterProfile?: {
    race: string;
    height: number;
    bodyType: "human" | "goblin" | "orc" | "creature" | "boss";
    headSize: "small" | "medium" | "large" | "huge";
    headShape: "round" | "oval" | "angular" | "wide";
    neckLength: "short" | "medium" | "long";
    shoulderWidth: "narrow" | "medium" | "wide" | "massive";
  };
}

interface HelmetRotation {
  x: number;
  y: number;
  z: number;
}

interface DebuggerState {
  // View and Demo Settings
  activeDemo: string;
  viewMode: "sphereCube" | "avatarArmor" | "helmetFitting";
  showWireframe: boolean;

  // Model Selection
  selectedAvatar: ModelOption;
  selectedArmor: ModelOption;
  selectedHelmet: ModelOption;
  selectedAvatarPath: string;
  selectedArmorPath: string;
  selectedHelmetPath: string;

  // Animation Settings
  currentAnimation: "tpose" | "walking" | "running";
  isAnimationPlaying: boolean;

  // Fitting Parameters
  fittingParameters: MeshFittingParameters;

  // Helmet Fitting Settings
  helmetFittingMethod: "auto" | "manual";
  helmetSizeMultiplier: number;
  helmetFitTightness: number;
  helmetVerticalOffset: number;
  helmetForwardOffset: number;
  helmetRotation: HelmetRotation;

  // Debug Visualization
  showHeadBounds: boolean;
  showCollisionDebug: boolean;
  showHull: boolean;
  showDebugArrows: boolean;
  debugArrowDensity: number;
  debugColorMode: "direction" | "magnitude" | "sidedness";

  // Processing States
  isProcessing: boolean;
  isArmorFitted: boolean;
  isArmorBound: boolean;
  isHelmetFitted: boolean;
  isHelmetAttached: boolean;
  boundArmorMesh: THREE.SkinnedMesh | null;

  // Error Handling
  lastError: string | null;

  // History for undo/redo
  canUndo: boolean;
  canRedo: boolean;
}

interface DebuggerActions {
  // View and Demo
  setActiveDemo: (demo: string) => void;
  setViewMode: (mode: DebuggerState["viewMode"]) => void;
  toggleWireframe: () => void;
  setShowWireframe: (show: boolean) => void;

  // Model Selection
  setSelectedAvatar: (avatar: ModelOption) => void;
  setSelectedArmor: (armor: ModelOption) => void;
  setSelectedHelmet: (helmet: ModelOption) => void;
  updateModelPaths: () => void;

  // Animation
  setCurrentAnimation: (animation: DebuggerState["currentAnimation"]) => void;
  setIsAnimationPlaying: (playing: boolean) => void;
  toggleAnimation: () => void;

  // Fitting Parameters
  updateFittingParameters: (params: Partial<MeshFittingParameters>) => void;
  resetFittingParameters: () => void;

  // Helmet Fitting
  setHelmetFittingMethod: (method: "auto" | "manual") => void;
  setHelmetSizeMultiplier: (multiplier: number) => void;
  setHelmetFitTightness: (tightness: number) => void;
  setHelmetVerticalOffset: (offset: number) => void;
  setHelmetForwardOffset: (offset: number) => void;
  setHelmetRotation: (rotation: Partial<HelmetRotation>) => void;
  resetHelmetSettings: () => void;

  // Debug Visualization
  setShowHeadBounds: (show: boolean) => void;
  setShowCollisionDebug: (show: boolean) => void;
  setShowHull: (show: boolean) => void;
  setShowDebugArrows: (show: boolean) => void;
  setDebugArrowDensity: (density: number) => void;
  setDebugColorMode: (mode: DebuggerState["debugColorMode"]) => void;
  toggleDebugVisualization: (
    type: "headBounds" | "collision" | "hull" | "arrows",
  ) => void;

  // Processing States
  setIsProcessing: (processing: boolean) => void;
  setIsArmorFitted: (fitted: boolean) => void;
  setIsArmorBound: (bound: boolean) => void;
  setIsHelmetFitted: (fitted: boolean) => void;
  setIsHelmetAttached: (attached: boolean) => void;
  setBoundArmorMesh: (mesh: THREE.SkinnedMesh | null) => void;
  resetProcessingStates: () => void;

  // Error Handling
  setError: (error: string | null) => void;
  clearError: () => void;

  // Complex Actions
  resetDebugger: () => void;
  saveDebugConfiguration: () => void;
  loadDebugConfiguration: (config: DebugConfiguration) => void;
}

// Selectors
interface DebuggerSelectors {
  isReadyToFit: () => boolean;
  getActiveModelName: () => string;
  getCurrentDebugInfo: () => string;
}

type DebuggerStore = DebuggerState & DebuggerActions & DebuggerSelectors;

interface StoreHook<T> {
  (): T;
  <U>(selector: (state: T) => U): U;
}

const defaultFittingParameters: MeshFittingParameters = {
  iterations: 8,
  stepSize: 0.15,
  smoothingRadius: 0.2,
  smoothingStrength: 0.3,
  targetOffset: 0.05,
  sampleRate: 1.0,
  preserveFeatures: true,
  featureAngleThreshold: 45,
  useImprovedShrinkwrap: false,
  preserveOpenings: true,
  pushInteriorVertices: true,
  showDebugArrows: false,
  debugArrowDensity: 10,
  debugColorMode: "direction",
};

// Default selections - empty to force selection from available assets
const defaultAvatar: ModelOption = { id: "", name: "Select Avatar", path: "" };
const defaultArmor: ModelOption = { id: "", name: "Select Armor", path: "" };
const defaultHelmet: ModelOption = { id: "", name: "Select Helmet", path: "" };

const initialState: DebuggerState = {
  // View and Demo Settings
  activeDemo: "sphereCube",
  viewMode: "avatarArmor",
  showWireframe: true,

  // Model Selection
  selectedAvatar: defaultAvatar,
  selectedArmor: defaultArmor,
  selectedHelmet: defaultHelmet,
  selectedAvatarPath: defaultAvatar?.path || "",
  selectedArmorPath: defaultArmor?.path || "",
  selectedHelmetPath: defaultHelmet?.path || "",

  // Animation Settings
  currentAnimation: "tpose",
  isAnimationPlaying: false,

  // Fitting Parameters
  fittingParameters: { ...defaultFittingParameters },

  // Helmet Fitting Settings
  helmetFittingMethod: "auto",
  helmetSizeMultiplier: 1.0,
  helmetFitTightness: 1.0,
  helmetVerticalOffset: 0,
  helmetForwardOffset: 0,
  helmetRotation: { x: 0, y: 0, z: 0 },

  // Debug Visualization
  showHeadBounds: true,
  showCollisionDebug: false,
  showHull: false,
  showDebugArrows: false,
  debugArrowDensity: 1,
  debugColorMode: "direction",

  // Processing States
  isProcessing: false,
  isArmorFitted: false,
  isArmorBound: false,
  isHelmetFitted: false,
  isHelmetAttached: false,
  boundArmorMesh: null,

  // Error Handling
  lastError: null,

  // History
  canUndo: false,
  canRedo: false,
};

const debuggerStore = create<DebuggerStore>()(
  subscribeWithSelector(
    devtools(
      persist(
        immer((set, get) => ({
          ...initialState,

          // View and Demo
          setActiveDemo: (demo) =>
            set((state) => {
              state.activeDemo = demo;
              state.lastError = null;
            }),

          setViewMode: (mode) =>
            set((state) => {
              state.viewMode = mode;
              state.lastError = null;
              // Reset processing states when switching modes
              state.isProcessing = false;
            }),

          toggleWireframe: () =>
            set((state) => {
              state.showWireframe = !state.showWireframe;
            }),

          setShowWireframe: (show) =>
            set((state) => {
              state.showWireframe = show;
            }),

          // Model Selection
          setSelectedAvatar: (avatar) =>
            set((state) => {
              state.selectedAvatar = avatar;
              state.selectedAvatarPath = avatar?.path || "";
              state.isArmorFitted = false;
              state.isArmorBound = false;
              state.isHelmetAttached = false;
              state.lastError = null;
            }),

          setSelectedArmor: (armor) =>
            set((state) => {
              state.selectedArmor = armor;
              state.selectedArmorPath = armor?.path || "";
              state.isArmorFitted = false;
              state.isArmorBound = false;
              state.lastError = null;
            }),

          setSelectedHelmet: (helmet) =>
            set((state) => {
              state.selectedHelmet = helmet;
              state.selectedHelmetPath = helmet?.path || "";
              state.isHelmetAttached = false;
              state.lastError = null;
            }),

          updateModelPaths: () =>
            set((state) => {
              if (state.selectedAvatar) {
                state.selectedAvatarPath = state.selectedAvatar.path;
              }
              if (state.selectedArmor) {
                state.selectedArmorPath = state.selectedArmor.path;
              }
              if (state.selectedHelmet) {
                state.selectedHelmetPath = state.selectedHelmet.path;
              }
            }),

          // Animation
          setCurrentAnimation: (animation) =>
            set((state) => {
              state.currentAnimation = animation;
            }),

          setIsAnimationPlaying: (playing) =>
            set((state) => {
              state.isAnimationPlaying = playing;
            }),

          toggleAnimation: () =>
            set((state) => {
              state.isAnimationPlaying = !state.isAnimationPlaying;
            }),

          // Fitting Parameters
          updateFittingParameters: (params) =>
            set((state) => {
              Object.assign(state.fittingParameters, params);
            }),

          resetFittingParameters: () =>
            set((state) => {
              state.fittingParameters = { ...defaultFittingParameters };
            }),

          // Helmet Fitting
          setHelmetFittingMethod: (method) =>
            set((state) => {
              state.helmetFittingMethod = method;
            }),

          setHelmetSizeMultiplier: (multiplier) =>
            set((state) => {
              state.helmetSizeMultiplier = multiplier;
            }),

          setHelmetFitTightness: (tightness) =>
            set((state) => {
              state.helmetFitTightness = tightness;
            }),

          setHelmetVerticalOffset: (offset) =>
            set((state) => {
              state.helmetVerticalOffset = offset;
            }),

          setHelmetForwardOffset: (offset) =>
            set((state) => {
              state.helmetForwardOffset = offset;
            }),

          setHelmetRotation: (rotation) =>
            set((state) => {
              Object.assign(state.helmetRotation, rotation);
            }),

          resetHelmetSettings: () =>
            set((state) => {
              state.helmetFittingMethod = "auto";
              state.helmetSizeMultiplier = 1.0;
              state.helmetFitTightness = 1.0;
              state.helmetVerticalOffset = 0;
              state.helmetForwardOffset = 0;
              state.helmetRotation = { x: 0, y: 0, z: 0 };
            }),

          // Debug Visualization
          setShowHeadBounds: (show) =>
            set((state) => {
              state.showHeadBounds = show;
            }),

          setShowCollisionDebug: (show) =>
            set((state) => {
              state.showCollisionDebug = show;
            }),

          setShowHull: (show) =>
            set((state) => {
              state.showHull = show;
            }),

          setShowDebugArrows: (show) =>
            set((state) => {
              state.showDebugArrows = show;
              state.fittingParameters.showDebugArrows = show;
            }),

          setDebugArrowDensity: (density) =>
            set((state) => {
              state.debugArrowDensity = density;
              state.fittingParameters.debugArrowDensity = density * 10;
            }),

          setDebugColorMode: (mode) =>
            set((state) => {
              state.debugColorMode = mode;
              state.fittingParameters.debugColorMode = mode;
            }),

          toggleDebugVisualization: (type) =>
            set((state) => {
              switch (type) {
                case "headBounds":
                  state.showHeadBounds = !state.showHeadBounds;
                  break;
                case "collision":
                  state.showCollisionDebug = !state.showCollisionDebug;
                  break;
                case "hull":
                  state.showHull = !state.showHull;
                  break;
                case "arrows":
                  state.showDebugArrows = !state.showDebugArrows;
                  state.fittingParameters.showDebugArrows =
                    !state.showDebugArrows;
                  break;
              }
            }),

          // Processing States
          setIsProcessing: (processing) =>
            set((state) => {
              state.isProcessing = processing;
            }),

          setIsArmorFitted: (fitted) =>
            set((state) => {
              state.isArmorFitted = fitted;
            }),

          setIsArmorBound: (bound) =>
            set((state) => {
              state.isArmorBound = bound;
            }),

          setIsHelmetFitted: (fitted) =>
            set((state) => {
              state.isHelmetFitted = fitted;
            }),

          setIsHelmetAttached: (attached) =>
            set((state) => {
              state.isHelmetAttached = attached;
            }),

          setBoundArmorMesh: (mesh) =>
            set(() => ({
              boundArmorMesh: mesh,
            })),

          resetProcessingStates: () =>
            set((state) => {
              state.isProcessing = false;
              state.isArmorFitted = false;
              state.isArmorBound = false;
              state.isHelmetFitted = false;
              state.isHelmetAttached = false;
              state.boundArmorMesh = null;
            }),

          // Error Handling
          setError: (error) =>
            set((state) => {
              state.lastError = error;
            }),

          clearError: () =>
            set((state) => {
              state.lastError = null;
            }),

          // Complex Actions
          resetDebugger: () =>
            set((state) => {
              // Reset to initial state
              Object.assign(state, initialState);
            }),

          saveDebugConfiguration: () => {
            const state = get();
            const config = {
              viewMode: state.viewMode,
              showWireframe: state.showWireframe,
              fittingParameters: state.fittingParameters,
              helmetSettings: {
                method: state.helmetFittingMethod,
                sizeMultiplier: state.helmetSizeMultiplier,
                fitTightness: state.helmetFitTightness,
                verticalOffset: state.helmetVerticalOffset,
                forwardOffset: state.helmetForwardOffset,
                rotation: state.helmetRotation,
              },
              debugVisualization: {
                showHeadBounds: state.showHeadBounds,
                showCollisionDebug: state.showCollisionDebug,
                showHull: state.showHull,
                showDebugArrows: state.showDebugArrows,
                debugArrowDensity: state.debugArrowDensity,
                debugColorMode: state.debugColorMode,
              },
              timestamp: new Date().toISOString(),
            };

            const json = JSON.stringify(config, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `debug_config_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
          },

          loadDebugConfiguration: (config) =>
            set((state) => {
              if (config.viewMode) state.viewMode = config.viewMode;
              if (config.showWireframe !== undefined)
                state.showWireframe = config.showWireframe;
              if (config.fittingParameters) {
                Object.assign(
                  state.fittingParameters,
                  config.fittingParameters,
                );
              }
              if (config.helmetSettings) {
                const hs = config.helmetSettings;
                if (hs.method) state.helmetFittingMethod = hs.method;
                if (hs.sizeMultiplier !== undefined)
                  state.helmetSizeMultiplier = hs.sizeMultiplier;
                if (hs.fitTightness !== undefined)
                  state.helmetFitTightness = hs.fitTightness;
                if (hs.verticalOffset !== undefined)
                  state.helmetVerticalOffset = hs.verticalOffset;
                if (hs.forwardOffset !== undefined)
                  state.helmetForwardOffset = hs.forwardOffset;
                if (hs.rotation)
                  Object.assign(state.helmetRotation, hs.rotation);
              }
              if (config.debugVisualization) {
                const dv = config.debugVisualization;
                if (dv.showHeadBounds !== undefined)
                  state.showHeadBounds = dv.showHeadBounds;
                if (dv.showCollisionDebug !== undefined)
                  state.showCollisionDebug = dv.showCollisionDebug;
                if (dv.showHull !== undefined) state.showHull = dv.showHull;
                if (dv.showDebugArrows !== undefined) {
                  state.showDebugArrows = dv.showDebugArrows;
                  state.fittingParameters.showDebugArrows = dv.showDebugArrows;
                }
                if (dv.debugArrowDensity !== undefined) {
                  state.debugArrowDensity = dv.debugArrowDensity;
                  state.fittingParameters.debugArrowDensity =
                    dv.debugArrowDensity * 10;
                }
                if (dv.debugColorMode) {
                  state.debugColorMode = dv.debugColorMode;
                  state.fittingParameters.debugColorMode = dv.debugColorMode;
                }
              }
            }),

          // Selectors
          isReadyToFit: () => {
            const state = get();
            if (state.viewMode === "avatarArmor") {
              return !!(state.selectedAvatar && state.selectedArmor);
            }
            if (state.viewMode === "helmetFitting") {
              return !!(state.selectedAvatar && state.selectedHelmet);
            }
            return true; // sphereCube is always ready
          },

          getActiveModelName: () => {
            const state = get();
            if (state.viewMode === "avatarArmor") {
              return `${state.selectedAvatar?.name || "None"} + ${state.selectedArmor?.name || "None"}`;
            }
            if (state.viewMode === "helmetFitting") {
              return `${state.selectedAvatar?.name || "None"} + ${state.selectedHelmet?.name || "None"}`;
            }
            return "Sphere + Cube";
          },

          getCurrentDebugInfo: () => {
            const state = get();
            return `Mode: ${state.viewMode} | Models: ${state.getActiveModelName()} | Wireframe: ${state.showWireframe ? "ON" : "OFF"}`;
          },
        })),
        {
          name: "mesh-fitting-debugger",
          partialize: (state) => ({
            // Persist these settings
            showWireframe: state.showWireframe,
            fittingParameters: state.fittingParameters,
            helmetFittingMethod: state.helmetFittingMethod,
            helmetSizeMultiplier: state.helmetSizeMultiplier,
            helmetFitTightness: state.helmetFitTightness,
            helmetVerticalOffset: state.helmetVerticalOffset,
            helmetForwardOffset: state.helmetForwardOffset,
            helmetRotation: state.helmetRotation,
            showHeadBounds: state.showHeadBounds,
            showCollisionDebug: state.showCollisionDebug,
            showHull: state.showHull,
            showDebugArrows: state.showDebugArrows,
            debugArrowDensity: state.debugArrowDensity,
            debugColorMode: state.debugColorMode,
          }),
        },
      ),
      {
        name: "debugger-store",
      },
    ),
  ),
);

export const useDebuggerStore: StoreHook<DebuggerStore> = debuggerStore;

// Export convenient selectors
export const useIsReadyToFit = () =>
  useDebuggerStore((state) => state.isReadyToFit());
export const useActiveModelName = () =>
  useDebuggerStore((state) => state.getActiveModelName());
export const useCurrentDebugInfo = () =>
  useDebuggerStore((state) => state.getCurrentDebugInfo());
