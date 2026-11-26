import type {
  EmbeddedSurface,
  EmbeddedViewportConfig,
  GraphicsQuality,
  HideableUIElement,
  ViewportMode,
} from "../types/embeddedConfig";
import type { URLParamValidation } from "../utils/InputValidator";

// `streaming` is a compatibility alias used by older embedded stream URLs.
// It is normalized to the passive spectator viewport and never enters the
// authenticated/free-control path.
const EMBEDDED_MODE_VALUES = ["spectator", "streaming", "free"] as const;
const EMBEDDED_SURFACE_VALUES = ["viewport", "agent-control"] as const;
const GRAPHICS_QUALITY_VALUES = [
  "potato",
  "low",
  "medium",
  "high",
  "ultra",
] as const;
const HIDEABLE_UI_ELEMENTS = [
  "chat",
  "inventory",
  "minimap",
  "hotbar",
  "stats",
] as const;

export const embeddedParamSchema: URLParamValidation[] = [
  { name: "embedded", type: "boolean" },
  { name: "mode", type: "enum", enumValues: EMBEDDED_MODE_VALUES },
  { name: "surface", type: "enum", enumValues: EMBEDDED_SURFACE_VALUES },
  { name: "quality", type: "enum", enumValues: GRAPHICS_QUALITY_VALUES },
  { name: "agentId", type: "id", maxLength: 64 },
  { name: "characterId", type: "id", maxLength: 64 },
  { name: "followEntity", type: "id", maxLength: 64 },
  { name: "wsUrl", type: "url" },
  { name: "hiddenUI", type: "string", maxLength: 128 },
  { name: "privyUserId", type: "id", maxLength: 64 },
];

function resolveViewportMode(rawMode: unknown): ViewportMode {
  return rawMode === "free" ? "free" : "spectator";
}

function resolveEmbeddedSurface(rawSurface: unknown): EmbeddedSurface {
  return rawSurface === "agent-control" ? "agent-control" : "viewport";
}

function resolveGraphicsQuality(
  rawQuality: unknown,
  mode: ViewportMode,
): GraphicsQuality {
  switch (rawQuality) {
    case "potato":
    case "low":
    case "medium":
    case "high":
    case "ultra":
      return rawQuality;
    default:
      return mode === "spectator" ? "low" : "medium";
  }
}

function parseHiddenUIElements(
  rawHiddenUI: unknown,
): HideableUIElement[] | undefined {
  if (typeof rawHiddenUI !== "string" || rawHiddenUI.trim().length === 0) {
    return undefined;
  }

  const validElements = new Set<string>(HIDEABLE_UI_ELEMENTS);
  const hiddenElements = rawHiddenUI
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is HideableUIElement => validElements.has(value));

  return hiddenElements.length > 0 ? hiddenElements : undefined;
}

export function buildEmbeddedConfig(
  params: Record<string, unknown>,
  defaults: {
    wsUrl: string;
  },
): EmbeddedViewportConfig {
  const mode = resolveViewportMode(params.mode);

  return {
    agentId: typeof params.agentId === "string" ? params.agentId : "",
    authToken: "",
    characterId:
      typeof params.characterId === "string" ? params.characterId : undefined,
    wsUrl: typeof params.wsUrl === "string" ? params.wsUrl : defaults.wsUrl,
    mode,
    surface: resolveEmbeddedSurface(params.surface),
    followEntity:
      typeof params.followEntity === "string" ? params.followEntity : undefined,
    hiddenUI: parseHiddenUIElements(params.hiddenUI),
    quality: resolveGraphicsQuality(params.quality, mode),
    sessionToken: "",
    privyUserId:
      typeof params.privyUserId === "string" ? params.privyUserId : undefined,
  };
}

export function getEmbeddedSurface(
  config: EmbeddedViewportConfig | null | undefined,
): EmbeddedSurface {
  return config?.surface === "agent-control" ? "agent-control" : "viewport";
}

export function cloneEmbeddedConfig(
  config: EmbeddedViewportConfig | null | undefined,
): EmbeddedViewportConfig | null {
  if (!config) {
    return null;
  }

  return {
    ...config,
    hiddenUI: config.hiddenUI ? [...config.hiddenUI] : undefined,
  };
}
