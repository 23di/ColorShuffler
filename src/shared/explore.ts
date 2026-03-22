import {
  angleLerp,
  buildColorRoleIndex,
  buildColorKey,
  classifyColorRole,
  clamp,
  clamp01,
  detectToneBand,
  dominantHue,
  hueDistance,
  isNearNeutralChroma,
  lerp,
  normalizeHue,
  oklchToRgb,
  rgbToHex,
  normalizeNeutralThreshold,
} from "./color";
import {
  type ColorMappingEntry,
  type ColorRecordSummary,
  type ExploreSettings,
  type HuePreset,
  type HuePresetChip,
  type HueRangeSettings,
  type OklchColor,
} from "./types";

function computeHueRangeWeight(
  hue: number,
  chroma: number,
  range: HueRangeSettings,
  neutralThreshold: number,
): number {
  const calibratedThreshold = normalizeNeutralThreshold(neutralThreshold);
  if (!range.includeNeutrals && chroma < calibratedThreshold) return 0;
  if (range.preset === "neutrals") {
    return chroma < calibratedThreshold ? 1 : 0;
  }
  if (range.preset === "all" || (range.min === 0 && range.max === 360)) return 1;

  const h = normalizeHue(hue);
  const mn = normalizeHue(range.min);
  const mx = normalizeHue(range.max);

  let inRange: boolean;
  if (mn <= mx) {
    inRange = h >= mn && h <= mx;
  } else {
    inRange = h >= mn || h <= mx;
  }

  const dToMin = hueDistance(h, mn);
  const dToMax = hueDistance(h, mx);
  const minDist = Math.min(dToMin, dToMax);

  if (inRange) return 1;

  const softnessRange = Math.max(0, range.softness);
  if (softnessRange <= 0 || minDist >= softnessRange) return 0;
  return 1 - minDist / softnessRange;
}

export const DEFAULT_EXPLORE_SETTINGS: ExploreSettings = {
  exposure: 0,
  contrast: 0,
  vibrance: 0,
  saturation: 0,
  hueShift: 0,
  chromaScale: 1,
  protectNeutrals: true,
  neutralThreshold: 0.04,
  clampOutOfGamut: true,
  huePreset: "none",
  hueRange: {
    preset: "all",
    min: 0,
    max: 360,
    softness: 30,
    includeNeutrals: false,
  },
  grading: {
    shadows: { hueShift: 0, chromaScale: 1 },
    midtones: { hueShift: 0, chromaScale: 1 },
    highlights: { hueShift: 0, chromaScale: 1 },
  },
};

function resolveHuePreset(
  color: OklchColor,
  preset: HuePreset,
  dominant: number,
): number {
  switch (preset) {
    case "negative30":
      return -30;
    case "positive30":
      return 30;
    case "complementary":
      return 180;
    case "analogous":
      return normalizeHue(color.h - dominant) > 180 ? 30 : -30;
    default:
      return 0;
  }
}

function transformExploreColor(
  color: ColorRecordSummary,
  settings: ExploreSettings,
  paletteDominantHue: number,
): OklchColor {
  const source = color.oklch;
  if (settings.protectNeutrals && isNearNeutralChroma(source.c, settings.neutralThreshold)) {
    return source;
  }

  const hueWeight = settings.hueRange
    ? computeHueRangeWeight(source.h, source.c, settings.hueRange, settings.neutralThreshold)
    : 1;
  if (hueWeight <= 0) return source;

  const contrastFactor = clamp(1 + settings.contrast / 60, 0.25, 2.4);
  const band = detectToneBand(source.l);
  const bandAdjustment = settings.grading[band];

  let lightness = clamp01(source.l + settings.exposure / 100);
  lightness = clamp01(0.5 + (lightness - 0.5) * contrastFactor);

  const vibranceBoost =
    1 + (settings.vibrance / 100) * (1 - clamp(source.c / 0.26, 0, 1));
  const saturationFactor = Math.max(0, 1 + settings.saturation / 100);

  let chroma =
    source.c *
    saturationFactor *
    settings.chromaScale *
    bandAdjustment.chromaScale *
    vibranceBoost;

  chroma = Math.max(0, chroma);

  const presetHueShift = resolveHuePreset(
    source,
    settings.huePreset,
    paletteDominantHue,
  );

  const shiftedHue = normalizeHue(
    source.h + settings.hueShift + presetHueShift + bandAdjustment.hueShift,
  );

  const transformed: OklchColor = {
    l: lightness,
    c: chroma,
    h: shiftedHue,
    alpha: source.alpha,
  };

  if (hueWeight >= 1) return transformed;

  return {
    l: lerp(source.l, transformed.l, hueWeight),
    c: lerp(source.c, transformed.c, hueWeight),
    h: angleLerp(source.h, transformed.h, hueWeight),
    alpha: source.alpha,
  };
}

export function buildExploreMapping(
  colors: ColorRecordSummary[],
  settings: ExploreSettings,
  roleByKey = buildColorRoleIndex(colors, settings.neutralThreshold),
): Record<string, ColorMappingEntry> {
  const paletteDominantHue = dominantHue(colors);
  const mapping: Record<string, ColorMappingEntry> = {};

  for (const color of colors) {
    const transformed = transformExploreColor(
      color,
      settings,
      paletteDominantHue,
    );
    const target = oklchToRgb(transformed, {
      clampToGamut: settings.clampOutOfGamut,
    });

    mapping[color.key] = {
      key: color.key,
      source: color.rgb,
      sourceHex: color.hex,
      target,
      targetHex: rgbToHex(target),
      targetOklch: transformed,
      role:
        roleByKey.get(color.key) ??
        classifyColorRole(color, colors, settings.neutralThreshold),
    };
  }

  return mapping;
}

