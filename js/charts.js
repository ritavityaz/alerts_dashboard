import * as d3 from "d3";
import { t } from "./i18n.js";
import { showTooltip, hideTooltip } from "./tooltip.js";

const threatColors = {
  "1": "#ef4444",   // missiles
  "2": "#8b5cf6",   // drones
  "10": "#f59e0b",  // infiltrations
};

const threatI18nKeys = {
  "1": "missiles",
  "2": "drones",
  "10": "infiltrations",
};

const CATEGORIES = ["1", "2", "10"];

function buildStacked(rows, nameKey, metaKey) {
  const byName = d3.rollup(rows, (v) => new Map(v.map((d) => [d.category, d.count])), (d) => d[nameKey]);
  const names = [...byName.keys()];
  // Grab extra metadata from the first row of each group
  const metaByName = metaKey
    ? d3.rollup(rows, (v) => v[0][metaKey], (d) => d[nameKey])
    : null;
  return names.map((name) => {
    const cats = byName.get(name);
    let x0 = 0;
    const segments = CATEGORIES.map((cat) => {
      const count = cats.get(cat) || 0;
      const seg = { cat, count, x0, x1: x0 + count, name };
      x0 += count;
      return seg;
    }).filter((s) => s.count > 0);
    return { name, segments, total: x0, meta: metaByName ? metaByName.get(name) : null };
  });
}

/**
 * Stacked horizontal bar chart — zones on Y axis, alert counts on X, stacked by threat.
 * Click a zone row to expand into per-city breakdown.
 * @param {HTMLElement} container
 * @param {function} fetchCities - async (zone) => [{city, category, count}, ...]
 * @param {function} displayName - (rawName) => localized display string
 */
export function createZoneStackedChart(container, fetchCities, displayName) {
  const margin = { top: 8, right: 56, bottom: 28, left: 140 };
  const zoneRowH = 24;
  const cityRowH = 20;
  const fmt = d3.format(",");

  const svg = d3.select(container).append("svg");
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const xAxisG = g.append("g");
  const barsG = g.append("g");
  const labelsG = g.append("g");

  // Track expanded zones: zone -> city stacked data
  const expanded = new Map();

  function render(zoneStacked) {
    // Build flat list of rows: zone rows + expanded city rows
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

    // Compute y positions manually (mixed row heights)
    let yPos = 0;
    for (const r of flatRows) {
      r.y = yPos;
      r.h = r.type === "zone" ? zoneRowH : cityRowH;
      yPos += r.h;
    }

    const maxTotal = d3.max(zoneStacked, (d) => d.total) || 1;
    const x = d3.scaleLinear().domain([0, maxTotal]).range([0, innerW]).nice();

    // X axis
    xAxisG
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format("~s")).tickSize(-innerH))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll(".tick line").attr("stroke", "#1e293b"))
      .call((g) => g.selectAll(".tick text").attr("fill", "#64748b").attr("font-size", "10px"));

    // Labels — use foreignObject so the browser handles bidi/RTL natively
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

    // Stacked bar segments
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
          `<strong>${displayName(d.name)}</strong><br>${t(threatI18nKeys[d.cat])}: ${fmt(d.count)}`);
      })
      .on("mouseleave", () => hideTooltip());

    // Total count labels
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
      .text((d) => fmt(d.total));

    // Click handler + hover highlight for zone rows
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
          const cityRows = await fetchCities(d.rawName);
          expanded.set(d.rawName, buildStacked(cityRows, "city"));
          render(zoneStacked);
        }
      });
  }

  function update(rows) {
    expanded.clear();
    render(buildStacked(rows, "zone", "cities"));
  }

  return { update };
}
