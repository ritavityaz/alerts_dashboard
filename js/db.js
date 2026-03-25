import * as duckdb from "@duckdb/duckdb-wasm";

let db = null;
let conn = null;

// Start Wasm download + engine instantiation immediately on module load.
// With snapshot.json providing instant first render, this runs in background
// without blocking the UI.
const _enginePromise = (async () => {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
  const worker = await duckdb.createWorker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger();
  const _db = new duckdb.AsyncDuckDB(logger, worker);
  await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return _db;
})();

/**
 * Load parquet files directly into DuckDB tables.
 * @param {ArrayBuffer} alertsBuf - alerts.parquet bytes
 * @param {ArrayBuffer} incidentsBuf - incidents.parquet bytes
 * @param {ArrayBuffer} incidentEventsBuf - incident_events.parquet bytes
 */
export async function initDB(alertsBuf, incidentsBuf, incidentEventsBuf) {
  console.time("duckdb:engine");
  db = await _enginePromise;
  console.timeEnd("duckdb:engine");

  console.time("duckdb:connect");
  conn = await db.connect();
  console.timeEnd("duckdb:connect");

  console.time("duckdb:alerts-table");
  await db.registerFileBuffer("alerts.parquet", new Uint8Array(alertsBuf));
  await conn.query(`CREATE TABLE alerts AS SELECT * FROM read_parquet('alerts.parquet')`);
  console.timeEnd("duckdb:alerts-table");

  console.time("duckdb:incidents-table");
  await db.registerFileBuffer("incidents.parquet", new Uint8Array(incidentsBuf));
  await conn.query(`CREATE TABLE incidents AS SELECT * FROM read_parquet('incidents.parquet')`);
  console.timeEnd("duckdb:incidents-table");

  console.time("duckdb:incident-events-table");
  await db.registerFileBuffer("incident_events.parquet", new Uint8Array(incidentEventsBuf));
  await conn.query(`CREATE TABLE incident_events AS SELECT * FROM read_parquet('incident_events.parquet')`);
  console.timeEnd("duckdb:incident-events-table");
}

/**
 * Query initial stats needed before first render: totalAlerts, countByCity, minTs, maxTs.
 */
export async function queryInitialStats() {
  const [totals, counts, range] = await Promise.all([
    conn.query(`SELECT SUM(count) as total FROM alerts`),
    conn.query(`SELECT data, SUM(count) as cnt FROM alerts GROUP BY data`),
    conn.query(`SELECT MIN(ts) as min_ts, MAX(ts) as max_ts FROM alerts`),
  ]);

  const totalAlerts = Number(totals.getChild("total").get(0)) || 0;

  const countByCity = new Map();
  const dataCol = counts.getChild("data");
  const cntCol = counts.getChild("cnt");
  for (let i = 0; i < counts.numRows; i++) {
    countByCity.set(dataCol.get(i), Number(cntCol.get(i)));
  }

  const minTs = Number(range.getChild("min_ts").get(0));
  const maxTs = Number(range.getChild("max_ts").get(0));

  return { totalAlerts, countByCity, minTs, maxTs };
}

/** Build a WHERE clause for the common filter pattern */
function filterWhere(table, { threat, ctx, zone, city, startMs, endMs } = {}) {
  const clauses = [];
  const tsCol = table === "incidents" ? "start_ms" : "ts";
  if (startMs != null) clauses.push(`${tsCol} >= ${startMs}`);
  if (endMs != null) clauses.push(`${tsCol} <= ${endMs}`);
  if (threat && threat !== "all") {
    const col = table === "incidents" ? "threat_type" : "category";
    const val = table === "incidents" ? threatForCategory(threat) : threat;
    clauses.push(`${col} = '${val}'`);
  }
  if (ctx === "zone" && zone && zone !== "all") {
    clauses.push(`zone_en = '${escapeSql(zone)}'`);
  } else if (ctx === "city" && city) {
    clauses.push(`data = '${escapeSql(city)}'`);
  }
  return clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
}

const THREAT_MAP = { "1": "missiles", "2": "drones", "10": "infiltration" };
function threatForCategory(cat) {
  return THREAT_MAP[cat] || cat;
}

function escapeSql(s) {
  return s.replace(/'/g, "''");
}

/**
 * Count alerts by city, for map coloring.
 * @returns {Map<string, number>}
 */
export async function queryCountsByCity(threat, ctx, zone, city, startMs, endMs) {
  const where = filterWhere("alerts", { threat, ctx, zone, city, startMs, endMs });
  const result = await conn.query(`
    SELECT data, SUM(count) as cnt FROM alerts ${where} GROUP BY data
  `);
  const map = new Map();
  const dataCol = result.getChild("data");
  const cntCol = result.getChild("cnt");
  for (let i = 0; i < result.numRows; i++) {
    map.set(dataCol.get(i), Number(cntCol.get(i)));
  }
  return map;
}

/**
 * Get the maximum alert count across all cities (for fixed color scale).
 * @returns {number}
 */
export async function queryGlobalMax(threat, startMs, endMs) {
  const where = filterWhere("alerts", { threat, startMs, endMs });
  const result = await conn.query(`
    SELECT MAX(cnt) as m FROM (
      SELECT SUM(count) as cnt FROM alerts ${where} GROUP BY data
    )
  `);
  return Number(result.getChild("m").get(0)) || 1;
}

/**
 * Get stats: total, unique cities, peak day, category breakdown.
 */
export async function queryStats(ctx, zone, city, startMs, endMs) {
  const where = filterWhere("alerts", { ctx, zone, city, startMs, endMs });

  const [totals, peak, cats] = await Promise.all([
    conn.query(`
      SELECT SUM(count) as total, COUNT(DISTINCT data) as cities
      FROM alerts ${where}
    `),
    conn.query(`
      SELECT (ts / 86400000) as day_key, SUM(count) as cnt
      FROM alerts ${where}
      GROUP BY day_key ORDER BY cnt DESC LIMIT 1
    `),
    conn.query(`
      SELECT category, SUM(count) as cnt
      FROM alerts ${where}
      GROUP BY category
    `),
  ]);

  const total = Number(totals.getChild("total").get(0)) || 0;
  const cities = Number(totals.getChild("cities").get(0));

  let peakDayMs = null;
  let peakCount = 0;
  if (peak.numRows > 0) {
    peakDayMs = Number(peak.getChild("day_key").get(0)) * 86400000;
    peakCount = Number(peak.getChild("cnt").get(0));
  }

  const catMap = new Map();
  const catCol = cats.getChild("category");
  const catCnt = cats.getChild("cnt");
  for (let i = 0; i < cats.numRows; i++) {
    catMap.set(catCol.get(i), Number(catCnt.get(i)));
  }

  return {
    total,
    cities,
    peakDayMs,
    peakCount,
    missiles: catMap.get("1") || 0,
    drones: catMap.get("2") || 0,
    infiltration: catMap.get("10") || 0,
  };
}

/**
 * Get hourly alert counts for sparkline.
 * Returns array of {hour: ms_timestamp, count: number}
 */
export async function querySparkline(threat, ctx, zone, city) {
  const where = filterWhere("alerts", { threat, ctx, zone, city });
  const result = await conn.query(`
    SELECT ts as hour, SUM(count) as cnt
    FROM alerts ${where}
    GROUP BY hour ORDER BY hour
  `);
  const rows = [];
  const hourCol = result.getChild("hour");
  const cntCol = result.getChild("cnt");
  for (let i = 0; i < result.numRows; i++) {
    rows.push({ hour: Number(hourCol.get(i)), count: Number(cntCol.get(i)) });
  }
  return rows;
}

/**
 * Get filtered incidents (for timeline rendering, quiet periods, heatmap).
 * Returns array of plain objects with proper UTC Dates.
 */
export async function queryFilteredEvents(threat, ctx, zone, city) {
  const clauses = [];
  if (threat && threat !== "all") {
    clauses.push(`threat_type = '${threatForCategory(threat)}'`);
  }
  if (ctx === "zone" && zone && zone !== "all") {
    clauses.push(`zone_en = '${escapeSql(zone)}'`);
  } else if (ctx === "city" && city) {
    clauses.push(`data = '${escapeSql(city)}'`);
  }
  const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";

  const result = await conn.query(`
    SELECT data, threat_type, start_ms, end_ms, zone_en, name_en,
           pattern, n_events, group_id, duration_min
    FROM incidents ${where}
  `);

  const rows = [];
  const dataCol = result.getChild("data");
  const ttCol = result.getChild("threat_type");
  const sCol = result.getChild("start_ms");
  const eCol = result.getChild("end_ms");
  const enCol = result.getChild("name_en");
  const zoneCol = result.getChild("zone_en");
  const patCol = result.getChild("pattern");
  const neCol = result.getChild("n_events");
  const gidCol = result.getChild("group_id");
  const durCol = result.getChild("duration_min");
  for (let i = 0; i < result.numRows; i++) {
    rows.push({
      data: dataCol.get(i),
      threat_type: ttCol.get(i),
      _start: new Date(Number(sCol.get(i))),
      _end: new Date(Number(eCol.get(i))),
      NAME_HE: dataCol.get(i),
      NAME_EN: enCol.get(i) || dataCol.get(i),
      zone_en: zoneCol.get(i) || "",
      pattern: patCol.get(i),
      n_events: Number(neCol.get(i)),
      group_id: Number(gidCol.get(i)),
      duration_min: Number(durCol.get(i)),
    });
  }
  return rows;
}

/**
 * Get events grouped by zone and threat type, for computing alert duration per zone.
 * Returns array of {zone, category, start_ms, end_ms, cities} sorted by zone total desc.
 */
export async function queryEventsByZone(startMs, endMs) {
  const clauses = ["zone_en != ''"];
  if (startMs != null) clauses.push(`end_ms >= ${startMs}`);
  if (endMs != null) clauses.push(`start_ms <= ${endMs}`);
  const where = "WHERE " + clauses.join(" AND ");

  const result = await conn.query(`
    WITH filtered AS (
      SELECT * FROM incidents ${where}
    ),
    zone_cities AS (
      SELECT zone_en, COUNT(DISTINCT data) as cities
      FROM filtered GROUP BY zone_en
    ),
    zone_dur AS (
      SELECT zone_en, SUM(end_ms - start_ms) as raw_total
      FROM filtered GROUP BY zone_en
    )
    SELECT f.zone_en, f.threat_type, f.start_ms, f.end_ms, zc.cities
    FROM filtered f
    JOIN zone_dur zd ON f.zone_en = zd.zone_en
    JOIN zone_cities zc ON f.zone_en = zc.zone_en
    ORDER BY zd.raw_total DESC, f.zone_en, f.start_ms
  `);

  const CATEGORY_MAP = { missiles: "1", drones: "2", infiltration: "10" };
  return result.toArray().map((r) => ({
    zone: r.zone_en,
    category: CATEGORY_MAP[r.threat_type] || r.threat_type,
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
    cities: Number(r.cities),
  }));
}

/**
 * Get events for cities within a zone, for computing alert duration per city.
 * Returns array of {city, category, start_ms, end_ms}.
 */
/**
 * Get daily alert counts (number of alerts per day).
 * Returns array of {day_ms, count}.
 */
export async function queryDailyAlertCounts(startMs, endMs, ctx, zone, city) {
  const where = filterWhere("alerts", { ctx, zone, city, startMs, endMs });

  const result = await conn.query(`
    SELECT (ts / 86400000) as day_key, category, SUM(count) as cnt
    FROM alerts ${where}
    GROUP BY day_key, category ORDER BY day_key
  `);

  const dayCol = result.getChild("day_key");
  const catCol = result.getChild("category");
  const cntCol = result.getChild("cnt");
  // byDay: Map<day_ms, Map<category, count>>
  const byDay = new Map();
  for (let i = 0; i < result.numRows; i++) {
    const day_ms = Math.floor(Number(dayCol.get(i))) * 86400000;
    const cat = String(catCol.get(i));
    if (!byDay.has(day_ms)) byDay.set(day_ms, new Map());
    const catMap = byDay.get(day_ms);
    catMap.set(cat, (catMap.get(cat) || 0) + Number(cntCol.get(i)));
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day_ms, catMap]) => ({ day_ms, byCategory: Object.fromEntries(catMap) }));
}

/**
 * Get daily shelter duration in minutes (merged intervals per day).
 * Returns array of {day_ms, minutes}.
 */
export async function queryDailyShelterDuration(startMs, endMs, ctx, zone, city) {
  const clauses = [];
  if (startMs != null) clauses.push(`end_ms >= ${startMs}`);
  if (endMs != null) clauses.push(`start_ms <= ${endMs}`);
  if (ctx === "zone" && zone && zone !== "all") {
    clauses.push(`zone_en = '${escapeSql(zone)}'`);
  } else if (ctx === "city" && city) {
    clauses.push(`data = '${escapeSql(city)}'`);
  }
  const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";

  const CATEGORY_MAP = { missiles: "1", drones: "2", infiltration: "10" };

  // Get all incidents with threat type, we'll merge intervals per day+category in JS
  const result = await conn.query(`
    SELECT start_ms, end_ms, threat_type FROM incidents ${where} ORDER BY start_ms
  `);

  const sCol = result.getChild("start_ms");
  const eCol = result.getChild("end_ms");
  const tCol = result.getChild("threat_type");

  // Group intervals by day+category
  // dayMap: Map<day_ms, Map<category, [[start, end], ...]>>
  const dayMap = new Map();
  for (let i = 0; i < result.numRows; i++) {
    const s = Number(sCol.get(i));
    const e = Number(eCol.get(i));
    const cat = CATEGORY_MAP[tCol.get(i)] || String(tCol.get(i));
    const dayStart = Math.floor(s / 86400000) * 86400000;
    const dayEnd = Math.floor(e / 86400000) * 86400000;
    for (let d = dayStart; d <= dayEnd; d += 86400000) {
      const clipS = Math.max(s, d);
      const clipE = Math.min(e, d + 86400000);
      if (clipE <= clipS) continue;
      if (!dayMap.has(d)) dayMap.set(d, new Map());
      const catMap = dayMap.get(d);
      if (!catMap.has(cat)) catMap.set(cat, []);
      catMap.get(cat).push([clipS, clipE]);
    }
  }

  // Merge overlapping intervals per day+category and compute duration
  function mergeAndSum(intervals) {
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [intervals[0].slice()];
    for (let i = 1; i < intervals.length; i++) {
      const last = merged[merged.length - 1];
      if (intervals[i][0] <= last[1]) {
        last[1] = Math.max(last[1], intervals[i][1]);
      } else {
        merged.push(intervals[i].slice());
      }
    }
    return merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  }

  const rows = [];
  for (const [day_ms, catMap] of [...dayMap.entries()].sort((a, b) => a[0] - b[0])) {
    const byCategory = {};
    for (const [cat, intervals] of catMap) {
      const minutes = Math.round(mergeAndSum(intervals) / 60000);
      if (minutes > 0) byCategory[cat] = minutes;
    }
    rows.push({ day_ms, byCategory });
  }
  return rows;
}

export async function queryEventsByCityInZone(zone, startMs, endMs) {
  const clauses = [`zone_en = '${escapeSql(zone)}'`];
  if (startMs != null) clauses.push(`end_ms >= ${startMs}`);
  if (endMs != null) clauses.push(`start_ms <= ${endMs}`);
  const where = "WHERE " + clauses.join(" AND ");

  const result = await conn.query(`
    WITH filtered AS (
      SELECT * FROM incidents ${where}
    ),
    city_dur AS (
      SELECT data, SUM(end_ms - start_ms) as raw_total
      FROM filtered GROUP BY data
    )
    SELECT f.data, f.threat_type, f.start_ms, f.end_ms
    FROM filtered f
    JOIN city_dur cd ON f.data = cd.data
    ORDER BY cd.raw_total DESC, f.data, f.start_ms
  `);

  const CATEGORY_MAP = { missiles: "1", drones: "2", infiltration: "10" };
  return result.toArray().map((r) => ({
    city: r.data,
    category: CATEGORY_MAP[r.threat_type] || r.threat_type,
    start_ms: Number(r.start_ms),
    end_ms: Number(r.end_ms),
  }));
}

