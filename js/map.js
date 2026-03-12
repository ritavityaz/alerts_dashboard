const maplibregl = window.maplibregl;
import * as d3 from "d3";
import { lang, t } from "./i18n.js";

function renderLegend(maxCount) {
  const canvas = document.getElementById("legend-bar");
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.clientWidth;
  const w = canvas.width;
  const h = canvas.height;

  const colorScale = d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([1, maxCount]);
  for (let x = 0; x < w; x++) {
    const val = Math.pow(maxCount, x / w);
    ctx.fillStyle = colorScale(Math.max(1, val));
    ctx.fillRect(x, 0, 1, h);
  }

  document.getElementById("legend-min").textContent = "1";
  document.getElementById("legend-max").textContent = d3.format(",")(maxCount);
}

export function createMap(container, geojson, countByZone, onCityClick) {
  const height = Math.min(container.clientWidth * 1.2, 600);
  container.style.height = `${height}px`;

  const bounds = d3.geoBounds(geojson);

  // Assign stable numeric IDs to features for setFeatureState
  const featureIdByName = new Map();
  for (let i = 0; i < geojson.features.length; i++) {
    const f = geojson.features[i];
    f.id = i;
    featureIdByName.set(f.properties.name_he, i);
  }

  const map = new maplibregl.Map({
    container,
    style: "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json",
    bounds: [bounds[0], bounds[1]],
    fitBoundsOptions: { padding: 20 },
  });

  const tooltip = document.getElementById("tooltip");
  const fmt = d3.format(",");
  const emptyGeoJSON = { type: "FeatureCollection", features: [] };

  const ready = new Promise((resolve) => map.on("load", () => {
    map.addSource("zones", { type: "geojson", data: geojson, promoteId: "name_he" });

    // Use feature-state driven color via a step expression over the "bucket" state
    // bucket is a 0-255 index into our color ramp
    // Build a step expression: [0] → rampColors[0], [1] → rampColors[1], ...
    // This is too large — instead use interpolate with r/g/b channels from feature-state
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

    map.on("mousemove", "zone-fill", (e) => {
      const p = e.features[0].properties;
      const state = map.getFeatureState({ source: "zones", id: p.name_he });
      const count = state?.count || 0;
      if (count > 0) {
        map.getCanvas().style.cursor = "pointer";
        tooltip.style.display = "block";
        tooltip.style.left = `${e.originalEvent.pageX + 12}px`;
        tooltip.style.top = `${e.originalEvent.pageY - 12}px`;
        const name = lang === "he" ? p.name_he : p.name_en;
        const zone = lang === "he" ? p.zone_he : p.zone_en;
        tooltip.innerHTML = `<strong>${name}</strong><br>${zone}<br>${fmt(count)} ${t("alerts")}`;
      }
    });

    map.on("mouseleave", "zone-fill", () => {
      map.getCanvas().style.cursor = "";
      tooltip.style.display = "none";
    });

    map.on("click", "zone-fill", (e) => {
      const p = e.features[0].properties;
      const state = map.getFeatureState({ source: "zones", id: p.name_he });
      if ((state?.count || 0) > 0 && onCityClick) {
        onCityClick(p.name_he);
      }
    });

    // Apply initial counts
    applyFeatureStates(countByZone);

    resolve();
  }));

  function applyFeatureStates(countByZone, fixedMax) {
    const maxCount = fixedMax || d3.max([...countByZone.values()]) || 1;
    const colorScale = d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([1, maxCount]);

    // Clear all states first, then set new ones
    for (const f of geojson.features) {
      const name = f.properties.name_he;
      const count = countByZone.get(name) || 0;
      if (count > 0) {
        const c = d3.color(colorScale(count));
        map.setFeatureState(
          { source: "zones", id: name },
          { count, r: c.r, g: c.g, b: c.b }
        );
      } else {
        map.setFeatureState(
          { source: "zones", id: name },
          { count: 0, r: 0, g: 0, b: 0 }
        );
      }
    }

    renderLegend(maxCount);
  }

  function zoomToZone(zoneName) {
    if (!zoneName || zoneName === "all") {
      map.fitBounds([bounds[0], bounds[1]], { padding: 20 });
      return;
    }
    const matching = geojson.features.filter((f) => f.properties.zone_en === zoneName);
    if (matching.length === 0) return;
    const collection = { type: "FeatureCollection", features: matching };
    const [[x0, y0], [x1, y1]] = d3.geoBounds(collection);
    map.fitBounds([[x0, y0], [x1, y1]], { padding: 40 });
  }

  function zoomToCity(nameHe) {
    const feature = geojson.features.find((f) => f.properties.name_he === nameHe);
    if (!feature) return;
    const [[x0, y0], [x1, y1]] = d3.geoBounds(feature);
    map.fitBounds([[x0, y0], [x1, y1]], { padding: 60, maxZoom: 12 });
  }

  function highlightCity(nameHe) {
    if (!nameHe) {
      map.getSource("highlight")?.setData(emptyGeoJSON);
      return;
    }
    const feature = geojson.features.find((f) => f.properties.name_he === nameHe);
    if (!feature) {
      map.getSource("highlight")?.setData(emptyGeoJSON);
      return;
    }
    map.getSource("highlight")?.setData({ type: "FeatureCollection", features: [feature] });
  }

  return {
    ready,
    recolor: (counts, fixedMax) => applyFeatureStates(counts, fixedMax),
    zoomToZone,
    zoomToCity,
    highlightCity,
  };
}
