import { calculateApcaContrast } from "./apca";
import {
  buildColorKey,
  clamp,
  lerp,
  normalizeHue,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
} from "./color";
import type {
  ColorMappingEntry,
  ColorRecordSummary,
  OklchColor,
  SerializedColor,
  ThemeFlipSettings,
} from "./types";

export type ThemeTarget = "light" | "dark";

export const DEFAULT_THEME_FLIP_SETTINGS: ThemeFlipSettings = {
  surfaceDepth: 30,
  surfaceContrast: 0,
  chromaticDepth: 70,
  chromaPreservation: 100,
  textDepth: 100,
  textMinContrast: 90,
  preserveColorForeground: false,
};

const DECORATIVE_TEXT_MAX_CONTRAST = 15;

interface LightnessTransformOptions {
  minLightness: number;
  maxLightness: number;
  minStrength: number;
  maxStrength: number;
  curveStart: number;
  curveEnd: number;
}

function resolveBackgroundEntry(
  color: ColorRecordSummary | undefined,
  entryByKey: ReadonlyMap<string, ColorMappingEntry>,
): ColorMappingEntry | null {
  if (!color?.theme?.textBackground) return null;
  const key = `${buildColorKey(color.theme.textBackground)}__paint`;
  return entryByKey.get(key) ?? null;
}

function resolveBackgroundSummary(
  color: ColorRecordSummary | undefined,
  analysisColorByKey: ReadonlyMap<string, ColorRecordSummary>,
): ColorRecordSummary | undefined {
  if (!color?.theme?.textBackground) return undefined;
  const paintKey = `${buildColorKey(color.theme.textBackground)}__paint`;
  const textKey = `${buildColorKey(color.theme.textBackground)}__text`;
  return analysisColorByKey.get(paintKey) ?? analysisColorByKey.get(textKey);
}

function isTextLike(color: ColorRecordSummary | undefined): boolean {
  const sourceKinds = color?.sourceKinds ?? [];
  return sourceKinds.some((kind) => kind === "text" || kind === "gradient-text");
}

function isStrokeLike(color: ColorRecordSummary | undefined): boolean {
  const sourceKinds = color?.sourceKinds ?? [];
  return (
    sourceKinds.length > 0 &&
    sourceKinds.every((kind) => kind === "stroke" || kind === "gradient-stroke")
  );
}

function isEffectLike(color: ColorRecordSummary | undefined): boolean {
  const sourceKinds = color?.sourceKinds ?? [];
  return sourceKinds.length > 0 && sourceKinds.every((kind) => kind === "effect");
}

function isNeutralLike(base: OklchColor, color: ColorRecordSummary | undefined): boolean {
  return base.c <= 0.04 || color?.theme?.kind === "neutral";
}

function compositeOver(
  foreground: SerializedColor,
  background: SerializedColor,
): SerializedColor {
  const alpha = clamp(foreground.a, 0, 1);
  const inverseAlpha = 1 - alpha;
  return {
    r: foreground.r * alpha + background.r * inverseAlpha,
    g: foreground.g * alpha + background.g * inverseAlpha,
    b: foreground.b * alpha + background.b * inverseAlpha,
    a: 1,
  };
}

function calculateVisibleTextContrast(
  textColor: SerializedColor,
  backgroundColor: SerializedColor,
): number {
  const opaqueBackground = { ...backgroundColor, a: 1 };
  const visibleText =
    textColor.a < 0.999 ? compositeOver(textColor, opaqueBackground) : { ...textColor, a: 1 };
  return Math.abs(calculateApcaContrast(visibleText, opaqueBackground));
}

function mirrorRoleLightness(
  lightness: number,
  depth: number,
  contrast: number,
  options: LightnessTransformOptions,
): number {
  const amount = clamp(depth / 100, 0, 2);
  if (amount <= 0.001) {
    return clamp(lightness, options.minLightness, options.maxLightness);
  }

  const distance = lightness - 0.5;
  if (Math.abs(distance) <= 0.0001) {
    return 0.5;
  }

  const normalizedDistance = clamp(Math.abs(distance) / 0.5, 0, 1);
  const curve = lerp(options.curveStart, options.curveEnd, amount);
  const shapedDistance = Math.pow(normalizedDistance, curve) * 0.5;
  const strength =
    lerp(options.minStrength, options.maxStrength, amount) *
    (1 + clamp(contrast / 100, -1, 1) * 0.35);
  const mirrored = 0.5 - Math.sign(distance) * shapedDistance * strength;

  return clamp(mirrored, options.minLightness, options.maxLightness);
}

function transformStrokeOklch(
  base: OklchColor,
  color: ColorRecordSummary | undefined,
  settings: ThemeFlipSettings,
): OklchColor {
  const preserve = clamp(settings.chromaPreservation / 100, 0, 1);
  const neutralLike = isNeutralLike(base, color);

  return {
    ...base,
    l: mirrorRoleLightness(base.l, settings.surfaceDepth, settings.surfaceContrast, {
      minLightness: 0.1,
      maxLightness: 0.9,
      minStrength: 0.72,
      maxStrength: 0.88,
      curveStart: 1.12,
      curveEnd: 1.22,
    }),
    c: neutralLike
      ? Math.min(base.c, 0.018)
      : clamp(lerp(base.c * 0.6, base.c, preserve), 0.03, 0.16),
    h: normalizeHue(base.h),
  };
}

function transformNeutralSurfaceOklch(
  base: OklchColor,
  settings: ThemeFlipSettings,
): OklchColor {
  return {
    ...base,
    l: mirrorRoleLightness(base.l, settings.surfaceDepth, settings.surfaceContrast, {
      minLightness: 0.05,
      maxLightness: 0.95,
      minStrength: 0.64,
      maxStrength: 0.84,
      curveStart: 1.1,
      curveEnd: 1.2,
    }),
    c: Math.min(base.c, 0.024),
    h: normalizeHue(base.h),
  };
}

function transformChromaticSurfaceOklch(
  base: OklchColor,
  color: ColorRecordSummary | undefined,
  settings: ThemeFlipSettings,
): OklchColor {
  const roleDepthFactor =
    color?.role === "accent" || color?.role === "outlier"
      ? 1
      : color?.role === "support"
        ? 0.94
        : 0.97;
  const preserve = clamp(settings.chromaPreservation / 100, 0, 1);

  return {
    ...base,
    l: mirrorRoleLightness(
      base.l,
      settings.chromaticDepth * roleDepthFactor,
      settings.surfaceContrast * 0.7,
      {
        minLightness: 0.08,
        maxLightness: 0.92,
        minStrength: 0.68,
        maxStrength: 0.9,
        curveStart: 1.04,
        curveEnd: 1.1,
      },
    ),
    c: clamp(lerp(base.c * 0.58, base.c, preserve), 0.03, 0.25),
    h: normalizeHue(base.h),
  };
}

function transformEffectOklch(
  base: OklchColor,
  color: ColorRecordSummary | undefined,
  settings: ThemeFlipSettings,
): OklchColor {
  const neutralLike = isNeutralLike(base, color);
  const preserve = clamp(settings.chromaPreservation / 100, 0, 1);

  return {
    ...base,
    l: mirrorRoleLightness(base.l, settings.surfaceDepth * 0.72, settings.surfaceContrast * 0.45, {
      minLightness: 0.08,
      maxLightness: 0.92,
      minStrength: 0.5,
      maxStrength: 0.68,
      curveStart: 1.08,
      curveEnd: 1.16,
    }),
    c: neutralLike
      ? Math.min(base.c, 0.02)
      : clamp(lerp(base.c * 0.55, base.c, preserve), 0.025, 0.14),
    h: normalizeHue(base.h),
  };
}

function transformSurfaceOklch(
  base: OklchColor,
  color: ColorRecordSummary | undefined,
  settings: ThemeFlipSettings,
): OklchColor {
  if (isStrokeLike(color)) {
    return transformStrokeOklch(base, color, settings);
  }

  if (isNeutralLike(base, color)) {
    return transformNeutralSurfaceOklch(base, settings);
  }

  return transformChromaticSurfaceOklch(base, color, settings);
}

function textLightnessCandidates(anchor: number, preferLight: boolean): number[] {
  const nudges = preferLight
    ? [0, 0.02, 0.04, 0.06, 0.08, 0.1, -0.02, -0.04, -0.06]
    : [0, -0.02, -0.04, -0.06, -0.08, -0.1, 0.02, 0.04, 0.06];
  return nudges.map((nudge) => clamp(anchor + nudge, 0.02, 0.98));
}

function mirrorTextLightness(lightness: number, textDepth: number): number {
  return mirrorRoleLightness(lightness, textDepth, 0, {
    minLightness: 0.02,
    maxLightness: 0.98,
    minStrength: 0.82,
    maxStrength: 0.96,
    curveStart: 0.88,
    curveEnd: 0.98,
  });
}

function resolveTextAnchor(preferLight: boolean, textDepth: number, sourceLightness?: number): number {
  const amount = clamp(textDepth / 100, 0, 1);
  if (sourceLightness !== undefined) {
    return mirrorTextLightness(sourceLightness, textDepth);
  }
  return preferLight
    ? lerp(0.68, 0.98, amount)
    : lerp(0.32, 0.02, amount);
}

function resolveTextChroma(
  base: OklchColor,
  settings: ThemeFlipSettings,
): number {
  if (base.c <= 0.04) {
    return Math.min(base.c, 0.03);
  }

  const preserve = clamp(settings.chromaPreservation / 100, 0, 1);
  return clamp(lerp(base.c * 0.72, base.c, preserve), 0.045, 0.22);
}

function transformDecorativeTextOklch(
  base: OklchColor,
  sourceBackground: OklchColor,
  transformedBackground: OklchColor,
  settings: ThemeFlipSettings,
): OklchColor {
  const deltaLightness = clamp(base.l - sourceBackground.l, -0.12, 0.12);
  return {
    ...base,
    l: clamp(transformedBackground.l + deltaLightness, 0.02, 0.98),
    c: resolveTextChroma(base, settings),
    h: normalizeHue(base.h),
  };
}

function chooseTextForContrast(
  base: OklchColor,
  transformedBackground: SerializedColor,
  preferLight: boolean,
  settings: ThemeFlipSettings,
): OklchColor {
  const minContrast = settings.textMinContrast;
  const primaryAnchor = resolveTextAnchor(preferLight, settings.textDepth, base.l);
  const fallbackAnchor = resolveTextAnchor(!preferLight, settings.textDepth);
  const targetChroma = resolveTextChroma(base, settings);
  const sequences = [
    textLightnessCandidates(primaryAnchor, preferLight),
    textLightnessCandidates(fallbackAnchor, !preferLight),
  ];

  let bestCandidate: { score: number; oklch: OklchColor } | null = null;

  for (const sequence of sequences) {
    for (const lightness of sequence) {
      const candidate: OklchColor = {
        ...base,
        l: lightness,
        c: targetChroma,
        h: normalizeHue(base.h),
      };
      const rgb = oklchToRgb(candidate, { clampToGamut: true });
      const contrast = calculateVisibleTextContrast(rgb, transformedBackground);
      const score =
        contrast >= minContrast ? Math.abs(contrast - minContrast) : 1000 + (minContrast - contrast);

      if (!bestCandidate || score < bestCandidate.score) {
        bestCandidate = { score, oklch: candidate };
      }
      if (contrast >= minContrast) {
        return candidate;
      }
    }
  }

  return bestCandidate?.oklch ?? {
    ...base,
    l: primaryAnchor,
    c: targetChroma,
    h: normalizeHue(base.h),
  };
}

function transformTextOklch(
  entry: ColorMappingEntry,
  color: ColorRecordSummary | undefined,
  transformedEntryByKey: ReadonlyMap<string, ColorMappingEntry>,
  analysisColorByKey: ReadonlyMap<string, ColorRecordSummary>,
  targetTheme: ThemeTarget,
  settings: ThemeFlipSettings,
): OklchColor {
  const base = entry.targetOklch;
  const backgroundEntry = resolveBackgroundEntry(color, transformedEntryByKey);
  const backgroundSummary = resolveBackgroundSummary(color, analysisColorByKey);
  const sourceBackgroundOklch = color?.theme?.textBackground
    ? rgbToOklch(color.theme.textBackground)
    : backgroundEntry?.targetOklch ?? null;
  const transformedBackground =
    backgroundEntry?.target ??
    (sourceBackgroundOklch
      ? oklchToRgb(
          transformSurfaceOklch(sourceBackgroundOklch, backgroundSummary, settings),
          { clampToGamut: true },
        )
      : null);

  if (!transformedBackground) {
    const preferLight = base.l < 0.5;
    return {
      ...base,
      l: resolveTextAnchor(preferLight, settings.textDepth, base.l),
      c: resolveTextChroma(base, settings),
      h: normalizeHue(base.h),
    };
  }

  const transformedBackgroundOklch = rgbToOklch(transformedBackground);
  const originalContrast = Math.abs(color?.theme?.originalLc ?? Infinity);
  if (sourceBackgroundOklch && originalContrast <= DECORATIVE_TEXT_MAX_CONTRAST) {
    return transformDecorativeTextOklch(
      base,
      sourceBackgroundOklch,
      transformedBackgroundOklch,
      settings,
    );
  }

  const sourceIsLight = sourceBackgroundOklch
    ? base.l >= sourceBackgroundOklch.l
    : base.l >= 0.5;
  const transformedBackgroundIsDark = transformedBackgroundOklch.l < 0.5;
  const canPreserveForegroundPolarity =
    settings.preserveColorForeground &&
    transformedBackgroundOklch.c > 0.04 &&
    sourceBackgroundOklch !== null &&
    (sourceBackgroundOklch.l < 0.5) === transformedBackgroundIsDark;
  const preferLight = canPreserveForegroundPolarity
    ? sourceIsLight
    : transformedBackgroundOklch.l < 0.5;

  return chooseTextForContrast(base, transformedBackground, preferLight, settings);
}

export function applyThemeFlip(
  entries: ColorMappingEntry[],
  analysisColorByKey: ReadonlyMap<string, ColorRecordSummary>,
  settings: ThemeFlipSettings,
  targetTheme: ThemeTarget,
): ColorMappingEntry[] {
  if (entries.length === 0) return entries;

  const transformedNonTextEntries = entries.map((entry) => {
    const color = analysisColorByKey.get(entry.key);
    if (isTextLike(color)) {
      return entry;
    }

    const nextOklch = isEffectLike(color)
      ? transformEffectOklch(entry.targetOklch, color, settings)
      : transformSurfaceOklch(entry.targetOklch, color, settings);
    const target = oklchToRgb(nextOklch, { clampToGamut: true });

    return {
      ...entry,
      target,
      targetHex: rgbToHex(target),
      targetOklch: nextOklch,
      reason: `Role-based theme switched to ${targetTheme}`,
    };
  });

  const transformedEntryByKey = new Map(
    transformedNonTextEntries.map((entry) => [entry.key, entry]),
  );

  return transformedNonTextEntries.map((entry) => {
    const color = analysisColorByKey.get(entry.key);
    if (!isTextLike(color)) {
      return entry;
    }

    const nextOklch = transformTextOklch(
      entry,
      color,
      transformedEntryByKey,
      analysisColorByKey,
      targetTheme,
      settings,
    );
    const target = oklchToRgb(nextOklch, { clampToGamut: true });

    return {
      ...entry,
      target,
      targetHex: rgbToHex(target),
      targetOklch: nextOklch,
      reason: `Role-based theme switched to ${targetTheme}`,
    };
  });
}
