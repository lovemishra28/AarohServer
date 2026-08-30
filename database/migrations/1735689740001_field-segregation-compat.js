/**
 * Backfill compatibility for databases created before the segregation migration was
 * applied. Some environments reuse a stale schema snapshot without running the
 * later field-segregation migration, which leaves `fields.source` and
 * `fields.detected_at` missing. The application code always expects those columns,
 * so we add them here in an idempotent way.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'fields'
          AND column_name = 'source'
      ) THEN
        ALTER TABLE fields ADD COLUMN source text NOT NULL DEFAULT 'manual';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'fields'
          AND column_name = 'detected_at'
      ) THEN
        ALTER TABLE fields ADD COLUMN detected_at timestamptz;
      END IF;
    END $$;
  `);

  pgm.sql(`
    UPDATE fields
    SET source = 'manual'
    WHERE source IS NULL;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.constraint_column_usage ccu
        JOIN information_schema.table_constraints tc
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name = 'fields'
          AND tc.constraint_type = 'CHECK'
          AND tc.constraint_name = 'fields_source_check'
      ) THEN
        ALTER TABLE fields
          ADD CONSTRAINT fields_source_check CHECK (source IN ('manual', 'auto'));
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'fields'
          AND constraint_name = 'fields_source_check'
      ) THEN
        ALTER TABLE fields DROP CONSTRAINT fields_source_check;
      END IF;
    END $$;
  `);

  pgm.sql(`
    ALTER TABLE fields DROP COLUMN IF EXISTS detected_at;
    ALTER TABLE fields DROP COLUMN IF EXISTS source;
  `);
};
