import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function isMaterializedStats(stats, expectedSize = stats.size) {
  if (!stats.isFile() || stats.size !== expectedSize) {
    return false;
  }

  // APFS/iCloud placeholders report their logical size while owning no local
  // blocks. Reading one can block indefinitely while FileProvider downloads it.
  return stats.size === 0 || stats.blocks > 0;
}

export function inspectMaterializedFile(filePath, expectedSize) {
  if (!existsSync(filePath)) {
    return { ready: false, reason: "missing" };
  }

  const stats = statSync(filePath);
  if (!stats.isFile()) {
    return { ready: false, reason: "not-a-file" };
  }
  if (expectedSize !== undefined && stats.size !== expectedSize) {
    return { ready: false, reason: "size-mismatch", size: stats.size };
  }
  if (!isMaterializedStats(stats, expectedSize ?? stats.size)) {
    return { ready: false, reason: "not-materialized", size: stats.size };
  }

  return { ready: true, size: stats.size };
}

export function copyPrebuiltFiles(files, { log = console } = {}) {
  const plans = files.map(({ src, dest }) => {
    const source = inspectMaterializedFile(src);
    if (source.reason === "missing") {
      throw new Error(`Prebuilt file not found: ${src}`);
    }
    if (source.reason === "not-a-file") {
      throw new Error(`Prebuilt source is not a file: ${src}`);
    }

    return {
      src,
      dest,
      source,
      destination: inspectMaterializedFile(dest, source.size),
    };
  });

  const pending = plans.filter(({ destination }) => !destination.ready);
  if (pending.length === 0) {
    log.log(
      "PhysX prebuilt files are materialized and current; skipping copy.",
    );
    return { copied: 0, skipped: plans.length };
  }

  for (const { src, source } of pending) {
    if (!source.ready) {
      throw new Error(
        `Prebuilt source is not locally materialized: ${src}. ` +
          "Download the source file before rebuilding PhysX.",
      );
    }
  }

  let copied = 0;
  for (const { src, dest, source, destination } of pending) {
    mkdirSync(dirname(dest), { recursive: true });
    const temporaryPath = join(
      dirname(dest),
      `.${basename(dest)}.copy-prebuilt-${process.pid}-${Date.now()}-${copied}.tmp`,
    );

    try {
      copyFileSync(src, temporaryPath);
      const temporary = inspectMaterializedFile(temporaryPath, source.size);
      if (!temporary.ready) {
        throw new Error(
          `Copied PhysX artifact failed local materialization validation: ${temporaryPath}`,
        );
      }
      renameSync(temporaryPath, dest);
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }

    copied += 1;
    log.log(`Copied ${src} -> ${dest} (${destination.reason}).`);
  }

  return { copied, skipped: plans.length - copied };
}
