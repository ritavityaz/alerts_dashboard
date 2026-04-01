/**
 * Query Cache — bridge between the filter store and components.
 *
 * Subscribes to store changes. When filters change, re-runs only the
 * DuckDB queries whose dependencies include the changed keys.
 * Exposes results as named signals that components subscribe to.
 */

import * as store from "./store.js";
import {
  queryCountsByCity,
  queryGlobalMax,
  queryStats,
  querySparkline,
  queryFilteredEvents,
  queryFilteredSlices,
  queryFilteredIncidentEvents,
  queryHeatmapBins,
  queryEventsByZone,
  queryDailyAlertCounts,
  queryDailyShelterDuration,
} from "./db.js";
import { israelDayStartUtc } from "./tz.js";

// ── Signal system ──

const signalListeners = new Map();   // signalName → Set<listener>
const signalValues = new Map();      // signalName → latest value

/**
 * Subscribe to a named signal. Listener is called with the new value
 * each time the signal fires. If the signal already has a value,
 * the listener is called immediately.
 * Returns an unsubscribe function.
 */
export function onSignal(signalName, listener) {
  if (!signalListeners.has(signalName)) {
    signalListeners.set(signalName, new Set());
  }
  signalListeners.get(signalName).add(listener);
  if (signalValues.has(signalName)) {
    listener(signalValues.get(signalName));
  }
  return () => signalListeners.get(signalName)?.delete(listener);
}

// ── Batched signal emission ──
// Defers listener calls to a single requestAnimationFrame so that multiple
// signals emitted in the same microtask (e.g. after Promise.all resolves)
// trigger only one combined paint instead of serialized re-renders.

const pendingSignals = new Map();  // signalName → value (last wins)
let rafScheduled = false;

function flushSignals() {
  rafScheduled = false;
  const batch = new Map(pendingSignals);
  pendingSignals.clear();
  for (const [signalName, value] of batch) {
    const listeners = signalListeners.get(signalName);
    if (!listeners) continue;
    for (const listener of listeners) {
      listener(value);
    }
  }
}

function emitSignal(signalName, value) {
  // Skip if the value is the same reference — avoids redundant re-renders
  // (e.g. reset returning the same cached result that's already displayed).
  if (signalValues.get(signalName) === value) return;
  signalValues.set(signalName, value);
  pendingSignals.set(signalName, value);
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(flushSignals);
  }
}

// ── Query definitions ──
// Each query declares which store keys it depends on and an async run function.

const queryDefinitions = {
  alertCountsByCity: {
    depends: ["threat", "mapCtx", "zone", "city", "startMs", "endMs"],
    run: (filters) => queryCountsByCity(filters.threat, filters.mapCtx, filters.zone, filters.city, filters.startMs, filters.endMs),
  },
  alertMaxCountPerCity: {
    depends: ["threat", "startMs", "endMs"],
    run: (filters) => queryGlobalMax(filters.threat, filters.startMs, filters.endMs),
  },
  alertStats: {
    depends: ["ctx", "zone", "city", "startMs", "endMs"],
    run: (filters) => queryStats(filters.ctx, filters.zone, filters.city, filters.startMs, filters.endMs),
  },
  hourlySparkline: {
    depends: ["threat", "ctx", "zone", "city"],
    run: (filters) => querySparkline(filters.threat, filters.ctx, filters.zone, filters.city),
  },
  filteredAlertEvents: {
    depends: ["threat", "ctx", "zone", "city"],
    run: (filters) => queryFilteredEvents(filters.threat, filters.ctx, filters.zone, filters.city),
  },
  filteredAlertSlices: {
    depends: ["threat", "ctx", "zone", "city"],
    run: (filters) => queryFilteredSlices(filters.threat, filters.ctx, filters.zone, filters.city),
  },
  heatmapBins: {
    depends: ["threat", "ctx", "zone", "city"],
    run: async (filters) => {
      const { threat, ctx, zone, city } = filters;
      const todayStartMs = israelDayStartUtc(Date.now());
      const [bins3d, bins7d, binsAll] = await Promise.all([
        queryHeatmapBins(threat, ctx, zone, city, todayStartMs - 3 * 86400000, todayStartMs),
        queryHeatmapBins(threat, ctx, zone, city, todayStartMs - 7 * 86400000, todayStartMs),
        queryHeatmapBins(threat, ctx, zone, city, 0, todayStartMs),
      ]);
      return { "3d": bins3d, "7d": bins7d, all: binsAll };
    },
  },
  filteredIncidentEvents: {
    depends: ["threat", "ctx", "zone", "city"],
    run: (filters) => queryFilteredIncidentEvents(filters.threat, filters.ctx, filters.zone, filters.city),
  },
  alertDurationByZone: {
    depends: ["startMs", "endMs"],
    run: (filters) => queryEventsByZone(filters.startMs, filters.endMs),
  },
  dailyAlertCounts: {
    depends: ["ctx", "zone", "city"],
    run: (filters) => queryDailyAlertCounts(undefined, undefined, filters.ctx, filters.zone, filters.city),
  },
  dailyShelterDuration: {
    depends: ["ctx", "zone", "city"],
    run: (filters) => queryDailyShelterDuration(undefined, undefined, filters.ctx, filters.zone, filters.city),
  },
};

// ── Cache ──
// Key: query name + serialized relevant filter values → value

const resultCache = new Map();

function buildCacheKey(queryName, filters) {
  const dependencies = queryDefinitions[queryName].depends;
  const parts = dependencies.map((key) => `${key}=${filters[key] ?? ""}`);
  return `${queryName}|${parts.join("&")}`;
}

// ── Version tracking to discard stale results ──

let currentVersion = 0;

/**
 * Run all queries that depend on the changed keys.
 * Pass changedKeys = null to run all queries (initial load).
 */
export async function runAffectedQueries(changedKeys) {
  const runVersion = ++currentVersion;
  const filters = store.getState();
  const queriesToRun = [];

  for (const [queryName, queryDef] of Object.entries(queryDefinitions)) {
    const isAffected = changedKeys === null || queryDef.depends.some((key) => changedKeys.has(key));
    if (!isAffected) continue;

    const cacheKey = buildCacheKey(queryName, filters);
    if (resultCache.has(cacheKey)) {
      emitSignal(queryName, resultCache.get(cacheKey));
    } else {
      queriesToRun.push({ queryName, cacheKey, run: queryDef.run });
    }
  }

  if (queriesToRun.length === 0) return;

  const results = await Promise.all(
    queriesToRun.map((entry) => entry.run(filters))
  );

  // Discard if a newer update superseded this batch
  if (currentVersion !== runVersion) return;

  for (let i = 0; i < queriesToRun.length; i++) {
    resultCache.set(queriesToRun[i].cacheKey, results[i]);
    emitSignal(queriesToRun[i].queryName, results[i]);
  }
}

/**
 * Initialize: subscribe to the store so queries re-run on filter changes.
 * Call runAffectedQueries(null) separately once DuckDB is ready.
 */
export function init() {
  store.subscribe((_filters, changedKeys) => {
    runAffectedQueries(changedKeys);
  });
}
