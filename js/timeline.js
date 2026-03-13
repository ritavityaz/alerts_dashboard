import * as d3 from "d3";
import { lang, t } from "./i18n.js";

function toFractionalHour(date) {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

function dayslice(alerts) {
  const slices = [];
  for (const a of alerts) {
    if (!a._end) {
      slices.push({ ...a, day: d3.timeDay(a._start), y0: toFractionalHour(a._start), y1: null });
      continue;
    }

    let cursor = new Date(a._start);
    const end = a._end;

    while (cursor < end) {
      const day = d3.timeDay(cursor);
      const nextDay = d3.timeDay.offset(day, 1);
      const sliceEnd = end < nextDay ? end : nextDay;

      slices.push({
        ...a,
        day,
        y0: toFractionalHour(cursor),
        y1: cursor < sliceEnd ? toFractionalHour(sliceEnd === nextDay ? new Date(nextDay - 1) : sliceEnd) : null,
      });

      cursor = nextDay;
    }
  }
  return slices;
}

const threatColors = {
  missiles: "#ef4444",
  drones: "#8b5cf6",
  terrorists: "#f59e0b",
};

export function createTimeline(container, allAlerts) {
  const yAxisWidth = 44;
  const margin = { top: 30, right: 16, bottom: 16 };
  const height = 600;

  // Fixed day domain from all alerts
  const days = [...new Set(allAlerts.map((a) => +d3.timeDay(a._start)))].sort((a, b) => a - b).map((d) => new Date(d));

  // Color legend
  const threatI18nKeys = {
    missiles: "timelineMissiles",
    drones: "timelineDrones",
    terrorists: "timelineTerrorists",
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
    .text(d3.timeFormat("%b"));

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
  const tooltip = document.getElementById("tooltip");
  const timeFmt = d3.timeFormat("%H:%M");

  function update(alerts) {
    const slices = dayslice(alerts);

    const ranged = slices.filter((d) => d.y1 !== null);
    dataGroup.selectAll(".alert-bar")
      .data(ranged)
      .join("rect")
      .attr("class", "alert-bar")
      .attr("x", (d) => x(d.day))
      .attr("width", x.bandwidth())
      .attr("y", (d) => y(d.y0))
      .attr("height", (d) => Math.max(1, y(d.y1) - y(d.y0)))
      .attr("fill", (d) => threatColors[d.threat_type] || "#6366f1")
      .attr("fill-opacity", 0.5)
      .attr("rx", 1)
      .on("mousemove", (event, d) => {
        tooltip.style.display = "block";
        tooltip.style.left = `${event.pageX + 12}px`;
        tooltip.style.top = `${event.pageY - 12}px`;
        const startStr = timeFmt(d._start);
        const endStr = d._end ? timeFmt(d._end) : "";
        const name = lang === "he" ? (d.NAME_HE || d.data) : (d.NAME_EN || d.data);
        const threat = t(threatI18nKeys[d.threat_type]);
        tooltip.innerHTML = `<strong>${name}</strong><br>${threat}<br>${startStr}${endStr ? " – " + endStr : ""}`;
      })
      .on("mouseleave", () => { tooltip.style.display = "none"; });

    const dots = slices.filter((d) => d.y1 === null);
    dataGroup.selectAll(".alert-dot")
      .data(dots)
      .join("circle")
      .attr("class", "alert-dot")
      .attr("cx", (d) => x(d.day) + x.bandwidth() / 2)
      .attr("cy", (d) => y(d.y0))
      .attr("r", Math.min(x.bandwidth() / 3, 3))
      .attr("fill", (d) => threatColors[d.threat_type] || "#6366f1")
      .attr("fill-opacity", 0.7)
      .on("mousemove", (event, d) => {
        tooltip.style.display = "block";
        tooltip.style.left = `${event.pageX + 12}px`;
        tooltip.style.top = `${event.pageY - 12}px`;
        const name = lang === "he" ? (d.NAME_HE || d.data) : (d.NAME_EN || d.data);
        const threat = t(threatI18nKeys[d.threat_type]);
        tooltip.innerHTML = `<strong>${name}</strong><br>${threat}<br>${timeFmt(d._start)}`;
      })
      .on("mouseleave", () => { tooltip.style.display = "none"; });
  }

  update(allAlerts);

  // Scroll to the end so the most recent days (including today) are visible
  requestAnimationFrame(() => {
    const node = scrollDiv.node();
    node.scrollLeft = node.scrollWidth;
  });

  const highlightGroup = svg.append("g");

  function highlightGap(startMs, endMs) {
    highlightGroup.selectAll("*").remove();
    if (startMs == null || endMs == null) return;
    const start = new Date(startMs);
    const end = new Date(endMs);

    for (const day of days) {
      const dayStart = day;
      const dayEnd = d3.timeDay.offset(day, 1);
      if (+dayEnd <= startMs || +dayStart >= endMs) continue;

      const colX = x(day);
      if (colX == null) continue;

      const hourFrom = +dayStart < startMs ? toFractionalHour(start) : 0;
      const hourTo = +dayEnd > endMs ? toFractionalHour(end) : 24;

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
