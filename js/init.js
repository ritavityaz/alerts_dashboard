/**
 * Bootstrap — replaces main.js.
 *
 * 1. Fetch snapshot.json → instant first paint
 * 2. Fetch parquet files + init DuckDB in parallel
 * 3. Read URL params → restore filter state
 * 4. Wire all components
 * 5. Once DuckDB ready → run initial queries
 */

import * as d3 from "d3";
import { t, lang, formatNumber } from "./i18n.js";
import * as store from "./store.js";
import * as queries from "./queries.js";
import { mountAll, isMobile, onViewportChange } from "./framework.js";
import { initDB, queryAllIncidents } from "./db.js";
import { onSignal } from "./queries.js";
import * as filters from "./filters.js";
import * as slider from "./slider.js";
import { initMap } from "./map.js";
import { createTimeline } from "./timeline.js";
import { createHeatmap } from "./heatmap.js";
import { createZoneDurationChart, createDailyHistogram, threatColors as threatColorsChart, threatI18nKeys as threatI18nChart, CATEGORIES } from "./charts.js";
import "./stats.js"; // registers statsPanel component via defineComponent
import { initQuietPeriods } from "./quiet.js";

const DATA_URL = import.meta.env.VITE_DATA_URL || "";

async function init() {
  // ── Parallel fetches ──
  const snapshotPromise = fetch(`${DATA_URL}/optimized/snapshot.json`).then((response) => response.json()).catch(() => null);
  const alertsBufferPromise = fetch(`${DATA_URL}/optimized/alerts.parquet`).then((response) => response.arrayBuffer());
  const incidentsBufferPromise = fetch(`${DATA_URL}/optimized/incidents.parquet`).then((response) => response.arrayBuffer());
  const incidentEventsBufferPromise = fetch(`${DATA_URL}/optimized/incident_events.parquet`).then((response) => response.arrayBuffer());
  const geojsonPromise = d3.json(`${DATA_URL}/optimized/zones.geojson`);

  // DuckDB init starts as soon as parquets arrive (runs in background)
  const duckdbReadyPromise = Promise.all([alertsBufferPromise, incidentsBufferPromise, incidentEventsBufferPromise]).then(
    ([alertsBuffer, incidentsBuffer, incidentEventsBuffer]) => initDB(alertsBuffer, incidentsBuffer, incidentEventsBuffer)
  );

  // Fast path: wait only for snapshot + geojson
  const [snapshot, geojson] = await Promise.all([snapshotPromise, geojsonPromise]);

  const snapshotTotalAlerts = snapshot?.totalAlerts ?? 0;
  const snapshotMinMs = snapshot?.minTs ?? 0;
  const snapshotMaxMs = snapshot?.maxTs ?? Date.now();
  const initialCountsByCity = snapshot ? new Map(Object.entries(snapshot.countByCity)) : new Map();

  console.log(`Loaded snapshot: ${snapshotTotalAlerts} alerts, ${geojson.features.length} zones`);
  console.time("init:snapshot-render");

  // ── Set slider time bounds (needed by filter chips for time range display) ──
  slider.setSnapshotMinMs(snapshotMinMs);
  slider.setSnapshotMaxMs(snapshotMaxMs);

  // ── Initialize filters (needs geojson for city/zone lookups) ──
  filters.init(geojson);

  // ── Initialize map ──
  const mapContainer = document.getElementById("map-container");
  initMap(mapContainer, geojson, initialCountsByCity);

  // ── Initialize slider + sparkline ──
  slider.init(snapshotMinMs, snapshotMaxMs);

  // Render sparkline from snapshot immediately
  if (snapshot?.sparkline) {
    slider.renderFromSnapshot(snapshot.sparkline);
  }

  // Render stats from snapshot immediately
  if (snapshot) {
    const statTotal = document.getElementById("stat-total");
    const statCities = document.getElementById("stat-cities");
    const statPeakDay = document.getElementById("stat-peak-day");
    const statPeakCount = document.getElementById("stat-peak-count");
    const statMissiles = document.querySelector("#stat-missiles bdi");
    const statDrones = document.querySelector("#stat-drones bdi");
    const statInfiltration = document.querySelector("#stat-infiltration bdi");

    if (statTotal) statTotal.innerHTML = `<bdi>${formatNumber(snapshot.totalAlerts)}</bdi>`;
    if (statCities) statCities.innerHTML = `<bdi>${formatNumber(snapshot.cities)}</bdi>`;
    if (statPeakDay) statPeakDay.textContent = new Intl.DateTimeFormat(lang, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Jerusalem" }).format(new Date(snapshot.peakDayMs));
    if (statPeakCount) statPeakCount.textContent = `${formatNumber(snapshot.peakCount)} ${t("stats.alerts")}`;
    if (statMissiles) statMissiles.textContent = formatNumber(snapshot.missiles);
    if (statDrones) statDrones.textContent = formatNumber(snapshot.drones);
    if (statInfiltration) statInfiltration.textContent = formatNumber(snapshot.infiltration);
  }

  // ── Bake translations into data-i18n elements ──
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const translated = t(element.dataset.i18n);
    if (translated !== element.dataset.i18n) element.textContent = translated;
  }
  for (const element of document.querySelectorAll("[data-i18n-html]")) {
    const translated = t(element.dataset.i18nHtml);
    if (translated !== element.dataset.i18nHtml) element.innerHTML = translated;
  }
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    const translated = t(element.dataset.i18nPlaceholder);
    if (translated !== element.dataset.i18nPlaceholder) element.placeholder = translated;
  }

  // ── Restore filter state from URL params ──
  const urlParams = new URLSearchParams(window.location.search);
  const restoredFilters = {};
  if (urlParams.has("threat")) restoredFilters.threat = urlParams.get("threat");
  if (urlParams.has("zone")) restoredFilters.zone = urlParams.get("zone");
  if (urlParams.has("city")) restoredFilters.city = urlParams.get("city");
  if (urlParams.has("startMs")) restoredFilters.startMs = Number(urlParams.get("startMs"));
  if (urlParams.has("endMs")) restoredFilters.endMs = Number(urlParams.get("endMs"));
  if (Object.keys(restoredFilters).length > 0) {
    // Infer ctx from restored params
    if (restoredFilters.city) {
      restoredFilters.ctx = "city";
      restoredFilters.mapCtx = "city";
    } else if (restoredFilters.zone && restoredFilters.zone !== "all") {
      restoredFilters.ctx = "zone";
      restoredFilters.mapCtx = "zone";
    }
    store.update(restoredFilters);
  }

  console.timeEnd("init:snapshot-render");

  // ── Wait for DuckDB ──
  console.time("init:await-duckdb");
  await duckdbReadyPromise;
  console.timeEnd("init:await-duckdb");

  // ── Initialize query cache + subscribe to store ──
  queries.init();

  // ── Create timeline + heatmap ──
  const timelineContainer = document.getElementById("timeline-container");
  const timeline = createTimeline(timelineContainer, {
    minMs: snapshotMinMs,
    maxMs: snapshotMaxMs,
    resolveZoneName: (zoneEn) => filters.zoneDisplayName(zoneEn),
  });

  const heatmapContainer = document.getElementById("heatmap-container");
  const heatmapChart = createHeatmap(heatmapContainer);

  // ── Move quiet stats into heatmap (desktop) or timeline (mobile) ──
  const quietTemplate = document.getElementById("quiet-stats-template");
  if (quietTemplate) {
    const quietNode = quietTemplate.content.cloneNode(true);
    const timelineContainer = document.getElementById("timeline-container");
    const target = isMobile() ? timelineContainer : heatmapContainer;
    target.appendChild(quietNode);

    // Re-parent on viewport change
    onViewportChange((mobile) => {
      const quietEl = document.getElementById("stats-section");
      if (!quietEl) return;
      const newParent = mobile ? timelineContainer : heatmapContainer;
      if (quietEl.parentElement !== newParent) {
        newParent.appendChild(quietEl);
      }
    });
  }

  // ── Create charts (each subscribes to its own signal internally) ──
  createZoneDurationChart(
    document.getElementById("duration-chart"),
    { displayName: (name) => filters.zoneDisplayName(name) },
  );

  createDailyHistogram(
    document.getElementById("daily-alerts-chart"),
    {
      yFormat: d3.format(","),
      tooltipFmt: (d) => {
        const date = `<strong>${d3.utcFormat("%-d/%m")(new Date(d.day_ms))}</strong>`;
        const lines = CATEGORIES
          .filter((cat) => d.byCategory[cat])
          .map((cat) => `<span style="display:inline-block;width:8px;height:8px;background:${threatColorsChart[cat]};border-radius:1px;margin-inline-end:4px;vertical-align:middle"></span>${t(threatI18nChart[cat])}: ${formatNumber(d.byCategory[cat])}`);
        return `${date}<br>${formatNumber(d.total)} ${t("stats.alerts")}` + (lines.length ? `<div style="margin-top:4px;font-size:10px;line-height:1.6">${lines.join("<br>")}</div>` : "");
      },
      signalName: "dailyAlertCounts",
    },
  );

  createDailyHistogram(
    document.getElementById("daily-shelter-chart"),
    {
      yFormat: (minutes) => `${minutes}${t("duration.m")}`,
      tooltipFmt: (dataPoint) => `<strong>${d3.utcFormat("%-d/%m")(new Date(dataPoint.day_ms))}</strong><br>${dataPoint.total} ${t("duration.m")}`,
      signalName: "dailyShelterDuration",
    },
  );

  // ── Wire heatmap — depends on heatmapBins (pre-binned by DuckDB) ──
  onSignal("heatmapBins", (binData) => {
    heatmapChart?.update(binData);
  });

  // ── Quiet periods — subscribes to filteredAlertEvents internally ──
  initQuietPeriods({
    highlightGap: timeline.highlightGap,
    highlightHourRange: timeline.highlightHourRange,
  });

  // ── Mount framework-driven components (statsPanel) ──
  mountAll();

  // ── Precompute timeline day-slices for all incidents (one-time cost) ──
  const allIncidents = await queryAllIncidents();
  timeline.setSliceIndex(allIncidents);

  // ── Run all queries for initial render ──
  await queries.runAffectedQueries(null);
}

init();
