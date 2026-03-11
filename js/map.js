import maplibregl from "maplibre-gl";
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

function applyColors(geojson, countByZone, fixedMax) {
  const maxCount = fixedMax || d3.max([...countByZone.values()]) || 1;
  const colorScale = d3.scaleSequentialLog(d3.interpolateYlOrRd).domain([1, maxCount]);

  for (const f of geojson.features) {
    const count = countByZone.get(f.properties.name_he) || 0;
    f.properties.alertCount = count;
    f.properties.color = count > 0 ? d3.color(colorScale(count)).formatHex() : "rgba(0,0,0,0)";
  }

  renderLegend(maxCount);
}

function recolor(map, geojson, countByZone, fixedMax) {
  applyColors(geojson, countByZone, fixedMax);
  map.getSource("zones").setData(geojson);
}

export function createMap(container, geojson, countByZone, onCityClick) {
  const height = Math.min(container.clientWidth * 1.2, 600);
  container.style.height = `${height}px`;

  const bounds = d3.geoBounds(geojson);

  applyColors(geojson, countByZone);

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
    map.addSource("zones", { type: "geojson", data: geojson });
    map.addLayer({
      id: "zone-fill",
      type: "fill",
      source: "zones",
      paint: { "fill-color": ["get", "color"], "fill-opacity": 0.7 },
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
      if (p.alertCount > 0) {
        map.getCanvas().style.cursor = "pointer";
        tooltip.style.display = "block";
        tooltip.style.left = `${e.originalEvent.pageX + 12}px`;
        tooltip.style.top = `${e.originalEvent.pageY - 12}px`;
        const name = lang === "he" ? p.name_he : p.name_en;
        const zone = lang === "he" ? p.zone_he : p.zone_en;
        tooltip.innerHTML = `<strong>${name}</strong><br>${zone}<br>${fmt(p.alertCount)} ${t("alerts")}`;
      }
    });

    map.on("mouseleave", "zone-fill", () => {
      map.getCanvas().style.cursor = "";
      tooltip.style.display = "none";
    });

    map.on("click", "zone-fill", (e) => {
      const p = e.features[0].properties;
      if (p.alertCount > 0 && onCityClick) {
        onCityClick(p.name_he);
      }
    });

    resolve();
  }));

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
    recolor: (counts, fixedMax) => recolor(map, geojson, counts, fixedMax),
    zoomToZone,
    zoomToCity,
    highlightCity,
  };
}
