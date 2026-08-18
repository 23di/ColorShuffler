import { calculateApcaContrast } from "../apca";
import {
  clamp,
  lerp,
  normalizeHue,
  oklchToRgb,
  rgbToOklch,
} from "../color";
import type {
  OklchColor,
  SerializedColor,
  ThemeFlipSettings,
} from "../types";
import type { ClassifiedColor, FlipDirection, FlipRole } from "./roles";

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

function visibleContrast(
  text: SerializedColor,
  background: SerializedColor,
): number {
  const opaqueBackground = { ...background, a: 1 };
  const visible =
    text.a < 0.999 ? compositeOver(text, opaqueBackground) : { ...text, a: 1 };
  return Math.abs(calculateApcaContrast(visible, opaqueBackground));
}

function textChromaTarget(
  role: FlipRole,
  sourceC: number,
  direction: FlipDirection,
  settings: ThemeFlipSettings,
): number {
  const saturation = clamp(settings.accentSaturation / 100, 0, 1.5);
  if (sourceC <= 0.04) {
    return Math.min(sourceC, 0.03);
  }
  let bias = direction === "toLight" ? 0.85 : 0.95;
  let cap = 0.1;
  if (role === "text-on-accent") {
    bias = direction === "toLight" ? 0.7 : 0.85;
    cap = 0.12;
  } else if (role === "text-decorative") {
    bias = direction === "toLight" ? 0.95 : 1.0;
    cap = direction === "toLight" ? 0.12 : 0.14;
  }
  return clamp(sourceC * saturation * bias, 0, cap);
}

interface BisectionResult {
  l: number;
  lc: number;
  converged: boolean;
}

function lcAt(
  l: number,
  chroma: number,
  hue: number,
  background: SerializedColor,
): number {
  const candidate: OklchColor = {
    l: clamp(l, 0, 1),
    c: Math.max(0, chroma),
    h: normalizeHue(hue),
    alpha: 1,
  };
  const rgb = oklchToRgb(candidate, { clampToGamut: true });
  return visibleContrast(rgb, background);
}

function bisectForContrast(
  chroma: number,
  hue: number,
  background: SerializedColor,
  minLc: number,
  interval: [number, number],
): BisectionResult {
  const [lo, hi] = interval;
  const lcLow = lcAt(lo, chroma, hue, background);
  const lcHigh = lcAt(hi, chroma, hue, background);
  const maxLc = Math.max(lcLow, lcHigh);

  if (maxLc < minLc) {
    return lcHigh >= lcLow
      ? { l: hi, lc: lcHigh, converged: false }
      : { l: lo, lc: lcLow, converged: false };
  }

  const endpointIncreases = lcHigh >= lcLow;
  let low = lo;
  let high = hi;
  let best = endpointIncreases
    ? { l: hi, lc: lcHigh }
    : { l: lo, lc: lcLow };

  for (let i = 0; i < 22; i += 1) {
    const mid = (low + high) / 2;
    const lcMid = lcAt(mid, chroma, hue, background);
    if (lcMid >= minLc) {
      best = { l: mid, lc: lcMid };
      if (endpointIncreases) {
        high = mid;
      } else {
        low = mid;
      }
    } else {
      if (endpointIncreases) {
        low = mid;
      } else {
        high = mid;
      }
    }
    if (Math.abs(high - low) < 1e-4) break;
  }

  return { ...best, converged: true };
}

function polarityInterval(
  backgroundOklch: OklchColor,
  polarity: "dark-text" | "light-text",
): [number, number] {
  const bgL = clamp(backgroundOklch.l, 0, 1);
  if (polarity === "dark-text") {
    const upper = clamp(bgL - 0.2, 0.02, 0.45);
    return [0.02, Math.max(upper, 0.1)];
  }
  const lower = clamp(bgL + 0.2, 0.55, 0.98);
  return [Math.min(lower, 0.9), 0.98];
}

function preferredPolarity(
  backgroundOklch: OklchColor,
  direction: FlipDirection,
  preserveColorForeground: boolean,
  sourceL: number,
  sourceBackgroundOklch: OklchColor | null,
  hasChromaticTextBackground: boolean,
): "dark-text" | "light-text" {
  const bgIsLight = backgroundOklch.l >= 0.5;
  if (preserveColorForeground) {
    // Transformed bg is still chromatic — preserve polarity directly from
    // the detected source background.
    if (backgroundOklch.c > 0.04 && sourceBackgroundOklch) {
      const srcTextIsLight = sourceL >= sourceBackgroundOklch.l;
      return srcTextIsLight ? "light-text" : "dark-text";
    }
    // Transformed bg is neutral but the color was ever seen on a chromatic
    // surface (e.g. shared entry used as both button label and body text).
    // Bias polarity to keep source extreme so buttons keep their labels.
    if (hasChromaticTextBackground) {
      return sourceL >= 0.5 ? "light-text" : "dark-text";
    }
  }
  return bgIsLight ? "dark-text" : "light-text";
}

export interface ResolveTextInput {
  classified: ClassifiedColor;
  transformedBackgroundRgb: SerializedColor | null;
  transformedBackgroundOklch: OklchColor | null;
  direction: FlipDirection;
  settings: ThemeFlipSettings;
}

export function resolveTextOklch(input: ResolveTextInput): OklchColor {
  const { classified, direction, settings } = input;
  const base = classified.sourceOklch;
  const sourceBackgroundOklch = classified.backgroundRgb
    ? rgbToOklch(classified.backgroundRgb)
    : null;
  const bgRgb = input.transformedBackgroundRgb;
  const bgOklch = input.transformedBackgroundOklch;

  const hue = normalizeHue(base.h);
  const chromaTarget = textChromaTarget(
    classified.role,
    base.c,
    direction,
    settings,
  );

  if (!bgRgb || !bgOklch) {
    const fallbackPolarity =
      direction === "toLight" ? "dark-text" : "light-text";
    return anchorFallback(fallbackPolarity, chromaTarget, hue, settings);
  }

  if (classified.role === "text-decorative" && sourceBackgroundOklch) {
    return decorativeText(base, sourceBackgroundOklch, bgOklch, chromaTarget);
  }

  const minLc = clamp(settings.textContrast, 0, 105);
  const hasChromaticTextBackground =
    classified.summary?.theme?.hasChromaticTextBackground ?? false;
  const polarity = preferredPolarity(
    bgOklch,
    direction,
    settings.preserveButtonText,
    base.l,
    sourceBackgroundOklch,
    hasChromaticTextBackground,
  );

  // Preserve-polarity fast path for button labels / text on chromatic surfaces.
  // Triggers when:
  //   • the user opted into "Preserve button text"
  //   • the source text is near an extreme pole (pure-ish white or black)
  //   • the color was observed on a chromatic surface somewhere in the doc
  // In that case we keep the source L rather than bisecting it down to the
  // APCA threshold (which would turn #FFF into a mid gray).
  const nearPole =
    (polarity === "light-text" && base.l >= 0.93) ||
    (polarity === "dark-text" && base.l <= 0.07);
  const buttonTextContext =
    (bgOklch.c > 0.04 && !!sourceBackgroundOklch) ||
    hasChromaticTextBackground;
  if (settings.preserveButtonText && nearPole && buttonTextContext) {
    return {
      l: clamp(base.l, 0, 1),
      c: chromaTarget,
      h: hue,
      alpha: 1,
    };
  }

  let result = bisectForContrast(
    chromaTarget,
    hue,
    bgRgb,
    minLc,
    polarityInterval(bgOklch, polarity),
  );

  if (!result.converged) {
    const opposite = polarity === "dark-text" ? "light-text" : "dark-text";
    const alt = bisectForContrast(
      chromaTarget,
      hue,
      bgRgb,
      minLc,
      polarityInterval(bgOklch, opposite),
    );
    if (alt.converged || alt.lc > result.lc) {
      result = alt;
    }
  }

  if (!result.converged) {
    const desatChroma = chromaTarget * 0.5;
    const desat = bisectForContrast(
      desatChroma,
      hue,
      bgRgb,
      minLc,
      polarityInterval(bgOklch, polarity),
    );
    if (desat.converged || desat.lc > result.lc) {
      return {
        l: desat.l,
        c: desatChroma,
        h: hue,
        alpha: 1,
      };
    }
  }

  const depth = clamp(settings.textWeight / 100, 0, 1);
  const pole = polarity === "dark-text" ? 0.02 : 0.98;
  // Primary text pulls all the way to pole; secondary/on-accent stay closer
  // to the APCA-solved L so hierarchy between text roles is preserved.
  const roleStrength =
    classified.role === "text-secondary"
      ? 0.3
      : classified.role === "text-on-accent"
        ? 0.6
        : 1.0;
  const finalL = result.converged
    ? lerp(result.l, pole, depth * roleStrength)
    : result.l;
  return {
    l: clamp(finalL, 0, 1),
    c: chromaTarget,
    h: hue,
    alpha: 1,
  };
}

function decorativeText(
  base: OklchColor,
  sourceBackground: OklchColor,
  transformedBackground: OklchColor,
  chromaTarget: number,
): OklchColor {
  const deltaL = clamp(base.l - sourceBackground.l, -0.12, 0.12);
  return {
    l: clamp(transformedBackground.l + deltaL, 0.02, 0.98),
    c: chromaTarget,
    h: normalizeHue(base.h),
    alpha: 1,
  };
}

function anchorFallback(
  polarity: "dark-text" | "light-text",
  chroma: number,
  hue: number,
  settings: ThemeFlipSettings,
): OklchColor {
  const depth = clamp(settings.textWeight / 100, 0, 1);
  const anchor = polarity === "dark-text" ? 0.12 : 0.92;
  const pole = polarity === "dark-text" ? 0.02 : 0.98;
  return {
    l: lerp(anchor, pole, depth),
    c: chroma,
    h: normalizeHue(hue),
    alpha: 1,
  };
}
