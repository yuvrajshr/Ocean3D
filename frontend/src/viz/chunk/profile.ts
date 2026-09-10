/**
 * One observed cast against the model column beside it.
 *
 * This is the comparison the whole product exists for, and the chunk view builds
 * it locally rather than calling `/api/compare`. That endpoint samples INCOIS's
 * 1-degree analysis, which is the right answer for the map and the water column
 * — but it would put a different model in this chart than the one filling the
 * box around it. Sampling the chunk the view has already loaded costs no request
 * and cannot disagree with what is on screen.
 */

import type { InstrumentProfile } from "../../api/client";
import type { Profile, VariableKey } from "./model";
import type { ChunkSource } from "./source";

/** Which measured column, if any, this variable can be compared against. */
function observedAt(
  level: InstrumentProfile["profile"][number],
  variable: VariableKey,
): number | null {
  if (variable === "temperature") return level.temperature;
  if (variable === "salinity") return level.salinity;
  // An Argo core float measures neither chlorophyll nor velocity. The BGC
  // sensors that would carry the first are not in this ingestion path yet, and
  // `ProfileLevel.chlorophyll` has been a declared-but-never-filled field since
  // the schema was written.
  return null;
}

/**
 * Pair a cast with the model, level by level.
 *
 * Returns null where the instrument did not measure this variable — the card
 * then says so instead of drawing one curve and implying the other is missing
 * data rather than missing sensors.
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
    // Only levels where both exist are paired. The chart's RMSD reads the two
    // arrays by index, so a gap in one of them would silently compare a
    // measurement against the wrong depth.
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
