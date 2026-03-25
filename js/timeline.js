import * as d3 from "d3";
import { lang, t } from "./i18n.js";
import { showTooltip, hideTooltip, pinTooltip, unpinTooltip, isTooltipPinned, setOnUnpin } from "./tooltip.js";
import { onSignal } from "./queries.js";

/**
 * Israel-timezone helpers.
 *
 * Israel offset is +02:00 (standard) or +03:00 (DST). We compute it once
 * for the dataset midpoint and use simple ms arithmetic everywhere —
 * the ±1h DST error is acceptable for timeline display.
 */
const ISRAEL_OFFSET_MS = (() => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hour: "numeric", minute: "numeric", hour12: false,
    year: "numeric", month: "numeric", day: "numeric",
  });
  const now = new Date();
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) parts[type] = +value;
  const localMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === 24 ? 0 : parts.hour, parts.minute);
  return localMs - (+now - (+now % 60000));
})();

function israelHourOfDay(date) {
  const localMs = +date + ISRAEL_OFFSET_MS;
  return (((localMs % 86400000) + 86400000) % 86400000) / 3600000;
}

/** Return midnight Israel time as a UTC Date for the day containing `date`. */
function israelDay(date) {
  const localMs = +date + ISRAEL_OFFSET_MS;
  const midnightLocal = localMs - (((localMs % 86400000) + 86400000) % 86400000);
  return new Date(midnightLocal - ISRAEL_OFFSET_MS);
}

function dayslice(alerts) {
  const slices = [];
  for (const a of alerts) {
    let cursorMs = +a._start;
    const endMs = +a._end;

    while (cursorMs < endMs) {
      const dayMs = +israelDay(new Date(cursorMs));
      const nextDayMs = dayMs + 86400000;
      const sliceEndMs = Math.min(endMs, nextDayMs);

      slices.push({
        ...a,
        day: new Date(dayMs),
        y0: israelHourOfDay(new Date(cursorMs)),
        y1: israelHourOfDay(new Date(sliceEndMs < nextDayMs ? sliceEndMs : nextDayMs - 1)),
      });

      cursorMs = nextDayMs;
    }
  }
  return slices;
}

const threatColors = {
  missiles: "#ef4444",
  drones: "#8b5cf6",
  infiltration: "#f59e0b",
};

export function createTimeline(container, { minMs, maxMs, resolveZoneName = (z) => z, onClusterSelect = null } = {}) {
  const yAxisWidth = 44;
  const margin = { top: 30, right: 16, bottom: 16 };
  const height = 600;

  // Fixed day domain from minMs/maxMs range (Israel timezone)
  const firstDay = israelDay(new Date(minMs));
  const lastDay = israelDay(new Date(maxMs));
  const days = [];
  for (let d = +firstDay; d <= +lastDay; d += 86400000) days.push(new Date(d));

  // Color legend
  const threatI18nKeys = {
    missiles: "timeline.missiles",
    drones: "timeline.drones",
    infiltration: "timeline.infiltration",
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

  function updateLegendLabels() {
    for (const { el, key } of legendLabels) {
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
    .call(d3.axisTop(x).tickFormat(d3.timeFormat("%-d")).tickSize(0))
    .call((g) => g.select(".domain").remove())
    .call((g) => g.selectAll("text")
      .attr("fill", "#64748b")
      .attr("font-size", x.bandwidth() < 12 ? "7px" : "9px")
    );

  // Month labels
  const monthStarts = days.filter((d, i) => i === 0 || d.getMonth() !== days[i - 1].getMonth());
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
  const overlayGroup = svg.append("g"); // Separate group ensures overlays always sit on top of bars/dots
  const timeFmt = d3.timeFormat("%H:%M");

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

  function buildMergedTooltipHtml(overlappingSlices) {
    // Single alert — original simple format
    if (overlappingSlices.length === 1) {
      const slice = overlappingSlices[0];
      const cityName = lang === "he" ? (slice.NAME_HE || slice.data) : (slice.NAME_EN || slice.data);
      const threatLabel = t(threatI18nKeys[slice.threat_type]);
      const startStr = timeFmt(slice._start);
      const endStr = " \u2013 " + timeFmt(slice._end);
      return `<strong><bdi>${cityName}</bdi></strong><br>${threatLabel}<br><span dir="ltr">${startStr}${endStr}</span>`;
    }

    // Deduplicate slices by city + start time
    const dedupeKeys = new Set();
    const dedupedSlices = [];
    for (const slice of overlappingSlices) {
      const cityName = lang === "he" ? (slice.NAME_HE || slice.data) : (slice.NAME_EN || slice.data);
      const key = cityName + "|" + slice.threat_type + "|" + timeFmt(slice._start);
      if (dedupeKeys.has(key)) continue;
      dedupeKeys.add(key);
      dedupedSlices.push(slice);
    }

    // Count unique cities
    const uniqueCities = new Set(dedupedSlices.map((s) => s.data));
    const useZoneGrouping = uniqueCities.size > ZONE_GROUP_THRESHOLD;

    // Compute cluster timespan from all slices
    const clusterStart = new Date(Math.min(...overlappingSlices.map((s) => +s._start)));
    const clusterEnd = new Date(Math.max(...overlappingSlices.map((s) => +s._end)));
    const dateFmt = d3.timeFormat("%-d/%m");
    const spanStart = `${dateFmt(clusterStart)} ${timeFmt(clusterStart)}`;
    const spanEnd = `${dateFmt(clusterEnd)} ${timeFmt(clusterEnd)}`;
    const timespan = +clusterStart === +clusterEnd ? spanStart
      : dateFmt(clusterStart) === dateFmt(clusterEnd) ? `${dateFmt(clusterStart)} ${timeFmt(clusterStart)} \u2013 ${timeFmt(clusterEnd)}`
      : `${spanStart} \u2013 ${spanEnd}`;

    const htmlParts = [];
    htmlParts.push(`<div style="margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.15)"><div dir="ltr" style="font-size:11px"><strong>${timespan}</strong></div><div style="opacity:0.5;font-size:10px;margin-top:1px">${dedupedSlices.length} ${t("timeline.alerts")} &middot; ${uniqueCities.size} ${t("timeline.cities")}</div></div>`);

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
      if (!groupedByThreat.has(slice.threat_type)) groupedByThreat.set(slice.threat_type, []);
      groupedByThreat.get(slice.threat_type).push(slice);
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
        const cityName = lang === "he" ? (slice.NAME_HE || slice.data) : (slice.NAME_EN || slice.data);
        const startStr = timeFmt(slice._start);
        const endStr = " \u2013 " + timeFmt(slice._end);
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
      const threatType = slice.threat_type;
      const zoneKey = slice.zone_en || "other";
      const cityKey = slice.data;

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
          const cityName = lang === "he" ? (citySlices[0].NAME_HE || cityKey) : (citySlices[0].NAME_EN || cityKey);
          const sortedSlices = citySlices.sort((a, b) => a.y0 - b.y0);

          if (sortedSlices.length === 1) {
            const slice = sortedSlices[0];
            const startStr = timeFmt(slice._start);
            const endStr = " \u2013 " + timeFmt(slice._end);
            zoneCity.push(`<div style="padding-inline-start:24px"><bdi>${cityName}</bdi> <span dir="ltr" style="opacity:0.6">${startStr}${endStr}</span></div>`);
          } else {
            zoneCity.push(
              `<div class="tt-toggle" style="padding-inline-start:24px;cursor:pointer">` +
              `<span class="tt-arrow" style="display:inline-block;width:10px;font-size:9px">${collapsedArrow()}</span>` +
              `<bdi>${cityName}</bdi> <span style="opacity:0.5">(${sortedSlices.length})</span></div>` +
              `<div class="tt-content" style="display:none">` +
              sortedSlices.map((slice) => {
                const startStr = timeFmt(slice._start);
                const endStr = " \u2013 " + timeFmt(slice._end);
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
  function update(alerts) {
    const slices = dayslice(alerts);

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
      .attr("fill", (slice) => threatColors[slice.threat_type] || "#6366f1")
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
      .on("mousemove", (event, hoveredDay) => {
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
      .on("mouseleave", () => {
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
            const startMs = Math.min(...cluster.slices.map((s) => +s._start));
            const endMs = Math.max(...cluster.slices.map((s) => +s._end));
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

  const highlightGroup = svg.append("g");

  function highlightGap(startMs, endMs) {
    highlightGroup.selectAll("*").remove();
    if (startMs == null || endMs == null) return;
    const start = new Date(startMs);
    const end = new Date(endMs);

    for (const day of days) {
      const dayStart = +day;
      const dayEnd = dayStart + 86400000;
      if (dayEnd <= startMs || dayStart >= endMs) continue;

      const colX = x(day);
      if (colX == null) continue;

      const hourFrom = dayStart < startMs ? israelHourOfDay(start) : 0;
      const hourTo = dayEnd > endMs ? israelHourOfDay(end) : 24;

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

  return { update, updateLegendLabels, highlightGap, highlightHourRange };
}
