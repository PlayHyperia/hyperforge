import {
  Package,
  Play,
  Download,
  RotateCcw,
  Loader2,
  Upload,
  PersonStanding,
  Eye,
  EyeOff,
  Rocket,
} from "lucide-react";
import React, { useRef, useState, useCallback } from "react";
import type { VRM } from "@pixiv/three-vrm";

import { ShellExtractionService } from "../../services/armor-pipeline/ShellExtractionService";
import { ShellRiggingService } from "../../services/armor-pipeline/ShellRiggingService";
import {
  AVATAR_OPTIONS,
  ANIMATION_URLS,
  SLOT_LABELS,
  ALL_SLOTS,
  ALL_BULKS,
  MATERIAL_TIERS,
} from "../../services/armor-pipeline/constants";
import type {
  RiggedArmorResult,
  EquipmentSlotName,
  BulkClass,
  ShellExtractionResult,
} from "../../services/armor-pipeline/types";
import { BULK_OFFSETS } from "../../services/armor-pipeline/types";
import type { ArmorKitPiece } from "../../pages/ArmorPipelinePage";
import {
  ShellPreviewViewer,
  type ShellPreviewViewerRef,
} from "./ShellPreviewViewer";

interface ArmorPreviewTabProps {
  /** Full armor kit from the pipeline (accumulated from TextureGeneratorTab) */
  armorKit: Map<string, ArmorKitPiece>;
}

function getPublishedSlotItemName(
  slot: string,
  tier: string,
): { itemId: string; itemName: string } {
  const nameMap: Record<string, string> = {
    helmet: "full_helm",
    body: "platebody",
    legs: "platelegs",
    boots: "boots",
    gloves: "gloves",
  };
  const suffix = nameMap[slot] ?? slot;
  const itemId = `${tier}_${suffix}`;
  const tierLabel =
    MATERIAL_TIERS.find((entry) => entry.id === tier)?.label ?? tier;
  const suffixLabel = suffix
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return { itemId, itemName: `${tierLabel} ${suffixLabel}` };
}

export const ArmorPreviewTab: React.FC<ArmorPreviewTabProps> = ({
  armorKit,
}) => {
  const viewerRef = useRef<ShellPreviewViewerRef>(null);
  const shellServiceRef = useRef<ShellExtractionService | null>(null);
  const riggingServiceRef = useRef<ShellRiggingService | null>(null);

  // State
  const [avatarUrl, setAvatarUrl] = useState(AVATAR_OPTIONS[0].url);
  const [isRigging, setIsRigging] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  // Publish to game
  const [publishTier, setPublishTier] = useState("bronze");
  const [isPublishing, setIsPublishing] = useState(false);

  // Upload GLB settings (slot/bulk for standalone uploads)
  const [uploadSlot, setUploadSlot] = useState<EquipmentSlotName>("body");
  const [uploadBulk, setUploadBulk] = useState<BulkClass>("plate");
  const [extractionCache, setExtractionCache] =
    useState<ShellExtractionResult | null>(null);
  const selectedAvatarId =
    AVATAR_OPTIONS.find((avatar) => avatar.url === avatarUrl)?.id ?? null;

  // Per-piece state
  const [riggedPieces, setRiggedPieces] = useState<
    Map<string, RiggedArmorResult>
  >(new Map());
  /** Which kit pieces are enabled for rigging */
  const [enabledPieces, setEnabledPieces] = useState<Set<string>>(new Set());
  /** Which rigged pieces are currently visible */
  const [visiblePieces, setVisiblePieces] = useState<Set<string>>(new Set());

  // Sync enabledPieces when kit changes — auto-enable new pieces
  React.useEffect(() => {
    setEnabledPieces((prev) => {
      const next = new Set(prev);
      for (const key of armorKit.keys()) {
        next.add(key); // auto-enable new pieces
      }
      // Remove pieces no longer in kit
      for (const key of next) {
        if (!armorKit.has(key)) next.delete(key);
      }
      return next;
    });
  }, [armorKit]);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [
      ...prev.slice(-50),
      `[${new Date().toLocaleTimeString()}] ${msg}`,
    ]);
  }, []);

  /** Parse slot label from key like "body_plate" */
  const pieceLabel = (key: string) => {
    const [slot, bulk] = key.split("_");
    const slotLabel = SLOT_LABELS[slot as EquipmentSlotName] ?? slot;
    return `${slotLabel} (${bulk})`;
  };

  /** Rig all enabled pieces */
  const handleRigAll = useCallback(async () => {
    const piecesToRig = Array.from(enabledPieces).filter((k) =>
      armorKit.has(k),
    );
    if (piecesToRig.length === 0) {
      setError(
        "No pieces to rig. Texture some shells first in the Texture or Tiers tab.",
      );
      return;
    }

    setIsRigging(true);
    setError(null);
    setRiggedPieces(new Map());
    setVisiblePieces(new Set());

    try {
      if (!shellServiceRef.current) {
        shellServiceRef.current = new ShellExtractionService();
      }
      if (!riggingServiceRef.current) {
        riggingServiceRef.current = new ShellRiggingService();
      }

      // Load VRM once for all pieces
      addLog(`Loading avatar: ${avatarUrl}`);
      const {
        vrm,
        skeleton: vrmSkeleton,
        scene: vrmScene,
      } = await shellServiceRef.current.loadVRM(avatarUrl);

      // Set up the avatar in the viewer (ghost material + mixer)
      viewerRef.current?.setupAvatar(vrmScene, vrm as unknown as VRM);
      addLog("Avatar loaded. Rigging pieces...");

      // Rig each piece
      const newRigged = new Map<string, RiggedArmorResult>();
      const newVisible = new Set<string>();

      for (const key of piecesToRig) {
        const piece = armorKit.get(key)!;
        addLog(`Rigging ${pieceLabel(key)}...`);

        const result = await riggingServiceRef.current.rigTexturedShell(
          piece.shell,
          piece.texturedUrl,
          vrmSkeleton,
        );

        newRigged.set(key, result);
        newVisible.add(key);

        // Add to viewer
        viewerRef.current?.addArmorPiece(key, result.skinnedMesh);

        addLog(
          `  ${pieceLabel(key)}: ${result.vertexCount} verts, match=${result.vertexMatch}`,
        );
      }

      setRiggedPieces(newRigged);
      setVisiblePieces(newVisible);
      addLog(
        `All ${piecesToRig.length} pieces rigged. Use animation buttons to test.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addLog(`ERROR: ${msg}`);
    } finally {
      setIsRigging(false);
    }
  }, [avatarUrl, armorKit, enabledPieces, addLog]);

  /** Toggle a piece's enabled state (for rigging) */
  const toggleEnabled = (key: string) => {
    setEnabledPieces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Toggle a rigged piece's visibility */
  const toggleVisible = (key: string) => {
    const isVisible = visiblePieces.has(key);
    const newVisible = new Set(visiblePieces);
    if (isVisible) {
      newVisible.delete(key);
    } else {
      newVisible.add(key);
    }
    setVisiblePieces(newVisible);
    viewerRef.current?.setArmorPieceVisible(key, !isVisible);
  };

  /** Play an animation */
  const handlePlayAnimation = useCallback(
    async (animUrl: string, name: string) => {
      if (riggedPieces.size === 0) return;
      try {
        addLog(`Playing animation: ${name}`);
        setIsAnimating(true);
        await viewerRef.current?.playAnimation(animUrl);
      } catch (err) {
        addLog(`Animation error: ${err}`);
      }
    },
    [riggedPieces, addLog],
  );

  /** Stop animation (T-Pose) */
  const handleStopAnimation = useCallback(() => {
    viewerRef.current?.stopAnimation();
    setIsAnimating(false);
    addLog("Stopped animation (T-Pose)");
  }, [addLog]);

  /** Download all visible rigged pieces as GLBs */
  const handleDownloadAll = useCallback(async () => {
    if (!riggingServiceRef.current) return;

    for (const [key, result] of riggedPieces) {
      if (!visiblePieces.has(key)) continue;
      try {
        addLog(`Exporting ${pieceLabel(key)}...`);
        if (!selectedAvatarId) throw new Error("Selected avatar is unknown");
        const { itemId } = getPublishedSlotItemName(
          result.slotName,
          publishTier,
        );
        const blob = await riggingServiceRef.current.exportRiggedGLB(result, {
          itemId,
          compatibleAvatarIds: [selectedAvatarId],
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rigged_${key}.glb`;
        a.click();
        URL.revokeObjectURL(url);
        addLog(`  ${pieceLabel(key)}: ${(blob.size / 1024).toFixed(1)}KB`);
      } catch (err) {
        addLog(`Export error for ${key}: ${err}`);
      }
    }
  }, [riggedPieces, visiblePieces, selectedAvatarId, publishTier, addLog]);

  /** Publish all visible rigged pieces to the game's model directory + update armor manifest */
  const handlePublishToGame = useCallback(async () => {
    if (!riggingServiceRef.current || riggedPieces.size === 0) return;

    setIsPublishing(true);
    let successCount = 0;
    const total = Array.from(riggedPieces.keys()).filter((k) =>
      visiblePieces.has(k),
    ).length;

    addLog(`Publishing ${total} piece(s) as "${publishTier}" tier to game...`);

    for (const [key, result] of riggedPieces) {
      if (!visiblePieces.has(key)) continue;
      try {
        addLog(`  Exporting ${pieceLabel(key)}...`);
        const { itemId, itemName } = getPublishedSlotItemName(
          result.slotName,
          publishTier,
        );
        if (!selectedAvatarId) throw new Error("Selected avatar is unknown");
        const blob = await riggingServiceRef.current.exportRiggedGLB(result, {
          itemId,
          compatibleAvatarIds: [selectedAvatarId],
        });
        addLog(`  Publishing ${itemName} (${itemId})...`);

        const resp = await riggingServiceRef.current.publishToGame(blob, {
          itemId,
          slot: result.slotName,
          itemName,
          tier: publishTier,
        });

        if (resp.success) {
          addLog(
            `  ✓ ${itemName}: ${resp.glbPath} (${(blob.size / 1024).toFixed(1)}KB)`,
          );
          successCount++;
        } else {
          addLog(`  ✗ ${itemName}: ${resp.error}`);
        }
      } catch (err) {
        addLog(`  ✗ ${pieceLabel(key)}: ${err}`);
      }
    }

    addLog(
      successCount === total
        ? `Published ${successCount}/${total} pieces. Restart game server to load.`
        : `Published ${successCount}/${total} — some failed, check logs.`,
    );
    setIsPublishing(false);
  }, [riggedPieces, visiblePieces, publishTier, selectedAvatarId, addLog]);

  /** Load a local GLB — extracts shell on the fly if no kit piece exists for the slot */
  const handleLoadGLB = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".glb,.gltf";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      const fileUrl = URL.createObjectURL(file);
      setIsRigging(true);
      setError(null);

      try {
        if (!shellServiceRef.current)
          shellServiceRef.current = new ShellExtractionService();
        if (!riggingServiceRef.current)
          riggingServiceRef.current = new ShellRiggingService();

        // Get or extract shell for the selected slot/bulk
        const shellKey = `${uploadSlot}_${uploadBulk}`;
        let shell = armorKit.get(shellKey)?.shell;

        if (!shell) {
          // Extract shells from avatar on the fly
          let extraction = extractionCache;
          if (!extraction) {
            addLog("Extracting shells from avatar (first time)...");
            extraction = await shellServiceRef.current.extractShells(
              avatarUrl,
              ALL_SLOTS,
              ALL_BULKS,
              (prog) => addLog(prog.message),
            );
            setExtractionCache(extraction);
            addLog("Shell extraction complete.");
          }
          shell = extraction.shells.get(shellKey);
          if (!shell) throw new Error(`Shell not found: ${shellKey}`);
        }

        // Load VRM for rigging
        addLog(`Loading avatar: ${avatarUrl}`);
        const {
          vrm,
          skeleton: vrmSkeleton,
          scene: vrmScene,
        } = await shellServiceRef.current.loadVRM(avatarUrl);

        if (riggedPieces.size === 0) {
          viewerRef.current?.setupAvatar(vrmScene, vrm as unknown as VRM);
        }

        addLog(`Rigging local GLB: ${file.name} → ${shellKey}`);
        const result = await riggingServiceRef.current.rigTexturedShell(
          shell,
          fileUrl,
          vrmSkeleton,
        );

        const key = `${result.slotName}_${result.bulkClass}`;
        viewerRef.current?.addArmorPiece(key, result.skinnedMesh);

        setRiggedPieces((prev) => new Map(prev).set(key, result));
        setVisiblePieces((prev) => new Set(prev).add(key));
        addLog(`Rigged ${pieceLabel(key)} from local file.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        addLog(`ERROR: ${msg}`);
      } finally {
        URL.revokeObjectURL(fileUrl);
        setIsRigging(false);
      }
    };
    input.click();
  }, [
    avatarUrl,
    uploadSlot,
    uploadBulk,
    armorKit,
    extractionCache,
    riggedPieces,
    addLog,
  ]);

  /** Reset everything */
  const handleReset = useCallback(() => {
    viewerRef.current?.clear();
    setRiggedPieces(new Map());
    setVisiblePieces(new Set());
    setError(null);
    setLogs([]);
    setIsAnimating(false);
  }, []);

  const hasKit = armorKit.size > 0;
  const hasRigged = riggedPieces.size > 0;

  return (
    <div className="flex h-full">
      {/* Left panel — Controls */}
      <div className="w-80 flex-shrink-0 border-r border-border-primary bg-bg-primary overflow-y-auto">
        <div className="p-4 space-y-5">
          {/* Header */}
          <div>
            <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <Package size={20} className="text-primary" />
              Rig &amp; Preview
            </h2>
            <p className="text-xs text-text-tertiary mt-1">
              Re-rig textured armor and preview on animated avatar
            </p>
          </div>

          {/* Avatar Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-secondary">
              Avatar
            </label>
            <select
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-sm text-text-primary"
            >
              {AVATAR_OPTIONS.map((opt) => (
                <option key={opt.url} value={opt.url}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Kit Pieces */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-text-secondary">
              Armor Kit ({armorKit.size} piece{armorKit.size !== 1 ? "s" : ""})
            </label>
            {!hasKit ? (
              <p className="text-xs text-text-tertiary italic px-1">
                No pieces yet. Use the Texture or Tiers tab, then click
                &quot;Add to Kit&quot;.
              </p>
            ) : (
              <div className="space-y-1">
                {Array.from(armorKit.keys()).map((key) => {
                  const isEnabled = enabledPieces.has(key);
                  const isRiggedPiece = riggedPieces.has(key);
                  const isVisible = visiblePieces.has(key);

                  return (
                    <div
                      key={key}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-bg-secondary border border-border-primary"
                    >
                      {/* Enable checkbox (pre-rig) */}
                      {!hasRigged && (
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={() => toggleEnabled(key)}
                          className="accent-primary"
                        />
                      )}

                      {/* Visibility toggle (post-rig) */}
                      {hasRigged && isRiggedPiece && (
                        <button
                          onClick={() => toggleVisible(key)}
                          className="text-text-tertiary hover:text-text-primary"
                          title={isVisible ? "Hide" : "Show"}
                        >
                          {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                        </button>
                      )}

                      <span
                        className={`text-xs font-medium flex-1 ${
                          (hasRigged ? isVisible : isEnabled)
                            ? "text-text-primary"
                            : "text-text-tertiary"
                        }`}
                      >
                        {pieceLabel(key)}
                      </span>

                      {isRiggedPiece && (
                        <span className="text-[10px] text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">
                          Rigged
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Rig Actions */}
          <div className="space-y-2 pt-2 border-t border-border-primary">
            <button
              onClick={handleRigAll}
              disabled={isRigging || !hasKit || enabledPieces.size === 0}
              className="w-full px-4 py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2
                bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRigging ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Rigging...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Rig {enabledPieces.size} Piece
                  {enabledPieces.size !== 1 ? "s" : ""}
                </>
              )}
            </button>

            {/* Upload GLB with slot/bulk selector */}
            <div className="space-y-1.5 p-2 bg-bg-secondary rounded-lg border border-border-primary">
              <div className="flex items-center gap-1.5">
                <Upload size={12} className="text-text-tertiary" />
                <span className="text-xs font-medium text-text-secondary">
                  Upload GLB
                </span>
              </div>
              <div className="flex gap-1.5">
                <select
                  value={uploadSlot}
                  onChange={(e) =>
                    setUploadSlot(e.target.value as EquipmentSlotName)
                  }
                  className="flex-1 bg-bg-primary border border-border-primary rounded px-1.5 py-1 text-[11px] text-text-primary"
                >
                  {ALL_SLOTS.map((slot) => (
                    <option key={slot} value={slot}>
                      {SLOT_LABELS[slot]}
                    </option>
                  ))}
                </select>
                <select
                  value={uploadBulk}
                  onChange={(e) => setUploadBulk(e.target.value as BulkClass)}
                  className="flex-1 bg-bg-primary border border-border-primary rounded px-1.5 py-1 text-[11px] text-text-primary"
                >
                  {ALL_BULKS.map((bulk) => (
                    <option key={bulk} value={bulk}>
                      {bulk} ({BULK_OFFSETS[bulk] * 1000}mm)
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={handleLoadGLB}
                disabled={isRigging}
                className="w-full px-3 py-1.5 rounded text-xs font-medium transition-all flex items-center justify-center gap-1.5
                  bg-bg-primary border border-border-primary text-text-secondary hover:text-text-primary hover:border-border-secondary
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload size={12} />
                Choose GLB File
              </button>
            </div>
          </div>

          {/* Animation Controls */}
          {hasRigged && (
            <div className="space-y-2 pt-2 border-t border-border-primary">
              <label className="text-sm font-medium text-text-secondary">
                Animation
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  onClick={handleStopAnimation}
                  className={`px-2 py-1.5 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-1 ${
                    !isAnimating
                      ? "bg-primary/20 text-primary border border-primary/30"
                      : "bg-bg-secondary text-text-tertiary border border-border-primary hover:border-border-secondary"
                  }`}
                >
                  <PersonStanding size={12} />
                  T-Pose
                </button>
                <button
                  onClick={() =>
                    handlePlayAnimation(ANIMATION_URLS.walking, "Walk")
                  }
                  className="px-2 py-1.5 rounded-md text-xs font-medium bg-bg-secondary text-text-tertiary border border-border-primary hover:border-border-secondary transition-all flex items-center justify-center gap-1"
                >
                  <Play size={12} />
                  Walk
                </button>
                <button
                  onClick={() =>
                    handlePlayAnimation(ANIMATION_URLS.running, "Run")
                  }
                  className="px-2 py-1.5 rounded-md text-xs font-medium bg-bg-secondary text-text-tertiary border border-border-primary hover:border-border-secondary transition-all flex items-center justify-center gap-1"
                >
                  <Play size={12} />
                  Run
                </button>
              </div>
            </div>
          )}

          {/* Export + Reset */}
          {hasRigged && (
            <div className="flex gap-2">
              <button
                onClick={handleDownloadAll}
                className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5
                  bg-bg-secondary border border-border-primary text-text-secondary hover:text-text-primary hover:border-border-secondary"
              >
                <Download size={14} />
                Download All
              </button>

              <button
                onClick={handleReset}
                className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5
                  bg-bg-secondary border border-border-primary text-text-secondary hover:text-text-primary hover:border-border-secondary"
              >
                <RotateCcw size={14} />
                Reset
              </button>
            </div>
          )}

          {/* Publish to Game */}
          {hasRigged && (
            <div className="space-y-2 pt-2 border-t border-border-primary">
              <label className="text-sm font-medium text-text-secondary flex items-center gap-1.5">
                <Rocket size={14} className="text-primary" />
                Publish to Game
              </label>
              <p className="text-[10px] text-text-tertiary leading-tight">
                Exports rigged GLBs and updates the armor manifest so the game
                can load and equip them.
              </p>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-text-tertiary w-10">
                    Tier
                  </label>
                  <select
                    value={publishTier}
                    onChange={(e) => setPublishTier(e.target.value)}
                    className="flex-1 bg-bg-secondary border border-border-primary rounded px-2 py-1.5 text-xs text-text-primary"
                  >
                    {MATERIAL_TIERS.map((tier) => (
                      <option key={tier.id} value={tier.id}>
                        {tier.label}
                      </option>
                    ))}
                  </select>
                  <div
                    className="w-5 h-5 rounded border border-border-primary flex-shrink-0"
                    style={{
                      backgroundColor:
                        MATERIAL_TIERS.find((t) => t.id === publishTier)
                          ?.color ?? "#888",
                    }}
                  />
                </div>
              </div>
              <button
                onClick={handlePublishToGame}
                disabled={isPublishing || riggedPieces.size === 0}
                className="w-full px-4 py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2
                  bg-green-600 text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPublishing ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Publishing...
                  </>
                ) : (
                  <>
                    <Rocket size={16} />
                    Publish{" "}
                    {
                      Array.from(riggedPieces.keys()).filter((k) =>
                        visiblePieces.has(k),
                      ).length
                    }{" "}
                    Piece
                    {Array.from(riggedPieces.keys()).filter((k) =>
                      visiblePieces.has(k),
                    ).length !== 1
                      ? "s"
                      : ""}
                  </>
                )}
              </button>
            </div>
          )}

          {/* Stats */}
          {hasRigged && (
            <div className="p-3 bg-bg-secondary rounded-lg border border-border-primary space-y-1.5">
              <h3 className="text-xs font-semibold text-text-primary">
                Rigging Stats
              </h3>
              {Array.from(riggedPieces.entries()).map(([key, result]) => (
                <div
                  key={key}
                  className="flex items-center justify-between text-xs text-text-tertiary"
                >
                  <span>{pieceLabel(key)}</span>
                  <span className="flex items-center gap-1.5">
                    <span>{result.vertexCount.toLocaleString()} verts</span>
                    <span
                      className={`px-1 py-0.5 rounded text-[9px] ${
                        result.vertexMatch
                          ? "bg-green-400/10 text-green-400"
                          : "bg-yellow-400/10 text-yellow-400"
                      }`}
                    >
                      {result.vertexMatch ? "exact" : "transferred"}
                    </span>
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs text-text-tertiary pt-1 border-t border-border-primary">
                <span>Skeleton</span>
                <span>
                  {riggedPieces.values().next().value?.skeleton.bones.length ??
                    0}{" "}
                  bones
                </span>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Center — 3D Viewer */}
      <div className="flex-1 flex flex-col">
        <ShellPreviewViewer ref={viewerRef} className="flex-1" />

        {/* Bottom log panel */}
        <div
          className="h-32 border-t border-border-primary bg-bg-primary overflow-y-auto"
          ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <div className="p-2 space-y-0.5">
            {logs.length === 0 ? (
              <p className="text-xs text-text-tertiary italic">
                Add textured pieces from the Texture or Tiers tab, then click
                &quot;Rig&quot; to preview
              </p>
            ) : (
              logs.map((log, i) => (
                <p
                  key={i}
                  className={`text-xs font-mono ${
                    log.includes("ERROR")
                      ? "text-red-400"
                      : log.includes("rigged") ||
                          log.includes("All") ||
                          log.includes("Published")
                        ? "text-green-400"
                        : "text-text-tertiary"
                  }`}
                >
                  {log}
                </p>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
