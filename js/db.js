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
 * @param {ArrayBuffer} eventsBuf - events.parquet bytes
 */
export async function initDB(alertsBuf, eventsBuf) {
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

  console.time("duckdb:events-table");
  await db.registerFileBuffer("events.parquet", new Uint8Array(eventsBuf));
  await conn.query(`CREATE TABLE events AS SELECT * FROM read_parquet('events.parquet')`);
  console.timeEnd("duckdb:events-table");
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
  if (startMs != null && endMs != null) {
    clauses.push(`ts >= ${startMs} AND ts <= ${endMs}`);
  }
  if (threat && threat !== "all") {
    const col = table === "events" ? "threat_type" : "category";
    const val = table === "events" ? threatForCategory(threat) : threat;
    clauses.push(`${col} = '${val}'`);
  }
  if (ctx === "zone" && zone && zone !== "all") {
    clauses.push(`zone_en = '${escapeSql(zone)}'`);
  } else if (ctx === "city" && city) {
    clauses.push(`data = '${escapeSql(city)}'`);
  }
  return clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
}

const THREAT_MAP = { "1": "missiles", "2": "drones", "10": "terrorists" };
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
 * Get filtered timeline events (for timeline rendering, quiet periods, heatmap).
 * Returns array of plain objects matching the matched[] shape.
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
    SELECT data, threat_type, start_ms, end_ms, zone_en, name_en
    FROM events ${where}
  `);

  // Events store Israel wall-clock ms as if UTC. Shift by browser TZ offset
  // so Date local fields (.getHours() etc.) show Israel time for d3.
  // Use each date's own offset to handle DST transitions correctly.
  function toFakeLocal(ms) {
    const d = new Date(ms);
    return new Date(ms + d.getTimezoneOffset() * 60000);
  }

  const rows = [];
  const dataCol = result.getChild("data");
  const ttCol = result.getChild("threat_type");
  const sCol = result.getChild("start_ms");
  const eCol = result.getChild("end_ms");
  const enCol = result.getChild("name_en");
  for (let i = 0; i < result.numRows; i++) {
    const endMs = eCol.get(i);
    rows.push({
      data: dataCol.get(i),
      threat_type: ttCol.get(i),
      _start: toFakeLocal(Number(sCol.get(i))),
      _end: endMs != null ? toFakeLocal(Number(endMs)) : null,
      NAME_HE: dataCol.get(i),
      NAME_EN: enCol.get(i) || dataCol.get(i),
    });
  }
  return rows;
}
