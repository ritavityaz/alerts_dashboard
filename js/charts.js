import * as d3 from "d3";
import { t, formatNumber } from "./i18n.js";
import { showTooltip, hideTooltip } from "./tooltip.js";
import { onSignal } from "./queries.js";
import * as store from "./store.js";
import { queryEventsByCityInZone } from "./db.js";

const threatColors = {
  "1": "#ef4444",   // missiles
  "2": "#8b5cf6",   // drones
  "10": "#f59e0b",  // infiltrations
};

const threatI18nKeys = {
  "1": "timeline.missiles",
  "2": "timeline.drones",
  "10": "timeline.infiltration",
};

const CATEGORIES = ["1", "2", "10"];

/**
 * Merge overlapping intervals and return total covered duration in ms.
 */
function mergedDuration(intervals) {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i].slice());
    }
  }
  return merged.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/**
 * Build stacked duration data from raw event rows.
 * Groups by nameKey, splits by category, merges overlapping intervals per category,
 * then builds stacked segments with duration in minutes.
 * @param {Array} rows - [{nameKey, category, start_ms, end_ms}, ...]
 * @param {string} nameKey - "zone" or "city"
 * @param {string} [metaKey] - optional metadata key (e.g. "cities")
 */
function buildDurationStacked(rows, nameKey, metaKey) {
  // Group by name -> category -> list of [start, end] intervals
  const byName = new Map();
  const metaByName = new Map();
  for (const r of rows) {
    const name = r[nameKey];
    if (!byName.has(name)) byName.set(name, new Map());
    const byCat = byName.get(name);
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push([r.start_ms, r.end_ms]);
    if (metaKey && !metaByName.has(name)) metaByName.set(name, r[metaKey]);
  }

  // Also compute total duration (all categories merged together) for sorting
  const totalByName = new Map();
  for (const [name, byCat] of byName) {
    const allIntervals = [];
    for (const intervals of byCat.values()) allIntervals.push(...intervals);
    totalByName.set(name, mergedDuration(allIntervals));
  }

  // Sort names by total duration descending
  const names = [...byName.keys()].sort((a, b) => totalByName.get(b) - totalByName.get(a));

  return names.map((name) => {
    const byCat = byName.get(name);
    const totalMs = totalByName.get(name);
    const totalMin = Math.round(totalMs / 60000);

    // Compute each category's merged duration (for proportional display)
    const catDurations = CATEGORIES.map((cat) => ({
      cat,
      ms: mergedDuration(byCat.get(cat) || []),
    })).filter((d) => d.ms > 0);

    // Scale category durations proportionally so they sum to the merged total
    const rawSum = catDurations.reduce((s, d) => s + d.ms, 0);
    const scale = rawSum > 0 ? totalMs / rawSum : 0;
    let x0 = 0;
    const segments = catDurations.map((d) => {
      const durationMin = Math.round((d.ms * scale) / 60000);
      const seg = { cat: d.cat, count: durationMin, x0, x1: x0 + durationMin, name };
      x0 += durationMin;
      return seg;
    });

    return { name, segments, total: totalMin, meta: metaByName.get(name) || null };
  });
}

function fmtDurationShort(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  }
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Daily histogram — vertical bars, one per day.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} opts.yLabel - axis label
 * @param {function} opts.yFormat - tick formatter for y axis
 * @param {string} opts.color - bar fill color
 * @param {function} opts.tooltipFmt - (d) => tooltip HTML
 */
export function createDailyHistogram(container, { yFormat, tooltipFmt, signalName = null, mapData = null }) {
  const margin = { top: 8, right: 12, bottom: 32, left: 48 };
  const cats = CATEGORIES; // ["1", "2", "10"]

  const svg = d3.select(container).append("svg").style("width", "100%");
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const xAxisG = g.append("g");
  const yAxisG = g.append("g");
  const barsG = g.append("g");
  // Invisible hit rects on top for tooltips
  const hitG = g.append("g");

  function update(data) {
    // data: [{day_ms, byCategory: {"1": n, "2": n, "10": n}}]
    if (!data || data.length === 0) {
      svg.attr("height", 0);
      return;
    }

    // Fill gaps so every day in the range has a bar
    const byDay = new Map(data.map((d) => [d.day_ms, d.byCategory]));
    const minDay = data[0].day_ms;
    const maxDay = data[data.length - 1].day_ms;
    const filled = [];
    for (let d = minDay; d <= maxDay; d += 86400000) {
      filled.push({ day_ms: d, byCategory: byDay.get(d) || {} });
    }
    data = filled;

    // Compute totals and stacked segments per day
    for (const d of data) {
      d.total = cats.reduce((sum, cat) => sum + (d.byCategory[cat] || 0), 0);
      let y0 = 0;
      d.segments = cats.map((cat) => {
        const val = d.byCategory[cat] || 0;
        const seg = { cat, value: val, y0, y1: y0 + val, day_ms: d.day_ms };
        y0 += val;
        return seg;
      }).filter((s) => s.value > 0);
    }

    const w = container.clientWidth || 300;
    const height = 200;
    const innerW = w - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr("width", w).attr("height", height);

    const x = d3.scaleBand()
      .domain(data.map((d) => d.day_ms))
      .range([0, innerW])
      .padding(0.15);

    const y = d3.scaleLinear()
      .domain([0, d3.max(data, (d) => d.total) || 1])
      .range([innerH, 0])
      .nice();

    const dayFmt = d3.timeFormat("%-d/%m");

    // X axis — show ~8-12 labels max
    const tickEvery = Math.max(1, Math.floor(data.length / 10));
    const tickValues = data.filter((_, i) => i % tickEvery === 0).map((d) => d.day_ms);

    xAxisG
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickValues(tickValues).tickFormat((d) => dayFmt(new Date(d))).tickSize(0))
      .call((g) => g.select(".domain").attr("stroke", "#334155"))
      .call((g) => g.selectAll(".tick text").attr("fill", "#64748b").attr("font-size", "9px")
        .attr("text-anchor", "end").attr("transform", "rotate(-40)").attr("dx", "-4").attr("dy", "4"));

    yAxisG
      .call(d3.axisLeft(y).ticks(5).tickFormat(yFormat || d3.format(",")).tickSize(-innerW))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll(".tick line").attr("stroke", "#1e293b"))
      .call((g) => g.selectAll(".tick text").attr("fill", "#64748b").attr("font-size", "10px"));

    // Stacked segments
    const allSegs = data.flatMap((d) => d.segments);
    barsG.selectAll("rect")
      .data(allSegs, (d) => `${d.day_ms}-${d.cat}`)
      .join("rect")
      .attr("x", (d) => x(d.day_ms))
      .attr("width", x.bandwidth())
      .attr("y", (d) => y(d.y1))
      .attr("height", (d) => Math.max(0, y(d.y0) - y(d.y1)))
      .attr("fill", (d) => threatColors[d.cat] || "#6366f1")
      .attr("rx", 1);

    // Invisible hit rects for whole-bar tooltips
    hitG.selectAll("rect")
      .data(data, (d) => d.day_ms)
      .join("rect")
      .attr("x", (d) => x(d.day_ms))
      .attr("width", x.bandwidth())
      .attr("y", 0)
      .attr("height", innerH)
      .attr("fill", "transparent")
      .on("mousemove", (event, d) => {
        showTooltip(event.pageX, event.pageY, tooltipFmt(d));
      })
      .on("mouseleave", () => hideTooltip());
  }

  if (signalName) {
    onSignal(signalName, (data) => {
      update(data);
    });
  }

  return { update };
}

/**
 * Stacked horizontal bar chart — zones on Y axis, alert duration on X, stacked by threat.
 * Click a zone row to expand into per-city breakdown.
 * @param {HTMLElement} container
 * @param {function} fetchCityEvents - async (zone) => [{city, category, start_ms, end_ms}, ...]
 * @param {function} displayName - (rawName) => localized display string
 */
export function createZoneDurationChart(container, { fetchCityEvents = null, displayName = (name) => name } = {}) {
  // Default fetchCityEvents uses db.js + store directly
  if (!fetchCityEvents) {
    fetchCityEvents = (zone) => queryEventsByCityInZone(zone, store.getState().startMs, store.getState().endMs);
  }
  const margin = { top: 8, right: 72, bottom: 28, left: 140 };
  const zoneRowH = 24;
  const cityRowH = 20;

  const svg = d3.select(container).append("svg");
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const xAxisG = g.append("g");
  const barsG = g.append("g");
  const labelsG = g.append("g");

  const expanded = new Map();

  function render(zoneStacked) {
    const flatRows = [];
    for (const zd of zoneStacked) {
      const isExpanded = expanded.has(zd.name);
      const cityCount = zd.meta || 0;
      const suffix = cityCount > 0 ? ` (${cityCount})` : "";
      flatRows.push({ type: "zone", key: zd.name, rawName: zd.name, label: displayName(zd.name) + suffix, segments: zd.segments, total: zd.total });
      if (isExpanded) {
        for (const cd of expanded.get(zd.name)) {
          flatRows.push({ type: "city", key: `${zd.name}/${cd.name}`, rawName: cd.name, label: displayName(cd.name), segments: cd.segments, total: cd.total, zone: zd.name });
        }
      }
    }

    const w = container.clientWidth || 500;
    const innerH = flatRows.reduce((h, r) => h + (r.type === "zone" ? zoneRowH : cityRowH), 0);
    const height = margin.top + innerH + margin.bottom;
    const innerW = w - margin.left - margin.right;

    svg.attr("width", w).attr("height", height);

    let yPos = 0;
    for (const r of flatRows) {
      r.y = yPos;
      r.h = r.type === "zone" ? zoneRowH : cityRowH;
      yPos += r.h;
    }

    const maxTotal = d3.max(zoneStacked, (d) => d.total) || 1;
    const x = d3.scaleLinear().domain([0, maxTotal * 1.03]).range([0, innerW]).nice();

    xAxisG
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat((d) => fmtDurationShort(d)).tickSize(-innerH))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll(".tick line").attr("stroke", "#1e293b"))
      .call((g) => g.selectAll(".tick text").attr("fill", "#64748b").attr("font-size", "10px"));

    const labelPad = 0.15;
    labelsG.selectAll(".row-label")
      .data(flatRows, (d) => d.key)
      .join("foreignObject")
      .attr("class", "row-label")
      .attr("x", -margin.left)
      .attr("y", (d) => d.y)
      .attr("width", margin.left - 6)
      .attr("height", (d) => d.h)
      .each(function (d) {
        const fo = d3.select(this);
        fo.selectAll("div").remove();
        fo.append("xhtml:div")
          .style("width", "100%")
          .style("height", d.h + "px")
          .style("line-height", d.h + "px")
          .style("text-align", "right")
          .style("color", d.type === "city" ? "#64748b" : "#94a3b8")
          .style("font-size", d.type === "city" ? "10px" : "11px")
          .style("font-weight", d.type === "zone" ? "500" : "normal")
          .style("overflow", "hidden")
          .style("text-overflow", "ellipsis")
          .style("white-space", "nowrap")
          .text(d.label);
      });

    const allSegs = flatRows.flatMap((r) =>
      r.segments.map((s) => ({ ...s, rowKey: r.key, rowY: r.y, rowH: r.h, rowType: r.type }))
    );
    const barPad = (d) => d.rowH * labelPad / 2;

    barsG.selectAll(".seg")
      .data(allSegs, (d) => d.rowKey + d.cat)
      .join("rect")
      .attr("class", "seg")
      .attr("x", (d) => x(d.x0))
      .attr("width", (d) => Math.max(0, x(d.x1) - x(d.x0)))
      .attr("y", (d) => d.rowY + barPad(d))
      .attr("height", (d) => d.rowH - barPad(d) * 2)
      .attr("fill", (d) => threatColors[d.cat])
      .attr("fill-opacity", (d) => d.rowType === "city" ? 0.6 : 0.8)
      .attr("rx", 1)
      .on("mousemove", (event, d) => {
        showTooltip(event.pageX, event.pageY,
          `<strong>${displayName(d.name)}</strong><br>${t(threatI18nKeys[d.cat])}: ${fmtDurationShort(d.count)}`);
      })
      .on("mouseleave", () => hideTooltip());

    barsG.selectAll(".total-label")
      .data(flatRows, (d) => d.key)
      .join("text")
      .attr("class", "total-label")
      .attr("direction", "ltr")
      .attr("text-anchor", "start")
      .attr("x", (d) => Math.max(x(d.total), 0) + 6)
      .attr("y", (d) => d.y + d.h / 2)
      .attr("dy", "0.35em")
      .attr("fill", (d) => d.type === "city" ? "#94a3b8" : "#e2e8f0")
      .attr("font-size", (d) => d.type === "city" ? "9px" : "10px")
      .text((d) => fmtDurationShort(d.total));

    barsG.selectAll(".zone-hit")
      .data(flatRows.filter((d) => d.type === "zone"), (d) => d.key)
      .join("rect")
      .attr("class", "zone-hit")
      .attr("x", -margin.left)
      .attr("width", w)
      .attr("y", (d) => d.y)
      .attr("height", (d) => d.h)
      .attr("fill", "transparent")
      .style("cursor", "pointer")
      .on("mouseenter", function () {
        d3.select(this).attr("fill", "rgba(99,102,241,0.08)");
      })
      .on("mouseleave", function () {
        d3.select(this).attr("fill", "transparent");
      })
      .on("click", async (_event, d) => {
        if (expanded.has(d.rawName)) {
          expanded.delete(d.rawName);
          render(zoneStacked);
        } else {
          const cityEvents = await fetchCityEvents(d.rawName);
          expanded.set(d.rawName, buildDurationStacked(cityEvents, "city"));
          render(zoneStacked);
        }
      });
  }

  function update(rows) {
    expanded.clear();
    render(buildDurationStacked(rows, "zone", "cities"));
  }

  onSignal("alertDurationByZone", (durationEvents) => {
    update(durationEvents);
  });

  return { update };
}
