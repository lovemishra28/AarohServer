import { getPool, type Queryable } from '../../common/db';
import { AppError } from '../../common/errors';

/**
 * Read-only view of the active region configuration (§6.2). This is the same
 * agronomy data the recommendation engine uses, exposed so the app can show
 * product prices, RDF bands and the class thresholds without hard-coding them.
 * Only the single active version per region is returned.
 */

interface RegionConfigRow {
  region_code: string;
  version: string;
  agronomy_version: string;
  provisional: boolean;
  bag_kg: string;
  rounding: string;
  mult_low: string;
  mult_medium: string;
  mult_high: string;
  n_low_max: string;
  n_med_max: string;
  p_low_max: string;
  p_med_max: string;
  k_low_max: string;
  k_med_max: string;
  mgkg_to_kgha: string;
  p_to_p2o5: string;
  k_to_k2o: string;
}

interface PriceRow {
  product: string;
  n_pct: string;
  p2o5_pct: string;
  k2o_pct: string;
  inr_per_bag: string;
  supplies: string[];
}

interface CropBandRow {
  crop: string;
  crop_hi: string;
  rdf_n_kgha: string;
  rdf_p2o5_kgha: string;
  rdf_k2o_kgha: string;
  is_legume: boolean;
}

export interface PublicRegionConfig {
  region_code: string;
  version: string;
  agronomy_version: string;
  provisional: boolean;
  bag_kg: number;
  rounding: string;
  class_multipliers: { low: number; medium: number; high: number };
  soil_class_thresholds: {
    n_mgkg: { low_max: number; med_max: number };
    p_mgkg: { low_max: number; med_max: number };
    k_mgkg: { low_max: number; med_max: number };
  };
  conversion_factors: { mgkg_to_kgha: number; p_to_p2o5: number; k_to_k2o: number };
  products: Array<{
    product: string;
    n_pct: number;
    p2o5_pct: number;
    k2o_pct: number;
    inr_per_bag: number;
    supplies: string[];
  }>;
  crops: Array<{
    crop: string;
    crop_hi: string;
    rdf_kgha: { n: number; p2o5: number; k2o: number };
    is_legume: boolean;
  }>;
}

/** Load the active config for a region, or throw REGION_NOT_FOUND (404). */
export async function getActiveRegionConfig(
  regionCode: string,
  db: Queryable = getPool(),
): Promise<PublicRegionConfig> {
  const cfg = await db.query<RegionConfigRow>(
    `SELECT region_code, version, agronomy_version, provisional, bag_kg, rounding,
            mult_low, mult_medium, mult_high,
            n_low_max, n_med_max, p_low_max, p_med_max, k_low_max, k_med_max,
            mgkg_to_kgha, p_to_p2o5, k_to_k2o
       FROM region_config
      WHERE region_code = $1 AND is_active = true`,
    [regionCode],
  );
  const row = cfg.rows[0];
  if (!row) {
    throw new AppError('REGION_NOT_FOUND', `No active configuration for region '${regionCode}'`, 404);
  }

  const [prices, crops] = await Promise.all([
    db.query<PriceRow>(
      `SELECT product, n_pct, p2o5_pct, k2o_pct, inr_per_bag, supplies
         FROM price_table WHERE region_code = $1 AND version = $2 ORDER BY product`,
      [regionCode, row.version],
    ),
    db.query<CropBandRow>(
      `SELECT crop, crop_hi, rdf_n_kgha, rdf_p2o5_kgha, rdf_k2o_kgha, is_legume
         FROM crop_band WHERE region_code = $1 AND version = $2 ORDER BY crop`,
      [regionCode, row.version],
    ),
  ]);

  return {
    region_code: row.region_code,
    version: row.version,
    agronomy_version: row.agronomy_version,
    provisional: row.provisional,
    bag_kg: Number(row.bag_kg),
    rounding: row.rounding,
    class_multipliers: {
      low: Number(row.mult_low),
      medium: Number(row.mult_medium),
      high: Number(row.mult_high),
    },
    soil_class_thresholds: {
      n_mgkg: { low_max: Number(row.n_low_max), med_max: Number(row.n_med_max) },
      p_mgkg: { low_max: Number(row.p_low_max), med_max: Number(row.p_med_max) },
      k_mgkg: { low_max: Number(row.k_low_max), med_max: Number(row.k_med_max) },
    },
    conversion_factors: {
      mgkg_to_kgha: Number(row.mgkg_to_kgha),
      p_to_p2o5: Number(row.p_to_p2o5),
      k_to_k2o: Number(row.k_to_k2o),
    },
    products: prices.rows.map((p) => ({
      product: p.product,
      n_pct: Number(p.n_pct),
      p2o5_pct: Number(p.p2o5_pct),
      k2o_pct: Number(p.k2o_pct),
      inr_per_bag: Number(p.inr_per_bag),
      supplies: p.supplies,
    })),
    crops: crops.rows.map((c) => ({
      crop: c.crop,
      crop_hi: c.crop_hi,
      rdf_kgha: {
        n: Number(c.rdf_n_kgha),
        p2o5: Number(c.rdf_p2o5_kgha),
        k2o: Number(c.rdf_k2o_kgha),
      },
      is_legume: c.is_legume,
    })),
  };
}
