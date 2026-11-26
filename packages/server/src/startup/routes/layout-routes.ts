/**
 * Layout Routes
 *
 * API endpoints for UI layout preset cloud sync.
 * Allows users to save, load, and share interface layouts.
 */

import type { FastifyInstance } from "fastify";
import type { World } from "@hyperforge/shared";
import type { DatabaseSystem } from "../../systems/DatabaseSystem/index.js";
import * as schema from "../../database/schema.js";
import { eq, and, desc, isNotNull } from "drizzle-orm";
import { requirePrivyRequestUser } from "../../infrastructure/auth/http-auth.js";

/**
 * Generate a unique share code for a preset
 * Format: 6 alphanumeric characters (e.g., "AB12CD")
 */
function generateShareCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/** Layout preset data structure */
interface LayoutPresetData {
  slotIndex: number;
  name: string;
  layoutData: string; // JSON serialized WindowState[]
  resolution?: { width: number; height: number };
  shared?: boolean;
}

/**
 * Register layout preset API routes
 */
export function registerLayoutRoutes(
  fastify: FastifyInstance,
  world: World,
): void {
  const databaseSystem = world.getSystem(
    "database",
  ) as unknown as DatabaseSystem;

  if (!databaseSystem) {
    console.error("[LayoutRoutes] DatabaseSystem not found");
    return;
  }

  /**
   * GET /api/layouts
   *
   * Get all layout presets for a user.
   *
   * Query:
   *   - userId: string - The user's account ID
   *
   * Returns:
   *   - presets: LayoutPreset[]
   */
  fastify.get<{
    Querystring: { userId?: string };
  }>("/api/layouts", async (request, reply) => {
    const { userId } = request.query;

    if (!userId) {
      return reply.status(400).send({
        success: false,
        error: "Missing userId parameter",
      });
    }
    if (!(await requirePrivyRequestUser(request, reply, userId))) return;

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const presets = await db
        .select()
        .from(schema.layoutPresets)
        .where(eq(schema.layoutPresets.userId, userId))
        .orderBy(schema.layoutPresets.slotIndex);

      return reply.send({
        success: true,
        presets: presets.map((p) => ({
          slotIndex: p.slotIndex,
          name: p.name,
          layoutData: p.layoutData,
          resolution: p.resolution ? JSON.parse(p.resolution) : null,
          shared: p.shared === 1,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error fetching layouts:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch layouts",
      });
    }
  });

  /**
   * GET /api/layouts/:slotIndex
   *
   * Get a specific layout preset.
   *
   * Params:
   *   - slotIndex: number - Preset slot (0-3)
   *
   * Query:
   *   - userId: string - The user's account ID
   *
   * Returns:
   *   - preset: LayoutPreset | null
   */
  fastify.get<{
    Params: { slotIndex: string };
    Querystring: { userId?: string };
  }>("/api/layouts/:slotIndex", async (request, reply) => {
    const { slotIndex } = request.params;
    const { userId } = request.query;

    if (!userId) {
      return reply.status(400).send({
        success: false,
        error: "Missing userId parameter",
      });
    }
    if (!(await requirePrivyRequestUser(request, reply, userId))) return;

    const slot = parseInt(slotIndex, 10);
    if (isNaN(slot) || slot < 0 || slot > 3) {
      return reply.status(400).send({
        success: false,
        error: "Invalid slotIndex (must be 0-3)",
      });
    }

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const presets = await db
        .select()
        .from(schema.layoutPresets)
        .where(
          and(
            eq(schema.layoutPresets.userId, userId),
            eq(schema.layoutPresets.slotIndex, slot),
          ),
        )
        .limit(1);

      if (presets.length === 0) {
        return reply.send({
          success: true,
          preset: null,
        });
      }

      const p = presets[0];
      return reply.send({
        success: true,
        preset: {
          slotIndex: p.slotIndex,
          name: p.name,
          layoutData: p.layoutData,
          resolution: p.resolution ? JSON.parse(p.resolution) : null,
          shared: p.shared === 1,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        },
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error fetching layout:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch layout",
      });
    }
  });

  /**
   * POST /api/layouts
   *
   * Save a layout preset.
   *
   * Body:
   *   - userId: string - The user's account ID
   *   - slotIndex: number - Preset slot (0-3)
   *   - name: string - Preset name
   *   - layoutData: string - JSON serialized layout
   *   - resolution?: { width, height }
   *   - shared?: boolean
   *
   * Returns:
   *   - success: boolean
   */
  fastify.post<{
    Body: {
      userId?: string;
      slotIndex?: number;
      name?: string;
      layoutData?: string;
      resolution?: { width: number; height: number };
      shared?: boolean;
    };
  }>("/api/layouts", async (request, reply) => {
    const { userId, slotIndex, name, layoutData, resolution, shared } =
      request.body;

    // Validate required fields
    if (!userId || slotIndex === undefined || !name || !layoutData) {
      return reply.status(400).send({
        success: false,
        error: "Missing required fields: userId, slotIndex, name, layoutData",
      });
    }
    if (!(await requirePrivyRequestUser(request, reply, userId))) return;

    if (slotIndex < 0 || slotIndex > 3) {
      return reply.status(400).send({
        success: false,
        error: "Invalid slotIndex (must be 0-3)",
      });
    }

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const now = Date.now();

      // Check if preset exists for upsert
      const existing = await db
        .select({ id: schema.layoutPresets.id })
        .from(schema.layoutPresets)
        .where(
          and(
            eq(schema.layoutPresets.userId, userId),
            eq(schema.layoutPresets.slotIndex, slotIndex),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        // Update existing
        await db
          .update(schema.layoutPresets)
          .set({
            name,
            layoutData,
            resolution: resolution ? JSON.stringify(resolution) : null,
            shared: shared ? 1 : 0,
            updatedAt: now,
          })
          .where(eq(schema.layoutPresets.id, existing[0].id));
      } else {
        // Insert new
        await db.insert(schema.layoutPresets).values({
          userId,
          slotIndex,
          name,
          layoutData,
          resolution: resolution ? JSON.stringify(resolution) : null,
          shared: shared ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      console.log(
        `[LayoutRoutes] ✅ Layout saved: ${name} (slot ${slotIndex}) for user ${userId}`,
      );

      return reply.send({
        success: true,
        message: "Layout saved successfully",
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error saving layout:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to save layout",
      });
    }
  });

  /**
   * DELETE /api/layouts/:slotIndex
   *
   * Delete a layout preset.
   *
   * Params:
   *   - slotIndex: number - Preset slot (0-3)
   *
   * Body:
   *   - userId: string - The user's account ID
   *
   * Returns:
   *   - success: boolean
   */
  fastify.delete<{
    Params: { slotIndex: string };
    Body: { userId?: string };
  }>("/api/layouts/:slotIndex", async (request, reply) => {
    const { slotIndex } = request.params;
    const { userId } = request.body;

    if (!userId) {
      return reply.status(400).send({
        success: false,
        error: "Missing userId in body",
      });
    }
    if (!(await requirePrivyRequestUser(request, reply, userId))) return;

    const slot = parseInt(slotIndex, 10);
    if (isNaN(slot) || slot < 0 || slot > 3) {
      return reply.status(400).send({
        success: false,
        error: "Invalid slotIndex (must be 0-3)",
      });
    }

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      await db
        .delete(schema.layoutPresets)
        .where(
          and(
            eq(schema.layoutPresets.userId, userId),
            eq(schema.layoutPresets.slotIndex, slot),
          ),
        );

      console.log(
        `[LayoutRoutes] ✅ Layout deleted: slot ${slot} for user ${userId}`,
      );

      return reply.send({
        success: true,
        message: "Layout deleted successfully",
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error deleting layout:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to delete layout",
      });
    }
  });

  /**
   * POST /api/layouts/sync
   *
   * Sync all layouts at once (bulk upsert).
   *
   * Body:
   *   - userId: string
   *   - presets: LayoutPresetData[]
   *
   * Returns:
   *   - success: boolean
   */
  fastify.post<{
    Body: {
      userId?: string;
      presets?: LayoutPresetData[];
    };
  }>("/api/layouts/sync", async (request, reply) => {
    const { userId, presets } = request.body;

    if (!userId || !presets) {
      return reply.status(400).send({
        success: false,
        error: "Missing required fields: userId, presets",
      });
    }
    if (!(await requirePrivyRequestUser(request, reply, userId))) return;

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const now = Date.now();

      // Process each preset
      for (const preset of presets) {
        if (
          preset.slotIndex < 0 ||
          preset.slotIndex > 3 ||
          !preset.name ||
          !preset.layoutData
        ) {
          continue; // Skip invalid presets
        }

        const existing = await db
          .select({ id: schema.layoutPresets.id })
          .from(schema.layoutPresets)
          .where(
            and(
              eq(schema.layoutPresets.userId, userId),
              eq(schema.layoutPresets.slotIndex, preset.slotIndex),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          await db
            .update(schema.layoutPresets)
            .set({
              name: preset.name,
              layoutData: preset.layoutData,
              resolution: preset.resolution
                ? JSON.stringify(preset.resolution)
                : null,
              shared: preset.shared ? 1 : 0,
              updatedAt: now,
            })
            .where(eq(schema.layoutPresets.id, existing[0].id));
        } else {
          await db.insert(schema.layoutPresets).values({
            userId,
            slotIndex: preset.slotIndex,
            name: preset.name,
            layoutData: preset.layoutData,
            resolution: preset.resolution
              ? JSON.stringify(preset.resolution)
              : null,
            shared: preset.shared ? 1 : 0,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      console.log(
        `[LayoutRoutes] ✅ Layouts synced: ${presets.length} presets for user ${userId}`,
      );

      return reply.send({
        success: true,
        message: `${presets.length} layouts synced`,
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error syncing layouts:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to sync layouts",
      });
    }
  });

  // ============================================================================
  // COMMUNITY SHARING ENDPOINTS
  // ============================================================================

  /**
   * POST /api/layouts/share
   *
   * Share a preset publicly and generate a share code.
   *
   * Body:
   *   - userId: string
   *   - slotIndex: number
   *   - description?: string
   *   - category?: string
   *   - tags?: string[]
   *
   * Returns:
   *   - shareCode: string
   */
  fastify.post<{
    Body: {
      userId?: string;
      slotIndex?: number;
      description?: string;
      category?: string;
      tags?: string[];
    };
  }>("/api/layouts/share", async (request, reply) => {
    const { userId, slotIndex, description, category, tags } = request.body;

    if (!userId || slotIndex === undefined) {
      return reply.status(400).send({
        success: false,
        error: "Missing required fields: userId, slotIndex",
      });
    }
    if (!(await requirePrivyRequestUser(request, reply, userId))) return;

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      // Find the preset
      const presets = await db
        .select()
        .from(schema.layoutPresets)
        .where(
          and(
            eq(schema.layoutPresets.userId, userId),
            eq(schema.layoutPresets.slotIndex, slotIndex),
          ),
        )
        .limit(1);

      if (presets.length === 0) {
        return reply.status(404).send({
          success: false,
          error: "Preset not found",
        });
      }

      const preset = presets[0];

      // Generate unique share code (retry if collision)
      let shareCode = preset.shareCode;
      if (!shareCode) {
        let attempts = 0;
        while (attempts < 10) {
          shareCode = generateShareCode();
          const existing = await db
            .select({ id: schema.layoutPresets.id })
            .from(schema.layoutPresets)
            .where(eq(schema.layoutPresets.shareCode, shareCode))
            .limit(1);
          if (existing.length === 0) break;
          attempts++;
        }
        if (attempts >= 10) {
          return reply.status(500).send({
            success: false,
            error: "Failed to generate unique share code",
          });
        }
      }

      // Update preset with sharing info
      await db
        .update(schema.layoutPresets)
        .set({
          shared: 1,
          shareCode,
          description: description || null,
          category: category || "custom",
          tags: tags ? JSON.stringify(tags) : "[]",
          updatedAt: Date.now(),
        })
        .where(eq(schema.layoutPresets.id, preset.id));

      console.log(
        `[LayoutRoutes] ✅ Preset shared: ${preset.name} with code ${shareCode}`,
      );

      return reply.send({
        success: true,
        shareCode,
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error sharing preset:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to share preset",
      });
    }
  });

  /**
   * GET /api/layouts/code/:shareCode
   *
   * Get a preset by share code.
   *
   * Params:
   *   - shareCode: string
   *
   * Returns:
   *   - preset: LayoutPreset
   */
  fastify.get<{
    Params: { shareCode: string };
  }>("/api/layouts/code/:shareCode", async (request, reply) => {
    const { shareCode } = request.params;

    if (!shareCode || shareCode.length !== 6) {
      return reply.status(400).send({
        success: false,
        error: "Invalid share code",
      });
    }

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const presets = await db
        .select({
          id: schema.layoutPresets.id,
          name: schema.layoutPresets.name,
          layoutData: schema.layoutPresets.layoutData,
          resolution: schema.layoutPresets.resolution,
          description: schema.layoutPresets.description,
          category: schema.layoutPresets.category,
          tags: schema.layoutPresets.tags,
          usageCount: schema.layoutPresets.usageCount,
          rating: schema.layoutPresets.rating,
          ratingCount: schema.layoutPresets.ratingCount,
          shareCode: schema.layoutPresets.shareCode,
          userId: schema.layoutPresets.userId,
          createdAt: schema.layoutPresets.createdAt,
        })
        .from(schema.layoutPresets)
        .where(
          and(
            eq(schema.layoutPresets.shareCode, shareCode.toUpperCase()),
            eq(schema.layoutPresets.shared, 1),
          ),
        )
        .limit(1);

      if (presets.length === 0) {
        return reply.status(404).send({
          success: false,
          error: "Preset not found or not shared",
        });
      }

      const p = presets[0];

      // Increment usage count
      await db
        .update(schema.layoutPresets)
        .set({
          usageCount: (p.usageCount || 0) + 1,
        })
        .where(eq(schema.layoutPresets.id, p.id));

      // Get author name
      const users = await db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, p.userId))
        .limit(1);
      const authorName = users[0]?.name || "Unknown";

      return reply.send({
        success: true,
        preset: {
          name: p.name,
          layoutData: p.layoutData,
          resolution: p.resolution ? JSON.parse(p.resolution) : null,
          description: p.description,
          category: p.category,
          tags: p.tags ? JSON.parse(p.tags) : [],
          usageCount: p.usageCount,
          rating: p.rating,
          ratingCount: p.ratingCount,
          shareCode: p.shareCode,
          authorName,
          createdAt: p.createdAt,
        },
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error fetching preset by code:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch preset",
      });
    }
  });

  /**
   * GET /api/layouts/player/:playerName
   *
   * Get all public presets from a specific player.
   *
   * Params:
   *   - playerName: string
   *
   * Returns:
   *   - presets: LayoutPreset[]
   */
  fastify.get<{
    Params: { playerName: string };
  }>("/api/layouts/player/:playerName", async (request, reply) => {
    const { playerName } = request.params;

    if (!playerName) {
      return reply.status(400).send({
        success: false,
        error: "Missing player name",
      });
    }

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      // Find user by name
      const users = await db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.name, playerName))
        .limit(1);

      if (users.length === 0) {
        return reply.status(404).send({
          success: false,
          error: "Player not found",
        });
      }

      const user = users[0];

      // Get public presets
      const presets = await db
        .select()
        .from(schema.layoutPresets)
        .where(
          and(
            eq(schema.layoutPresets.userId, user.id),
            eq(schema.layoutPresets.shared, 1),
          ),
        )
        .orderBy(desc(schema.layoutPresets.usageCount));

      return reply.send({
        success: true,
        playerName: user.name,
        presets: presets.map((p) => ({
          name: p.name,
          description: p.description,
          category: p.category,
          tags: p.tags ? JSON.parse(p.tags) : [],
          usageCount: p.usageCount,
          rating: p.rating,
          ratingCount: p.ratingCount,
          shareCode: p.shareCode,
          createdAt: p.createdAt,
        })),
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error fetching player presets:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch player presets",
      });
    }
  });

  /**
   * GET /api/layouts/community/:category
   *
   * Browse community presets by category.
   *
   * Params:
   *   - category: "featured" | "popular" | "recent" | string (category name)
   *
   * Query:
   *   - limit?: number (default 20, max 50)
   *   - offset?: number (default 0)
   *
   * Returns:
   *   - presets: LayoutPreset[]
   */
  fastify.get<{
    Params: { category: string };
    Querystring: { limit?: string; offset?: string };
  }>("/api/layouts/community/:category", async (request, reply) => {
    const { category } = request.params;
    const limit = Math.min(parseInt(request.query.limit || "20", 10), 50);
    const offset = parseInt(request.query.offset || "0", 10);

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const baseSelect = {
        id: schema.layoutPresets.id,
        name: schema.layoutPresets.name,
        description: schema.layoutPresets.description,
        category: schema.layoutPresets.category,
        tags: schema.layoutPresets.tags,
        usageCount: schema.layoutPresets.usageCount,
        rating: schema.layoutPresets.rating,
        ratingCount: schema.layoutPresets.ratingCount,
        shareCode: schema.layoutPresets.shareCode,
        userId: schema.layoutPresets.userId,
        createdAt: schema.layoutPresets.createdAt,
      };

      // Build query based on category
      let presets;
      if (category === "featured") {
        // Featured: high rating with significant usage
        presets = await db
          .select(baseSelect)
          .from(schema.layoutPresets)
          .where(
            and(
              eq(schema.layoutPresets.shared, 1),
              isNotNull(schema.layoutPresets.rating),
            ),
          )
          .orderBy(desc(schema.layoutPresets.rating))
          .limit(limit)
          .offset(offset);
      } else if (category === "popular") {
        // Popular: most used
        presets = await db
          .select(baseSelect)
          .from(schema.layoutPresets)
          .where(eq(schema.layoutPresets.shared, 1))
          .orderBy(desc(schema.layoutPresets.usageCount))
          .limit(limit)
          .offset(offset);
      } else if (category === "recent") {
        // Recent: newest first
        presets = await db
          .select(baseSelect)
          .from(schema.layoutPresets)
          .where(eq(schema.layoutPresets.shared, 1))
          .orderBy(desc(schema.layoutPresets.createdAt))
          .limit(limit)
          .offset(offset);
      } else {
        // Category filter
        presets = await db
          .select(baseSelect)
          .from(schema.layoutPresets)
          .where(
            and(
              eq(schema.layoutPresets.shared, 1),
              eq(schema.layoutPresets.category, category),
            ),
          )
          .orderBy(desc(schema.layoutPresets.usageCount))
          .limit(limit)
          .offset(offset);
      }

      // Get author names
      const userIds = [...new Set(presets.map((p) => p.userId))];
      const usersResult =
        userIds.length > 0
          ? await db
              .select({ id: schema.users.id, name: schema.users.name })
              .from(schema.users)
          : [];
      const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

      return reply.send({
        success: true,
        category,
        presets: presets.map((p) => ({
          name: p.name,
          description: p.description,
          category: p.category,
          tags: p.tags ? JSON.parse(p.tags) : [],
          usageCount: p.usageCount,
          rating: p.rating,
          ratingCount: p.ratingCount,
          shareCode: p.shareCode,
          authorName: userMap.get(p.userId) || "Unknown",
          createdAt: p.createdAt,
        })),
      });
    } catch (error) {
      console.error(
        "[LayoutRoutes] ❌ Error fetching community presets:",
        error,
      );
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch community presets",
      });
    }
  });

  /**
   * POST /api/layouts/:shareCode/rate
   *
   * Rate a shared preset.
   *
   * Params:
   *   - shareCode: string
   *
   * Body:
   *   - userId: string
   *   - rating: number (1-5)
   *
   * Returns:
   *   - newRating: number (updated average)
   */
  fastify.post<{
    Params: { shareCode: string };
    Body: { userId?: string; rating?: number };
  }>("/api/layouts/:shareCode/rate", async (request, reply) => {
    const { shareCode } = request.params;
    const { userId, rating } = request.body;

    if (!userId || rating === undefined) {
      return reply.status(400).send({
        success: false,
        error: "Missing required fields: userId, rating",
      });
    }
    if (!(await requirePrivyRequestUser(request, reply, userId))) return;

    if (rating < 1 || rating > 5) {
      return reply.status(400).send({
        success: false,
        error: "Rating must be between 1 and 5",
      });
    }

    try {
      const db = databaseSystem.getDb();
      if (!db) {
        return reply.status(500).send({
          success: false,
          error: "Database not available",
        });
      }

      const presets = await db
        .select()
        .from(schema.layoutPresets)
        .where(
          and(
            eq(schema.layoutPresets.shareCode, shareCode.toUpperCase()),
            eq(schema.layoutPresets.shared, 1),
          ),
        )
        .limit(1);

      if (presets.length === 0) {
        return reply.status(404).send({
          success: false,
          error: "Preset not found",
        });
      }

      const preset = presets[0];

      // Prevent self-rating
      if (preset.userId === userId) {
        return reply.status(400).send({
          success: false,
          error: "Cannot rate your own preset",
        });
      }

      // Update rating (simple average for now, could use a separate ratings table for more accuracy)
      const newRatingCount = (preset.ratingCount || 0) + 1;
      const newRatingSum = (preset.ratingSum || 0) + rating;
      const newRating = newRatingSum / newRatingCount;

      await db
        .update(schema.layoutPresets)
        .set({
          ratingCount: newRatingCount,
          ratingSum: newRatingSum,
          rating: newRating,
          updatedAt: Date.now(),
        })
        .where(eq(schema.layoutPresets.id, preset.id));

      console.log(
        `[LayoutRoutes] ✅ Preset rated: ${preset.name} - ${rating}/5 (avg: ${newRating.toFixed(2)})`,
      );

      return reply.send({
        success: true,
        newRating: parseFloat(newRating.toFixed(2)),
        ratingCount: newRatingCount,
      });
    } catch (error) {
      console.error("[LayoutRoutes] ❌ Error rating preset:", error);
      return reply.status(500).send({
        success: false,
        error: "Failed to rate preset",
      });
    }
  });

  console.log(
    "[LayoutRoutes] ✅ Layout routes registered (with community sharing)",
  );
}
