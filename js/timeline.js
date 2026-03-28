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

  const timeFmt = (d) => israelTimeHHMM(+d);

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

  const ZONE_GROUP_THRESHOLD = 5;

  const eventTypeI18n = {
    alert: "timeline.evAlert",
    early_warning: "timeline.evWarning",
    resolved: "timeline.evResolved",
    weak_resolved: "timeline.evWeakResolved",
  };

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
    if (overlappingSlices.length === 1) {
      const slice = overlappingSlices[0];
      const a = slice.alert;
      const cityName = lang === "he" ? (a.NAME_HE || a.data) : (a.NAME_EN || a.data);
      const threatLabel = t(threatI18nKeys[a.threat_type]);
      const startStr = timeFmt(a._start);
      const endStr = " \u2013 " + timeFmt(a._end);
      return `<strong><bdi>${cityName}</bdi></strong><br>${threatLabel}<br><span dir="ltr">${startStr}${endStr}</span>${buildEventBreakdownHtml([slice])}`;
    }

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

    const uniqueCities = new Set(dedupedSlices.map((s) => s.alert.data));
    const useZoneGrouping = uniqueCities.size > ZONE_GROUP_THRESHOLD;

    const clusterStart = new Date(overlappingSlices.reduce((min, s) => Math.min(min, +s.alert._start), Infinity));
    const clusterEnd = new Date(overlappingSlices.reduce((max, s) => Math.max(max, +s.alert._end), -Infinity));
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

  function buildZoneGroupedHtml(slices) {
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

  // ── State ──

  function resetBarHighlight() {
    dataGroup.selectAll(".alert-bar").attr("stroke", null).attr("stroke-width", 0);
  }

  let slicesByDay = new Map();
  let sliceIndex = null;
  let currentTransform = d3.zoomIdentity;

  function setSliceIndex(allAlerts) {
    sliceIndex = precomputeSliceIndex(allAlerts);
  }

  // ── Hit-testing (uses viewGroup local coords — original scale space) ──

  const hoverToleranceHours = 0.15;

  function hitTestCluster(event, hoveredDay) {
    const cursorYInLocal = d3.pointer(event, viewGroup.node())[1];
    const cursorHour = Math.max(0, Math.min(24, y.invert(cursorYInLocal)));
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

  // ── Highlight rendering (positioned in original scale space, inside viewGroup) ──

  let lastHighlight = null;

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

  // ── renderData() — slow path, called only on data/filter changes ──

  function renderData(slices, points, pointsVisible) {
    const bw = x.bandwidth();

    // Alert bars — positioned with original scales
    dataGroup.selectAll(".alert-bar")
      .data(slices)
      .join(
        (enter) => enter.append("rect")
          .attr("class", "alert-bar")
          .attr("fill", (s) => threatColors[s.alert.threat_type] || "#6366f1")
          .attr("fill-opacity", 0.5)
          .attr("rx", 1),
        (update) => update
          .attr("fill", (s) => threatColors[s.alert.threat_type] || "#6366f1"),
      )
      .attr("x", (s) => x(s.day))
      .attr("width", bw)
      .attr("y", (s) => y(s.y0))
      .attr("height", (s) => Math.max(1, y(s.y1) - y(s.y0)));

    // Event ticks
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
  // Only updates: 1 geometric transform + axis labels + gridlines

  const maxKx = days.length;
  const maxKy = 8; // 24 / 3 = min 3 hours visible

  function redraw(transform) {
    currentTransform = transform;

    // Per-axis zoom clamping
    const kx = Math.min(transform.k, maxKx);
    const ky = Math.min(transform.k, maxKy);

    // Zoomed proxy scales (for axis label positioning)
    const zx = d3.zoomIdentity.translate(transform.x, 0).scale(kx).rescaleX(xProxy);
    const zy = d3.zoomIdentity.translate(0, transform.y).scale(ky).rescaleY(yProxy);

    // Geometric transform on viewGroup — moves all data elements in one DOM write
    // Maps original pixel (ox, oy) → screen (kx*ox + zx(0), ky*oy + zy(0) - ky*margin.top)
    viewGroup.attr("transform",
      `translate(${zx(0)},${zy(0) - ky * margin.top}) scale(${kx},${ky})`);

    // Display scale for Y-axis labels (maps hours → screen pixels)
    const displayY = d3.scaleLinear().domain([0, 24]).range([zy(0), zy(24)]);

    // Zoomed bandwidth for X-axis label density
    const zoomedBw = (zx(1) - zx(0)) * (1 - 0.1 * 2); // approximate zoomed bandwidth accounting for padding

    // ── X-axis (pinned to top, in screen space) ──
    gX.selectAll("*").remove();
    const xAxisG = gX.append("g").attr("transform", `translate(0,${margin.top})`);
    const labelEvery = zoomedBw < 7 ? 7 : zoomedBw < 12 ? 3 : 1;
    for (let i = 0; i < days.length; i++) {
      if (i % labelEvery !== 0) continue;
      const cx = zx(i) + zoomedBw / 2 + (zx(1) - zx(0)) * 0.1; // center of zoomed column
      if (cx < -20 || cx > availableWidth + 20) continue;
      xAxisG.append("text")
        .attr("x", cx)
        .attr("y", -4)
        .attr("text-anchor", "middle")
        .attr("fill", "#64748b")
        .attr("font-size", zoomedBw < 12 ? "7px" : "9px")
        .text(dayLabels[i]);
    }

    // ── Month labels (in screen space) ──
    gMonth.selectAll("*").remove();
    for (let mi = 0; mi < monthStarts.length; mi++) {
      const i = monthStartIndices[mi];
      const cx = zx(i) + zoomedBw / 2 + (zx(1) - zx(0)) * 0.1;
      if (cx < -20 || cx > availableWidth + 20) continue;
      gMonth.append("text")
        .attr("x", cx)
        .attr("y", 10)
        .attr("text-anchor", "middle")
        .attr("fill", "#94a3b8")
        .attr("font-size", "10px")
        .attr("font-weight", "bold")
        .text(monthLabelTexts[mi]);
    }

    // ── Y-axis (fixed left SVG, uses display scale) ──
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

    // ── Gridlines (in screen space, match Y-axis ticks) ──
    gGrid.selectAll("*").remove();
    for (const h of yTicks) {
      const py = displayY(h);
      if (py < -10 || py > height + 10) continue;
      gGrid.append("line")
        .attr("x1", 0).attr("x2", availableWidth)
        .attr("y1", py).attr("y2", py)
        .attr("stroke", "#1e293b")
        .attr("stroke-dasharray", "2,2");
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
    .on("click", (event) => {
      const hoveredDay = findHoveredDay(event);
      const wasPinned = isTooltipPinned();
      const cluster = hoveredDay ? hitTestCluster(event, hoveredDay) : null;

      if (wasPinned) {
        unpinTooltip({ silent: !!cluster });
        resetBarHighlight();
      }

      if (cluster) {
        applyClusterHighlight(cluster.clusterSet);
        showTooltip(event.pageX, event.pageY, buildMergedTooltipHtml(cluster.slices));
        pinTooltip();
        if (onClusterSelect) {
          const startMs = cluster.slices.reduce((min, s) => Math.min(min, +s.alert._start), Infinity);
          const endMs = cluster.slices.reduce((max, s) => Math.max(max, +s.alert._end), -Infinity);
          onClusterSelect({ startMs, endMs });
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

  function update(alerts) {
    setSliceIndex(alerts);
    let slices = dayslice(alerts);

    slicesByDay = new Map();
    for (const slice of slices) {
      const dayKey = +slice.day;
      if (!slicesByDay.has(dayKey)) slicesByDay.set(dayKey, []);
      slicesByDay.get(dayKey).push(slice);
    }

    renderData(slices, currentPoints, currentPointsVisible);
  }

  // ── Initial zoom: pan to rightmost days ──
  requestAnimationFrame(() => {
    const tx = Math.min(0, -(dataWidth - margin.right - availableWidth));
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, 0));
  });

  // Subscribe to filtered events signal
  onSignal("filteredAlertEvents", (events) => {
    update(events);
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
    currentPoints = isCity ? dayslicePoints(rawEvents) : [];
    // Re-render data elements (ticks changed)
    renderData(
      Array.from(slicesByDay.values()).flat(),
      currentPoints,
      currentPointsVisible,
    );
  });

  // ── Public highlight API ──

  function highlightGap(startMs, endMs) {
    lastHighlight = startMs != null ? { type: "gap", args: [startMs, endMs] } : null;
    renderHighlightGap(startMs, endMs);
  }

  function highlightHourRange(startMin, endMin, fromDay, toDay) {
    lastHighlight = startMin != null ? { type: "hourRange", args: [startMin, endMin, fromDay, toDay] } : null;
    renderHighlightHourRange(startMin, endMin, fromDay, toDay);
  }

  return { update, setSliceIndex, updateLegendLabels, highlightGap, highlightHourRange };
}
