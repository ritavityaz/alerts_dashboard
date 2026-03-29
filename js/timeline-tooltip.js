import { lang, t } from "./i18n.js";
import { getState } from "./store.js";
import { israelTimeHHMM, israelDateDM } from "./tz.js";

const threatColors = {
  missiles: "#fb3838",
  drones: "#8b5cf6",
  infiltration: "#f59e0b",
  false_alarm: "#64748b",
};

const threatI18nKeys = {
  missiles: "timeline.missiles",
  drones: "timeline.drones",
  infiltration: "timeline.infiltration",
  false_alarm: "timeline.falseAlarm",
};

const eventTypeColors = {
  alert_missiles: "#f82323",
  alert_drones: "#290691",
  alert_infiltration: "#fbbf24",
  alert: "#ffffff",
  early_warning: "#fbbf24",
  resolved: "#4ade80",
  weak_resolved: "#4ade80",
};

const eventTypeI18n = {
  alert: "timeline.evAlert",
  early_warning: "timeline.evWarning",
  resolved: "timeline.evResolved",
  weak_resolved: "timeline.evWeakResolved",
};

const ZONE_GROUP_THRESHOLD = 5;

/** Incident key for deduplication in tooltips. */
function incidentKey(alert) {
  return alert.data + "|" + alert.group_id;
}

/** Resolve tick color: alerts match their threat type (vivid), others by event_type. */
function eventTickColor(point) {
  if (point.event_type === "alert" && point.threat_type) {
    return eventTypeColors["alert_" + point.threat_type] || eventTypeColors.alert;
  }
  return eventTypeColors[point.event_type] || "#94a3b8";
}

function cityName(alert) {
  return lang === "he" ? (alert.NAME_HE || alert.data) : (alert.NAME_EN || alert.data);
}

const collapsedArrow = () => lang === "he" ? "&#9664;" : "&#9654;";

// ── Builders ──

function buildEventBreakdownHtml(slices, eventsByGroup) {
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
        const time = israelTimeHHMM(+new Date(evt.ts));
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
      const name = cityName(slice.alert);
      const startStr = israelTimeHHMM(+slice.alert._start);
      const endStr = " \u2013 " + israelTimeHHMM(+slice.alert._end);
      parts.push(`<div style="padding-inline-start:12px"><bdi>${name}</bdi> <span dir="ltr" style="opacity:0.6">${startStr}${endStr}</span></div>`);
    }
  }
  return parts.join("");
}

function buildZoneGroupedHtml(slices, resolveZoneName) {
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
        const name = cityName(citySlices[0].alert);
        const sortedSlices = citySlices.sort((a, b) => a.y0 - b.y0);

        if (sortedSlices.length === 1) {
          const sa = sortedSlices[0].alert;
          const startStr = israelTimeHHMM(+sa._start);
          const endStr = " \u2013 " + israelTimeHHMM(+sa._end);
          zoneCity.push(`<div style="padding-inline-start:24px"><bdi>${name}</bdi> <span dir="ltr" style="opacity:0.6">${startStr}${endStr}</span></div>`);
        } else {
          zoneCity.push(
            `<div class="tt-toggle" style="padding-inline-start:24px;cursor:pointer">` +
            `<span class="tt-arrow" style="display:inline-block;width:10px;font-size:9px">${collapsedArrow()}</span>` +
            `<bdi>${name}</bdi> <span style="opacity:0.5">(${sortedSlices.length})</span></div>` +
            `<div class="tt-content" style="display:none">` +
            sortedSlices.map((slice) => {
              const startStr = israelTimeHHMM(+slice.alert._start);
              const endStr = " \u2013 " + israelTimeHHMM(+slice.alert._end);
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

/**
 * Build merged tooltip HTML for a cluster of overlapping alert slices.
 * @param {Array} overlappingSlices
 * @param {{ eventsByGroup: Map, resolveZoneName: function }} ctx
 */
export function buildMergedTooltipHtml(overlappingSlices, { eventsByGroup, resolveZoneName }) {
  const timeFmt = (d) => israelTimeHHMM(+d);

  if (overlappingSlices.length === 1) {
    const slice = overlappingSlices[0];
    const a = slice.alert;
    const name = cityName(a);
    const threatLabel = t(threatI18nKeys[a.threat_type]);
    const startStr = timeFmt(a._start);
    const endStr = " \u2013 " + timeFmt(a._end);
    return `<strong><bdi>${name}</bdi></strong><br>${threatLabel}<br><span dir="ltr">${startStr}${endStr}</span>${buildEventBreakdownHtml([slice], eventsByGroup)}`;
  }

  const dedupeKeys = new Set();
  const dedupedSlices = [];
  for (const slice of overlappingSlices) {
    const a = slice.alert;
    const name = cityName(a);
    const key = name + "|" + a.threat_type + "|" + timeFmt(a._start);
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
  htmlParts.push(`<div style="margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.15)"><div dir="ltr" style="font-size:11px"><strong>${timespan}</strong></div><div style="opacity:0.5;font-size:10px;margin-top:1px">${dedupedSlices.length} ${t("timeline.alerts")} &middot; ${uniqueCities.size} ${t("timeline.cities")}</div>${buildEventBreakdownHtml(dedupedSlices, eventsByGroup)}</div>`);

  if (useZoneGrouping) {
    htmlParts.push(buildZoneGroupedHtml(dedupedSlices, resolveZoneName));
  } else {
    htmlParts.push(buildFlatGroupedHtml(dedupedSlices));
  }

  return htmlParts.join("");
}

function formatFractionalHour(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseHex(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(r, g, b) {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/** Weighted blend of threat colors. False alarms don't contribute to color. */
export function blendClusterColor(bar) {
  const weights = [
    [bar.n_missiles, threatColors.missiles],
    [bar.n_drones, threatColors.drones],
    [bar.n_infiltration, threatColors.infiltration],
  ];
  const total = weights.reduce((s, [n]) => s + n, 0);
  if (total === 0) return threatColors.false_alarm;

  let r = 0, g = 0, b = 0;
  for (const [n, color] of weights) {
    if (n === 0) continue;
    const [cr, cg, cb] = parseHex(color);
    const w = n / total;
    r += cr * w;
    g += cg * w;
    b += cb * w;
  }
  return toHex(r, g, b);
}

const threatBreakdownOrder = ["missiles", "drones", "infiltration", "false_alarm"];
const threatCountKeys = { missiles: "n_missiles", drones: "n_drones", infiltration: "n_infiltration", false_alarm: "n_false_alarm" };

/**
 * Lightweight hover tooltip for a merged cluster bar.
 */
export function buildClusterSummaryHtml(bar) {
  const start = formatFractionalHour(bar.y0);
  const end = formatFractionalHour(bar.y1);

  const lines = [];
  for (const type of threatBreakdownOrder) {
    const n = bar[threatCountKeys[type]];
    if (n === 0) continue;
    const color = threatColors[type];
    const label = t(threatI18nKeys[type]);
    lines.push(
      `<div style="margin-top:2px">` +
      `<span style="display:inline-block;width:8px;height:8px;background:${color};border-radius:2px;margin-inline-end:4px;vertical-align:middle"></span>` +
      `<strong>${n}</strong> ${label}</div>`
    );
  }

  return `<div style="margin-bottom:4px"><strong>${bar.n_incidents}</strong> ${t("timeline.alerts")}</div>` +
    lines.join("") +
    `<div style="margin-top:4px;opacity:0.6"><span dir="ltr">${start} \u2013 ${end}</span></div>`;
}

export { threatColors, threatI18nKeys, eventTypeColors, eventTickColor, incidentKey };
