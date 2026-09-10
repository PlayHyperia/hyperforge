/// <reference path="../../types/rendering/webgpu-attribute-utils.d.ts" />

import WebGPUAttributeUtils from "three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js";
import type {
  BufferAttribute,
  InterleavedBuffer,
  InterleavedBufferAttribute,
} from "three";

type BufferAttributeLike = BufferAttribute | InterleavedBufferAttribute;
type UploadBufferAttribute = (BufferAttribute | InterleavedBuffer) & {
  name?: string;
};

interface BufferDataLike {
  buffer?: GPUBuffer;
}

interface WebGPUAttributeUtilsLike {
  backend: {
    device: GPUDevice;
    get: (attribute: UploadBufferAttribute) => BufferDataLike;
  };
  _getBufferAttribute: (
    attribute: BufferAttributeLike,
  ) => UploadBufferAttribute;
  createAttribute: (
    attribute: BufferAttributeLike,
    usage: GPUBufferUsageFlags,
  ) => void;
}

const WEBGPU_ATTRIBUTE_UPLOAD_PATCH = Symbol(
  "hyperia.webgpuAttributeUploadPatch",
);
let loggedFallbackCount = 0;

export function alignWebGPUBufferSize(size: number): number {
  return size + ((4 - (size % 4)) % 4);
}

function isMappedAtCreationCreateBufferFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("createBuffer failed") &&
    message.includes("mappedAtCreation")
  );
}

export function installWebGPUAttributeUploadFallback(): void {
  const prototype =
    WebGPUAttributeUtils.prototype as WebGPUAttributeUtilsLike & {
      [WEBGPU_ATTRIBUTE_UPLOAD_PATCH]?: boolean;
    };

  if (prototype[WEBGPU_ATTRIBUTE_UPLOAD_PATCH] === true) {
    return;
  }

  const originalCreateAttribute = prototype.createAttribute;

  prototype.createAttribute = function (
    this: WebGPUAttributeUtilsLike,
    attribute: BufferAttributeLike,
    usage: GPUBufferUsageFlags,
  ): void {
    try {
      originalCreateAttribute.call(this, attribute, usage);
      return;
    } catch (error) {
      if (!isMappedAtCreationCreateBufferFailure(error)) {
        throw error;
      }

      const bufferAttribute = this._getBufferAttribute(attribute);
      const bufferData = this.backend.get(bufferAttribute);

      if (bufferData.buffer !== undefined) {
        return;
      }

      const array = bufferAttribute.array;
      const buffer = this.backend.device.createBuffer({
        label: bufferAttribute.name,
        size: alignWebGPUBufferSize(array.byteLength),
        usage: usage | GPUBufferUsage.COPY_DST,
      });

      this.backend.device.queue.writeBuffer(
        buffer,
        0,
        array.buffer as ArrayBuffer,
        array.byteOffset,
        array.byteLength,
      );
      bufferData.buffer = buffer;

      if (loggedFallbackCount < 3) {
        loggedFallbackCount += 1;
        console.warn(
          `[WebGPUUploadFallback] Replaced mappedAtCreation upload for ${bufferAttribute.name || "unnamed-attribute"} (${array.byteLength} bytes)`,
        );
      }
    }
  };

  prototype[WEBGPU_ATTRIBUTE_UPLOAD_PATCH] = true;
}
