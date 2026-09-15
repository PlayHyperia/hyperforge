import * as bufferModule from "buffer";

type BufferModuleLike = {
  Buffer?: typeof globalThis.Buffer;
  SlowBuffer?: typeof globalThis.Buffer;
  INSPECT_MAX_BYTES?: number;
  kMaxLength?: number;
};

const resolved = (bufferModule as unknown as BufferModuleLike).Buffer
  ? (bufferModule as unknown as BufferModuleLike)
  : ((bufferModule as unknown as { default?: BufferModuleLike }).default ??
    (bufferModule as unknown as BufferModuleLike));

export const Buffer = resolved.Buffer ?? globalThis.Buffer;
export const SlowBuffer = resolved.SlowBuffer ?? Buffer;
export const INSPECT_MAX_BYTES = resolved.INSPECT_MAX_BYTES ?? 50;
export const kMaxLength = resolved.kMaxLength ?? Number.MAX_SAFE_INTEGER;

// Inject Buffer global for libraries that expect it (Solana, crypto, bn.js).
// Previously handled by vite-plugin-node-polyfills, which is incompatible with vite 8.
(globalThis as Record<string, unknown>).Buffer = Buffer;

export default resolved;
