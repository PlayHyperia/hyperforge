/**
 * Avatar.ts - VRM Avatar Node
 *
 * Manages VRM character models with animations and bone transforms.
 */

import type { HotReloadable } from "../types";
import type {
  AvatarHooks,
  AvatarData,
  VRMAvatarInstance,
  VRMAvatarFactory,
} from "../types/rendering/nodes";
import * as THREE from "../extras/three/three";
import { Node } from "./Node";
import { Emotes } from "../data/playerEmotes";

const defaults = {
  src: null,
  emote: Emotes.IDLE,
  onLoad: null,
};

const v1 = new THREE.Vector3();

export class Avatar extends Node {
  factory: VRMAvatarFactory | null = null;
  hooks: AvatarHooks | null = null;
  instance: VRMAvatarInstance | null = null;
  n: number;
  needsRebuild: boolean = false;
  private _src: string | null = null;
  private _emote: string | null = null;
  private _onLoad: Function | null = null;
  private _disableRateCheck: boolean = false;

  constructor(data: AvatarData = {}) {
    super(data);
    this.name = "avatar";

    this._src = data.src ?? defaults.src;
    this._emote = data.emote ?? defaults.emote;
    this._onLoad = data.onLoad ?? defaults.onLoad;

    this.factory = data.factory ?? null;
    this.hooks = data.hooks ?? null;
    this.n = 0;
  }

  async mount() {
    this.needsRebuild = false;
    if (this._src && this.ctx?.loader) {
      const n = ++this.n;
      let avatar = this.ctx.loader.get("avatar", this._src);
      if (!avatar) {
        avatar = await this.ctx.loader.load("avatar", this._src);
      }
      if (this.n !== n) return;
      // Avatar loaded from loader is a different type - use type assertion based on context
      const avatarData = avatar as {
        factory?: VRMAvatarFactory;
        hooks?: AvatarHooks;
      };
      this.factory = avatarData?.factory ?? null;
      // Only update hooks from avatarData if we don't have any hooks at all
      // This preserves hooks that were manually set on this node
      if (!this.hooks) {
        this.hooks = avatarData?.hooks ?? null;
      }
    }
    if (this.factory) {
      // Only create instance if we don't already have one
      if (!this.instance) {
        const _vrmHooks = this.hooks as unknown as {
          scene?: unknown;
          octree?: unknown;
          [key: string]: unknown;
        };

        // CRITICAL: Update matrix before passing to factory
        // The avatar node needs its world transform updated to match its parent
        this.updateTransform();
        const worldPos = v1;
        worldPos.setFromMatrixPosition(this.matrixWorld);

        // Factory has typed create(matrix, hooks, node)
        this.instance = this.factory.create(
          this.matrixWorld,
          this.hooks ?? undefined,
          this,
        );
        this.instance?.setEmote(this._emote);
        if (this._disableRateCheck && this.instance) {
          this.instance.disableRateCheck();
          this._disableRateCheck = false;
        }
        // Only register as hot if instance implements HotReloadable
        const maybeHot = this.instance as Partial<HotReloadable> | null;
        if (
          this.ctx &&
          maybeHot?.update &&
          maybeHot?.fixedUpdate &&
          maybeHot?.postLateUpdate
        ) {
          this.ctx.setHot(maybeHot as HotReloadable, true);
        }

        const instanceWithRaw = this.instance as unknown as {
          raw?: { scene?: THREE.Object3D };
        };
        if (instanceWithRaw?.raw?.scene && this.ctx?.stage?.scene) {
          const avatarScene = instanceWithRaw.raw.scene;
          if (!avatarScene.parent) {
            console.warn(
              "[Avatar] Avatar scene has no parent! Manually adding to world.stage.scene",
            );
            this.ctx.stage.scene.add(avatarScene);
          }
        }

        this._onLoad?.();
      } else {
        // Just update the existing instance
        this.instance?.move(this.matrixWorld);
      }
    }
  }

  commit(didMove: boolean) {
    if (this.needsRebuild) {
      this.unmount();
      this.mount();
    }
    if (didMove) {
      this.instance?.move(this.matrixWorld);
    }
  }

  unmount() {
    this.n++;
    if (this.instance) {
      const maybeHot = this.instance as Partial<HotReloadable>;
      if (
        this.ctx &&
        maybeHot.update &&
        maybeHot.fixedUpdate &&
        maybeHot.postLateUpdate
      ) {
        this.ctx.setHot(maybeHot as HotReloadable, false);
      }
      this.instance.destroy();
      this.instance = null;
    }
  }

  applyStats(stats: {
    meshes?: number;
    materials?: number;
    textures?: number;
  }) {
    // Factory may have applyStats method - using type assertion based on usage context
    const factoryWithStats = this.factory as {
      applyStats?: (stats: unknown) => void;
    };
    if (factoryWithStats?.applyStats) {
      factoryWithStats.applyStats(stats);
    }
  }

  get src() {
    return this._src;
  }

  set src(value: string | null) {
    if (!value) value = defaults.src;

    if (this._src === value) return;
    this._src = value;
    this.needsRebuild = true;
    this.setDirty();
  }

  get emote() {
    return this._emote;
  }

  set emote(value: string | null) {
    if (!value) value = defaults.emote;
    if (this._emote === value) return;
    // DEBUG: Log death emote setting
    if (value?.includes("death")) {
      console.log(`[Avatar] Setting death emote:`, {
        oldEmote: this._emote,
        newEmote: value,
        hasInstance: !!this.instance,
        instanceType: this.instance?.constructor?.name,
      });
    }
    this._emote = value;
    this.instance?.setEmote(value);
    // DEBUG: Confirm setEmote was called
    if (value?.includes("death")) {
      console.log(`[Avatar] After setEmote call, instance:`, !!this.instance);
    }
  }

  get onLoad() {
    return this._onLoad;
  }

  set onLoad(value: Function | null) {
    this._onLoad = value;
  }

  getHeight(): number | null {
    return this.instance?.height ?? null;
  }

  getHeadToHeight(): number | null {
    return this.instance?.headToHeight ?? null;
  }

  getBoneTransform(boneName: string): THREE.Matrix4 | null {
    return this.instance?.getBoneTransform(boneName) ?? null;
  }

  disableRateCheck() {
    if (this.instance) {
      this.instance.disableRateCheck();
    } else {
      this._disableRateCheck = true;
    }
  }

  setEmote(url: string | null, startTimeSeconds?: number) {
    // The explicit method remains necessary for authoritative phase seeking;
    // the property setter intentionally represents an ordinary frame-zero
    // emote change.
    if (startTimeSeconds === undefined) {
      this.emote = url;
      return;
    }
    const normalizedUrl = url || defaults.emote;
    this._emote = normalizedUrl;
    this.instance?.setEmote(normalizedUrl, startTimeSeconds);
  }

  triggerHitReaction(intensity = 1, side: -1 | 1 = 1) {
    this.instance?.triggerHitReaction(intensity, side);
  }

  clearHitReaction() {
    this.instance?.clearHitReaction();
  }

  get height() {
    // DEPRECATED: use .getHeight()
    return this.getHeight();
  }

  copy(source: Avatar, recursive?: boolean) {
    super.copy(source, recursive);
    this._src = source._src;
    this._emote = source._emote;
    this._onLoad = source._onLoad;

    this.factory = source.factory;
    this.hooks = source.hooks;
    return this;
  }

  getProxy() {
    if (!this.proxy) {
      const self = this;
      let proxy = {
        get src() {
          return self.src;
        },
        set src(value: string | null) {
          self.src = value;
        },
        get emote() {
          return self.emote;
        },
        set emote(value: string | null) {
          self.emote = value;
        },
        get onLoad() {
          return self.onLoad;
        },
        set onLoad(value: Function | null) {
          self.onLoad = value;
        },
        getHeight() {
          return self.getHeight();
        },
        getHeadToHeight() {
          return self.getHeadToHeight();
        },
        getBoneTransform(boneName: string) {
          return self.getBoneTransform(boneName);
        },
        setEmote(url: string | null, startTimeSeconds?: number) {
          // DEPRECATED: use .emote
          return self.setEmote(url, startTimeSeconds);
        },
        triggerHitReaction(intensity?: number, side?: -1 | 1) {
          return self.triggerHitReaction(intensity, side);
        },
        clearHitReaction() {
          return self.clearHitReaction();
        },
        get height() {
          // DEPRECATED: use .getHeight()
          return self.height;
        },
      };
      proxy = Object.defineProperties(
        proxy,
        Object.getOwnPropertyDescriptors(super.getProxy()),
      ); // inherit Node properties
      this.proxy = proxy;
    }
    return this.proxy;
  }
}
