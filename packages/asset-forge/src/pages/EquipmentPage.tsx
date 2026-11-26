import React, { useState, useRef, useEffect, useCallback } from "react";

import { Asset } from "../types";
import { getAssetModelUrl, getFullUrl } from "../utils/api";
import { notify } from "../utils/notify";

import {
  AssetSelectionPanel,
  ViewportSection,
  EquipmentSlotSelector,
  GripDetectionPanel,
  OrientationControls,
  PositionControls,
  CreatureSizeControls,
  ExportOptionsPanel,
  BatchProgressOverlay,
  BatchReviewBar,
} from "@/components/Equipment";
import type { BatchProgress, BatchReviewState } from "@/components/Equipment";
import { EquipmentViewerRef } from "@/components/Equipment/EquipmentViewer";
import { useAssets } from "@/hooks";
import { WeaponHandleDetector } from "@/services/processing/WeaponHandleDetector";
import type { HandleDetectionResult } from "@/services/processing/WeaponHandleDetector";

// Import all modular components

export const EquipmentPage: React.FC = () => {
  const { assets, loading } = useAssets();
  // Selected items
  const [selectedAvatar, setSelectedAvatar] = useState<Asset | null>(null);
  const [selectedEquipment, setSelectedEquipment] = useState<Asset | null>(
    null,
  );

  // Equipment fitting states
  const [isDetectingHandle, setIsDetectingHandle] = useState(false);
  const [handleDetectionResult, setHandleDetectionResult] =
    useState<HandleDetectionResult | null>(null);
  const [equipmentSlot, setEquipmentSlot] = useState("Hand_R");
  const [showSkeleton, setShowSkeleton] = useState(false);

  // Creature sizing
  const [avatarHeight, setAvatarHeight] = useState(1.83); // Default medium creature height
  const [creatureCategory, setCreatureCategory] = useState("medium");
  const [autoScaleWeapon, setAutoScaleWeapon] = useState(true);
  const [weaponScaleOverride, setWeaponScaleOverride] = useState(1.0); // Base scale, auto-scale will adjust based on creature size

  // Manual rotation controls
  const [manualRotation, setManualRotation] = useState({ x: 0, y: 0, z: 0 });

  // Manual position controls
  const [manualPosition, setManualPosition] = useState({ x: 0, y: 0, z: 0 });

  // Animation controls
  const [currentAnimation, setCurrentAnimation] = useState<
    "tpose" | "walking" | "running"
  >("tpose");
  const [isAnimationPlaying, setIsAnimationPlaying] = useState(false);

  // Batch operation state
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(
    null,
  );
  const [batchReview, setBatchReview] = useState<BatchReviewState | null>(null);
  const batchCancelRef = useRef(false);
  // Preserve the equipment selected before entering review mode
  const preReviewEquipmentRef = useRef<Asset | null>(null);

  const viewerRef = useRef<EquipmentViewerRef>(null);
  const handleDetector = useRef<WeaponHandleDetector | null>(null);

  // Initialize handle detector
  useEffect(() => {
    handleDetector.current = new WeaponHandleDetector();

    return () => {
      // Cleanup on unmount
      if (handleDetector.current) {
        handleDetector.current.dispose();
        handleDetector.current = null;
      }
    };
  }, []);

  const handleDetectGripPoint = async () => {
    if (
      !selectedEquipment ||
      !selectedEquipment.hasModel ||
      !handleDetector.current
    )
      return;

    setIsDetectingHandle(true);

    try {
      const modelUrl = getAssetModelUrl(selectedEquipment.id);
      const result = await handleDetector.current.detectHandleArea(
        modelUrl,
        true,
      ); // Always use consensus mode
      setHandleDetectionResult(result);

      // Log the result for analysis
      console.log("Grip detection result:", {
        gripPoint: result.gripPoint,
        confidence: result.confidence,
        bounds: result.redBoxBounds,
        vertexCount: result.vertices?.length || 0,
      });

      // With normalized weapons, grip should already be at origin
      if (result.gripPoint.length() > 0.1) {
        console.warn("Weapon may not be normalized - grip not at origin");
      }

      // Show success message
      setTimeout(() => {
        notify.success(
          "Grip point detected! Weapon is normalized with grip at origin.",
        );
      }, 100);
    } catch (error) {
      console.error("Handle detection failed:", error);
      notify.error(
        `Handle detection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setIsDetectingHandle(false);
    }
  };

  const handleSaveConfiguration = async () => {
    if (!selectedEquipment || !selectedAvatar) return;

    const config = {
      hyperiaAttachment: {
        vrmBoneName:
          equipmentSlot === "Hand_R"
            ? "rightHand"
            : equipmentSlot === "Hand_L"
              ? "leftHand"
              : "rightHand",
        position: manualPosition,
        rotation: manualRotation,
        scale: autoScaleWeapon ? weaponScaleOverride : weaponScaleOverride,
        gripPoint: handleDetectionResult?.gripPoint || { x: 0, y: 0, z: 0 },
        avatarHeight,
        weaponType: selectedEquipment.type || "weapon",
        testedWithAvatar: selectedAvatar.id,
        lastUpdated: new Date().toISOString(),
      },
    };

    try {
      // Save attachment config to equipment metadata
      const response = await fetch(
        getFullUrl(`/api/assets/${selectedEquipment.id}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metadata: config }),
        },
      );

      if (!response.ok) throw new Error("Failed to save configuration");

      notify.success("Attachment configuration saved!");
      console.log("Saved attachment configuration:", config);
    } catch (error) {
      console.error("Failed to save configuration:", error);
      notify.error("Failed to save configuration");
    }
  };

  const handleExportAlignedModel = async () => {
    if (!selectedAvatar || !selectedEquipment || !viewerRef.current) return;

    try {
      const alignedModel = await viewerRef.current.exportAlignedEquipment({
        itemId: selectedEquipment.id,
        avatarId: selectedAvatar.id,
      });

      // Create download link
      const blob = new Blob([alignedModel], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selectedEquipment.name}-aligned.glb`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Export failed:", error);
    }
  };

  const handleExportEquippedAvatar = async () => {
    if (!selectedAvatar || !selectedEquipment || !viewerRef.current) return;

    try {
      const equippedModel = await viewerRef.current.exportEquippedModel();

      // Create download link
      const blob = new Blob([equippedModel], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selectedAvatar.name}-equipped.glb`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Export failed:", error);
    }
  };

  // Called by EquipmentViewer when equipment finishes loading
  const handleEquipmentLoaded = useCallback(() => {
    // Currently unused but kept as a hook for future features
  }, []);

  // Get all same-subtype weapon assets (excluding selected)
  const getSameSubtypeAssets = (): Asset[] => {
    if (!selectedEquipment) return [];
    const subtype = selectedEquipment.metadata?.subtype as string | undefined;
    if (!subtype) return [];
    return assets.filter(
      (a) =>
        a.type === "weapon" &&
        (a.metadata?.subtype as string) === subtype &&
        a.id !== selectedEquipment.id &&
        a.hasModel,
    );
  };

  const handleBatchApplyFitting = async () => {
    if (!selectedEquipment || !selectedAvatar) return;

    const sameSubtype = getSameSubtypeAssets();
    if (sameSubtype.length === 0) {
      notify.error("No other weapons of the same subtype found");
      return;
    }

    const config = {
      hyperiaAttachment: {
        vrmBoneName:
          equipmentSlot === "Hand_R"
            ? "rightHand"
            : equipmentSlot === "Hand_L"
              ? "leftHand"
              : "rightHand",
        position: manualPosition,
        rotation: manualRotation,
        scale: weaponScaleOverride,
        gripPoint: handleDetectionResult?.gripPoint || { x: 0, y: 0, z: 0 },
        avatarHeight,
        weaponType: selectedEquipment.type || "weapon",
        testedWithAvatar: selectedAvatar.id,
        lastUpdated: new Date().toISOString(),
      },
    };

    const assetIds = sameSubtype.map((a) => a.id);

    setBatchProgress({
      current: 0,
      total: assetIds.length,
      currentAsset: "Starting...",
      phase: "applying",
    });
    batchCancelRef.current = false;

    try {
      const response = await fetch(
        getFullUrl("/api/assets/batch-apply-fitting"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config, assetIds }),
        },
      );

      if (!response.ok) throw new Error("Batch apply fitting failed");

      const result = await response.json();
      notify.success(`Fitting applied to ${result.updated} weapons`);
    } catch (error) {
      console.error("Batch apply fitting failed:", error);
      notify.error("Failed to batch apply fitting");
    } finally {
      setBatchProgress(null);
    }
  };

  // --- Batch Review Mode ---

  const handleStartBatchReview = () => {
    if (!selectedEquipment || !selectedAvatar) return;

    const sameSubtype = getSameSubtypeAssets();
    const allWeapons = [selectedEquipment, ...sameSubtype];

    if (allWeapons.length <= 1) {
      notify.error("No other weapons of the same subtype found");
      return;
    }

    preReviewEquipmentRef.current = selectedEquipment;

    setBatchReview({
      weapons: allWeapons.map((w) => ({ id: w.id, name: w.name })),
      currentIndex: 0,
      exported: new Set(),
      isExporting: false,
    });
  };

  const handleReviewNavigate = async (index: number) => {
    if (!batchReview || batchReview.isExporting) return;
    if (index < 0 || index >= batchReview.weapons.length) return;

    const weapon = batchReview.weapons[index];
    const asset = assets.find((a) => a.id === weapon.id);
    if (!asset) return;

    setBatchReview((prev) => (prev ? { ...prev, currentIndex: index } : null));

    // Swap only the visual mesh content — keeps all transforms locked
    if (viewerRef.current?.swapEquipmentContent) {
      const url = getAssetModelUrl(asset.id);
      await viewerRef.current.swapEquipmentContent(url);
    }
  };

  const handleReviewPrev = () => {
    if (batchReview) handleReviewNavigate(batchReview.currentIndex - 1);
  };

  const handleReviewNext = () => {
    if (batchReview) handleReviewNavigate(batchReview.currentIndex + 1);
  };

  const handleReviewSkip = () => {
    if (!batchReview) return;
    if (batchReview.currentIndex < batchReview.weapons.length - 1) {
      handleReviewNavigate(batchReview.currentIndex + 1);
    }
  };

  // Export a single weapon (the one currently shown in the viewer)
  const exportCurrentWeapon = async (weaponOverride?: {
    id: string;
    name: string;
  }): Promise<boolean> => {
    if (!batchReview || !viewerRef.current) return false;

    const weapon =
      weaponOverride || batchReview.weapons[batchReview.currentIndex];

    setBatchReview((prev) => (prev ? { ...prev, isExporting: true } : null));

    try {
      if (!selectedAvatar) {
        notify.error("Select the fitted avatar before exporting");
        return false;
      }
      const alignedModel = await viewerRef.current.exportAlignedEquipment({
        itemId: weapon.id,
        avatarId: selectedAvatar.id,
      });
      if (alignedModel.byteLength === 0) {
        notify.error(`Empty export for ${weapon.name}`);
        return false;
      }

      // Browser download
      const blob = new Blob([alignedModel], { type: "model/gltf-binary" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${weapon.name}-aligned.glb`;
      a.click();
      URL.revokeObjectURL(url);

      // Save to server
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([alignedModel], { type: "model/gltf-binary" }),
        `${weapon.id}-aligned.glb`,
      );
      await fetch(getFullUrl(`/api/assets/${weapon.id}/save-aligned`), {
        method: "POST",
        body: formData,
      });

      // Mark as exported
      setBatchReview((prev) => {
        if (!prev) return null;
        const exported = new Set(prev.exported);
        exported.add(weapon.id);
        return { ...prev, exported };
      });

      return true;
    } catch (error) {
      console.error(`Failed to export ${weapon.name}:`, error);
      notify.error(`Failed to export ${weapon.name}`);
      return false;
    } finally {
      setBatchReview((prev) => (prev ? { ...prev, isExporting: false } : null));
    }
  };

  const handleReviewExportCurrent = async () => {
    const ok = await exportCurrentWeapon();
    if (ok && batchReview) {
      // Auto-advance to next un-exported weapon
      const nextIndex = batchReview.weapons.findIndex(
        (w, i) =>
          i > batchReview.currentIndex && !batchReview.exported.has(w.id),
      );
      if (nextIndex !== -1) {
        // Small delay so the user sees the green checkmark
        setTimeout(() => handleReviewNavigate(nextIndex), 400);
      }
    }
  };

  const handleReviewExportAll = async () => {
    if (!batchReview) return;

    batchCancelRef.current = false;

    // Snapshot the weapons list and track exported locally to avoid stale closure
    const weapons = batchReview.weapons;
    const localExported = new Set(batchReview.exported);

    for (let i = 0; i < weapons.length; i++) {
      if (batchCancelRef.current) break;

      const weapon = weapons[i];

      // Skip already exported
      if (localExported.has(weapon.id)) continue;

      // Swap visual content (no reload, transforms locked)
      await handleReviewNavigate(i);
      // Small settle time for GPU to process new mesh
      await new Promise((r) => setTimeout(r, 200));

      const ok = await exportCurrentWeapon(weapon);
      if (!ok) {
        notify.error(`Failed on ${weapon.name}, stopping.`);
        break;
      }

      localExported.add(weapon.id);
    }

    if (localExported.size === weapons.length) {
      notify.success(`All ${weapons.length} weapons exported!`);
    }
  };

  const handleReviewDone = async () => {
    if (batchReview?.isExporting) return;

    const exportedCount = batchReview?.exported.size || 0;
    const total = batchReview?.weapons.length || 0;

    // Restore original weapon's visual content before clearing review state
    if (
      preReviewEquipmentRef.current &&
      viewerRef.current?.swapEquipmentContent
    ) {
      const url = getAssetModelUrl(preReviewEquipmentRef.current.id);
      await viewerRef.current.swapEquipmentContent(url);
    }

    preReviewEquipmentRef.current = null;
    setBatchReview(null);

    if (exportedCount > 0) {
      notify.success(`Exported ${exportedCount}/${total} weapons`);
    }
  };

  const handleBatchCancel = () => {
    batchCancelRef.current = true;
  };

  const handleReset = () => {
    setAvatarHeight(1.83);
    setCreatureCategory("medium");
    setWeaponScaleOverride(1.0);
  };

  // Reset manual adjustments when equipment changes (but not during batch review)
  useEffect(() => {
    if (batchReview) return;
    setManualPosition({ x: 0, y: 0, z: 0 });
    setManualRotation({ x: 0, y: 0, z: 0 });
  }, [selectedEquipment, batchReview]);

  return (
    <div className="flex h-[calc(100vh-60px)] bg-gradient-to-br from-bg-primary to-bg-secondary p-4 gap-4">
      {/* Left Panel - Asset Selection */}
      <AssetSelectionPanel
        assets={assets}
        loading={loading}
        selectedAvatar={selectedAvatar}
        selectedEquipment={selectedEquipment}
        onSelectAvatar={setSelectedAvatar}
        onSelectEquipment={setSelectedEquipment}
      />

      {/* Center - 3D Viewport */}
      <div className="flex-1 flex flex-col relative">
        <ViewportSection
          selectedAvatar={selectedAvatar}
          selectedEquipment={selectedEquipment}
          equipmentSlot={equipmentSlot}
          showSkeleton={showSkeleton}
          setShowSkeleton={setShowSkeleton}
          viewerRef={viewerRef}
          handleDetectionResult={handleDetectionResult}
          avatarHeight={avatarHeight}
          autoScaleWeapon={autoScaleWeapon}
          weaponScaleOverride={weaponScaleOverride}
          manualRotation={manualRotation}
          manualPosition={manualPosition}
          currentAnimation={currentAnimation}
          setCurrentAnimation={setCurrentAnimation}
          isAnimationPlaying={isAnimationPlaying}
          setIsAnimationPlaying={setIsAnimationPlaying}
          onEquipmentLoaded={handleEquipmentLoaded}
        />

        {/* Batch Review Bar */}
        {batchReview && (
          <BatchReviewBar
            review={batchReview}
            onPrev={handleReviewPrev}
            onNext={handleReviewNext}
            onExportCurrent={handleReviewExportCurrent}
            onExportAll={handleReviewExportAll}
            onSkip={handleReviewSkip}
            onDone={handleReviewDone}
          />
        )}
      </div>

      {/* Right Panel - Controls */}
      <div className="card overflow-hidden w-96 flex flex-col bg-gradient-to-br from-bg-primary to-bg-secondary">
        {/* Header */}
        <div className="p-4 border-b border-border-primary bg-bg-primary bg-opacity-30">
          <h2 className="text-lg font-semibold text-text-primary">
            Fitting Controls
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="p-4 space-y-4">
            {/* Equipment Slot Selection */}
            <EquipmentSlotSelector
              equipmentSlot={equipmentSlot}
              onSlotChange={setEquipmentSlot}
            />

            {/* AI Handle Detection */}
            <GripDetectionPanel
              selectedEquipment={selectedEquipment}
              isDetectingHandle={isDetectingHandle}
              handleDetectionResult={handleDetectionResult}
              onDetectGripPoint={handleDetectGripPoint}
            />

            {/* Fine-tune Controls */}
            <OrientationControls
              manualRotation={manualRotation}
              onRotationChange={setManualRotation}
              selectedEquipment={selectedEquipment}
            />

            <PositionControls
              manualPosition={manualPosition}
              onPositionChange={setManualPosition}
              selectedEquipment={selectedEquipment}
            />

            {/* Creature Size Controls */}
            <CreatureSizeControls
              avatarHeight={avatarHeight}
              setAvatarHeight={setAvatarHeight}
              creatureCategory={creatureCategory}
              setCreatureCategory={setCreatureCategory}
              autoScaleWeapon={autoScaleWeapon}
              setAutoScaleWeapon={setAutoScaleWeapon}
              weaponScaleOverride={weaponScaleOverride}
              setWeaponScaleOverride={setWeaponScaleOverride}
              selectedEquipment={selectedEquipment}
              onReset={handleReset}
            />

            {/* Actions */}
            <ExportOptionsPanel
              selectedAvatar={selectedAvatar}
              selectedEquipment={selectedEquipment}
              onSaveConfiguration={handleSaveConfiguration}
              onExportAlignedModel={handleExportAlignedModel}
              onExportEquippedAvatar={handleExportEquippedAvatar}
              assets={assets}
              onBatchApplyFitting={handleBatchApplyFitting}
              onBatchExportAligned={handleStartBatchReview}
            />
          </div>
        </div>
      </div>

      {/* Batch Progress Overlay (for apply fitting) */}
      {batchProgress && (
        <BatchProgressOverlay
          progress={batchProgress}
          onCancel={handleBatchCancel}
        />
      )}
    </div>
  );
};

export default EquipmentPage;
