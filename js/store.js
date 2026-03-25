/**
 * Filter Store — single source of truth for all dashboard filter state.
 *
 * Components that control filters call store.update({ key: value }).
 * queries.js subscribes to the store and re-runs affected DuckDB queries.
 * Components never query or re-render directly — they subscribe to query signals.
 */

const DEFAULTS = {
  threat: "all",     // "all" | "1" | "2" | "10"
  zone: "all",       // "all" | zone name (English)
  city: null,        // null | city name (Hebrew — matches geojson/parquet keys)
  ctx: "country",    // "country" | "zone" | "city" (data filtering scope)
  mapCtx: "country", // "country" | "zone" | "city" (map visualization scope)
  startMs: null,     // null = full range | UTC epoch ms
  endMs: null,       // null = full range | UTC epoch ms
};

let state = { ...DEFAULTS };
const subscribers = new Set();

/**
 * Get a shallow copy of the current filter state.
 */
export function getState() {
  return { ...state };
}

/**
 * Get default filter values (for reset).
 */
export function getDefaults() {
  return { ...DEFAULTS };
}

/**
 * Update one or more filter keys.
 * Only changed keys trigger a notification.
 * Returns the set of keys that actually changed.
 */
export function update(filters) {
  const changed = new Set();
  for (const [key, val] of Object.entries(filters)) {
    if (!(key in DEFAULTS)) continue;
    if (state[key] !== val) {
      changed.add(key);
      state[key] = val;
    }
  }
  if (changed.size > 0) {
    notify(changed);
  }
  return changed;
}

/**
 * Reset all filters to defaults.
 */
export function reset() {
  const changed = new Set();
  for (const key of Object.keys(DEFAULTS)) {
    if (state[key] !== DEFAULTS[key]) {
      changed.add(key);
    }
  }
  state = { ...DEFAULTS };
  if (changed.size > 0) {
    notify(changed);
  }
  return changed;
}

/**
 * Subscribe to state changes.
 * Callback receives (newState, changedKeys).
 * Returns an unsubscribe function.
 */
export function subscribe(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function notify(changed) {
  const snapshot = { ...state };
  for (const listener of subscribers) {
    listener(snapshot, changed);
  }
}
