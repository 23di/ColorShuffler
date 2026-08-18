import { clamp, lerp } from "../color";
import type { ThemeFlipSettings } from "../types";
import type { ClassifiedColor, FlipDirection, FlipRole } from "./roles";

/**
 * Lightness remap — driven by two intuitive knobs:
 *
 *   backgroundBrightness (0..100)
 *     How close the main background goes to the pure pole (#FFF for toLight,
 *     #000 for toDark). 100 = extreme pole, 0 = soft pole (light-gray / dark-gray).
 *
 *   surfaceSeparation (0..100)
 *     How much L-distance each surface tier (base → raised → overlay → border)
 *     gets from the main background. 0 = all tiers collapse, 100 = full spread.
 *
 *   accentBrightness (-50..+50)
 *     Shifts chromatic roles (chromatic-surface, accent-chromatic) up/down
 *     independently of neutrals.
 */

// Main-bg anchor per direction.
//   pole      = where mainBg lands at brightness=100 (pure white/black)
//   soft      = where mainBg lands at brightness=0 (soft light/dark gray)
//   tierStep  = L delta per tier unit at separation=100 (sign pushes away from pole)
const SURFACE_ANCHOR = {
  toLight: { pole: 1.0, soft: 0.9, tierStep: -0.07 },
  toDark: { pole: 0.02, soft: 0.15, tierStep: 0.07 },
} as const;

// Chromatic roles float inside their own safe band, independent of tiers.
const CHROMATIC_BAND: Record<FlipDirection, { lMin: number; lMax: number }> = {
  toLight: { lMin: 0.45, lMax: 0.7 },
  toDark: { lMin: 0.55, lMax: 0.8 },
};

// Shadow target per direction (always pulled to the dark edge).
const SHADOW_BAND: Record<FlipDirection, { lMin: number; lMax: number }> = {
  toLight: { lMin: 0.05, lMax: 0.2 },
  toDark: { lMin: 0.02, lMax: 0.1 },
};

function isSurfaceRole(role: FlipRole): boolean {
  return (
    role === "surface-base" ||
    role === "surface-raised" ||
    role === "surface-overlay"
  );
}

function isChromaticRole(role: FlipRole): boolean {
  return role === "chromatic-surface" || role === "accent-chromatic";
}

// Distance from main bg in "tier units". Main bg = 0, next surface = 1, etc.
// Borders sit just past the outermost visible surface; dividers one step closer.
function surfaceTierDistance(c: ClassifiedColor): number {
  if (c.role === "border") return Math.max(c.tierCount, 3);
  if (c.role === "divider") return Math.max(c.tierCount - 1, 2);
  return c.tierIndex;
}

export function remapLightness(
  c: ClassifiedColor,
  direction: FlipDirection,
  settings: ThemeFlipSettings,
): number {
  const brightness = clamp(settings.backgroundBrightness / 100, 0, 1);
  const separation = clamp(settings.surfaceSeparation / 100, 0, 1);

  if (isSurfaceRole(c.role) || c.role === "border" || c.role === "divider") {
    const { pole, soft, tierStep } = SURFACE_ANCHOR[direction];
    const mainBg = lerp(soft, pole, brightness);
    const distance = surfaceTierDistance(c);
    const offset = distance * tierStep * separation;
    return clamp(mainBg + offset, 0, 1);
  }

  if (isChromaticRole(c.role)) {
    const band = CHROMATIC_BAND[direction];
    const shift = clamp(settings.accentBrightness / 100, -0.5, 0.5) * 0.3;
    const sourceL = clamp(c.sourceOklch.l, 0, 1);
    const srcRefMin = direction === "toLight" ? 0.35 : 0.4;
    const srcRefMax = 0.8;
    const t = clamp((sourceL - srcRefMin) / (srcRefMax - srcRefMin), 0, 1);
    const positional = lerp(band.lMin, band.lMax, t);
    return clamp(positional + shift, 0.05, 0.95);
  }

  if (c.role === "shadow") {
    const band = SHADOW_BAND[direction];
    // Stronger main bg → stronger shadow (toward the darkest edge).
    return clamp(lerp(band.lMax, band.lMin, brightness), 0, 1);
  }

  // Text roles handled separately; safe fallback.
  return clamp(c.sourceOklch.l, 0, 1);
}
