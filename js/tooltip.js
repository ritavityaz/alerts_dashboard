const tooltip = document.getElementById("tooltip");
const MARGIN = 8;

export function showTooltip(pageX, pageY, html) {
  tooltip.innerHTML = html;
  tooltip.style.display = "block";

  const rect = tooltip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = pageX + 12;
  let top = pageY - 12;

  // Flip left if overflowing right
  if (left + rect.width > vw - MARGIN) {
    left = pageX - rect.width - 12;
  }
  // Clamp left
  if (left < MARGIN) left = MARGIN;

  // Flip up if overflowing bottom
  if (top + rect.height > window.scrollY + vh - MARGIN) {
    top = pageY - rect.height - 12;
  }
  // Clamp top
  if (top < window.scrollY + MARGIN) top = window.scrollY + MARGIN;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

export function hideTooltip() {
  tooltip.style.display = "none";
}
