import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { Asset } from "../services/api/AssetService";
import {
  MaterialPreset,
  ImageGenerationResult,
  ModelGenerationResult,
  RemeshResult,
  HardpointResult,
  ArmorPlacementResult,
  RiggingResult,
  BuildingAnalysisResult,
  AssetMetadata,
} from "../types";

export interface PipelineStage {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  status: "idle" | "active" | "completed" | "failed" | "skipped";
}

export interface CustomMaterial {
  name: string;
  prompt: string;
  color?: string;
  displayName?: string;
}

export interface CustomAssetType {
  name: string;
  prompt: string;
}

export interface GeneratedAsset extends Asset {
  status: string;
  pipelineId?: string;
  modelUrl?: string;
  conceptArtUrl?: string;
  variants?: Asset[] | Array<{ name: string; modelUrl: string; id?: string }>;
  hasSpriteMetadata?: boolean;
  hasSprites?: boolean;
  sprites?: Array<{ angle: number; imageUrl: string }> | null;
  createdAt?: string;
  modelFile?: string;
}

interface GenerationState {
  // UI State
  generationType: "item" | "avatar" | undefined;
  activeView: "config" | "progress" | "results";
  showAdvancedPrompts: boolean;
  showAssetTypeEditor: boolean;
  editMaterialPrompts: boolean;
  showDeleteConfirm: string | null;

  // Material State
  materialPresets: MaterialPreset[];
  isLoadingMaterials: boolean;
  editingPreset: MaterialPreset | null;

  // Form State
  assetName: string;
  assetType: string;
  description: string;
  gameStyle: "classic" | "custom";
  customStyle: string;

  // Reference image input
  referenceImageMode: "auto" | "custom";
  referenceImageSource: "upload" | "url" | null;
  referenceImageUrl: string | null;
  referenceImageDataUrl: string | null;

  // Custom Prompts
  customGamePrompt: string;
  customAssetTypePrompt: string;

  // Asset Type Management
  customAssetTypes: CustomAssetType[];
  assetTypePrompts: Record<string, string>;

  // Pipeline Configuration
  useGPT5Enhancement: boolean;
  enableRetexturing: boolean;
  enableSprites: boolean;
  quality: "standard" | "high" | "ultra";

  // Avatar-specific Configuration
  enableRigging: boolean;
  characterHeight: number;

  // Material Configuration
  selectedMaterials: string[];
  customMaterials: CustomMaterial[];
  materialPromptOverrides: Record<string, string>;

  // Pipeline Execution State
  isGenerating: boolean;
  currentPipelineId: string | null;
  isGeneratingSprites: boolean;
  modelLoadError: string | null;
  isModelLoading: boolean;
  pipelineStages: PipelineStage[];

  // Results State
  generatedAssets: GeneratedAsset[];
  selectedAsset: GeneratedAsset | null;
  selectedStageResult: {
    stage: "description" | "image" | "model" | "remesh" | "analysis" | "final";
    result:
      | ImageGenerationResult
      | ModelGenerationResult
      | RemeshResult
      | HardpointResult
      | ArmorPlacementResult
      | RiggingResult
      | BuildingAnalysisResult
      | { modelUrl: string; metadata: AssetMetadata }
      | string;
  } | null;

  // Actions
  setGenerationType: (type: "item" | "avatar" | undefined) => void;
  setActiveView: (view: "config" | "progress" | "results") => void;
  setShowAdvancedPrompts: (show: boolean) => void;
  setShowAssetTypeEditor: (show: boolean) => void;
  setEditMaterialPrompts: (edit: boolean) => void;
  setShowDeleteConfirm: (id: string | null) => void;

  // Reference image actions
  setReferenceImageMode: (mode: "auto" | "custom") => void;
  setReferenceImageSource: (source: "upload" | "url" | null) => void;
  setReferenceImageUrl: (url: string | null) => void;
  setReferenceImageDataUrl: (dataUrl: string | null) => void;

  // Material Actions
  setMaterialPresets: (presets: MaterialPreset[]) => void;
  setIsLoadingMaterials: (loading: boolean) => void;
  setEditingPreset: (preset: MaterialPreset | null) => void;

  // Form Actions
  setAssetName: (name: string) => void;
  setAssetType: (type: string) => void;
  setDescription: (desc: string) => void;
  setGameStyle: (style: "classic" | "custom") => void;
  setCustomStyle: (style: string) => void;

  // Custom Prompt Actions
  setCustomGamePrompt: (prompt: string) => void;
  setCustomAssetTypePrompt: (prompt: string) => void;

  // Asset Type Actions
  setCustomAssetTypes: (types: CustomAssetType[]) => void;
  setAssetTypePrompts: (prompts: Record<string, string>) => void;
  addCustomAssetType: (type: CustomAssetType) => void;
  removeCustomAssetType: (name: string) => void;

  // Pipeline Configuration Actions
  setUseGPT5Enhancement: (use: boolean) => void;
  setEnableRetexturing: (enable: boolean) => void;
  setEnableSprites: (enable: boolean) => void;
  setQuality: (q: "standard" | "high" | "ultra") => void;

  // Avatar Configuration Actions
  setEnableRigging: (enable: boolean) => void;
  setCharacterHeight: (height: number) => void;

  // Material Configuration Actions
  setSelectedMaterials: (materials: string[]) => void;
  setCustomMaterials: (materials: CustomMaterial[]) => void;
  setMaterialPromptOverrides: (overrides: Record<string, string>) => void;
  addCustomMaterial: (material: CustomMaterial) => void;
  removeCustomMaterial: (name: string) => void;
  toggleMaterialSelection: (materialId: string) => void;

  // Pipeline Execution Actions
  setIsGenerating: (generating: boolean) => void;
  setCurrentPipelineId: (id: string | null) => void;
  setIsGeneratingSprites: (generating: boolean) => void;
  setModelLoadError: (error: string | null) => void;
  setIsModelLoading: (loading: boolean) => void;
  setPipelineStages: (stages: PipelineStage[]) => void;
  updatePipelineStage: (
    stageId: string,
    status: PipelineStage["status"],
  ) => void;

  // Results Actions
  setGeneratedAssets: (assets: GeneratedAsset[]) => void;
  setSelectedAsset: (asset: GeneratedAsset | null) => void;
  setSelectedStageResult: (
    result: {
      stage:
        "description" | "image" | "model" | "remesh" | "analysis" | "final";
      result:
        | ImageGenerationResult
        | ModelGenerationResult
        | RemeshResult
        | HardpointResult
        | ArmorPlacementResult
        | RiggingResult
        | BuildingAnalysisResult
        | { modelUrl: string; metadata: AssetMetadata }
        | string;
    } | null,
  ) => void;
  addGeneratedAsset: (asset: GeneratedAsset) => void;
  updateGeneratedAsset: (id: string, updates: Partial<GeneratedAsset>) => void;

  // Complex Actions
  resetForm: () => void;
  resetPipeline: () => void;
  initializePipelineStages: () => void;
}

interface StoreHook<T> {
  (): T;
  <U>(selector: (state: T) => U): U;
}

const generationStore = create<GenerationState>()(
  devtools(
    persist(
      subscribeWithSelector(
        immer((set, get) => ({
          // Initial State
          generationType: undefined,
          activeView: "config",
          showAdvancedPrompts: false,
          showAssetTypeEditor: false,
          editMaterialPrompts: false,
          showDeleteConfirm: null,

          materialPresets: [],
          isLoadingMaterials: true,
          editingPreset: null,

          assetName: "",
          assetType: "weapon",
          description: "",
          gameStyle: "classic",
          customStyle: "",
          referenceImageMode: "auto",
          referenceImageSource: null,
          referenceImageUrl: null,
          referenceImageDataUrl: null,

          customGamePrompt: "",
          customAssetTypePrompt: "",

          customAssetTypes: [],
          assetTypePrompts: {},

          useGPT5Enhancement: true,
          enableRetexturing: true,
          enableSprites: false,
          quality: "high",

          enableRigging: true,
          characterHeight: 1.7,

          selectedMaterials: ["bronze", "steel", "mithril"],
          customMaterials: [],
          materialPromptOverrides: {},

          isGenerating: false,
          currentPipelineId: null,
          isGeneratingSprites: false,
          modelLoadError: null,
          isModelLoading: false,
          pipelineStages: [],

          generatedAssets: [],
          selectedAsset: null,
          selectedStageResult: null,

          // Actions
          setGenerationType: (type) =>
            set((state) => {
              state.generationType = type;
              // Set default asset type for avatars
              if (type === "avatar") {
                state.assetType = "character";
              }
            }),

          setActiveView: (view) =>
            set((state) => {
              state.activeView = view;
            }),

          setShowAdvancedPrompts: (show) =>
            set((state) => {
              state.showAdvancedPrompts = show;
            }),

          setShowAssetTypeEditor: (show) =>
            set((state) => {
              state.showAssetTypeEditor = show;
            }),

          setEditMaterialPrompts: (edit) =>
            set((state) => {
              state.editMaterialPrompts = edit;
            }),

          setShowDeleteConfirm: (id) =>
            set((state) => {
              state.showDeleteConfirm = id;
            }),

          // Reference image actions
          setReferenceImageMode: (mode) =>
            set((state) => {
              state.referenceImageMode = mode;
              if (mode === "auto") {
                state.referenceImageSource = null;
                state.referenceImageUrl = null;
                state.referenceImageDataUrl = null;
              }
            }),
          setReferenceImageSource: (source) =>
            set((state) => {
              state.referenceImageSource = source;
            }),
          setReferenceImageUrl: (url) =>
            set((state) => {
              state.referenceImageUrl = url;
            }),
          setReferenceImageDataUrl: (dataUrl) =>
            set((state) => {
              state.referenceImageDataUrl = dataUrl;
            }),

          // Material Actions
          setMaterialPresets: (presets) =>
            set((state) => {
              state.materialPresets = presets;
            }),

          setIsLoadingMaterials: (loading) =>
            set((state) => {
              state.isLoadingMaterials = loading;
            }),

          setEditingPreset: (preset) =>
            set((state) => {
              state.editingPreset = preset;
            }),

          // Form Actions
          setAssetName: (name) =>
            set((state) => {
              state.assetName = name;
            }),

          setAssetType: (type) =>
            set((state) => {
              state.assetType = type;
            }),

          setDescription: (desc) =>
            set((state) => {
              state.description = desc;
            }),

          setGameStyle: (style) =>
            set((state) => {
              state.gameStyle = style;
            }),

          setCustomStyle: (style) =>
            set((state) => {
              state.customStyle = style;
            }),

          // Custom Prompt Actions
          setCustomGamePrompt: (prompt) =>
            set((state) => {
              state.customGamePrompt = prompt;
            }),

          setCustomAssetTypePrompt: (prompt) =>
            set((state) => {
              state.customAssetTypePrompt = prompt;
            }),

          // Asset Type Actions
          setCustomAssetTypes: (types) =>
            set((state) => {
              state.customAssetTypes = types;
            }),

          setAssetTypePrompts: (prompts) =>
            set((state) => {
              state.assetTypePrompts = prompts;
            }),

          addCustomAssetType: (type) =>
            set((state) => {
              state.customAssetTypes.push(type);
            }),

          removeCustomAssetType: (name) =>
            set((state) => {
              state.customAssetTypes = state.customAssetTypes.filter(
                (t) => t.name !== name,
              );
            }),

          // Pipeline Configuration Actions
          setUseGPT5Enhancement: (use) =>
            set((state) => {
              state.useGPT5Enhancement = use;
            }),

          setEnableRetexturing: (enable) =>
            set((state) => {
              state.enableRetexturing = enable;
            }),

          setEnableSprites: (enable) =>
            set((state) => {
              state.enableSprites = enable;
            }),

          setQuality: (q) =>
            set((state) => {
              state.quality = q;
            }),

          // Avatar Configuration Actions
          setEnableRigging: (enable) =>
            set((state) => {
              state.enableRigging = enable;
            }),

          setCharacterHeight: (height) =>
            set((state) => {
              state.characterHeight = height;
            }),

          // Material Configuration Actions
          setSelectedMaterials: (materials) =>
            set((state) => {
              state.selectedMaterials = materials;
            }),

          setCustomMaterials: (materials) =>
            set((state) => {
              state.customMaterials = materials;
            }),

          setMaterialPromptOverrides: (overrides) =>
            set((state) => {
              state.materialPromptOverrides = overrides;
            }),

          addCustomMaterial: (material) =>
            set((state) => {
              state.customMaterials.push(material);
            }),

          removeCustomMaterial: (name) =>
            set((state) => {
              state.customMaterials = state.customMaterials.filter(
                (m) => m.name !== name,
              );
            }),

          toggleMaterialSelection: (materialId) =>
            set((state) => {
              const index = state.selectedMaterials.indexOf(materialId);
              if (index > -1) {
                state.selectedMaterials.splice(index, 1);
              } else {
                state.selectedMaterials.push(materialId);
              }
            }),

          // Pipeline Execution Actions
          setIsGenerating: (generating) =>
            set((state) => {
              state.isGenerating = generating;
            }),

          setCurrentPipelineId: (id) =>
            set((state) => {
              state.currentPipelineId = id;
            }),

          setIsGeneratingSprites: (generating) =>
            set((state) => {
              state.isGeneratingSprites = generating;
            }),

          setModelLoadError: (error) =>
            set((state) => {
              state.modelLoadError = error;
            }),

          setIsModelLoading: (loading) =>
            set((state) => {
              state.isModelLoading = loading;
            }),

          setPipelineStages: (stages) =>
            set((state) => {
              state.pipelineStages = stages;
            }),

          updatePipelineStage: (stageId, status) =>
            set((state) => {
              const DEBUG =
                (import.meta as any).env?.VITE_DEBUG_PIPELINE === "true";
              if (DEBUG)
                console.log(
                  "Updating pipeline stage:",
                  stageId,
                  "to status:",
                  status,
                );
              const stage = state.pipelineStages.find((s) => s.id === stageId);
              if (stage) {
                stage.status = status;
              } else {
                // Don’t spam console; warn only in debug mode
                if (DEBUG)
                  console.warn(
                    "Stage not found:",
                    stageId,
                    "Available stages:",
                    state.pipelineStages.map((s) => s.id),
                  );
              }
            }),

          // Results Actions
          setGeneratedAssets: (assets) =>
            set((state) => {
              state.generatedAssets = assets;
            }),

          setSelectedAsset: (asset) =>
            set((state) => {
              state.selectedAsset = asset;
            }),

          setSelectedStageResult: (result) =>
            set((state) => {
              state.selectedStageResult = result;
            }),

          addGeneratedAsset: (asset) =>
            set((state) => {
              state.generatedAssets.push(asset);
            }),

          updateGeneratedAsset: (id, updates) =>
            set((state) => {
              const asset = state.generatedAssets.find((a) => a.id === id);
              if (asset) {
                Object.assign(asset, updates);
              }
            }),

          // Complex Actions
          resetForm: () =>
            set((state) => {
              state.assetName = "";
              state.description = "";
              state.customAssetTypePrompt = "";
              state.referenceImageMode = "auto";
              state.referenceImageSource = null;
              state.referenceImageUrl = null;
              state.referenceImageDataUrl = null;
              // Don't reset other configuration settings
            }),

          resetPipeline: () =>
            set((state) => {
              state.isGenerating = false;
              state.currentPipelineId = null;
              state.isGeneratingSprites = false;
              state.modelLoadError = null;
              state.isModelLoading = false;
              // Reset all pipeline stages to idle
              state.pipelineStages.forEach((stage) => {
                stage.status = "idle";
              });
            }),

          initializePipelineStages: () => {
            const {
              generationType,
              useGPT5Enhancement,
              enableRetexturing,
              enableSprites,
              enableRigging,
            } = get();
            const stages: PipelineStage[] = [
              {
                id: "text-input",
                name: "Text Input",
                icon: null, // Will be set by component
                description: "Process asset description",
                status: "idle",
              },
              {
                id: "gpt5-enhancement",
                name: "Prompt Enhancement",
                icon: null,
                description: "Enhance prompt with AI",
                status: useGPT5Enhancement ? "idle" : "skipped",
              },
              {
                id: "image-generation",
                name: "Image Generation",
                icon: null,
                description: "Generate concept art",
                status: "idle",
              },
              {
                id: "image-to-3d",
                name: "Image to 3D",
                icon: null,
                description: "Convert to 3D model",
                status: "idle",
              },
            ];

            // Add rigging stage for avatars
            if (generationType === "avatar" && enableRigging) {
              stages.push({
                id: "rigging",
                name: "Auto-Rigging",
                icon: null,
                description: "Add skeleton & animations",
                status: "idle",
              });
            }

            // Add retexturing stage for items
            if (generationType === "item" && enableRetexturing) {
              stages.push({
                id: "retexturing",
                name: "Material Variants",
                icon: null,
                description: "Create material variations",
                status: "idle",
              });
            }

            // Add sprite generation if enabled
            if (enableSprites) {
              stages.push({
                id: "sprites",
                name: "2D Sprites",
                icon: null,
                description: "Render sprites from multiple angles",
                status: "idle",
              });
            }

            set((state) => {
              state.pipelineStages = stages;
            });
          },
        })),
      ),
      {
        name: "generation-store",
        partialize: (state) => ({
          // Persist user preferences and configurations
          generationType: state.generationType,
          gameStyle: state.gameStyle,
          customStyle: state.customStyle,
          customGamePrompt: state.customGamePrompt,
          customAssetTypes: state.customAssetTypes,
          assetTypePrompts: state.assetTypePrompts,
          useGPT5Enhancement: state.useGPT5Enhancement,
          enableRetexturing: state.enableRetexturing,
          enableSprites: state.enableSprites,
          quality: state.quality,
          enableRigging: state.enableRigging,
          characterHeight: state.characterHeight,
          selectedMaterials: state.selectedMaterials,
          customMaterials: state.customMaterials,
          materialPromptOverrides: state.materialPromptOverrides,
          showAdvancedPrompts: state.showAdvancedPrompts,
          // Persist the selection mode but not the potentially large data URL
          referenceImageMode: state.referenceImageMode,
          referenceImageSource: state.referenceImageSource,
          referenceImageUrl: state.referenceImageUrl,
        }),
      },
    ),
    {
      name: "GenerationStore",
    },
  ),
);

export const useGenerationStore: StoreHook<GenerationState> = generationStore;
