/**
 * Filter UI — unified chip bar with desktop dropdowns + mobile bottom sheet.
 *
 * Chip bar is always visible. On desktop, clicking a chip opens a dropdown.
 * On mobile, clicking a chip opens the bottom sheet.
 * Time range chip is read-only and scrolls to the slider on click.
 *
 * Reads from the DOM, writes to the store. Subscribes to store for chip labels.
 */

import * as store from "./store.js";
import { lang, t, formatDateTimeRange } from "./i18n.js";
import { getTimeBounds } from "./slider.js";

let cityToZone = new Map();
let cityEnToHe = new Map();
let cityHeToEn = new Map();
let zoneEnToHe = new Map();
let cityNamesEn = [];
let cityNamesHe = [];
let zoneNamesEn = [];

// ── Public API ──

/**
 * Initialize filter UI with geojson-derived lookup data.
 */
export function init(geojson) {
  buildLookups(geojson);
  wireChips();
  wireContextToggle();
  wireDesktopDropdowns();
  wireMobileBottomSheet();
  wireLangToggle();
  subscribeToStore();
}

// ── Lookups ──

function buildLookups(geojson) {
  for (const feature of geojson.features) {
    const { name_he, name_en, zone_en, zone_he } = feature.properties;
    cityToZone.set(name_he, zone_en);
    cityEnToHe.set(name_en, name_he);
    cityHeToEn.set(name_he, name_en);
    if (zone_en && zone_he) {
      zoneEnToHe.set(zone_en, zone_he);
    }
  }
  cityNamesEn = [...cityEnToHe.keys()].sort();
  cityNamesHe = [...cityHeToEn.keys()].sort();
  zoneNamesEn = [...new Set(geojson.features.map((feature) => feature.properties.zone_en))].filter(Boolean).sort();
}

function getCityList() {
  return lang === "he" ? cityNamesHe : cityNamesEn;
}

/**
 * Resolve a city input value (English or Hebrew) to the Hebrew key used in data.
 */
export function resolveCityName(value) {
  return cityEnToHe.get(value) || (cityHeToEn.has(value) ? value : null);
}

/**
 * Get the display name for a city in the current language.
 */
export function cityDisplayName(cityHe) {
  if (lang === "he") return cityHe;
  return cityHeToEn.get(cityHe) || cityHe;
}

/**
 * Get the display name for a zone in the current language.
 */
export function zoneDisplayName(zoneEn) {
  if (lang === "he") return zoneEnToHe.get(zoneEn) || zoneEn;
  return zoneEn;
}

/**
 * Get the zone for a city (Hebrew key).
 */
export function getZoneForCity(cityHe) {
  return cityToZone.get(cityHe) || null;
}

/**
 * Called by map when a city is clicked.
 */
export function selectCityFromMap(cityHe) {
  const zone = cityToZone.get(cityHe) || "all";
  store.update({ city: cityHe, zone, ctx: "city", mapCtx: "city" });
}

// ── Helpers ──

const isMobile = () => window.matchMedia("(max-width: 639px)").matches;

const threatLabels = {
  all: "filters.allThreats",
  "1": "filters.missiles",
  "2": "filters.drones",
  "10": "filters.infiltrations",
};

function getThreatLabel(value) {
  return t(threatLabels[value] || "filters.allThreats");
}

function getZoneLabel(value) {
  if (!value || value === "all") return t("filters.allZones");
  return zoneDisplayName(value);
}

function getCityLabel(cityHe) {
  if (!cityHe) return t("filters.cityPlaceholder");
  return cityDisplayName(cityHe);
}

function getTimeRangeLabel(state) {
  const bounds = getTimeBounds();
  const startMs = state.startMs ?? bounds.minMs;
  const endMs = state.endMs ?? bounds.maxMs;
  if (!startMs && !endMs) return "—";
  return formatDateTimeRange(startMs, endMs);
}

// ── Chip bar ──

let activeDropdown = null;

function closeAllDropdowns() {
  document.querySelectorAll(".chip-dropdown").forEach((dropdown) => dropdown.classList.add("hidden"));
  activeDropdown = null;
}

function positionDropdown(chip, dropdown) {
  const rect = chip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;

  // Reset any previous inline position so we can measure natural width
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = "0px";
  dropdown.style.right = "auto";

  const dropdownWidth = dropdown.offsetWidth;

  // Align dropdown start edge with chip start edge, keep within viewport
  let left = rect.left;
  if (left + dropdownWidth > viewportWidth - 8) {
    left = viewportWidth - dropdownWidth - 8;
  }
  if (left < 8) left = 8;

  dropdown.style.left = `${left}px`;
}

function toggleDropdown(chipElement, dropdownId) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;

  if (activeDropdown === dropdownId) {
    closeAllDropdowns();
    return;
  }

  closeAllDropdowns();

  // Position before making visible to prevent layout flash
  dropdown.style.visibility = "hidden";
  dropdown.classList.remove("hidden");
  positionDropdown(chipElement, dropdown);
  dropdown.style.visibility = "";
  activeDropdown = dropdownId;

  // Focus search input if city or zone dropdown
  if (dropdownId === "dropdown-city") {
    const searchInput = document.getElementById("city-search");
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
      populateCityResults("");
    }
  } else if (dropdownId === "dropdown-zone") {
    const searchInput = document.getElementById("zone-search");
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
      populateZoneResults("");
    }
  }
}

function wireChips() {
  const chipThreat = document.getElementById("chip-threat");
  const chipZone = document.getElementById("chip-zone");
  const chipCity = document.getElementById("chip-city");
  const chipTime = document.getElementById("chip-time");
  const chipReset = document.getElementById("chip-reset");

  // On mobile, all filter chips open the bottom sheet
  // On desktop, they open their own dropdown
  chipThreat?.addEventListener("click", () => {
    if (isMobile()) {
      openBottomSheet();
    } else {
      toggleDropdown(chipThreat, "dropdown-threat");
    }
  });

  chipZone?.addEventListener("click", () => {
    if (isMobile()) {
      openBottomSheet();
    } else {
      toggleDropdown(chipZone, "dropdown-zone");
    }
  });

  chipCity?.addEventListener("click", () => {
    if (isMobile()) {
      openBottomSheet();
    } else {
      toggleDropdown(chipCity, "dropdown-city");
    }
  });

  // Time chip opens time range dropdown
  chipTime?.addEventListener("click", () => {
    syncTimeInputsFromStore();
    toggleDropdown(chipTime, "dropdown-time");
  });

  chipReset?.addEventListener("click", () => {
    closeAllDropdowns();
    store.reset();
  });

  // Close dropdowns when clicking outside
  document.addEventListener("click", (event) => {
    if (!activeDropdown) return;
    const isChipClick = event.target.closest(".filter-chip");
    const isDropdownClick = event.target.closest(".chip-dropdown");
    if (!isChipClick && !isDropdownClick) {
      closeAllDropdowns();
    }
  });
}

// ── Context toggle ──

function wireContextToggle() {
  const toggle = document.getElementById("context-toggle");
  if (!toggle) return;

  toggle.addEventListener("click", (event) => {
    const btn = event.target.closest(".ctx-btn");
    if (!btn) return;
    store.update({ mapCtx: btn.dataset.ctx });
  });
}

function updateContextToggle(state) {
  const toggle = document.getElementById("context-toggle");
  if (!toggle) return;

  // Show only when a city is selected
  toggle.classList.toggle("hidden", !state.city);

  // Highlight active context button
  for (const btn of toggle.querySelectorAll(".ctx-btn")) {
    const isActive = btn.dataset.ctx === state.mapCtx;
    btn.classList.toggle("active", isActive);
    btn.classList.toggle("bg-indigo-600", isActive);
    btn.classList.toggle("text-white", isActive);
    btn.classList.toggle("bg-gray-800", !isActive);
    btn.classList.toggle("text-gray-400", !isActive);
  }
}

// ── Desktop dropdowns ──

function wireDesktopDropdowns() {
  // Threat dropdown
  const threatDropdown = document.getElementById("dropdown-threat");
  if (threatDropdown) {
    threatDropdown.addEventListener("click", (event) => {
      const item = event.target.closest(".chip-dropdown-item");
      if (!item) return;
      store.update({ threat: item.dataset.value });
      closeAllDropdowns();
    });
  }

  // Zone dropdown (searchable list)
  const zoneSearch = document.getElementById("zone-search");
  const zoneResults = document.getElementById("zone-results");
  if (zoneSearch && zoneResults) {
    zoneSearch.addEventListener("input", () => {
      populateZoneResults(zoneSearch.value);
    });

    zoneResults.addEventListener("click", (event) => {
      const li = event.target.closest("li");
      if (!li) return;
      const zoneValue = li.dataset.value;
      if (zoneValue !== "all") {
        store.update({ zone: zoneValue, city: null, ctx: "zone", mapCtx: "zone" });
      } else {
        store.update({ zone: "all", city: null, ctx: "country", mapCtx: "country" });
      }
      closeAllDropdowns();
    });
  }

  // City dropdown
  const citySearch = document.getElementById("city-search");
  const cityResults = document.getElementById("city-results");
  if (citySearch && cityResults) {
    citySearch.addEventListener("input", () => {
      populateCityResults(citySearch.value);
    });

    cityResults.addEventListener("click", (event) => {
      const li = event.target.closest("li");
      if (!li) return;
      const cityName = li.textContent;
      const cityHe = resolveCityName(cityName);
      if (!cityHe) return;
      const zone = cityToZone.get(cityHe) || "all";
      store.update({ city: cityHe, zone, ctx: "city", mapCtx: "city" });
      closeAllDropdowns();
    });
  }

  // Time range dropdown — presets + datetime inputs
  const timeDropdown = document.getElementById("dropdown-time");
  const timeStartInput = document.getElementById("time-start");
  const timeEndInput = document.getElementById("time-end");

  if (timeDropdown) {
    // Preset buttons
    timeDropdown.addEventListener("click", (event) => {
      const preset = event.target.closest(".time-preset");
      if (!preset) return;
      const range = computePresetRange(preset.dataset.value);
      store.update({ startMs: range.startMs, endMs: range.endMs });
      syncTimeInputsFromStore();
      highlightActivePreset();
      closeAllDropdowns();
    });

    // Date-time inputs — apply on change
    timeStartInput?.addEventListener("change", () => {
      applyTimeInputs();
    });
    timeEndInput?.addEventListener("change", () => {
      applyTimeInputs();
    });
  }
}

// ── Time range helpers ──

/**
 * Convert a UTC epoch ms to an Israel-time datetime-local string (YYYY-MM-DDTHH:MM).
 */
function utcMsToLocalInputValue(utcMs) {
  const date = new Date(utcMs);
  const israelString = date.toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" });
  // "sv-SE" gives "YYYY-MM-DD HH:MM:SS" format
  return israelString.slice(0, 16).replace(" ", "T");
}

/**
 * Convert an Israel-time datetime-local string back to UTC epoch ms.
 */
function localInputValueToUtcMs(localValue) {
  // localValue is "YYYY-MM-DDTHH:MM" in Israel time
  // Create a date in Israel time by parsing and adjusting
  const [datePart, timePart] = localValue.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  // Use Intl to find the UTC offset for this Israel time
  const approxUtc = new Date(year, month - 1, day, hour, minute);
  const israelString = approxUtc.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" });
  const israelDate = new Date(israelString);
  const offsetMs = israelDate.getTime() - approxUtc.getTime();

  return approxUtc.getTime() - offsetMs;
}

function syncTimeInputsFromStore() {
  const timeStartInput = document.getElementById("time-start");
  const timeEndInput = document.getElementById("time-end");
  if (!timeStartInput || !timeEndInput) return;

  const state = store.getState();
  const bounds = getTimeBounds();
  const startMs = state.startMs ?? bounds.minMs;
  const endMs = state.endMs ?? bounds.maxMs;

  timeStartInput.value = utcMsToLocalInputValue(startMs);
  timeEndInput.value = utcMsToLocalInputValue(endMs);
  timeStartInput.min = utcMsToLocalInputValue(bounds.minMs);
  timeStartInput.max = utcMsToLocalInputValue(bounds.maxMs);
  timeEndInput.min = utcMsToLocalInputValue(bounds.minMs);
  timeEndInput.max = utcMsToLocalInputValue(bounds.maxMs);

  highlightActivePreset();
}

function applyTimeInputs() {
  const timeStartInput = document.getElementById("time-start");
  const timeEndInput = document.getElementById("time-end");
  if (!timeStartInput?.value || !timeEndInput?.value) return;

  const startMs = localInputValueToUtcMs(timeStartInput.value);
  const endMs = localInputValueToUtcMs(timeEndInput.value);
  const bounds = getTimeBounds();

  // If inputs match full range, clear to null (= "all time")
  const isFullRange = Math.abs(startMs - bounds.minMs) < 3600000 && Math.abs(endMs - bounds.maxMs) < 3600000;
  store.update({
    startMs: isFullRange ? null : startMs,
    endMs: isFullRange ? null : endMs,
  });
  highlightActivePreset();
}

function computePresetRange(preset) {
  const now = new Date();
  const israelNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const todayStart = new Date(israelNow.getFullYear(), israelNow.getMonth(), israelNow.getDate());
  // Convert Israel midnight back to UTC
  const offsetMs = israelNow.getTime() - now.getTime();

  switch (preset) {
    case "today":
      return { startMs: todayStart.getTime() - offsetMs, endMs: null };
    case "yesterday": {
      const yesterdayStart = new Date(todayStart.getTime() - 86400000);
      return { startMs: yesterdayStart.getTime() - offsetMs, endMs: todayStart.getTime() - offsetMs };
    }
    case "3d": {
      const threeDaysAgo = new Date(todayStart.getTime() - 3 * 86400000);
      return { startMs: threeDaysAgo.getTime() - offsetMs, endMs: null };
    }
    case "7d": {
      const sevenDaysAgo = new Date(todayStart.getTime() - 7 * 86400000);
      return { startMs: sevenDaysAgo.getTime() - offsetMs, endMs: null };
    }
    case "all":
    default:
      return { startMs: null, endMs: null };
  }
}

function highlightActivePreset() {
  const presets = document.querySelectorAll("#dropdown-time .time-preset");
  const state = store.getState();
  for (const preset of presets) {
    const range = computePresetRange(preset.dataset.value);
    const isActive = state.startMs === range.startMs && state.endMs === range.endMs;
    preset.classList.toggle("active", isActive);
  }
}

function populateZoneResults(filterText) {
  const zoneResults = document.getElementById("zone-results");
  if (!zoneResults) return;

  const query = filterText.toLowerCase();
  const state = store.getState();

  // Build zone list with display names for filtering
  const zones = zoneNamesEn.map((zoneEn) => ({
    value: zoneEn,
    label: zoneDisplayName(zoneEn),
  }));

  const matches = query
    ? zones.filter((zone) => zone.label.toLowerCase().includes(query)).sort((a, b) => {
        const aStarts = a.label.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.label.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.label.localeCompare(b.label);
      })
    : zones;

  zoneResults.innerHTML = "";

  // "All zones" option (only when not filtering)
  if (!query) {
    const allLi = document.createElement("li");
    allLi.textContent = t("filters.allZones");
    allLi.dataset.value = "all";
    if (state.zone === "all") allLi.classList.add("selected");
    zoneResults.appendChild(allLi);
  }

  for (const zone of matches) {
    const li = document.createElement("li");
    li.textContent = zone.label;
    li.dataset.value = zone.value;
    if (state.zone === zone.value) li.classList.add("selected");
    zoneResults.appendChild(li);
  }
}

function populateCityResults(filterText) {
  const cityResults = document.getElementById("city-results");
  if (!cityResults) return;

  const list = getCityList();
  const query = filterText.toLowerCase();
  const matches = query
    ? list.filter((city) => city.toLowerCase().includes(query)).sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.localeCompare(b);
      })
    : list;

  cityResults.innerHTML = "";
  for (const city of matches) {
    const li = document.createElement("li");
    li.textContent = city;
    cityResults.appendChild(li);
  }
}

// ── Mobile bottom sheet ──

let sheetViewportCleanup = null;

function openBottomSheet() {
  const backdrop = document.getElementById("filter-backdrop");
  const sheet = document.getElementById("filter-sheet");
  if (!backdrop || !sheet) return;

  // Track visual viewport to resize sheet when keyboard opens/closes
  if (sheetViewportCleanup) sheetViewportCleanup();
  if (window.visualViewport) {
    const onResize = () => {
      sheet.style.maxHeight = `${window.visualViewport.height * 0.85}px`;
    };
    onResize();
    window.visualViewport.addEventListener("resize", onResize);
    sheetViewportCleanup = () => {
      window.visualViewport.removeEventListener("resize", onResize);
      sheet.style.maxHeight = "";
      sheetViewportCleanup = null;
    };
  }

  // Sync bottom sheet UI with current store state
  const state = store.getState();

  const threatChips = document.querySelectorAll("#mobile-threat-chips button");
  for (const chip of threatChips) {
    const isActive = chip.dataset.value === state.threat;
    chip.classList.toggle("bg-indigo-600", isActive);
    chip.classList.toggle("text-white", isActive);
    chip.classList.toggle("bg-gray-800", !isActive);
    chip.classList.toggle("text-gray-400", !isActive);
  }

  const cityInput = document.getElementById("mobile-city-filter");
  if (cityInput) cityInput.value = state.city ? cityDisplayName(state.city) : "";

  const zoneSelect = document.getElementById("mobile-zone-filter");
  if (zoneSelect) {
    populateMobileZoneSelect(zoneSelect);
    zoneSelect.value = state.zone;
  }

  backdrop.classList.add("open");
  sheet.classList.add("open");
}

function closeBottomSheet() {
  const backdrop = document.getElementById("filter-backdrop");
  const sheet = document.getElementById("filter-sheet");
  if (backdrop) backdrop.classList.remove("open");
  if (sheet) sheet.classList.remove("open");
  if (sheetViewportCleanup) sheetViewportCleanup();
}

function populateMobileZoneSelect(select) {
  // Keep the first "All zones" option, clear the rest
  while (select.options.length > 1) select.remove(1);
  for (const zoneEn of zoneNamesEn) {
    const option = document.createElement("option");
    option.value = zoneEn;
    option.textContent = zoneDisplayName(zoneEn);
    select.appendChild(option);
  }
}

function showMobileCityDropdown(input, dropdown, filterText) {
  const list = getCityList();
  const query = filterText.toLowerCase();
  const matches = query
    ? list.filter((city) => city.toLowerCase().includes(query)).sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.localeCompare(b);
      })
    : list;

  dropdown.innerHTML = "";
  for (const city of matches.slice(0, 50)) {
    const li = document.createElement("li");
    li.textContent = city;
    li.className = "px-3 py-1.5 cursor-pointer hover:bg-gray-700 text-gray-200";
    li.addEventListener("mousedown", (event) => {
      event.preventDefault();
      input.value = city;
      dropdown.classList.add("hidden");
      input.dispatchEvent(new Event("change"));
    });
    dropdown.appendChild(li);
  }
  dropdown.classList.toggle("hidden", matches.length === 0);
}

function wireMobileBottomSheet() {
  const backdrop = document.getElementById("filter-backdrop");
  const sheet = document.getElementById("filter-sheet");
  const applyButton = document.getElementById("mobile-apply");
  const resetButton = document.getElementById("mobile-reset");
  const threatChips = document.querySelectorAll("#mobile-threat-chips button");
  const cityInput = document.getElementById("mobile-city-filter");
  const cityDropdown = document.getElementById("mobile-city-dropdown");

  if (!sheet) return;

  // Pending state — only applied on "Apply"
  let pendingThreat = "all";

  backdrop?.addEventListener("click", closeBottomSheet);

  // Threat chips
  for (const chip of threatChips) {
    chip.addEventListener("click", () => {
      pendingThreat = chip.dataset.value;
      for (const otherChip of threatChips) {
        const isActive = otherChip === chip;
        otherChip.classList.toggle("bg-indigo-600", isActive);
        otherChip.classList.toggle("text-white", isActive);
        otherChip.classList.toggle("bg-gray-800", !isActive);
        otherChip.classList.toggle("text-gray-400", !isActive);
      }
    });
  }

  // City autocomplete
  cityInput?.addEventListener("input", () => showMobileCityDropdown(cityInput, cityDropdown, cityInput.value));
  cityInput?.addEventListener("focus", () => showMobileCityDropdown(cityInput, cityDropdown, cityInput.value));
  cityInput?.addEventListener("blur", () => {
    setTimeout(() => cityDropdown?.classList.add("hidden"), 150);
  });

  // Apply
  applyButton?.addEventListener("click", () => {
    const zoneSelect = document.getElementById("mobile-zone-filter");
    const pendingZone = zoneSelect?.value || "all";
    const cityHe = resolveCityName(cityInput?.value || "");
    const zone = pendingZone !== "all" ? pendingZone : (cityHe ? (cityToZone.get(cityHe) || "all") : "all");
    const ctx = cityHe ? "city" : (zone !== "all" ? "zone" : "country");

    store.update({
      threat: pendingThreat,
      city: cityHe || null,
      zone,
      ctx,
      mapCtx: ctx,
    });
    closeBottomSheet();
  });

  // Reset
  resetButton?.addEventListener("click", () => {
    store.reset();
    closeBottomSheet();
  });

  // Touch drag to dismiss (only when scrolled to top)
  let touchStartY = 0;
  let currentTranslateY = 0;
  let allowDrag = false;

  sheet.addEventListener("touchstart", (event) => {
    allowDrag = sheet.scrollTop <= 0;
    touchStartY = event.touches[0].clientY;
    currentTranslateY = 0;
    sheet.style.transition = "none";
  });

  sheet.addEventListener("touchmove", (event) => {
    if (!allowDrag) return;
    const deltaY = event.touches[0].clientY - touchStartY;
    if (deltaY > 0) {
      currentTranslateY = deltaY;
      sheet.style.transform = `translateY(${deltaY}px)`;
      event.preventDefault();
    }
  }, { passive: false });

  sheet.addEventListener("touchend", () => {
    sheet.style.transition = "";
    if (currentTranslateY > 100) {
      closeBottomSheet();
    }
    sheet.style.transform = "";
  });
}

// ── Language toggle ──

function wireLangToggle() {
  const langLinks = document.querySelectorAll("#lang-toggle a");
  for (const link of langLinks) {
    const isActive = link.dataset.lang === lang;
    link.classList.toggle("bg-indigo-600", isActive);
    link.classList.toggle("text-white", isActive);
    link.classList.toggle("bg-gray-800", !isActive);
    link.classList.toggle("text-gray-400", !isActive);

    link.addEventListener("click", (event) => {
      event.preventDefault();
      const state = store.getState();
      const params = new URLSearchParams();
      if (state.threat !== "all") params.set("threat", state.threat);
      if (state.zone !== "all") params.set("zone", state.zone);
      if (state.city) params.set("city", state.city);
      if (state.startMs != null) params.set("startMs", state.startMs);
      if (state.endMs != null) params.set("endMs", state.endMs);
      const search = params.toString() ? `?${params}` : "";
      window.location.href = `/${link.dataset.lang}/${search}`;
    });
  }
}

// ── Store subscription — update chip labels reactively ──

function subscribeToStore() {
  const chipThreat = document.getElementById("chip-threat");
  const chipZone = document.getElementById("chip-zone");
  const chipCity = document.getElementById("chip-city");
  const chipTime = document.getElementById("chip-time");
  const chipReset = document.getElementById("chip-reset");

  function updateChips(state) {
    // Update chip labels
    const threatLabel = chipThreat?.querySelector(".chip-label");
    if (threatLabel) threatLabel.textContent = getThreatLabel(state.threat);

    const zoneLabel = chipZone?.querySelector(".chip-label");
    if (zoneLabel) zoneLabel.textContent = getZoneLabel(state.zone);

    const cityLabel = chipCity?.querySelector(".chip-label");
    if (cityLabel) cityLabel.textContent = getCityLabel(state.city);

    const timeLabel = chipTime?.querySelector(".chip-label");
    if (timeLabel) timeLabel.textContent = getTimeRangeLabel(state);

    // Toggle "active" style on chips with non-default values
    chipThreat?.classList.toggle("active", state.threat !== "all");
    chipZone?.classList.toggle("active", state.zone !== "all");
    chipCity?.classList.toggle("active", !!state.city);
    chipTime?.classList.toggle("active", state.startMs != null || state.endMs != null);

    // Show/hide reset chip
    const isDefault = state.threat === "all"
      && state.zone === "all"
      && !state.city
      && state.startMs == null
      && state.endMs == null;
    chipReset?.classList.toggle("hidden", isDefault);

    // Update context toggle visibility and active state
    updateContextToggle(state);
  }

  // Set initial chip labels
  updateChips(store.getState());

  // Update on every store change
  store.subscribe(updateChips);
}
