/**
 * Time slider — dual-range input with sparkline overlay.
 *
 * Subscribes to hourlySparkline signal for the area chart.
 * Writes to store when the slider or step buttons change.
 */

import * as d3 from "d3";
import * as store from "./store.js";
import { onSignal } from "./queries.js";
import { t, formatDateTime } from "./i18n.js";
import { showTooltip, hideTooltip } from "./tooltip.js";

let minDate = null;
let maxDate = null;
let totalHours = 0;
let xScale = null;
let yScale = null;
let areaGenerator = null;
let sparkPath = null;
let sparkContainer = null;

/**
 * Initialize the slider with the time bounds from snapshot.
 * Must be called before DuckDB is ready (uses snapshot data).
 */
export function init(snapshotMinMs, snapshotMaxMs) {
  minDate = toIsraelTime(new Date(snapshotMinMs));
  maxDate = toIsraelTime(new Date(Math.max(snapshotMaxMs, Date.now())));
  totalHours = Math.ceil((maxDate - minDate) / 3600000);

  sparkContainer = document.getElementById("sparkline");
  const sparkWidth = sparkContainer.clientWidth;
  const sparkHeight = 40;
  const thumbRadius = 7;

  const sparkSvg = d3.select(sparkContainer).append("svg")
    .attr("width", sparkWidth).attr("height", sparkHeight);

  xScale = d3.scaleTime().domain([minDate, maxDate]).range([thumbRadius, sparkWidth - thumbRadius]);
  yScale = d3.scaleLinear().range([sparkHeight, 0]);

  areaGenerator = d3.area()
    .x((dataPoint) => xScale(dataPoint.date))
    .y0(sparkHeight)
    .y1((dataPoint) => yScale(dataPoint.count))
    .curve(d3.curveMonotoneX);

  // Date gridlines
  const days = d3.timeDay.range(d3.timeDay.ceil(minDate), maxDate);
  sparkSvg.selectAll(".gridline")
    .data(days)
    .join("line")
    .attr("class", "gridline")
    .attr("x1", (day) => xScale(day))
    .attr("x2", (day) => xScale(day))
    .attr("y1", 0)
    .attr("y2", sparkHeight)
    .attr("stroke", "#334155")
    .attr("stroke-width", 0.5)
    .attr("stroke-dasharray", "2,2");

  sparkPath = sparkSvg.append("path")
    .attr("fill", "#6366f1")
    .attr("fill-opacity", 0.2)
    .attr("stroke", "#6366f1")
    .attr("stroke-width", 1);

  // Hover crosshair
  const hoverLine = sparkSvg.append("line")
    .attr("y1", 0).attr("y2", sparkHeight)
    .attr("stroke", "#94a3b8").attr("stroke-width", 0.5)
    .style("display", "none");

  sparkSvg.append("rect")
    .attr("width", sparkWidth).attr("height", sparkHeight)
    .attr("fill", "none")
    .attr("pointer-events", "all")
    .on("mousemove", (event) => {
      const [mouseX] = d3.pointer(event);
      const date = xScale.invert(mouseX);
      const hour = d3.timeHour(date);
      const data = sparkPath.datum();
      const match = data?.find((dataPoint) => +dataPoint.date === +hour);
      hoverLine.attr("x1", mouseX).attr("x2", mouseX).style("display", null);
      showTooltip(event.pageX, event.pageY, `<strong>${formatDateTime(+hour - israelOffset())}</strong><br>${d3.format(",")(match?.count || 0)} ${t("map.alerts")}`);
    })
    .on("mouseleave", () => {
      hoverLine.style("display", "none");
      hideTooltip();
    });

  // Range slider setup
  const rangeMin = document.getElementById("range-min");
  const rangeMax = document.getElementById("range-max");
  const highlight = document.getElementById("range-highlight");
  const startLabel = document.getElementById("slider-start");
  const endLabel = document.getElementById("slider-end");

  rangeMin.max = rangeMax.max = totalHours;

  // ── Rendering: driven entirely by store state ──

  function renderSlider(state) {
    const lowHour = state.startMs != null ? Math.max(0, dateToSlider(utcMsToIsraelDate(state.startMs))) : 0;
    const highHour = state.endMs != null ? Math.min(totalHours, dateToSlider(utcMsToIsraelDate(state.endMs))) : totalHours;

    rangeMin.value = lowHour;
    rangeMax.value = highHour;

    const startMs = state.startMs ?? snapshotMinMs;
    const endMs = state.endMs ?? Math.max(snapshotMaxMs, Date.now());
    startLabel.textContent = formatDateTime(startMs);
    endLabel.textContent = formatDateTime(endMs);

    const trackWidth = sparkWidth - 2 * thumbRadius;
    const lowPixel = thumbRadius + (lowHour / totalHours) * trackWidth;
    const highPixel = thumbRadius + (highHour / totalHours) * trackWidth;
    highlight.style.insetInlineStart = `${lowPixel}px`;
    highlight.style.width = `${highPixel - lowPixel}px`;
  }

  // Initial render
  renderSlider(store.getState());

  // Re-render when store changes
  store.subscribe((state, changedKeys) => {
    if (changedKeys.has("startMs") || changedKeys.has("endMs")) {
      renderSlider(state);
    }
  });

  // ── User interactions: compute new values, update store ──

  function commitSliderValues() {
    let low = +rangeMin.value;
    let high = +rangeMax.value;
    if (low > high) { low = high; rangeMin.value = low; }
    const isFullRange = low === 0 && high === totalHours;
    store.update({
      startMs: isFullRange ? null : sliderToUtcMs(low),
      endMs: isFullRange ? null : sliderToUtcMs(high),
    });
  }

  // Live preview while dragging (updates labels + highlight without committing to store)
  function onSliderDrag() {
    let low = +rangeMin.value;
    let high = +rangeMax.value;
    if (low > high) { low = high; rangeMin.value = low; }
    startLabel.textContent = formatDateTime(sliderToUtcMs(low));
    endLabel.textContent = formatDateTime(sliderToUtcMs(high));
    const trackWidth = sparkWidth - 2 * thumbRadius;
    const lowPixel = thumbRadius + (low / totalHours) * trackWidth;
    const highPixel = thumbRadius + (high / totalHours) * trackWidth;
    highlight.style.insetInlineStart = `${lowPixel}px`;
    highlight.style.width = `${highPixel - lowPixel}px`;
  }

  rangeMin.addEventListener("input", onSliderDrag);
  rangeMax.addEventListener("input", onSliderDrag);
  rangeMin.addEventListener("change", commitSliderValues);
  rangeMax.addEventListener("change", commitSliderValues);

  // Step buttons — day
  function stepDay(direction) {
    const state = store.getState();
    const isFullRange = state.startMs == null && state.endMs == null;
    const DAY_MS = 86400000;

    let newStartMs, newEndMs;
    if (isFullRange) {
      if (direction === 1) {
        newStartMs = _snapshotMinMs;
        newEndMs = _snapshotMinMs + DAY_MS;
      } else {
        newEndMs = Math.max(_snapshotMaxMs, Date.now());
        newStartMs = newEndMs - DAY_MS;
      }
    } else {
      const span = state.endMs - state.startMs;
      newStartMs = state.startMs + direction * DAY_MS;
      newEndMs = newStartMs + span;
    }

    // Clamp to bounds
    const boundsMin = _snapshotMinMs;
    const boundsMax = Math.max(_snapshotMaxMs, Date.now());
    if (newStartMs < boundsMin) { newStartMs = boundsMin; newEndMs = newStartMs + (state.endMs - state.startMs || DAY_MS); }
    if (newEndMs > boundsMax) { newEndMs = boundsMax; newStartMs = Math.max(boundsMin, newEndMs - (state.endMs - state.startMs || DAY_MS)); }

    store.update({ startMs: newStartMs, endMs: newEndMs });
  }

  document.getElementById("step-prev")?.addEventListener("click", () => stepDay(-1));
  document.getElementById("step-next")?.addEventListener("click", () => stepDay(1));

  // Step buttons — hour
  function stepHour(direction) {
    const state = store.getState();
    const isFullRange = state.startMs == null && state.endMs == null;
    const HOUR_MS = 3600000;

    let newStartMs, newEndMs;
    if (isFullRange) {
      if (direction === 1) {
        newStartMs = _snapshotMinMs;
        newEndMs = _snapshotMinMs + HOUR_MS;
      } else {
        newEndMs = Math.max(_snapshotMaxMs, Date.now());
        newStartMs = newEndMs - HOUR_MS;
      }
    } else {
      const span = state.endMs - state.startMs;
      newStartMs = state.startMs + direction * HOUR_MS;
      newEndMs = newStartMs + span;
    }

    // Clamp to bounds
    const boundsMin = _snapshotMinMs;
    const boundsMax = Math.max(_snapshotMaxMs, Date.now());
    if (newStartMs < boundsMin) { newStartMs = boundsMin; newEndMs = newStartMs + (state.endMs - state.startMs || HOUR_MS); }
    if (newEndMs > boundsMax) { newEndMs = boundsMax; newStartMs = Math.max(boundsMin, newEndMs - (state.endMs - state.startMs || HOUR_MS)); }

    store.update({ startMs: newStartMs, endMs: newEndMs });
  }

  document.getElementById("step-prev-hr")?.addEventListener("click", () => stepHour(-1));
  document.getElementById("step-next-hr")?.addEventListener("click", () => stepHour(1));

  // Subscribe to sparkline signal
  onSignal("hourlySparkline", (sparkData) => {
    renderSparkline(sparkData);
  });
}

/**
 * Render sparkline from snapshot data (before DuckDB is ready).
 */
export function renderFromSnapshot(sparklineData) {
  if (!sparkPath || !minDate) return;
  const offset = israelOffset();
  const sparkMap = new Map(sparklineData.map(([epochMs, count]) => [epochMs + offset, count]));
  renderSparklineFromMap(sparkMap);
}

// ── Internal helpers ──

function renderSparkline(sparkData) {
  const offset = israelOffset();
  const sparkMap = new Map(sparkData.map((dataPoint) => [dataPoint.hour + offset, dataPoint.count]));
  renderSparklineFromMap(sparkMap);
}

function renderSparklineFromMap(sparkMap) {
  const allHours = d3.timeHour.range(d3.timeHour(minDate), d3.timeHour.offset(maxDate, 1));
  const hourlyData = allHours.map((date) => ({ date, count: sparkMap.get(+date) || 0 }));
  yScale.domain([0, d3.max(hourlyData, (dataPoint) => dataPoint.count) || 1]);
  sparkPath.datum(hourlyData).attr("d", areaGenerator);
}

/**
 * Convert a UTC Date to a "fake-local" Date whose local fields show Israel time.
 */
function toIsraelTime(utcDate) {
  const israelString = utcDate.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" });
  return new Date(israelString);
}

function utcMsToIsraelDate(utcMs) {
  return toIsraelTime(new Date(utcMs));
}

/**
 * Israel-to-UTC offset in ms (same as israelOffsetMs, used internally for sparkline).
 * NOTE: This uses a single offset and does not handle DST transitions.
 * Full DST handling is deferred to a later phase.
 */
function israelOffset() {
  return minDate.getTime() - _snapshotMinMs;
}

/**
 * Get the Israel fake-local minDate (for heatmap/quiet period computation).
 */
export function getMinDate() {
  return minDate;
}

// Recompute from minDate each time to be explicit
export function israelOffsetMs() {
  // The offset used in main.js: minDate.getTime() - minTs
  // minDate is toIsraelTime(new Date(minTs)), so offset = toIsraelTime(minTs).getTime() - minTs
  return minDate.getTime() - _snapshotMinMs;
}

let _snapshotMinMs = 0;
let _snapshotMaxMs = 0;

export function setSnapshotMinMs(minMs) {
  _snapshotMinMs = minMs;
}

export function setSnapshotMaxMs(maxMs) {
  _snapshotMaxMs = maxMs;
}

/**
 * Get the full time bounds (UTC epoch ms) for the time range chip.
 */
export function getTimeBounds() {
  return { minMs: _snapshotMinMs, maxMs: _snapshotMaxMs || Date.now() };
}

function sliderToDate(sliderValue) {
  return new Date(minDate.getTime() + sliderValue * 3600000);
}

function sliderToUtcMs(sliderValue) {
  return +sliderToDate(sliderValue) - israelOffsetMs();
}

function dateToSlider(date) {
  return Math.round((date - minDate) / 3600000);
}
