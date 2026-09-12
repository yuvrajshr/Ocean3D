/**
 * Compare an observed profile against the model column next to it.
 *
 * Built from the loaded chunk rather than /api/compare, because that endpoint
 * uses the INCOIS 1 degree analysis, and this chart should match the model in
 * the box around it (and it saves a request).
 */

import type { InstrumentProfile } from "../../api/client";
import type { Profile, VariableKey } from "./model";
import type { ChunkSource } from "./source";

/** Which measured values, if any, can be compared for this variable. */
function observedAt(
  level: InstrumentProfile["profile"][number],
  variable: VariableKey,
): number | null {
  if (variable === "temperature") return level.temperature;
  if (variable === "salinity") return level.salinity;
  // Core Argo floats don't measure chlorophyll or velocity.
  return null;
}

/**
 * Pair the profile with the model level by level. Returns null if the instrument
 * didn't measure this variable, and the card shows that.
 */
export function buildProfile(
  source: ChunkSource,
  cast: InstrumentProfile,
  variable: VariableKey,
): Profile | null {
  const obs: [number, number][] = [];
  const model: [number, number][] = [];
  let top = 0;

  for (const level of cast.profile) {
    const measured = observedAt(level, variable);
    if (measured === null || !Number.isFinite(measured)) continue;
    if (level.depth > source.grid.maxDepth) break;
    const modelled = source.value(cast.lon, cast.lat, level.depth);
    // Only pair levels where both have a value; the RMSD compares by index.
    if (!Number.isFinite(modelled)) continue;
    obs.push([measured, level.depth]);
    model.push([modelled, level.depth]);
    if (level.depth > top) top = level.depth;
  }

  if (obs.length < 2) return null;
  return {
    obs,
    model,
    lon: cast.lon,
    lat: cast.lat,
    top,
    id: cast.platform_id,
    type: cast.platform_type,
    cycle: cast.cycle_number,
    observedTime: cast.time,
  };
}
