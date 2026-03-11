import * as d3 from "d3";
import { t } from "./i18n.js";

const BINS = 48; // 30-minute resolution
const COL_GAP = 4;
const COLS = [
  { key: "3d", label: "3d", i18n: "past3days" },
  { key: "7d", label: "7d", i18n: "past7days" },
  { key: "all", label: "all", i18n: "sinceStart" },
];

const HALF_LIFE_DAYS = 2; // fixed 2-day half-life
const DECAY_RATE = Math.log(2) / HALF_LIFE_DAYS;

function computeBins(eventsArr, from, to) {
  const binCounts = new Float64Array(BINS);
  const minsPerBin = 1440 / BINS;

  for (const d of eventsArr) {
    const s = +d._start, e = +(d._end || d._start);
    if (s > +to || e < +from) continue;
    const cs = Math.max(s, +from), ce = Math.min(e, +to);
    const age = (+to - cs) / 86400000;
    const weight = Math.exp(-DECAY_RATE * age);
    const sDate = new Date(cs), eDate = new Date(ce);
    let sm = sDate.getHours() * 60 + sDate.getMinutes();
    let em = eDate.getHours() * 60 + eDate.getMinutes();
    if (em <= sm) em = sm + 1;
    // Count once per bin touched (hybrid approach)
    const firstBin = Math.floor(sm / minsPerBin);
    const lastBin = Math.min(Math.floor((Math.min(em, 1440) - 1) / minsPerBin), BINS - 1);
    for (let b = firstBin; b <= lastBin; b++) binCounts[b] += weight;
  }

  return binCounts;
}

function fmtHour(h) {
  if (h === 0 || h === 24) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// Match timeline dimensions exactly
const TIMELINE_HEIGHT = 600;
const TIMELINE_MARGIN = { top: 30, bottom: 16 };

export function createHeatmap(container, timelineContainer) {
  // Measure the timeline's legend div so we can add a matching spacer
  const timelineLegend = timelineContainer.querySelector("div");
  const legendHeight = timelineLegend ? timelineLegend.offsetHeight : 0;

  const header = d3.select(container).append("div")
    .style("height", legendHeight > 0 ? `${legendHeight}px` : "auto")
    .style("display", "flex")
    .style("align-items", "center")
    .style("justify-content", "center")
    .style("padding", "0 4px");
  const titleEl = header.append("span")
    .style("font-size", "10px")
    .style("color", "#64748b")
    .style("white-space", "nowrap")
    .text(t("alertHeatmap"));

  const margin = { top: TIMELINE_MARGIN.top, right: 8, bottom: TIMELINE_MARGIN.bottom, left: 8 };
  const height = TIMELINE_HEIGHT;
  const binHeight = (height - margin.top - margin.bottom) / BINS;
  const COL_WIDTH = binHeight; // square cells
  const innerWidth = COLS.length * COL_WIDTH + (COLS.length - 1) * COL_GAP;
  const width = margin.left + innerWidth + margin.right;

  const svg = d3.select(container).append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [0, 0, width, height]);

  // Y-axis: 0–24h, matching timeline's y scale
  const yScale = d3.scaleLinear().domain([0, 24]).range([margin.top, height - margin.bottom]);

  function colX(i) { return margin.left + i * (COL_WIDTH + COL_GAP); }

  // Column labels (top) – keep short abbreviations in all languages
  COLS.forEach((col, i) => {
    svg.append("text")
      .attr("x", colX(i) + COL_WIDTH / 2)
      .attr("y", margin.top - 6)
      .attr("text-anchor", "middle")
      .attr("fill", "#94a3b8")
      .attr("font-size", "9px")
      .text(col.label);
  });

  // Data groups per column
  const colGroups = COLS.map((_, i) => svg.append("g").attr("transform", `translate(${colX(i)},0)`));
  const tooltip = document.getElementById("tooltip");

  function update(data) {
    // data: { "3d": { events, from, to }, "7d": ..., "all": ... }
    COLS.forEach((col, i) => {
      const d = data[col.key];
      if (!d) return;
      const bins = computeBins(d.events, d.from, d.to);
      const maxVal = d3.max(bins) || 1;

      colGroups[i].selectAll(".heatmap-cell")
        .data(bins)
        .join("rect")
        .attr("class", "heatmap-cell")
        .attr("x", 0)
        .attr("width", COL_WIDTH)
        .attr("y", (_, j) => yScale(j * 24 / BINS))
        .attr("height", Math.max(1, binHeight - 0.5))
        .attr("fill", (v) => v === 0 ? "#1e293b" : d3.interpolateTurbo(0.15 + (v / maxVal) * 0.85))
        .attr("rx", 1)
        .on("mousemove", (event, v) => {
          const j = bins.indexOf(v);
          const hourStart = j * 24 / BINS;
          const hourEnd = (j + 1) * 24 / BINS;
          tooltip.style.display = "block";
          tooltip.style.left = `${event.pageX + 12}px`;
          tooltip.style.top = `${event.pageY - 12}px`;
          tooltip.innerHTML = `<strong>${fmtHour(hourStart)}–${fmtHour(hourEnd)}</strong><br>${t(col.i18n)}<br>${v.toFixed(1)} weighted`;
        })
        .on("mouseleave", () => { tooltip.style.display = "none"; });
    });
  }

  function updateLabels() {
    titleEl.text(t("alertHeatmap"));
    // Column labels stay as short abbreviations (3d/7d/all) in all languages
  }

  return { update, updateLabels };
}
