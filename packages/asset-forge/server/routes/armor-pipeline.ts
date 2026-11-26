/**
 * Armor Pipeline Routes — POC-2 + Publish-to-Game
 *
 * Endpoints for shell texture generation via Meshy AI
 * and publishing rigged armor to the game's model directory.
 */

import { Elysia, t } from "elysia";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ShellTextureService } from "../services/armor-pipeline/ShellTextureService";
import {
  ArmorPublishValidationError,
  validatePublishedArmorGlb,
} from "../services/armor-pipeline/DuelFitMetadata";

/** Only allow alphanumeric, hyphens, and underscores in path segments */
const SAFE_PATH_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate that a URL uses HTTPS and is not a private/internal address */
function isValidPublicUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "https:") return false;

    // Block private/internal IP ranges to prevent SSRF
    const host = url.hostname;
    // Strip IPv6 mapped prefix for consistent checks (e.g. ::ffff:127.0.0.1 → 127.0.0.1)
    const bareHost = host.replace(/^::ffff:/, "");
    if (
      bareHost === "localhost" ||
      bareHost.startsWith("127.") ||
      bareHost.startsWith("0.") ||
      bareHost === "::1" ||
      bareHost === "0.0.0.0" ||
      bareHost.startsWith("10.") ||
      bareHost.startsWith("192.168.") ||
      bareHost.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(bareHost) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(bareHost) // CGN (100.64.0.0/10)
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function parseBonuses(raw: string | undefined): Record<string, number> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.entries(parsed).some(
        ([key, value]) =>
          !SAFE_PATH_RE.test(key) ||
          typeof value !== "number" ||
          !Number.isFinite(value),
      )
    ) {
      return null;
    }
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

async function writeFileAtomically(
  targetPath: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export const createArmorPipelineRoutes = (
  shellTextureService: ShellTextureService,
) => {
  return (
    new Elysia({ prefix: "/api/armor-pipeline", name: "armor-pipeline" })

      // Upload shell GLB + start Meshy retexture in one step
      // Sends the GLB to Meshy as a base64 data URI (no public URL needed)
      .post(
        "/texture-shell",
        async ({ body, set }) => {
          if (!shellTextureService.isConfigured) {
            set.status = 503;
            return { success: false, error: "MESHY_API_KEY not configured" };
          }

          try {
            const file = body.file;
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const filename = body.name || `shell_${Date.now()}.glb`;

            // Save locally + get base64 data URI
            const { dataUri } = await shellTextureService.saveShellGLB(
              buffer,
              filename,
            );

            // Start Meshy retexture with data URI
            const enablePBR = body.enablePBR === "true";
            // preserveUV=false: let Meshy generate new UVs.
            // Avatar UVs map to a skin texture atlas which biases Meshy to paint skin/clothing.
            // New UVs treat the shell as a generic 3D object → correct armor textures.
            const preserveUV = body.preserveUV === "true";
            const taskId = await shellTextureService.startTextureTask(
              dataUri,
              body.prompt,
              {
                preserveUV,
                enablePBR,
                aiModel: body.aiModel || "meshy-6",
                styleImageUrl:
                  body.styleImageUrl && isValidPublicUrl(body.styleImageUrl)
                    ? body.styleImageUrl
                    : undefined,
              },
            );

            return {
              success: true,
              taskId,
              sizeKB: Math.round(buffer.length / 1024),
            };
          } catch (err) {
            set.status = 500;
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        {
          body: t.Object({
            file: t.File({ maxSize: "20m" }),
            prompt: t.String(),
            name: t.Optional(t.String()),
            aiModel: t.Optional(t.String()),
            enablePBR: t.Optional(t.String()),
            preserveUV: t.Optional(t.String()),
            styleImageUrl: t.Optional(t.String()),
          }),
          detail: {
            tags: ["Armor Pipeline"],
            summary: "Upload shell GLB and start AI texture generation",
          },
        },
      )

      // Upload shell GLB + start multiple Meshy retexture tasks (one per tier)
      // Shell is uploaded/encoded once and reused for all tier prompts
      .post(
        "/texture-shell-batch",
        async ({ body, set }) => {
          if (!shellTextureService.isConfigured) {
            set.status = 503;
            return { success: false, error: "MESHY_API_KEY not configured" };
          }

          try {
            const file = body.file;
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const filename = body.name || `shell_batch_${Date.now()}.glb`;

            // Save locally + get base64 data URI (once)
            const { dataUri } = await shellTextureService.saveShellGLB(
              buffer,
              filename,
            );

            let tiers: {
              tierId: string;
              prompt: string;
              /** Per-tier style reference image URL for color consistency */
              styleImageUrl?: string;
            }[];
            try {
              tiers = JSON.parse(body.tiers);
            } catch {
              set.status = 400;
              return { success: false, error: "Invalid tiers JSON" };
            }
            if (!Array.isArray(tiers) || tiers.length === 0) {
              set.status = 400;
              return {
                success: false,
                error: "tiers must be a non-empty array",
              };
            }
            // Validate each tier has required fields
            for (let i = 0; i < tiers.length; i++) {
              const tier = tiers[i];
              if (
                !tier ||
                typeof tier.tierId !== "string" ||
                !tier.tierId ||
                typeof tier.prompt !== "string" ||
                !tier.prompt
              ) {
                set.status = 400;
                return {
                  success: false,
                  error: `tiers[${i}] must have non-empty "tierId" and "prompt" string fields`,
                };
              }
            }
            if (tiers.length > 10) {
              set.status = 400;
              return { success: false, error: "Maximum 10 tiers per batch" };
            }
            const aiModel = body.aiModel || "meshy-6";
            const enablePBR = body.enablePBR === "true";
            // Global fallback style image (used when tiers don't specify their own)
            const globalStyleImageUrl =
              body.styleImageUrl && isValidPublicUrl(body.styleImageUrl)
                ? body.styleImageUrl
                : undefined;

            // Start tasks sequentially with a small delay to avoid Meshy 504s
            // (each request sends the full ~6MB base64 payload)
            const results: { tierId: string; taskId: string }[] = [];
            for (let i = 0; i < tiers.length; i++) {
              const tier = tiers[i];
              if (i > 0) {
                await new Promise((r) => setTimeout(r, 2000));
              }
              // Per-tier style image takes precedence over global fallback
              const rawTierStyle = tier.styleImageUrl || globalStyleImageUrl;
              const tierStyleUrl =
                rawTierStyle && isValidPublicUrl(rawTierStyle)
                  ? rawTierStyle
                  : undefined;
              const preserveUV = body.preserveUV === "true";
              const taskId = await shellTextureService.startTextureTask(
                dataUri,
                tier.prompt,
                { preserveUV, enablePBR, aiModel, styleImageUrl: tierStyleUrl },
              );
              results.push({ tierId: tier.tierId, taskId });
              console.log(
                `[ArmorPipeline] Batch ${i + 1}/${tiers.length}: ${tier.tierId} → ${taskId}`,
              );
            }

            return { success: true, tasks: results };
          } catch (err) {
            set.status = 500;
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        {
          body: t.Object({
            file: t.File({ maxSize: "20m" }),
            tiers: t.String(), // JSON-encoded array of {tierId, prompt, styleImageUrl?}[]
            name: t.Optional(t.String()),
            aiModel: t.Optional(t.String()),
            enablePBR: t.Optional(t.String()),
            preserveUV: t.Optional(t.String()),
            styleImageUrl: t.Optional(t.String()),
          }),
          detail: {
            tags: ["Armor Pipeline"],
            summary:
              "Upload shell GLB and start batch AI texture generation for multiple tiers",
          },
        },
      )

      // Poll texture task status
      .get(
        "/texture-status/:taskId",
        async ({ params, set }) => {
          if (!shellTextureService.isConfigured) {
            set.status = 503;
            return { error: "MESHY_API_KEY not configured" };
          }

          try {
            const status = await shellTextureService.getTaskStatus(
              params.taskId,
            );
            return status;
          } catch (err) {
            set.status = 500;
            return {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        {
          params: t.Object({
            taskId: t.String(),
          }),
          detail: {
            tags: ["Armor Pipeline"],
            summary: "Check texture generation task status",
          },
        },
      )

      // Download textured result (proxies Meshy download URL)
      .get(
        "/texture-download/:taskId",
        async ({ params, set }) => {
          if (!shellTextureService.isConfigured) {
            set.status = 503;
            return { error: "MESHY_API_KEY not configured" };
          }

          try {
            const status = await shellTextureService.getTaskStatus(
              params.taskId,
            );

            if (status.status !== "succeeded" || !status.resultGlbUrl) {
              set.status = 404;
              return { error: "Task not complete or no result available" };
            }

            const buffer = await shellTextureService.downloadResult(
              status.resultGlbUrl,
            );

            const safeTaskId = params.taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
            set.headers["content-type"] = "model/gltf-binary";
            set.headers["content-disposition"] =
              `attachment; filename="textured_shell_${safeTaskId}.glb"`;

            return new Response(buffer);
          } catch (err) {
            set.status = 500;
            return {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        {
          params: t.Object({
            taskId: t.String(),
          }),
          detail: {
            tags: ["Armor Pipeline"],
            summary: "Download textured shell GLB result",
          },
        },
      )

      // Publish rigged armor GLB to the game's model directory + update manifest
      // Security: restricted to localhost requests only (writes to game server filesystem)
      .post(
        "/publish-to-game",
        async ({ body, set, request, server }) => {
          // Only allow requests from localhost — check actual socket IP, not Host header
          // IMPORTANT: if requestIP() returns undefined (e.g. behind proxy), deny by default
          const remoteAddr = server?.requestIP(request)?.address;
          const isLocal =
            remoteAddr !== undefined &&
            (remoteAddr === "127.0.0.1" ||
              remoteAddr === "::1" ||
              remoteAddr === "::ffff:127.0.0.1");
          if (!isLocal) {
            set.status = 403;
            return {
              success: false,
              error: "Publish is only allowed from localhost",
            };
          }
          try {
            const file = body.file;
            const arrayBuffer = await file.arrayBuffer();
            const glbBuffer = Buffer.from(arrayBuffer);

            const itemId = body.itemId;
            const slot = body.slot;

            // Validate path segments to prevent directory traversal
            if (!SAFE_PATH_RE.test(itemId) || !SAFE_PATH_RE.test(slot)) {
              set.status = 400;
              return {
                success: false,
                error:
                  "itemId and slot must contain only alphanumeric characters, hyphens, and underscores",
              };
            }

            const itemName = body.itemName || itemId.replace(/_/g, " ");
            const tier = body.tier || "bronze";
            if (
              !SAFE_PATH_RE.test(tier) ||
              itemName.length > 100 ||
              /[\u0000-\u001f\u007f]/u.test(itemName)
            ) {
              throw new ArmorPublishValidationError(
                "tier or itemName contains invalid publish metadata",
              );
            }

            // Determine game model directory based on slot
            const slotDirMap: Record<string, string> = {
              helmet: "helmets",
              body: "torsos",
              legs: "legs",
              boots: "boots",
              gloves: "gloves",
              cape: "capes",
            };
            const slotDir = slotDirMap[slot];
            if (!slotDir) {
              set.status = 400;
              return {
                success: false,
                error: `Unknown equipment slot: ${slot}. Must be one of: ${Object.keys(slotDirMap).join(", ")}`,
              };
            }

            // Validate the exact competitive identity embedded in the GLB and
            // all request-derived data before creating or replacing any file.
            const duelFit = validatePublishedArmorGlb(glbBuffer, {
              itemId,
              slot,
            });
            const bonuses = parseBonuses(body.bonuses);
            if (bonuses === null) {
              throw new ArmorPublishValidationError("Invalid bonuses JSON");
            }

            // Resolve paths relative to the monorepo
            const serverAssetsDir = join(
              import.meta.dir,
              "..",
              "..",
              "..",
              "server",
              "world",
              "assets",
            );
            const modelDir = join(serverAssetsDir, "models", slotDir, itemId);
            const manifestPath = join(
              serverAssetsDir,
              "manifests",
              "items",
              "armor.json",
            );

            const glbPath = join(modelDir, `${itemId}.glb`);
            const metadata = {
              name: itemId,
              gameId: itemId,
              type: "armor",
              subtype: slot,
              description: `${itemName} — generated by Armor Pipeline`,
              generatedAt: new Date().toISOString(),
              isBaseModel: true,
              hasModel: true,
              modelPath: `models/${slotDir}/${itemId}/${itemId}.glb`,
              gddCompliant: true,
              workflow: "Shell Extraction → Meshy Texture → Rig → Publish",
              duelFit,
            };

            // Parse and construct every output before creating or replacing a
            // file. Each replacement is atomic, so readers never observe a
            // partially-written GLB, metadata document, or manifest.
            let manifest: Record<string, unknown>[] = [];
            if (existsSync(manifestPath)) {
              const raw = await readFile(manifestPath, "utf-8");
              manifest = JSON.parse(raw);
            }

            const existingIndex = manifest.findIndex(
              (item) => item.id === itemId,
            );
            const entry: Record<string, unknown> = {
              id: itemId,
              name: itemName,
              type: "armor",
              tier,
              equipSlot: slot,
              equippedModelPath: `asset://models/${slotDir}/${itemId}/${itemId}.glb`,
              value: 100,
              weight: 5,
              description: `${itemName}.`,
              examine: `A piece of ${tier} armor.`,
              tradeable: true,
              rarity: "common",
              bonuses,
            };

            if (existingIndex >= 0) {
              manifest[existingIndex] = {
                ...manifest[existingIndex],
                ...entry,
              };
            } else {
              manifest.push(entry);
            }

            await mkdir(modelDir, { recursive: true });
            await writeFileAtomically(glbPath, glbBuffer);
            await writeFileAtomically(
              join(modelDir, "metadata.json"),
              JSON.stringify(metadata, null, 2),
            );
            await writeFileAtomically(
              manifestPath,
              JSON.stringify(manifest, null, 2),
            );

            console.log(
              `[ArmorPipeline] Published ${itemId} → ${glbPath} (${(glbBuffer.length / 1024).toFixed(1)}KB)`,
            );

            return {
              success: true,
              itemId,
              slot,
              glbPath: `models/${slotDir}/${itemId}/${itemId}.glb`,
              glbSizeKB: Math.round(glbBuffer.length / 1024),
              manifestUpdated: true,
            };
          } catch (err) {
            set.status = err instanceof ArmorPublishValidationError ? 400 : 500;
            return {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
        {
          body: t.Object({
            file: t.File({ maxSize: "20m" }),
            itemId: t.String(),
            slot: t.String(),
            itemName: t.Optional(t.String()),
            tier: t.Optional(t.String()),
            bonuses: t.Optional(t.String()),
          }),
          detail: {
            tags: ["Armor Pipeline"],
            summary:
              "Publish rigged armor GLB to game model directory and update item manifest",
          },
        },
      )
  );
};
