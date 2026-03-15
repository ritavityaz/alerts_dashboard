import * as d3 from "d3";
import { createMap } from "./map.js";
import { createTimeline } from "./timeline.js";
import { createHeatmap } from "./heatmap.js";
import { lang, setLang, t } from "./i18n.js";
import { initDB, queryCountsByCity, queryGlobalMax, queryStats, querySparkline, queryFilteredEvents, queryZonesByThreat, queryCitiesByThreat } from "./db.js";
import { createZoneStackedChart } from "./charts.js";
import { showTooltip, hideTooltip } from "./tooltip.js";

const DATA_URL = import.meta.env.VITE_DATA_URL || "";

/**
 * Convert a UTC Date to a "fake-local" Date whose local fields
 * (.getHours(), .getDate(), etc.) show Israel time.
 * This lets d3.timeFormat / d3.timeDay work in Israel time
 * regardless of the browser's timezone.
 */
function toIL(utcDate) {
  const ilStr = utcDate.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" });
  return new Date(ilStr);
}

async function init() {
  // Start all fetches in parallel — snapshot is tiny and arrives first
  const snapshotP = fetch(`${DATA_URL}/optimized/snapshot.json`).then((r) => r.json()).catch(() => null);
  const alertsBufP = fetch(`${DATA_URL}/optimized/alerts.parquet`).then((r) => r.arrayBuffer());
  const eventsBufP = fetch(`${DATA_URL}/optimized/events.parquet`).then((r) => r.arrayBuffer());
  const geojsonP = d3.json(`${DATA_URL}/optimized/zones.geojson`);

  // Heavy path: start DuckDB init as soon as parquet arrives (runs in background)
  const dbReadyP = Promise.all([alertsBufP, eventsBufP]).then(
    ([alertsBuf, eventsBuf]) => initDB(alertsBuf, eventsBuf)
  );

  // Fast path: wait only for snapshot + geojson (small files)
  const [snapshot, geojson] = await Promise.all([snapshotP, geojsonP]);

  const totalAlerts = snapshot?.totalAlerts ?? 0;
  const minTs = snapshot?.minTs ?? 0;
  const maxTs = snapshot?.maxTs ?? Date.now();
  const countByZoneInit = snapshot ? new Map(Object.entries(snapshot.countByCity)) : new Map();

  console.log(`Loaded snapshot: ${totalAlerts} alerts, ${geojson.features.length} zones`);
  console.time("init:snapshot-render");

  // Build city lookups
  const cityToZone = new Map();
  const cityEnToHe = new Map();
  const cityHeToEn = new Map();
  const zoneEnToHe = new Map();
  const zoneHeToEn = new Map();
  for (const f of geojson.features) {
    cityToZone.set(f.properties.name_he, f.properties.zone_en);
    cityEnToHe.set(f.properties.name_en, f.properties.name_he);
    cityHeToEn.set(f.properties.name_he, f.properties.name_en);
    if (f.properties.zone_en && f.properties.zone_he) {
      zoneEnToHe.set(f.properties.zone_en, f.properties.zone_he);
      zoneHeToEn.set(f.properties.zone_he, f.properties.zone_en);
    }
  }

  // City dropdown
  const cityNames = [...cityEnToHe.keys()].sort();
  const cityNamesHe = [...cityHeToEn.keys()].sort();
  const cityDropdown = document.getElementById("city-dropdown");

  function getCityList() {
    return lang === "he" ? cityNamesHe : cityNames;
  }

  function showDropdown(filter) {
    const list = getCityList();
    const q = filter.toLowerCase();
    const matches = q
      ? list.filter((c) => c.toLowerCase().includes(q)).sort((a, b) => {
          const aStarts = a.toLowerCase().startsWith(q) ? 0 : 1;
          const bStarts = b.toLowerCase().startsWith(q) ? 0 : 1;
          return aStarts - bStarts || a.localeCompare(b);
        })
      : list;
    cityDropdown.innerHTML = "";
    for (const c of matches.slice(0, 50)) {
      const li = document.createElement("li");
      li.textContent = c;
      li.className = "px-3 py-1.5 cursor-pointer hover:bg-gray-700 text-gray-200";
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cityInput.value = c;
        cityDropdown.classList.add("hidden");
        cityInput.dispatchEvent(new Event("change"));
      });
      cityDropdown.appendChild(li);
    }
    cityDropdown.classList.toggle("hidden", matches.length === 0); 
  }

  // Populate zone filter dropdown
  const zoneNames = [...new Set(geojson.features.map((f) => f.properties.zone_en))].sort();
  const zoneSelect = document.getElementById("zone-filter");
  for (const z of zoneNames) {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z;
    zoneSelect.appendChild(opt);
  }

  const fmt = d3.format(",");
  const threatSelect = document.getElementById("threat-filter");

  const subtitle = document.getElementById("subtitle");
  subtitle.textContent = `${fmt(totalAlerts)} ${t("totalSuffix")}`;

  // Stats panel elements
  const statTotal = document.getElementById("stat-total");
  const statCities = document.getElementById("stat-cities");
  const statPeakDay = document.getElementById("stat-peak-day");
  const statPeakCount = document.getElementById("stat-peak-count");
  const statMissiles = document.querySelector("#stat-missiles .font-bold");
  const statDrones = document.querySelector("#stat-drones .font-bold");
  const statInfiltration = document.querySelector("#stat-infiltration .font-bold");
  const statQuietToday = document.querySelector('#stat-quiet-today [data-field="dur"]');
  const statQuiet3d = document.querySelector('#stat-quiet-3d [data-field="dur"]');
  const statQuiet7d = document.querySelector('#stat-quiet-7d [data-field="dur"]');
  const statQuietAll = document.querySelector('#stat-quiet-all [data-field="dur"]');
  const statQuietTodayRange = document.querySelector('#stat-quiet-today [data-field="range"]');
  const statQuiet3dRange = document.querySelector('#stat-quiet-3d [data-field="range"]');
  const statQuiet7dRange = document.querySelector('#stat-quiet-7d [data-field="range"]');
  const statQuietAllRange = document.querySelector('#stat-quiet-all [data-field="range"]');
  const quietRows = [statQuietToday.parentElement, statQuiet3d.parentElement, statQuiet7d.parentElement, statQuietAll.parentElement];
  const statQuietest3dRange = document.querySelector('#stat-quietest-3d [data-field="range"]');
  const statQuietest3dDur = document.querySelector('#stat-quietest-3d [data-field="dur"]');
  const statQuietest7dRange = document.querySelector('#stat-quietest-7d [data-field="range"]');
  const statQuietest7dDur = document.querySelector('#stat-quietest-7d [data-field="dur"]');
  const statQuietestAllRange = document.querySelector('#stat-quietest-all [data-field="range"]');
  const statQuietestAllDur = document.querySelector('#stat-quietest-all [data-field="dur"]');
  const dayFmt = d3.timeFormat("%b %d");

  // Create map
  let onMapCityClick = null;
  const { ready, recolor, zoomToZone, zoomToCity, highlightCity } = createMap(document.getElementById("map-container"), geojson, countByZoneInit, (nameHe) => {
    if (onMapCityClick) onMapCityClick(nameHe);
  });

  // Sparkline area chart (alerts per hour)
  // Convert UTC epoch ms to Israel wall-clock dates for display/d3
  const minDate = toIL(new Date(minTs));
  const maxDate = toIL(new Date(Math.max(maxTs, Date.now())));
  // Israel-to-UTC offset (ms) for converting slider values back to UTC for queries
  const ilOffset = minDate.getTime() - minTs;

  const sparkContainer = document.getElementById("sparkline");
  const sparkW = sparkContainer.clientWidth;
  const sparkH = 40;
  const thumbR = 7; // half of 14px slider thumb — aligns sparkline with range track

  const sparkSvg = d3.select(sparkContainer).append("svg")
    .attr("width", sparkW).attr("height", sparkH);

  const xScale = d3.scaleTime().domain([minDate, maxDate]).range([thumbR, sparkW - thumbR]);
  const yScale = d3.scaleLinear().range([sparkH, 0]);

  const areaGen = d3.area()
    .x((d) => xScale(d.date))
    .y0(sparkH)
    .y1((d) => yScale(d.count))
    .curve(d3.curveMonotoneX);

  // Date gridlines
  const days = d3.timeDay.range(d3.timeDay.ceil(minDate), maxDate);
  sparkSvg.selectAll(".gridline")
    .data(days)
    .join("line")
    .attr("class", "gridline")
    .attr("x1", (d) => xScale(d))
    .attr("x2", (d) => xScale(d))
    .attr("y1", 0)
    .attr("y2", sparkH)
    .attr("stroke", "#334155")
    .attr("stroke-width", 0.5)
    .attr("stroke-dasharray", "2,2");

  const sparkPath = sparkSvg.append("path")
    .attr("fill", "#6366f1")
    .attr("fill-opacity", 0.2)
    .attr("stroke", "#6366f1")
    .attr("stroke-width", 1);

  // Hover crosshair + tooltip
  const hoverLine = sparkSvg.append("line")
    .attr("y1", 0).attr("y2", sparkH)
    .attr("stroke", "#94a3b8").attr("stroke-width", 0.5)
    .style("display", "none");

  const sparkDateFmt = d3.timeFormat("%b %d %H:%M");

  sparkSvg.append("rect")
    .attr("width", sparkW).attr("height", sparkH)
    .attr("fill", "none")
    .attr("pointer-events", "all")
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const date = xScale.invert(mx);
      const hour = d3.timeHour(date);
      const data = sparkPath.datum();
      const match = data?.find((d) => +d.date === +hour);
      hoverLine.attr("x1", mx).attr("x2", mx).style("display", null);
      showTooltip(event.pageX, event.pageY, `<strong>${sparkDateFmt(hour)}</strong><br>${fmt(match?.count || 0)} ${t("alerts")}`);
    })
    .on("mouseleave", () => {
      hoverLine.style("display", "none");
      hideTooltip();
    });

  // Render from snapshot immediately (before DuckDB loads)
  if (snapshot) {
    statTotal.textContent = fmt(snapshot.totalAlerts);
    statCities.textContent = fmt(snapshot.cities);
    statPeakDay.textContent = dayFmt(toIL(new Date(snapshot.peakDayMs)));
    statPeakCount.textContent = `${fmt(snapshot.peakCount)} ${t("alerts")}`;
    statMissiles.textContent = fmt(snapshot.missiles);
    statDrones.textContent = fmt(snapshot.drones);
    statInfiltration.textContent = fmt(snapshot.infiltration);

    // Render sparkline from snapshot
    const sparkMap = new Map(snapshot.sparkline.map(([ms, cnt]) => [ms + ilOffset, cnt]));
    const allHours = d3.timeHour.range(d3.timeHour(minDate), d3.timeHour.offset(maxDate, 1));
    const hourly = allHours.map((date) => ({ date, count: sparkMap.get(+date) || 0 }));
    yScale.domain([0, d3.max(hourly, (d) => d.count) || 1]);
    sparkPath.datum(hourly).attr("d", areaGen);
  }

  // Set data-i18n-html elements on initial load
  for (const el of document.querySelectorAll("[data-i18n-html]")) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }

  // Time slider (hour resolution)
  const totalHours = Math.ceil((maxDate - minDate) / 3600000);
  const dateFmt = d3.timeFormat("%b %d");
  const dateFmtHour = d3.timeFormat("%b %d %H:%M");

  const rangeMin = document.getElementById("range-min");
  const rangeMax = document.getElementById("range-max");
  const highlight = document.getElementById("range-highlight");
  const startLabel = document.getElementById("slider-start");
  const endLabel = document.getElementById("slider-end");

  rangeMin.max = rangeMax.max = totalHours;
  rangeMin.value = 0;
  rangeMax.value = totalHours;

  startLabel.textContent = dateFmtHour(minDate);
  endLabel.textContent = dateFmtHour(maxDate);

  function sliderToDate(val) {
    return new Date(minDate.getTime() + val * 3600000);
  }

  function sliderDateLabel(date) {
    return dateFmtHour(date);
  }

  function updateHighlight() {
    const trackW = sparkW - 2 * thumbR;
    const loPx = thumbR + (+rangeMin.value / totalHours) * trackW;
    const hiPx = thumbR + (+rangeMax.value / totalHours) * trackW;
    highlight.style.left = `${loPx}px`;
    highlight.style.width = `${hiPx - loPx}px`;
  }

  updateHighlight();

  function onSliderInput() {
    // Prevent crossing
    if (+rangeMin.value > +rangeMax.value) {
      rangeMin.value = rangeMax.value;
    }
    const startDate = sliderToDate(+rangeMin.value);
    const endDate = sliderToDate(+rangeMax.value);
    startLabel.textContent = sliderDateLabel(startDate);
    endLabel.textContent = sliderDateLabel(endDate);
    updateHighlight();
  }
  function onSliderChange() {
    onSliderInput();
    applyFilters();
  }

  // Step buttons – flip through full days (midnight to midnight)
  function dateToSlider(date) {
    return Math.round((date - minDate) / 3600000);
  }
  function snapToDay(dir) {
    const curStart = sliderToDate(+rangeMin.value);
    const curEnd = sliderToDate(+rangeMax.value);
    const isFullRange = +rangeMin.value === 0 && +rangeMax.value === totalHours;

    let dayStart, dayEnd;
    if (isFullRange) {
      // First click: snap to first or last full day
      if (dir === 1) {
        dayStart = d3.timeDay(minDate);
        dayEnd = d3.timeDay.offset(dayStart, 1);
      } else {
        dayEnd = d3.timeDay.ceil(maxDate);
        dayStart = d3.timeDay.offset(dayEnd, -1);
      }
    } else {
      // Shift current window by one day
      dayStart = d3.timeDay.offset(d3.timeDay(curStart), dir);
      dayEnd = d3.timeDay.offset(d3.timeDay(curEnd), dir);
    }

    let lo = dateToSlider(dayStart);
    let hi = dateToSlider(dayEnd);
    // Clamp to slider bounds
    if (lo < 0) { lo = 0; hi = Math.min(24, totalHours); }
    if (hi > totalHours) { hi = totalHours; lo = Math.max(hi - 24, 0); }
    rangeMin.value = lo;
    rangeMax.value = hi;
    onSliderChange();
  }
  document.getElementById("step-prev").addEventListener("click", () => snapToDay(-1));
  document.getElementById("step-next").addEventListener("click", () => snapToDay(1));

  // Hour step buttons
  function stepHour(dir) {
    const isFullRange = +rangeMin.value === 0 && +rangeMax.value === totalHours;
    let span = +rangeMax.value - +rangeMin.value;
    if (isFullRange) {
      // Snap to first or last 1-hour window
      if (dir === 1) {
        rangeMin.value = 0;
        rangeMax.value = Math.min(1, totalHours);
      } else {
        rangeMax.value = totalHours;
        rangeMin.value = Math.max(totalHours - 1, 0);
      }
    } else {
      let lo = +rangeMin.value + dir;
      let hi = +rangeMax.value + dir;
      if (lo < 0) { lo = 0; hi = Math.min(span, totalHours); }
      if (hi > totalHours) { hi = totalHours; lo = Math.max(totalHours - span, 0); }
      rangeMin.value = lo;
      rangeMax.value = hi;
    }
    onSliderChange();
  }
  document.getElementById("step-prev-hr").addEventListener("click", () => stepHour(-1));
  document.getElementById("step-next-hr").addEventListener("click", () => stepHour(1));

  // Context toggle
  const contextToggle = document.getElementById("context-toggle");
  const ctxBtns = contextToggle.querySelectorAll("button");
  let currentCtx = "country";
  let selectedCityHe = null;

  function setCtx(ctx) {
    currentCtx = ctx;
    for (const btn of ctxBtns) {
      if (btn.dataset.ctx === ctx) {
        btn.classList.replace("bg-gray-800", "bg-indigo-600");
        btn.classList.replace("text-gray-400", "text-white");
      } else {
        btn.classList.replace("bg-indigo-600", "bg-gray-800");
        btn.classList.replace("text-white", "text-gray-400");
      }
    }
    applyFilters();
    applyZoom();
    highlightCity(selectedCityHe);
  }

  function applyZoom() {
    if (currentCtx === "city" && selectedCityHe) {
      zoomToCity(selectedCityHe);
    } else if (currentCtx === "zone" && zoneSelect.value !== "all") {
      zoomToZone(zoneSelect.value);
    } else {
      zoomToZone("all");
    }
  }

  for (const btn of ctxBtns) {
    btn.addEventListener("click", () => setCtx(btn.dataset.ctx));
  }

  function longestGap(eventsArr, from, to, { fromFirstAlert = false } = {}) {
    // Build intervals [start, end] for each alert
    const intervals = eventsArr
      .filter((d) => d._start <= to && +(d._end || d._start) >= +from)
      .map((d) => [+d._start, +(d._end || d._start)])
      .sort((a, b) => a[0] - b[0]);
    if (intervals.length === 0) {
      if (fromFirstAlert) return { ms: 0, start: null, end: null };
      return { ms: +to - +from, start: +from, end: +to };
    }
    // Merge overlapping intervals to find covered periods
    const merged = [intervals[0].slice()];
    for (let i = 1; i < intervals.length; i++) {
      const last = merged[merged.length - 1];
      if (intervals[i][0] <= last[1]) {
        last[1] = Math.max(last[1], intervals[i][1]);
      } else {
        merged.push(intervals[i].slice());
      }
    }
    // Find longest gap between merged intervals
    let max = 0, gapStart = null, gapEnd = null;
    // Gap before first interval (skip if starting from first alert)
    if (!fromFirstAlert) {
      const headGap = merged[0][0] - +from;
      if (headGap > max) { max = headGap; gapStart = +from; gapEnd = merged[0][0]; }
    }
    for (let i = 1; i < merged.length; i++) {
      const gap = merged[i][0] - merged[i - 1][1];
      if (gap > max) { max = gap; gapStart = merged[i - 1][1]; gapEnd = merged[i][0]; }
    }
    // Gap after last interval
    const tailGap = +to - merged[merged.length - 1][1];
    if (tailGap > max) { max = tailGap; gapStart = merged[merged.length - 1][1]; gapEnd = +to; }
    return { ms: max, start: gapStart, end: gapEnd };
  }

  function fmtDuration(ms) {
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h >= 24) {
      const d = Math.floor(h / 24);
      const rh = h % 24;
      return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
    }
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function quietestHour(eventsArr, from, to) {
    // Project all alerts onto a single 24h window [0..1440) in minutes, merge, find longest gap
    const MINS = 1440;
    const covered = new Uint8Array(MINS); // 1 = alert active in this minute
    for (const d of eventsArr) {
      const s = +d._start, e = +(d._end || d._start);
      if (s > +to || e < +from) continue;
      // Clamp to [from, to]
      const cs = Math.max(s, +from), ce = Math.min(e, +to);
      // Project onto 24h: use hour/minute of start and end
      const sDate = new Date(cs), eDate = new Date(ce);
      let sm = sDate.getHours() * 60 + sDate.getMinutes();
      let em = eDate.getHours() * 60 + eDate.getMinutes();
      // If event spans within one day or we just mark its time-of-day footprint
      if (em <= sm) em = sm + 1; // at minimum, mark 1 minute
      for (let m = sm; m < Math.min(em, MINS); m++) covered[m] = 1;
    }
    // Find longest uncovered stretch (wrapping around midnight)
    // Double the array to handle wrap-around
    let maxLen = 0, bestStart = 0;
    let run = 0, runStart = 0;
    for (let i = 0; i < MINS * 2; i++) {
      if (covered[i % MINS] === 0) {
        if (run === 0) runStart = i % MINS;
        run++;
        if (run > maxLen && run <= MINS) { maxLen = run; bestStart = runStart; }
      } else {
        run = 0;
      }
    }
    if (maxLen === 0) return null;
    const sh = Math.floor(bestStart / 60), sm = bestStart % 60;
    const endMin = (bestStart + maxLen) % MINS;
    const eh = Math.floor(endMin / 60), em = endMin % 60;
    return { startH: sh, startM: sm, endH: eh, endM: em, minutes: maxLen };
  }

  const gapTimeFmt = d3.timeFormat("%H:%M");
  const gapDateFmt = d3.timeFormat("%-d/%m %H:%M");
  function fmtGapRange(gap) {
    if (!gap || !gap.ms) return "";
    const s = new Date(gap.start), e = new Date(gap.end);
    const sameDay = d3.timeDay(s).getTime() === d3.timeDay(e).getTime();
    if (sameDay) return `${gapTimeFmt(s)}–${gapTimeFmt(e)}`;
    return `${gapDateFmt(s)}–${gapDateFmt(e)}`;
  }

  function fmtTimeRange(q) {
    if (!q) return { range: "—", dur: "" };
    const pad = (n) => String(n).padStart(2, "0");
    const h = Math.floor(q.minutes / 60), m = q.minutes % 60;
    const dur = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
    return { range: `${pad(q.startH)}:${pad(q.startM)}–${pad(q.endH)}:${pad(q.endM)}`, dur };
  }


  const categoryToThreat = { "1": "missiles", "2": "drones", "10": "terrorists" };
  const threatLabelKeys = { "1": "missilePrefix", "2": "dronePrefix", "10": "infiltrationPrefix" };

  let _filterVersion = 0;
  let _lastEventKey = ""; // tracks threat+ctx+zone+city to skip redundant tier 2/3
  let _dbReady = false;
  async function applyFilters() {
    if (!_dbReady) return;
    const version = ++_filterVersion;
    const threat = threatSelect.value;
    const zone = zoneSelect.value;
    // Slider produces Israel wall-clock ms; convert to UTC for DuckDB queries
    // Pass null when at full range to skip time filtering entirely
    const isFullRange = +rangeMin.value === 0 && +rangeMax.value === totalHours;
    const startMs = isFullRange ? null : +sliderToDate(+rangeMin.value) - ilOffset;
    const endMs = isFullRange ? null : +sliderToDate(+rangeMax.value) - ilOffset;
    const eventKey = `${threat}|${currentCtx}|${zone}|${selectedCityHe}`;

    // ── TIER 1: Immediate — DuckDB queries + map + basic stats ──
    const [counts, fixedMax, stats, sparkData, zoneRows] = await Promise.all([
      queryCountsByCity(threat, currentCtx, zone, selectedCityHe, startMs, endMs),
      currentCtx !== "country"
        ? queryGlobalMax(threat, startMs, endMs)
        : Promise.resolve(undefined),
      queryStats(currentCtx, zone, selectedCityHe, startMs, endMs),
      querySparkline(threat, currentCtx, zone, selectedCityHe),
      queryZonesByThreat(startMs, endMs),
    ]);
    if (version !== _filterVersion) return; // superseded

    recolor(counts, fixedMax);
    highlightCity(selectedCityHe);

    // Stats panel
    statTotal.textContent = fmt(stats.total);
    statCities.textContent = fmt(stats.cities);
    if (stats.peakDayMs != null) {
      statPeakDay.textContent = dayFmt(toIL(new Date(stats.peakDayMs)));
      statPeakCount.textContent = `${fmt(stats.peakCount)} ${t("alerts")}`;
    } else {
      statPeakDay.textContent = "—";
      statPeakCount.textContent = "";
    }
    statMissiles.textContent = fmt(stats.missiles);
    statDrones.textContent = fmt(stats.drones);
    statInfiltration.textContent = fmt(stats.infiltration);

    zonesChart.update(zoneRows);

    // Update zones chart title with date range
    const zonesTitle = document.getElementById("zones-chart-title");
    if (isFullRange) {
      zonesTitle.textContent = t("alertsByZone");
    } else {
      const rangeStart = dateFmtHour(sliderToDate(+rangeMin.value));
      const rangeEnd = dateFmtHour(sliderToDate(+rangeMax.value));
      zonesTitle.textContent = `${t("alertsByZone")} (${rangeStart} – ${rangeEnd})`;
    }

    // Sparkline — convert UTC hour keys to Israel time for matching
    const sparkMap = new Map(sparkData.map((d) => [d.hour + ilOffset, d.count]));
    const allHours = d3.timeHour.range(d3.timeHour(minDate), d3.timeHour.offset(maxDate, 1));
    const hourly = allHours.map((date) => ({ date, count: sparkMap.get(+date) || 0 }));
    yScale.domain([0, d3.max(hourly, (d) => d.count) || 1]);
    sparkPath.datum(hourly).attr("d", areaGen);

    updateResetVisibility();

    // ── TIER 2: Next frame — timeline + filtered events ──
    // Skip if only the time range changed (timeline/quiet periods don't depend on it)
    if (eventKey === _lastEventKey) return;
    _lastEventKey = eventKey;

    requestAnimationFrame(async () => {
      if (version !== _filterVersion) return;

      const quietEvents = await queryFilteredEvents(threat, currentCtx, zone, selectedCityHe);
      if (version !== _filterVersion) return;

      updateTimeline(quietEvents);
      // Dynamic title
      const prefix = threat !== "all" ? t(threatLabelKeys[threat]) : t("allPrefix");
      let title = `${prefix} ${t("alertsSuffix")}`;
      if (currentCtx === "city" && selectedCityHe) {
        const cityName = lang === "he" ? selectedCityHe : (cityHeToEn.get(selectedCityHe) || cityInput.value);
        title += ` ${t("inWord")} ${cityName}`;
      } else if (currentCtx === "zone" && zone !== "all") {
        const zoneName = lang === "he" ? (zoneEnToHe.get(zone) || zone) : zone;
        title += ` ${t("inWord")} ${zoneName}`;
      }
      timelineTitle.textContent = title;
      clearAllHighlights();

      // ── TIER 3: Idle — quiet periods + heatmap ──
      const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
      idle(() => {
        if (version !== _filterVersion) return;

        const now = toIL(new Date());
        const todayStart = d3.timeDay(now);
        const threeDaysAgo = d3.timeDay.offset(todayStart, -3);
        const sevenDaysAgo = d3.timeDay.offset(todayStart, -7);

        const gapToday = longestGap(quietEvents, todayStart, now);
        const gap3d = longestGap(quietEvents, threeDaysAgo, now);
        const gap7d = longestGap(quietEvents, sevenDaysAgo, now);
        const gapAll = longestGap(quietEvents, minDate, now, { fromFirstAlert: true });
        statQuietToday.textContent = fmtDuration(gapToday.ms);
        statQuiet3d.textContent = fmtDuration(gap3d.ms);
        statQuiet7d.textContent = fmtDuration(gap7d.ms);
        statQuietAll.textContent = fmtDuration(gapAll.ms);
        statQuietTodayRange.textContent = fmtGapRange(gapToday);
        statQuiet3dRange.textContent = fmtGapRange(gap3d);
        statQuiet7dRange.textContent = fmtGapRange(gap7d);
        statQuietAllRange.textContent = fmtGapRange(gapAll);
        statQuietToday.parentElement.dataset.gapStart = gapToday.start;
        statQuietToday.parentElement.dataset.gapEnd = gapToday.end;
        statQuiet3d.parentElement.dataset.gapStart = gap3d.start;
        statQuiet3d.parentElement.dataset.gapEnd = gap3d.end;
        statQuiet7d.parentElement.dataset.gapStart = gap7d.start;
        statQuiet7d.parentElement.dataset.gapEnd = gap7d.end;
        statQuietAll.parentElement.dataset.gapStart = gapAll.start;
        statQuietAll.parentElement.dataset.gapEnd = gapAll.end;

        const qh3d = quietestHour(quietEvents, threeDaysAgo, todayStart);
        const qh7d = quietestHour(quietEvents, sevenDaysAgo, todayStart);
        const qhAll = quietestHour(quietEvents, minDate, todayStart);
        const fmt3d = fmtTimeRange(qh3d);
        statQuietest3dRange.textContent = fmt3d.range;
        statQuietest3dDur.textContent = fmt3d.dur;
        const fmt7d = fmtTimeRange(qh7d);
        statQuietest7dRange.textContent = fmt7d.range;
        statQuietest7dDur.textContent = fmt7d.dur;
        const fmtAllQ = fmtTimeRange(qhAll);
        statQuietestAllRange.textContent = fmtAllQ.range;
        statQuietestAllDur.textContent = fmtAllQ.dur;
        const qh3dEl = document.getElementById("stat-quietest-3d");
        const qh7dEl = document.getElementById("stat-quietest-7d");
        const qhAllEl = document.getElementById("stat-quietest-all");
        qh3dEl.dataset.startMin = qh3d ? qh3d.startH * 60 + qh3d.startM : "";
        qh3dEl.dataset.endMin = qh3d ? (qh3d.startH * 60 + qh3d.startM + qh3d.minutes) % 1440 : "";
        qh3dEl.dataset.fromDay = +threeDaysAgo;
        qh3dEl.dataset.toDay = +todayStart;
        qh7dEl.dataset.startMin = qh7d ? qh7d.startH * 60 + qh7d.startM : "";
        qh7dEl.dataset.endMin = qh7d ? (qh7d.startH * 60 + qh7d.startM + qh7d.minutes) % 1440 : "";
        qh7dEl.dataset.fromDay = +sevenDaysAgo;
        qh7dEl.dataset.toDay = +todayStart;
        qhAllEl.dataset.startMin = qhAll ? qhAll.startH * 60 + qhAll.startM : "";
        qhAllEl.dataset.endMin = qhAll ? (qhAll.startH * 60 + qhAll.startM + qhAll.minutes) % 1440 : "";
        qhAllEl.dataset.fromDay = +minDate;
        qhAllEl.dataset.toDay = +todayStart;

        heatmapChart?.update({
          "3d": { events: quietEvents, from: threeDaysAgo, to: todayStart },
          "7d": { events: quietEvents, from: sevenDaysAgo, to: todayStart },
          "all": { events: quietEvents, from: minDate, to: todayStart },
        });
      });
    });
  }

  rangeMin.addEventListener("input", onSliderInput);
  rangeMax.addEventListener("input", onSliderInput);
  rangeMin.addEventListener("change", onSliderChange);
  rangeMax.addEventListener("change", onSliderChange);
  threatSelect.addEventListener("change", applyFilters);
  zoneSelect.addEventListener("change", () => {
    cityInput.value = "";
    selectedCityHe = null;
    highlightCity(null);
    if (zoneSelect.value !== "all") {
      contextToggle.classList.remove("hidden");
      // Hide city button when no city selected
      for (const btn of ctxBtns) {
        btn.style.display = btn.dataset.ctx === "city" ? "none" : "";
      }
      setCtx("zone");
    } else {
      contextToggle.classList.add("hidden");
      currentCtx = "country";
      applyFilters();
      zoomToZone("all");
    }
  });

  // City picker
  const cityInput = document.getElementById("city-filter");

  cityInput.addEventListener("input", () => showDropdown(cityInput.value));
  cityInput.addEventListener("focus", () => showDropdown(cityInput.value));
  cityInput.addEventListener("blur", () => {
    // Delay to allow mousedown on dropdown item
    setTimeout(() => cityDropdown.classList.add("hidden"), 150);
  });

  function resolveCityInput(value) {
    // Try English first, then Hebrew
    return cityEnToHe.get(value) || (cityHeToEn.has(value) ? value : null);
  }

  cityInput.addEventListener("change", () => {
    const val = cityInput.value;
    const cityHe = resolveCityInput(val);
    if (!cityHe) {
      if (val === "") {
        selectedCityHe = null;
        highlightCity(null);
        zoneSelect.value = "all";
        contextToggle.classList.add("hidden");
        currentCtx = "country";
        applyFilters();
        zoomToZone("all");
      }
      return;
    }
    selectedCityHe = cityHe;
    const zone = cityToZone.get(cityHe);
    if (zone) zoneSelect.value = zone;
    contextToggle.classList.remove("hidden");
    for (const btn of ctxBtns) btn.style.display = "";
    setCtx("city");
  });

  // Map click → select city
  onMapCityClick = (nameHe) => {
    selectedCityHe = nameHe;
    const nameEn = cityHeToEn.get(nameHe) || nameHe;
    cityInput.value = lang === "he" ? nameHe : nameEn;
    const zone = cityToZone.get(nameHe);
    if (zone) zoneSelect.value = zone;
    contextToggle.classList.remove("hidden");
    for (const btn of ctxBtns) btn.style.display = "";
    setCtx("city");
  };

  // Reset button
  const resetBtn = document.getElementById("reset-filters");

  function updateResetVisibility() {
    const isDefault = threatSelect.value === "all"
      && zoneSelect.value === "all"
      && !selectedCityHe
      && +rangeMin.value === 0
      && +rangeMax.value === totalHours;
    resetBtn.classList.toggle("hidden", isDefault);
  }

  resetBtn.addEventListener("click", () => {
    threatSelect.value = "all";
    zoneSelect.value = "all";
    cityInput.value = "";
    selectedCityHe = null;
    highlightCity(null);
    rangeMin.value = 0;
    rangeMax.value = totalHours;
    startLabel.textContent = dateFmt(minDate);
    endLabel.textContent = dateFmt(maxDate);
    updateHighlight();
    contextToggle.classList.add("hidden");
    currentCtx = "country";
    applyFilters();
    zoomToZone("all");
  });

  // Wait for DuckDB init (started in parallel at top of init)
  console.timeEnd("init:snapshot-render");
  console.time("init:await-duckdb");
  await dbReadyP;
  console.timeEnd("init:await-duckdb");
  _dbReady = true;

  // Get all events from DuckDB for initial timeline render
  const matched = await queryFilteredEvents("all", "country", "all", null);

  // Create timeline + heatmap
  const timelineEl = document.getElementById("timeline-container");
  const { update: updateTimeline, updateLegendLabels, highlightGap, highlightHourRange } = createTimeline(timelineEl, matched);
  const heatmapEl = document.getElementById("heatmap-container");
  const isMobile = window.innerWidth < 640;
  if (isMobile) heatmapEl.style.display = "none";
  const heatmapChart = isMobile ? null : createHeatmap(heatmapEl, timelineEl);

  // Zone stacked bar chart
  function getSliderMs() {
    const isFullRange = +rangeMin.value === 0 && +rangeMax.value === totalHours;
    return {
      startMs: isFullRange ? null : +sliderToDate(+rangeMin.value) - ilOffset,
      endMs: isFullRange ? null : +sliderToDate(+rangeMax.value) - ilOffset,
    };
  }
  const zonesChart = createZoneStackedChart(
    document.getElementById("zones-chart"),
    (zone) => {
      const { startMs, endMs } = getSliderMs();
      return queryCitiesByThreat(zone, startMs, endMs);
    },
    (name) => {
      if (lang === "he") return zoneEnToHe.get(name) || name;
      return cityHeToEn.get(name) || name;
    },
  );

  // Apply filters once map is ready
  ready.then(() => { applyFilters(); quietRows[0].click(); });
  const timelineTitle = document.getElementById("timeline-title");

  // Quiet period & quietest hour click-to-highlight
  const quietestRows = [document.getElementById("stat-quietest-3d"), document.getElementById("stat-quietest-7d"), document.getElementById("stat-quietest-all")];
  const allHighlightRows = [...quietRows, ...quietestRows];
  const activeClass = ["bg-emerald-900/40", "ring-1", "ring-emerald-500/30"];

  function clearAllHighlights() {
    for (const row of allHighlightRows) row.classList.remove(...activeClass);
    highlightGap(null, null);
  }

  for (const el of quietRows) {
    el.classList.add("cursor-pointer", "rounded", "px-1", "-mx-1", "transition-colors", "hover:bg-gray-800");
    el.addEventListener("click", () => {
      const s = +el.dataset.gapStart;
      const e = +el.dataset.gapEnd;
      if (!s || !e) return;
      const wasActive = el.classList.contains(activeClass[0]);
      clearAllHighlights();
      if (!wasActive) {
        el.classList.add(...activeClass);
        highlightGap(s, e);
      }
    });
  }

  for (const el of quietestRows) {
    el.classList.add("cursor-pointer", "rounded", "px-1", "-mx-1", "transition-colors", "hover:bg-gray-800");
    el.addEventListener("click", () => {
      const sm = el.dataset.startMin;
      const em = el.dataset.endMin;
      if (sm === "" || em === "") return;
      const wasActive = el.classList.contains(activeClass[0]);
      clearAllHighlights();
      if (!wasActive) {
        el.classList.add(...activeClass);
        highlightHourRange(+sm, +em, new Date(+el.dataset.fromDay), new Date(+el.dataset.toDay));
      }
    });
  }

  // Timeline filtering is now handled by applyFilters tier 2

  // Refresh dropdown for current language (called on lang switch)
  function populateCityList() {
    cityDropdown.classList.add("hidden");
  }

  // Populate zone dropdown for current language
  function populateZoneDropdown() {
    const currentZone = zoneSelect.value; // zone_en value
    // Remove all options except the first ("All zones")
    while (zoneSelect.options.length > 1) zoneSelect.remove(1);
    // Update "All zones" label
    zoneSelect.options[0].textContent = t("allZones");
    for (const z of zoneNames) {
      const opt = document.createElement("option");
      opt.value = z; // always zone_en internally
      opt.textContent = lang === "he" ? (zoneEnToHe.get(z) || z) : z;
      zoneSelect.appendChild(opt);
    }
    zoneSelect.value = currentZone;
  }

  // Update all data-i18n elements
  function updateI18nElements() {
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const key = el.dataset.i18n;
      el.textContent = t(key);
    }
    for (const el of document.querySelectorAll("[data-i18n-html]")) {
      const key = el.dataset.i18nHtml;
      el.innerHTML = t(key);
    }
  }

  // Language toggle
  const langBtns = document.querySelectorAll("#lang-toggle button");

  function updateLang(newLang) {
    setLang(newLang);

    // Toggle button styles
    for (const btn of langBtns) {
      if (btn.dataset.lang === newLang) {
        btn.classList.replace("bg-gray-800", "bg-indigo-600");
        btn.classList.replace("text-gray-400", "text-white");
      } else {
        btn.classList.replace("bg-indigo-600", "bg-gray-800");
        btn.classList.replace("text-white", "text-gray-400");
      }
    }

    // RTL
    document.body.dir = newLang === "he" ? "rtl" : "ltr";

    // Update static text
    document.getElementById("page-title").textContent = t("title");
    updateI18nElements();
    cityInput.placeholder = t("cityPlaceholder");

    // Update threat filter labels
    for (const opt of threatSelect.options) {
      if (opt.dataset.i18n) opt.textContent = t(opt.dataset.i18n);
    }

    // Repopulate dropdowns
    populateCityList();
    populateZoneDropdown();

    // Clear city input (avoid mixed-language state)
    cityInput.value = "";

    // Update subtitle
    subtitle.textContent = `${fmt(totalAlerts)} ${t("totalSuffix")}`;

    // Update timeline legend & heatmap labels
    updateLegendLabels();
    heatmapChart?.updateLabels();

    // Refresh all dynamic text
    applyFilters();
  }

  for (const btn of langBtns) {
    btn.addEventListener("click", () => updateLang(btn.dataset.lang));
  }
}

init();
