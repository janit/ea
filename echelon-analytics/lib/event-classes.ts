// Echelon Analytics — Event Classes
//
// Every semantic event type is either INTERACTION (its presence proves the
// visitor did something: a gesture) or PASSIVE (a page load, or a visitor who
// lands, reads and leaves, emits it with no gesture at all). The view
// validator and the engagement gate treat only interaction events as
// evidence of a human.
//
// Both sets are written out, and the allowed list is their union, so a new
// event type cannot exist without being classified. When adding one, the
// question is: "can a headless page load emit this without a gesture?" If
// yes, it is passive. tests/event-classes_test.ts snapshots the partition so
// a change here is always deliberate.
//
// Zero imports on purpose: islands may import this.

/** Lifecycle and telemetry. Never proof of a human. */
export const PASSIVE_EVENTS: ReadonlySet<string> = new Set([
  "bounce",
  "session_end",
  "session_resume",
  // Scrolling is trivially scripted and a scroll-only visit is still a
  // land-and-leave visit.
  "scroll_depth",
  "web_vital",
  // Site-defined via echelon.track(); it may be fired from a button or from
  // page load, and Echelon cannot tell which. `engage` covers real gestures.
  "custom",
]);

/** Fired from a trusted user gesture. */
export const INTERACTION_EVENTS: ReadonlySet<string> = new Set([
  // Once per pageview, on the first pointerdown / keydown / touchstart.
  "engage",
  "click",
  "ad_click",
  "form_focus",
  "form_blur",
  "form_submit",
  "hover",
  "outbound",
  "download",
]);

/** Every event type POST /e accepts. */
export const ALLOWED_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...PASSIVE_EVENTS,
  ...INTERACTION_EVENTS,
]);

/** True if this event type is proof of a gesture. */
export function isInteractionEvent(type: string): boolean {
  return INTERACTION_EVENTS.has(type);
}

/**
 * INTERACTION_EVENTS as a quoted list for `event_type IN (...)`. Built from
 * the compile-time constants above — never interpolate request data with it.
 */
export const INTERACTION_SQL_LIST: string = [...INTERACTION_EVENTS]
  .sort()
  .map((t) => `'${t}'`)
  .join(", ");
