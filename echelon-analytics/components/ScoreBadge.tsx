import { isBotScore } from "../lib/bot-threshold.ts";

/** Coloured bot-score badge: high = bot, medium = suspicious, low = human. */
export function scoreBadge(score: number) {
  const cls = isBotScore(score)
    ? "bot-score-high"
    : score >= 25
    ? "bot-score-med"
    : "bot-score-low";
  return <span class={`bot-score-badge ${cls}`}>{score}</span>;
}
