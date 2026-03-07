import { readFileSync, writeFileSync, mkdirSync } from "fs";

const OUT = "optimized";
mkdirSync(OUT, { recursive: true });

// ── helpers ──
function parseCSV(text) {
  const [headerLine, ...lines] = text.trim().split("\n");
  const headers = headerLine.split(",");
  return lines.map((line) => {
    const vals = line.split(",");
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = vals[i] || "";
    return obj;
  });
}

// ── 1. alerts_cube.json ──
console.log("Processing alerts_typed.csv...");
const typedRaw = readFileSync("data/alerts_typed.csv", "utf-8");
const typedRows = parseCSV(typedRaw);

const cutoff = new Date(2026, 1, 26); // Feb 26
const catMap = { "1": 0, "2": 1, "10": 2 };
const validCats = new Set(["1", "2", "10"]);

const filtered = typedRows.filter((r) => {
  if (!validCats.has(r.category)) return false;
  const ts = new Date(r.alertDate);
  return ts >= cutoff;
});

console.log(`  ${typedRows.length} total rows -> ${filtered.length} after filtering`);

// Aggregate into (city, hour, threat) tuples
const tupleMap = new Map();
for (const r of filtered) {
  const ts = new Date(r.alertDate);
  const hour = ts.toISOString().slice(0, 13); // "2026-02-28T16"
  const key = `${r.data}\t${hour}\t${r.category}`;
  tupleMap.set(key, (tupleMap.get(key) || 0) + 1);
}

const cities = [...new Set(filtered.map((r) => r.data))].sort();
const cityIdx = new Map(cities.map((c, i) => [c, i]));
const hours = [...new Set(filtered.map((r) => new Date(r.alertDate).toISOString().slice(0, 13)))].sort();
const hourIdx = new Map(hours.map((h, i) => [h, i]));

const c = [], h = [], t = [], n = [];
for (const [key, count] of tupleMap) {
  const [city, hour, cat] = key.split("\t");
  c.push(cityIdx.get(city));
  h.push(hourIdx.get(hour));
  t.push(catMap[cat]);
  n.push(count);
}

const cube = { cities, hours, c, h, t, n };
writeFileSync(`${OUT}/alerts_cube.json`, JSON.stringify(cube));
console.log(`  ${tupleMap.size} tuples, ${cities.length} cities, ${hours.length} hours`);

// ── 2. timeline_events.json ──
console.log("Processing alerts_matched.csv...");
const matchedRaw = readFileSync("data/alerts_matched.csv", "utf-8");
const matchedRows = parseCSV(matchedRaw);

const threatMap = { missiles: 0, drones: 1, terrorists: 2 };
const validThreats = new Set(["missiles", "drones", "terrorists"]);

const base = cutoff;
const baseMs = base.getTime();

function toMinutes(isoStr) {
  if (!isoStr) return null;
  const ms = new Date(isoStr).getTime();
  return Math.round((ms - baseMs) / 60000);
}

const matchedFiltered = matchedRows.filter((r) => {
  if (!validThreats.has(r.threat_type)) return false;
  const ts = new Date(r.ts);
  const warning = r.warning_ts ? new Date(r.warning_ts) : null;
  const start = warning && warning < ts ? warning : ts;
  return start >= cutoff;
});

console.log(`  ${matchedRows.length} total rows -> ${matchedFiltered.length} after filtering`);

const mCities = [...new Set(matchedFiltered.map((r) => r.data))].sort();
const mCityIdx = new Map(mCities.map((c, i) => [c, i]));

const mc = [], mt = [], ms = [], mr = [], mw = [];
for (const r of matchedFiltered) {
  mc.push(mCityIdx.get(r.data));
  mt.push(threatMap[r.threat_type]);

  const tsMin = toMinutes(r.ts);
  const warnMin = toMinutes(r.warning_ts);
  const startMin = warnMin !== null && warnMin < tsMin ? warnMin : tsMin;

  ms.push(startMin);
  mr.push(toMinutes(r.resolved_ts));
  mw.push(warnMin);
}

const events = {
  cities: mCities,
  base: base.toISOString(),
  c: mc,
  t: mt,
  s: ms,
  r: mr,
  w: mw,
};
writeFileSync(`${OUT}/timeline_events.json`, JSON.stringify(events));
console.log(`  ${matchedFiltered.length} events, ${mCities.length} cities`);

// ── 3. zones.geojson ──
console.log("Processing geojson...");
const geo = JSON.parse(readFileSync("geo/pikud_haoref_zones.geojson", "utf-8"));

for (const f of geo.features) {
  const { name_he, name_en, zone_he, zone_en } = f.properties;
  f.properties = { name_he, name_en, zone_he, zone_en };
}

writeFileSync(`${OUT}/zones.geojson`, JSON.stringify(geo));
console.log(`  ${geo.features.length} features (stripped to 4 properties)`);

// ── Summary ──
console.log("\nDone! Output files:");
for (const f of ["alerts_cube.json", "timeline_events.json", "zones.geojson"]) {
  const size = readFileSync(`${OUT}/${f}`).length;
  console.log(`  ${OUT}/${f}: ${(size / 1024).toFixed(0)} KB`);
}
