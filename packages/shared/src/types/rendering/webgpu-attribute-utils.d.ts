/** Narrow declaration for the Three.js internal upload API used by our patch. */
declare module "three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js" {
  import type {
    BufferAttribute,
    InterleavedBuffer,
    InterleavedBufferAttribute,
  } from "three";
  import type WebGPUBackend from "three/src/renderers/webgpu/WebGPUBackend.js";

  export default class WebGPUAttributeUtils {
    constructor(backend: WebGPUBackend);
    backend: WebGPUBackend & {
      device: GPUDevice;
      get(attribute: object): { buffer?: GPUBuffer };
    };
    createAttribute(
      attribute: BufferAttribute | InterleavedBufferAttribute,
      usage: GPUBufferUsageFlags,
    ): void;
    _getBufferAttribute(
      attribute: BufferAttribute | InterleavedBufferAttribute,
    ): BufferAttribute | InterleavedBuffer;
  }
}
