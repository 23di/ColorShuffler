import { clamp } from "../color";
import type { ThemeFlipSettings } from "../types";
import type { ClassifiedColor, FlipDirection, FlipRole } from "./roles";

/**
 * Chroma remap — one intuitive knob:
 *
 *   accentSaturation (0..150)
 *     0   = grayscale (strip all color)
 *     100 = preserve source chroma
 *     150 = boost chroma (bounded by role cap + gamut clamp downstream)
 *
 * Per-role caps prevent oversaturated cards/text from dominating the page
 * after flipping — e.g. a bright red accent stays punchy but doesn't push
 * past OKLCH cap 0.24 where it would read as neon on white.
 */

interface ChromaCaps {
  // Hard cap applied after scaling. Keeps output inside a reasonable gamut.
  cap: number;
  // Direction-specific multiplier on top of user scale — light themes tolerate
  // slightly less chroma than dark (bright accents on white look "hot").
  directionBias: Record<FlipDirection, number>;
}

const CHROMA_ROLE_CAPS: Record<FlipRole, ChromaCaps> = {
  "surface-base": { cap: 0.02, directionBias: { toLight: 0.5, toDark: 0.8 } },
  "surface-raised": { cap: 0.02, directionBias: { toLight: 0.5, toDark: 0.8 } },
  "surface-overlay": { cap: 0.02, directionBias: { toLight: 0.5, toDark: 0.8 } },
  border: { cap: 0.04, directionBias: { toLight: 0.6, toDark: 0.8 } },
  divider: { cap: 0.04, directionBias: { toLight: 0.6, toDark: 0.8 } },
  "chromatic-surface": { cap: 0.2, directionBias: { toLight: 0.9, toDark: 1.1 } },
  "accent-chromatic": { cap: 0.24, directionBias: { toLight: 0.95, toDark: 1.15 } },
  "text-primary": { cap: 0.1, directionBias: { toLight: 0.85, toDark: 0.95 } },
  "text-secondary": { cap: 0.1, directionBias: { toLight: 0.85, toDark: 0.95 } },
  "text-decorative": { cap: 0.14, directionBias: { toLight: 0.95, toDark: 1.0 } },
  "text-on-accent": { cap: 0.12, directionBias: { toLight: 0.9, toDark: 1.0 } },
  shadow: { cap: 0.05, directionBias: { toLight: 0.5, toDark: 0.7 } },
};

export function remapChroma(
  c: ClassifiedColor,
  direction: FlipDirection,
  settings: ThemeFlipSettings,
): number {
  const saturation = clamp(settings.accentSaturation / 100, 0, 1.5);
  const rule = CHROMA_ROLE_CAPS[c.role];
  const sourceC = Math.max(0, c.sourceOklch.c);
  const scaled = sourceC * saturation * rule.directionBias[direction];
  return clamp(scaled, 0, rule.cap);
}
