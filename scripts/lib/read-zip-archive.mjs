import { inflateRawSync, crc32 } from "node:zlib";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK_TYPE = 0o120000;

function fail(label, message) {
  throw new Error(`${label}: ${message}`);
}

function assertRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    fail(label, "ZIP range is outside the archive");
  }
}

function decodeEntryName(bytes, flags, label) {
  if ((flags & 0x0800) === 0 && bytes.some((value) => value > 0x7f)) {
    fail(label, "non-UTF-8 entry names are unsupported");
  }
  const name = bytes.toString("utf8");
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/u.test(name)
  ) {
    fail(label, `unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  const components = name.split("/");
  if (components.some((component) => component === "." || component === "..")) {
    fail(label, `unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  return name;
}

function findEndOfCentralDirectory(buffer, label) {
  const minimumOffset = Math.max(0, buffer.length - MAX_COMMENT_BYTES - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  fail(label, "end-of-central-directory record is missing");
}

export function readZipArchive(buffer, label = "ZIP archive") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    fail(label, "input is not a complete ZIP archive");
  }

  const endOffset = findEndOfCentralDirectory(buffer, label);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDiskNumber = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDiskNumber !== 0 ||
    diskEntries !== entryCount
  ) {
    fail(label, "multi-disk ZIP archives are unsupported");
  }
  if (
    entryCount === ZIP64_SENTINEL_16 ||
    centralSize === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32
  ) {
    fail(label, "ZIP64 archives are unsupported");
  }
  assertRange(buffer, centralOffset, centralSize, label);
  if (centralOffset + centralSize > endOffset) {
    fail(label, "central directory overlaps the end record");
  }

  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(buffer, offset, 46, label);
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      fail(label, `central entry ${index} has an invalid signature`);
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const expectedCrc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const startDisk = buffer.readUInt16LE(offset + 34);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (
      compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32 ||
      localOffset === ZIP64_SENTINEL_32
    ) {
      fail(label, "ZIP64 entries are unsupported");
    }
    if (startDisk !== 0) fail(label, "multi-disk ZIP entry is unsupported");
    if ((flags & 0x0001) !== 0)
      fail(label, "encrypted ZIP entry is unsupported");
    if (compression !== 0 && compression !== 8) {
      fail(label, `unsupported ZIP compression method ${compression}`);
    }

    const variableLength = nameLength + extraLength + commentLength;
    assertRange(buffer, offset + 46, variableLength, label);
    const name = decodeEntryName(
      buffer.subarray(offset + 46, offset + 46 + nameLength),
      flags,
      label,
    );
    if (entries.has(name)) fail(label, `duplicate ZIP entry: ${name}`);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE) {
      fail(label, `symbolic-link ZIP entry is unsupported: ${name}`);
    }

    assertRange(buffer, localOffset, 30, label);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE) {
      fail(label, `local entry has an invalid signature: ${name}`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localCompression = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    if (localFlags !== flags || localCompression !== compression) {
      fail(label, `central/local metadata mismatch: ${name}`);
    }
    assertRange(
      buffer,
      localOffset + 30,
      localNameLength + localExtraLength,
      label,
    );
    const localName = decodeEntryName(
      buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      flags,
      label,
    );
    if (localName !== name) fail(label, `central/local name mismatch: ${name}`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assertRange(buffer, dataOffset, compressedSize, label);

    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data =
      compression === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) {
      fail(label, `uncompressed size mismatch: ${name}`);
    }
    if (crc32(data) >>> 0 !== expectedCrc32) {
      fail(label, `CRC-32 mismatch: ${name}`);
    }
    entries.set(name, {
      name,
      directory: name.endsWith("/"),
      compressedSize,
      uncompressedSize,
      data,
    });
    offset += 46 + variableLength;
  }
  if (offset !== centralOffset + centralSize) {
    fail(label, "central directory size does not match its entries");
  }

  return {
    entries,
    entryCount,
    fileCount: [...entries.values()].filter((entry) => !entry.directory).length,
  };
}
