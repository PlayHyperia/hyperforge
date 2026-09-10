import {
  VRMLoaderPlugin,
  type VRM,
  type VRMHumanBoneName,
} from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

import { createEmoteFactory } from "../packages/shared/src/extras/three/createEmoteFactory";
import { EquipmentVisualSystem } from "../packages/shared/src/systems/client/EquipmentVisualSystem";
import { validateStreamingEquipmentVisualModel } from "../packages/shared/src/systems/client/EquipmentVisualHelpers";
import { EventType } from "../packages/shared/src/types/events";

interface EquipmentDefinition {
  asset: string;
  itemId: string;
  slot: "weapon" | "shield" | "gatheringtool";
}

export interface EquipmentSwitchAuditConfig {
  schemaVersion: 1 | 2;
  title: string;
  avatar: string;
  avatarId?: string;
  pose?: string;
  equipment: {
    weapon: EquipmentDefinition;
    shield?: EquipmentDefinition;
    hatchet: EquipmentDefinition;
    pickaxe: EquipmentDefinition;
  };
  rapidSwitchIterations: number;
}

interface EquipmentVisuals {
  weapon?: THREE.Object3D;
  shield?: THREE.Object3D;
  gatheringtool?: THREE.Object3D;
}

interface EquipmentVisualInternals {
  handleEquipmentChange(data: {
    playerId: string;
    slot: string;
    itemId: string | null;
  }): Promise<void>;
  handleGatheringToolShow(data: {
    playerId: string;
    itemId: string;
    slot: string;
  }): Promise<void>;
  handleGatheringToolHide(data: { playerId: string; slot: string }): void;
  loadEquipmentModel(
    itemId: string,
    slot: string,
    fallback: unknown,
  ): Promise<GLTF | null>;
  playerEquipment: Map<string, EquipmentVisuals>;
  activeGatheringToolItemIds: Map<string, string>;
  attachedEquipmentItemIds: Map<string, Map<string, string>>;
  attachedEquipmentAvatarVrms: Map<string, VRM>;
}

interface PhaseResult {
  id: string;
  attached: Record<string, string>;
  activeGatheringToolItemId: string | null;
  visible: Record<string, boolean>;
  underCurrentAvatar: Record<string, boolean>;
  attachmentAvatarMatches: boolean;
  failures: string[];
}

interface ContestantPhaseSnapshot extends PhaseResult {
  playerId: string;
}

interface TwoContestantPhaseResult {
  id: string;
  contestants: ContestantPhaseSnapshot[];
  failures: string[];
}

interface TransportFaultAuditResult {
  requests: Array<{
    url: string;
    status: number;
    ok: boolean;
  }>;
  failedCycle: {
    ready: boolean;
    status: string | null;
  };
  recoveredCycle: {
    ready: boolean;
    status: string | null;
  };
  failures: string[];
}

interface EventSubscription {
  unsubscribe(): void;
}

class AuditEventBus {
  private handlers = new Map<
    string,
    Set<(event: { data: unknown }) => void | Promise<void>>
  >();

  subscribe(
    type: string,
    handler: (event: { data: unknown }) => void | Promise<void>,
  ): EventSubscription {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return {
      unsubscribe: () => handlers.delete(handler),
    };
  }

  emitEvent(type: string, data: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) {
      void handler({ data });
    }
  }
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))
  ];
}

function isDescendant(root: THREE.Object3D, child: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = child;
  while (current) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function addPhaseCard(
  title: string,
  rendererCanvas: HTMLCanvasElement,
  phase: PhaseResult,
): void {
  const card = document.createElement("article");
  card.dataset.status = phase.failures.length === 0 ? "pass" : "fail";
  const image = document.createElement("img");
  image.alt = title;
  image.src = rendererCanvas.toDataURL("image/png");
  const details = document.createElement("div");
  details.className = "meta";
  const visible = Object.entries(phase.visible)
    .filter(([, value]) => value)
    .map(([slot]) => slot)
    .join(", ");
  details.innerHTML = `<div class="name"></div><div class="stats"></div>`;
  details.querySelector(".name")!.textContent = title;
  details.querySelector(".stats")!.textContent =
    phase.failures.length === 0
      ? `PASS · visible ${visible || "none"}`
      : `FAIL · ${phase.failures.join(" · ")}`;
  card.append(image, details);
  document.querySelector("main")!.append(card);
}

async function loadAvatar(asset: string): Promise<{
  vrm: VRM;
  raw: { userData: { vrm: VRM }; scene: THREE.Object3D };
}> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(
    asset.startsWith("/") ? asset : `/asset/${asset}`,
  );
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm?.humanoid) throw new Error(`${asset} is not a humanoid VRM`);
  const bounds = new THREE.Box3().setFromObject(vrm.scene, true);
  const height = bounds.getSize(new THREE.Vector3()).y;
  vrm.scene.scale.setScalar(1.6 / Math.max(height, 0.001));
  vrm.scene.updateMatrixWorld(true);
  vrm.humanoid.update();
  return {
    vrm,
    raw: { userData: { vrm }, scene: vrm.scene },
  };
}

export async function runEquipmentSwitchAudit(
  config: EquipmentSwitchAuditConfig,
): Promise<{
  renderer: string;
  userAgent: string;
  phases: PhaseResult[];
  twoContestantPhases: TwoContestantPhaseResult[];
  rapidSwitch: {
    iterations: number;
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    over50Ms: number;
    failures: string[];
  };
  twoContestantRapidSwitch: {
    iterations: number;
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    over50Ms: number;
    failures: string[];
  };
  transportFault: TransportFaultAuditResult;
  equipmentValidation: Array<{
    itemId: string;
    slot: string;
    valid: boolean;
    reason: string | null;
  }>;
  failures: string[];
}> {
  const rendererCanvas = document.createElement("canvas");
  rendererCanvas.width = 480;
  rendererCanvas.height = 440;
  const renderer = new THREE.WebGLRenderer({
    canvas: rendererCanvas,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1);
  renderer.setSize(480, 440, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  const gl = renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = debug
    ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x172139);
  scene.add(new THREE.HemisphereLight(0xc9dcff, 0x202025, 2.3));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x73a6ff, 1.4);
  rim.position.set(-4, 3, -3);
  scene.add(rim);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 64),
    new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.94 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(28, 480 / 440, 0.01, 20);
  camera.position.set(0, 0.86, 3.7);
  camera.lookAt(0, 0.82, 0);

  const equipmentLoader = new GLTFLoader();
  const poseFactory = config.pose
    ? createEmoteFactory(
        await equipmentLoader.loadAsync(`/asset/${config.pose}`),
        config.pose,
      )
    : null;
  const applyReviewPose = (vrm: VRM) => {
    if (!poseFactory) return;
    const rawHips = vrm.humanoid.getRawBoneNode("hips");
    const rootToHips = rawHips?.getWorldPosition(new THREE.Vector3()).y ?? 1;
    const clip = poseFactory.toClip({
      rootToHips,
      version: vrm.meta?.metaVersion ?? "1",
      getBoneName: (boneName: string) =>
        vrm.humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName)?.name,
    });
    const mixer = new THREE.AnimationMixer(vrm.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(Math.min(clip.duration * 0.4, clip.duration - 0.001));
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
  };
  const loadedModels = new Map<string, GLTF>();
  for (const definition of Object.values(config.equipment)) {
    loadedModels.set(
      definition.itemId,
      await equipmentLoader.loadAsync(`/asset/${definition.asset}`),
    );
  }

  let avatar = await loadAvatar(config.avatar);
  const opponentAvatar = await loadAvatar(config.avatar);
  applyReviewPose(avatar.vrm);
  applyReviewPose(opponentAvatar.vrm);
  avatar.vrm.scene.position.x = -0.55;
  opponentAvatar.vrm.scene.position.x = 0.55;
  scene.add(avatar.vrm.scene, opponentAvatar.vrm.scene);
  const equipmentValidation = Object.values(config.equipment).map(
    (definition) => {
      const result = validateStreamingEquipmentVisualModel(
        loadedModels.get(definition.itemId)!.scene,
        definition.slot,
        {
          itemId: definition.itemId,
          avatarId: config.avatarId ?? "kaykit-knight",
          vrm: avatar.vrm,
        },
      );
      return {
        itemId: definition.itemId,
        slot: definition.slot,
        ...result,
      };
    },
  );
  const invalidEquipment = equipmentValidation.filter(
    (validation) => !validation.valid,
  );
  if (invalidEquipment.length > 0) {
    throw new Error(
      invalidEquipment
        .map(
          (validation) =>
            `${validation.itemId} (${validation.slot}): ${validation.reason}`,
        )
        .join("; "),
    );
  }
  const eventBus = new AuditEventBus();
  const transportRequests: TransportFaultAuditResult["requests"] = [];
  const configuredAvatarUrl = `asset://${config.avatar}`;
  const player = {
    id: "audit-player",
    avatarUrl: configuredAvatarUrl,
    data: {
      avatar: configuredAvatarUrl,
      e: "idle",
    },
    _avatar: { instance: { raw: avatar.raw } },
  };
  const opponent = {
    id: "audit-opponent",
    avatarUrl: configuredAvatarUrl,
    data: {
      avatar: configuredAvatarUrl,
      e: "idle",
    },
    _avatar: { instance: { raw: opponentAvatar.raw } },
  };
  const world = {
    isServer: false,
    $eventBus: eventBus,
    entities: new Map([
      [player.id, player],
      [opponent.id, opponent],
    ]),
    network: { connected: true },
    assetsUrl: `${window.location.origin}/transport-fault`,
    loader: {
      loadFile: async (url: string): Promise<File> => {
        const response = await fetch(url, { cache: "no-store" });
        transportRequests.push({
          url,
          status: response.status,
          ok: response.ok,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} loading ${url}`);
        }
        const bytes = await response.arrayBuffer();
        return new File([bytes], url.split("/").pop() ?? "equipment.glb", {
          type: response.headers.get("content-type") ?? "model/gltf-binary",
        });
      },
    },
  };
  const system = new EquipmentVisualSystem(world as never);
  await system.init();
  const internals = system as unknown as EquipmentVisualInternals;
  const productionLoadEquipmentModel =
    internals.loadEquipmentModel.bind(internals);
  internals.loadEquipmentModel = async (itemId) =>
    loadedModels.get(itemId) ?? null;

  const phases: PhaseResult[] = [];
  const twoContestantPhases: TwoContestantPhaseResult[] = [];
  const snapshotContestant = (
    target: typeof player,
    targetAvatar: typeof avatar,
    id: string,
    expectedVisible: readonly string[],
    expectedAttached: Record<string, string>,
    expectedAvatarMatch = true,
    expectedActiveGatheringToolItemId: string | null = null,
  ): ContestantPhaseSnapshot => {
    const visuals = internals.playerEquipment.get(target.id) ?? {};
    const visible = Object.fromEntries(
      ["weapon", "shield", "gatheringtool"].map((slot) => {
        const visual = visuals[slot as keyof EquipmentVisuals];
        return [
          slot,
          Boolean(
            visual?.visible && isDescendant(targetAvatar.vrm.scene, visual),
          ),
        ];
      }),
    );
    const underCurrentAvatar = Object.fromEntries(
      ["weapon", "shield", "gatheringtool"].map((slot) => {
        const visual = visuals[slot as keyof EquipmentVisuals];
        return [
          slot,
          Boolean(visual && isDescendant(targetAvatar.vrm.scene, visual)),
        ];
      }),
    );
    const attached = Object.fromEntries(
      internals.attachedEquipmentItemIds.get(target.id) ?? [],
    );
    const attachmentAvatarMatches =
      Object.keys(attached).length === 0 ||
      internals.attachedEquipmentAvatarVrms.get(target.id) === targetAvatar.vrm;
    const failures: string[] = [];
    const expectedVisibleSet = new Set(expectedVisible);
    for (const slot of Object.keys(visible)) {
      if (visible[slot] !== expectedVisibleSet.has(slot)) {
        failures.push(`${slot} visibility mismatch`);
      }
    }
    const attachedEntries = Object.entries(attached).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const expectedEntries = Object.entries(expectedAttached).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (JSON.stringify(attachedEntries) !== JSON.stringify(expectedEntries)) {
      failures.push("attached identity mismatch");
    }
    if (attachmentAvatarMatches !== expectedAvatarMatch) {
      failures.push("attachment avatar identity mismatch");
    }
    const activeGatheringToolItemId =
      internals.activeGatheringToolItemIds.get(target.id) ?? null;
    if (activeGatheringToolItemId !== expectedActiveGatheringToolItemId) {
      failures.push("active gathering-tool identity mismatch");
    }
    return {
      playerId: target.id,
      id,
      attached,
      activeGatheringToolItemId,
      visible,
      underCurrentAvatar,
      attachmentAvatarMatches,
      failures,
    };
  };
  const renderScene = () => {
    system.update(0);
    avatar.vrm.humanoid.update();
    opponentAvatar.vrm.humanoid.update();
    avatar.vrm.scene.updateMatrixWorld(true);
    opponentAvatar.vrm.scene.updateMatrixWorld(true);
    renderer.render(scene, camera);
    gl.finish();
  };
  const capture = (
    id: string,
    expectedVisible: readonly string[],
    expectedAttached: Record<string, string>,
    expectedAvatarMatch = true,
    expectedActiveGatheringToolItemId: string | null = null,
  ) => {
    renderScene();
    const { playerId: _playerId, ...phase } = snapshotContestant(
      player,
      avatar,
      id,
      expectedVisible,
      expectedAttached,
      expectedAvatarMatch,
      expectedActiveGatheringToolItemId,
    );
    phases.push(phase);
    addPhaseCard(id, rendererCanvas, phase);
    return phase;
  };
  const captureTwoContestants = (
    id: string,
    playerExpectation: {
      visible: readonly string[];
      attached: Record<string, string>;
      activeGatheringToolItemId?: string | null;
    },
    opponentExpectation: {
      visible: readonly string[];
      attached: Record<string, string>;
      activeGatheringToolItemId?: string | null;
    },
  ) => {
    renderScene();
    const contestants = [
      snapshotContestant(
        player,
        avatar,
        id,
        playerExpectation.visible,
        playerExpectation.attached,
        true,
        playerExpectation.activeGatheringToolItemId ?? null,
      ),
      snapshotContestant(
        opponent,
        opponentAvatar,
        id,
        opponentExpectation.visible,
        opponentExpectation.attached,
        true,
        opponentExpectation.activeGatheringToolItemId ?? null,
      ),
    ];
    const failures = contestants.flatMap((contestant) =>
      contestant.failures.map(
        (failure) => `${contestant.playerId}: ${failure}`,
      ),
    );
    const phase: TwoContestantPhaseResult = { id, contestants, failures };
    twoContestantPhases.push(phase);
    const visible = Object.fromEntries(
      contestants.flatMap((contestant) =>
        Object.entries(contestant.visible).map(([slot, isVisible]) => [
          `${contestant.playerId}:${slot}`,
          isVisible,
        ]),
      ),
    );
    addPhaseCard(id, rendererCanvas, {
      id,
      attached: {},
      activeGatheringToolItemId: null,
      visible,
      underCurrentAvatar: {},
      attachmentAvatarMatches: contestants.every(
        (contestant) => contestant.attachmentAvatarMatches,
      ),
      failures,
    });
    return phase;
  };

  const { weapon, shield, hatchet, pickaxe } = config.equipment;
  const combatDefinitions = [weapon, ...(shield ? [shield] : [])];
  await Promise.all(
    [player.id, opponent.id].flatMap((playerId) =>
      combatDefinitions.map((definition) =>
        internals.handleEquipmentChange({
          playerId,
          slot: definition.slot,
          itemId: definition.itemId,
        }),
      ),
    ),
  );
  const combatAttached = Object.fromEntries(
    combatDefinitions.map((definition) => [definition.slot, definition.itemId]),
  );
  const combatVisible = combatDefinitions.map((definition) => definition.slot);
  capture("Combat loadout", combatVisible, combatAttached);

  internals.loadEquipmentModel = async (itemId) =>
    itemId === hatchet.itemId ? null : (loadedModels.get(itemId) ?? null);
  await Promise.all([
    internals.handleGatheringToolShow({
      playerId: player.id,
      itemId: hatchet.itemId,
      slot: "weapon",
    }),
    internals.handleGatheringToolShow({
      playerId: opponent.id,
      itemId: pickaxe.itemId,
      slot: "weapon",
    }),
  ]);
  captureTwoContestants(
    "One missing tool fails closed independently",
    {
      visible: [],
      attached: combatAttached,
      activeGatheringToolItemId: hatchet.itemId,
    },
    {
      visible: ["gatheringtool"],
      attached: {
        ...combatAttached,
        gatheringtool: pickaxe.itemId,
      },
      activeGatheringToolItemId: pickaxe.itemId,
    },
  );
  internals.handleGatheringToolHide({
    playerId: player.id,
    slot: "weapon",
  });
  internals.handleGatheringToolHide({
    playerId: opponent.id,
    slot: "weapon",
  });
  captureTwoContestants(
    "Missing-tool isolation recovers both loadouts",
    { visible: combatVisible, attached: combatAttached },
    { visible: combatVisible, attached: combatAttached },
  );

  let releaseCancelledHatchet: ((model: GLTF | null) => void) | undefined;
  internals.loadEquipmentModel = (itemId) =>
    itemId === hatchet.itemId
      ? new Promise((resolve) => {
          releaseCancelledHatchet = resolve;
        })
      : Promise.resolve(loadedModels.get(itemId) ?? null);
  const cancelledHatchet = internals.handleGatheringToolShow({
    playerId: player.id,
    itemId: hatchet.itemId,
    slot: "weapon",
  });
  capture(
    "Slow tool suppresses stale combat",
    [],
    combatAttached,
    true,
    hatchet.itemId,
  );
  internals.handleGatheringToolHide({
    playerId: player.id,
    slot: "weapon",
  });
  capture("Cancelled slow load restores combat", combatVisible, combatAttached);
  releaseCancelledHatchet?.(loadedModels.get(hatchet.itemId) ?? null);
  await cancelledHatchet;
  capture("Cancelled late load stays discarded", combatVisible, combatAttached);

  let releaseSlowHatchet: ((model: GLTF | null) => void) | undefined;
  internals.loadEquipmentModel = (itemId) =>
    itemId === hatchet.itemId
      ? new Promise((resolve) => {
          releaseSlowHatchet = resolve;
        })
      : Promise.resolve(loadedModels.get(itemId) ?? null);
  const slowHatchet = internals.handleGatheringToolShow({
    playerId: player.id,
    itemId: hatchet.itemId,
    slot: "weapon",
  });
  await internals.handleGatheringToolShow({
    playerId: player.id,
    itemId: pickaxe.itemId,
    slot: "weapon",
  });
  capture(
    "Newest tool wins",
    ["gatheringtool"],
    {
      ...combatAttached,
      gatheringtool: pickaxe.itemId,
    },
    true,
    pickaxe.itemId,
  );
  releaseSlowHatchet?.(loadedModels.get(hatchet.itemId) ?? null);
  await slowHatchet;
  capture(
    "Late old load discarded",
    ["gatheringtool"],
    {
      ...combatAttached,
      gatheringtool: pickaxe.itemId,
    },
    true,
    pickaxe.itemId,
  );

  internals.handleGatheringToolHide({ playerId: player.id, slot: "weapon" });
  capture("Combat loadout restored", combatVisible, combatAttached);

  player.data.e = "death";
  capture("Death suppresses held visuals", [], combatAttached);
  player.data.e = "idle";
  capture("Idle restores held visuals", combatVisible, combatAttached);

  const oldAvatar = avatar;
  avatar = await loadAvatar(config.avatar);
  applyReviewPose(avatar.vrm);
  avatar.vrm.scene.position.x = -0.55;
  scene.remove(oldAvatar.vrm.scene);
  scene.add(avatar.vrm.scene);
  player._avatar.instance.raw = avatar.raw;
  capture("Replacement fails closed", [], combatAttached, false);
  eventBus.emitEvent(EventType.AVATAR_LOAD_COMPLETE, {
    playerId: player.id,
    success: true,
  });
  await waitFor(
    () =>
      internals.attachedEquipmentAvatarVrms.get(player.id) === avatar.vrm &&
      internals.attachedEquipmentItemIds.get(player.id)?.get("weapon") ===
        weapon.itemId &&
      (!shield ||
        internals.attachedEquipmentItemIds.get(player.id)?.get("shield") ===
          shield.itemId),
    "desired equipment to reattach to replacement avatar",
  );
  capture("Replacement reattached", combatVisible, combatAttached);

  internals.loadEquipmentModel = async (itemId) =>
    loadedModels.get(itemId) ?? null;
  const switchDurations: number[] = [];
  const rapidFailures: string[] = [];
  for (let index = 0; index < config.rapidSwitchIterations; index += 1) {
    const tool = index % 2 === 0 ? hatchet : pickaxe;
    const started = performance.now();
    await internals.handleGatheringToolShow({
      playerId: player.id,
      itemId: tool.itemId,
      slot: "weapon",
    });
    system.update(0);
    renderer.render(scene, camera);
    gl.finish();
    switchDurations.push(performance.now() - started);
    const visuals = internals.playerEquipment.get(player.id);
    if (
      internals.attachedEquipmentItemIds
        .get(player.id)
        ?.get("gatheringtool") !== tool.itemId ||
      visuals?.gatheringtool?.visible !== true ||
      visuals.weapon?.visible !== false ||
      (shield && visuals.shield?.visible !== false)
    ) {
      rapidFailures.push(`iteration ${index} exposed mixed equipment`);
    }
  }
  internals.handleGatheringToolHide({ playerId: player.id, slot: "weapon" });
  capture("Rapid-switch recovery", combatVisible, combatAttached);

  const twoContestantSwitchDurations: number[] = [];
  const twoContestantRapidFailures: string[] = [];
  for (let index = 0; index < config.rapidSwitchIterations; index += 1) {
    const playerTool = index % 2 === 0 ? hatchet : pickaxe;
    const opponentTool = index % 2 === 0 ? pickaxe : hatchet;
    const started = performance.now();
    await Promise.all([
      internals.handleGatheringToolShow({
        playerId: player.id,
        itemId: playerTool.itemId,
        slot: "weapon",
      }),
      internals.handleGatheringToolShow({
        playerId: opponent.id,
        itemId: opponentTool.itemId,
        slot: "weapon",
      }),
    ]);
    renderScene();
    twoContestantSwitchDurations.push(performance.now() - started);
    const playerVisuals = internals.playerEquipment.get(player.id);
    const opponentVisuals = internals.playerEquipment.get(opponent.id);
    const playerAttached = internals.attachedEquipmentItemIds.get(player.id);
    const opponentAttached = internals.attachedEquipmentItemIds.get(
      opponent.id,
    );
    if (
      playerAttached?.get("gatheringtool") !== playerTool.itemId ||
      opponentAttached?.get("gatheringtool") !== opponentTool.itemId ||
      playerVisuals?.gatheringtool?.visible !== true ||
      opponentVisuals?.gatheringtool?.visible !== true ||
      playerVisuals.weapon?.visible !== false ||
      opponentVisuals.weapon?.visible !== false ||
      (shield && playerVisuals.shield?.visible !== false) ||
      (shield && opponentVisuals.shield?.visible !== false) ||
      internals.attachedEquipmentAvatarVrms.get(player.id) !== avatar.vrm ||
      internals.attachedEquipmentAvatarVrms.get(opponent.id) !==
        opponentAvatar.vrm
    ) {
      twoContestantRapidFailures.push(
        `iteration ${index} exposed cross-contestant or mixed equipment`,
      );
    }
  }
  const finalPlayerTool =
    (config.rapidSwitchIterations - 1) % 2 === 0 ? hatchet : pickaxe;
  const finalOpponentTool =
    (config.rapidSwitchIterations - 1) % 2 === 0 ? pickaxe : hatchet;
  captureTwoContestants(
    "Two contestants switch independently",
    {
      visible: ["gatheringtool"],
      attached: {
        ...combatAttached,
        gatheringtool: finalPlayerTool.itemId,
      },
      activeGatheringToolItemId: finalPlayerTool.itemId,
    },
    {
      visible: ["gatheringtool"],
      attached: {
        ...combatAttached,
        gatheringtool: finalOpponentTool.itemId,
      },
      activeGatheringToolItemId: finalOpponentTool.itemId,
    },
  );
  internals.handleGatheringToolHide({
    playerId: player.id,
    slot: "weapon",
  });
  internals.handleGatheringToolHide({
    playerId: opponent.id,
    slot: "weapon",
  });
  captureTwoContestants(
    "Two contestants recover combat loadouts",
    { visible: combatVisible, attached: combatAttached },
    { visible: combatVisible, attached: combatAttached },
  );

  internals.loadEquipmentModel = productionLoadEquipmentModel;
  const transportFailures: string[] = [];
  const transportAvatar = await loadAvatar("/canonical/duel-steve.vrm");
  const transportPlayer = {
    id: "audit-transport-player",
    avatarUrl: "asset://avatars/duel-candidates/duel-steve.vrm",
    data: {
      avatar: "asset://avatars/duel-candidates/duel-steve.vrm",
      e: "idle",
    },
    _avatar: { instance: { raw: transportAvatar.raw } },
  };
  world.entities.set(transportPlayer.id, transportPlayer);
  const transportRequirement = {
    playerId: transportPlayer.id,
    itemId: "bronze_shortsword",
    slot: "weapon" as const,
  };
  system.setStreamingDuelEquipmentVisualContract({
    cycleId: "equipment-http-fault",
    requirements: [transportRequirement],
    currentEquipment: [],
  });
  await waitFor(
    () =>
      system.getStreamingDuelEquipmentVisualReadiness().unresolved[0]
        ?.status === "load_failed",
    "HTTP 503 to keep equipment readiness fail closed",
  );
  const failedReadiness = system.getStreamingDuelEquipmentVisualReadiness();
  system.setStreamingDuelEquipmentVisualContract({
    cycleId: "equipment-http-retry",
    requirements: [transportRequirement],
    currentEquipment: [],
  });
  await waitFor(
    () => system.getStreamingDuelEquipmentVisualReadiness().ready,
    "replacement cycle to retry and recover equipment readiness",
  );
  const recoveredReadiness = system.getStreamingDuelEquipmentVisualReadiness();
  const transportStatuses = transportRequests.map((request) => request.status);
  if (JSON.stringify(transportStatuses) !== JSON.stringify([503, 503, 200])) {
    transportFailures.push(
      `expected HTTP status sequence 503,503,200; received ${transportStatuses.join(",") || "none"}`,
    );
  }
  if (
    transportRequests[0]?.url !== transportRequests[2]?.url ||
    transportRequests[0]?.url === transportRequests[1]?.url
  ) {
    transportFailures.push(
      "replacement cycle did not retry the original primary URL after the distinct fallback failed",
    );
  }
  if (failedReadiness.ready || failedReadiness.readyCount !== 0) {
    transportFailures.push("HTTP 503 did not keep renderer readiness closed");
  }
  if (
    failedReadiness.unresolved[0]?.status !== "load_failed" ||
    recoveredReadiness.unresolved.length !== 0 ||
    !recoveredReadiness.ready ||
    recoveredReadiness.readyCount !== 1
  ) {
    transportFailures.push(
      "replacement cycle did not recover the exact equipment requirement",
    );
  }

  system.destroy();
  renderer.dispose();
  renderer.forceContextLoss();
  const failures = [
    ...phases.flatMap((phase) =>
      phase.failures.map((failure) => `${phase.id}: ${failure}`),
    ),
    ...rapidFailures,
    ...twoContestantPhases.flatMap((phase) =>
      phase.failures.map((failure) => `${phase.id}: ${failure}`),
    ),
    ...twoContestantRapidFailures,
    ...transportFailures,
  ];
  return {
    renderer: rendererName,
    userAgent: navigator.userAgent,
    phases,
    twoContestantPhases,
    rapidSwitch: {
      iterations: config.rapidSwitchIterations,
      samples: switchDurations.length,
      p50Ms: rounded(percentile(switchDurations, 0.5)),
      p95Ms: rounded(percentile(switchDurations, 0.95)),
      p99Ms: rounded(percentile(switchDurations, 0.99)),
      maxMs: rounded(Math.max(0, ...switchDurations)),
      over50Ms: switchDurations.filter((duration) => duration > 50).length,
      failures: rapidFailures,
    },
    twoContestantRapidSwitch: {
      iterations: config.rapidSwitchIterations,
      samples: twoContestantSwitchDurations.length,
      p50Ms: rounded(percentile(twoContestantSwitchDurations, 0.5)),
      p95Ms: rounded(percentile(twoContestantSwitchDurations, 0.95)),
      p99Ms: rounded(percentile(twoContestantSwitchDurations, 0.99)),
      maxMs: rounded(Math.max(0, ...twoContestantSwitchDurations)),
      over50Ms: twoContestantSwitchDurations.filter((duration) => duration > 50)
        .length,
      failures: twoContestantRapidFailures,
    },
    transportFault: {
      requests: transportRequests,
      failedCycle: {
        ready: failedReadiness.ready,
        status: failedReadiness.unresolved[0]?.status ?? null,
      },
      recoveredCycle: {
        ready: recoveredReadiness.ready,
        status: recoveredReadiness.unresolved[0]?.status ?? null,
      },
      failures: transportFailures,
    },
    equipmentValidation,
    failures,
  };
}
