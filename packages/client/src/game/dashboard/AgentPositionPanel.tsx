import { GAME_API_URL } from "@/lib/api-config";
import { getApiAuthorizationHeaders } from "@/lib/api-client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import type { Agent } from "./types";
import {
  ChevronDown,
  ChevronUp,
  MapPin,
  TreePine,
  Landmark,
  Flame,
  Pickaxe,
  Fish,
  Swords,
  Store,
  Home,
} from "lucide-react";

interface Position {
  x: number;
  y: number;
  z: number;
}

interface NearbyLocation {
  type: string;
  name: string;
  distance: number;
}

interface AgentPositionPanelProps {
  agent: Agent;
  isViewportActive: boolean;
}

// Zone detection based on coordinates
function getZoneName(x: number, z: number): string {
  // Central area (spawn)
  if (Math.abs(x) < 30 && Math.abs(z) < 30) {
    return "Central Haven";
  }

  // Forest areas
  if (x > 30 && z > 0) {
    return "Eastern Forest";
  }
  if (x < -30 && z > 0) {
    return "Western Woods";
  }

  // Mining area
  if (x > 0 && z < -30) {
    return "Mining Quarry";
  }

  // Fishing area
  if (x < 0 && z < -30) {
    return "Riverside";
  }

  // Combat areas
  if (Math.abs(x) > 50 || Math.abs(z) > 50) {
    return "Wilderness";
  }

  return "Unknown Region";
}

// POI definitions with their coordinates
const POINTS_OF_INTEREST = [
  { type: "bank", name: "Bank", x: 0, z: 5, icon: Landmark },
  { type: "shop", name: "General Store", x: -10, z: 8, icon: Store },
  { type: "trees", name: "Oak Trees", x: 40, z: 20, icon: TreePine },
  { type: "trees", name: "Willow Trees", x: -35, z: 25, icon: TreePine },
  { type: "furnace", name: "Furnace", x: 15, z: -10, icon: Flame },
  { type: "anvil", name: "Anvil", x: 18, z: -10, icon: Pickaxe },
  { type: "fishing", name: "Fishing Spot", x: -20, z: -40, icon: Fish },
  { type: "combat", name: "Goblin Camp", x: 60, z: 40, icon: Swords },
  { type: "combat", name: "Training Dummies", x: 25, z: -5, icon: Swords },
  { type: "spawn", name: "Spawn Point", x: 0, z: 0, icon: Home },
];

// Calculate distance between two points (2D, ignoring Y)
function getDistance(x1: number, z1: number, x2: number, z2: number): number {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(z2 - z1, 2));
}

// Get nearby POIs sorted by distance
function getNearbyPOIs(
  x: number,
  z: number,
  maxDistance = 50,
): NearbyLocation[] {
  return POINTS_OF_INTEREST.map((poi) => ({
    type: poi.type,
    name: poi.name,
    distance: Math.round(getDistance(x, z, poi.x, poi.z)),
  }))
    .filter((poi) => poi.distance <= maxDistance && poi.distance > 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4);
}

export const AgentPositionPanel: React.FC<AgentPositionPanelProps> = ({
  agent,
  isViewportActive,
}) => {
  const [position, setPosition] = useState<Position | null>(null);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [zoneName, setZoneName] = useState<string>("Unknown");
  const [nearbyPOIs, setNearbyPOIs] = useState<NearbyLocation[]>([]);
  const pollTimeoutRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  // Fetch character ID once when agent changes
  useEffect(() => {
    if (agent.status !== "active") {
      setPosition(null);
      setOnline(false);
      setCharacterId(null);
      setZoneName("Unknown");
      setNearbyPOIs([]);
      return;
    }
    fetchCharacterId();
  }, [agent.id, agent.status]);

  const fetchCharacterId = async () => {
    try {
      setLoading(true);
      setError(null);

      const mappingResponse = await fetch(
        `${GAME_API_URL}/api/agents/mapping/${agent.id}`,
        { headers: getApiAuthorizationHeaders() },
      );

      if (!mappingResponse.ok) {
        if (mappingResponse.status === 404) {
          setError("Agent not mapped");
          return;
        }
        throw new Error(`Mapping failed: ${mappingResponse.status}`);
      }

      const mappingData = await mappingResponse.json();
      const charId = mappingData.characterId;

      if (!charId) {
        setError("No character linked");
        return;
      }

      setCharacterId(charId);
    } catch (err) {
      console.error("[AgentPositionPanel] Error fetching character ID:", err);
      setError("Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  const fetchPosition = useCallback(async () => {
    if (!characterId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const positionResponse = await fetch(
        `${GAME_API_URL}/api/characters/${characterId}/position`,
        { headers: getApiAuthorizationHeaders() },
      );

      if (!positionResponse.ok) {
        throw new Error(`Position failed: ${positionResponse.status}`);
      }

      const positionData = await positionResponse.json();
      setOnline(positionData.online);
      setPosition(positionData.position);

      // Calculate zone and nearby POIs
      if (positionData.position) {
        const { x, z } = positionData.position;
        setZoneName(getZoneName(x, z));
        setNearbyPOIs(getNearbyPOIs(x, z));
      }

      setError(null);
    } catch (err) {
      console.error("[AgentPositionPanel] Error fetching position:", err);
      // Don't set error state on position fetch failure - just keep last known position
    } finally {
      inFlightRef.current = false;
    }
  }, [characterId]);

  // Poll for position updates - always active, faster when viewport is active
  useEffect(() => {
    if (agent.status !== "active" || !characterId) return;

    let cancelled = false;
    const schedule = (delay: number) => {
      if (pollTimeoutRef.current) window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = window.setTimeout(run, delay);
    };
    const run = async () => {
      await fetchPosition();
      if (!cancelled) {
        schedule(!document.hidden && isViewportActive ? 5000 : 10000);
      }
    };
    const onVisibilityChange = () => {
      if (!cancelled) schedule(document.hidden ? 10000 : 1000);
    };

    void run();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (pollTimeoutRef.current) window.clearTimeout(pollTimeoutRef.current);
    };
  }, [agent.status, characterId, fetchPosition, isViewportActive]);

  // Don't show if agent is inactive
  if (agent.status !== "active") {
    return null;
  }

  return (
    <div className="border-t border-[#8b4513]/30 bg-[#0b0a15]/80">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-2 hover:bg-[#f2d08a]/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <MapPin size={14} className="text-[#f2d08a]/60" />
          <span className="text-xs font-bold text-[#f2d08a]/80 uppercase tracking-wider">
            Location
          </span>
          {online && position && (
            <span className="text-[10px] text-[#f2d08a]/50 truncate max-w-[100px]">
              {zoneName}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-[#f2d08a]/40" />
        ) : (
          <ChevronDown size={14} className="text-[#f2d08a]/40" />
        )}
      </button>

      {/* Position Display */}
      {expanded && (
        <div className="px-2 pb-2">
          {loading && !position ? (
            <div className="flex items-center justify-center py-3">
              <div className="animate-spin rounded-full h-4 w-4 border-t border-b border-[#f2d08a]/60" />
            </div>
          ) : error ? (
            <div className="text-center py-2 text-[10px] text-red-400/70">
              {error}
            </div>
          ) : !online ? (
            <div className="text-center py-2 text-[10px] text-[#f2d08a]/50">
              Agent offline
            </div>
          ) : position ? (
            <div className="space-y-2">
              {/* Zone Name Banner */}
              <div className="flex items-center gap-2 p-2 rounded bg-[#f2d08a]/10 border border-[#f2d08a]/20">
                <MapPin size={14} className="text-[#f2d08a]" />
                <div className="flex-1">
                  <div className="text-[10px] font-bold text-[#f2d08a]">
                    {zoneName}
                  </div>
                  <div className="text-[8px] text-[#f2d08a]/50">
                    X: {Math.floor(position.x)} Y: {Math.floor(position.y)} Z:{" "}
                    {Math.floor(position.z)}
                  </div>
                </div>
              </div>

              {/* Nearby POIs */}
              {nearbyPOIs.length > 0 && (
                <div>
                  <div className="text-[8px] text-[#f2d08a]/50 uppercase tracking-wider mb-1 font-medium">
                    Nearby
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {nearbyPOIs.map((poi, idx) => (
                      <POIBadge key={idx} poi={poi} />
                    ))}
                  </div>
                </div>
              )}

              {/* Coordinate Grid - Collapsed view */}
              <div className="grid grid-cols-3 gap-1">
                <CoordinateBox
                  label="X"
                  value={Math.floor(position.x)}
                  color="red"
                />
                <CoordinateBox
                  label="Y"
                  value={Math.floor(position.y)}
                  color="green"
                />
                <CoordinateBox
                  label="Z"
                  value={Math.floor(position.z)}
                  color="blue"
                />
              </div>

              {/* Copy button */}
              <button
                onClick={() => {
                  const coordString = `${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)}`;
                  navigator.clipboard.writeText(coordString);
                }}
                className="w-full py-1 px-2 text-[9px] text-[#f2d08a]/60 hover:text-[#f2d08a] hover:bg-[#f2d08a]/10 rounded transition-colors"
              >
                Copy Coordinates
              </button>

              {/* Live indicator when viewport active */}
              {isViewportActive && (
                <div className="flex items-center justify-center gap-1 pt-1 border-t border-[#8b4513]/20">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-[9px] text-green-500/80">
                    Live Tracking
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

function CoordinateBox({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "red" | "green" | "blue";
}) {
  const colorClasses = {
    red: "border-red-500/30 text-red-400",
    green: "border-green-500/30 text-green-400",
    blue: "border-blue-500/30 text-blue-400",
  };

  return (
    <div
      className={`flex flex-col items-center p-1.5 rounded bg-black/30 border ${colorClasses[color]}`}
    >
      <span className="text-[8px] opacity-60 uppercase">{label}</span>
      <span className="text-[11px] font-mono font-bold">{value}</span>
    </div>
  );
}

// Get icon for POI type
function getPOIIcon(type: string) {
  const IconComponent = POINTS_OF_INTEREST.find((p) => p.type === type)?.icon;
  if (IconComponent) {
    return <IconComponent size={10} className="text-[#f2d08a]/70" />;
  }
  return <MapPin size={10} className="text-[#f2d08a]/70" />;
}

function POIBadge({ poi }: { poi: NearbyLocation }) {
  return (
    <div className="flex items-center gap-1.5 p-1 rounded bg-black/30 border border-[#8b4513]/20">
      {getPOIIcon(poi.type)}
      <span className="text-[8px] text-[#e8ebf4]/70 truncate flex-1">
        {poi.name}
      </span>
      <span className="text-[8px] text-[#f2d08a]/50">{poi.distance}m</span>
    </div>
  );
}
