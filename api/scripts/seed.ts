/**
 * Seed the versioned region-configuration tables from the canonical agronomy
 * JSON, so Postgres and the AI service share one source of truth (§5.4).
 *
 * The JSON at `ai/.../regions/<region>/<active_version>.json` is authoritative;
 * this script derives `region_config`, `crop_band` and `price_table` rows from
 * it. It is **idempotent** — re-running upserts the same rows — and it makes the
 * seeded version the single active one for its region (the partial unique index
 * `region_config_one_active` enforces at most one active version per region).
 *
 * Run with:  npm run seed            (region 'chambal', from the manifest)
 *            npm run seed -- <region>
 *
 * Keys beginning with '_' in the JSON are documentation (`_note`, `_meta`,
 * `_basis`) and are skipped where they sit alongside real data.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { closeDb, withClient } from '../src/common/db';
import { describeError } from '../src/common/errors';
import { logger } from '../src/common/logger';

const HERE = dirname(fileURLToPath(import.meta.url));
// api/scripts → ../../ = repo root → the AI service's region configs.
const DEFAULT_REGION_DIR = resolve(HERE, '../../ai/src/aaroh_ai/services/agronomy/regions');

/** The slices of the canonical JSON this seeder consumes. */
const CanonicalSchema = z.object({
  _meta: z.object({
    region_code: z.string(),
    version: z.string(),
    agronomy_version: z.string(),
    provisional: z.boolean().default(true),
  }),
  factors: z.object({
    mgkg_to_kgha: z.number(),
    p_to_p2o5: z.number(),
    k_to_k2o: z.number(),
  }),
  bag_kg: z.number(),
  rounding: z.enum(['nearest', 'up']),
  dose_model: z.object({
    class_multiplier: z.object({ Low: z.number(), Medium: z.number(), High: z.number() }),
  }),
  soil_rating: z.object({
    n_kgha: z.object({ low_max: z.number(), med_max: z.number() }),
    p_kgha: z.object({ low_max: z.number(), med_max: z.number() }),
    k_kgha: z.object({ low_max: z.number(), med_max: z.number() }),
  }),
  legumes: z.array(z.string()),
  products: z.record(z.string(), z.unknown()),
  crops: z.record(z.string(), z.unknown()),
});

const ProductSchema = z.object({
  n_pct: z.number(),
  p2o5_pct: z.number(),
  k2o_pct: z.number(),
  inr_per_bag: z.number(),
  supplies: z.array(z.string()),
});

const CropSchema = z.object({
  hi: z.string(),
  rdf_kgha: z.object({ n: z.number(), p2o5: z.number(), k2o: z.number() }),
});

/** Entries whose key starts with '_' are documentation, not data. */
function dataEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).filter(([key]) => !key.startsWith('_'));
}

async function main(): Promise<void> {
  const regionCode = process.argv[2] ?? 'chambal';
  const regionDir = process.env.AAROH_REGION_DIR ?? DEFAULT_REGION_DIR;

  const manifest = JSON.parse(
    readFileSync(resolve(regionDir, regionCode, 'manifest.json'), 'utf8'),
  ) as { active_version: string };
  const version = manifest.active_version;

  const raw = JSON.parse(
    readFileSync(resolve(regionDir, regionCode, `${version}.json`), 'utf8'),
  ) as unknown;
  const cfg = CanonicalSchema.parse(raw);

  if (cfg._meta.region_code !== regionCode || cfg._meta.version !== version) {
    throw new Error(
      `canonical JSON _meta (${cfg._meta.region_code}@${cfg._meta.version}) ` +
        `disagrees with manifest (${regionCode}@${version})`,
    );
  }

  const products = dataEntries(cfg.products).map(([name, value]) => ({
    name,
    ...ProductSchema.parse(value),
  }));
  const legumes = new Set(cfg.legumes);
  const crops = dataEntries(cfg.crops).map(([name, value]) => {
    const parsed = CropSchema.parse(value);
    return { name, ...parsed, isLegume: legumes.has(name) };
  });

  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      // Exactly one active version per region: demote any other version first,
      // so upserting this one as active never trips the partial unique index.
      await client.query(
        'UPDATE region_config SET is_active = false WHERE region_code = $1 AND version <> $2',
        [regionCode, version],
      );

      await client.query(
        `INSERT INTO region_config (
           region_code, version, agronomy_version, is_active, provisional,
           bag_kg, rounding, mult_low, mult_medium, mult_high,
           n_low_max, n_med_max, p_low_max, p_med_max, k_low_max, k_med_max,
           mgkg_to_kgha, p_to_p2o5, k_to_k2o
         ) VALUES (
           $1,$2,$3,true,$4,
           $5,$6,$7,$8,$9,
           $10,$11,$12,$13,$14,$15,
           $16,$17,$18
         )
         ON CONFLICT (region_code, version) DO UPDATE SET
           agronomy_version = EXCLUDED.agronomy_version,
           is_active        = true,
           provisional      = EXCLUDED.provisional,
           bag_kg           = EXCLUDED.bag_kg,
           rounding         = EXCLUDED.rounding,
           mult_low         = EXCLUDED.mult_low,
           mult_medium      = EXCLUDED.mult_medium,
           mult_high        = EXCLUDED.mult_high,
           n_low_max        = EXCLUDED.n_low_max,
           n_med_max        = EXCLUDED.n_med_max,
           p_low_max        = EXCLUDED.p_low_max,
           p_med_max        = EXCLUDED.p_med_max,
           k_low_max        = EXCLUDED.k_low_max,
           k_med_max        = EXCLUDED.k_med_max,
           mgkg_to_kgha     = EXCLUDED.mgkg_to_kgha,
           p_to_p2o5        = EXCLUDED.p_to_p2o5,
           k_to_k2o         = EXCLUDED.k_to_k2o`,
        [
          regionCode,
          version,
          cfg._meta.agronomy_version,
          cfg._meta.provisional,
          cfg.bag_kg,
          cfg.rounding,
          cfg.dose_model.class_multiplier.Low,
          cfg.dose_model.class_multiplier.Medium,
          cfg.dose_model.class_multiplier.High,
          cfg.soil_rating.n_kgha.low_max,
          cfg.soil_rating.n_kgha.med_max,
          cfg.soil_rating.p_kgha.low_max,
          cfg.soil_rating.p_kgha.med_max,
          cfg.soil_rating.k_kgha.low_max,
          cfg.soil_rating.k_kgha.med_max,
          cfg.factors.mgkg_to_kgha,
          cfg.factors.p_to_p2o5,
          cfg.factors.k_to_k2o,
        ],
      );

      for (const p of products) {
        await client.query(
          `INSERT INTO price_table (
             region_code, version, product, n_pct, p2o5_pct, k2o_pct, inr_per_bag, supplies
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (region_code, version, product) DO UPDATE SET
             n_pct = EXCLUDED.n_pct, p2o5_pct = EXCLUDED.p2o5_pct, k2o_pct = EXCLUDED.k2o_pct,
             inr_per_bag = EXCLUDED.inr_per_bag, supplies = EXCLUDED.supplies`,
          [
            regionCode,
            version,
            p.name,
            p.n_pct,
            p.p2o5_pct,
            p.k2o_pct,
            p.inr_per_bag,
            JSON.stringify(p.supplies),
          ],
        );
      }

      for (const c of crops) {
        await client.query(
          `INSERT INTO crop_band (
             region_code, version, crop, crop_hi, rdf_n_kgha, rdf_p2o5_kgha, rdf_k2o_kgha, is_legume
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (region_code, version, crop) DO UPDATE SET
             crop_hi = EXCLUDED.crop_hi, rdf_n_kgha = EXCLUDED.rdf_n_kgha,
             rdf_p2o5_kgha = EXCLUDED.rdf_p2o5_kgha, rdf_k2o_kgha = EXCLUDED.rdf_k2o_kgha,
             is_legume = EXCLUDED.is_legume`,
          [
            regionCode,
            version,
            c.name,
            c.hi,
            c.rdf_kgha.n,
            c.rdf_kgha.p2o5,
            c.rdf_kgha.k2o,
            c.isLegume,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });

  logger.info('seed_complete', {
    region: regionCode,
    version,
    agronomy_version: cfg._meta.agronomy_version,
    products: products.length,
    crops: crops.length,
  });
}

main()
  .catch((err: unknown) => {
    logger.error('seed_failed', describeError(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
