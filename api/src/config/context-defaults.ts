/**
 * Provisional agro-climatic context for the recommendation call.
 *
 * The AI ranker needs four inputs the soil probe does not measure — `season`,
 * `soil_type`, `humidity`, `rainfall`. These are **contextual features that
 * influence which crops rank where; they never enter the fertiliser cost math**
 * (that depends only on the soil NPK classes and the crop's RDF — ADR-0004). So
 * defaulting them can reorder suggestions but cannot make a rupee figure wrong.
 *
 * They are deliberately kept here, in one clearly-labelled place, rather than in
 * the seeded region tables: the canonical agronomy JSON does not contain climate
 * norms, and inventing rows there would pollute the single source of truth. Any
 * request may override each value explicitly. Replace these with a real weather
 * integration + per-field soil survey when that data exists.
 *
 * All values below are PROVISIONAL Chambal placeholders, not surveyed figures.
 */

export interface AgroContext {
  season: string;
  soil_type: string;
  humidity: number;
  rainfall: number;
}

/** Chambal division is dominated by alluvial soils (with some black cotton). */
const DEFAULT_SOIL_TYPE = 'alluvial';

/** Rough seasonal humidity (%) and accumulated rainfall (mm). Provisional. */
const SEASONAL_NORMS: Record<string, { humidity: number; rainfall: number }> = {
  Kharif: { humidity: 70, rainfall: 650 }, // monsoon
  Rabi: { humidity: 55, rainfall: 40 }, // winter
  Zaid: { humidity: 40, rainfall: 15 }, // dry summer
};

/**
 * Indian cropping calendar: Kharif (Jun–Oct), Rabi (Nov–Mar), Zaid (Apr–May).
 * Uses the local month (the deployment runs in IST), which is sufficient for a
 * categorical model feature.
 */
export function deriveSeason(now: Date = new Date()): string {
  const month = now.getMonth() + 1; // 1–12
  if (month >= 6 && month <= 10) return 'Kharif';
  if (month === 4 || month === 5) return 'Zaid';
  return 'Rabi';
}

/** The default context for a region at a point in time, before any overrides. */
export function defaultAgroContext(now: Date = new Date()): AgroContext {
  const season = deriveSeason(now);
  const norms = SEASONAL_NORMS[season] ?? SEASONAL_NORMS.Rabi;
  return {
    season,
    soil_type: DEFAULT_SOIL_TYPE,
    humidity: norms.humidity,
    rainfall: norms.rainfall,
  };
}
