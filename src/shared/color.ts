import {
  Hct,
  argbFromRgb,
  blueFromArgb,
  greenFromArgb,
  redFromArgb,
} from "@material/material-color-utilities";
import {
  type ColorRecordSummary,
  type ColorRole,
  type OklchColor,
  type SerializedColor,
  type ToneBand,
} from "./types";

const HUE_FAMILIES = [
  { id: "red", label: "Red", hue: 20 },
  { id: "orange", label: "Orange", hue: 40 },
  { id: "amber", label: "Amber", hue: 60 },
  { id: "yellow", label: "Yellow", hue: 85 },
  { id: "lime", label: "Lime", hue: 110 },
  { id: "green", label: "Green", hue: 140 },
  { id: "teal", label: "Teal", hue: 180 },
  { id: "cyan", label: "Cyan", hue: 205 },
  { id: "blue", label: "Blue", hue: 235 },
  { id: "indigo", label: "Indigo", hue: 260 },
  { id: "violet", label: "Violet", hue: 285 },
  { id: "magenta", label: "Magenta", hue: 320 },
  { id: "rose", label: "Rose", hue: 350 },
];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function normalizeNeutralThreshold(value: number): number {
  const clamped = Math.max(0, value);
  return Math.min(0.18, Math.max(clamped, clamped * 2.2));
}

export function isNearNeutralChroma(chroma: number, threshold: number): boolean {
  return chroma < normalizeNeutralThreshold(threshold);
}

export function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

export function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  return ((hue % 360) + 360) % 360;
}

export function hueDistance(a: number, b: number): number {
  const diff = Math.abs(normalizeHue(a) - normalizeHue(b));
  return Math.min(diff, 360 - diff);
}

export function angleLerp(from: number, to: number, amount: number): number {
  const start = normalizeHue(from);
  const end = normalizeHue(to);
  let delta = end - start;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return normalizeHue(start + delta * amount);
}

export function buildColorKey(color: SerializedColor): string {
  const r = Math.round(clamp01(color.r) * 255);
  const g = Math.round(clamp01(color.g) * 255);
  const b = Math.round(clamp01(color.b) * 255);
  const a = Math.round(clamp01(color.a) * 1000);
  return `${r},${g},${b},${a}`;
}

export function rgbToHex(color: SerializedColor): string {
  const r = Math.round(clamp01(color.r) * 255)
    .toString(16)
    .padStart(2, "0");
  const g = Math.round(clamp01(color.g) * 255)
    .toString(16)
    .padStart(2, "0");
  const b = Math.round(clamp01(color.b) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${r}${g}${b}`.toUpperCase();
}

export function rgbToCss(color: SerializedColor): string {
  const r = Math.round(clamp01(color.r) * 255);
  const g = Math.round(clamp01(color.g) * 255);
  const b = Math.round(clamp01(color.b) * 255);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(color.a).toFixed(3)})`;
}

export interface HslColor {
  h: number;
  s: number;
  l: number;
  a: number;
}

export function rgbToHsl(color: SerializedColor): HslColor {
  const r = clamp01(color.r);
  const g = clamp01(color.g);
  const b = clamp01(color.b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  let hue = 0;
  let saturation = 0;

  if (delta > 0) {
    saturation =
      lightness === 0 || lightness === 1
        ? 0
        : delta / (1 - Math.abs(2 * lightness - 1));

    switch (max) {
      case r:
        hue = ((g - b) / delta) % 6;
        break;
      case g:
        hue = (b - r) / delta + 2;
        break;
      default:
        hue = (r - g) / delta + 4;
        break;
    }

    hue *= 60;
  }

  return {
    h: normalizeHue(hue),
    s: clamp01(saturation),
    l: clamp01(lightness),
    a: clamp01(color.a),
  };
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

export function hslToRgb(color: HslColor): SerializedColor {
  const h = normalizeHue(color.h) / 360;
  const s = clamp01(color.s);
  const l = clamp01(color.l);

  if (s === 0) {
    return { r: l, g: l, b: l, a: clamp01(color.a) };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: clamp01(hueToRgb(p, q, h + 1 / 3)),
    g: clamp01(hueToRgb(p, q, h)),
    b: clamp01(hueToRgb(p, q, h - 1 / 3)),
    a: clamp01(color.a),
  };
}

export function oklchToCss(color: OklchColor): string {
  return `hct(${(color.l * 100).toFixed(1)} ${(
    color.c * 100
  ).toFixed(1)} ${normalizeHue(color.h).toFixed(1)})`;
}

export const hctToCss = oklchToCss;

export function rgbToOklch(color: SerializedColor): OklchColor {
  const argb = argbFromRgb(
    Math.round(clamp01(color.r) * 255),
    Math.round(clamp01(color.g) * 255),
    Math.round(clamp01(color.b) * 255),
  );
  const converted = Hct.fromInt(argb);
  return {
    l: clamp01((converted.tone ?? 0) / 100),
    c: Math.max(0, (converted.chroma ?? 0) / 100),
    h: normalizeHue(converted.hue ?? 0),
    alpha: clamp01(color.a),
  };
}

export const rgbToHct = rgbToOklch;

function rawOklchToRgb(color: OklchColor): SerializedColor {
  const converted = Hct.from(
    normalizeHue(color.h),
    Math.max(0, color.c) * 100,
    clamp01(color.l) * 100,
  ).toInt();
  return {
    r: redFromArgb(converted) / 255,
    g: greenFromArgb(converted) / 255,
    b: blueFromArgb(converted) / 255,
    a: clamp01(color.alpha),
  };
}

export function isInSrgbGamut(color: SerializedColor): boolean {
  return (
    color.r >= 0 &&
    color.r <= 1 &&
    color.g >= 0 &&
    color.g <= 1 &&
    color.b >= 0 &&
    color.b <= 1
  );
}

export function clampRgb(color: SerializedColor): SerializedColor {
  return {
    r: clamp01(color.r),
    g: clamp01(color.g),
    b: clamp01(color.b),
    a: clamp01(color.a),
  };
}

export function oklchToRgb(
  color: OklchColor,
  options?: { clampToGamut?: boolean },
): SerializedColor {
  const raw = rawOklchToRgb(color);
  if (!options?.clampToGamut || isInSrgbGamut(raw)) {
    return clampRgb(raw);
  }

  let low = 0;
  let high = Math.max(0, color.c);
  let best = rawOklchToRgb({ ...color, c: 0 });

  for (let index = 0; index < 18; index += 1) {
    const mid = (low + high) / 2;
    const candidate = rawOklchToRgb({ ...color, c: mid });
    if (isInSrgbGamut(candidate)) {
      low = mid;
      best = candidate;
    } else {
      high = mid;
    }
  }

  return clampRgb(best);
}

export const hctToRgb = oklchToRgb;

export function weightedAverageHue(
  values: Array<{ hue: number; weight: number }>,
): number {
  if (values.length === 0) return 0;
  const sum = values.reduce(
    (accumulator, entry) => {
      const radians = (normalizeHue(entry.hue) * Math.PI) / 180;
      const weight = Math.max(entry.weight, 0);
      return {
        x: accumulator.x + Math.cos(radians) * weight,
        y: accumulator.y + Math.sin(radians) * weight,
      };
    },
    { x: 0, y: 0 },
  );

  if (sum.x === 0 && sum.y === 0) return 0;
  return normalizeHue((Math.atan2(sum.y, sum.x) * 180) / Math.PI);
}

export function averageColor(colors: SerializedColor[]): SerializedColor {
  if (colors.length === 0) return { r: 0, g: 0, b: 0, a: 1 };
  const totals = colors.reduce(
    (accumulator, color) => ({
      r: accumulator.r + color.r,
      g: accumulator.g + color.g,
      b: accumulator.b + color.b,
      a: accumulator.a + color.a,
    }),
    { r: 0, g: 0, b: 0, a: 0 },
  );

  return {
    r: totals.r / colors.length,
    g: totals.g / colors.length,
    b: totals.b / colors.length,
    a: totals.a / colors.length,
  };
}

export function familyFromHue(hue: number | null, chroma: number): {
  id: string;
  name: string;
} {
  if (hue === null || chroma < 0.03) {
    return { id: "neutral", name: "Neutral" };
  }

  let winner = HUE_FAMILIES[0];
  let smallestDistance = Number.POSITIVE_INFINITY;
  for (const family of HUE_FAMILIES) {
    const distance = hueDistance(hue, family.hue);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      winner = family;
    }
  }

  return { id: winner.id, name: winner.label };
}

export function classifyColorRole(
  color: Pick<ColorRecordSummary, "oklch" | "usageCount">,
  colors: Array<Pick<ColorRecordSummary, "oklch" | "usageCount">>,
  neutralThreshold: number,
): ColorRole {
  if (color.oklch.c < neutralThreshold) {
    return "neutral";
  }

  let nearest = Number.POSITIVE_INFINITY;
  for (const entry of colors) {
    if (entry === color || entry.oklch.c < neutralThreshold) continue;

    const distance =
      hueDistance(color.oklch.h, entry.oklch.h) / 45 +
      Math.abs(color.oklch.c - entry.oklch.c) / 0.08 +
      Math.abs(color.oklch.l - entry.oklch.l) / 0.08;

    if (distance < nearest) {
      nearest = distance;
    }
  }

  if (color.usageCount <= 1 && nearest > 1.8) {
    return "outlier";
  }

  if (color.oklch.c >= 0.14 || color.usageCount >= 3) {
    return "accent";
  }

  return "support";
}

export function detectToneBand(lightness: number): ToneBand {
  if (lightness < 0.35) return "shadows";
  if (lightness > 0.7) return "highlights";
  return "midtones";
}

export function dominantHue(colors: ColorRecordSummary[]): number {
  const chromatic: Array<{ hue: number; weight: number }> = [];
  for (const color of colors) {
    if (color.oklch.c < 0.03) continue;
    chromatic.push({
      hue: color.oklch.h,
      weight: Math.max(color.usageCount, 1) * Math.max(color.oklch.c, 0.01),
    });
  }

  return weightedAverageHue(chromatic);
}

export function buildColorRoleIndex(
  colors: Array<Pick<ColorRecordSummary, "key" | "oklch" | "usageCount">>,
  neutralThreshold: number,
): Map<string, ColorRole> {
  const chromatic = colors.filter((color) => color.oklch.c >= neutralThreshold);
  const roleByKey = new Map<string, ColorRole>();

  for (const color of colors) {
    if (color.oklch.c < neutralThreshold) {
      roleByKey.set(color.key, "neutral");
      continue;
    }

    let nearest = Number.POSITIVE_INFINITY;
    for (const entry of chromatic) {
      if (entry === color) continue;

      const distance =
        hueDistance(color.oklch.h, entry.oklch.h) / 45 +
        Math.abs(color.oklch.c - entry.oklch.c) / 0.08 +
        Math.abs(color.oklch.l - entry.oklch.l) / 0.08;

      if (distance < nearest) {
        nearest = distance;
      }
    }

    if (color.usageCount <= 1 && nearest > 1.8) {
      roleByKey.set(color.key, "outlier");
      continue;
    }

    if (color.oklch.c >= 0.14 || color.usageCount >= 3) {
      roleByKey.set(color.key, "accent");
      continue;
    }

    roleByKey.set(color.key, "support");
  }

  return roleByKey;
}

export function compareByUsageThenHue(
  left: ColorRecordSummary,
  right: ColorRecordSummary,
): number {
  if (right.usageCount !== left.usageCount) {
    return right.usageCount - left.usageCount;
  }

  return left.oklch.h - right.oklch.h;
}
