/**
 * Quiet periods — compute longest gaps and quietest hours from alert events.
 *
 * Pure computation functions + initQuietPeriods() which subscribes to the
 * filteredAlertEvents signal, updates the DOM, and wires click-to-highlight.
 */

import { t } from "./i18n.js";
import { onSignal } from "./queries.js";
import * as slider from "./slider.js";
import { israelTimeHHMM, israelDateDM, israelDayStartUtc } from "./tz.js";

const _hFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Jerusalem" });
const _mFmt = new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: "Asia/Jerusalem" });

function israelMinuteOfDay(date) {
  return +_hFmt.format(date) * 60 + +_mFmt.format(date);
}

/**
 * Find the longest gap (quiet period) between merged alert intervals.
 * @param {Array} eventsArr - alert events with _start and _end
 * @param {Date|number} from - start of analysis window
 * @param {Date|number} to - end of analysis window
 * @param {object} [options]
 * @param {boolean} [options.fromFirstAlert=false] - if true, skip gap before first alert
 * @returns {{ ms: number, start: number|null, end: number|null }}
 */
export function longestGap(eventsArr, from, to, { fromFirstAlert = false } = {}) {
  // Build intervals [start, end] for each alert
  const intervals = eventsArr
    .filter((d) => d._start <= to && +d._end >= +from)
    .map((d) => [+d._start, +d._end])
    .sort((a, b) => a[0] - b[0]);
  if (intervals.length === 0) {
    if (fromFirstAlert) return { ms: 0, start: null, end: null };
    return { ms: +to - +from, start: +from, end: +to };
  }
  // Merge overlapping intervals to find covered periods
  const merged = [intervals[0].slice()];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) {
      last[1] = Math.max(last[1], intervals[i][1]);
    } else {
      merged.push(intervals[i].slice());
    }
  }
  // Find longest gap between merged intervals
  let max = 0, gapStart = null, gapEnd = null;
  // Gap before first interval (skip if starting from first alert)
  if (!fromFirstAlert) {
    const headGap = merged[0][0] - +from;
    if (headGap > max) { max = headGap; gapStart = +from; gapEnd = merged[0][0]; }
  }
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i][0] - merged[i - 1][1];
    if (gap > max) { max = gap; gapStart = merged[i - 1][1]; gapEnd = merged[i][0]; }
  }
  // Gap after last interval
  const tailGap = +to - merged[merged.length - 1][1];
  if (tailGap > max) { max = tailGap; gapStart = merged[merged.length - 1][1]; gapEnd = +to; }
  return { ms: max, start: gapStart, end: gapEnd };
}

/**
 * Find the quietest hour-of-day window by projecting all alerts onto a 24h clock.
 * @param {Array} eventsArr - alert events with _start and _end
 * @param {Date|number} from - start of analysis window
 * @param {Date|number} to - end of analysis window
 * @returns {{ startH, startM, endH, endM, minutes }|null}
 */
export function quietestHour(eventsArr, from, to) {
  // Project all alerts onto a single 24h window [0..1440) in minutes, merge, find longest gap
  const MINS = 1440;
  const covered = new Uint8Array(MINS); // 1 = alert active in this minute
  for (const d of eventsArr) {
    const s = +d._start, e = +d._end;
    if (s > +to || e < +from) continue;
    // Clamp to [from, to]
    const cs = Math.max(s, +from), ce = Math.min(e, +to);
    // Project onto 24h: use Israel hour/minute of start and end
    let sm = israelMinuteOfDay(new Date(cs));
    let em = israelMinuteOfDay(new Date(ce));
    // If event spans within one day or we just mark its time-of-day footprint
    if (em <= sm) em = sm + 1; // at minimum, mark 1 minute
    for (let m = sm; m < Math.min(em, MINS); m++) covered[m] = 1;
  }
  // Find longest uncovered stretch (wrapping around midnight)
  // Double the array to handle wrap-around
  let maxLen = 0, bestStart = 0;
  let run = 0, runStart = 0;
  for (let i = 0; i < MINS * 2; i++) {
    if (covered[i % MINS] === 0) {
      if (run === 0) runStart = i % MINS;
      run++;
      if (run > maxLen && run <= MINS) { maxLen = run; bestStart = runStart; }
    } else {
      run = 0;
    }
  }
  if (maxLen === 0) return null;
  const sh = Math.floor(bestStart / 60), sm = bestStart % 60;
  const endMin = (bestStart + maxLen) % MINS;
  const eh = Math.floor(endMin / 60), em = endMin % 60;
  return { startH: sh, startM: sm, endH: eh, endM: em, minutes: maxLen };
}

/**
 * Format a duration in ms as a human-readable string (e.g. "2h 30m", "3d 5h").
 */
const RLM = "\u200f", SP = "\u2002";

export function formatDuration(ms) {
  const H = t("duration.h"), M = t("duration.m");
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${RLM}${h} ${H}${SP}${m} ${M}` : `${RLM}${m} ${M}`;
}

/**
 * Format a gap's time range as a string (e.g. "14:30–18:00" or "12/3 14:30–13/3 08:00").
 * Uses Israel timezone for all formatting.
 */
export function formatGapRange(gap) {
  if (!gap || !gap.ms) return "";
  const sameDay = israelDayStartUtc(gap.start) === israelDayStartUtc(gap.end);
  if (sameDay) return `${israelTimeHHMM(gap.start)}–${israelTimeHHMM(gap.end)}`;
  return `${israelDateDM(gap.start)} ${israelTimeHHMM(gap.start)}–${israelDateDM(gap.end)} ${israelTimeHHMM(gap.end)}`;
}

/**
 * Format a quietestHour result as { range, dur } strings.
 */
export function formatQuietestRange(q) {
  if (!q) return { range: "—", dur: "" };
  const H = t("duration.h"), M = t("duration.m");
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(q.minutes / 60), m = q.minutes % 60;
  const dur = h > 0 ? `${RLM}${h} ${H}${m > 0 ? `${SP}${m} ${M}` : ""}` : `${RLM}${m} ${M}`;
  return { range: `${pad(q.startH)}:${pad(q.startM)}–${pad(q.endH)}:${pad(q.endM)}`, dur };
}

// ── DOM integration ──

/**
 * Initialize quiet periods: subscribe to filteredAlertEvents, update DOM,
 * and wire click-to-highlight on the timeline.
 *
 * @param {{ highlightGap: Function, highlightHourRange: Function }} timelineHighlight
 */
export function initQuietPeriods(timelineHighlight) {
  const quietPeriodIds = ["stat-quiet-today", "stat-quiet-3d", "stat-quiet-7d", "stat-quiet-all"];
  const quietestHourIds = ["stat-quietest-3d", "stat-quietest-7d", "stat-quietest-all"];
  const allIds = [...quietPeriodIds, ...quietestHourIds];

  const activeClasses = ["bg-emerald-900/40", "ring-1", "ring-emerald-500/30"];

  function clearAllHighlights() {
    for (const id of allIds) {
      const element = document.getElementById(id);
      if (element) element.classList.remove(...activeClasses);
    }
    timelineHighlight.highlightGap(null, null);
  }

  // Wire click-to-highlight on quiet period rows
  for (const id of quietPeriodIds) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.classList.add("cursor-pointer", "rounded", "px-1", "-mx-1", "transition-colors", "hover:bg-gray-800");
    element.addEventListener("click", () => {
      const gapStart = +element.dataset.gapStart;
      const gapEnd = +element.dataset.gapEnd;
      if (!gapStart || !gapEnd) return;
      const wasActive = element.classList.contains(activeClasses[0]);
      clearAllHighlights();
      if (!wasActive) {
        element.classList.add(...activeClasses);
        timelineHighlight.highlightGap(gapStart, gapEnd);
      }
    });
  }

  // Wire click-to-highlight on quietest hour rows
  for (const id of quietestHourIds) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.classList.add("cursor-pointer", "rounded", "px-1", "-mx-1", "transition-colors", "hover:bg-gray-800");
    element.addEventListener("click", () => {
      const startMinute = element.dataset.startMin;
      const endMinute = element.dataset.endMin;
      if (startMinute === "" || endMinute === "") return;
      const wasActive = element.classList.contains(activeClasses[0]);
      clearAllHighlights();
      if (!wasActive) {
        element.classList.add(...activeClasses);
        timelineHighlight.highlightHourRange(+startMinute, +endMinute, new Date(+element.dataset.fromDay), new Date(+element.dataset.toDay));
      }
    });
  }

  // Subscribe to filteredAlertEvents and update quiet period DOM
  onSignal("filteredAlertEvents", (events) => {
    const now = new Date();
    const todayStartMs = israelDayStartUtc(+now);
    const todayStart = new Date(todayStartMs);
    const threeDaysAgo = new Date(israelDayStartUtc(todayStartMs - 3 * 86400000));
    const sevenDaysAgo = new Date(israelDayStartUtc(todayStartMs - 7 * 86400000));
    const minDate = new Date(slider.getMinMs() || todayStartMs);

    // Longest quiet periods
    const gapToday = longestGap(events, todayStart, now);
    const gap3days = longestGap(events, threeDaysAgo, now);
    const gap7days = longestGap(events, sevenDaysAgo, now);
    const gapAllTime = longestGap(events, minDate, now, { fromFirstAlert: true });

    updateQuietPeriodElement("stat-quiet-today", gapToday);
    updateQuietPeriodElement("stat-quiet-3d", gap3days);
    updateQuietPeriodElement("stat-quiet-7d", gap7days);
    updateQuietPeriodElement("stat-quiet-all", gapAllTime);

    // Quietest hours
    const quietest3days = quietestHour(events, threeDaysAgo, todayStart);
    const quietest7days = quietestHour(events, sevenDaysAgo, todayStart);
    const quietestAllTime = quietestHour(events, minDate, todayStart);

    updateQuietestHourElement("stat-quietest-3d", quietest3days, threeDaysAgo, todayStart);
    updateQuietestHourElement("stat-quietest-7d", quietest7days, sevenDaysAgo, todayStart);
    updateQuietestHourElement("stat-quietest-all", quietestAllTime, minDate, todayStart);

    clearAllHighlights();
  });
}

function updateQuietPeriodElement(elementId, gapResult) {
  const container = document.getElementById(elementId);
  if (!container) return;
  const durationElement = container.querySelector('[data-field="dur"]');
  const rangeElement = container.querySelector('[data-field="range"]');
  if (durationElement) durationElement.textContent = formatDuration(gapResult.ms);
  if (rangeElement) rangeElement.textContent = formatGapRange(gapResult);
  container.dataset.gapStart = gapResult.start;
  container.dataset.gapEnd = gapResult.end;
}

function updateQuietestHourElement(elementId, quietestResult, fromDate, toDate) {
  const container = document.getElementById(elementId);
  if (!container) return;
  const formatted = formatQuietestRange(quietestResult);
  const rangeElement = container.querySelector('[data-field="range"]');
  const durationElement = container.querySelector('[data-field="dur"]');
  if (rangeElement) rangeElement.textContent = formatted.range;
  if (durationElement) durationElement.textContent = formatted.dur;
  container.dataset.startMin = quietestResult ? quietestResult.startH * 60 + quietestResult.startM : "";
  container.dataset.endMin = quietestResult ? (quietestResult.startH * 60 + quietestResult.startM + quietestResult.minutes) % 1440 : "";
  container.dataset.fromDay = +fromDate;
  container.dataset.toDay = +toDate;
}
