import * as d3 from "d3";
import { lang, t } from "./i18n.js";
import { showTooltip, hideTooltip, pinTooltip, unpinTooltip, isTooltipPinned, setOnUnpin } from "./tooltip.js";
import { onSignal } from "./queries.js";
import { getState } from "./store.js";
import { israelHourOfDay, israelDayStartUtc, israelParts, israelTimeHHMM, israelDateDM, nextIsraelDay } from "./tz.js";

/**
 * Slice alerts across Israel-timezone day boundaries.
 * Each slice holds a reference to the original alert (no object spread).
 */
function dayslice(alerts) {
  const slices = [];
  for (const a of alerts) {
    let cursorMs = +a._start;
    const endMs = +a._end;

    while (cursorMs < endMs) {
      const dayMs = israelDayStartUtc(cursorMs);
      const nextDayMs = nextIsraelDay(dayMs);
      const sliceEndMs = Math.min(endMs, nextDayMs);

      slices.push({
        alert: a,
        day: new Date(dayMs),
        y0: israelHourOfDay(cursorMs),
        y1: israelHourOfDay(sliceEndMs < nextDayMs ? sliceEndMs : nextDayMs - 1),
      });

      cursorMs = nextDayMs;
    }
  }
  return slices;
}

/** Incident key used for precomputed slice lookups. */
function incidentKey(alert) {
  return alert.data + "|" + alert.group_id;
}

/**
 * Precompute slices for all incidents once.
 * Returns a Map: incidentKey → [slice, slice, ...].
 */
function precomputeSliceIndex(allAlerts) {
  const slices = dayslice(allAlerts);
  const index = new Map();
  for (const slice of slices) {
    const key = incidentKey(slice.alert);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(slice);
  }
  return index;
}

/** Map each point-in-time event to a day + hour for rendering as a tick mark. */
function dayslicePoints(events) {
  const points = [];
  for (const evt of events) {
    if (evt.event_type === "other") continue;
    points.push({ ...evt, day: new Date(israelDayStartUtc(evt.ts)), yHour: israelHourOfDay(evt.ts) });
  }
  return points;
}

const eventTypeColors = {
  alert_missiles: "#f82323",
  alert_drones: "#290691",
  alert_infiltration: "#fbbf24",
  alert: "#ffffff",
  early_warning: "#fbbf24",
  resolved: "#4ade80",
  weak_resolved: "#4ade80",
};

/** Resolve tick color: alerts match their threat type (vivid), others by event_type. */
function eventTickColor(point) {
  if (point.event_type === "alert" && point.threat_type) {
    return eventTypeColors["alert_" + point.threat_type] || eventTypeColors.alert;
  }
  return eventTypeColors[point.event_type] || "#94a3b8";
}

const threatColors = {
  missiles: "#fb3838",
  drones: "#8b5cf6",
  infiltration: "#f59e0b",
  false_alarm: "#64748b",
};

export function createTimeline(container, { minMs, maxMs, resolveZoneName = (z) => z, onClusterSelect = null } = {}) {
  const yAxisWidth = 44;
  const margin = { top: 30, right: 16, bottom: 16 };
  const height = 600;

  // Fixed day domain from minMs/maxMs range (Israel timezone)
  const firstDayMs = israelDayStartUtc(minMs);
  const lastDayMs = israelDayStartUtc(maxMs);
  const days = [];
  for (let d = firstDayMs; d <= lastDayMs; d = nextIsraelDay(d)) days.push(new Date(d));

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

  // Wrapper: fixed Y-axis on left + scrollable chart area on right
  const wrapper = d3.select(container).append("div")
    .style("display", "flex")
    .style("position", "relative");

  // Fixed Y-axis column
  const yAxisSvg = wrapper.append("svg")
    .attr("width", yAxisWidth)
    .attr("height", height)
    .style("flex-shrink", "0");

  const y = d3.scaleLinear()
    .domain([0, 24])
    .range([margin.top, height - margin.bottom]);

  // Scrollable chart area
  const scrollDiv = wrapper.append("div")
    .style("flex", "1")
    .style("min-width", "0")
    .style("overflow-x", "auto");

  // Compute data SVG width: enough room for all day columns
  const minColWidth = 14;
  const availableWidth = container.clientWidth - yAxisWidth;
  const dataWidth = Math.max(availableWidth, days.length * minColWidth) + margin.right;

  const svg = scrollDiv.append("svg")
    .attr("width", dataWidth)
    .attr("height", height);

  const x = d3.scaleBand()
    .domain(days)
    .range([0, dataWidth - margin.right])
    .padding(0.1);

  // X-axis (top) — inside scrollable SVG
  svg.append("g")
    .attr("transform", `translate(0,${margin.top})`)
    .call(d3.axisTop(x).tickFormat((d) => israelParts(+d).day).tickSize(0))
    .call((g) => g.select(".domain").remove())
    .call((g) => g.selectAll("text")
      .attr("fill", "#64748b")
      .attr("font-size", x.bandwidth() < 12 ? "7px" : "9px")
    );

  // Month labels
  const monthStarts = days.filter((d, i) => i === 0 || israelParts(+d).month !== israelParts(+days[i - 1]).month);
  svg.selectAll(".month-label")
    .data(monthStarts)
    .join("text")
    .attr("class", "month-label")
    .attr("x", (d) => x(d) + x.bandwidth() / 2)
    .attr("y", 10)
    .attr("text-anchor", "middle")
    .attr("fill", "#94a3b8")
    .attr("font-size", "10px")
    .attr("font-weight", "bold")
    .text((d) => d.toLocaleString(lang, { month: "short", timeZone: "Asia/Jerusalem" }));

  // Y-axis (fixed left column) — draw tick lines full width in data SVG, labels in yAxisSvg
  yAxisSvg.append("g")
    .attr("transform", `translate(${yAxisWidth},0)`)
    .call(
      d3.axisLeft(y)
        .tickValues(d3.range(0, 25, 3))
        .tickFormat((h) => {
          if (h === 0 || h === 24) return "12am";
          if (h === 12) return "12pm";
          return h < 12 ? `${h}am` : `${h - 12}pm`;
        })
        .tickSize(0)
    )
    .call((g) => g.select(".domain").remove())
    .call((g) => g.selectAll(".tick text").attr("fill", "#64748b").attr("font-size", "10px").attr("dx", "-4"));

  // Horizontal gridlines inside scrollable SVG
  svg.append("g")
    .selectAll("line")
    .data(d3.range(0, 25, 3))
    .join("line")
    .attr("x1", 0)
    .attr("x2", dataWidth)
    .attr("y1", (h) => y(h))
    .attr("y2", (h) => y(h))
    .attr("stroke", "#1e293b")
    .attr("stroke-dasharray", "2,2");

  const dataGroup = svg.append("g");
  const eventTickGroup = svg.append("g"); // Individual event ticks (city-level only)
  const overlayGroup = svg.append("g"); // Separate group ensures overlays always sit on top of bars/dots
  const timeFmt = (d) => israelTimeHHMM(+d);

  /**
   * Given a few "seed" slices under the cursor, expand outward to collect
   * every slice in the same day column that transitively overlaps them.
   * Returns the full cluster as an array.
   */
  function expandOverlapCluster(seedSlices, allDaySlices) {
    const cluster = new Set(seedSlices);
    let clusterGrew = true;
    while (clusterGrew) {
      clusterGrew = false;
      // Compute the merged time envelope of the current cluster
      let envelopeStart = Infinity;
      let envelopeEnd = -Infinity;
      for (const slice of cluster) {
        envelopeStart = Math.min(envelopeStart, slice.y0);
        envelopeEnd = Math.max(envelopeEnd, slice.y1);
      }
      // Pull in any slice that touches the envelope
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

  /**
   * Build HTML for a merged tooltip showing all overlapping alerts.
   *
   * When the number of unique cities exceeds ZONE_GROUP_THRESHOLD, cities are
   * grouped under collapsible zone headers. Within each zone, if a city has
   * multiple events, the city itself is collapsible showing individual times.
   * Collapsing/expanding requires the tooltip to be pinned (pointer-events: auto).
   */
  const ZONE_GROUP_THRESHOLD = 5;

  const eventTypeI18n = {
    alert: "timeline.evAlert",
    early_warning: "timeline.evWarning",
    resolved: "timeline.evResolved",
    weak_resolved: "timeline.evWeakResolved",
  };

  /** Build event breakdown HTML from raw incident events for the given slices. */
  function buildEventBreakdownHtml(slices) {
    const allEvts = [];
    const seen = new Set();
    for (const slice of slices) {
      const key = incidentKey(slice.alert);
      if (seen.has(key)) continue;
      seen.add(key);
      const evts = eventsByGroup.get(key);
      if (evts) allEvts.push(...evts);
    }
    if (allEvts.length === 0) return "";

    // In city view: list individual events with timestamps and colored lines
    if (getState().ctx === "city") {
      const sorted = allEvts.slice().sort((a, b) => a.ts - b.ts);
      const lines = sorted
        .filter((evt) => evt.event_type !== "other")
        .map((evt) => {
          const color = eventTickColor(evt);
          const label = t(eventTypeI18n[evt.event_type] || "");
          const time = timeFmt(new Date(evt.ts));
          return `<div style="padding-inline-start:4px;font-size:10px;line-height:1.5">` +
            `<span style="display:inline-block;width:10px;height:2px;background:${color};margin-inline-end:5px;vertical-align:middle"></span>` +
            `<span dir="ltr" style="opacity:0.6">${time}</span> ${label}</div>`;
        });
      return `<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);padding-top:3px">${lines.join("")}</div>`;
    }

    // Otherwise: compact summary
    const counts = { alert: 0, early_warning: 0, resolved: 0, weak_resolved: 0 };
    for (const evt of allEvts) {
      if (evt.event_type in counts) counts[evt.event_type]++;
    }
    const total = counts.alert + counts.early_warning + counts.resolved + counts.weak_resolved;
    if (total === 0) return "";

    const parts = [];
    if (counts.alert > 0) {
      parts.push(`${counts.alert} ${t(counts.alert === 1 ? "timeline.evAlert" : "timeline.evAlerts")}`);
    }
    const warnings = counts.early_warning + counts.weak_resolved;
    if (warnings > 0) {
      parts.push(`${warnings} ${t(warnings === 1 ? "timeline.evWarning" : "timeline.evWarnings")}`);
    }
    if (counts.resolved > 0) {
      parts.push(`${counts.resolved} ${t("timeline.evResolved")}`);
    }
    return `<div style="opacity:0.45;font-size:9px;margin-top:3px">${total} ${t("timeline.evEvents")}: ${parts.join(", ")}</div>`;
  }

  function buildMergedTooltipHtml(overlappingSlices) {
    // Single alert — original simple format
    if (overlappingSlices.length === 1) {
      const slice = overlappingSlices[0];
      const a = slice.alert;
      const cityName = lang === "he" ? (a.NAME_HE || a.data) : (a.NAME_EN || a.data);
      const threatLabel = t(threatI18nKeys[a.threat_type]);
      const startStr = timeFmt(a._start);
      const endStr = " \u2013 " + timeFmt(a._end);
      return `<strong><bdi>${cityName}</bdi></strong><br>${threatLabel}<br><span dir="ltr">${startStr}${endStr}</span>${buildEventBreakdownHtml([slice])}`;
    }

    // Deduplicate slices by city + start time
    const dedupeKeys = new Set();
    const dedupedSlices = [];
    for (const slice of overlappingSlices) {
      const a = slice.alert;
      const cityName = lang === "he" ? (a.NAME_HE || a.data) : (a.NAME_EN || a.data);
      const key = cityName + "|" + a.threat_type + "|" + timeFmt(a._start);
      if (dedupeKeys.has(key)) continue;
      dedupeKeys.add(key);
      dedupedSlices.push(slice);
    }

    // Count unique cities
    const uniqueCities = new Set(dedupedSlices.map((s) => s.alert.data));
    const useZoneGrouping = uniqueCities.size > ZONE_GROUP_THRESHOLD;

    // Compute cluster timespan from all slices
    const clusterStart = new Date(Math.min(...overlappingSlices.map((s) => +s.alert._start)));
    const clusterEnd = new Date(Math.max(...overlappingSlices.map((s) => +s.alert._end)));
    const dateFmt = (d) => israelDateDM(+d);
    const spanStart = `${dateFmt(clusterStart)} ${timeFmt(clusterStart)}`;
    const spanEnd = `${dateFmt(clusterEnd)} ${timeFmt(clusterEnd)}`;
    const timespan = +clusterStart === +clusterEnd ? spanStart
      : dateFmt(clusterStart) === dateFmt(clusterEnd) ? `${dateFmt(clusterStart)} ${timeFmt(clusterStart)} \u2013 ${timeFmt(clusterEnd)}`
      : `${spanStart} \u2013 ${spanEnd}`;

    const htmlParts = [];
    htmlParts.push(`<div style="margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.15)"><div dir="ltr" style="font-size:11px"><strong>${timespan}</strong></div><div style="opacity:0.5;font-size:10px;margin-top:1px">${dedupedSlices.length} ${t("timeline.alerts")} &middot; ${uniqueCities.size} ${t("timeline.cities")}</div>${buildEventBreakdownHtml(dedupedSlices)}</div>`);

    if (useZoneGrouping) {
      htmlParts.push(buildZoneGroupedHtml(dedupedSlices));
    } else {
      htmlParts.push(buildFlatGroupedHtml(dedupedSlices));
    }

    return htmlParts.join("");
  }

  /** Flat list grouped by threat type (for small clusters) */
  function buildFlatGroupedHtml(slices) {
    const groupedByThreat = new Map();
    for (const slice of slices) {
      const tt = slice.alert.threat_type;
      if (!groupedByThreat.has(tt)) groupedByThreat.set(tt, []);
      groupedByThreat.get(tt).push(slice);
    }

    const parts = [];
    for (const [threatType, group] of groupedByThreat) {
      const color = threatColors[threatType] || "#6366f1";
      const threatLabel = t(threatI18nKeys[threatType]);
      parts.push(
        `<div style="margin-top:4px">` +
        `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:2px;margin-inline-end:4px;vertical-align:middle"></span>` +
        `<strong>${threatLabel}</strong></div>`
      );
      for (const slice of group.sort((a, b) => a.y0 - b.y0)) {
        const a = slice.alert;
        const cityName = lang === "he" ? (a.NAME_HE || a.data) : (a.NAME_EN || a.data);
        const startStr = timeFmt(a._start);
        const endStr = " \u2013 " + timeFmt(a._end);
        parts.push(`<div style="padding-inline-start:12px"><bdi>${cityName}</bdi> <span dir="ltr" style="opacity:0.6">${startStr}${endStr}</span></div>`);
      }
    }
    return parts.join("");
  }

  const collapsedArrow = () => lang === "he" ? "&#9664;" : "&#9654;";

  /** Zone-grouped collapsible HTML (for large clusters) */
  function buildZoneGroupedHtml(slices) {
    // Group: threat -> zone -> city -> [slices]
    const tree = new Map();
    for (const slice of slices) {
      const a = slice.alert;
      const threatType = a.threat_type;
      const zoneKey = a.zone_en || "other";
      const cityKey = a.data;

      if (!tree.has(threatType)) tree.set(threatType, new Map());
      const zoneMap = tree.get(threatType);
      if (!zoneMap.has(zoneKey)) zoneMap.set(zoneKey, new Map());
      const cityMap = zoneMap.get(zoneKey);
      if (!cityMap.has(cityKey)) cityMap.set(cityKey, []);
      cityMap.get(cityKey).push(slice);
    }

    const parts = [];

    for (const [threatType, zoneMap] of tree) {
      const color = threatColors[threatType] || "#6366f1";
      const threatLabel = t(threatI18nKeys[threatType]);
      parts.push(
        `<div style="margin-top:4px">` +
        `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:2px;margin-inline-end:4px;vertical-align:middle"></span>` +
        `<strong>${threatLabel}</strong></div>`
      );

      for (const [zoneKey, cityMap] of zoneMap) {
        const zoneName = resolveZoneName(zoneKey);
        const cityCount = cityMap.size;

        // Zone: header + collapsible content wrapped in a container
        const zoneCity = [];
        for (const [cityKey, citySlices] of cityMap) {
          const cityName = lang === "he" ? (citySlices[0].alert.NAME_HE || cityKey) : (citySlices[0].alert.NAME_EN || cityKey);
          const sortedSlices = citySlices.sort((a, b) => a.y0 - b.y0);

          if (sortedSlices.length === 1) {
            const sa = sortedSlices[0].alert;
            const startStr = timeFmt(sa._start);
            const endStr = " \u2013 " + timeFmt(sa._end);
            zoneCity.push(`<div style="padding-inline-start:24px"><bdi>${cityName}</bdi> <span dir="ltr" style="opacity:0.6">${startStr}${endStr}</span></div>`);
          } else {
            zoneCity.push(
              `<div class="tt-toggle" style="padding-inline-start:24px;cursor:pointer">` +
              `<span class="tt-arrow" style="display:inline-block;width:10px;font-size:9px">${collapsedArrow()}</span>` +
              `<bdi>${cityName}</bdi> <span style="opacity:0.5">(${sortedSlices.length})</span></div>` +
              `<div class="tt-content" style="display:none">` +
              sortedSlices.map((slice) => {
                const startStr = timeFmt(slice.alert._start);
                const endStr = " \u2013 " + timeFmt(slice.alert._end);
                return `<div dir="ltr" style="padding-inline-start:40px;opacity:0.7">${startStr}${endStr}</div>`;
              }).join("") +
              `</div>`
            );
          }
        }

        parts.push(
          `<div>` +
          `<div class="tt-toggle" style="padding-inline-start:8px;cursor:pointer;opacity:0.85;margin-top:2px">` +
          `<span class="tt-arrow" style="display:inline-block;width:10px;font-size:9px">${collapsedArrow()}</span>` +
          `<bdi>${zoneName}</bdi> <span style="opacity:0.5">(${cityCount})</span></div>` +
          `<div class="tt-content" style="display:none;border-inline-start:2px solid rgba(255,255,255,0.15);margin-inline-start:14px">${zoneCity.join("")}</div>` +
          `</div>`
        );
      }
    }

    return parts.join("");
  }

  function resetBarHighlight() {
    dataGroup.selectAll(".alert-bar").attr("stroke", null).attr("stroke-width", 0);
  }

  let slicesByDay = new Map();
  let sliceIndex = null; // Map: incidentKey → [slice, ...] — set once via setSliceIndex

  /**
   * Precompute day-slices for all incidents (call once after DuckDB loads).
   * Subsequent update() calls use this index instead of re-slicing.
   */
  function setSliceIndex(allAlerts) {
    sliceIndex = precomputeSliceIndex(allAlerts);
  }

  function update(alerts) {
    // If precomputed index exists, collect slices by key lookup (fast path).
    // Otherwise fall back to computing on the fly (before index is ready).
    let slices;
    if (sliceIndex) {
      slices = [];
      for (const a of alerts) {
        const key = incidentKey(a);
        const cached = sliceIndex.get(key);
        if (cached) slices.push(...cached);
      }
    } else {
      slices = dayslice(alerts);
    }

    // Build per-day spatial index for fast hover lookups
    slicesByDay = new Map();
    for (const slice of slices) {
      const dayKey = +slice.day;
      if (!slicesByDay.has(dayKey)) slicesByDay.set(dayKey, []);
      slicesByDay.get(dayKey).push(slice);
    }

    // Render alerts as bars (no per-element mouse handlers)
    dataGroup.selectAll(".alert-bar")
      .data(slices)
      .join("rect")
      .attr("class", "alert-bar")
      .attr("x", (slice) => x(slice.day))
      .attr("width", x.bandwidth())
      .attr("y", (slice) => y(slice.y0))
      .attr("height", (slice) => Math.max(1, y(slice.y1) - y(slice.y0)))
      .attr("fill", (slice) => threatColors[slice.alert.threat_type] || "#6366f1")
      .attr("fill-opacity", 0.5)
      .attr("rx", 1);

    // Invisible overlay rects per day column for merged tooltip hit-testing.
    // These sit on top of all bars/dots in z-order, capturing all mouse events.
    const hoverToleranceHours = 0.15; // ~9 minutes — helps target thin bars and point events

    function hitTestCluster(event, hoveredDay) {
      const cursorYInSvg = d3.pointer(event, svg.node())[1];
      const cursorHour = Math.max(0, Math.min(24, y.invert(cursorYInSvg)));
      const slicesForDay = slicesByDay.get(+hoveredDay) || [];

      const slicesUnderCursor = slicesForDay.filter((slice) => {
        const sliceStart = slice.y0 - hoverToleranceHours;
        const sliceEnd = slice.y1 + hoverToleranceHours;
        return cursorHour >= sliceStart && cursorHour <= sliceEnd;
      });

      if (!slicesUnderCursor.length) return null;

      const clusterSlices = expandOverlapCluster(slicesUnderCursor, slicesForDay);
      return { slices: clusterSlices, clusterSet: new Set(clusterSlices) };
    }

    function applyClusterHighlight(clusterSet) {
      dataGroup.selectAll(".alert-bar")
        .attr("stroke", (slice) => clusterSet.has(slice) ? "#fff" : null)
        .attr("stroke-width", (slice) => clusterSet.has(slice) ? 1 : 0);
    }
    overlayGroup.selectAll(".day-overlay")
      .data(days)
      .join("rect")
      .attr("class", "day-overlay")
      .attr("x", (day) => x(day))
      .attr("width", x.bandwidth())
      .attr("y", y(0))
      .attr("height", y(24) - y(0))
      .attr("fill", "transparent")
      .attr("pointer-events", "all")
      .on("pointermove", (event, hoveredDay) => {
        if (isTooltipPinned()) return;
        const cluster = hitTestCluster(event, hoveredDay);
        if (!cluster) {
          hideTooltip();
          resetBarHighlight();
          return;
        }
        applyClusterHighlight(cluster.clusterSet);
        showTooltip(event.pageX, event.pageY, buildMergedTooltipHtml(cluster.slices));
      })
      .on("pointerleave", () => {
        if (isTooltipPinned()) return;
        hideTooltip();
        resetBarHighlight();
      })
      .on("click", (event, hoveredDay) => {
        const wasPinned = isTooltipPinned();
        const cluster = hitTestCluster(event, hoveredDay);

        if (wasPinned) {
          // Silent unpin when switching to a new cluster (no callback, no slider restore)
          // Full unpin when clicking empty space (fires callback to restore slider)
          unpinTooltip({ silent: !!cluster });
          resetBarHighlight();
        }

        if (cluster) {
          applyClusterHighlight(cluster.clusterSet);
          showTooltip(event.pageX, event.pageY, buildMergedTooltipHtml(cluster.slices));
          pinTooltip();
          if (onClusterSelect) {
            const startMs = Math.min(...cluster.slices.map((s) => +s.alert._start));
            const endMs = Math.max(...cluster.slices.map((s) => +s.alert._end));
            onClusterSelect({ startMs, endMs });
          }
        }
        event.stopPropagation();
      });

  }

  // Reset highlights and map filter when tooltip is dismissed via the X button
  setOnUnpin(() => {
    resetBarHighlight();
    if (onClusterSelect) onClusterSelect(null);
  });


  // Scroll to the end so the most recent days (including today) are visible
  requestAnimationFrame(() => {
    const node = scrollDiv.node();
    node.scrollLeft = node.scrollWidth;
  });

  // Subscribe to filtered events signal
  onSignal("filteredAlertEvents", (events) => {
    update(events);
  });

  // ── Individual event ticks + lookup for tooltips ─────────
  let eventsByGroup = new Map(); // "data|group_id" → [{ts, event_type, ...}]

  onSignal("filteredIncidentEvents", (rawEvents) => {
    eventsByGroup = new Map();
    for (const evt of rawEvents) {
      const key = evt.data + "|" + evt.group_id;
      if (!eventsByGroup.has(key)) eventsByGroup.set(key, []);
      eventsByGroup.get(key).push(evt);
    }

    // Render tick marks only when viewing a single city
    const isCity = getState().ctx === "city";
    showEventLegend(isCity);
    if (isCity) {
      const points = dayslicePoints(rawEvents);
      eventTickGroup.selectAll(".event-tick")
        .data(points, (d, i) => `${+d.day}-${d.data}-${d.group_id}-${i}`)
        .join("line")
        .attr("class", "event-tick")
        .attr("x1", (d) => x(d.day))
        .attr("x2", (d) => x(d.day) + x.bandwidth())
        .attr("y1", (d) => y(d.yHour))
        .attr("y2", (d) => y(d.yHour))
        .attr("stroke", (d) => eventTickColor(d))
        .attr("stroke-width", 0.55)
        .attr("stroke-opacity", 0.9)
        .attr("pointer-events", "none");
    } else {
      eventTickGroup.selectAll(".event-tick").remove();
    }
  });

  const highlightGroup = svg.append("g");

  function highlightGap(startMs, endMs) {
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

      highlightGroup.append("rect")
        .attr("x", colX)
        .attr("width", x.bandwidth())
        .attr("y", y(hourFrom))
        .attr("height", Math.max(1, y(hourTo) - y(hourFrom)))
        .attr("fill", "#22c55e")
        .attr("fill-opacity", 0.15)
        .attr("stroke", "#22c55e")
        .attr("stroke-opacity", 0.4)
        .attr("stroke-width", 0.5)
        .attr("rx", 1);
    }
  }

  function highlightHourRange(startMin, endMin, fromDay, toDay) {
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
        highlightGroup.append("rect")
          .attr("x", colX).attr("width", x.bandwidth())
          .attr("y", y(hourFrom))
          .attr("height", Math.max(1, y(24) - y(hourFrom)))
          .attr("fill", "#22c55e").attr("fill-opacity", 0.15)
          .attr("stroke", "#22c55e").attr("stroke-opacity", 0.4)
          .attr("stroke-width", 0.5).attr("rx", 1);
        highlightGroup.append("rect")
          .attr("x", colX).attr("width", x.bandwidth())
          .attr("y", y(0))
          .attr("height", Math.max(1, y(hourTo) - y(0)))
          .attr("fill", "#22c55e").attr("fill-opacity", 0.15)
          .attr("stroke", "#22c55e").attr("stroke-opacity", 0.4)
          .attr("stroke-width", 0.5).attr("rx", 1);
      } else {
        highlightGroup.append("rect")
          .attr("x", colX).attr("width", x.bandwidth())
          .attr("y", y(hourFrom))
          .attr("height", Math.max(1, y(hourTo) - y(hourFrom)))
          .attr("fill", "#22c55e").attr("fill-opacity", 0.15)
          .attr("stroke", "#22c55e").attr("stroke-opacity", 0.4)
          .attr("stroke-width", 0.5).attr("rx", 1);
      }
    }
  }

  return { update, setSliceIndex, updateLegendLabels, highlightGap, highlightHourRange };
}
