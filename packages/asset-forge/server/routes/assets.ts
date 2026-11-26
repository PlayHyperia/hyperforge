/**
 * Asset Routes
 * Asset management endpoints including CRUD operations, file serving, and sprite generation
 */

import { Elysia, t } from "elysia";
import path from "path";
import fs from "fs";
import type { AssetService } from "../services/AssetService";
import * as Models from "../models";
import {
  ArmorPublishValidationError,
  validatePublishedRigidEquipmentGlb,
} from "../services/armor-pipeline/DuelFitMetadata";

const SAFE_ASSET_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;

export const createAssetRoutes = (
  rootDir: string,
  assetService: AssetService,
) => {
  return new Elysia({ prefix: "/api/assets", name: "assets" }).guard(
    {
      beforeHandle: ({ request }) => {
        console.log(`[Assets] ${request.method} request`);
      },
    },
    (app) =>
      app
        // Asset listing endpoint
        .get(
          "",
          async () => {
            const assets = await assetService.listAssets();
            return assets;
          },
          {
            response: Models.AssetListResponse,
            detail: {
              tags: ["Assets"],
              summary: "List all assets",
              description:
                "Returns a list of all generated 3D assets. (Auth optional - shows public assets, authenticated users see their own assets)",
            },
          },
        )

        // Get single asset model
        .get("/:id/model", async ({ params: { id }, set }) => {
          const modelPath = await assetService.getModelPath(id);
          const modelFile = Bun.file(modelPath);

          if (!(await modelFile.exists())) {
            set.status = 404;
            return { error: `Model not found for asset ${id}` };
          }

          return modelFile;
        })

        // HEAD request for model existence check
        // Note: Currently has Elysia framework issues, but kept for future compatibility
        .head("/:id/model", async ({ params: { id }, set }) => {
          try {
            const modelPath = await assetService.getModelPath(id);
            const modelFile = Bun.file(modelPath);

            if (!(await modelFile.exists())) {
              set.status = 404;
            } else {
              set.status = 200;
            }
          } catch {
            set.status = 404;
          }

          return new Response(null, { status: set.status });
        })

        // Serve any file from an asset directory
        .get("/:id/*", async ({ params, set }) => {
          const assetId = params.id;
          const filePath = params["*"]; // Everything after the asset ID

          const fullPath = path.join(rootDir, "gdd-assets", assetId, filePath);

          // Security check to prevent directory traversal
          const normalizedPath = path.normalize(fullPath);
          const assetDir = path.join(rootDir, "gdd-assets", assetId);

          if (!normalizedPath.startsWith(assetDir)) {
            set.status = 403;
            return { error: "Access denied" };
          }

          const file = Bun.file(fullPath);

          if (!(await file.exists())) {
            set.status = 404;
            return { error: "File not found" };
          }

          return file;
        })

        // HEAD request for file existence check (wildcard route)
        // Note: Currently has Elysia framework issues, but kept for future compatibility
        .head("/:id/*", async ({ params, set }) => {
          const assetId = params.id;
          const filePath = params["*"]; // Everything after the asset ID

          const fullPath = path.join(rootDir, "gdd-assets", assetId, filePath);

          // Security check to prevent directory traversal
          const normalizedPath = path.normalize(fullPath);
          const assetDir = path.join(rootDir, "gdd-assets", assetId);

          if (!normalizedPath.startsWith(assetDir)) {
            set.status = 403;
            return new Response(null, { status: 403 });
          }

          const file = Bun.file(fullPath);

          if (!(await file.exists())) {
            set.status = 404;
          } else {
            set.status = 200;
          }

          return new Response(null, { status: set.status });
        })

        // Delete asset endpoint
        .delete(
          "/:id",
          async ({ params: { id }, query, set }) => {
            const assets = await assetService.listAssets();
            const asset = assets.find(
              (a: Models.AssetMetadataType) => a.id === id,
            );

            if (!asset) {
              set.status = 404;
              return { error: "Asset not found" };
            }

            const includeVariants = query.includeVariants === "true";
            await assetService.deleteAsset(id, includeVariants);

            return {
              success: true,
              message: `Asset ${id} deleted successfully`,
            };
          },
          {
            params: t.Object({
              id: t.String({ minLength: 1 }),
            }),
            query: Models.DeleteAssetQuery,
            response: {
              200: Models.DeleteAssetResponse,
              403: Models.ErrorResponse,
              404: Models.ErrorResponse,
            },
            detail: {
              tags: ["Assets"],
              summary: "Delete an asset",
              description:
                "Deletes an asset and optionally its variants. (Auth required - users can only delete their own assets, admins can delete any asset)",
            },
          },
        )

        // Update asset metadata
        .patch(
          "/:id",
          async ({ params: { id }, body, set }) => {
            const assets = await assetService.listAssets();
            const asset = assets.find(
              (a: Models.AssetMetadataType) => a.id === id,
            );

            if (!asset) {
              set.status = 404;
              return { error: "Asset not found" };
            }

            const updatedAsset = await assetService.updateAsset(id, body);

            if (!updatedAsset) {
              set.status = 404;
              return { error: "Asset not found" };
            }

            return updatedAsset;
          },
          {
            params: t.Object({
              id: t.String({ minLength: 1 }),
            }),
            body: Models.AssetUpdate,
            response: {
              200: Models.AssetMetadata,
              403: Models.ErrorResponse,
              404: Models.ErrorResponse,
            },
            detail: {
              tags: ["Assets"],
              summary: "Update asset metadata",
              description:
                "Updates asset metadata like name, type, tier, etc. (Auth required - users can only update their own assets, admins can update any asset)",
            },
          },
        )

        // Save sprites for an asset
        .post(
          "/:id/sprites",
          async ({ params: { id }, body }) => {
            const { sprites, config } = body;

            console.log(
              `[Sprites] Saving ${sprites.length} sprites for asset: ${id}`,
            );

            // Create sprites directory
            const assetDir = path.join(rootDir, "gdd-assets", id);
            const spritesDir = path.join(assetDir, "sprites");

            console.log(`[Sprites] Creating directory: ${spritesDir}`);
            await fs.promises.mkdir(spritesDir, { recursive: true });

            // Save each sprite image
            for (const sprite of sprites) {
              const { angle, imageData } = sprite;

              // Extract base64 data from data URL
              const base64Data = imageData.replace(
                /^data:image\/\w+;base64,/,
                "",
              );
              const buffer = Buffer.from(base64Data, "base64");

              // Save as PNG file using Bun.write
              const filename = `${angle}deg.png`;
              const filepath = path.join(spritesDir, filename);
              await Bun.write(filepath, buffer);
              console.log(
                `[Sprites] Saved: ${filename} (${(buffer.length / 1024).toFixed(2)} KB)`,
              );
            }

            // Save sprite metadata
            const spriteMetadata = {
              assetId: id,
              config: config || {},
              angles: sprites.map((s) => s.angle),
              spriteCount: sprites.length,
              status: "completed",
              generatedAt: new Date().toISOString(),
            };

            const metadataPath = path.join(assetDir, "sprite-metadata.json");
            await Bun.write(
              metadataPath,
              JSON.stringify(spriteMetadata, null, 2),
            );
            console.log(`[Sprites] Saved sprite-metadata.json`);

            // Update asset metadata to indicate sprites are available
            const assetMetadataPath = path.join(assetDir, "metadata.json");
            const currentMetadata = JSON.parse(
              await fs.promises.readFile(assetMetadataPath, "utf-8"),
            );

            // Update with sprite info
            const updatedMetadata = {
              ...currentMetadata,
              hasSpriteSheet: true,
              spriteCount: sprites.length,
              spriteConfig: config,
              lastSpriteGeneration: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };

            await Bun.write(
              assetMetadataPath,
              JSON.stringify(updatedMetadata, null, 2),
            );
            console.log(`[Sprites] Updated asset metadata with sprite info`);

            return {
              success: true,
              message: `${sprites.length} sprites saved successfully`,
              spritesDir: `gdd-assets/${id}/sprites`,
              spriteFiles: sprites.map((s) => `${s.angle}deg.png`),
            };
          },
          {
            params: t.Object({
              id: t.String({ minLength: 1 }),
            }),
            body: Models.SpriteSaveRequest,
            response: Models.SpriteSaveResponse,
            detail: {
              tags: ["Sprites"],
              summary: "Save sprite images",
              description:
                "Saves generated sprite images and metadata for an asset. (Auth optional)",
            },
          },
        )

        // Batch apply fitting configuration to multiple assets
        .post(
          "/batch-apply-fitting",
          async ({ body, set }) => {
            const { config, assetIds } = body;

            console.log(
              `[Batch Fitting] Applying config to ${assetIds.length} assets`,
            );

            let updated = 0;

            for (const assetId of assetIds) {
              try {
                const assetDir = path.join(rootDir, "gdd-assets", assetId);
                const metadataPath = path.join(assetDir, "metadata.json");

                // Security check
                const normalizedPath = path.normalize(metadataPath);
                if (
                  !normalizedPath.startsWith(path.join(rootDir, "gdd-assets"))
                ) {
                  console.warn(
                    `[Batch Fitting] Skipping ${assetId}: path traversal`,
                  );
                  continue;
                }

                const currentMetadata = JSON.parse(
                  await fs.promises.readFile(metadataPath, "utf-8"),
                );

                const updatedMetadata = {
                  ...currentMetadata,
                  ...config,
                  updatedAt: new Date().toISOString(),
                };

                await Bun.write(
                  metadataPath,
                  JSON.stringify(updatedMetadata, null, 2),
                );

                updated++;
                console.log(`[Batch Fitting] Updated: ${assetId}`);
              } catch (error) {
                console.error(`[Batch Fitting] Failed for ${assetId}:`, error);
              }
            }

            return { success: true, updated };
          },
          {
            body: Models.BatchApplyFittingRequest,
            response: Models.BatchApplyFittingResponse,
            detail: {
              tags: ["Assets"],
              summary: "Batch apply fitting configuration",
              description:
                "Applies a fitting configuration (e.g., hyperiaAttachment) to multiple asset metadata files.",
            },
          },
        )

        // Save aligned GLB for an asset
        .post(
          "/:id/save-aligned",
          async ({ params: { id }, body, set, request, server }) => {
            const remoteAddress = server?.requestIP(request)?.address;
            if (
              remoteAddress !== "127.0.0.1" &&
              remoteAddress !== "::1" &&
              remoteAddress !== "::ffff:127.0.0.1"
            ) {
              set.status = 403;
              return {
                success: false,
                path: "",
                error: "Aligned equipment publishing is localhost-only",
              };
            }
            if (!SAFE_ASSET_ID_PATTERN.test(id)) {
              set.status = 400;
              return {
                success: false,
                path: "",
                error: "Invalid competitive item ID",
              };
            }
            const formData = body as { file?: File };
            const file = formData.file;

            if (!file) {
              set.status = 400;
              return { success: false, path: "", error: "No file provided" };
            }

            try {
              const glbBuffer = Buffer.from(await file.arrayBuffer());
              const duelFit = validatePublishedRigidEquipmentGlb(glbBuffer, {
                itemId: id,
              });
              const assetDir = path.join(rootDir, "gdd-assets", id);
              const assetsRoot = `${path.resolve(rootDir, "gdd-assets")}${path.sep}`;
              if (
                !`${path.resolve(assetDir)}${path.sep}`.startsWith(assetsRoot)
              ) {
                set.status = 403;
                return { success: false, path: "", error: "Access denied" };
              }

              const metadataPath = path.join(assetDir, "metadata.json");
              const currentMetadata: unknown = JSON.parse(
                await fs.promises.readFile(metadataPath, "utf-8"),
              );
              if (
                !currentMetadata ||
                typeof currentMetadata !== "object" ||
                Array.isArray(currentMetadata)
              ) {
                throw new Error(`Invalid metadata document for ${id}`);
              }

              const updatedMetadata = {
                ...currentMetadata,
                alignedModelPath: `${id}-aligned.glb`,
                alignedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                duelFit,
              };
              const alignedPath = path.join(assetDir, `${id}-aligned.glb`);
              const suffix = crypto.randomUUID();
              const temporaryAlignedPath = `${alignedPath}.${suffix}.tmp`;
              const temporaryMetadataPath = `${metadataPath}.${suffix}.tmp`;

              await fs.promises.mkdir(assetDir, { recursive: true });
              try {
                await Promise.all([
                  fs.promises.writeFile(temporaryAlignedPath, glbBuffer),
                  fs.promises.writeFile(
                    temporaryMetadataPath,
                    JSON.stringify(updatedMetadata, null, 2),
                  ),
                ]);
                await fs.promises.rename(temporaryAlignedPath, alignedPath);
                await fs.promises.rename(temporaryMetadataPath, metadataPath);
              } catch (error) {
                await Promise.all([
                  fs.promises
                    .unlink(temporaryAlignedPath)
                    .catch(() => undefined),
                  fs.promises
                    .unlink(temporaryMetadataPath)
                    .catch(() => undefined),
                ]);
                throw error;
              }

              const relativePath = `gdd-assets/${id}/${id}-aligned.glb`;
              console.log(
                `[Save Aligned] Saved competitive fit: ${relativePath} (${(file.size / 1024).toFixed(1)} KB)`,
              );
              return { success: true, path: relativePath };
            } catch (error) {
              set.status =
                error instanceof ArmorPublishValidationError ? 400 : 500;
              return {
                success: false,
                path: "",
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
          {
            params: t.Object({
              id: t.String({ minLength: 1 }),
            }),
            response: Models.SaveAlignedResponse,
            detail: {
              tags: ["Assets"],
              summary: "Save aligned GLB model",
              description: "Saves an aligned (fitted) GLB model for an asset.",
            },
          },
        )

        // Upload VRM file
        .post(
          "/upload-vrm",
          async ({ body }) => {
            const formData = body as { file?: File; assetId?: string };
            const file = formData.file!;
            const assetId = formData.assetId!;
            const filename = file.name;

            console.log(
              `[VRM Upload] Uploading ${filename} for asset: ${assetId}`,
            );
            console.log(
              `[VRM Upload] File size: ${(file.size / 1024 / 1024).toFixed(2)} MB`,
            );

            // Save VRM to asset directory
            const assetDir = path.join(rootDir, "gdd-assets", assetId);

            // Create directory if it doesn't exist
            await fs.promises.mkdir(assetDir, { recursive: true });

            // Save VRM file
            const vrmPath = path.join(assetDir, filename);
            await Bun.write(vrmPath, file);

            console.log(`[VRM Upload] Saved to: ${vrmPath}`);

            // Return success with URL
            const url = `/gdd-assets/${assetId}/${filename}`;
            return {
              success: true,
              url,
              message: `VRM uploaded successfully to ${url}`,
            };
          },
          {
            response: Models.VRMUploadResponse,
            detail: {
              tags: ["VRM"],
              summary: "Upload VRM file",
              description:
                "Uploads a VRM file for an asset. (Auth optional - authenticated users get ownership tracking)",
            },
          },
        ),
  );
};
