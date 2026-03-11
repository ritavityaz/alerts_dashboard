import * as d3 from "d3";
import { createMap } from "./map.js";
import { createTimeline } from "./timeline.js";
import { createHeatmap } from "./heatmap.js";
import { lang, setLang, t } from "./i18n.js";

const DATA_URL = import.meta.env.VITE_DATA_URL || "";

async function init() {
  const [cube, geojson, eventsData] = await Promise.all([
    d3.json(`${DATA_URL}/optimized/alerts_cube.json`),
    d3.json(`${DATA_URL}/optimized/zones.geojson`),
    d3.json(`${DATA_URL}/optimized/timeline_events.json`),
  ]);

  // Hydrate alerts from compact cube format
  const cats = ["1", "2", "10"];
  const alerts = [];
  for (let i = 0; i < cube.c.length; i++) {
    const data = cube.cities[cube.c[i]];
    const _ts = new Date(cube.hours[cube.h[i]] + ":00:00Z");
    const category = cats[cube.t[i]];
    const count = cube.n[i];
    for (let j = 0; j < count; j++) alerts.push({ data, _ts, category });
  }

  console.log(`Loaded ${alerts.length} alerts, ${geojson.features.length} zones`);

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

  // Populate city datalist
  const cityNames = [...cityEnToHe.keys()].sort();
  const cityList = document.getElementById("city-list");
  for (const c of cityNames) {
    const opt = document.createElement("option");
    opt.value = c;
    cityList.appendChild(opt);
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
  subtitle.textContent = `${fmt(alerts.length)} ${t("totalSuffix")}`;

  // Stats panel elements
  const statTotal = document.getElementById("stat-total");
  const statCities = document.getElementById("stat-cities");
  const statPeakDay = document.getElementById("stat-peak-day");
  const statPeakCount = document.getElementById("stat-peak-count");
  const statMissiles = document.querySelector("#stat-missiles .font-bold");
  const statDrones = document.querySelector("#stat-drones .font-bold");
  const statInfiltration = document.querySelector("#stat-infiltration .font-bold");
  const statQuietToday = document.querySelector("#stat-quiet-today .font-bold");
  const statQuiet3d = document.querySelector("#stat-quiet-3d .font-bold");
  const statQuiet7d = document.querySelector("#stat-quiet-7d .font-bold");
  const statQuietAll = document.querySelector("#stat-quiet-all .font-bold");
  const quietRows = [statQuietToday.parentElement, statQuiet3d.parentElement, statQuiet7d.parentElement, statQuietAll.parentElement];
  const statQuietest3dRange = document.querySelector('#stat-quietest-3d [data-field="range"]');
  const statQuietest3dDur = document.querySelector('#stat-quietest-3d [data-field="dur"]');
  const statQuietest7dRange = document.querySelector('#stat-quietest-7d [data-field="range"]');
  const statQuietest7dDur = document.querySelector('#stat-quietest-7d [data-field="dur"]');
  const statQuietestAllRange = document.querySelector('#stat-quietest-all [data-field="range"]');
  const statQuietestAllDur = document.querySelector('#stat-quietest-all [data-field="dur"]');
  const dayFmt = d3.timeFormat("%b %d");

  // Create map
  const countByZone = d3.rollup(alerts, (v) => v.length, (d) => d.data);
  let onMapCityClick = null;
  const { ready, recolor, zoomToZone, zoomToCity, highlightCity } = createMap(document.getElementById("map-container"), geojson, countByZone, (nameHe) => {
    if (onMapCityClick) onMapCityClick(nameHe);
  });

  // Sparkline area chart (alerts per day)
  const minDate = d3.min(alerts, (d) => d._ts);
  const maxDate = d3.max(alerts, (d) => d._ts);

  const sparkContainer = document.getElementById("sparkline");
  const sparkW = sparkContainer.clientWidth;
  const sparkH = 40;

  const sparkSvg = d3.select(sparkContainer).append("svg")
    .attr("width", sparkW).attr("height", sparkH);

  const xScale = d3.scaleTime().domain([minDate, maxDate]).range([0, sparkW]);
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

  const tooltip = document.getElementById("tooltip");
  const sparkDateFmt = d3.timeFormat("%b %d");

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
      tooltip.style.display = "block";
      tooltip.style.left = `${event.pageX + 12}px`;
      tooltip.style.top = `${event.pageY - 30}px`;
      tooltip.innerHTML = `<strong>${sparkDateFmt(hour)}</strong><br>${fmt(match?.count || 0)} ${t("alerts")}`;
    })
    .on("mouseleave", () => {
      hoverLine.style("display", "none");
      tooltip.style.display = "none";
    });

  function updateSparkline(filtered) {
    const countMap = d3.rollup(filtered, (v) => v.length, (d) => +d3.timeHour(d._ts));
    const allHours = d3.timeHour.range(d3.timeHour(minDate), d3.timeHour.offset(maxDate, 1));
    const hourly = allHours.map((date) => ({ date, count: countMap.get(+date) || 0 }));
    yScale.domain([0, d3.max(hourly, (d) => d.count) || 1]);
    sparkPath.datum(hourly).attr("d", areaGen);
  }

  updateSparkline(alerts);

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

  startLabel.textContent = dateFmt(minDate);
  endLabel.textContent = dateFmt(maxDate);

  function sliderToDate(val) {
    return new Date(minDate.getTime() + val * 3600000);
  }

  function sliderDateLabel(date) {
    const h = date.getHours();
    return h === 0 ? dateFmt(date) : dateFmtHour(date);
  }

  function updateHighlight() {
    const lo = +rangeMin.value / totalHours * 100;
    const hi = +rangeMax.value / totalHours * 100;
    highlight.style.left = `${lo}%`;
    highlight.style.width = `${hi - lo}%`;
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
    _skipTimeline = true; applyFilters(); _skipTimeline = false;
  }

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

  function fmtTimeRange(q) {
    if (!q) return { range: "—", dur: "" };
    const pad = (n) => String(n).padStart(2, "0");
    const h = Math.floor(q.minutes / 60), m = q.minutes % 60;
    const dur = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
    return { range: `${pad(q.startH)}:${pad(q.startM)}–${pad(q.endH)}:${pad(q.endM)}`, dur };
  }


  const categoryToThreat = { "1": "missiles", "2": "drones", "10": "terrorists" };

  let _skipTimeline = false;
  function applyFilters() {
    const threat = threatSelect.value;
    const zone = zoneSelect.value;
    const startDate = sliderToDate(+rangeMin.value);
    const endDate = sliderToDate(+rangeMax.value);

    // Threat-filtered base
    let threatFiltered = alerts;
    if (threat !== "all") threatFiltered = threatFiltered.filter((d) => d.category === threat);

    // Determine data scope based on context
    let base = threatFiltered;
    if (currentCtx === "zone" && zone !== "all") {
      base = base.filter((d) => cityToZone.get(d.data) === zone);
    } else if (currentCtx === "city" && selectedCityHe) {
      base = base.filter((d) => d.data === selectedCityHe);
    }
    updateSparkline(base);

    // Time-filtered for map
    const filtered = base.filter((d) => d._ts >= startDate && d._ts <= endDate);
    const counts = d3.rollup(filtered, (v) => v.length, (d) => d.data);

    // For zone/city context, use global max so colors stay comparable
    let fixedMax;
    if (currentCtx !== "country") {
      const globalFiltered = threatFiltered.filter((d) => d._ts >= startDate && d._ts <= endDate);
      const globalCounts = d3.rollup(globalFiltered, (v) => v.length, (d) => d.data);
      fixedMax = d3.max([...globalCounts.values()]) || 1;
    }

    recolor(counts, fixedMax);
    highlightCity(selectedCityHe);

    // Update stats panel (ignores threat filter)
    let statsBase = alerts;
    if (currentCtx === "zone" && zone !== "all") {
      statsBase = statsBase.filter((d) => cityToZone.get(d.data) === zone);
    } else if (currentCtx === "city" && selectedCityHe) {
      statsBase = statsBase.filter((d) => d.data === selectedCityHe);
    }
    const statsFiltered = statsBase.filter((d) => d._ts >= startDate && d._ts <= endDate);

    statTotal.textContent = fmt(statsFiltered.length);
    statCities.textContent = fmt(new Set(statsFiltered.map((d) => d.data)).size);

    const byDay = d3.rollup(statsFiltered, (v) => v.length, (d) => d3.timeDay(d._ts).getTime());
    if (byDay.size > 0) {
      const peakEntry = d3.greatest([...byDay], (a, b) => a[1] - b[1]);
      statPeakDay.textContent = dayFmt(new Date(peakEntry[0]));
      statPeakCount.textContent = `${fmt(peakEntry[1])} ${t("alerts")}`;
    } else {
      statPeakDay.textContent = "—";
      statPeakCount.textContent = "";
    }

    const byCat = d3.rollup(statsFiltered, (v) => v.length, (d) => d.category);
    statMissiles.textContent = fmt(byCat.get("1") || 0);
    statDrones.textContent = fmt(byCat.get("2") || 0);
    statInfiltration.textContent = fmt(byCat.get("10") || 0);

    // Longest quiet periods (using minute-resolution timeline events)
    // Data timestamps are Israeli local times stored as-if-local (no TZ suffix),
    // so we need "now" and "today midnight" in the same frame of reference.
    // Convert real now → Israeli local time, then use d3.timeDay for midnight.
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const todayStart = d3.timeDay(now);
    const threeDaysAgo = d3.timeDay.offset(todayStart, -3);
    const sevenDaysAgo = d3.timeDay.offset(todayStart, -7);
    let quietEvents = matched;
    if (threat !== "all") quietEvents = quietEvents.filter((d) => d.threat_type === categoryToThreat[threat]);
    if (currentCtx === "zone" && zone !== "all") {
      quietEvents = quietEvents.filter((d) => cityToZone.get(d.data) === zone);
    } else if (currentCtx === "city" && selectedCityHe) {
      quietEvents = quietEvents.filter((d) => d.data === selectedCityHe);
    }
    const gapToday = longestGap(quietEvents, todayStart, now);
    const gap3d = longestGap(quietEvents, threeDaysAgo, now);
    const gap7d = longestGap(quietEvents, sevenDaysAgo, now);
    const gapAll = longestGap(quietEvents, minDate, now, { fromFirstAlert: true });
    statQuietToday.textContent = fmtDuration(gapToday.ms);
    statQuiet3d.textContent = fmtDuration(gap3d.ms);
    statQuiet7d.textContent = fmtDuration(gap7d.ms);
    statQuietAll.textContent = fmtDuration(gapAll.ms);
    statQuietToday.parentElement.dataset.gapStart = gapToday.start;
    statQuietToday.parentElement.dataset.gapEnd = gapToday.end;
    statQuiet3d.parentElement.dataset.gapStart = gap3d.start;
    statQuiet3d.parentElement.dataset.gapEnd = gap3d.end;
    statQuiet7d.parentElement.dataset.gapStart = gap7d.start;
    statQuiet7d.parentElement.dataset.gapEnd = gap7d.end;
    statQuietAll.parentElement.dataset.gapStart = gapAll.start;
    statQuietAll.parentElement.dataset.gapEnd = gapAll.end;

    // Quietest hour (overlay projection onto 24h, excludes today's partial data)
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

    // Alert heatmap (weighted by recency, excludes today)
    heatmapChart?.update({
      "3d": { events: quietEvents, from: threeDaysAgo, to: todayStart },
      "7d": { events: quietEvents, from: sevenDaysAgo, to: todayStart },
      "all": { events: quietEvents, from: minDate, to: todayStart },
    });


    if (!_skipTimeline) {
      updateTimelineFilter();
      clearAllHighlights();
    }
    updateResetVisibility();
  }

  rangeMin.addEventListener("input", onSliderInput);
  rangeMax.addEventListener("input", onSliderInput);
  rangeMin.addEventListener("change", onSliderChange);
  rangeMax.addEventListener("change", onSliderChange);
  rangeMin.addEventListener("change", updateTimelineFilter);
  rangeMax.addEventListener("change", updateTimelineFilter);
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

  // Initial stats (wait for map sources to be ready), then select Today
  ready.then(() => { applyFilters(); quietRows[0].click(); });

  // Hydrate timeline events from compact format
  const threatTypes = ["missiles", "drones", "terrorists"];
  const eventsBase = new Date(eventsData.base).getTime();
  const matched = [];
  for (let i = 0; i < eventsData.c.length; i++) {
    const data = eventsData.cities[eventsData.c[i]];
    const threat_type = threatTypes[eventsData.t[i]];
    const _start = new Date(eventsBase + eventsData.s[i] * 60000);
    const _end = eventsData.r[i] != null ? new Date(eventsBase + eventsData.r[i] * 60000) : null;
    const NAME_HE = data;
    const NAME_EN = cityHeToEn.get(data) || data;
    matched.push({ data, threat_type, _start, _end, NAME_HE, NAME_EN });
  }

  const timelineEl = document.getElementById("timeline-container");
  const { update: updateTimeline, updateLegendLabels, highlightGap, highlightHourRange } = createTimeline(timelineEl, matched);
  const heatmapEl = document.getElementById("heatmap-container");
  const isMobile = window.innerWidth < 640;
  if (isMobile) heatmapEl.style.display = "none";
  const heatmapChart = isMobile ? null : createHeatmap(heatmapEl, timelineEl);
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

  // Map category codes for timeline filtering
  const threatLabelKeys = { "1": "missilePrefix", "2": "dronePrefix", "10": "infiltrationPrefix" };

  function updateTimelineFilter() {
    const threat = threatSelect.value;
    const zone = zoneSelect.value;

    let filtered = matched;
    if (threat !== "all") filtered = filtered.filter((d) => d.threat_type === categoryToThreat[threat]);
    if (currentCtx === "zone" && zone !== "all") {
      filtered = filtered.filter((d) => cityToZone.get(d.data) === zone);
    } else if (currentCtx === "city" && selectedCityHe) {
      filtered = filtered.filter((d) => d.data === selectedCityHe);
    }
    updateTimeline(filtered);

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
  }

  updateTimelineFilter();

  // Populate city datalist for current language
  function populateCityList() {
    cityList.innerHTML = "";
    const names = lang === "he"
      ? [...cityHeToEn.keys()].sort()
      : [...cityEnToHe.keys()].sort();
    for (const c of names) {
      const opt = document.createElement("option");
      opt.value = c;
      cityList.appendChild(opt);
    }
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
    subtitle.textContent = `${fmt(alerts.length)} ${t("totalSuffix")}`;

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
