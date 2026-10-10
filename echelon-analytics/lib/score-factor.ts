// Echelon Analytics — Bot Score Factor Display
//
// How one value of a bot_score_detail object is shown next to its label.
// Most factors are the number of points they added. A few are not: PoW
// results are strings, the correlator stores an object describing the
// cluster, and marks written by older versions may be booleans.
//
// Zero imports on purpose: islands import this.

/**
 * The text shown for a factor's value: "+N" for points, the string itself
 * for a string, the penalty of an object that carries one, and nothing (the
 * label says it all) for anything else.
 */
export function formatFactor(value: unknown): string {
  if (typeof value === "number") return `+${value}`;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const penalty = (value as Record<string, unknown>).penalty;
    if (typeof penalty === "number") return `+${penalty}`;
  }
  return "";
}
