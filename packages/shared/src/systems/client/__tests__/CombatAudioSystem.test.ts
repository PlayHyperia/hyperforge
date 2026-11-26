import { beforeEach, describe, expect, it, vi } from "vitest";

import { AttackType } from "../../../types/game/item-types";
import { EventType } from "../../../types/events";
import {
  CombatAudioSystem,
  MELEE_IMPACT_AUDIO_PATHS,
  selectMeleeImpactVariant,
} from "../CombatAudioSystem";

type FakeSource = {
  buffer: AudioBuffer | null;
  playbackRate: { value: number };
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type FakeGain = {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type FakePanner = {
  panningModel: PanningModelType;
  distanceModel: DistanceModelType;
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  positionX: { value: number };
  positionY: { value: number };
  positionZ: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function createHarness(params?: {
  contextState?: AudioContextState;
  load?: (path: string) => Promise<AudioBuffer>;
}) {
  let damageHandler: ((data: unknown) => void) | null = null;
  const sources: FakeSource[] = [];
  const gains: FakeGain[] = [];
  const panners: FakePanner[] = [];
  const buffers = MELEE_IMPACT_AUDIO_PATHS.map(
    (path) => ({ path }) as unknown as AudioBuffer,
  );
  const load = vi.fn((type: string, path: string) => {
    expect(type).toBe("audio");
    if (params?.load) return params.load(path);
    const index = MELEE_IMPACT_AUDIO_PATHS.indexOf(path);
    return Promise.resolve(buffers[index]!);
  });
  const sfxDestination = { id: "sfx" };
  const audio = {
    ctx: {
      state: params?.contextState ?? "running",
      createBufferSource: vi.fn(() => {
        const source: FakeSource = {
          buffer: null,
          playbackRate: { value: 1 },
          onended: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        sources.push(source);
        return source;
      }),
      createGain: vi.fn(() => {
        const gain: FakeGain = {
          gain: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gains.push(gain);
        return gain;
      }),
      createPanner: vi.fn(() => {
        const panner: FakePanner = {
          panningModel: "equalpower",
          distanceModel: "linear",
          refDistance: 1,
          maxDistance: 10_000,
          rolloffFactor: 1,
          positionX: { value: 0 },
          positionY: { value: 0 },
          positionZ: { value: 0 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        panners.push(panner);
        return panner;
      }),
    },
    groupGains: { sfx: sfxDestination },
  };
  const world = {
    isClient: true,
    audio,
    loader: { load },
    entities: {
      get: vi.fn(() => ({ position: { x: 7, y: 2, z: 9 } })),
    },
    on: vi.fn((event: EventType, handler: (data: unknown) => void) => {
      if (event === EventType.COMBAT_DAMAGE_DEALT) damageHandler = handler;
    }),
    off: vi.fn(),
  };
  const system = new CombatAudioSystem(world as never);

  return {
    system,
    world,
    load,
    sources,
    gains,
    panners,
    buffers,
    emitDamage(data: unknown) {
      if (!damageHandler) throw new Error("damage handler not registered");
      damageHandler(data);
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("CombatAudioSystem", () => {
  it("preloads every melee impact variant before reporting ready", async () => {
    const harness = createHarness();

    await harness.system.init({} as never);

    expect(harness.load).toHaveBeenCalledTimes(MELEE_IMPACT_AUDIO_PATHS.length);
    expect(harness.system.getStatus()).toEqual({
      ready: true,
      loadedImpactVariants: MELEE_IMPACT_AUDIO_PATHS.length,
      totalImpactVariants: MELEE_IMPACT_AUDIO_PATHS.length,
      failedImpactVariants: [],
      activeImpacts: 0,
    });
  });

  it("plays a bounded positional SFX node graph for an authoritative melee hit", async () => {
    const harness = createHarness();
    await harness.system.init({} as never);

    const payload = {
      attackerId: "fighter-a",
      targetId: "fighter-b",
      damage: 12,
      attackType: AttackType.MELEE,
      position: { x: 3, y: 4, z: 5 },
      tick: 40,
    };
    harness.emitDamage(payload);

    const variant = selectMeleeImpactVariant(
      payload,
      MELEE_IMPACT_AUDIO_PATHS.length,
    );
    expect(variant).not.toBeNull();
    expect(harness.sources).toHaveLength(1);
    expect(harness.sources[0]!.buffer).toBe(harness.buffers[variant!]);
    expect(harness.sources[0]!.start).toHaveBeenCalledWith(0);
    expect(harness.sources[0]!.connect).toHaveBeenCalledWith(harness.gains[0]);
    expect(harness.gains[0]!.connect).toHaveBeenCalledWith(harness.panners[0]);
    expect(harness.panners[0]!.connect).toHaveBeenCalledWith(
      harness.world.audio.groupGains.sfx,
    );
    expect(harness.panners[0]!.panningModel).toBe("HRTF");
    expect(harness.panners[0]!.positionX.value).toBe(3);
    expect(harness.panners[0]!.positionY.value).toBe(4);
    expect(harness.panners[0]!.positionZ.value).toBe(5);
    expect(harness.system.getStatus().activeImpacts).toBe(1);

    harness.sources[0]!.onended?.();
    expect(harness.system.getStatus().activeImpacts).toBe(0);
    expect(harness.sources[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it("uses the live target position for legacy melee packets without a position or style", async () => {
    const harness = createHarness();
    await harness.system.init({} as never);

    harness.emitDamage({
      attackerId: "fighter-a",
      targetId: "fighter-b",
      damage: 3,
      tick: 41,
    });

    expect(harness.world.entities.get).toHaveBeenCalledWith("fighter-b");
    expect(harness.panners[0]!.positionX.value).toBe(7);
    expect(harness.panners[0]!.positionY.value).toBe(2);
    expect(harness.panners[0]!.positionZ.value).toBe(9);
  });

  it("does not misrepresent misses or ranged and magic impacts as sword strikes", async () => {
    const harness = createHarness();
    await harness.system.init({} as never);

    for (const payload of [
      {
        attackerId: "a",
        targetId: "b",
        damage: 0,
        attackType: AttackType.MELEE,
      },
      {
        attackerId: "a",
        targetId: "b",
        damage: 4,
        attackType: AttackType.RANGED,
      },
      {
        attackerId: "a",
        targetId: "b",
        damage: 4,
        attackType: AttackType.MAGIC,
      },
    ]) {
      harness.emitDamage(payload);
    }

    expect(harness.sources).toHaveLength(0);
  });

  it("drops stale audio while suspended and caps overlapping impact sources", async () => {
    const suspended = createHarness({ contextState: "suspended" });
    await suspended.system.init({} as never);
    suspended.emitDamage({
      attackerId: "a",
      targetId: "b",
      damage: 4,
    });
    expect(suspended.sources).toHaveLength(0);

    const active = createHarness();
    await active.system.init({} as never);
    for (let tick = 1; tick <= 9; tick++) {
      active.emitDamage({
        attackerId: "a",
        targetId: "b",
        damage: 4,
        tick,
      });
    }
    expect(active.sources).toHaveLength(9);
    expect(active.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(active.system.getStatus().activeImpacts).toBe(8);
  });

  it("cannot repopulate buffers after destruction during preload", async () => {
    const pending: Array<(buffer: AudioBuffer) => void> = [];
    const harness = createHarness({
      load: () =>
        new Promise<AudioBuffer>((resolve) => {
          pending.push(resolve);
        }),
    });
    const initialization = harness.system.init({} as never);
    await Promise.resolve();
    expect(pending).toHaveLength(MELEE_IMPACT_AUDIO_PATHS.length);

    harness.system.destroy();
    pending.forEach((resolve, index) => resolve(harness.buffers[index]!));
    await initialization;

    expect(harness.system.getStatus().loadedImpactVariants).toBe(0);
    expect(harness.world.off).toHaveBeenCalledWith(
      EventType.COMBAT_DAMAGE_DEALT,
      expect.any(Function),
    );
  });
});
