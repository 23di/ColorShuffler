import {
  buildColorKey,
  normalizeHue,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
} from "../color";
import type {
  ColorMappingEntry,
  ColorRecordSummary,
  OklchColor,
  ThemeDetectionSummary,
  ThemeFlipSettings,
} from "../types";
import { remapChroma } from "./chroma";
import { remapLightness } from "./lightness";
import {
  buildSurfaceTiers,
  classifyRoles,
  type ClassifiedColor,
  type FlipDirection,
  type FlipRole,
} from "./roles";
import { resolveTextOklch } from "./text";

export type ThemeTarget = "light" | "dark";

export const DEFAULT_THEME_FLIP_SETTINGS: ThemeFlipSettings = {
  backgroundBrightness: 100,
  surfaceSeparation: 40,
  accentSaturation: 90,
  accentBrightness: 0,
  textContrast: 75,
  textWeight: 70,
  preserveButtonText: true,
};

export type { FlipRole, FlipDirection };

function isTextRole(role: FlipRole): boolean {
  return (
    role === "text-primary" ||
    role === "text-secondary" ||
    role === "text-decorative" ||
    role === "text-on-accent"
  );
}

export function deriveDirection(
  targetTheme: ThemeTarget,
  themeDetection?: ThemeDetectionSummary,
): FlipDirection {
  if (targetTheme === "light") return "toLight";
  if (targetTheme === "dark") return "toDark";
  return (themeDetection?.inferredSourceTheme ?? "light") === "dark"
    ? "toLight"
    : "toDark";
}

function transformSurface(
  c: ClassifiedColor,
  direction: FlipDirection,
  settings: ThemeFlipSettings,
): OklchColor {
  const l = remapLightness(c, direction, settings);
  const cValue = remapChroma(c, direction, settings);
  return {
    l,
    c: cValue,
    h: normalizeHue(c.sourceOklch.h),
    alpha: c.sourceOklch.alpha,
  };
}

function materialize(
  entry: ColorMappingEntry,
  oklch: OklchColor,
  targetTheme: ThemeTarget,
): ColorMappingEntry {
  const target = oklchToRgb(
    { ...oklch, alpha: entry.target.a },
    { clampToGamut: true },
  );
  target.a = entry.target.a;
  return {
    ...entry,
    target,
    targetHex: rgbToHex(target),
    targetOklch: oklch,
    reason: `Role-based theme switched to ${targetTheme}`,
  };
}

export function applyThemeFlip(
  entries: ColorMappingEntry[],
  analysisColorByKey: ReadonlyMap<string, ColorRecordSummary>,
  settings: ThemeFlipSettings,
  targetTheme: ThemeTarget,
  themeDetection?: ThemeDetectionSummary,
): ColorMappingEntry[] {
  if (entries.length === 0) return entries;

  const direction = deriveDirection(targetTheme, themeDetection);
  const classified = classifyRoles(entries, analysisColorByKey);
  buildSurfaceTiers(classified, direction);

  // Phase 1: non-text transforms (surface, chromatic, border, shadow).
  const transformedOklchByKey = new Map<string, OklchColor>();
  const entriesByKey = new Map<string, ColorMappingEntry>();

  for (const c of classified) {
    if (isTextRole(c.role)) continue;
    const next = transformSurface(c, direction, settings);
    transformedOklchByKey.set(c.entry.key, next);
    entriesByKey.set(c.entry.key, materialize(c.entry, next, targetTheme));
  }

  // Phase 2: text pass — uses transformed backgrounds.
  for (const c of classified) {
    if (!isTextRole(c.role)) continue;
    const bg = resolveTransformedBackground(
      c,
      transformedOklchByKey,
      analysisColorByKey,
      direction,
      settings,
    );
    const next = resolveTextOklch({
      classified: c,
      transformedBackgroundRgb: bg?.rgb ?? null,
      transformedBackgroundOklch: bg?.oklch ?? null,
      direction,
      settings,
    });
    entriesByKey.set(c.entry.key, materialize(c.entry, next, targetTheme));
  }

  // Preserve original order.
  return entries.map((entry) => entriesByKey.get(entry.key) ?? entry);
}

interface TransformedBackground {
  rgb: ReturnType<typeof oklchToRgb>;
  oklch: OklchColor;
}

function resolveTransformedBackground(
  c: ClassifiedColor,
  transformedOklchByKey: ReadonlyMap<string, OklchColor>,
  analysisColorByKey: ReadonlyMap<string, ColorRecordSummary>,
  direction: FlipDirection,
  settings: ThemeFlipSettings,
): TransformedBackground | null {
  const bgRgb = c.backgroundRgb;
  if (!bgRgb) return null;

  const baseKey = buildColorKey(bgRgb);
  const candidateKeys = [`${baseKey}__paint`, `${baseKey}__text`];

  for (const key of candidateKeys) {
    const transformedOklch = transformedOklchByKey.get(key);
    if (!transformedOklch) continue;
    const rgb = oklchToRgb(transformedOklch, { clampToGamut: true });
    return { rgb, oklch: transformedOklch };
  }

  // Fallback: the background color wasn't part of the mapping entries
  // (e.g., composited or outside selection). Run a surface transform
  // against it synthetically so the text still aims at the right target.
  const summary =
    analysisColorByKey.get(candidateKeys[0]) ??
    analysisColorByKey.get(candidateKeys[1]);
  const role: FlipRole =
    summary?.theme?.kind === "chromatic" ? "chromatic-surface" : "surface-base";
  const sourceOklch = rgbToOklch(bgRgb);
  const fallbackClassified: ClassifiedColor = {
    entry: {
      key: "__bg_fallback__",
      source: bgRgb,
      sourceHex: "",
      target: bgRgb,
      targetHex: "",
      targetOklch: sourceOklch,
      role: summary?.role ?? "neutral",
    },
    summary,
    role,
    sourceOklch,
    backgroundRgb: null,
    tierIndex: 0,
    tierCount: 1,
  };
  const nextOklch = transformSurface(fallbackClassified, direction, settings);
  const rgb = oklchToRgb(nextOklch, { clampToGamut: true });
  return { rgb, oklch: nextOklch };
}
