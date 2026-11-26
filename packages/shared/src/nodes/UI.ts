/**
 * UI.ts - 3D UI Panel Node
 *
 * Renders 2D UI elements in 3D space. Supports flexbox layout via Yoga.
 */

import { every, isArray, isBoolean, isNumber, isString } from "lodash-es";
import Yoga from "yoga-layout";
import THREE, {
  MeshStandardNodeMaterial,
  MeshBasicNodeMaterial,
} from "../extras/three/three";
import type { Entity } from "../entities/Entity";
import { fillRoundRect } from "../extras/ui/roundRect";
import {
  AlignContent,
  AlignItems,
  FlexDirection,
  FlexWrap,
  isAlignContent,
  isAlignItem,
  isFlexDirection,
  isFlexWrap,
  isJustifyContent,
  JustifyContent,
} from "../extras/ui/yoga";
import { Node } from "./Node";

import type {
  UIRaycastHit,
  UISceneItem,
  UIData,
  UIProxy,
  UIYogaNode,
} from "../types/rendering/nodes";
import type { HotReloadable } from "../types";
import { borderRoundRect } from "../extras/ui/borderRoundRect";
import { clamp } from "../utils";

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const v4 = new THREE.Vector3();
const v5 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const e1 = new THREE.Euler(0, 0, 0, "YXZ");
const m1 = new THREE.Matrix4();

const isBrowser = typeof window !== "undefined";

const spaces = ["world", "screen"];
const billboards = ["none", "full", "y"];
const pivots = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

const defaults = {
  space: "world",
  width: 100,
  height: 100,
  size: 0.01,
  res: 2,

  lit: false,
  doubleside: true,
  billboard: "none",
  pivot: "center",
  offset: [0, 0, 0],
  scaler: null,
  pointerEvents: true,

  transparent: true,
  backgroundColor: null,
  borderWidth: 0,
  borderColor: null,
  borderRadius: 0,
  padding: 0,
  flexDirection: "column",
  justifyContent: "flex-start",
  alignItems: "stretch",
  alignContent: "flex-start",
  flexWrap: "no-wrap",
  gap: 0,
};

type UIHitTestNode = Node & {
  box?: { left: number; top: number; width: number; height: number } | null;
  _display?: string;
};

export class UI extends Node implements HotReloadable {
  // Add all the missing private property declarations
  private _space: string = defaults.space;
  private _width: number = defaults.width;
  private _height: number = defaults.height;
  private _size: number = defaults.size;
  private _res: number = defaults.res;
  private _lit: boolean = defaults.lit;
  private _doubleside: boolean = defaults.doubleside;
  private _billboard: string = defaults.billboard;
  private _pivot: string = defaults.pivot;
  private _offset: THREE.Vector3;
  private _scaler: [number, number] | [number, number, number] | null =
    defaults.scaler;
  private _pointerEvents: boolean = defaults.pointerEvents;
  private _transparent: boolean = defaults.transparent;
  private _backgroundColor: string | null = defaults.backgroundColor;
  private _borderWidth: number = defaults.borderWidth;
  private _borderColor: string | null = defaults.borderColor;
  private _borderRadius: number | number[] = defaults.borderRadius;
  private _padding: number | number[] = defaults.padding;
  private _flexDirection: string = defaults.flexDirection;
  private _justifyContent: string = defaults.justifyContent;
  private _alignItems: string = defaults.alignItems;
  private _alignContent: string = defaults.alignContent;
  private _flexWrap: string = defaults.flexWrap;
  private _gap: number = defaults.gap;

  // Other properties that need to be declared
  yogaNode?: UIYogaNode;
  canvas?: HTMLCanvasElement | null;
  canvasCtx?: CanvasRenderingContext2D | null;
  texture?: THREE.CanvasTexture | null;
  geometry?: THREE.PlaneGeometry | null;
  material?: THREE.Material | null;
  mesh?: THREE.Mesh | null;
  sItem?: UISceneItem | null;
  cleanupPointer: (() => void) | null = null;
  needsRebuild?: boolean;
  needsRedraw?: boolean;
  box?: { left: number; top: number; width: number; height: number } | null;
  pivotOffset?: THREE.Vector3;
  ui: UI;
  proxy?: UIProxy;
  transform: { position: THREE.Vector3 };

  constructor(data: UIData = {}) {
    super(data);
    this.name = "ui";

    this._space = data.space ?? defaults.space;
    this._width = data.width ?? defaults.width;
    this._height = data.height ?? defaults.height;
    this._size = data.size ?? defaults.size;
    this._res = data.res ?? defaults.res;

    this._lit = data.lit ?? defaults.lit;
    this._doubleside = data.doubleside ?? defaults.doubleside;
    this._billboard = data.billboard ?? defaults.billboard;
    this._pivot = data.pivot ?? defaults.pivot;
    this._offset = new THREE.Vector3();
    if (data.offset) {
      this._offset.set(data.offset[0], data.offset[1], data.offset[2]);
    } else {
      this._offset.set(
        defaults.offset[0],
        defaults.offset[1],
        defaults.offset[2],
      );
    }
    this._scaler = (data.scaler ?? defaults.scaler) as
      [number, number] | [number, number, number] | null;
    this._pointerEvents = data.pointerEvents ?? defaults.pointerEvents;

    this._transparent = data.transparent ?? defaults.transparent;
    this._backgroundColor = data.backgroundColor ?? defaults.backgroundColor;
    this._borderWidth = data.borderWidth ?? defaults.borderWidth;
    this._borderColor = data.borderColor ?? defaults.borderColor;
    this._borderRadius = data.borderRadius ?? defaults.borderRadius;
    this._padding = data.padding ?? defaults.padding;
    this._flexDirection = data.flexDirection ?? defaults.flexDirection;
    this._justifyContent = data.justifyContent ?? defaults.justifyContent;
    this._alignItems = data.alignItems ?? defaults.alignItems;
    this._alignContent = data.alignContent ?? defaults.alignContent;
    this._flexWrap = data.flexWrap ?? defaults.flexWrap;
    this._gap = data.gap ?? defaults.gap;

    this.ui = this;

    // Initialize transform object to prevent undefined access in lateUpdate
    this.transform = {
      position: new THREE.Vector3(),
    };

    // Note: We can't override _offset methods since it would break THREE.Vector3 functionality
    // offset changes should be tracked through the setter
  }

  build() {
    if (!isBrowser) return;
    this.unbuild();
    this.canvas = document.createElement("canvas");
    this.canvas.width = this._width * this._res;
    this.canvas.height = this._height * this._res;
    this.canvasCtx = this.canvas.getContext("2d");
    if (this._space === "world") {
      // world-space
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.anisotropy = this.ctx?.graphics?.maxAnisotropy || 1;
      // this.texture.minFilter = THREE.LinearFilter // or THREE.NearestFilter for pixel-perfect but potentially aliased text
      // this.texture.magFilter = THREE.LinearFilter
      // this.texture.generateMipmaps = true
      this.geometry = new THREE.PlaneGeometry(this._width, this._height);
      this.geometry.scale(this._size, this._size, this._size);
      pivotGeometry(
        this._pivot,
        this.geometry,
        this._width * this._size,
        this._height * this._size,
      );
      const pivotOffset2D = getPivotOffset(
        this._pivot,
        this._width,
        this._height,
      );
      this.pivotOffset = new THREE.Vector3(pivotOffset2D.x, pivotOffset2D.y, 0);
      this.material = this.createMaterial(
        this._lit,
        this.texture,
        this._transparent,
        this._doubleside,
      );
      this.mesh = new THREE.Mesh(this.geometry, this.material);
      this.mesh.matrixAutoUpdate = false;
      this.mesh.matrixWorldAutoUpdate = false;
      this.mesh.matrixWorld.copy(this.matrixWorld);
      this.ctx?.stage.scene?.add(this.mesh);
      if (this._pointerEvents) {
        this.sItem = {
          matrix: this.mesh.matrixWorld,
          geometry: this.geometry,
          material: this.material,
          getEntity: () => (this.ctx!.entity as Entity | undefined) || null,
          node: this,
        };
        if (this.sItem) {
          this.ctx?.stage?.octree?.insert(this.sItem);
        }
      }
      this.ctx?.setHot(this, true);
    } else {
      // screen-space
      this.canvas.style.position = "absolute";
      this.canvas.style.width = this._width + "px";
      this.canvas.style.height = this._height + "px";
      pivotCanvas(this._pivot, this.canvas, this._width, this._height);
      this.canvas.style.left = `calc(${this.position.x * 100}% + ${this._offset.x}px)`;
      this.canvas.style.top = `calc(${this.position.y * 100}% + ${this._offset.y}px)`;
      this.canvas.style.pointerEvents = this._pointerEvents ? "auto" : "none";
      if (this._pointerEvents) {
        let hit: { node: UI; coords: THREE.Vector3 } | undefined;
        const canvas = this.canvas;
        const world = this.ctx!;
        const onPointerEnter = (_e: PointerEvent) => {
          hit = {
            node: this,
            coords: v5.set(0, 0, 0),
          };
          (
            world as { pointer?: { setScreenHit: (hit: unknown) => void } }
          ).pointer?.setScreenHit(hit);
        };
        const onPointerMove = (e: PointerEvent) => {
          if (!hit) return;
          const rect = canvas.getBoundingClientRect();
          const x = (e.clientX - rect.left) * this._res;
          const y = (e.clientY - rect.top) * this._res;
          hit.coords.x = x;
          hit.coords.y = y;
        };
        const onPointerLeave = (_e: PointerEvent) => {
          hit = undefined;
          (
            world as { pointer?: { setScreenHit: (hit: null) => void } }
          ).pointer?.setScreenHit(null);
        };
        canvas.addEventListener("pointerenter", onPointerEnter);
        canvas.addEventListener("pointermove", onPointerMove);
        canvas.addEventListener("pointerleave", onPointerLeave);
        this.cleanupPointer = () => {
          if (hit)
            (
              world as { pointer?: { setScreenHit: (hit: null) => void } }
            ).pointer?.setScreenHit(null);
          canvas.removeEventListener("pointerenter", onPointerEnter);
          canvas.removeEventListener("pointermove", onPointerMove);
          canvas.removeEventListener("pointerleave", onPointerLeave);
        };
      }
      (
        this.ctx! as {
          pointer?: { ui?: { prepend: (canvas: HTMLCanvasElement) => void } };
        }
      ).pointer?.ui?.prepend(this.canvas);
    }
    this.needsRebuild = false;
  }

  unbuild() {
    if (this.mesh) {
      this.ctx!.stage.scene.remove(this.mesh);
      this.texture?.dispose();
      if (this.mesh.material) {
        if (Array.isArray(this.mesh.material)) {
          this.mesh.material.forEach((m) => m.dispose());
        } else {
          this.mesh.material.dispose();
        }
      }
      this.mesh.geometry?.dispose();
      this.mesh = null;
      this.canvas = null;
      if (this.sItem) {
        this.ctx!.stage.octree.remove(this.sItem);
        this.sItem = null;
      }
      this.ctx!.setHot(this, false);
    }
    if (this.canvas) {
      (
        this.ctx! as {
          pointer?: {
            ui?: { removeChild: (canvas: HTMLCanvasElement) => void };
          };
        }
      ).pointer?.ui?.removeChild(this.canvas);
      this.canvas = null;
    }
    if (this.cleanupPointer) {
      this.cleanupPointer();
      this.cleanupPointer = null;
    }
  }

  draw() {
    if (!isBrowser) return;
    if (!this.yogaNode) {
      console.warn(
        "UI.draw() called on unmounted or improperly initialized UI element",
      );
      return;
    }
    const node = this.yogaNode;
    node.calculateLayout(
      this._width * this._res,
      this._height * this._res,
      Yoga.DIRECTION_LTR,
    );
    const ctx = this.canvasCtx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this._width * this._res, this._height * this._res);
    const left = node.getComputedLeft();
    const top = node.getComputedTop();
    const width = node.getComputedWidth();
    const height = node.getComputedHeight();
    if (this._backgroundColor && ctx) {
      // when theres a border, slightly inset to prevent bleeding
      const inset = this._borderColor && this._borderWidth ? 1 * this._res : 0;
      const radius = Math.max(
        0,
        (typeof this._borderRadius === "number"
          ? this._borderRadius
          : this._borderRadius[0]) *
          this._res -
          inset,
      );
      const insetLeft = left + inset;
      const insetTop = top + inset;
      const insetWidth = width - inset * 2;
      const insetHeight = height - inset * 2;
      fillRoundRect(
        ctx,
        insetLeft,
        insetTop,
        insetWidth,
        insetHeight,
        radius,
        this._backgroundColor,
      );
    }
    if (this._borderWidth && this._borderColor && ctx) {
      const radius =
        (typeof this._borderRadius === "number"
          ? this._borderRadius
          : this._borderRadius[0]) * this._res;
      const thickness = this._borderWidth * this._res;
      ctx.strokeStyle = this._borderColor;
      ctx.lineWidth = thickness;
      if (this._borderRadius) {
        borderRoundRect(ctx, left, top, width, height, radius, thickness);
      } else {
        const insetLeft = left + thickness / 2;
        const insetTop = top + thickness / 2;
        const insetWidth = width - thickness;
        const insetHeight = height - thickness;
        ctx.strokeRect(insetLeft, insetTop, insetWidth, insetHeight);
      }
    }
    this.box = { left, top, width, height };
    this.children.forEach((child) => {
      const drawable = child as {
        draw?: (
          ctx: CanvasRenderingContext2D,
          left: number,
          top: number,
        ) => void;
      };
      if (drawable.draw) {
        drawable.draw(ctx, left, top);
      }
    });
    if (this.texture) this.texture.needsUpdate = true;
    this.needsRedraw = false;
  }

  mount() {
    if (this.ctx?.network?.isServer) return;
    const parentUI = (this.parent as Node & { ui?: unknown })?.ui;
    if (parentUI)
      return console.error("ui: cannot be nested inside another ui");
    this.yogaNode = Yoga.Node.create();
    const node = this.yogaNode;
    node.setWidth(this._width * this._res);
    node.setHeight(this._height * this._res);
    node.setBorder(Yoga.EDGE_ALL, this._borderWidth * this._res);
    if (isArray(this._padding)) {
      const [top, right, bottom, left] = this._padding as number[];
      node.setPadding(Yoga.EDGE_TOP, top * this._res);
      node.setPadding(Yoga.EDGE_RIGHT, right * this._res);
      node.setPadding(Yoga.EDGE_BOTTOM, bottom * this._res);
      node.setPadding(Yoga.EDGE_LEFT, left * this._res);
    } else {
      node.setPadding(Yoga.EDGE_ALL, (this._padding as number) * this._res);
    }
    node.setFlexDirection(
      (FlexDirection as Record<string, number>)[this._flexDirection] || 0,
    );
    node.setJustifyContent(
      (JustifyContent as Record<string, number>)[this._justifyContent] || 0,
    );
    node.setAlignItems(
      (AlignItems as Record<string, number>)[this._alignItems] || 0,
    );
    node.setAlignContent(
      (AlignContent as Record<string, number>)[this._alignContent] || 0,
    );
    node.setFlexWrap((FlexWrap as Record<string, number>)[this._flexWrap] || 0);
    node.setGap(Yoga.GUTTER_ALL, this._gap * this._res);
    this.build();
    this.needsRedraw = true;
    this.setDirty();
  }

  commit(didMove: boolean) {
    if (this.ctx!.network.isServer) {
      return;
    }
    if (this.needsRebuild) {
      this.build();
    }
    if (this.needsRedraw) {
      this.draw();
    }
    if (didMove) {
      // if (this._billboard !== 'none') {
      //   v1.setFromMatrixPosition(this.matrixWorld)
      //   v2.setFromMatrixScale(this.matrixWorld)
      //   this.mesh.matrixWorld.compose(v1, iQuaternion, v2)
      // } else {
      //   this.mesh.matrixWorld.copy(this.matrixWorld)
      //   this.ctx?.stage.octree.move(this.sItem)
      // }
    }
  }

  fixedUpdate(_delta: number): void {
    // UI doesn't need fixed update logic
  }

  update(_delta: number): void {
    // UI doesn't need regular update logic
  }

  lateUpdate(_delta: number): void {
    if (this._space === "world" && this.mesh) {
      const world = this.ctx!;
      const camera = world.camera;
      const camPosition = v1.setFromMatrixPosition(camera.matrixWorld);
      const uiPosition = v2.setFromMatrixPosition(this.matrixWorld);
      const distance = camPosition.distanceTo(uiPosition);
      this.mesh.renderOrder = -distance; // Same ordering as particles

      const pos = v3;
      const qua = q1;
      const sca = v4;
      this.matrixWorld.decompose(
        pos as THREE.Vector3,
        qua,
        sca as THREE.Vector3,
      );
      if (this._billboard === "full") {
        // Full billboard matches camera rotation
        qua.copy(world.rig.quaternion);
      } else if (this._billboard === "y") {
        // Y-axis billboard matches camera y rotation only
        e1.setFromQuaternion(world.rig.quaternion);
        e1.x = 0;
        e1.z = 0;
        qua.setFromEuler(e1);
      }
      if (this._scaler) {
        const worldToScreenFactor = world.graphics?.worldToScreenFactor || 1;
        const [minDistance, maxDistance, baseScale = 1] = this._scaler;
        const clampedDistance = clamp(distance, minDistance, maxDistance);
        // calculate scale factor based on the distance
        // When distance is at min, scale is 1.0 (or some other base scale)
        // When distance is at max, scale adjusts proportionally
        const scaleFactor =
          (baseScale * (worldToScreenFactor * clampedDistance)) / this._size;
        sca.setScalar(scaleFactor);
      }
      this.matrixWorld.compose(pos as THREE.Vector3, qua, sca as THREE.Vector3);
      this.transform.position = pos;
      if (this.mesh) {
        this.mesh.matrixWorld.copy(this.matrixWorld);
        if (this.sItem) {
          world.stage.octree.move(this.sItem);
        }
      }
    }
  }

  postLateUpdate(_delta: number): void {
    // UI doesn't need post late update logic
  }

  unmount() {
    if (this.ctx!.network.isServer) return;
    this.unbuild();
    this.needsRebuild = false;
    this.needsRedraw = false;
    if (this.yogaNode) {
      this.yogaNode.free();
    }
    this.yogaNode = undefined;
    this.box = null;
  }

  rebuild() {
    this.needsRebuild = true;
    this.needsRedraw = true;
    this.setDirty();
  }

  redraw() {
    this.needsRedraw = true;
    this.setDirty();
  }

  copy(source: UI, recursive: boolean) {
    super.copy(source, recursive);
    this._space = source._space;
    this._width = source._width;
    this._height = source._height;
    this._size = source._size;
    this._res = source._res;

    this._lit = source._lit;
    this._doubleside = source._doubleside;
    this._billboard = source._billboard;
    this._pivot = source._pivot;
    this._offset = source._offset;
    this._scaler = source._scaler;
    this._pointerEvents = source._pointerEvents;

    this._transparent = source._transparent;
    this._backgroundColor = source._backgroundColor;
    this._borderWidth = source._borderWidth;
    this._borderColor = source._borderColor;
    this._borderRadius = source._borderRadius;
    this._padding = source._padding;
    this._flexDirection = source._flexDirection;
    this._justifyContent = source._justifyContent;
    this._alignItems = source._alignItems;
    this._alignContent = source._alignContent;
    this._flexWrap = source._flexWrap;
    this._gap = source._gap;
    return this;
  }

  resolveHit(
    hit:
      | UIRaycastHit
      | { coords?: { x: number; y: number }; point?: THREE.Vector3 }
      | null,
  ) {
    if (hit?.point && this.mesh && this.pivotOffset) {
      const inverseMatrix = m1.copy(this.mesh.matrixWorld).invert();
      // convert world hit point to canvas coordinates (0,0 is top left x,y)
      v1.copy(hit.point)
        .applyMatrix4(inverseMatrix)
        .multiplyScalar(1 / this._size);
      if (this.pivotOffset) {
        v1.sub(this.pivotOffset);
      }
      const x = v1.x * this._res;
      const y = -v1.y * this._res;
      return this.findNodeAt(x, y);
    }
    if (
      hit &&
      "coords" in hit &&
      hit.coords &&
      typeof hit.coords === "object"
    ) {
      const coords = hit.coords as { x: number; y: number };
      return this.findNodeAt(coords.x, coords.y);
    }
    return null;
  }

  findNodeAt(x: number, y: number): Node | null {
    const findHitNode = (
      node: UIHitTestNode,
      offsetX = 0,
      offsetY = 0,
    ): Node | null => {
      if (!node.box || node._display === "none") return null;
      const left = offsetX + node.box.left;
      const top = offsetY + node.box.top;
      const width = node.box.width;
      const height = node.box.height;
      if (x < left || x > left + width || y < top || y > top + height) {
        return null;
      }
      // Check children from front to back
      for (let i = node.children.length - 1; i >= 0; i--) {
        const childHit = findHitNode(node.children[i], offsetX, offsetY);
        if (childHit) return childHit;
      }
      return node;
    };
    return findHitNode(this);
  }

  createMaterial(
    lit: boolean,
    texture: THREE.Texture,
    transparent: boolean,
    doubleside: boolean,
  ) {
    // Use Node materials for WebGPU compatibility
    const material = lit
      ? new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
      : new MeshBasicNodeMaterial();
    material.color.set("white");
    material.transparent = transparent;
    // material.depthTest = true
    // material.depthWrite = false
    material.map = texture;
    material.side = doubleside ? THREE.DoubleSide : THREE.FrontSide;
    this.ctx!.setupMaterial(material);
    return material;
  }

  get space() {
    return this._space;
  }

  set space(value: string) {
    if (!value) value = defaults.space;
    if (!isSpace(value)) {
      throw new Error("[ui] space not valid");
    }
    if (this._space === value) return;
    this._space = value;
    this.rebuild();
  }

  get width() {
    return this._width;
  }

  set width(value: number) {
    if (!value && value !== 0) value = defaults.width;
    if (!isNumber(value)) {
      throw new Error("[ui] width not a number");
    }
    if (this._width === value) return;
    this._width = value;
    if (this.yogaNode) {
      this.yogaNode.setWidth(this._width * this._res);
    }
    this.rebuild();
  }

  get height() {
    return this._height;
  }

  set height(value: number) {
    if (!value && value !== 0) value = defaults.height;
    if (!isNumber(value)) {
      throw new Error("[ui] height not a number");
    }
    if (this._height === value) return;
    this._height = value;
    if (this.yogaNode) {
      this.yogaNode.setHeight(this._height * this._res);
    }
    this.rebuild();
  }

  get size() {
    return this._size;
  }

  set size(value: number) {
    if (!value && value !== 0) value = defaults.size;
    if (!isNumber(value)) {
      throw new Error("[ui] size not a number");
    }
    if (this._size === value) return;
    this._size = value;
    this.rebuild();
  }

  get res() {
    return this._res;
  }

  set res(value: number) {
    if (!value && value !== 0) value = defaults.res;
    if (!isNumber(value)) {
      throw new Error("[ui] res not a number");
    }
    if (this._res === value) return;
    this._res = value;
    this.rebuild();
  }

  get lit() {
    return this._lit;
  }

  set lit(value: boolean) {
    if (value === undefined || value === null) value = defaults.lit;
    if (!isBoolean(value)) {
      throw new Error("[ui] lit not a boolean");
    }
    if (this._lit === value) return;
    this._lit = value;
    this.rebuild();
  }

  get doubleside() {
    return this._doubleside;
  }

  set doubleside(value: boolean) {
    if (value === undefined || value === null) value = defaults.doubleside;
    if (!isBoolean(value)) {
      throw new Error("[ui] doubleside not a boolean");
    }
    if (this._doubleside === value) return;
    this._doubleside = value;
    this.rebuild();
  }

  get billboard() {
    return this._billboard;
  }

  set billboard(value: string) {
    if (!value) value = defaults.billboard;
    if (!isBillboard(value)) {
      throw new Error("[ui] billboard not valid");
    }
    if (this._billboard === value) return;
    this._billboard = value;
  }

  get pivot() {
    return this._pivot;
  }

  set pivot(value: string) {
    if (!value) value = defaults.pivot;
    if (!isPivot(value)) {
      throw new Error("[ui] pivot not valid");
    }
    if (this._pivot === value) return;
    this._pivot = value;
    this.rebuild();
  }

  get offset() {
    return this._offset;
  }

  set offset(value: THREE.Vector3 | number[]) {
    if (!value) return;
    if (Array.isArray(value)) {
      this._offset.fromArray(value);
    } else {
      this._offset.copy(value);
    }
    this.rebuild();
  }

  get scaler() {
    return this._scaler;
  }

  set scaler(value: number[] | null) {
    if (value === undefined) value = defaults.scaler;
    if (value && !isScaler(value)) {
      throw new Error("[ui] scaler not valid");
    }
    this._scaler = value as [number, number] | [number, number, number] | null;
  }

  get pointerEvents() {
    return this._pointerEvents;
  }

  set pointerEvents(value: boolean) {
    if (value === undefined || value === null) value = defaults.pointerEvents;
    if (!isBoolean(value)) {
      throw new Error("[ui] pointerEvents not a boolean");
    }
    if (this._pointerEvents === value) return;
    this._pointerEvents = value;
    this.rebuild();
  }

  get transparent() {
    return this._transparent;
  }

  set transparent(value: boolean) {
    if (value === undefined || value === null) value = defaults.transparent;
    if (!isBoolean(value)) {
      throw new Error("[ui] transparent not a boolean");
    }
    if (this._transparent === value) return;
    this._transparent = value;
    this.rebuild();
  }

  get backgroundColor() {
    return this._backgroundColor;
  }

  set backgroundColor(value: string | null) {
    if (value === undefined) value = defaults.backgroundColor;
    if (value && !isString(value)) {
      throw new Error("[ui] backgroundColor not a string");
    }
    if (this._backgroundColor === value) return;
    this._backgroundColor = value;
    this.redraw();
  }

  get borderWidth() {
    return this._borderWidth;
  }

  set borderWidth(value: number) {
    if (!value && value !== 0) value = defaults.borderWidth;
    if (!isNumber(value)) {
      throw new Error("[ui] borderWidth not a number");
    }
    if (this._borderWidth === value) return;
    this._borderWidth = value;
    this.redraw();
  }

  get borderColor() {
    return this._borderColor;
  }

  set borderColor(value: string | null) {
    if (value === undefined) value = defaults.borderColor;
    if (value && !isString(value)) {
      throw new Error("[ui] borderColor not a string");
    }
    if (this._borderColor === value) return;
    this._borderColor = value;
    this.redraw();
  }

  get borderRadius(): number {
    return typeof this._borderRadius === "number"
      ? this._borderRadius
      : this._borderRadius[0];
  }

  set borderRadius(value: number) {
    if (!value && value !== 0) value = defaults.borderRadius;
    if (!isNumber(value)) {
      throw new Error("[ui] borderRadius not a number");
    }
    if (this._borderRadius === value) return;
    this._borderRadius = value;
    this.redraw();
  }

  get padding() {
    return this._padding;
  }

  set padding(value: number | number[]) {
    if (value === undefined || value === null) value = defaults.padding;
    if (!isNumber(value) && !isArray(value)) {
      throw new Error("[ui] padding not a number or array");
    }
    if (isArray(value) && !every(value, isNumber)) {
      throw new Error("[ui] padding array values not all numbers");
    }
    if (this._padding === value) return;
    this._padding = value;
    if (this.yogaNode) {
      const node = this.yogaNode;
      if (isArray(this._padding)) {
        const [top, right, bottom, left] = this._padding as number[];
        node.setPadding(Yoga.EDGE_TOP, top * this._res);
        node.setPadding(Yoga.EDGE_RIGHT, right * this._res);
        node.setPadding(Yoga.EDGE_BOTTOM, bottom * this._res);
        node.setPadding(Yoga.EDGE_LEFT, left * this._res);
      } else {
        node.setPadding(Yoga.EDGE_ALL, this._padding * this._res);
      }
    }
    this.redraw();
  }

  get flexDirection() {
    return this._flexDirection;
  }

  set flexDirection(value: string) {
    if (!value) value = defaults.flexDirection;
    if (!isFlexDirection(value)) {
      throw new Error("[ui] flexDirection not valid");
    }
    if (this._flexDirection === value) return;
    this._flexDirection = value;
    if (this.yogaNode) {
      this.yogaNode.setFlexDirection(
        (FlexDirection as Record<string, number>)[this._flexDirection] || 0,
      );
    }
    this.redraw();
  }

  get justifyContent() {
    return this._justifyContent;
  }

  set justifyContent(value: string) {
    if (!value) value = defaults.justifyContent;
    if (!isJustifyContent(value)) {
      throw new Error("[ui] justifyContent not valid");
    }
    if (this._justifyContent === value) return;
    this._justifyContent = value;
    if (this.yogaNode) {
      this.yogaNode.setJustifyContent(
        (JustifyContent as Record<string, number>)[this._justifyContent] || 0,
      );
    }
    this.redraw();
  }

  get alignItems() {
    return this._alignItems;
  }

  set alignItems(value: string) {
    if (!value) value = defaults.alignItems;
    if (!isAlignItem(value)) {
      throw new Error("[ui] alignItems not valid");
    }
    if (this._alignItems === value) return;
    this._alignItems = value;
    if (this.yogaNode) {
      this.yogaNode.setAlignItems(
        (AlignItems as Record<string, number>)[this._alignItems] || 0,
      );
    }
    this.redraw();
  }

  get alignContent() {
    return this._alignContent;
  }

  set alignContent(value: string) {
    if (!value) value = defaults.alignContent;
    if (!isAlignContent(value)) {
      throw new Error("[ui] alignContent not valid");
    }
    if (this._alignContent === value) return;
    this._alignContent = value;
    if (this.yogaNode) {
      this.yogaNode.setAlignContent(
        (AlignContent as Record<string, number>)[this._alignContent] || 0,
      );
    }
    this.redraw();
  }

  get flexWrap() {
    return this._flexWrap;
  }

  set flexWrap(value: string) {
    if (!value) value = defaults.flexWrap;
    if (!isFlexWrap(value)) {
      throw new Error("[ui] flexWrap not valid");
    }
    if (this._flexWrap === value) return;
    this._flexWrap = value;
    if (this.yogaNode) {
      this.yogaNode.setFlexWrap(
        (FlexWrap as Record<string, number>)[this._flexWrap] || 0,
      );
    }
    this.redraw();
  }

  get gap() {
    return this._gap;
  }

  set gap(value: number) {
    if (!value && value !== 0) value = defaults.gap;
    if (!isNumber(value)) {
      throw new Error("[ui] gap not a number");
    }
    if (this._gap === value) return;
    this._gap = value;
    if (this.yogaNode) {
      this.yogaNode.setGap(Yoga.GUTTER_ALL, this._gap * this._res);
    }
    this.redraw();
  }

  getProxy() {
    if (!this.proxy) {
      const self = this;
      let proxy = {
        get space() {
          return self.space;
        },
        set space(value) {
          self.space = value;
        },
        get width() {
          return self.width;
        },
        set width(value) {
          self.width = value;
        },
        get height() {
          return self.height;
        },
        set height(value) {
          self.height = value;
        },
        get size() {
          return self.size;
        },
        set size(value) {
          self.size = value;
        },
        get res() {
          return self.res;
        },
        set res(value) {
          self.res = value;
        },
        get lit() {
          return self.lit;
        },
        set lit(value) {
          self.lit = value;
        },
        get doubleside() {
          return self.doubleside;
        },
        set doubleside(value) {
          self.doubleside = value;
        },
        get billboard() {
          return self.billboard;
        },
        set billboard(value) {
          self.billboard = value;
        },
        get pivot() {
          return self.pivot;
        },
        set pivot(value) {
          self.pivot = value;
        },
        get offset() {
          return self.offset;
        },
        set offset(value) {
          self.offset = value;
        },
        get scaler() {
          return self.scaler;
        },
        set scaler(value) {
          self.scaler = value;
        },
        get pointerEvents() {
          return self.pointerEvents;
        },
        set pointerEvents(value) {
          self.pointerEvents = value;
        },
        get transparent() {
          return self.transparent;
        },
        set transparent(value) {
          self.transparent = value;
        },
        get backgroundColor() {
          return self.backgroundColor;
        },
        set backgroundColor(value) {
          self.backgroundColor = value;
        },
        get borderWidth() {
          return self.borderWidth;
        },
        set borderWidth(value) {
          self.borderWidth = value;
        },
        get borderColor() {
          return self.borderColor;
        },
        set borderColor(value) {
          self.borderColor = value;
        },
        get borderRadius() {
          return self.borderRadius;
        },
        set borderRadius(value) {
          self.borderRadius = value;
        },
        get padding() {
          return self.padding;
        },
        set padding(value) {
          self.padding = value;
        },
        get flexDirection() {
          return self.flexDirection;
        },
        set flexDirection(value) {
          self.flexDirection = value;
        },
        get justifyContent() {
          return self.justifyContent;
        },
        set justifyContent(value) {
          self.justifyContent = value;
        },
        get alignItems() {
          return self.alignItems;
        },
        set alignItems(value) {
          self.alignItems = value;
        },
        get alignContent() {
          return self.alignContent;
        },
        set alignContent(value) {
          self.alignContent = value;
        },
        get flexWrap() {
          return self.flexWrap;
        },
        set flexWrap(value) {
          self.flexWrap = value;
        },
        get gap() {
          return self.gap;
        },
        set gap(value) {
          self.gap = value;
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

function pivotGeometry(
  pivot: string,
  geometry: THREE.BufferGeometry,
  width: number,
  height: number,
) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  switch (pivot) {
    case "top-left":
      geometry.translate(halfWidth, -halfHeight, 0);
      break;
    case "top-center":
      geometry.translate(0, -halfHeight, 0);
      break;
    case "top-right":
      geometry.translate(-halfWidth, -halfHeight, 0);
      break;
    case "center-left":
      geometry.translate(halfWidth, 0, 0);
      break;
    case "center-right":
      geometry.translate(-halfWidth, 0, 0);
      break;
    case "bottom-left":
      geometry.translate(halfWidth, halfHeight, 0);
      break;
    case "bottom-center":
      geometry.translate(0, halfHeight, 0);
      break;
    case "bottom-right":
      geometry.translate(-halfWidth, halfHeight, 0);
      break;
    case "center":
    default:
      break;
  }
}

function pivotCanvas(
  pivot: string,
  canvas: HTMLCanvasElement,
  _width: number,
  _height: number,
) {
  // const halfWidth = width / 2
  // const halfHeight = height / 2
  switch (pivot) {
    case "top-left":
      canvas.style.transform = `translate(0%, 0%)`;
      break;
    case "top-center":
      canvas.style.transform = `translate(-50%, 0%)`;
      break;
    case "top-right":
      canvas.style.transform = `translate(-100%, 0%)`;
      break;
    case "center-left":
      canvas.style.transform = `translate(0%, -50%)`;
      break;
    case "center-right":
      canvas.style.transform = `translate(-100%, -50%)`;
      break;
    case "bottom-left":
      canvas.style.transform = `translate(0%, -100%)`;
      break;
    case "bottom-center":
      canvas.style.transform = `translate(-50%, -100%)`;
      break;
    case "bottom-right":
      canvas.style.transform = `translate(-100%, -100%)`;
      break;
    case "center":
    default:
      canvas.style.transform = `translate(-50%, -50%)`;
      break;
  }
}

function isBillboard(value: string) {
  return billboards.includes(value);
}

function isPivot(value: string) {
  return pivots.includes(value);
}

function isSpace(value: string) {
  return spaces.includes(value);
}

// pivotOffset == ( - pivotX, - pivotY )
// i.e., the negative of whatever pivotGeometry just did.
function getPivotOffset(pivot: string, width: number, height: number) {
  // The top-left corner is originally (-halfW, +halfH).
  // Then pivotGeometry adds the following translation:
  const halfW = width / 2;
  const halfH = height / 2;
  let tx = 0,
    ty = 0;
  switch (pivot) {
    case "top-left":
      tx = +halfW;
      ty = -halfH;
      break;
    case "top-center":
      tx = 0;
      ty = -halfH;
      break;
    case "top-right":
      tx = -halfW;
      ty = -halfH;
      break;
    case "center-left":
      tx = +halfW;
      ty = 0;
      break;
    case "center-right":
      tx = -halfW;
      ty = 0;
      break;
    case "bottom-left":
      tx = +halfW;
      ty = +halfH;
      break;
    case "bottom-center":
      tx = 0;
      ty = +halfH;
      break;
    case "bottom-right":
      tx = -halfW;
      ty = +halfH;
      break;
    case "center":
    default:
      tx = 0;
      ty = 0;
      break;
  }

  // So the final local coordinate of top-left corner is:
  //   originalTopLeft + pivotTranslation
  // = (-halfW + tx, +halfH + ty)
  return new THREE.Vector2(-halfW + tx, +halfH + ty);
}

function _isEdge(value: unknown) {
  if (isNumber(value)) {
    return true;
  }
  if (isArray(value)) {
    return value.length === 4 && every(value, (n) => isNumber(n));
  }
  return false;
}

function isScaler(value: unknown) {
  return isArray(value) && isNumber(value[0]) && isNumber(value[1]);
}
