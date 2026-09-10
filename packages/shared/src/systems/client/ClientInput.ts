/**
 * ClientInput.ts - Input Handling System
 *
 * Unified input system for keyboard, mouse, and touch.
 * Provides a consistent API for all input devices with configurable bindings.
 *
 * Key Features:
 * - **Multi-Device Support**: Keyboard, mouse, touch, gamepad
 * - **Flexible Bindings**: Map any input to any action
 * - **Action System**: High-level actions (move, jump, interact)
 * - **Raw Input Access**: Low-level button/axis states
 * - **Pointer Events**: Click, hover, drag with 3D raycasting
 * - **Mobile Touch**: Virtual joystick and touch gestures
 * - **Configurable**: Save/load input preferences
 *
 * Input Flow:
 * 1. Raw input events (keyboard, mouse, touch)
 * 2. Control bindings map to actions
 * 3. Actions trigger commands (e.g., "move forward")
 * 4. Systems respond to commands
 *
 * Control Types:
 * - **Button**: Binary on/off (keyboard keys, mouse buttons)
 * - **Vector**: 2D directional (WASD, joystick, touch)
 * - **Value**: 1D scalar (scroll wheel, trigger)
 * - **Pointer**: 2D screen position + 3D raycast
 * - **Screen**: Touch info and dimensions
 *
 * Input Actions:
 * - Movement: forward, back, left, right, jump, crouch
 * - Camera: look, rotate, zoom
 * - Interaction: use, attack, pickup
 * - UI: menu, inventory, chat
 * - Social: emote, voice, gesture
 *
 * Mobile Touch Controls:
 * - Left side: Virtual joystick for movement
 * - Right side: Camera drag to look around
 * - Tap: Interact with objects
 * - Pinch: Zoom camera
 * - Two-finger drag: Pan camera
 *
 * Pointer Raycasting:
 * - Casts ray from screen position into 3D world
 * - Detects entities, terrain, and UI elements
 * - Provides hit point, normal, and distance
 * - Supports interaction highlighting
 *
 * Input Buffering:
 * - Queues inputs when not focused
 * - Prevents lost inputs during lag
 * - Replays on reconnection
 *
 * Performance:
 * - Pre-allocated objects to avoid GC
 * - Input pooling for high-frequency events
 * - Debounce rapid button presses
 * - Throttle pointer move events
 *
 * Usage:
 * ```typescript
 * // Check if key is down
 * if (world.input.getButton('forward')) {
 *   player.moveForward();
 * }
 *
 * // Get movement vector
 * const move = world.input.getVector('move');
 * player.velocity.x = move.x;
 * player.velocity.z = move.y;
 *
 * // Handle pointer click
 * world.input.on('pointerClick', (event) => {
 *   if (event.entity) {
 *     player.interact(event.entity);
 *   }
 * });
 * ```
 *
 * Related Systems:
 * - PlayerLocal: Consumes input to control player
 * - ClientCameraSystem: Uses input for camera control
 * - ClientActions: Executes actions from input
 * - ClientInterface: UI input handling
 *
 * Dependencies:
 * - Requires viewport element for mouse/touch events
 * - Requires camera for raycasting
 * - Requires physics for hit detection
 *
 * @see MovementUtils.ts for movement calculations
 * @see buttons.ts for key code mappings
 */

import THREE from "../../extras/three/three";
import { SystemBase } from "../shared/infrastructure/SystemBase";
import { EventType } from "../../types/events";
import { MovementConfig } from "../../utils/physics/MovementUtils";
import { buttons, codeToProp } from "../../extras/ui/buttons";
import type {
  World,
  WorldOptions,
  ControlEntry,
  ButtonEntry,
  VectorEntry,
  ValueEntry,
  PointerEntry,
  ScreenEntry,
  TouchInfo,
  ControlAction,
  ControlsBinding,
  ControlBinding,
  InputCommand,
  PointerNode,
  CustomPointerEvent,
} from "../../types";
import { InputButtons } from "../../types/network/networking";

// Pre-allocated temp objects to avoid per-frame allocations
const _v3_1 = new THREE.Vector3();
const _v3_2 = new THREE.Vector3();
const _v3_3 = new THREE.Vector3();
const _quat_1 = new THREE.Quaternion();

// Constants
const LMB = 1;
const RMB = 2;
const MouseLeft = "mouseLeft";
const MouseRight = "mouseRight";

const isBrowser = typeof window !== "undefined";
let actionIds = 0;

// Control type factories
const controlTypes = {
  mouseLeft: createButton,
  mouseRight: createButton,
  touchStick: createVector,
  scrollDelta: createValue,
  pointer: createPointer,
  screen: createScreen,
  touchA: createButton,
  touchB: createButton,
};

// Optimized pointer state - pre-allocates objects to avoid GC pressure
class PointerState {
  activePath = new Set<PointerNode>();
  cursor = "default";
  pressedNodes = new Set<PointerNode>();
  propagationStopped = false;

  // Pre-allocated for update() to avoid GC pressure
  private _newPath = new Set<PointerNode>();
  private _orderedPath: PointerNode[] = [];
  private _reusableEvent: CustomPointerEvent = {
    type: null,
    _propagationStopped: false,
    set(type: string) {
      this.type = type;
    },
    stopPropagation() {
      this._propagationStopped = true;
    },
  };

  // Reset and return the reusable event object
  private _getEvent(): CustomPointerEvent {
    this._reusableEvent.type = null;
    this._reusableEvent._propagationStopped = false;
    return this._reusableEvent;
  }

  update(
    hit: { node?: PointerNode } | null,
    pressed: boolean,
    released: boolean,
  ) {
    // Reuse pre-allocated Set instead of creating new one
    const newPath = this._newPath;
    newPath.clear();

    if (hit?.node) {
      let current: PointerNode | undefined = hit.node;
      while (current) {
        newPath.add(current);
        current = current.parent as PointerNode;
      }
    }

    // Handle enter/leave efficiently using reusable event
    for (const node of this.activePath) {
      if (!newPath.has(node)) {
        node.onPointerLeave?.(this._getEvent());
      }
    }

    for (const node of newPath) {
      if (!this.activePath.has(node)) {
        node.onPointerEnter?.(this._getEvent());
      }
    }

    // Handle press/release
    if (pressed && hit?.node) {
      this.propagationStopped = false;
      const orderedPath = this._getOrderedPath(newPath);
      for (let i = 0; i < orderedPath.length; i++) {
        if (this.propagationStopped) break;
        const node = orderedPath[i];
        node.onPointerDown?.(this._getEvent());
        this.pressedNodes.add(node);
      }
    }

    if (released) {
      this.propagationStopped = false;
      for (const node of this.pressedNodes) {
        if (this.propagationStopped) break;
        node.onPointerUp?.(this._getEvent());
      }
      this.pressedNodes.clear();
    }

    // Handle hover
    this.cursor = "default";
    for (const node of newPath) {
      if (node.cursor) {
        this.cursor = node.cursor;
        break;
      }
    }

    // Swap Sets instead of reassigning to avoid GC
    // Copy newPath to activePath and clear newPath
    this.activePath.clear();
    for (const node of newPath) {
      this.activePath.add(node);
    }
  }

  // Reuse array for ordered path to avoid allocation
  private _getOrderedPath(pathSet: Set<PointerNode>): PointerNode[] {
    this._orderedPath.length = 0;
    for (const node of pathSet) {
      this._orderedPath.push(node);
    }
    this._orderedPath.reverse();
    return this._orderedPath;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

/**
 * Client Input System
 *
 * Handles all client input: keyboard, mouse, touch, and input networking.
 * Provides control bindings with priority system for layered input handling.
 */
export class ClientInput extends SystemBase {
  // Control state
  controls: ControlsBinding[] = [];
  actions: ControlAction[] = [];
  buttonsDown = new Set<string>();
  isMac =
    typeof navigator !== "undefined" ? /Mac/.test(navigator.platform) : false;

  // Pointer state
  pointer = {
    locked: false,
    shouldLock: false,
    coords: new THREE.Vector3(),
    position: new THREE.Vector3(),
    delta: new THREE.Vector3(),
  };
  pointerState = new PointerState();
  screenHit: { node?: PointerNode } | null = null;

  // Touch state
  touches = new Map<number, TouchInfo>();

  // Screen state
  screen = { width: 0, height: 0 };
  scroll = { delta: 0 };

  // DOM elements
  viewport: HTMLElement | undefined;
  ui: {
    active: boolean;
    getBoundingClientRect(): { width: number; height: number };
  } | null = null;

  // Mouse button state
  lmbDown = false;
  rmbDown = false;

  // Input buffering for networking
  private inputBuffer: Array<{
    command: InputCommand;
    sent: boolean;
    acknowledged: boolean;
    timestamp: number;
  }> = [];
  private sequenceNumber = 0;
  private lastAcknowledgedSequence = -1;
  private accumulator = 0;
  private moveVector = new THREE.Vector3();
  private buttons = 0;
  private viewAngles = new THREE.Quaternion();

  constructor(world: World) {
    super(world, {
      name: "client-input",
      dependencies: { required: [], optional: [] },
      autoCleanup: true,
    });
  }

  async init(
    options: WorldOptions & {
      viewport?: HTMLElement;
      ui?: {
        active: boolean;
        getBoundingClientRect(): { width: number; height: number };
      };
    },
  ): Promise<void> {
    if (!isBrowser) return;

    this.viewport = options.viewport;
    this.ui = options.ui || null;

    if (!this.viewport) return;

    this.screen.width = this.viewport.offsetWidth;
    this.screen.height = this.viewport.offsetHeight;

    // Setup event listeners
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    this.viewport.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    this.viewport.addEventListener("touchstart", this.onTouchStart);
    this.viewport.addEventListener("touchmove", this.onTouchMove);
    this.viewport.addEventListener("touchend", this.onTouchEnd);
    this.viewport.addEventListener("touchcancel", this.onTouchEnd);
    this.viewport.addEventListener("pointerup", this.onPointerUp);
    this.viewport.addEventListener("wheel", this.onScroll, { passive: false });
    document.body.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("blur", this.onBlur);
  }

  start() {
    // Listen for input acknowledgments
    this.world.on("inputAck", this.handleInputAck.bind(this));

    // Setup keyboard input monitoring for movement
    this.setupMovementInput();
  }

  preFixedUpdate() {
    // Process scroll delta
    for (const control of this.controls) {
      const scrollDelta = control.entries.scrollDelta;
      if (scrollDelta) {
        (scrollDelta as ValueEntry).value = this.scroll.delta;
        if ((scrollDelta as ValueEntry).capture) break;
      }
    }
  }

  update(delta: number) {
    // Update pointer state
    this.pointerState.update(
      this.screenHit,
      this.lmbDown && !this.pointerState.pressedNodes.size,
      !this.lmbDown && this.pointerState.pressedNodes.size > 0,
    );

    // Apply cursor
    if (this.ui?.active && this.viewport) {
      this.viewport.style.cursor = this.pointerState.cursor;
    }

    // Process networked input at fixed rate
    this.accumulator += delta;
    const tickInterval = 1.0 / MovementConfig.clientTickRate;

    while (this.accumulator >= tickInterval) {
      this.captureAndSendInput(tickInterval);
      this.accumulator -= tickInterval;
    }

    // Clean old acknowledged inputs
    this.cleanInputBuffer();
  }

  postLateUpdate() {
    // Clear deltas
    this.pointer.delta.set(0, 0, 0);
    this.scroll.delta = 0;

    // Clear button states
    for (const control of this.controls) {
      for (const key in control.entries) {
        const entry = control.entries[key] as ButtonEntry;
        if (entry.$button) {
          entry.pressed = false;
          entry.released = false;
        }
      }
    }

    // Clear touch deltas
    for (const [_id, info] of this.touches) {
      info.delta.set(0, 0, 0);
    }
  }

  // Control binding API
  bind(
    options: {
      priority?: number;
      onRelease?: () => void;
      onTouch?: (info: TouchInfo) => boolean;
      onTouchEnd?: (info: TouchInfo) => boolean;
    } = {},
  ): ControlBinding {
    const entries: Record<string, ControlEntry> = {};
    const control: ControlsBinding = {
      options,
      entries,
      actions: null,
      api: {
        setActions: (value) => {
          control.actions = value;
          if (value) {
            for (const action of value) {
              action.id = ++actionIds;
            }
          }
          this.buildActions();
        },
        release: () => {
          const idx = this.controls.indexOf(control);
          if (idx === -1) return;
          this.controls.splice(idx, 1);
          options.onRelease?.();
        },
      },
      release: () => {
        const idx = this.controls.indexOf(control);
        if (idx === -1) return;
        this.controls.splice(idx, 1);
        options.onRelease?.();
      },
    };

    // Insert at priority
    const priority = options.priority ?? 0;
    const idx = this.controls.findIndex(
      (c) => (c.options.priority ?? 0) <= priority,
    );
    if (idx === -1) {
      this.controls.push(control);
    } else {
      this.controls.splice(idx, 0, control);
    }

    // Return proxy
    return new Proxy(control, {
      get(target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "release") return target.release;
        if (prop in target.api)
          return target.api[prop as keyof typeof target.api];
        if (prop in entries) return entries[prop];
        if (buttons.has(prop)) {
          entries[prop] = createButton();
          return entries[prop];
        }
        const createType = controlTypes[prop as keyof typeof controlTypes];
        if (createType) {
          entries[prop] = createType();
          return entries[prop];
        }
        return undefined;
      },
    }) as ControlBinding;
  }

  private buildActions() {
    this.actions = [];
    for (const control of this.controls) {
      if (!control.actions) continue;
      for (const action of control.actions) {
        if (action.type !== "custom") {
          if (this.actions.find((a) => a.type === action.type)) continue;
        }
        this.actions.push(action);
      }
    }
    this.emit("actions", this.actions);
  }

  // Event handlers
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat || this.isInputFocused()) return;

    // Block input if controls are disabled (spectator mode)
    if (!this._controlsEnabled) return;

    // CRITICAL: Block ALL input during death
    const player = this.world.getPlayer();
    if (
      player &&
      ((player as { isDying?: boolean }).isDying ||
        (player.data as { isDying?: boolean })?.isDying)
    ) {
      console.log(
        "[ClientInput] Blocked keydown during death - player is dying",
      );
      return;
    }

    if (e.code === "Tab") e.preventDefault();

    const prop = codeToProp[e.code];
    this.buttonsDown.add(prop);

    // Update movement buttons
    this.handleButtonPress(e.code);

    for (const control of this.controls) {
      const button = control.entries[prop] as ButtonEntry;
      if (button) {
        button.pressed = true;
        button.down = true;
        const capture = button.onPress?.();
        if (capture || button.capture) break;
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.repeat || this.isInputFocused()) return;

    // Block input if controls are disabled (spectator mode)
    if (!this._controlsEnabled) return;

    if (e.code === "MetaLeft" || e.code === "MetaRight") {
      return this.releaseAllButtons();
    }

    const prop = codeToProp[e.code];
    this.buttonsDown.delete(prop);

    // Update movement buttons
    this.handleButtonRelease(e.code);

    for (const control of this.controls) {
      const button = control.entries[prop] as ButtonEntry;
      if (button?.down) {
        button.down = false;
        button.released = true;
        button.onRelease?.();
      }
    }

    // classic fantasy MMORPG-style: no keyboard-driven movement; do not send network cancels on key release
  };

  private onPointerDown = (e: PointerEvent) => {
    type ExtendedPointerEvent = PointerEvent & { isCoreUI?: boolean };
    if ((e as ExtendedPointerEvent).isCoreUI) return;

    // Skip if event originated from a modal or UI overlay
    if (this.isEventFromModal(e)) return;

    // Block input if controls are disabled (spectator mode)
    if (!this._controlsEnabled) return;

    // CRITICAL: Block ALL pointer input during death
    const player = this.world.getPlayer();
    if (
      player &&
      ((player as { isDying?: boolean }).isDying ||
        (player.data as { isDying?: boolean })?.isDying)
    ) {
      console.log(
        "[ClientInput] Blocked pointer click during death - player is dying",
      );
      return;
    }

    this.checkPointerChanges(e);
  };

  private onPointerMove = (e: PointerEvent) => {
    type ExtendedPointerEvent = PointerEvent & { isCoreUI?: boolean };
    if ((e as ExtendedPointerEvent).isCoreUI || !this.viewport) return;
    if (this.isEventFromModal(e)) return;

    // Block input if controls are disabled (spectator mode)
    if (!this._controlsEnabled) return;

    const rect = this.viewport.getBoundingClientRect();
    const offsetX = e.pageX - rect.left;
    const offsetY = e.pageY - rect.top;

    this.pointer.coords.x = Math.max(0, Math.min(1, offsetX / rect.width));
    this.pointer.coords.y = Math.max(0, Math.min(1, offsetY / rect.height));
    this.pointer.position.x = offsetX;
    this.pointer.position.y = offsetY;
    this.pointer.delta.x += e.movementX;
    this.pointer.delta.y += e.movementY;
  };

  private onPointerUp = (e: PointerEvent) => {
    type ExtendedPointerEvent = PointerEvent & { isCoreUI?: boolean };
    if ((e as ExtendedPointerEvent).isCoreUI) return;
    if (this.isEventFromModal(e)) return;
    this.checkPointerChanges(e);
  };

  private checkPointerChanges(e: PointerEvent) {
    const lmb = !!(e.buttons & LMB);
    const rmb = !!(e.buttons & RMB);

    // Left mouse
    if (!this.lmbDown && lmb) {
      this.lmbDown = true;
      this.buttonsDown.add(MouseLeft);
      for (const control of this.controls) {
        const button = control.entries.mouseLeft as ButtonEntry;
        if (button) {
          button.down = true;
          button.pressed = true;
          const capture = button.onPress?.();
          if (capture || button.capture) break;
        }
      }
    }

    if (this.lmbDown && !lmb) {
      this.lmbDown = false;
      this.buttonsDown.delete(MouseLeft);
      for (const control of this.controls) {
        const button = control.entries.mouseLeft as ButtonEntry;
        if (button) {
          button.down = false;
          button.released = true;
          button.onRelease?.();
        }
      }
    }

    // Right mouse
    if (!this.rmbDown && rmb) {
      this.rmbDown = true;
      this.buttonsDown.add(MouseRight);
      for (const control of this.controls) {
        const button = control.entries.mouseRight as ButtonEntry;
        if (button) {
          button.down = true;
          button.pressed = true;
          const capture = button.onPress?.();
          if (capture || button.capture) break;
        }
      }
    }

    if (this.rmbDown && !rmb) {
      this.rmbDown = false;
      this.buttonsDown.delete(MouseRight);
      for (const control of this.controls) {
        const button = control.entries.mouseRight as ButtonEntry;
        if (button) {
          button.down = false;
          button.released = true;
          button.onRelease?.();
        }
      }
    }
  }

  private onTouchStart = (e: TouchEvent) => {
    type ExtendedTouchEvent = TouchEvent & { isCoreUI?: boolean };
    if ((e as ExtendedTouchEvent).isCoreUI) return;
    if (this.isEventFromModal(e)) return;
    // Ignore touches that begin on UI elements so mobile UI remains interactive
    const t = e.changedTouches && e.changedTouches[0];
    if (t) {
      const el = document.elementFromPoint(
        t.clientX,
        t.clientY,
      ) as HTMLElement | null;
      if (el && this.viewport && el !== this.viewport) {
        return;
      }
    }
    e.preventDefault();

    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      const info: TouchInfo = {
        id: touch.identifier,
        position: _v3_1.set(touch.clientX, touch.clientY, 0),
        prevPosition: _v3_2.set(touch.clientX, touch.clientY, 0),
        delta: _v3_3.set(0, 0, 0),
      };
      this.touches.set(info.id, info);

      for (const control of this.controls) {
        const consume = control.options.onTouch?.(info);
        if (consume) break;
      }
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    type ExtendedTouchEvent = TouchEvent & { isCoreUI?: boolean };
    if ((e as ExtendedTouchEvent).isCoreUI) return;
    // Don't interfere with UI drags/gestures
    const t = e.changedTouches && e.changedTouches[0];
    if (t) {
      const el = document.elementFromPoint(
        t.clientX,
        t.clientY,
      ) as HTMLElement | null;
      if (el && this.viewport && el !== this.viewport) {
        return;
      }
    }

    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      const info = this.touches.get(touch.identifier);
      if (!info) continue;

      const currentX = touch.clientX;
      const currentY = touch.clientY;
      info.delta.x += currentX - info.prevPosition.x;
      info.delta.y += currentY - info.prevPosition.y;
      info.position.x = currentX;
      info.position.y = currentY;
      info.prevPosition.x = currentX;
      info.prevPosition.y = currentY;
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    type ExtendedTouchEvent = TouchEvent & { isCoreUI?: boolean };
    if ((e as ExtendedTouchEvent).isCoreUI) return;
    // Allow UI taps to complete and generate click events
    const t = e.changedTouches && e.changedTouches[0];
    if (t) {
      const el = document.elementFromPoint(
        t.clientX,
        t.clientY,
      ) as HTMLElement | null;
      if (el && this.viewport && el !== this.viewport) {
        return;
      }
    }

    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      const info = this.touches.get(touch.identifier);

      for (const control of this.controls) {
        const consume = control.options.onTouchEnd?.(info!);
        if (consume) break;
      }

      this.touches.delete(touch.identifier);
    }
  };

  private onScroll = (e: WheelEvent) => {
    type ExtendedWheelEvent = WheelEvent & { isCoreUI?: boolean };
    if ((e as ExtendedWheelEvent).isCoreUI) return;
    // Skip if event originated from a modal or UI overlay
    if (this.isEventFromModal(e)) return;
    let delta = e.shiftKey ? e.deltaX : e.deltaY;
    if (!this.isMac) delta = -delta;
    this.scroll.delta += delta;
  };

  /**
   * Check if an event originated from within a modal overlay.
   * This prevents game interactions when clicking on modal UI elements.
   */
  private isEventFromModal(
    event: PointerEvent | MouseEvent | TouchEvent,
  ): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;

    // Check if the target is inside a modal (role="dialog" or data-modal attribute)
    const modal = target.closest('[role="dialog"], [data-modal="true"]');
    if (modal) return true;

    // Check if the target has a high z-index overlay (modal backdrop)
    // Modals typically use z-index >= 10000
    let el: HTMLElement | null = target;
    while (el) {
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex, 10);
      if (!isNaN(zIndex) && zIndex >= 10000) {
        return true;
      }
      el = el.parentElement;
    }

    return false;
  }

  private onContextMenu = (e: Event) => {
    e.preventDefault();
  };

  private onResize = () => {
    this.screen.width = this.viewport?.offsetWidth || 0;
    this.screen.height = this.viewport?.offsetHeight || 0;
  };

  private onFocus = () => {
    this.releaseAllButtons();
  };

  private onBlur = () => {
    this.releaseAllButtons();
  };

  private onPointerLockChange = () => {
    // Pointer lock disabled for UI
  };

  // Movement input handling
  private setupMovementInput() {
    if (this.world.rig) {
      setInterval(() => {
        this.viewAngles.copy(this.world.rig.quaternion);
      }, 16);
    }
  }

  private handleButtonPress(button: string): void {
    switch (button) {
      case "KeyW":
      case "ArrowUp":
        this.buttons |= InputButtons.FORWARD;
        break;
      case "KeyS":
      case "ArrowDown":
        this.buttons |= InputButtons.BACKWARD;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.buttons |= InputButtons.LEFT;
        break;
      case "KeyD":
      case "ArrowRight":
        this.buttons |= InputButtons.RIGHT;
        break;
      case "Space":
        this.buttons |= InputButtons.JUMP;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.buttons |= InputButtons.SPRINT;
        break;
      case "ControlLeft":
      case "ControlRight":
        this.buttons |= InputButtons.CROUCH;
        break;
    }
  }

  private handleButtonRelease(button: string): void {
    switch (button) {
      case "KeyW":
      case "ArrowUp":
        this.buttons &= ~InputButtons.FORWARD;
        break;
      case "KeyS":
      case "ArrowDown":
        this.buttons &= ~InputButtons.BACKWARD;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.buttons &= ~InputButtons.LEFT;
        break;
      case "KeyD":
      case "ArrowRight":
        this.buttons &= ~InputButtons.RIGHT;
        break;
      case "Space":
        this.buttons &= ~InputButtons.JUMP;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.buttons &= ~InputButtons.SPRINT;
        break;
      case "ControlLeft":
      case "ControlRight":
        this.buttons &= ~InputButtons.CROUCH;
        break;
    }
  }

  // Network input handling
  private captureAndSendInput(deltaTime: number): void {
    const now = performance.now();

    const input: InputCommand = {
      sequence: this.sequenceNumber++,
      timestamp: now,
      deltaTime: deltaTime,
      moveVector: this.moveVector.clone(),
      buttons: this.buttons,
      viewAngles: this.viewAngles.clone(),
      checksum: this.calculateChecksum(),
    };

    const buffered = {
      command: input,
      sent: false,
      acknowledged: false,
      timestamp: now,
    };

    this.inputBuffer.push(buffered);

    // classic fantasy MMORPG-style: no keyboard-driven movement; do not send moveRequest from keyboard

    // Trim buffer
    while (this.inputBuffer.length > MovementConfig.inputBufferSize) {
      this.inputBuffer.shift();
    }
  }

  private handleInputAck(data: {
    sequence: number;
    corrections?: unknown;
  }): void {
    this.lastAcknowledgedSequence = data.sequence;

    for (const buffered of this.inputBuffer) {
      if (buffered.command.sequence <= data.sequence) {
        buffered.acknowledged = true;
      }
    }

    if (data.corrections) {
      this.world.emit(EventType.SERVER_CORRECTION, {
        sequence: data.sequence,
        corrections: data.corrections,
      });
    }
  }

  private cleanInputBuffer(): void {
    const now = performance.now();
    // In-place filter to avoid creating new array each frame
    let writeIdx = 0;
    for (let i = 0; i < this.inputBuffer.length; i++) {
      const buffered = this.inputBuffer[i];
      if (!buffered.acknowledged) {
        this.inputBuffer[writeIdx++] = buffered;
      } else {
        const age = now - buffered.timestamp;
        if (age < 100) {
          this.inputBuffer[writeIdx++] = buffered;
        }
      }
    }
    this.inputBuffer.length = writeIdx;
  }

  private calculateChecksum(): number {
    const data =
      this.sequenceNumber +
      this.buttons +
      Math.floor(this.moveVector.x * 1000) +
      Math.floor(this.moveVector.z * 1000);
    return data % 65536;
  }

  // Helper methods
  private releaseAllButtons() {
    for (const control of this.controls) {
      for (const key in control.entries) {
        const button = control.entries[key] as ButtonEntry;
        if (button.$button && button.down) {
          button.released = true;
          button.down = false;
          button.onRelease?.();
        }
      }
    }
  }

  private isInputFocused() {
    return (
      document.activeElement?.tagName === "INPUT" ||
      document.activeElement?.tagName === "TEXTAREA"
    );
  }

  setScreenHit(screenHit: { node?: PointerNode } | null) {
    this.screenHit = screenHit;
  }

  setMoveTarget(target: THREE.Vector3 | null): void {
    if (target) {
      const player = this.world.entities.player;
      if (player && "position" in player) {
        _v3_1
          .subVectors(target, player.position as THREE.Vector3)
          .setY(0)
          .normalize();
        this.moveVector.copy(_v3_1);
      }
    } else {
      this.moveVector.set(0, 0, 0);
    }
  }

  getUnacknowledgedInputs(): InputCommand[] {
    return this.inputBuffer
      .filter((b) => !b.acknowledged)
      .map((b) => b.command);
  }

  stopAll(): void {
    this.releaseAllButtons();
    this.moveVector.set(0, 0, 0);
    this.buttons = 0;
  }

  // ========================================
  // AGENT CONTROL METHODS
  // These methods allow programmatic control for AI agents
  // ========================================

  // Agent navigation state
  private navigationTarget: { x: number; z: number } | null = null;
  private followTargetId: string | null = null;
  private isNavigating = false;
  private navigationToken: { aborted: boolean; abort: () => void } | null =
    null;
  private isRandomWalking = false;
  private randomWalkTimer: ReturnType<typeof setTimeout> | null = null;
  private randomWalkRadius = 10;
  private randomWalkInterval = 3000; // ms between random walks
  private tempVec3Agent = new THREE.Vector3();

  // Navigation constants
  private readonly NAVIGATION_STOP_DISTANCE = 0.5;
  private readonly FOLLOW_STOP_DISTANCE = 2.0;
  private readonly CONTROLS_TICK_INTERVAL = 100; // ms

  /**
   * Navigate to a specific position in the world (for AI agents)
   */
  async goto(x: number, z: number): Promise<boolean> {
    // Stop any existing navigation
    this.stopNavigation();

    // Set navigation target
    this.navigationTarget = { x, z };
    this.isNavigating = true;
    this.navigationToken = {
      aborted: false,
      abort: () => {
        this.navigationToken!.aborted = true;
      },
    };

    // Get player
    const player = this.world.entities.player!;

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isNavigating || this.navigationToken?.aborted) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }

        const currentPos = player.node.position;
        const targetPos = this.navigationTarget!;

        // Move towards target
        const direction = {
          x: targetPos.x - currentPos.x,
          z: targetPos.z - currentPos.z,
        };

        // Calculate distance to target
        const distance = Math.sqrt(
          Math.pow(currentPos.x - targetPos.x, 2) +
            Math.pow(currentPos.z - targetPos.z, 2),
        );

        // Check if we've reached the target
        if (distance <= this.NAVIGATION_STOP_DISTANCE) {
          clearInterval(checkInterval);
          this.stopNavigation();
          resolve(true);
          return;
        }

        // Normalize direction
        const length = Math.sqrt(
          direction.x * direction.x + direction.z * direction.z,
        );
        if (length > 0) {
          direction.x /= length;
          direction.z /= length;
        }

        // Use physics-based movement if available
        const controllablePlayer = player as {
          walkToward?: (
            targetPosition: { x: number; y: number; z: number },
            speed?: number,
          ) => void;
          walk?: (direction: { x: number; z: number }, speed?: number) => void;
          teleport?: (options: {
            position: THREE.Vector3;
            rotationY: number;
          }) => void;
        };

        if (controllablePlayer.walkToward) {
          // Use physics-based walking toward target
          const targetPosition = {
            x: targetPos.x,
            y: currentPos.y,
            z: targetPos.z,
          };
          controllablePlayer.walkToward(targetPosition, 2.0); // 2 m/s walking speed
        } else if (controllablePlayer.walk) {
          // Use physics-based directional walking
          controllablePlayer.walk(direction, 2.0);
        } else if (controllablePlayer.teleport) {
          const moveDistance = Math.min(1.0, distance);
          const newX = currentPos.x + direction.x * moveDistance;
          const newZ = currentPos.z + direction.z * moveDistance;

          controllablePlayer.teleport({
            position: this.tempVec3Agent.set(newX, currentPos.y, newZ),
            rotationY: Math.atan2(direction.x, direction.z),
          });
        }
      }, this.CONTROLS_TICK_INTERVAL);
    });
  }

  /**
   * Follow a specific entity by ID (for AI agents)
   */
  async followEntity(entityId: string): Promise<boolean> {
    // Stop any existing navigation
    this.stopNavigation();

    // Set follow target
    this.followTargetId = entityId;
    this.isNavigating = true;
    this.navigationToken = {
      aborted: false,
      abort: () => {
        this.navigationToken!.aborted = true;
      },
    };

    // Get player
    const player = this.world.entities.player!;

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.isNavigating || this.navigationToken?.aborted) {
          clearInterval(checkInterval);
          resolve(false);
          return;
        }

        // Get target entity
        const currentTarget =
          this.world.entities.items.get(entityId) ||
          this.world.entities.players.get(entityId)!;

        if (!currentTarget) {
          console.warn(
            `[ClientInput] Follow target entity ${entityId} no longer exists`,
          );
          clearInterval(checkInterval);
          this.stopNavigation();
          resolve(false);
          return;
        }

        const currentPos = player.node.position;
        const targetPos =
          currentTarget.position || currentTarget.node?.position;

        if (!targetPos) {
          console.warn(
            `[ClientInput] Follow target entity ${entityId} has no position`,
          );
          clearInterval(checkInterval);
          this.stopNavigation();
          resolve(false);
          return;
        }

        // Calculate distance to target
        const distance = Math.sqrt(
          Math.pow(currentPos.x - targetPos.x, 2) +
            Math.pow(currentPos.z - targetPos.z, 2),
        );

        // Check if we're close enough to the target
        if (distance <= this.FOLLOW_STOP_DISTANCE) {
          clearInterval(checkInterval);
          this.stopNavigation();
          resolve(true);
          return;
        }

        // Move towards target
        const direction = {
          x: targetPos.x - currentPos.x,
          z: targetPos.z - currentPos.z,
        };

        // Normalize direction
        const length = Math.sqrt(
          direction.x * direction.x + direction.z * direction.z,
        );
        if (length > 0) {
          direction.x /= length;
          direction.z /= length;
        }

        // Use physics-based movement for following
        const controllablePlayer = player as {
          walkToward?: (
            targetPosition: { x: number; y: number; z: number },
            speed?: number,
          ) => void;
          walk?: (direction: { x: number; z: number }, speed?: number) => void;
          teleport?: (options: {
            position: THREE.Vector3;
            rotationY: number;
          }) => void;
        };

        if (controllablePlayer.walkToward) {
          // Calculate target position that maintains follow distance
          const followDistance = this.FOLLOW_STOP_DISTANCE + 0.5; // Stay just outside the follow distance
          const targetDistance = Math.max(followDistance, distance - 1.0);
          const followX = targetPos.x - direction.x * targetDistance;
          const followZ = targetPos.z - direction.z * targetDistance;

          controllablePlayer.walkToward(
            { x: followX, y: currentPos.y, z: followZ },
            2.5,
          );
        } else if (controllablePlayer.walk) {
          // Use directional physics walking
          controllablePlayer.walk(direction, 2.5);
        } else if (controllablePlayer.teleport) {
          const moveDistance = Math.min(
            2.0,
            distance - this.FOLLOW_STOP_DISTANCE,
          );
          if (moveDistance > 0) {
            const newX = currentPos.x + direction.x * moveDistance;
            const newZ = currentPos.z + direction.z * moveDistance;

            controllablePlayer.teleport({
              position: this.tempVec3Agent.set(newX, currentPos.y, newZ),
              rotationY: Math.atan2(direction.x, direction.z),
            });
          }
        }
      }, this.CONTROLS_TICK_INTERVAL);
    });
  }

  /**
   * Stop all navigation actions (for AI agents)
   */
  stopNavigation(): void {
    if (this.navigationToken) {
      this.navigationToken.abort();
      this.navigationToken = null;
    }
    this.isNavigating = false;
    this.navigationTarget = null;
    this.followTargetId = null;
  }

  /**
   * Stop all agent actions (navigation, random walk, etc.)
   */
  stopAllActions(): void {
    this.stopNavigation();
    this.stopRandomWalk();
  }

  /**
   * Start random walk behavior (for AI agents)
   *
   * Picks random positions within the configured radius and walks to them.
   * Uses classic MMORPG-style probabilistic wandering with configurable interval.
   *
   * @param radius - Max distance from current position (default 10)
   * @param interval - Time between random walks in ms (default 3000)
   */
  startRandomWalk(radius = 10, interval = 3000): void {
    if (this.isRandomWalking) return;

    this.isRandomWalking = true;
    this.randomWalkRadius = radius;
    this.randomWalkInterval = interval;

    // Start the random walk loop
    this.executeRandomWalkStep();
  }

  /**
   * Execute a single random walk step, then schedule the next one.
   */
  private async executeRandomWalkStep(): Promise<void> {
    if (!this.isRandomWalking) return;

    const player = this.world.entities.player;
    if (!player?.node) {
      // No player yet, retry later
      this.randomWalkTimer = setTimeout(
        () => this.executeRandomWalkStep(),
        1000,
      );
      return;
    }

    // Get current position
    const currentPos = player.node.position;

    // Pick a random angle and distance
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * this.randomWalkRadius;

    // Calculate target position
    const targetX = currentPos.x + Math.cos(angle) * distance;
    const targetZ = currentPos.z + Math.sin(angle) * distance;

    // Navigate to the random position
    await this.goto(targetX, targetZ);

    // Schedule next random walk if still active
    if (this.isRandomWalking) {
      this.randomWalkTimer = setTimeout(
        () => this.executeRandomWalkStep(),
        this.randomWalkInterval,
      );
    }
  }

  /**
   * Stop random walk behavior (for AI agents)
   */
  stopRandomWalk(): void {
    this.isRandomWalking = false;
    if (this.randomWalkTimer) {
      clearTimeout(this.randomWalkTimer);
      this.randomWalkTimer = null;
    }
    this.stopNavigation();
  }

  /**
   * Check if currently walking randomly (for AI agents)
   */
  getIsWalkingRandomly(): boolean {
    return this.isRandomWalking;
  }

  /**
   * Check if currently navigating (for AI agents)
   */
  getIsNavigating(): boolean {
    return this.isNavigating;
  }

  /**
   * Disable all input controls (for spectator mode)
   * Prevents keyboard, mouse, and touch input from affecting the game
   */
  private _controlsEnabled = true;

  disable(): void {
    this._controlsEnabled = false;
    // Clear all current input states
    this.buttonsDown.clear();
    this.lmbDown = false;
    this.rmbDown = false;
    this.moveVector.set(0, 0, 0);
    console.log("[ClientInput] Controls disabled");
  }

  /**
   * Re-enable input controls
   */
  enable(): void {
    this._controlsEnabled = true;
    console.log("[ClientInput] Controls enabled");
  }

  /**
   * Check if controls are enabled
   */
  isEnabled(): boolean {
    return this._controlsEnabled;
  }

  destroy() {
    if (!isBrowser) return;

    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.viewport?.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    this.viewport?.removeEventListener("touchstart", this.onTouchStart);
    this.viewport?.removeEventListener("touchmove", this.onTouchMove);
    this.viewport?.removeEventListener("touchend", this.onTouchEnd);
    this.viewport?.removeEventListener("touchcancel", this.onTouchEnd);
    this.viewport?.removeEventListener("pointerup", this.onPointerUp);
    this.viewport?.removeEventListener("wheel", this.onScroll);
    document.body.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("blur", this.onBlur);
  }
}

// Factory functions for control entries
function createButton(): ButtonEntry {
  return {
    $button: true,
    down: false,
    pressed: false,
    released: false,
    capture: false,
    onPress: null,
    onRelease: null,
  };
}

function createVector(): VectorEntry {
  return {
    $vector: true,
    value: new THREE.Vector3(),
    capture: false,
  };
}

function createValue(): ValueEntry {
  return {
    $value: true,
    value: null,
    capture: false,
  };
}

function createPointer(): PointerEntry {
  const coords = new THREE.Vector3();
  const position = new THREE.Vector3();
  const delta = new THREE.Vector3();

  return {
    $pointer: true,
    get coords() {
      return coords;
    },
    get position() {
      return position;
    },
    get delta() {
      return delta;
    },
    get locked() {
      return false;
    },
    lock() {},
    unlock() {},
  } as PointerEntry;
}

function createScreen(): ScreenEntry {
  return {
    $screen: true,
    get width() {
      return 0;
    },
    get height() {
      return 0;
    },
  };
}
