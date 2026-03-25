/**
 * Component framework — lightweight lifecycle for dashboard components.
 *
 * Each component declares which signals it needs and a render function.
 * The framework auto-discovers containers via data-component attributes,
 * wires signal subscriptions, and calls render() when data arrives.
 */

import { onSignal } from "./queries.js";

const MOBILE_BREAKPOINT = 640;
const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

/**
 * Whether the viewport is currently below the mobile breakpoint.
 */
export function isMobile() {
  return mobileQuery.matches;
}

/**
 * Subscribe to mobile/desktop transitions.
 * Listener receives (isMobile: boolean).
 * Returns an unsubscribe function.
 */
export function onViewportChange(listener) {
  const handler = (event) => listener(event.matches);
  mobileQuery.addEventListener("change", handler);
  return () => mobileQuery.removeEventListener("change", handler);
}

// Registry of component definitions, keyed by name.
const componentRegistry = new Map();

/**
 * Define a component.
 *
 * @param {string} name — matches the data-component attribute in HTML
 * @param {object} definition
 * @param {string[]} definition.signals — signal names this component subscribes to
 * @param {function} definition.render — render(element, signalData, isMobile)
 * @param {function} [definition.init] — init(element) called once on mount
 * @param {function} [definition.destroy] — destroy(element) called on teardown
 */
export function defineComponent(name, definition) {
  componentRegistry.set(name, definition);
}

/**
 * Mount all components found in the DOM.
 * Looks for elements with data-component="<name>" and wires them up.
 * Returns an array of teardown functions.
 */
export function mountAll() {
  const teardowns = [];

  for (const [name, definition] of componentRegistry) {
    const element = document.querySelector(`[data-component="${name}"]`);
    if (!element) continue;

    // Accumulate latest signal values; render once all are received
    const signalData = {};
    const expectedSignals = new Set(definition.signals);
    const receivedSignals = new Set();

    if (definition.init) {
      definition.init(element);
    }

    const signalTeardowns = definition.signals.map((signalName) =>
      onSignal(signalName, (value) => {
        signalData[signalName] = value;
        receivedSignals.add(signalName);
        // Render once all declared signals have fired at least once
        if (receivedSignals.size === expectedSignals.size) {
          definition.render(element, signalData, isMobile());
        }
      })
    );

    // Re-render on viewport change (mobile ↔ desktop)
    const viewportTeardown = onViewportChange(() => {
      if (receivedSignals.size === expectedSignals.size) {
        definition.render(element, signalData, isMobile());
      }
    });

    teardowns.push(() => {
      signalTeardowns.forEach((unsub) => unsub());
      viewportTeardown();
      if (definition.destroy) {
        definition.destroy(element);
      }
    });
  }

  return teardowns;
}
