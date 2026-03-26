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
  queryFilteredIncidentEvents,
  queryEventsByZone,
  queryDailyAlertCounts,
  queryDailyShelterDuration,
} from "./db.js";

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

function emitSignal(signalName, value) {
  signalValues.set(signalName, value);
  const listeners = signalListeners.get(signalName);
  if (!listeners) return;
  for (const listener of listeners) {
    listener(value);
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
  filteredIncidentEvents: {
    depends: ["threat", "ctx", "zone", "city"],
    run: (filters) => queryFilteredIncidentEvents(filters.threat, filters.ctx, filters.zone, filters.city),
  },
  alertDurationByZone: {
    depends: ["startMs", "endMs"],
    run: (filters) => queryEventsByZone(filters.startMs, filters.endMs),
  },
  dailyAlertCounts: {
    depends: ["startMs", "endMs", "ctx", "zone", "city"],
    run: (filters) => queryDailyAlertCounts(filters.startMs, filters.endMs, filters.ctx, filters.zone, filters.city),
  },
  dailyShelterDuration: {
    depends: ["startMs", "endMs", "ctx", "zone", "city"],
    run: (filters) => queryDailyShelterDuration(filters.startMs, filters.endMs, filters.ctx, filters.zone, filters.city),
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
