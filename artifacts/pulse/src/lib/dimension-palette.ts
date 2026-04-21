// Per-dimension color system: each dimension owns a hue (identity), and a
// 5-stop saturation/lightness ramp keyed to the stage (1..5) encodes maturity
// intensity. Pale stops = weak maturity; vivid stops = strong maturity.
//
// Shared across the Scoring page, Heatmap deliverable, and Portfolio so a
// dimension always reads as the same colour throughout Pulse.

const DIMENSION_HUE: Record<string, number> = {
  tooling: 232,
  measurement: 178,
  process: 268,
  people: 38,
  governance: 348,
  culture: 152,
};
const DEFAULT_HUE = 220;

export function dimensionHue(dimension: string): number {
  return DIMENSION_HUE[dimension.toLowerCase()] ?? DEFAULT_HUE;
}

// Fill ramp for chart wedges / heatmap tiles. Pale/desaturated at stage 1 →
// vivid at stage 5. Pairs with fill-opacity in the chart; not intended as
// foreground text.
const STAGE_FILL_RAMP: Array<{ s: number; l: number }> = [
  { s: 32, l: 68 }, // stage 1
  { s: 48, l: 60 }, // stage 2
  { s: 62, l: 52 }, // stage 3
  { s: 74, l: 46 }, // stage 4
  { s: 86, l: 42 }, // stage 5
];

// Foreground-text ramp for the big score number. Lower L at every stop so
// the tint stays legible on the card background in both light and dark mode.
// Stage progression is conveyed by saturation; lightness only nudges slightly.
const STAGE_TEXT_RAMP: Array<{ s: number; l: number }> = [
  { s: 38, l: 42 },
  { s: 55, l: 40 },
  { s: 70, l: 38 },
  { s: 82, l: 36 },
  { s: 92, l: 34 },
];

export function clampStage(stage: number): number {
  return Math.max(1, Math.min(5, Math.round(stage || 1)));
}

export function stageFill(dimension: string, stage: number): string {
  const ramp = STAGE_FILL_RAMP[clampStage(stage) - 1]!;
  return `hsl(${dimensionHue(dimension)}, ${ramp.s}%, ${ramp.l}%)`;
}

export function stageTextColor(dimension: string, stage: number): string {
  const ramp = STAGE_TEXT_RAMP[clampStage(stage) - 1]!;
  return `hsl(${dimensionHue(dimension)}, ${ramp.s}%, ${ramp.l}%)`;
}

export function identityColor(dimension: string, alpha = 1): string {
  return `hsla(${dimensionHue(dimension)}, 88%, 48%, ${alpha})`;
}
