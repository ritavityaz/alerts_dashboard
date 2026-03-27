import * as d3 from "d3";
import { t } from "./i18n.js";
import { showTooltip, hideTooltip } from "./tooltip.js";

const BINS = 48; // 30-minute resolution
const COLS = [
  { key: "3d", label: "3d", i18nKey: "heatmap.past3days" },
  { key: "7d", label: "7d", i18nKey: "heatmap.past7days" },
  { key: "all", label: "all", i18nKey: "heatmap.sinceStart" },
];

function fmtHour(h) {
  if (h === 0 || h === 24) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

// ── Radar-clock constants ──
const SIZE = 280;
const CX = SIZE / 2;
const CY = SIZE / 2;
const OUTER_R = 95;
const INNER_R = 10;
const LABEL_R = OUTER_R + 20;
const TICK_R = OUTER_R + 4;
const MAJOR_TICK_R = OUTER_R + 8;

const angleScale = d3.scaleLinear().domain([0, BINS]).range([0, 2 * Math.PI]);
const rScale = d3.scaleLinear().domain([0, 1]).range([INNER_R, OUTER_R]).clamp(true);

const DEFAULT_COL = "3d";

export function createHeatmap(container) {
  // ── Header with dropdown ──
  let activeKey = DEFAULT_COL;

  const header = d3.select(container).append("div")
    .style("display", "flex")
    .style("align-items", "center")
    .style("justify-content", "center")
    .style("gap", "6px")
    .style("padding", "4px");
  const titleEl = header.append("span")
    .style("font-size", "10px")
    .style("color", "#64748b")
    .style("white-space", "nowrap")
    .text(t("heatmap.title"));
  const select = header.append("select")
    .attr("class", "heatmap-period-select")
    .style("font-size", "12px")
    .style("color", "#94a3b8")
    .style("background", "#1e293b")
    .style("border", "1px solid #334155")
    .style("border-radius", "4px")
    .style("padding", "2px 6px")
    .style("cursor", "pointer")
    .on("change", function () {
      activeKey = this.value;
      renderActive();
    });
  select.selectAll("option")
    .data(COLS)
    .join("option")
    .attr("value", (d) => d.key)
    .property("selected", (d) => d.key === DEFAULT_COL)
    .text((d) => d.label);

  // ── SVG ──
  const svg = d3.select(container).append("svg")
    .style("width", "100%")
    .style("max-width", `${SIZE}px`)
    .style("height", "auto")
    .attr("viewBox", [0, 0, SIZE, SIZE]);

  const defs = svg.append("defs");

  // ── Radial gradient for stroke encoding ──
  const numStops = 10;
  const grad = defs.append("radialGradient")
    .attr("id", "turbo-radial")
    .attr("gradientUnits", "userSpaceOnUse")
    .attr("cx", 0).attr("cy", 0).attr("r", OUTER_R);
  for (let i = 0; i <= numStops; i++) {
    const t01 = i / numStops;
    const rNorm = INNER_R / OUTER_R + t01 * (1 - INNER_R / OUTER_R);
    grad.append("stop")
      .attr("offset", rNorm)
      .attr("stop-color", d3.interpolateYlOrRd(0.15 + t01 * 0.85));
  }

  // ── Layers (z-order: grid → outline → ticks → hands → labels → hover) ──
  const gGrid = svg.append("g").attr("class", "grid");
  const gOutline = svg.append("g").attr("class", "radar-line");
  const gTicks = svg.append("g").attr("class", "ticks");
  const gHands = svg.append("g").attr("class", "hands");
  const gLabels = svg.append("g").attr("class", "labels");
  const gHover = svg.append("g").attr("class", "hover");

  // ── Static clock face ──
  // Concentric grid circles
  for (const frac of [0.33, 0.66, 1.0]) {
    gGrid.append("circle")
      .attr("cx", CX).attr("cy", CY)
      .attr("r", rScale(frac))
      .attr("fill", "none")
      .attr("stroke", "#334155")
      .attr("stroke-width", 0.5)
      .attr("stroke-dasharray", "2,2");
  }

  // Hour ticks + labels
  const majorHours = new Set([0, 6, 12, 18]);
  const labelHours = [0, 3, 6, 9, 12, 15, 18, 21];
  for (let h = 0; h < 24; h++) {
    const a = angleScale(h * BINS / 24); // 0=top, clockwise
    const sin = Math.sin(a), cos = -Math.cos(a);
    const isMajor = majorHours.has(h);
    const r1 = OUTER_R;
    const r2 = isMajor ? MAJOR_TICK_R : TICK_R;

    gTicks.append("line")
      .attr("x1", CX + r1 * sin).attr("y1", CY + r1 * cos)
      .attr("x2", CX + r2 * sin).attr("y2", CY + r2 * cos)
      .attr("stroke", isMajor ? "#94a3b8" : "#475569")
      .attr("stroke-width", isMajor ? 1 : 0.5);
  }

  for (const h of labelHours) {
    const binIdx = h * BINS / 24;
    const a = angleScale(binIdx);
    const sin = Math.sin(a), cos = -Math.cos(a);
    gLabels.append("text")
      .attr("x", CX + LABEL_R * sin)
      .attr("y", CY + LABEL_R * cos)
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .attr("fill", "#94a3b8")
      .attr("font-size", "10px")
      .text(`${h}:00`);
  }

  // ── Day/night indicators ──
  gLabels.append("text")
    .attr("x", CX).attr("y", CY - LABEL_R - 10)
    .attr("text-anchor", "middle").attr("font-size", "16px")
    .text("🌙");
  gLabels.append("text")
    .attr("x", CX).attr("y", CY + LABEL_R + 16)
    .attr("text-anchor", "middle").attr("font-size", "16px")
    .text("☀️");

  // ── Clock hands (Israel time) ──
  const HOUR_HAND_R = OUTER_R * 0.7;

  const hourHand = gHands.append("line")
    .attr("x1", CX).attr("y1", CY)
    .attr("stroke", "#fff").attr("stroke-width", 2)
    .attr("stroke-linecap", "round").attr("opacity", 0.9);
  gHands.append("circle")
    .attr("cx", CX).attr("cy", CY).attr("r", 2.5)
    .attr("fill", "#fff");

  const _israelTimeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem", hour: "numeric", minute: "numeric", hour12: false,
  });

  function updateHands() {
    const p = {};
    for (const { type, value } of _israelTimeFmt.formatToParts(new Date())) p[type] = +value;
    const h = p.hour === 24 ? 0 : p.hour;
    const m = p.minute;

    const hourAngle = ((h % 24) + m / 60) / 24 * 2 * Math.PI;

    hourHand
      .attr("x2", CX + HOUR_HAND_R * Math.sin(hourAngle))
      .attr("y2", CY - HOUR_HAND_R * Math.cos(hourAngle));
  }

  updateHands();
  setInterval(updateHands, 60000);

  // ── Hover wedges (invisible, for tooltip detection) ──
  const hoverArc = d3.arc()
    .innerRadius(0)
    .outerRadius(OUTER_R + 10);

  gHover.selectAll("path")
    .data(d3.range(BINS))
    .join("path")
    .attr("d", (i) => hoverArc({ startAngle: angleScale(i), endAngle: angleScale(i + 1) }))
    .attr("transform", `translate(${CX},${CY})`)
    .attr("fill", "transparent")
    .style("pointer-events", "all")
    .on("pointermove", (event, i) => {
      const hourStart = i * 24 / BINS;
      const hourEnd = (i + 1) * 24 / BINS;
      const raw = storedBins[activeKey];
      const val = raw ? raw[i].toFixed(1) : "–";
      showTooltip(event.pageX, event.pageY, `<strong>${fmtHour(hourStart)}\u2013${fmtHour(hourEnd)}</strong><br>${val} weighted`);
    })
    .on("pointerleave", () => { hideTooltip(); });

  // ── Radial generator ──
  const lineGen = d3.lineRadial()
    .angle((_, i) => angleScale(i))
    .radius((d) => rScale(d))
    .curve(d3.curveCardinalClosed.tension(0.7));

  // ── Single outline path ──
  const outlinePath = gOutline.append("path")
    .attr("transform", `translate(${CX},${CY})`)
    .attr("fill", "none")
    .attr("stroke", "url(#turbo-radial)")
    .attr("stroke-width", 2)
    .attr("stroke-linecap", "round")
    .attr("stroke-linejoin", "round");

  // ── Stored data for tooltip + re-render ──
  const storedBins = {};
  const storedNorm = {};
  function renderActive() {
    const norm = storedNorm[activeKey];
    if (!norm) return;
    outlinePath
      .transition().duration(400)
      .attr("d", lineGen(norm));
  }

  function update(data) {
    for (const col of COLS) {
      const bins = data[col.key];
      if (!bins) continue;
      const maxVal = d3.max(bins) || 1;
      storedBins[col.key] = bins;
      storedNorm[col.key] = Array.from(bins, (v) => Math.log1p(v) / Math.log1p(maxVal));
    }
    renderActive();
  }

  function updateLabels() {
    titleEl.text(t("heatmap.title"));
  }

  return { update, updateLabels };
}
