import * as d3 from "d3";
import { lang, t } from "./i18n.js";
import { showTooltip, hideTooltip, pinTooltip, unpinTooltip, isTooltipPinned, updateTooltipContent, setOnUnpin } from "./tooltip.js";
import { onSignal } from "./queries.js";
import { getState } from "./store.js";
import { israelHourOfDay, israelDayStartUtc, israelParts, nextIsraelDay } from "./tz.js";
import { buildMergedTooltipHtml, buildClusterSummaryHtml, blendClusterColor, threatColors, eventTypeColors, eventTickColor } from "./timeline-tooltip.js";
import { queryClusterDetail } from "./db.js";

export function createTimeline(container, { minMs, maxMs, resolveZoneName = (z) => z, onClusterSelect = null } = {}) {
  const yAxisWidth = 44;
  const margin = { top: 30, right: 16, bottom: 16 };
  const height = 600;

  // Fixed day domain from minMs/maxMs range (Israel timezone)
  const firstDayMs = israelDayStartUtc(minMs);
  const lastDayMs = israelDayStartUtc(maxMs);
  const days = [];
  for (let d = firstDayMs; d <= lastDayMs; d = nextIsraelDay(d)) days.push(new Date(d));

  // ── Pre-cached label strings (avoid Intl calls during zoom) ──
  const dayLabels = days.map((d) => israelParts(+d).day);
  const monthStarts = days.filter((d, i) => i === 0 || israelParts(+d).month !== israelParts(+days[i - 1]).month);
  const monthStartIndices = monthStarts.map((d) => days.indexOf(d));
  const monthLabelTexts = monthStarts.map((d) => d.toLocaleString(lang, { month: "short", timeZone: "Asia/Jerusalem" }));

  // Color legend
  const threatI18nKeys = {
    missiles: "timeline.missiles",
    drones: "timeline.drones",
    infiltration: "timeline.infiltration",
    false_alarm: "timeline.falseAlarm",
  };
  const legendDiv = d3.select(container).append("div")
    .attr("class", "flex gap-4 px-3 pt-3 text-xs justify-end");
  const legendLabels = [];
  for (const [type, color] of Object.entries(threatColors)) {
    const item = legendDiv.append("span").attr("class", "flex items-center gap-1.5");
    item.append("span")
      .style("width", "10px").style("height", "10px")
      .style("background", color).style("border-radius", "2px")
      .style("display", "inline-block").style("opacity", "0.7");
    const label = item.append("span").text(t(threatI18nKeys[type]))
      .style("color", "#94a3b8");
    legendLabels.push({ el: label, key: threatI18nKeys[type] });
  }

  // Event-type line legend (shown when viewing a single city)
  const eventLegendI18n = {
    early_warning: "timeline.evWarning",
    alert: "timeline.evAlert",
    resolved: "timeline.evResolved",
  };
  const eventLegendColors = {
    early_warning: eventTypeColors.early_warning,
    alert: eventTypeColors.alert,
    resolved: eventTypeColors.resolved,
  };
  const eventLegendDiv = d3.select(container).append("div")
    .attr("class", "flex gap-4 px-3 pb-1 text-xs justify-end")
    .style("opacity", "0.6")
    .style("display", "none");
  const eventLegendLabels = [];
  for (const [type, key] of Object.entries(eventLegendI18n)) {
    const item = eventLegendDiv.append("span").attr("class", "flex items-center gap-1.5");
    item.append("span")
      .style("width", "10px").style("height", "2px")
      .style("background", eventLegendColors[type])
      .style("display", "inline-block");
    const label = item.append("span").text(t(key))
      .style("color", "#64748b");
    eventLegendLabels.push({ el: label, key });
  }

  function showEventLegend(visible) {
    eventLegendDiv.style("display", visible ? null : "none");
  }

  function updateLegendLabels() {
    for (const { el, key } of legendLabels) {
      el.text(t(key));
    }
    for (const { el, key } of eventLegendLabels) {
      el.text(t(key));
    }
  }

  // ── Layout: fixed Y-axis on left + zoomable chart area on right ──

  const wrapper = d3.select(container).append("div")
    .style("display", "flex")
    .style("position", "relative");

  // Fixed Y-axis column
  const yAxisSvg = wrapper.append("svg")
    .attr("width", yAxisWidth)
    .attr("height", height)
    .style("flex-shrink", "0");

  // Chart area (no scroll — d3.zoom handles pan/zoom)
  const scrollDiv = wrapper.append("div")
    .style("flex", "1")
    .style("min-width", "0")
    .style("overflow", "hidden");

  // Virtual data width (full extent of all day columns)
  const minColWidth = 14;
  const availableWidth = container.clientWidth - yAxisWidth;
  const dataWidth = Math.max(availableWidth, days.length * minColWidth) + margin.right;

  // SVG sized to the visible viewport — zoom reveals the rest
  const svg = scrollDiv.append("svg")
    .attr("width", availableWidth)
    .attr("height", height)
    .style("touch-action", "none");

  // ── Scales (original ranges — NEVER mutated during zoom) ──

  const x = d3.scaleBand()
    .domain(days)
    .range([0, dataWidth - margin.right])
    .padding(0.1);

  const y = d3.scaleLinear()
    .domain([0, 24])
    .range([margin.top, height - margin.bottom]);

  // Proxy continuous scales for d3.zoom transform math
  const xProxy = d3.scaleLinear()
    .domain([0, days.length])
    .range([0, dataWidth - margin.right]);

  const yProxy = d3.scaleLinear()
    .domain([0, 24])
    .range([margin.top, height - margin.bottom]);

  // ── Clip path ──

  const clipId = "timeline-clip-" + Math.random().toString(36).slice(2, 8);
  const dataClipId = "timeline-data-clip-" + Math.random().toString(36).slice(2, 8);
  svg.append("defs").call((defs) => {
    defs.append("clipPath").attr("id", clipId)
      .append("rect").attr("width", availableWidth).attr("height", height);
    defs.append("clipPath").attr("id", dataClipId)
      .append("rect").attr("y", margin.top).attr("width", availableWidth).attr("height", height - margin.top);
  });

  // ── Groups: axes outside viewGroup, data inside viewGroup ──

  const gGrid = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const gX = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const gMonth = svg.append("g").attr("clip-path", `url(#${clipId})`);

  // viewClip: static wrapper that clips data to below the x-axis
  // viewGroup: geometric transform applied here — children positioned ONCE with original scales
  const viewClip = svg.append("g").attr("clip-path", `url(#${dataClipId})`);
  const viewGroup = viewClip.append("g");
  const dataGroup = viewGroup.append("g");
  const eventTickGroup = viewGroup.append("g");
  const highlightGroup = viewGroup.append("g");
  const overlayGroup = viewGroup.append("g");

  const gY = yAxisSvg.append("g").attr("transform", `translate(${yAxisWidth},0)`);

  // ── Y-axis format helper ──

  function formatHour(h) {
    const hour = Math.floor(h);
    const min = Math.round((h - hour) * 60);
    const suffix = h < 12 || h === 24 ? "am" : "pm";
    const h12 = hour === 0 || hour === 24 ? 12 : hour > 12 ? hour - 12 : hour;
    return min === 0 ? `${h12}${suffix}` : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
  }

  /** Pick the finest tick step where labels won't overlap given display Y scale. */
  function yTickStep(displayY) {
    const pxPerHour = Math.abs(displayY(1) - displayY(0));
    if (pxPerHour >= 36) return 0.5;
    if (pxPerHour >= 18) return 1;
    return 3;
  }

  // ── Cluster / tooltip helpers (unchanged) ──

  function expandOverlapCluster(seedSlices, allDaySlices) {
    const cluster = new Set(seedSlices);
    let clusterGrew = true;
    while (clusterGrew) {
      clusterGrew = false;
      let envelopeStart = Infinity;
      let envelopeEnd = -Infinity;
      for (const slice of cluster) {
        envelopeStart = Math.min(envelopeStart, slice.y0);
        envelopeEnd = Math.max(envelopeEnd, slice.y1);
      }
      for (const candidate of allDaySlices) {
        if (cluster.has(candidate)) continue;
        const candidateEnd = candidate.y1;
        if (candidate.y0 <= envelopeEnd && candidateEnd >= envelopeStart) {
          cluster.add(candidate);
          clusterGrew = true;
        }
      }
    }
    return [...cluster];
  }

  // ── State ──

  function resetBarHighlight() {
    dataGroup.selectAll(".alert-bar").attr("stroke", null).attr("stroke-width", 0);
  }

  let slicesByDay = new Map();   // raw slices (city view)
  let mergedByDay = new Map();   // merged bars (country/zone view)
  let isMerged = false;

  // ── Hit-testing (uses viewGroup local coords — original scale space) ──

  const hoverToleranceHours = 0.15;

  function cursorHour(event) {
    const cursorYInLocal = d3.pointer(event, viewGroup.node())[1];
    return Math.max(0, Math.min(24, y.invert(cursorYInLocal)));
  }

  function hitTestCluster(event, hoveredDay) {
    const hour = cursorHour(event);
    const slicesForDay = slicesByDay.get(+hoveredDay) || [];

    const slicesUnderCursor = slicesForDay.filter((slice) => {
      const sliceStart = slice.y0 - hoverToleranceHours;
      const sliceEnd = slice.y1 + hoverToleranceHours;
      return hour >= sliceStart && hour <= sliceEnd;
    });

    if (!slicesUnderCursor.length) return null;

    const clusterSlices = expandOverlapCluster(slicesUnderCursor, slicesForDay);
    return { slices: clusterSlices, clusterSet: new Set(clusterSlices) };
  }

  function hitTestMergedBar(event, hoveredDay) {
    const hour = cursorHour(event);
    const bars = mergedByDay.get(+hoveredDay) || [];
    return bars.find((b) => hour >= b.y0 - hoverToleranceHours && hour <= b.y1 + hoverToleranceHours) || null;
  }

  function applyClusterHighlight(clusterSet) {
    dataGroup.selectAll(".alert-bar")
      .attr("stroke", (d) => clusterSet.has(d) ? "#fff" : null)
      .attr("stroke-width", (d) => clusterSet.has(d) ? 1 : 0);
  }

  function applyMergedBarHighlight(bar) {
    dataGroup.selectAll(".alert-bar")
      .attr("stroke", (d) => d === bar ? "#fff" : null)
      .attr("stroke-width", (d) => d === bar ? 1 : 0);
  }

  // ── Highlight rendering (positioned in original scale space, inside viewGroup) ──

  function appendHighlightRect(colX, hourFrom, hourTo) {
    highlightGroup.append("rect")
      .attr("x", colX).attr("width", x.bandwidth())
      .attr("y", y(hourFrom))
      .attr("height", Math.max(1, y(hourTo) - y(hourFrom)))
      .attr("fill", "#22c55e").attr("fill-opacity", 0.15)
      .attr("stroke", "#22c55e").attr("stroke-opacity", 0.4)
      .attr("stroke-width", 0.5).attr("rx", 1);
  }

  function renderHighlightGap(startMs, endMs) {
    highlightGroup.selectAll("*").remove();
    if (startMs == null || endMs == null) return;

    for (const day of days) {
      const dayStart = +day;
      const dayEnd = nextIsraelDay(dayStart);
      if (dayEnd <= startMs || dayStart >= endMs) continue;

      const colX = x(day);
      if (colX == null) continue;

      const hourFrom = dayStart < startMs ? israelHourOfDay(startMs) : 0;
      const hourTo = dayEnd > endMs ? israelHourOfDay(endMs) : 24;
      appendHighlightRect(colX, hourFrom, hourTo);
    }
  }

  function renderHighlightHourRange(startMin, endMin, fromDay, toDay) {
    highlightGroup.selectAll("*").remove();
    if (startMin == null || endMin == null) return;
    const hourFrom = startMin / 60;
    const hourTo = endMin / 60;
    const wraps = hourTo <= hourFrom;

    for (const day of days) {
      if (+day < +fromDay || +day >= +toDay) continue;
      const colX = x(day);
      if (colX == null) continue;

      if (wraps) {
        appendHighlightRect(colX, hourFrom, 24);
        appendHighlightRect(colX, 0, hourTo);
      } else {
        appendHighlightRect(colX, hourFrom, hourTo);
      }
    }
  }

  // ── renderData() — slow path, called only on data/filter changes ──

  function clusterOpacity(n) {
    return Math.min(0.85, 0.15 + 0.035 * n);
  }

  function renderData(data, points, pointsVisible) {
    const bw = x.bandwidth();

    if (isMerged) {
      // Merged bars — one rect per cluster, opacity reflects incident count
      dataGroup.selectAll(".alert-bar")
        .data(data)
        .join(
          (enter) => enter.append("rect")
            .attr("class", "alert-bar")
            .attr("rx", 1),
        )
        .attr("fill", (d) => blendClusterColor(d))
        .attr("fill-opacity", (d) => clusterOpacity(d.n_incidents))
        .attr("x", (d) => x(d.day))
        .attr("width", bw)
        .attr("y", (d) => y(d.y0))
        .attr("height", (d) => Math.max(1, y(d.y1) - y(d.y0)));
    } else {
      // Raw slices — one rect per incident-day slice
      dataGroup.selectAll(".alert-bar")
        .data(data)
        .join(
          (enter) => enter.append("rect")
            .attr("class", "alert-bar")
            .attr("fill-opacity", 0.5)
            .attr("rx", 1),
          (update) => update
            .attr("fill", (s) => threatColors[s.alert.threat_type] || "#6366f1"),
        )
        .attr("fill", (s) => threatColors[s.alert.threat_type] || "#6366f1")
        .attr("x", (s) => x(s.day))
        .attr("width", bw)
        .attr("y", (s) => y(s.y0))
        .attr("height", (s) => Math.max(1, y(s.y1) - y(s.y0)));
    }

    // Event ticks (city view only)
    if (pointsVisible && points.length) {
      eventTickGroup.selectAll(".event-tick")
        .data(points, (d, i) => `${+d.day}-${d.data}-${d.group_id}-${i}`)
        .join("line")
        .attr("class", "event-tick")
        .attr("x1", (d) => x(d.day))
        .attr("x2", (d) => x(d.day) + bw)
        .attr("y1", (d) => y(d.yHour))
        .attr("y2", (d) => y(d.yHour))
        .attr("stroke", (d) => eventTickColor(d))
        .attr("stroke-width", 0.55)
        .attr("stroke-opacity", 1)
        .attr("pointer-events", "none");
    } else {
      eventTickGroup.selectAll(".event-tick").remove();
    }

    // Overlay hit targets — positioned with original scales
    overlayGroup.selectAll(".day-overlay")
      .data(days)
      .join("rect")
      .attr("class", "day-overlay")
      .attr("x", (day) => x(day))
      .attr("width", bw)
      .attr("y", y(0))
      .attr("height", y(24) - y(0))
      .attr("fill", "transparent")
      .attr("pointer-events", "all");
  }

  // ── redraw() — fast path, called every zoom frame ──
  // Pre-created DOM elements are repositioned each frame; no create/destroy.

  const maxKx = days.length;
  const maxKy = 8; // 24 / 3 = min 3 hours visible

  // Pre-create X-axis day labels (one <text> per day)
  const xAxisG = gX.append("g").attr("transform", `translate(0,${margin.top})`);
  const dayLabelEls = days.map((_, i) =>
    xAxisG.append("text")
      .attr("y", -4)
      .attr("text-anchor", "middle")
      .attr("fill", "#64748b")
      .text(dayLabels[i])
      .node()
  );

  // Pre-create month labels (one <text> per month start)
  const monthLabelEls = monthStarts.map((_, mi) =>
    gMonth.append("text")
      .attr("y", 10)
      .attr("text-anchor", "middle")
      .attr("fill", "#94a3b8")
      .attr("font-size", "10px")
      .attr("font-weight", "bold")
      .text(monthLabelTexts[mi])
      .node()
  );

  // Pre-create gridlines (max 49 at 0.5h step: 0, 0.5, 1, ... 24)
  const maxGridLines = 49;
  const gridLineEls = Array.from({ length: maxGridLines }, () =>
    gGrid.append("line")
      .attr("x1", 0).attr("x2", availableWidth)
      .attr("stroke", "#1e293b")
      .attr("stroke-dasharray", "2,2")
      .node()
  );

  function redraw(transform) {
    // Per-axis zoom clamping
    const kx = Math.min(transform.k, maxKx);
    const ky = Math.min(transform.k, maxKy);

    // Zoomed proxy scales (for axis label positioning)
    const zx = d3.zoomIdentity.translate(transform.x, 0).scale(kx).rescaleX(xProxy);
    const zy = d3.zoomIdentity.translate(0, transform.y).scale(ky).rescaleY(yProxy);

    // Geometric transform on viewGroup — moves all data elements in one DOM write
    viewGroup.attr("transform",
      `translate(${zx(0)},${zy(0) - ky * margin.top}) scale(${kx},${ky})`);

    // Display scale for Y-axis labels (maps hours → screen pixels)
    const displayY = d3.scaleLinear().domain([0, 24]).range([zy(0), zy(24)]);

    // Zoomed bandwidth for X-axis label density
    const zoomedBw = (zx(1) - zx(0)) * (1 - 0.1 * 2);
    const colOffset = zoomedBw / 2 + (zx(1) - zx(0)) * 0.1;
    const fontSize = zoomedBw < 12 ? "7px" : "9px";
    const labelEvery = zoomedBw < 7 ? 7 : zoomedBw < 12 ? 3 : 1;

    // ── X-axis day labels — reposition pre-created elements ──
    for (let i = 0; i < days.length; i++) {
      const el = dayLabelEls[i];
      if (i % labelEvery !== 0) { el.setAttribute("display", "none"); continue; }
      const cx = zx(i) + colOffset;
      if (cx < -20 || cx > availableWidth + 20) { el.setAttribute("display", "none"); continue; }
      el.removeAttribute("display");
      el.setAttribute("x", cx);
      el.setAttribute("font-size", fontSize);
    }

    // ── Month labels — reposition pre-created elements ──
    for (let mi = 0; mi < monthStarts.length; mi++) {
      const el = monthLabelEls[mi];
      const cx = zx(monthStartIndices[mi]) + colOffset;
      if (cx < -20 || cx > availableWidth + 20) { el.setAttribute("display", "none"); continue; }
      el.removeAttribute("display");
      el.setAttribute("x", cx);
    }

    // ── Y-axis (d3.axisLeft handles its own enter/update/exit) ──
    const step = yTickStep(displayY);
    const yTicks = d3.range(0, 24 + step, step);
    gY.selectAll("*").remove();
    gY.call(
      d3.axisLeft(displayY)
        .tickValues(yTicks)
        .tickFormat(formatHour)
        .tickSize(0)
    )
    .call((g) => g.select(".domain").remove())
    .call((g) => g.selectAll(".tick text").attr("fill", "#64748b").attr("font-size", "10px").attr("dx", "-4"));

    // ── Gridlines — reposition pre-created elements ──
    let gi = 0;
    for (const h of yTicks) {
      const py = displayY(h);
      if (py < -10 || py > height + 10) continue;
      if (gi < maxGridLines) {
        const el = gridLineEls[gi++];
        el.removeAttribute("display");
        el.setAttribute("y1", py);
        el.setAttribute("y2", py);
      }
    }
    for (; gi < maxGridLines; gi++) {
      gridLineEls[gi].setAttribute("display", "none");
    }
  }

  // ── Overlay event handlers (bound once on the group) ──

  function findHoveredDay(event) {
    const [mx] = d3.pointer(event, viewGroup.node());
    const bw = x.bandwidth();
    return days.find((day) => {
      const dx = x(day);
      return dx != null && mx >= dx && mx < dx + bw;
    });
  }

  overlayGroup
    .on("pointermove", (event) => {
      if (isTooltipPinned()) return;
      const hoveredDay = findHoveredDay(event);
      if (!hoveredDay) {
        hideTooltip();
        resetBarHighlight();
        return;
      }

      if (isMerged) {
        const bar = hitTestMergedBar(event, hoveredDay);
        if (!bar) { hideTooltip(); resetBarHighlight(); return; }
        applyMergedBarHighlight(bar);
        showTooltip(event.pageX, event.pageY, buildClusterSummaryHtml(bar));
      } else {
        const cluster = hitTestCluster(event, hoveredDay);
        if (!cluster) { hideTooltip(); resetBarHighlight(); return; }
        applyClusterHighlight(cluster.clusterSet);
        showTooltip(event.pageX, event.pageY, buildMergedTooltipHtml(cluster.slices, { eventsByGroup, resolveZoneName }));
      }
    })
    .on("pointerleave", () => {
      if (isTooltipPinned()) return;
      hideTooltip();
      resetBarHighlight();
    })
    .on("click", async (event) => {
      const hoveredDay = findHoveredDay(event);
      const wasPinned = isTooltipPinned();

      if (isMerged) {
        const bar = hoveredDay ? hitTestMergedBar(event, hoveredDay) : null;
        if (wasPinned) { unpinTooltip({ silent: !!bar }); resetBarHighlight(); }
        if (bar) {
          applyMergedBarHighlight(bar);
          // Show summary immediately, then fetch detail
          showTooltip(event.pageX, event.pageY, buildClusterSummaryHtml(bar));
          pinTooltip();
          const { threat, ctx, zone, city } = getState();
          const slices = await queryClusterDetail(threat, ctx, zone, city, +bar.day, bar.y0, bar.y1);
          if (slices.length && isTooltipPinned()) {
            updateTooltipContent(buildMergedTooltipHtml(slices, { eventsByGroup, resolveZoneName }));
          }
          if (onClusterSelect) {
            const startMs = slices.reduce((min, s) => Math.min(min, +s.alert._start), Infinity);
            const endMs = slices.reduce((max, s) => Math.max(max, +s.alert._end), -Infinity);
            onClusterSelect({ startMs, endMs });
          }
        }
      } else {
        const cluster = hoveredDay ? hitTestCluster(event, hoveredDay) : null;
        if (wasPinned) { unpinTooltip({ silent: !!cluster }); resetBarHighlight(); }
        if (cluster) {
          applyClusterHighlight(cluster.clusterSet);
          showTooltip(event.pageX, event.pageY, buildMergedTooltipHtml(cluster.slices, { eventsByGroup, resolveZoneName }));
          pinTooltip();
          if (onClusterSelect) {
            const startMs = cluster.slices.reduce((min, s) => Math.min(min, +s.alert._start), Infinity);
            const endMs = cluster.slices.reduce((max, s) => Math.max(max, +s.alert._end), -Infinity);
            onClusterSelect({ startMs, endMs });
          }
        }
      }
      event.stopPropagation();
    });

  // ── d3.zoom behavior ──

  const zoom = d3.zoom()
    .scaleExtent([1, Math.max(maxKx, maxKy)])
    .translateExtent([[0, 0], [dataWidth, height]])
    .extent([[0, 0], [availableWidth, height]])
    .filter((event) => !event.button)
    .on("zoom", ({ transform }) => {
      if (isTooltipPinned()) {
        unpinTooltip({ silent: true });
        resetBarHighlight();
      }
      redraw(transform);
    });

  svg.call(zoom);

  // Reset highlights and map filter when tooltip is dismissed via the X button
  setOnUnpin(() => {
    resetBarHighlight();
    if (onClusterSelect) onClusterSelect(null);
  });

  // ── Data update ──

  let currentPointsVisible = false;
  let currentPoints = [];

  function update(data) {
    // Detect shape: merged bars have n_incidents, raw slices have alert
    isMerged = data.length > 0 && data[0].n_incidents != null;

    if (isMerged) {
      mergedByDay = new Map();
      for (const bar of data) {
        const dayKey = +bar.day;
        if (!mergedByDay.has(dayKey)) mergedByDay.set(dayKey, []);
        mergedByDay.get(dayKey).push(bar);
      }
      slicesByDay = new Map();
    } else {
      slicesByDay = new Map();
      for (const slice of data) {
        const dayKey = +slice.day;
        if (!slicesByDay.has(dayKey)) slicesByDay.set(dayKey, []);
        slicesByDay.get(dayKey).push(slice);
      }
      mergedByDay = new Map();
    }

    renderData(data, currentPoints, currentPointsVisible);
  }

  // ── Initial zoom: pan to rightmost days ──
  requestAnimationFrame(() => {
    const tx = Math.min(0, -(dataWidth - margin.right - availableWidth));
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, 0));
  });

  // Subscribe to pre-sliced incidents (day-slicing done in DuckDB SQL)
  onSignal("filteredAlertSlices", (slices) => {
    update(slices);
  });

  // ── Individual event ticks + lookup for tooltips ──
  let eventsByGroup = new Map();

  onSignal("filteredIncidentEvents", (rawEvents) => {
    eventsByGroup = new Map();
    for (const evt of rawEvents) {
      const key = evt.data + "|" + evt.group_id;
      if (!eventsByGroup.has(key)) eventsByGroup.set(key, []);
      eventsByGroup.get(key).push(evt);
    }

    const isCity = getState().ctx === "city";
    showEventLegend(isCity);
    currentPointsVisible = isCity;
    currentPoints = isCity ? rawEvents : [];
    // Re-render data elements (ticks changed)
    const currentData = isMerged
      ? Array.from(mergedByDay.values()).flat()
      : Array.from(slicesByDay.values()).flat();
    renderData(currentData, currentPoints, currentPointsVisible);
  });

  // ── Public highlight API ──

  function highlightGap(startMs, endMs) {
    renderHighlightGap(startMs, endMs);
  }

  function highlightHourRange(startMin, endMin, fromDay, toDay) {
    renderHighlightHourRange(startMin, endMin, fromDay, toDay);
  }

  return { update, updateLegendLabels, highlightGap, highlightHourRange };
}
