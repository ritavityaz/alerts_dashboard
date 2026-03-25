# Dashboard Data Flow Diagram

## Layer 1: Data Sources

```
┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐  ┌──────────┐
│  snapshot.json    │  │  alerts.parquet   │  │ events.parquet  │  │zones.geo-│
│  (pre-computed)   │  │  (hourly aggs)    │  │ (individual)    │  │json      │
└────────┬─────────┘  └────────┬──────────┘  └───────┬─────────┘  └────┬─────┘
         │                     │                     │                 │
         ▼                     ▼                     ▼                 ▼
```

## Layer 2: Fetching (init.js)

**Fast path** (parallel, immediate render):
- `fetch(snapshot.json)` → `Response.json()` → Object
- `d3.json(zones.geojson)` → GeoJSON FeatureCollection

**Slow path** (background):
- `fetch(alerts.parquet)` → `ArrayBuffer`
- `fetch(events.parquet)` → `ArrayBuffer`
- → `initDB(alertsBuf, eventsBuf)` → DuckDB tables registered

### Snapshot Shape

```js
{
  totalAlerts: number,
  minTs: number,              // epoch ms
  maxTs: number,              // epoch ms
  cities: number,
  peakDayMs: number,          // epoch ms
  peakCount: number,
  missiles: number,
  drones: number,
  infiltration: number,
  countByCity: Map<string, number>,
  sparkline: Array<{
    hour: number,             // epoch ms
    cnt: number
  }>
}
```

### GeoJSON Shape

```js
{
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    geometry: { type, coordinates },
    properties: {
      name_he: string,
      name_en: string,
      zone_he: string,
      zone_en: string
    }
  }, ...]
}
```

### DuckDB Table Schemas

**alerts table:**

| Column   | Type   | Description              |
|----------|--------|--------------------------|
| ts       | int    | Hourly bucket (epoch ms) |
| data     | string | City name (Hebrew)       |
| category | int    | 1 \| 2 \| 10            |
| count    | int    | Aggregated alert count   |

**events table:**

| Column      | Type   | Description                          |
|-------------|--------|--------------------------------------|
| data        | string | City name (Hebrew)                   |
| threat_type | string | "missiles" \| "drones" \| "terrorists" |
| start_ms    | int    | Epoch ms                             |
| end_ms      | int    | Epoch ms (or null = ongoing)         |
| zone_en     | string | Zone name (English)                  |
| name_en     | string | City name (English)                  |

---

## Layer 3: State Management (store.js)

```js
state = {
  threat:  "all" | "1" | "2" | "10",       // alert category filter
  zone:    "all" | string,                  // zone_en name
  city:    null  | string,                  // city name_he
  ctx:     "country" | "zone" | "city",     // drill-down scope (data filtering)
  mapCtx:  "country" | "zone" | "city",     // map visualization scope (zoom/highlight)
  startMs: null | number,                   // epoch ms, time range start
  endMs:   null | number                    // epoch ms, time range end
}
```

**API:**
- `store.getState()` → shallow copy
- `store.update({key: val})` → notifies subscribers with `(newState, Set<key>)`
- `store.subscribe(fn)` → unsubscribe function

---

## Layer 4: Query Engine & Signal Dispatch (queries.js)

On store change → `runAffectedQueries(changedKeys)`:
- Only queries whose `depends` keys overlap with `changedKeys` re-run
- Results are cached by `(queryName, filterValues)`
- Each result emits a signal: `emitSignal(queryName, result)`

### Query Dependency Map

| Signal Name            | Depends On                                |
|------------------------|-------------------------------------------|
| alertCountsByCity      | threat, mapCtx, zone, city, startMs, endMs|
| alertMaxCountPerCity   | threat, startMs, endMs                    |
| alertStats             | ctx, zone, city, startMs, endMs           |
| hourlySparkline        | threat, ctx, zone, city                   |
| filteredAlertEvents    | threat, ctx, zone, city                   |
| alertDurationByZone    | startMs, endMs                            |
| dailyAlertCounts       | startMs, endMs, ctx, zone, city           |
| dailyShelterDuration   | startMs, endMs, ctx, zone, city           |

---

## Layer 5: SQL Execution & Result Shapes (db.js)

### Common WHERE Clause (filterWhere)

```
threat="1"     → alerts: category=1    events: threat_type='missiles'
threat="2"     → alerts: category=2    events: threat_type='drones'
threat="10"    → alerts: category=10   events: threat_type='terrorists'
ctx="city"     → WHERE data='${city}'
ctx="zone"     → WHERE zone_en='${zone}'
startMs/endMs  → WHERE ts >= ${startMs} AND ts <= ${endMs}

Note: alertCountsByCity uses mapCtx (not ctx) for its scope filter,
allowing the map to show a different scope than the data queries.
```

### Query Result Shapes

**queryCountsByCity:**
```js
Map<string, number>   // key = city name (Hebrew), value = total alert count
```

**queryStats:**
```js
{
  total: number,
  cities: number,
  peakDayMs: number | null,   // epoch ms of busiest day
  peakCount: number,
  missiles: number,
  drones: number,
  infiltration: number
}
```

**querySparkline:**
```js
Array<{ hour: number, count: number }>   // hour = epoch ms
```

**queryFilteredEvents:**
```js
Array<{
  data: string,                                      // city name (Hebrew)
  threat_type: "missiles" | "drones" | "terrorists",
  _start: Date,                                      // faked-local Date for D3
  _end: Date | null,                                 // null = ongoing
  NAME_HE: string,
  NAME_EN: string,
  zone_en: string
}>
```

**queryEventsByZone:**
```js
Array<{
  zone: string,              // zone_en
  category: "1" | "2" | "10",
  start_ms: number,          // epoch ms
  end_ms: number,
  cities: number             // unique city count in zone
}>
```

**queryDailyAlertCounts:**
```js
Array<{
  day_ms: number,                            // start-of-day epoch
  byCategory: { "1"?: number, "2"?: number, "10"?: number }  // count per threat
}>
```

**queryDailyShelterDuration:**
```js
Array<{
  day_ms: number,                            // start-of-day epoch
  byCategory: { "1"?: number, "2"?: number, "10"?: number }  // minutes per threat
}>
```

**queryEventsByCityInZone:**
```js
Array<{
  city: string,                              // city name (Hebrew)
  category: "1" | "2" | "10",
  start_ms: number,                          // epoch ms
  end_ms: number                             // epoch ms
}>
```

---

## Layer 6: Component Framework (framework.js)

```js
defineComponent("name", {
  signals: ["signalA", "signalB"],
  render(element, signalData, isMobile) { ... },
  init(element) { ... },
  destroy(element) { ... }
})

mountAll()   // scans DOM for data-component attributes → binds components

// signalData shape passed to render:
{ [signalName]: latestQueryResult }
```

---

## Layer 7: Rendering Components

### Map (map.js)

**Subscribes to:** `alertCountsByCity` (`Map<string, number>`), `alertMaxCountPerCity`

**Transform:**
```js
colorScale = d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([1, maxCount])

// For each city:
color = colorScale(count) → [r, g, b]: 0-255
map.setFeatureState(
  { source: "zones", id: cityNameHe },
  { count: number, r: number, g: number, b: number }
)
```

**Render:** MapLibre GL choropleth, fill-color from feature-state r/g/b

**Zoom:** Subscribes to `mapCtx`, `zone`, `city` changes → zooms to city/zone/country based on `mapCtx`

**Click** → `store.update({city, zone, ctx: "city", mapCtx: "city"})`

---

### Timeline (timeline.js)

**Subscribes to:** `filteredAlertEvents`

**Transform — dayslice():**
```js
// Input:  Array<{_start: Date, _end: Date|null, ...event}>
// Output: Array<{
//   ...event,
//   day: Date,           // date portion only
//   y0: number,          // fractional hour (0-24), start within day
//   y1: number | null    // fractional hour, end (null = ongoing)
// }>
// Multi-day events are split at midnight boundaries
```

**Scales:**
- X = `d3.scaleBand().domain([...days])` — one column per day
- Y = `d3.scaleLinear().domain([0, 24])` — hours of day

**Color:** `{ missiles: "#ef4444", drones: "#8b5cf6", terrorists: "#f59e0b" }`

**Render:** SVG rects per slice, fixed Y-axis + scrollable date columns

**Tooltip:** `expandOverlapCluster()` finds transitive overlaps via invisible overlay rects per day.
Groups by `threat_type` (<5 cities) or collapsible `zone_en` sections (≥5 cities).
Click-to-pin tooltip with X button; click empty space to unpin.
Separate `<g>` overlay group for z-order stability (avoids D3 .join() re-order issues).

---

### Heatmap (heatmap.js)

**Subscribes to:** `filteredAlertEvents`

**Splits events into 3 time windows:**
```js
{ "3d": {events, from, to}, "7d": {events, from, to}, "all": {events, from, to} }
```

**Transform — computeBins(events, from, to):**
1. Clamp each event to `[from, to]`
2. `age = (to - event midpoint)`
3. `weight = exp(-ln(2)/2days * age)` — 2-day half-life decay
4. Map to minute-of-day (0-1440)
5. Distribute weight across touched bins

**Returns:** `Float64Array[48]` — 48 bins x 30 min each, value = weighted count

**Render:** 3 columns x 48 rows grid, color intensity = bin value

---

### Charts (charts.js)

**Duration-by-Zone (stacked bar):**

Subscribes to: `alertDurationByZone`

Transform — `buildDurationStacked(rows, "zone", "cities")`:
```js
// Groups events by zone → category → merges overlapping intervals
// Returns:
Array<{
  name: string,           // zone_en
  total: number,          // total minutes
  meta: number,           // cities count
  segments: Array<{
    cat: "1" | "2" | "10",
    count: number,        // minutes for this category
    x0: number,           // stacked start position
    x1: number,           // stacked end position
    name: string          // zone_en
  }>
}>
```

**Duration-by-Zone — city expansion:**

Clicking a zone bar drills down via `queryEventsByCityInZone(zone, startMs, endMs)`,
showing per-city stacked bars within that zone.

**Daily Histogram (stacked by category):**

Subscribes to: `dailyAlertCounts` or `dailyShelterDuration`

Data: `Array<{ day_ms: number, byCategory: { "1"?: number, "2"?: number, "10"?: number } }>`

Bars are stacked by threat category (missiles/drones/terrorists).

Scales: X = `d3.scaleBand(days)`, Y = `d3.scaleLinear(values)`

---

### Stats Panel (stats.js)

**Subscribes to:** `alertStats`

**Input:** `{ total, cities, peakDayMs, peakCount, missiles, drones, infiltration }`

**Render:** Formatted numbers into DOM elements via i18n formatters

---

### Quiet Periods (quiet.js)

**Input:** `filteredAlertEvents` array

**longestGap(events, from, to, { fromFirstAlert = false }):**
- Merges overlapping events → finds max gap
- `fromFirstAlert`: if true, skips the gap before the first alert
- Returns: `{ ms: number, start: Date, end: Date }`

**quietestHour(events, from, to):**
- Projects all events onto 24h clock → finds longest uncovered window
- Returns: `{ startH, startM, endH, endM: number, minutes: number }`

Computed for each window: 3d, 7d, all-time

---

### Time Slider (slider.js)

**Subscribes to:** `hourlySparkline`

**Input:** `Array<{ hour: number (ms), count: number }>`

**Render:** D3 area chart (X = time, Y = count) + dual-range inputs

**Output:** `store.update({ startMs: number|null, endMs: number|null })`

**Conversions:**
- `sliderToUtcMs(hourIndex)` → `number` (epoch ms)
- `dateToSlider(Date)` → `number` (hour index)
- `utcMsToIsraelDate(ms)` → `Date` (Israel TZ)

---

## Layer 8: Filter UI (filters.js)

**Inputs:** Chip clicks, dropdown selections, time presets, datetime pickers

**Lookup tables** (built from geojson features):
```js
cityToZone:  Map<nameHe, zoneEn>
cityEnToHe:  Map<nameEn, nameHe>
cityHeToEn:  Map<nameHe, nameEn>
zoneEnToHe:  Map<zoneEn, zoneHe>
```

**Context toggle** (visible when city selected):
- Three buttons: country / zone / city
- Updates both `ctx` and `mapCtx` together

**Output:** `store.update({ threat?, zone?, city?, ctx?, mapCtx?, startMs?, endMs? })` → back to Layer 3

---

## End-to-End Data Type Summary

| Step | Location | Shape | Types |
|---|---|---|---|
| **Fetch** | Network | Raw bytes | `Response` → `.json()` / `.arrayBuffer()` |
| **Snapshot** | init.js | Object literal | `{totalAlerts: number, sparkline: {hour, cnt}[], countByCity: Map<string,number>, ...}` |
| **GeoJSON** | init.js | FeatureCollection | `{features: {properties: {name_he, name_en, zone_he, zone_en}}[]}` |
| **Parquet → DuckDB** | db.js | SQL tables | `alerts(ts int, data text, category int, count int)`, `events(data text, threat_type text, start_ms int, end_ms int, zone_en text, name_en text)` |
| **Store state** | store.js | Plain object | `{threat: string, zone: string, city: string\|null, ctx: string, mapCtx: string, startMs: number\|null, endMs: number\|null}` |
| **Query results** | db.js → queries.js | Varies per query | `Map<string,number>`, `Array<{...}>`, or `{...}` — see Layer 5 |
| **Signal dispatch** | queries.js → framework.js | `{signalName: result}` | Same as query results, keyed by signal name |
| **Map feature state** | map.js | Per-feature object | `{count: number, r: 0-255, g: 0-255, b: 0-255}` |
| **Timeline slices** | timeline.js | Derived array | `{...event, day: Date, y0: float(0-24), y1: float\|null}[]` |
| **Heatmap bins** | heatmap.js | Typed array | `Float64Array[48]` — weighted counts per 30-min slot |
| **Stacked bar segments** | charts.js | Derived array | `{name: string, total: number, segments: {cat, count, x0, x1}[]}[]` (zone click → city expansion) |
| **Filter UI output** | filters.js | Store update | Partial `{threat?, zone?, city?, ctx?, mapCtx?, startMs?, endMs?}` |

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            LAYER 1: DATA SOURCES                                │
│                                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐  ┌──────────┐ │
│  │  snapshot.json    │  │  alerts.parquet   │  │ events.parquet  │  │zones.geo-│ │
│  │  (pre-computed)   │  │  (hourly aggs)    │  │ (individual)    │  │json      │ │
│  └────────┬─────────┘  └────────┬──────────┘  └───────┬─────────┘  └────┬─────┘ │
└───────────┼──────────────────────┼─────────────────────┼─────────────────┼───────┘
            │                      │                     │                 │
            ▼                      ▼                     ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        LAYER 2: FETCHING  (init.js)                             │
│                                                                                 │
│  FAST PATH (parallel, immediate):        SLOW PATH (background):                │
│  ┌─────────────────────────────┐         ┌────────────────────────────────────┐ │
│  │ fetch(snapshot.json)        │         │ fetch(alerts.parquet) → ArrayBuffer│ │
│  │   → Response.json()         │         │ fetch(events.parquet) → ArrayBuffer│ │
│  │   → Object                  │         │   → initDB(alertsBuf, eventsBuf)  │ │
│  │                             │         │   → DuckDB tables registered      │ │
│  │ d3.json(zones.geojson)      │         └────────────────────────────────────┘ │
│  │   → GeoJSON FeatureCollection│                                               │
│  └─────────────────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────────────────┘
            │                                            │
            ▼                                            ▼
┌───────────────────────────────────┐  ┌──────────────────────────────────────────┐
│  SNAPSHOT SHAPE                   │  │  DUCKDB TABLE SCHEMAS                    │
│  {                                │  │                                          │
│    totalAlerts: number,           │  │  alerts table:                           │
│    minTs: number (epoch ms),      │  │  ┌──────────┬──────────┬────────┬─────┐ │
│    maxTs: number (epoch ms),      │  │  │ts: ms    │data:     │category│count│ │
│    cities: number,                │  │  │(hourly   │string    │: 1|2|10│: int│ │
│    peakDayMs: number (epoch ms),  │  │  │bucket)   │(city he) │        │     │ │
│    peakCount: number,             │  │  └──────────┴──────────┴────────┴─────┘ │
│    missiles: number,              │  │                                          │
│    drones: number,                │  │  events table:                           │
│    infiltration: number,          │  │  ┌────────┬───────────┬────────┬───────┐ │
│    countByCity: Map<string,number>,│ │  │data:   │threat_type│start_ms│end_ms │ │
│    sparkline: Array<{             │  │  │string  │: missiles │: int   │: int  │ │
│      hour: number (ms),           │  │  │(city)  │| drones   │(epoch) │|null  │ │
│      cnt: number                  │  │  │        │| terrorists│       │       │ │
│    }>                             │  │  ├────────┴───────────┴────────┴───────┤ │
│  }                                │  │  │+ zone_en: string, name_en: string  │ │
│                                   │  │  └────────────────────────────────────┘ │
│  GEOJSON SHAPE                    │  │                                          │
│  {                                │  │                                          │
│    type: "FeatureCollection",     │  │                                          │
│    features: [{                   │  │                                          │
│      type: "Feature",             │  │                                          │
│      geometry: {type, coords},    │  │                                          │
│      properties: {                │  │                                          │
│        name_he: string,           │  │                                          │
│        name_en: string,           │  │                                          │
│        zone_he: string,           │  │                                          │
│        zone_en: string            │  │                                          │
│      }                            │  │                                          │
│    }, ...]                        │  │                                          │
│  }                                │  │                                          │
└───────────────────────────────────┘  └──────────────────────────────────────────┘
            │                                            │
            │  (renders initial UI immediately)          │ (ready after parquet load)
            ▼                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      LAYER 3: STATE MANAGEMENT  (store.js)                      │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  state: {                                                               │    │
│  │    threat: "all" | "1" | "2" | "10",        // alert category filter    │    │
│  │    zone:   "all" | string,                  // zone_en name             │    │
│  │    city:   null  | string,                  // city name_he             │    │
│  │    ctx:    "country" | "zone" | "city",     // drill-down scope (data)  │    │
│  │    mapCtx: "country" | "zone" | "city",     // map scope (zoom/color)   │    │
│  │    startMs: null | number (epoch ms),       // time range start         │    │
│  │    endMs:   null | number (epoch ms)        // time range end           │    │
│  │  }                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  API:  store.getState() → shallow copy                                          │
│        store.update({key: val}) → notifies subscribers with (newState, Set<key>)│
│        store.subscribe(fn) → unsubscribe fn                                     │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
               store.update() triggers │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│               LAYER 4: QUERY ENGINE & SIGNAL DISPATCH  (queries.js)             │
│                                                                                 │
│  On store change → runAffectedQueries(changedKeys: Set<string>)                 │
│                                                                                 │
│  For each query definition:                                                     │
│    if (query.depends ∩ changedKeys ≠ ∅) → execute query → cache → emit signal   │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  QUERY DEPENDENCY MAP                                                   │    │
│  │                                                                         │    │
│  │  Signal Name            │ Depends On                                    │    │
│  │  ───────────────────────┼────────────────────────────────────────────   │    │
│  │  alertCountsByCity      │ threat, mapCtx, zone, city, startMs, endMs   │    │
│  │  alertMaxCountPerCity   │ threat, startMs, endMs                       │    │
│  │  alertStats             │ ctx, zone, city, startMs, endMs              │    │
│  │  hourlySparkline        │ threat, ctx, zone, city                      │    │
│  │  filteredAlertEvents    │ threat, ctx, zone, city                      │    │
│  │  alertDurationByZone    │ startMs, endMs                               │    │
│  │  dailyAlertCounts       │ startMs, endMs, ctx, zone, city              │    │
│  │  dailyShelterDuration   │ startMs, endMs, ctx, zone, city              │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  LAYER 5: SQL EXECUTION & RESULT SHAPES  (db.js)                │
│                                                                                 │
│  All queries apply a common WHERE clause built by filterWhere():                │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │  threat="1"     → alerts: category=1    events: threat_type='missiles' │    │
│  │  threat="2"     → alerts: category=2    events: threat_type='drones'   │    │
│  │  threat="10"    → alerts: category=10   events: threat_type='terrorists│    │
│  │  ctx="city"     → WHERE data='${city}'                                 │    │
│  │  ctx="zone"     → WHERE zone_en='${zone}'                              │    │
│  │  startMs/endMs  → WHERE ts >= ${startMs} AND ts <= ${endMs}            │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─── queryCountsByCity ──────────────────────────────────────────────────────┐ │
│  │  SQL: SELECT data, SUM(count) as cnt FROM alerts ... GROUP BY data        │ │
│  │  Returns: Map<string, number>                                              │ │
│  │           key = city name (Hebrew), value = total alert count              │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─── queryStats ─────────────────────────────────────────────────────────────┐ │
│  │  Returns: {                                                                │ │
│  │    total: number,              // total alert count                        │ │
│  │    cities: number,             // unique cities affected                   │ │
│  │    peakDayMs: number | null,   // epoch ms of busiest day                  │ │
│  │    peakCount: number,          // alerts on peak day                       │ │
│  │    missiles: number,           // count where category=1                   │ │
│  │    drones: number,             // count where category=2                   │ │
│  │    infiltration: number        // count where category=10                  │ │
│  │  }                                                                         │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─── querySparkline ─────────────────────────────────────────────────────────┐ │
│  │  Returns: Array<{ hour: number (epoch ms), count: number }>               │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─── queryFilteredEvents ────────────────────────────────────────────────────┐ │
│  │  Returns: Array<{                                                          │ │
│  │    data: "cityNameHe",                                                     │ │
│  │    threat_type: "missiles" | "drones" | "terrorists",                      │ │
│  │    _start: Date,               // faked-local Date for D3                  │ │
│  │    _end: Date | null,          // null = ongoing                           │ │
│  │    NAME_HE: string,                                                        │ │
│  │    NAME_EN: string,                                                        │ │
│  │    zone_en: string                                                         │ │
│  │  }>                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─── queryEventsByZone ──────────────────────────────────────────────────────┐ │
│  │  Returns: Array<{                                                          │ │
│  │    zone: string,               // zone_en                                  │ │
│  │    category: "1" | "2" | "10",                                             │ │
│  │    start_ms: number,           // epoch ms                                 │ │
│  │    end_ms: number,                                                         │ │
│  │    cities: number              // unique cities in zone                    │ │
│  │  }>                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─── queryDailyAlertCounts ──────────────────────────────────────────────────┐ │
│  │  Returns: Array<{                                                         │ │
│  │    day_ms: number (start-of-day epoch),                                   │ │
│  │    byCategory: { "1"?: number, "2"?: number, "10"?: number }              │ │
│  │  }>                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─── queryDailyShelterDuration ──────────────────────────────────────────────┐ │
│  │  Returns: Array<{                                                         │ │
│  │    day_ms: number (start-of-day epoch),                                   │ │
│  │    byCategory: { "1"?: number, "2"?: number, "10"?: number }              │ │
│  │  }>                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│  ┌─── queryEventsByCityInZone ───────────────────────────────────────────────┐ │
│  │  Returns: Array<{                                                         │ │
│  │    city: string, category: "1"|"2"|"10",                                  │ │
│  │    start_ms: number, end_ms: number                                       │ │
│  │  }>                                                                       │ │
│  └────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
                          emitSignal(name, result)
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│              LAYER 6: COMPONENT FRAMEWORK  (framework.js)                       │
│                                                                                 │
│  defineComponent("name", {                                                      │
│    signals: ["signalA", "signalB"],     // subscribes to these signals          │
│    render(element, signalData, isMobile) { ... },                               │
│    init(element) { ... },                                                       │
│    destroy(element) { ... }                                                     │
│  })                                                                             │
│                                                                                 │
│  mountAll() → scans DOM for data-component attributes → binds components        │
│                                                                                 │
│  signalData = { [signalName]: latestQueryResult }                               │
└──────────────────────────────────────┬──────────────────────────────────────────┘
                                       │
          ┌──────────┬─────────┬───────┴───────┬──────────┬──────────┐
          ▼          ▼         ▼               ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 7: RENDERING COMPONENTS                                │
│                                                                                 │
│ ┌─── MAP (map.js) ────────────────────────────────────────────────────────────┐ │
│ │ Subscribes to: alertCountsByCity (Map<string,number>),                      │ │
│ │                 alertMaxCountPerCity                                         │ │
│ │                                                                             │ │
│ │ Transform:                                                                  │ │
│ │   colorScale = d3.scaleSequentialLog(d3.interpolateYlOrRd)                  │ │
│ │                   .domain([1, maxCount])                                     │ │
│ │                                                                             │ │
│ │   For each city in countsByCity:                                             │ │
│ │     color = colorScale(count) → [r, g, b]: 0-255                            │ │
│ │     map.setFeatureState(                                                     │ │
│ │       { source: "zones", id: cityNameHe },                                  │ │
│ │       { count: number, r: number, g: number, b: number }                    │ │
│ │     )                                                                        │ │
│ │                                                                             │ │
│ │ Render: MapLibre GL choropleth, fill-color from feature-state r/g/b         │ │
│ │ Zoom: listens to mapCtx/zone/city → zooms to city/zone/country             │ │
│ │ Click → store.update({city, zone, ctx:"city", mapCtx:"city"})              │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ ┌─── TIMELINE (timeline.js) ──────────────────────────────────────────────────┐ │
│ │ Subscribes to: filteredAlertEvents                                          │ │
│ │                                                                             │ │
│ │ Transform — dayslice():                                                     │ │
│ │   Input:  Array<{_start: Date, _end: Date|null, ...event}>                  │ │
│ │   Output: Array<{                                                           │ │
│ │     ...event,                                                               │ │
│ │     day: Date,              // date portion only                            │ │
│ │     y0: number,             // fractional hour (0–24), start within day     │ │
│ │     y1: number | null       // fractional hour, end (null = ongoing)        │ │
│ │   }>                                                                        │ │
│ │   (multi-day events split at midnight boundaries)                           │ │
│ │                                                                             │ │
│ │ Scales:                                                                     │ │
│ │   X = d3.scaleBand().domain([...days])     // one column per day            │ │
│ │   Y = d3.scaleLinear().domain([0, 24])     // hours of day                  │ │
│ │                                                                             │ │
│ │ Color: { missiles: "#ef4444", drones: "#8b5cf6", terrorists: "#f59e0b" }    │ │
│ │                                                                             │ │
│ │ Render: SVG rects (bars) per slice, fixed Y-axis + scrollable date columns  │ │
│ │ Tooltip: expandOverlapCluster() finds transitive overlaps via overlay rects  │ │
│ │   Groups by threat_type (<5) or collapsible zone_en (≥5). Click-to-pin.    │ │
│ │   Separate <g> overlay group for z-order stability.                         │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ ┌─── HEATMAP (heatmap.js) ────────────────────────────────────────────────────┐ │
│ │ Subscribes to: filteredAlertEvents                                          │ │
│ │                                                                             │ │
│ │ Splits events into 3 time windows:                                          │ │
│ │   { "3d": {events, from, to}, "7d": {events, from, to},                    │ │
│ │     "all": {events, from, to} }                                             │ │
│ │                                                                             │ │
│ │ Transform — computeBins(events, from, to):                                  │ │
│ │   For each event:                                                           │ │
│ │     1. Clamp to [from, to]                                                  │ │
│ │     2. age = (to - event midpoint)                                          │ │
│ │     3. weight = exp(-ln(2)/2days × age)    // 2-day half-life decay         │ │
│ │     4. Map to minute-of-day (0–1440)                                        │ │
│ │     5. Distribute weight across touched bins                                │ │
│ │                                                                             │ │
│ │   Returns: Float64Array[48]                // 48 bins × 30 min each         │ │
│ │            index = half-hour slot, value = weighted count                    │ │
│ │                                                                             │ │
│ │ Render: 3 columns × 48 rows grid, color intensity = bin value               │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ ┌─── CHARTS (charts.js) ──────────────────────────────────────────────────────┐ │
│ │                                                                             │ │
│ │ Duration-by-Zone (stacked bar):                                             │ │
│ │   Subscribes to: alertDurationByZone                                        │ │
│ │   Transform — buildDurationStacked(rows, "zone", "cities"):                 │ │
│ │     Groups events by zone → category → merged intervals                     │ │
│ │     Returns: Array<{                                                        │ │
│ │       name: string,           // zone_en                                    │ │
│ │       total: number,          // total minutes                              │ │
│ │       meta: number,           // cities count                               │ │
│ │       segments: Array<{                                                     │ │
│ │         cat: "1"|"2"|"10",    // threat category                            │ │
│ │         count: number,        // minutes for this category                  │ │
│ │         x0: number,           // stacked start position                     │ │
│ │         x1: number,           // stacked end position                       │ │
│ │         name: string          // zone_en                                    │ │
│ │       }>                                                                    │ │
│ │     }>                                                                      │ │
│ │                                                                             │ │
│ │ Zone click → queryEventsByCityInZone() → city-level stacked bars            │ │
│ │                                                                             │ │
│ │ Daily Histogram (stacked by category):                                      │ │
│ │   Subscribes to: dailyAlertCounts or dailyShelterDuration                   │ │
│ │   Data: Array<{ day_ms, byCategory: {"1"?:n,"2"?:n,"10"?:n} }>            │ │
│ │   Scales: X = d3.scaleBand(days), Y = d3.scaleLinear(values)               │ │
│ │   Render: stacked vertical bars by threat category                          │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ ┌─── STATS PANEL (stats.js) ──────────────────────────────────────────────────┐ │
│ │ Subscribes to: alertStats                                                   │ │
│ │ Input: { total, cities, peakDayMs, peakCount, missiles, drones,             │ │
│ │          infiltration }                                                      │ │
│ │ Render: formatted numbers into DOM elements via i18n formatters             │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ ┌─── QUIET PERIODS (quiet.js) ────────────────────────────────────────────────┐ │
│ │ Input: filteredAlertEvents array                                            │ │
│ │                                                                             │ │
│ │ longestGap(events, from, to, { fromFirstAlert? }):                          │ │
│ │   Merges overlapping events → finds max gap                                 │ │
│ │   fromFirstAlert: skip gap before first alert                               │ │
│ │   Returns: { ms: number, start: Date, end: Date }                           │ │
│ │                                                                             │ │
│ │ quietestHour(events, from, to):                                             │ │
│ │   Projects all events onto 24h clock → finds longest uncovered window       │ │
│ │   Returns: { startH, startM, endH, endM: number, minutes: number }         │ │
│ │                                                                             │ │
│ │ Computed for each window: 3d, 7d, all-time                                  │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ ┌─── TIME SLIDER (slider.js) ─────────────────────────────────────────────────┐ │
│ │ Subscribes to: hourlySparkline                                              │ │
│ │ Input: Array<{ hour: number (ms), count: number }>                          │ │
│ │ Render: D3 area chart (X = time, Y = count) + dual-range inputs            │ │
│ │ Output: store.update({ startMs: number|null, endMs: number|null })          │ │
│ │                                                                             │ │
│ │ Conversions:                                                                │ │
│ │   sliderToUtcMs(hourIndex) → number (epoch ms)                              │ │
│ │   dateToSlider(Date) → number (hour index)                                  │ │
│ │   utcMsToIsraelDate(ms) → Date (Israel TZ)                                 │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
          ▲                                                          │
          │              USER INTERACTION FEEDBACK LOOP               │
          │                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      LAYER 8: FILTER UI  (filters.js)                           │
│                                                                                 │
│  Inputs: chip clicks, dropdown selections, time presets, datetime pickers       │
│                                                                                 │
│  Context toggle (visible when city selected):                                   │
│    Three buttons: country / zone / city → updates ctx + mapCtx together         │
│                                                                                 │
│  Lookup tables (built from geojson features):                                   │
│    cityToZone:  Map<nameHe, zoneEn>                                             │
│    cityEnToHe:  Map<nameEn, nameHe>                                             │
│    cityHeToEn:  Map<nameHe, nameEn>                                             │
│    zoneEnToHe:  Map<zoneEn, zoneHe>                                             │
│                                                                                 │
│  Output: store.update({ threat?, zone?, city?, ctx?, mapCtx?, startMs?, endMs?})│
│          ──────────────► back to LAYER 3 (store) ──► re-triggers queries        │
└─────────────────────────────────────────────────────────────────────────────────┘
```
