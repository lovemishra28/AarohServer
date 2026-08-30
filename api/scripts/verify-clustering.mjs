/**
 * Checks the mock survey against the shipped clustering code.
 *
 *   npm run verify:clustering                 # default: ../../AAROH-Client/test-frames/…
 *   npm run verify:clustering -- <file.txt>
 *
 * The three fields the acceptance test expects are not a property of the server — they are a
 * property of *those 90 coordinates* meeting these tunables. The unit tests cover the
 * algorithm with their own fixtures; nothing covers the fixture the demo actually uses, and a
 * dataset that clusters into two fields or twelve would look like a server bug when it is
 * really a bad file. So this runs the real `dbscan` at the real `CLUSTER_EPS_M` over the real
 * frames and asserts the outcome, before anyone plugs in a phone.
 *
 * It imports `dbscan.ts` directly (Node 22's type stripping), so there is no second copy of
 * the clustering logic to drift. What it does not touch is PostGIS: hulls, areas and
 * match-or-create are SQL and need a database. This answers the question underneath those —
 * "do these points fall into three groups at all" — which is the one that decides whether the
 * rest can possibly be right.
 *
 * Frames are read with a small key/value split rather than the app's parser, which lives in
 * the client repo and is verified there by `npm run verify:frames`. This side only needs the
 * coordinates and the seven measurements.
 */
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const fileUrl = (p) => pathToFileURL(resolve(p)).href;

const { dbscan, centroidOf, diameterMeters, haversineMeters } = await import(
  fileUrl(join(HERE, '../src/modules/segregation/dbscan.ts'))
);
const { CLUSTER_EPS_M, CLUSTER_MIN_POINTS, FIELD_MATCH_RADIUS_M } = await import(
  fileUrl(join(HERE, '../src/modules/segregation/segregation.config.ts'))
);

/** The client repo sits beside this one; override with an argument if it does not. */
const DEFAULT_FILE = join(HERE, '../../../AAROH-Client/test-frames/10-survey-3-fields.txt');
const file = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_FILE;

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.error(`Cannot read ${file}`);
  console.error('Pass the path explicitly: npm run verify:clustering -- <path to frames.txt>');
  process.exit(1);
}

/** `KEY:value,KEY:value` → object. Unknown keys are kept; this is not a validating parser. */
function readFrame(line) {
  const out = {};
  for (const pair of line.split(',')) {
    const at = pair.indexOf(':');
    if (at === -1) continue;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

const num = (v) => (v === undefined || v === '' ? null : Number(v));

const readings = [];
for (const line of text.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  // A packed line holds several frames with no delimiter, which `readFrame` would silently
  // flatten into one reading — the last frame's values, a third of the points, and a
  // plausible-looking pass. Refuse rather than answer wrongly.
  const identities = trimmed.split('ID:').length - 1 - (trimmed.split('SID:').length - 1);
  if (identities > 1) {
    console.error(`${file}\n`);
    console.error(`Line ${readings.length + 1} carries ${identities} frames packed together.`);
    console.error('This check needs one frame per line — use 10-survey-3-fields.txt.');
    process.exit(1);
  }
  const f = readFrame(trimmed);
  if (!f.ID) continue;
  readings.push({
    session_id: f.SID ?? null,
    lat: num(f.Lat),
    lng: num(f.Lng),
    n_mgkg: num(f.N),
    p_mgkg: num(f.P),
    k_mgkg: num(f.K),
    ph: num(f.pH),
    ec_uscm: num(f.EC),
    moisture_vwc: num(f.M),
    soil_temp_c: num(f.T),
  });
}

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

console.log(`${file}\n`);
console.log(`  ${readings.length} readings read`);

const located = readings.filter((r) => r.lat !== null && r.lng !== null);
check(
  located.length === readings.length,
  `${readings.length - located.length} readings have no GPS fix — those cannot be clustered`,
);

/* ------------------------------------------------------------------ clustering */

const { clusters, noise } = dbscan(located, {
  epsMeters: CLUSTER_EPS_M,
  minPoints: CLUSTER_MIN_POINTS,
});

console.log(
  `  dbscan(eps=${CLUSTER_EPS_M} m, minPoints=${CLUSTER_MIN_POINTS}) → ` +
    `${clusters.length} clusters, ${noise.length} noise\n`,
);

check(clusters.length === 3, `expected 3 clusters, got ${clusters.length}`);
check(
  noise.length === 0,
  `${noise.length} readings were classed as noise and would arrive unassigned`,
);

/**
 * The strongest available assertion: the geometry must reproduce the session ids exactly.
 * Counting clusters is not enough — three clusters of 29, 30 and 31 points would pass a count
 * check while quietly having moved a reading from one plot to the next.
 */
const bySession = new Map();
for (const r of located) {
  const key = r.session_id ?? '(none)';
  bySession.set(key, (bySession.get(key) ?? 0) + 1);
}

const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const METRICS = [
  ['N', 'n_mgkg', 0],
  ['P', 'p_mgkg', 1],
  ['K', 'k_mgkg', 0],
  ['pH', 'ph', 2],
  ['EC', 'ec_uscm', 0],
  ['M', 'moisture_vwc', 1],
  ['T', 'soil_temp_c', 1],
];

const summaries = clusters.map((indices, i) => {
  const members = indices.map((index) => located[index]);
  const sessions = [...new Set(members.map((m) => m.session_id ?? '(none)'))];

  check(
    sessions.length === 1,
    `cluster ${i + 1} mixes sessions ${sessions.join(', ')} — points from different plots merged`,
  );
  if (sessions.length === 1) {
    const expected = bySession.get(sessions[0]);
    check(
      members.length === expected,
      `cluster ${i + 1} (${sessions[0]}) has ${members.length} of that session's ${expected} points — the rest went elsewhere`,
    );
  }

  const aggregate = {};
  for (const [, column] of METRICS) {
    const values = members.map((m) => m[column]).filter((v) => v !== null);
    aggregate[column] = values.length > 0 ? mean(values) : null;
  }

  return {
    session: sessions.join('+'),
    count: members.length,
    centroid: centroidOf(members),
    diameter: diameterMeters(members),
    aggregate,
  };
});

for (const s of summaries) {
  const stats = METRICS.map(([label, column, dp]) =>
    s.aggregate[column] === null ? `${label} —` : `${label} ${s.aggregate[column].toFixed(dp)}`,
  ).join(' · ');
  console.log(`  ${s.session}: ${s.count} points, ${Math.round(s.diameter)} m across`);
  console.log(`    centroid ${s.centroid.lat.toFixed(5)}, ${s.centroid.lng.toFixed(5)}`);
  console.log(`    means ${stats}`);
}

/* --------------------------------------------------------- field-match distance */

console.log('\n  centroid separation:');
for (let i = 0; i < summaries.length; i += 1) {
  for (let j = i + 1; j < summaries.length; j += 1) {
    const apart = haversineMeters(summaries[i].centroid, summaries[j].centroid);
    console.log(
      `    ${summaries[i].session} ↔ ${summaries[j].session}: ${Math.round(apart)} m ` +
        `(match radius ${FIELD_MATCH_RADIUS_M} m)`,
    );
    check(
      apart > FIELD_MATCH_RADIUS_M,
      `${summaries[i].session} and ${summaries[j].session} are ${Math.round(apart)} m apart, ` +
        `inside the ${FIELD_MATCH_RADIUS_M} m match radius — the second would join the first`,
    );
  }
}

/**
 * The demo is meant to show three visibly different soils. If two plots average the same, a
 * switcher that changes nothing looks like a bug in the switcher.
 */
console.log('\n  plots distinguishable by mean:');
for (let i = 0; i < summaries.length; i += 1) {
  for (let j = i + 1; j < summaries.length; j += 1) {
    const differing = METRICS.filter(([, column]) => {
      const a = summaries[i].aggregate[column];
      const b = summaries[j].aggregate[column];
      if (a === null || b === null) return false;
      // 15% apart, so the difference survives rounding and reads as a different soil.
      return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) > 0.15;
    }).map(([label]) => label);
    console.log(
      `    ${summaries[i].session} ↔ ${summaries[j].session}: ${differing.length} of ` +
        `${METRICS.length} metrics differ by >15% (${differing.join(', ') || 'none'})`,
    );
    check(
      differing.length >= 3,
      `${summaries[i].session} and ${summaries[j].session} differ on only ${differing.length} metrics — too alike to demonstrate anything`,
    );
  }
}

/* ------------------------------------------------------------------- the verdict */

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\nThis dataset would not produce the expected fields. Fix the file, not the server.');
  process.exit(1);
}

console.log(
  `\nOK — ${located.length} readings cluster into ${clusters.length} well-separated fields ` +
    'with nothing left over.',
);
console.log('The means above are what the dashboard should show for each plot.');
