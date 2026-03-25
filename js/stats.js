/**
 * Stats panel — subscribes to alertStats signal and updates the DOM.
 */

import { defineComponent } from "./framework.js";
import { t, formatNumber, formatDate } from "./i18n.js";

defineComponent("statsPanel", {
  signals: ["alertStats"],

  render(element, { alertStats }) {
    const stats = alertStats;

    const statTotal = element.querySelector("#stat-total");
    const statCities = element.querySelector("#stat-cities");
    const statPeakDay = element.querySelector("#stat-peak-day");
    const statPeakCount = element.querySelector("#stat-peak-count");
    const statMissiles = element.querySelector("#stat-missiles .font-bold, #stat-missiles bdi");
    const statDrones = element.querySelector("#stat-drones .font-bold, #stat-drones bdi");
    const statInfiltration = element.querySelector("#stat-infiltration .font-bold, #stat-infiltration bdi");

    if (statTotal) statTotal.innerHTML = `<bdi>${formatNumber(stats.total)}</bdi>`;
    if (statCities) statCities.innerHTML = `<bdi>${formatNumber(stats.cities)}</bdi>`;

    if (stats.peakDayMs != null) {
      if (statPeakDay) statPeakDay.textContent = formatDate(stats.peakDayMs);
      if (statPeakCount) statPeakCount.textContent = `${formatNumber(stats.peakCount)} ${t("stats.alerts")}`;
    } else {
      if (statPeakDay) statPeakDay.textContent = "—";
      if (statPeakCount) statPeakCount.textContent = "";
    }

    if (statMissiles) statMissiles.textContent = formatNumber(stats.missiles);
    if (statDrones) statDrones.textContent = formatNumber(stats.drones);
    if (statInfiltration) statInfiltration.textContent = formatNumber(stats.infiltration);
  },
});
