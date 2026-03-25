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
    const currentStart = isFullRange ? minDate : utcMsToIsraelDate(state.startMs);
    const currentEnd = isFullRange ? maxDate : utcMsToIsraelDate(state.endMs);

    let dayStart, dayEnd;
    if (isFullRange) {
      if (direction === 1) {
        dayStart = d3.timeDay(minDate);
        dayEnd = d3.timeDay.offset(dayStart, 1);
      } else {
        dayEnd = d3.timeDay.ceil(maxDate);
        dayStart = d3.timeDay.offset(dayEnd, -1);
      }
    } else {
      dayStart = d3.timeDay.offset(d3.timeDay(currentStart), direction);
      dayEnd = d3.timeDay.offset(d3.timeDay(currentEnd), direction);
    }

    let lowHour = dateToSlider(dayStart);
    let highHour = dateToSlider(dayEnd);
    if (lowHour < 0) { lowHour = 0; highHour = Math.min(24, totalHours); }
    if (highHour > totalHours) { highHour = totalHours; lowHour = Math.max(highHour - 24, 0); }

    store.update({
      startMs: sliderToUtcMs(lowHour),
      endMs: sliderToUtcMs(highHour),
    });
  }

  document.getElementById("step-prev")?.addEventListener("click", () => stepDay(-1));
  document.getElementById("step-next")?.addEventListener("click", () => stepDay(1));

  // Step buttons — hour
  function stepHour(direction) {
    const state = store.getState();
    const isFullRange = state.startMs == null && state.endMs == null;
    const low = isFullRange ? 0 : Math.max(0, dateToSlider(utcMsToIsraelDate(state.startMs)));
    const high = isFullRange ? totalHours : Math.min(totalHours, dateToSlider(utcMsToIsraelDate(state.endMs)));
    const span = high - low;

    let newLow, newHigh;
    if (isFullRange) {
      if (direction === 1) {
        newLow = 0;
        newHigh = Math.min(1, totalHours);
      } else {
        newHigh = totalHours;
        newLow = Math.max(totalHours - 1, 0);
      }
    } else {
      newLow = low + direction;
      newHigh = high + direction;
      if (newLow < 0) { newLow = 0; newHigh = Math.min(span, totalHours); }
      if (newHigh > totalHours) { newHigh = totalHours; newLow = Math.max(totalHours - span, 0); }
    }

    store.update({
      startMs: sliderToUtcMs(newLow),
      endMs: sliderToUtcMs(newHigh),
    });
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
