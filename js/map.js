/**
 * Map component — MapLibre GL with feature-state driven coloring.
 *
 * Subscribes to alertCountsByCity and alertMaxCountPerCity signals.
 * Listens to store for ctx/zone/city changes to zoom accordingly.
 * Calls filters.selectCityFromMap() on map click.
 */

const maplibregl = window.maplibregl;
import * as d3 from "d3";
import { lang, t, formatNumber } from "./i18n.js";
import { showTooltip, hideTooltip } from "./tooltip.js";
import { onSignal } from "./queries.js";
import * as store from "./store.js";
import { selectCityFromMap } from "./filters.js";

let map = null;
let geojsonData = null;
let geoBounds = null;

function renderLegend(maxCount) {
  const canvas = document.getElementById("legend-bar");
  const canvasContext = canvas.getContext("2d");
  canvas.width = canvas.clientWidth;
  const width = canvas.width;
  const height = canvas.height;

  const colorScale = d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([1, maxCount]);
  for (let x = 0; x < width; x++) {
    const value = Math.pow(maxCount, x / width);
    canvasContext.fillStyle = colorScale(Math.max(1, value));
    canvasContext.fillRect(x, 0, 1, height);
  }

  document.getElementById("legend-min").innerHTML = "<bdi>1</bdi>";
  document.getElementById("legend-max").innerHTML = `<bdi>${formatNumber(maxCount)}</bdi>`;
}

/**
 * Initialize the map. Returns a promise that resolves when the map is loaded.
 */
export function initMap(container, geojson, initialCountsByCity) {
  geojsonData = geojson;
  geoBounds = d3.geoBounds(geojson);

  map = new maplibregl.Map({
    container,
    style: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",
    bounds: [geoBounds[0], geoBounds[1]],
    fitBoundsOptions: { padding: 20 },
  });

  const emptyGeoJSON = { type: "FeatureCollection", features: [] };

  return new Promise((resolve) => map.on("load", () => {
    map.addSource("zones", { type: "geojson", data: geojson, promoteId: "name_he" });

    map.addLayer({
      id: "zone-fill",
      type: "fill",
      source: "zones",
      paint: {
        "fill-color": [
          "case",
          [">", ["coalesce", ["feature-state", "count"], 0], 0],
          ["rgb",
            ["coalesce", ["feature-state", "r"], 0],
            ["coalesce", ["feature-state", "g"], 0],
            ["coalesce", ["feature-state", "b"], 0],
          ],
          "rgba(0,0,0,0)",
        ],
        "fill-opacity": 0.7,
      },
    });

    map.addSource("highlight", { type: "geojson", data: emptyGeoJSON });
    map.addLayer({
      id: "highlight-border",
      type: "line",
      source: "highlight",
      paint: { "line-color": "#00d062", "line-width": 2, "line-opacity": 1 },
    });

    // Hover tooltip
    map.on("mousemove", "zone-fill", (event) => {
      const properties = event.features[0].properties;
      const featureState = map.getFeatureState({ source: "zones", id: properties.name_he });
      const count = featureState?.count || 0;
      if (count > 0) {
        map.getCanvas().style.cursor = "pointer";
        const name = lang === "he" ? properties.name_he : properties.name_en;
        const zone = lang === "he" ? properties.zone_he : properties.zone_en;
        showTooltip(event.originalEvent.pageX, event.originalEvent.pageY,
          `<strong>${name}</strong><br>${zone}<br>${formatNumber(count)} ${t("map.alerts")}`);
      }
    });

    map.on("mouseleave", "zone-fill", () => {
      map.getCanvas().style.cursor = "";
      hideTooltip();
    });

    // Click → select city
    map.on("click", "zone-fill", (event) => {
      const properties = event.features[0].properties;
      const featureState = map.getFeatureState({ source: "zones", id: properties.name_he });
      if ((featureState?.count || 0) > 0) {
        selectCityFromMap(properties.name_he);
      }
    });

    // Apply initial counts from snapshot
    applyFeatureStates(initialCountsByCity);

    // Subscribe to signals for live updates
    // Both signals trigger re-render so order of emission doesn't matter.
    let latestCounts = null;

    function rerender() {
      if (!latestCounts) return;
      const currentMax = latestMaxCount || d3.max([...latestCounts.values()]) || 1;
      applyFeatureStates(latestCounts, currentMax);
      highlightCity(store.getState().city);
    }

    onSignal("alertCountsByCity", (countsByCity) => {
      latestCounts = countsByCity;
      rerender();
    });

    onSignal("alertMaxCountPerCity", (maxCount) => {
      latestMaxCount = maxCount;
      rerender();
    });

    // Subscribe to store for zoom changes
    store.subscribe((state, changedKeys) => {
      if (changedKeys.has("mapCtx") || changedKeys.has("zone") || changedKeys.has("city")) {
        applyZoom(state);
        highlightCity(state.city);
      }
    });

    resolve();
  }));
}

let latestMaxCount = null;

function applyFeatureStates(countsByCity, fixedMax) {
  const maxCount = fixedMax || d3.max([...countsByCity.values()]) || 1;
  const colorScale = d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([1, maxCount]);

  for (const feature of geojsonData.features) {
    const cityName = feature.properties.name_he;
    const count = countsByCity.get(cityName) || 0;
    if (count > 0) {
      const color = d3.color(colorScale(count));
      map.setFeatureState(
        { source: "zones", id: cityName },
        { count, r: color.r, g: color.g, b: color.b }
      );
    } else {
      map.setFeatureState(
        { source: "zones", id: cityName },
        { count: 0, r: 0, g: 0, b: 0 }
      );
    }
  }

  renderLegend(maxCount);
}

function applyZoom(state) {
  if (state.mapCtx === "city" && state.city) {
    zoomToCity(state.city);
  } else if (state.mapCtx === "zone" && state.zone !== "all") {
    zoomToZone(state.zone);
  } else {
    zoomToZone("all");
  }
}

function zoomToZone(zoneName) {
  if (!zoneName || zoneName === "all") {
    map.fitBounds([geoBounds[0], geoBounds[1]], { padding: 20 });
    return;
  }
  const matching = geojsonData.features.filter((feature) => feature.properties.zone_en === zoneName);
  if (matching.length === 0) return;
  const collection = { type: "FeatureCollection", features: matching };
  const [[x0, y0], [x1, y1]] = d3.geoBounds(collection);
  map.fitBounds([[x0, y0], [x1, y1]], { padding: 40 });
}

function zoomToCity(cityNameHe) {
  const feature = geojsonData.features.find((feature) => feature.properties.name_he === cityNameHe);
  if (!feature) return;
  const [[x0, y0], [x1, y1]] = d3.geoBounds(feature);
  map.fitBounds([[x0, y0], [x1, y1]], { padding: 60, maxZoom: 12 });
}

function highlightCity(cityNameHe) {
  if (!map?.getSource("highlight")) return;
  if (!cityNameHe) {
    map.getSource("highlight").setData({ type: "FeatureCollection", features: [] });
    return;
  }
  const feature = geojsonData.features.find((feature) => feature.properties.name_he === cityNameHe);
  if (!feature) {
    map.getSource("highlight").setData({ type: "FeatureCollection", features: [] });
    return;
  }
  map.getSource("highlight").setData({ type: "FeatureCollection", features: [feature] });
}
