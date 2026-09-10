/**
 * PlayerAvatarController - VRM Avatar Loading and Management
 *
 * Handles all avatar-related logic:
 * - VRM model loading from loader system
 * - Avatar node mounting and scene graph integration
 * - Emote mapping (symbolic names to asset URLs)
 * - Bubble/aura positioning from bone transforms
 * - Avatar URL management and caching
 * - Avatar retry mechanism
 *
 * Extracted from PlayerLocal.ts to reduce file size.
 *
 * @public
 */

import * as THREE from "../../extras/three/three";
import {
  Emotes,
  GATHERING_PRESENTATION_EMOTE_URLS,
} from "../../data/playerEmotes";
import { DEFAULT_AVATAR_URL } from "../../data/avatars";
import { EventType } from "../../types/events";
import type { ClientLoader, LoadedAvatar } from "../../types/index";
import type { VRMHooks } from "../../types/systems/physics";
import type { World } from "../../core/World";

interface AvatarInstance {
  destroy(): void;
  move(matrix: THREE.Matrix4): void;
  update(delta: number): void;
  raw: {
    scene: THREE.Object3D;
  };
  disableRateCheck?: () => void;
  height?: number;
  setEmote?: (emote: string) => void;
}

interface AvatarNode {
  instance: AvatarInstance | null;
  mount?: () => Promise<void>;
  position: THREE.Vector3;
  visible: boolean;
  emote?: string;
  setEmote?: (emote: string) => void;
  ctx: World;
  parent: { matrixWorld: THREE.Matrix4 };
  activate(world: World): void;
  getHeight?: () => number;
  getHeadToHeight?: () => number;
  getBoneTransform?: (boneName: string) => THREE.Matrix4 | null;
  deactivate?: () => void;
  height?: number;
}

interface AvatarNodeInternal {
  ctx: World;
  hooks: VRMHooks;
}

/**
 * Emote name to asset URL mapping.
 * Used when server sends symbolic emote names via modify().
 */
const EMOTE_MAP: Record<string, string> = {
  idle: Emotes.IDLE,
  walk: Emotes.WALK,
  run: Emotes.RUN,
  combat: Emotes.COMBAT,
  sword_swing: Emotes.SWORD_SWING,
  "2h_idle": Emotes.TWO_HAND_IDLE,
  "2h_slash": Emotes.TWO_HAND_SLASH,
  range: Emotes.RANGE,
  spell_cast: Emotes.SPELL_CAST,
  ...GATHERING_PRESENTATION_EMOTE_URLS,
  death: Emotes.DEATH,
  squat: Emotes.SQUAT, // Used for firemaking and cooking
  victory: Emotes.VICTORY, // Victory celebration (waving)
};

/**
 * Context interface that PlayerLocal must satisfy for the avatar controller.
 */
export interface AvatarControllerContext {
  readonly world: World;
  readonly data: {
    id: string;
    sessionAvatar?: string;
    avatar?: string;
    [key: string]: unknown;
  };
  readonly id: string;
  base?: THREE.Group;
  camHeight: number;
  avatarUrl?: string;
}

export class PlayerAvatarController {
  private ctx: AvatarControllerContext;

  /** Internal avatar node reference */
  private _avatar?: AvatarNode;
  private loadingAvatarUrl?: string;
  private avatarRetryInterval: NodeJS.Timeout | null = null;

  constructor(ctx: AvatarControllerContext) {
    this.ctx = ctx;
  }

  /** Get the current avatar node (for external access) */
  get avatarNode(): AvatarNode | undefined {
    return this._avatar;
  }

  /**
   * Get the avatar URL from session or data, falling back to default.
   */
  getAvatarUrl(): string {
    return (
      (this.ctx.data.sessionAvatar as string) ||
      (this.ctx.data.avatar as string) ||
      DEFAULT_AVATAR_URL
    );
  }

  /**
   * Load and apply the VRM avatar.
   * Handles caching, scene graph integration, and event emission.
   *
   * @param bubbleUI - Reference to the bubble UI node for head positioning
   */
  async applyAvatar(
    bubbleUI: { position: THREE.Vector3 } | null,
  ): Promise<void> {
    const ctx = this.ctx;
    const avatarUrl = this.getAvatarUrl();

    // Skip avatar loading on server (no loader system)
    if (!ctx.world.loader) {
      return;
    }

    // If we already have the correct avatar loaded, just reuse it
    if (ctx.avatarUrl === avatarUrl && this._avatar) {
      return;
    }

    // Clear retry interval if it exists since loader is now available
    if (this.avatarRetryInterval) {
      clearInterval(this.avatarRetryInterval);
      this.avatarRetryInterval = null;
    }

    // Prevent concurrent loads for the same URL
    if (this.loadingAvatarUrl === avatarUrl) {
      return;
    }
    this.loadingAvatarUrl = avatarUrl;

    // Only destroy if we're loading a different avatar
    if (this._avatar && ctx.avatarUrl !== avatarUrl) {
      const oldInstance = (this._avatar as AvatarNode).instance;
      if (oldInstance && oldInstance.destroy) {
        oldInstance.destroy();
      }
      this._avatar = undefined;
    }

    // Only clear cache if we're loading a different avatar URL
    if (ctx.avatarUrl !== avatarUrl) {
      const loader = ctx.world.loader as ClientLoader;
      if (loader) {
        const oldKey = `avatar/${ctx.avatarUrl}`;
        if (loader.promises.has(oldKey)) {
          loader.promises.delete(oldKey);
          loader.results.delete(oldKey);
        }
      }
    }

    const src = (await ctx.world.loader!.load(
      "avatar",
      avatarUrl,
    )) as LoadedAvatar;

    if (this._avatar && this._avatar.deactivate) {
      this._avatar.deactivate();
    }

    // Pass VRM hooks so the avatar can add itself to the scene
    const vrmHooks = {
      scene: ctx.world.stage.scene,
      octree: ctx.world.stage.octree,
      camera: ctx.world.camera,
      loader: ctx.world.loader,
    };
    const nodeMap = src.toNodes(vrmHooks);

    const rootNode = nodeMap.get("root");
    if (!rootNode) {
      throw new Error(
        `No root node found in loaded asset. Available keys: ${Array.from(nodeMap.keys())}`,
      );
    }

    const avatarNode = nodeMap.get("avatar") || rootNode;
    const nodeToUse = avatarNode;

    this._avatar = nodeToUse as unknown as AvatarNode;

    const avatarAsNode = nodeToUse as unknown as AvatarNode &
      AvatarNodeInternal;
    avatarAsNode.ctx = ctx.world;

    const vrmHooksTyped: VRMHooks = {
      scene: vrmHooks.scene,
      octree: vrmHooks.octree as VRMHooks["octree"],
      camera: vrmHooks.camera,
      loader: vrmHooks.loader,
    };
    avatarAsNode.hooks = vrmHooksTyped;

    ctx.base!.updateMatrix();
    ctx.base!.updateMatrixWorld(true);

    avatarAsNode.parent = { matrixWorld: ctx.base!.matrixWorld };
    avatarAsNode.position.set(0, 0, 0);

    avatarAsNode.activate!(ctx.world);
    await avatarAsNode.mount!();

    const instance = (nodeToUse as unknown as AvatarNode).instance;

    if (instance?.disableRateCheck) {
      instance.disableRateCheck();
    }

    // Set up bubble positioning
    const headHeight = this._avatar!.getHeadToHeight!()!;
    const safeHeadHeight = headHeight ?? 1.8;
    if (bubbleUI) {
      bubbleUI.position.y = safeHeadHeight + 0.2;
    }

    // Set camera height
    const avatarHeight = (this._avatar as AvatarNode).height ?? 1.5;
    ctx.camHeight = Math.max(1.2, avatarHeight * 0.9);

    // Make avatar visible and ensure proper positioning
    (this._avatar as { visible: boolean }).visible = true;
    (this._avatar as AvatarNode).position.set(0, 0, 0);

    // Verify avatar instance is actually in the scene graph
    const vrmInstance = (this._avatar as AvatarNode).instance;
    let parent = vrmInstance!.raw.scene.parent;
    let depth = 0;
    while (parent && depth < 10) {
      if (parent === ctx.world.stage.scene) {
        break;
      }
      parent = parent.parent;
      depth++;
    }
    if (!parent || parent !== ctx.world.stage.scene) {
      throw new Error(
        "[PlayerLocal] Avatar VRM scene NOT in world scene graph!",
      );
    }

    ctx.avatarUrl = avatarUrl;

    // Emit avatar ready event for camera system
    ctx.world.emit(EventType.PLAYER_AVATAR_READY, {
      playerId: ctx.data.id,
      avatar: this._avatar,
      camHeight: ctx.camHeight,
    });

    // Ensure avatar starts at ground height (0) if terrain height is unavailable
    if ((this._avatar as AvatarNode).position.y < 0) {
      (this._avatar as AvatarNode).position.y = 0;
    }

    this.loadingAvatarUrl = undefined;

    return;
  }

  /**
   * Apply an emote to the current avatar.
   * Maps symbolic emote names to asset URLs.
   */
  applyEmote(emoteName: string): void {
    if (!this._avatar) return;

    const avatarNode = this._avatar as AvatarNode;
    const emoteUrl = EMOTE_MAP[emoteName] || Emotes.IDLE;

    if (avatarNode.setEmote) {
      avatarNode.setEmote(emoteUrl);
    } else if (avatarNode.emote !== undefined) {
      avatarNode.emote = emoteUrl;
    }
  }

  /**
   * Apply the death emote.
   */
  applyDeathEmote(): void {
    if (this._avatar?.setEmote) {
      this._avatar.setEmote(Emotes.DEATH);
    }
  }

  /**
   * Update avatar instance position and animation each frame.
   */
  updateAvatar(delta: number, baseMatrixWorld: THREE.Matrix4): void {
    type AvatarNodeWithInstance = {
      instance?: {
        move?: (matrix: THREE.Matrix4) => void;
        update?: (delta: number) => void;
      };
    };
    const avatarNode = this._avatar as AvatarNodeWithInstance;
    if (avatarNode?.instance) {
      const instance = avatarNode.instance;
      if (instance.move) {
        instance.move(baseMatrixWorld);
      }
      if (instance.update) {
        instance.update(delta);
      }
    }
  }

  /**
   * Update aura position from avatar head bone.
   */
  updateAuraPosition(aura: THREE.Group | null): void {
    if (this._avatar && this._avatar.getBoneTransform && aura) {
      const matrix = this._avatar.getBoneTransform("head");
      if (matrix) {
        aura.position.setFromMatrixPosition(matrix);
      }
    }
  }

  /**
   * Get avatar's Player interface representation.
   */
  getAvatarInterface():
    | {
        getHeight?: () => number;
        getHeadToHeight?: () => number;
        setEmote?: (emote: string) => void;
        getBoneTransform?: (boneName: string) => THREE.Matrix4 | null;
      }
    | undefined {
    if (!this._avatar) return undefined;

    return {
      getHeight: () =>
        this._avatar && this._avatar.getHeight ? this._avatar.getHeight() : 1.8,
      getHeadToHeight: () =>
        this._avatar && this._avatar.getHeadToHeight
          ? this._avatar!.getHeadToHeight()
          : 1.6,
      setEmote: (emote: string) => {
        if (this._avatar && this._avatar.setEmote) this._avatar.setEmote(emote);
      },
      getBoneTransform: (boneName: string) =>
        this._avatar && this._avatar.getBoneTransform
          ? this._avatar.getBoneTransform(boneName)
          : null,
    };
  }

  /**
   * Clean up avatar and retry interval.
   */
  destroy(): void {
    if (this.avatarRetryInterval) {
      clearInterval(this.avatarRetryInterval);
      this.avatarRetryInterval = null;
    }

    if (this._avatar) {
      if (this._avatar.deactivate) {
        this._avatar.deactivate();
      }
      this._avatar = undefined;
    }
  }
}
