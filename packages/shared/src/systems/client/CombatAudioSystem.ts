import type { World, WorldOptions } from "../../types";
import { AttackType } from "../../types/game/item-types";
import { EventType } from "../../types/events";
import { System } from "../shared/infrastructure/System";
import type { ClientAudio } from "./ClientAudio";
import type { ClientLoader } from "./ClientLoader";

export const MELEE_IMPACT_AUDIO_PATHS = Object.freeze([
  "asset://audio/soundeffects/sword-clash-001.mp3",
  "asset://audio/soundeffects/sword-clash-002.mp3",
  "asset://audio/soundeffects/sword-clash-003.mp3",
  "asset://audio/soundeffects/sword-clash-004.mp3",
  "asset://audio/soundeffects/sword-clash-005.mp3",
  "asset://audio/soundeffects/sword-clash-006.mp3",
]);

type ImpactPosition = { x: number; y: number; z: number };

type CombatDamageAudioPayload = {
  attackerId: string;
  targetId: string;
  damage: number;
  attackType?: AttackType;
  position?: ImpactPosition;
  tick?: number;
};

type ActiveImpact = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: PannerNode;
};

export type CombatAudioStatus = {
  ready: boolean;
  loadedImpactVariants: number;
  totalImpactVariants: number;
  failedImpactVariants: readonly string[];
  activeImpacts: number;
};

const MAX_ACTIVE_IMPACTS = 8;

function hashImpact(payload: CombatDamageAudioPayload): number {
  const value = `${payload.attackerId}|${payload.targetId}|${payload.damage}|${payload.tick ?? 0}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectMeleeImpactVariant(
  payload: CombatDamageAudioPayload,
  variantCount: number,
): number | null {
  if (variantCount <= 0 || !Number.isInteger(variantCount)) return null;
  return hashImpact(payload) % variantCount;
}

/**
 * Plays authoritative combat impact audio. The first launch slice intentionally
 * handles only successful melee hits because those are the only matching local
 * effects currently available; ranged and magic hits must never sound like a
 * sword strike.
 */
export class CombatAudioSystem extends System {
  readonly name = "combat-audio";

  private audio: ClientAudio | null = null;
  private loader: ClientLoader | null = null;
  private impactBuffers: AudioBuffer[] = [];
  private failedImpactVariants: string[] = [];
  private activeImpacts: ActiveImpact[] = [];
  private loadGeneration = 0;
  private boundDamageHandler: ((data: unknown) => void) | null = null;

  getDependencies() {
    return { required: ["audio", "loader"] };
  }

  async init(options: WorldOptions): Promise<void> {
    await super.init(options);
    if (!this.world.isClient) return;

    this.audio = this.world.audio as ClientAudio;
    this.loader = this.world.loader as ClientLoader;
    this.boundDamageHandler = (data: unknown) => {
      this.onDamageDealt(data as CombatDamageAudioPayload);
    };
    this.world.on(EventType.COMBAT_DAMAGE_DEALT, this.boundDamageHandler, this);

    const generation = ++this.loadGeneration;
    const results = await Promise.allSettled(
      MELEE_IMPACT_AUDIO_PATHS.map((path) => this.loader!.load("audio", path)),
    );
    if (generation !== this.loadGeneration) return;

    const buffers: AudioBuffer[] = [];
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        buffers.push(result.value as AudioBuffer);
      } else {
        failures.push(MELEE_IMPACT_AUDIO_PATHS[index]!);
      }
    });
    this.impactBuffers = buffers;
    this.failedImpactVariants = failures;

    if (failures.length > 0) {
      console.warn(
        `[CombatAudioSystem] Failed to preload ${failures.length}/${MELEE_IMPACT_AUDIO_PATHS.length} melee impact variants`,
      );
    }
  }

  getStatus(): CombatAudioStatus {
    return {
      ready:
        this.impactBuffers.length === MELEE_IMPACT_AUDIO_PATHS.length &&
        this.failedImpactVariants.length === 0,
      loadedImpactVariants: this.impactBuffers.length,
      totalImpactVariants: MELEE_IMPACT_AUDIO_PATHS.length,
      failedImpactVariants: [...this.failedImpactVariants],
      activeImpacts: this.activeImpacts.length,
    };
  }

  private onDamageDealt(payload: CombatDamageAudioPayload): void {
    if (!Number.isFinite(payload.damage) || payload.damage <= 0) return;
    if (
      payload.attackType !== undefined &&
      payload.attackType !== AttackType.MELEE
    ) {
      return;
    }
    if (!this.audio || this.audio.ctx.state !== "running") return;

    const variantIndex = selectMeleeImpactVariant(
      payload,
      this.impactBuffers.length,
    );
    if (variantIndex === null) return;

    const position =
      payload.position ?? this.resolveTargetPosition(payload.targetId);
    if (!position) return;

    while (this.activeImpacts.length >= MAX_ACTIVE_IMPACTS) {
      this.stopImpact(this.activeImpacts[0]!);
    }

    const source = this.audio.ctx.createBufferSource();
    const gain = this.audio.ctx.createGain();
    const panner = this.audio.ctx.createPanner();
    const variation = (hashImpact(payload) % 9) - 4;

    source.buffer = this.impactBuffers[variantIndex]!;
    source.playbackRate.value = 1 + variation * 0.01;
    gain.gain.value = Math.min(0.7, 0.42 + payload.damage * 0.015);
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 2;
    panner.maxDistance = 40;
    panner.rolloffFactor = 1;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;

    const impact: ActiveImpact = { source, gain, panner };
    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.audio.groupGains.sfx);
    source.onended = () => this.releaseImpact(impact);
    this.activeImpacts.push(impact);
    source.start(0);
  }

  private resolveTargetPosition(targetId: string): ImpactPosition | null {
    const target = this.world.entities.get(targetId) as
      { position?: ImpactPosition } | undefined;
    const position = target?.position;
    if (
      !position ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return null;
    }
    return { x: position.x, y: position.y, z: position.z };
  }

  private releaseImpact(impact: ActiveImpact): void {
    const index = this.activeImpacts.indexOf(impact);
    if (index >= 0) this.activeImpacts.splice(index, 1);
    impact.source.onended = null;
    impact.source.disconnect();
    impact.gain.disconnect();
    impact.panner.disconnect();
  }

  private stopImpact(impact: ActiveImpact): void {
    try {
      impact.source.stop();
    } catch {
      // The source may already have ended between capacity check and cleanup.
    }
    this.releaseImpact(impact);
  }

  destroy(): void {
    this.loadGeneration++;
    if (this.boundDamageHandler) {
      this.world.off(EventType.COMBAT_DAMAGE_DEALT, this.boundDamageHandler);
      this.boundDamageHandler = null;
    }
    while (this.activeImpacts.length > 0) {
      this.stopImpact(this.activeImpacts[0]!);
    }
    this.impactBuffers = [];
    this.failedImpactVariants = [];
    this.audio = null;
    this.loader = null;
    super.destroy();
  }
}
