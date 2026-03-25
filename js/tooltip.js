import { isMobile } from "./framework.js";

const tooltip = document.getElementById("tooltip");
const MARGIN = 8;
let pinned = false;
let onUnpinCallback = null;
let bottomBarMode = false;

export function setOnUnpin(callback) {
  onUnpinCallback = callback;
}

export function showTooltip(pageX, pageY, html) {
  if (pinned) return;
  tooltip.innerHTML = html;

  // Mobile: show as bottom bar
  if (isMobile()) {
    tooltip.className = "tooltip-bottom-bar";
    tooltip.style.display = "block";
    tooltip.style.left = "";
    tooltip.style.top = "";
    bottomBarMode = true;
    return;
  }

  bottomBarMode = false;
  tooltip.className = "tooltip";
  tooltip.style.display = "block";

  const rect = tooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = pageX + 12;
  let top = pageY - 12;

  // Flip left if overflowing right
  if (left + rect.width > viewportWidth - MARGIN) {
    left = pageX - rect.width - 12;
  }
  // Clamp left
  if (left < MARGIN) left = MARGIN;

  // Flip up if overflowing bottom
  if (top + rect.height > window.scrollY + viewportHeight - MARGIN) {
    top = pageY - rect.height - 12;
  }
  // Clamp top
  if (top < window.scrollY + MARGIN) top = window.scrollY + MARGIN;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

export function hideTooltip() {
  if (pinned) return;
  tooltip.style.display = "none";
}

export function pinTooltip() {
  pinned = true;
  tooltip.style.pointerEvents = "auto";

  const closeBtn = document.createElement("span");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText = "position:absolute;top:2px;inset-inline-end:6px;cursor:pointer;font-size:14px;line-height:1;opacity:0.6";
  closeBtn.addEventListener("mouseenter", () => { closeBtn.style.opacity = "1"; });
  closeBtn.addEventListener("mouseleave", () => { closeBtn.style.opacity = "0.6"; });
  closeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    unpinTooltip();
  });
  tooltip.style.paddingInlineEnd = "20px";
  tooltip.appendChild(closeBtn);
}

export function unpinTooltip({ silent = false } = {}) {
  pinned = false;
  tooltip.style.pointerEvents = "none";
  tooltip.style.paddingInlineEnd = "";
  tooltip.style.display = "none";
  tooltip.className = "tooltip";
  if (!silent && onUnpinCallback) onUnpinCallback();
}

export function isTooltipPinned() {
  return pinned;
}

// Tap outside bottom-bar tooltip to dismiss on mobile
document.addEventListener("click", (event) => {
  if (bottomBarMode && !tooltip.contains(event.target)) {
    hideTooltip();
  }
});

// Delegated click handler for collapsible sections inside the tooltip
tooltip.addEventListener("click", (event) => {
  const toggle = event.target.closest(".tt-toggle");
  if (!toggle) return;
  event.stopPropagation();
  const target = toggle.nextElementSibling;
  if (!target || !target.classList.contains("tt-content")) return;
  const isOpen = target.style.display !== "none";
  target.style.display = isOpen ? "none" : "block";
  const arrow = toggle.querySelector(".tt-arrow");
  const isRtl = document.body.dir === "rtl";
  if (arrow) arrow.innerHTML = isOpen ? (isRtl ? "&#9664;" : "&#9654;") : "&#9660;";
});
