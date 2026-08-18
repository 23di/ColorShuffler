import {
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  applyExposureToLightness,
  buildExploreMapping,
  DEFAULT_EXPLORE_SETTINGS,
  resolveExposureForLightness,
} from "../shared/explore";
import type { PluginToUiMessage, UiToPluginMessage } from "../shared/messages";
import {
  applyThemeFlip,
  DEFAULT_THEME_FLIP_SETTINGS,
  type ThemeTarget,
} from "../shared/theme-flip";
import type {
  ColorMappingEntry,
  ExploreSettings,
  OklchColor,
  SelectionAnalysisSummary,
  ThemeFlipSettings,
} from "../shared/types";
import {
  buildColorRoleIndex,
  clamp,
  dominantHue,
  deriveNeutralThreshold,
  familyFromHue,
  hueDistance,
  isNearNeutralChroma,
  normalizeHue,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
  weightedAverageHue,
} from "../shared/color";
import { HueRelationWheel, type HueRelationWheelNode } from "./HueRelationWheel";

type ExtraHueGroupLinkMode =
  | "manual"
  | "monochrome"
  | "balanced"
  | "clustered"
  | "accent-support"
  | "complement"
  | "analog-plus"
  | "analog-wide-plus"
  | "analog-minus"
  | "analog-wide-minus"
  | "triad"
  | "triad-minus"
  | "split-plus"
  | "split-minus"
  | "square-plus"
  | "square-minus"
  | "tetrad-plus"
  | "tetrad-opposite"
  | "tetrad-minus";
type AnalysisColor = SelectionAnalysisSummary["colors"][number];
type FrameGroup = {
  id: string;
  name: string;
  type: "neutral" | "chromatic";
  memberKeys: string[];
  usageCount: number;
  hue: number | null;
};
type ExtraHueGroup = {
  id: string;
  scopeId: string;
  linkMode: ExtraHueGroupLinkMode;
  hueShift: number;
  exposure: number;
  contrast: number;
  chromaScale: number;
};

const EXTRA_HUE_LINK_MODE_OPTIONS: Array<{
  value: ExtraHueGroupLinkMode;
  label: string;
}> = [
  { value: "manual", label: "Fixed" },
  { value: "monochrome", label: "Monochrome" },
  { value: "balanced", label: "Balanced" },
  { value: "clustered", label: "Clustered" },
  { value: "accent-support", label: "Accent + support" },
  { value: "complement", label: "Complementary" },
  { value: "split-plus", label: "Split comp +" },
  { value: "split-minus", label: "Split comp -" },
  { value: "analog-plus", label: "Analog +" },
  { value: "analog-wide-plus", label: "Analog wide +" },
  { value: "analog-minus", label: "Analog -" },
  { value: "analog-wide-minus", label: "Analog wide -" },
  { value: "triad", label: "Triad" },
  { value: "triad-minus", label: "Triad -" },
  { value: "square-plus", label: "Square +" },
  { value: "square-minus", label: "Square -" },
  { value: "tetrad-plus", label: "Tetrad +" },
  { value: "tetrad-opposite", label: "Tetrad opposite" },
  { value: "tetrad-minus", label: "Tetrad -" },
];
const RELATION_LIGHTNESS_OPTIONS = [
  { value: "-45", label: "Darkest" },
  { value: "-20", label: "Darker" },
  { value: "-10", label: "Dark" },
  { value: "0", label: "Auto" },
  { value: "same", label: "Same" },
  { value: "10", label: "Light" },
  { value: "20", label: "Lighter" },
  { value: "45", label: "Lightest" },
] as const;
type RelationLightnessValue = (typeof RELATION_LIGHTNESS_OPTIONS)[number]["value"];

const DEFAULT_UI_WIDTH = 380;
const MIN_UI_WIDTH = 380;
const MAX_UI_WIDTH = 760;

function postMsg(message: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function fmt(v: number, suffix = ""): string {
  const r = Math.round(v * 10) / 10;
  return r > 0 ? `+${r}${suffix}` : `${r}${suffix}`;
}

function parseCssColorTriplet(value: string): [number, number, number] | null {
  const normalized = value.trim();
  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1]
      .split(",")
      .slice(0, 3)
      .map((part) => Number.parseFloat(part.trim()));
    if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
      return [parts[0], parts[1], parts[2]];
    }
  }

  const hexMatch = normalized.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return [
        Number.parseInt(`${hex[0]}${hex[0]}`, 16),
        Number.parseInt(`${hex[1]}${hex[1]}`, 16),
        Number.parseInt(`${hex[2]}${hex[2]}`, 16),
      ];
    }
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  return null;
}

function inferUiColorScheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";

  const rootStyle = window.getComputedStyle(document.documentElement);
  const bgValue =
    rootStyle.getPropertyValue("--figma-color-bg").trim() ||
    rootStyle.getPropertyValue("--bg").trim() ||
    rootStyle.backgroundColor ||
    window.getComputedStyle(document.body).backgroundColor;
  const rgb = parseCssColorTriplet(bgValue);
  if (!rgb) return "dark";

  const [r, g, b] = rgb;
  const perceivedBrightness = (r * 299 + g * 587 + b * 114) / 1000;
  return perceivedBrightness < 140 ? "dark" : "light";
}

function normalizeSignedHueShift(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function hueShiftBetween(fromHue: number, toHue: number): number {
  return normalizeSignedHueShift(normalizeHue(toHue) - normalizeHue(fromHue));
}

function createPrimaryScopeSettings(base: ExploreSettings, hueShift: number): ExploreSettings {
  return {
    ...base,
    hueShift,
    contrast: 0,
    huePreset: "none",
    grading: {
      shadows: { ...base.grading.shadows, hueShift: 0 },
      midtones: { ...base.grading.midtones, hueShift: 0 },
      highlights: { ...base.grading.highlights, hueShift: 0 },
    },
  };
}

function createScopedHueSettings(
  base: ExploreSettings,
  hueShift: number,
  exposure: number,
  chromaScale: number,
  contrast = 0,
): ExploreSettings {
  return {
    ...createPrimaryScopeSettings(base, hueShift),
    exposure,
    contrast,
    chromaScale,
  };
}

function extraHueGroupOffset(relation: ExtraHueGroupLinkMode): number {
  switch (relation) {
    case "monochrome":
      return 0;
    case "balanced":
      return 24;
    case "clustered":
      return 18;
    case "accent-support":
      return 150;
    case "complement":
      return 180;
    case "analog-plus":
      return 30;
    case "analog-wide-plus":
      return 60;
    case "analog-minus":
      return -30;
    case "analog-wide-minus":
      return -60;
    case "triad":
      return 120;
    case "triad-minus":
      return -120;
    case "split-plus":
      return 150;
    case "split-minus":
      return -150;
    case "square-plus":
      return 90;
    case "square-minus":
      return -90;
    case "tetrad-plus":
      return 60;
    case "tetrad-opposite":
      return 180;
    case "tetrad-minus":
      return -120;
    case "manual":
    default:
      return 0;
  }
}

function resolveMasterHue(anchorHue: number, globalHueShift: number): number {
  return normalizeHue(anchorHue + globalHueShift);
}

function resolvePassiveGroupHue(
  group: FrameGroup,
  masterHue: number,
  globalHueShift: number,
  tintEnabled: boolean,
): number {
  if (tintEnabled) {
    return masterHue;
  }
  return normalizeHue((group.hue ?? masterHue) + globalHueShift);
}

function resolveExtraHueGroupOffset(group: ExtraHueGroup): number {
  return group.linkMode === "manual" ? group.hueShift : extraHueGroupOffset(group.linkMode);
}

function globalRelationOffsets(mode: ExtraHueGroupLinkMode): number[] {
  switch (mode) {
    case "manual":
      return [];
    case "monochrome":
      return [0];
    case "balanced":
      return [24, -24, 54, -54, 148, -148, 178];
    case "clustered":
      return [18, -18, 36, -36, 60, -60, 150];
    case "accent-support":
      return [150, 24, -24, 48, -48, 176, 72];
    case "complement":
      return [180];
    case "analog-plus":
      return [30, 60, 90, 120, 150, 180];
    case "analog-wide-plus":
      return [60, 120, 180, 240, 300];
    case "analog-minus":
      return [-30, -60, -90, -120, -150, -180];
    case "analog-wide-minus":
      return [-60, -120, -180, -240, -300];
    case "triad":
      return [120, 240];
    case "triad-minus":
      return [-120, 120];
    case "split-plus":
      return [150, -150];
    case "split-minus":
      return [-150, 150];
    case "square-plus":
      return [90, 180, 270];
    case "square-minus":
      return [-90, -180, -270];
    case "tetrad-plus":
      return [60, 180, 240];
    case "tetrad-opposite":
      return [180, 60, 240];
    case "tetrad-minus":
      return [-60, -180, -240];
    default:
      return [];
  }
}

function resolveLinkedRelationHue(
  mode: ExtraHueGroupLinkMode,
  brandHue: number,
  groupIndex: number,
): number {
  if (groupIndex <= 0) {
    return normalizeHue(brandHue);
  }

  const offsets = globalRelationOffsets(mode);
  if (offsets.length === 0) {
    return normalizeHue(brandHue);
  }

  const offset = offsets[(groupIndex - 1) % offsets.length] ?? 0;
  return normalizeHue(brandHue + offset);
}

function resolveNearestRelationHue(
  mode: ExtraHueGroupLinkMode,
  brandHue: number,
  targetHue: number,
  includeBrandHue = true,
): number {
  const relationCandidates = globalRelationOffsets(mode).map((offset) =>
    normalizeHue(brandHue + offset),
  );
  const candidates = includeBrandHue
    ? [normalizeHue(brandHue), ...relationCandidates]
    : relationCandidates.length > 0
      ? relationCandidates
      : [normalizeHue(brandHue)];

  return candidates.reduce((bestHue, candidate) =>
    hueDistance(targetHue, candidate) < hueDistance(targetHue, bestHue) ? candidate : bestHue,
  );
}

function resolveNeutralRelationHue(
  mode: ExtraHueGroupLinkMode,
  brandHue: number,
  neutralHue: number,
  chromaScale: number,
): number | undefined {
  if (mode === "manual" || chromaScale <= 1.001) {
    return undefined;
  }

  if (mode === "monochrome") {
    return normalizeHue(brandHue);
  }

  return resolveNearestRelationHue(mode, brandHue, neutralHue, false);
}

function resolveAutoPairingValues(
  group: ExtraHueGroup,
): {
  exposure: number;
  chromaScale: number;
} {
  switch (group.linkMode) {
    case "monochrome":
      return { exposure: 0, chromaScale: 0.78 };
    case "balanced":
      return { exposure: 1, chromaScale: 0.9 };
    case "clustered":
      return { exposure: 0, chromaScale: 0.86 };
    case "accent-support":
      return { exposure: 1, chromaScale: 0.92 };
    case "analog-plus":
    case "analog-minus":
      return { exposure: 0, chromaScale: 0.82 };
    case "analog-wide-plus":
    case "analog-wide-minus":
      return { exposure: 1, chromaScale: 0.88 };
    case "split-plus":
    case "split-minus":
      return { exposure: 2, chromaScale: 0.94 };
    case "square-plus":
    case "square-minus":
    case "tetrad-opposite":
      return { exposure: 2, chromaScale: 0.96 };
    case "tetrad-plus":
    case "tetrad-minus":
      return { exposure: 2, chromaScale: 0.98 };
    case "complement":
      return { exposure: 2, chromaScale: 0.92 };
    case "triad":
    case "triad-minus":
      return { exposure: 3, chromaScale: 1.02 };
    case "manual":
    default: {
      const distance = Math.abs(normalizeSignedHueShift(resolveExtraHueGroupOffset(group)));
      if (distance < 30) return { exposure: 0, chromaScale: 0.8 };
      if (distance < 90) return { exposure: 1, chromaScale: 0.9 };
      if (distance < 150) return { exposure: 3, chromaScale: 1.02 };
      return { exposure: 2, chromaScale: 0.94 };
    }
  }
}

function resolveEffectiveExtraHueGroup(group: ExtraHueGroup): ExtraHueGroup {
  if (group.linkMode === "manual") {
    return group;
  }

  const autoValues = resolveAutoPairingValues(group);
  return {
    ...group,
    hueShift: resolveExtraHueGroupOffset(group),
    exposure: autoValues.exposure,
    chromaScale: autoValues.chromaScale,
  };
}

function resolveExtraHueGroupDisplayHue(group: ExtraHueGroup, masterHue: number): number {
  return normalizeHue(masterHue + resolveEffectiveExtraHueGroup(group).hueShift);
}

function materializeManualExtraHueGroup(group: ExtraHueGroup): ExtraHueGroup {
  const effectiveGroup = resolveEffectiveExtraHueGroup(group);
  return {
    ...effectiveGroup,
    linkMode: "manual",
  };
}

function applyTintMapping(
  mapping: Record<string, ColorMappingEntry>,
  targetHue: number,
  neutralThreshold: number,
  includeNearNeutrals = false,
): Record<string, ColorMappingEntry> {
  const entries = Object.values(mapping);
  if (entries.length === 0) return mapping;

  const chromaticEntries = entries.filter(
    (entry) => includeNearNeutrals || entry.targetOklch.c >= neutralThreshold,
  );
  if (chromaticEntries.length === 0) return mapping;

  const targetHueNormalized = normalizeHue(targetHue);
  return Object.fromEntries(
    entries.map((entry) => {
      if (!includeNearNeutrals && entry.targetOklch.c < neutralThreshold) {
        return [entry.key, entry];
      }

      const nextOklch = {
        ...entry.targetOklch,
        h: normalizeHue(targetHueNormalized),
      };
      const nextRgb = oklchToRgb(nextOklch, { clampToGamut: true });
      return [
        entry.key,
        {
          ...entry,
          key: entry.key,
          target: nextRgb,
          targetHex: rgbToHex(nextRgb),
          targetOklch: rgbToOklch(nextRgb),
          reason: "Tint aligned to target hue",
        } satisfies ColorMappingEntry,
      ];
    }),
  );
}

function applyNeutralChromaFloor(
  mapping: Record<string, ColorMappingEntry>,
  targetHue: number,
  neutralThreshold: number,
  chromaScale: number,
): Record<string, ColorMappingEntry> {
  const extraChroma = Math.max(0, chromaScale - 1);
  const floor = Math.max(
    0,
    Math.min(neutralThreshold * 0.8, neutralThreshold * 0.8 * extraChroma),
  );
  if (floor <= 0) {
    return mapping;
  }

  return Object.fromEntries(
    Object.values(mapping).map((entry) => {
      if (entry.targetOklch.c >= neutralThreshold) {
        return [entry.key, entry];
      }

      const nextOklch = {
        ...entry.targetOklch,
        c: Math.max(entry.targetOklch.c, floor),
        h: normalizeHue(targetHue),
      };
      const nextRgb = oklchToRgb(nextOklch, { clampToGamut: true });
      return [
        entry.key,
        {
          ...entry,
          target: nextRgb,
          targetHex: rgbToHex(nextRgb),
          targetOklch: rgbToOklch(nextRgb),
          reason: "Neutral tint floor",
        } satisfies ColorMappingEntry,
      ];
    }),
  );
}

function createIdentityMappingEntry(color: AnalysisColor): ColorMappingEntry {
  return {
    key: color.key,
    source: color.rgb,
    sourceHex: color.hex,
    target: color.rgb,
    targetHex: color.hex,
    targetOklch: color.oklch,
    role: color.role,
  };
}

function buildFrameGroups(
  colors: AnalysisColor[],
  neutralThreshold: number,
): FrameGroup[] {
  const grouped = new Map<
    string,
    {
      id: string;
      name: string;
      type: "neutral" | "chromatic";
      memberKeys: string[];
      usageCount: number;
      hueValues: Array<{ hue: number; weight: number }>;
    }
  >();

  for (const color of colors) {
    const chroma = color.oklch.c;
    const isNeutral = isNearNeutralChroma(chroma, neutralThreshold);
    const family = isNeutral
      ? { id: "neutral", name: "Neutrals" }
      : familyFromHue(color.oklch.h, chroma);
    const type = isNeutral ? "neutral" : "chromatic";
    const existing = grouped.get(family.id);
    if (existing) {
      existing.memberKeys.push(color.key);
      existing.usageCount += color.usageCount;
      if (!isNeutral) {
        existing.hueValues.push({
          hue: color.oklch.h,
          weight: Math.max(color.usageCount, 1) * Math.max(chroma, 0.01),
        });
      }
      continue;
    }

    grouped.set(family.id, {
      id: family.id,
      name: family.name,
      type,
      memberKeys: [color.key],
      usageCount: color.usageCount,
      hueValues: isNeutral
        ? []
        : [
            {
              hue: color.oklch.h,
              weight: Math.max(color.usageCount, 1) * Math.max(chroma, 0.01),
            },
          ],
    });
  }

  return [...grouped.values()]
    .map((group) => ({
      id: group.id,
      name: group.name,
      type: group.type,
      memberKeys: group.memberKeys,
      usageCount: group.usageCount,
      hue:
        group.type === "neutral" || group.hueValues.length === 0
          ? null
          : weightedAverageHue(group.hueValues),
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "chromatic" ? -1 : 1;
      }
      if (right.usageCount !== left.usageCount) {
        return right.usageCount - left.usageCount;
      }
      return (left.hue ?? 0) - (right.hue ?? 0);
    });
}

function createNeutralExtraHueGroup(): ExtraHueGroup {
  return {
    id: "neutral-fixed-group",
    scopeId: "neutral",
    linkMode: "manual",
    hueShift: 0,
    exposure: 0,
    contrast: 0,
    chromaScale: 1,
  };
}

function isButtonTarget(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && Boolean(target.closest("button"));
}

const MAX_NEUTRAL_WHEEL_TINT = 0.55;
const WHEEL_MAX_CHROMA = 0.25;
const MAX_CHROMA_CONTROL_SCALE = 2;
const HUE_WHEEL_LIGHTNESS = 0.7;
const HUE_WHEEL_TRACK_CHROMA = 0.25;

function summarizeOklchSample(
  colors: AnalysisColor[],
  fallbackHue: number,
): OklchColor {
  if (colors.length === 0) {
    return {
      l: 0.68,
      c: 0.08,
      h: normalizeHue(fallbackHue),
      alpha: 1,
    };
  }

  let totalWeight = 0;
  let weightedLightness = 0;
  let weightedChroma = 0;
  let weightedAlpha = 0;
  const hueValues: Array<{ hue: number; weight: number }> = [];

  for (const color of colors) {
    const weight = Math.max(color.usageCount, 1);
    totalWeight += weight;
    weightedLightness += color.oklch.l * weight;
    weightedChroma += color.oklch.c * weight;
    weightedAlpha += color.oklch.alpha * weight;

    if (color.oklch.c > 0.001) {
      hueValues.push({
        hue: color.oklch.h,
        weight: weight * Math.max(color.oklch.c, 0.01),
      });
    }
  }

  const normalizedWeight = Math.max(totalWeight, 1);
  return {
    l: clamp(weightedLightness / normalizedWeight, 0, 1),
    c: Math.max(0, weightedChroma / normalizedWeight),
    h: hueValues.length > 0 ? weightedAverageHue(hueValues) : normalizeHue(fallbackHue),
    alpha: clamp(weightedAlpha / normalizedWeight, 0, 1),
  };
}

function previewSampleOklch(
  sample: OklchColor,
  {
    hue,
    exposure,
    chromaScale,
    contrast = 0,
    neutralThreshold = 0,
    allowNeutralTintFloor = false,
  }: {
    hue: number;
    exposure: number;
    chromaScale: number;
    contrast?: number;
    neutralThreshold?: number;
    allowNeutralTintFloor?: boolean;
  },
): OklchColor {
  const contrastFactor = clamp(1 + contrast / 60, 0.25, 2.4);
  let lightness = applyExposureToLightness(sample.l, exposure);
  lightness = clamp(0.5 + (lightness - 0.5) * contrastFactor, 0, 1);

  let chroma = Math.max(0, sample.c * chromaScale);
  if (allowNeutralTintFloor && chromaScale > 1) {
    const floor = Math.max(
      0,
      Math.min(neutralThreshold * 0.8, neutralThreshold * 0.8 * Math.max(0, chromaScale - 1)),
    );
    chroma = Math.max(chroma, floor);
  }

  return {
    l: lightness,
    c: chroma,
    h: normalizeHue(hue),
    alpha: sample.alpha,
  };
}

function previewCssColor(color: OklchColor): string {
  return `oklch(${(clamp(color.l, 0, 1) * 100).toFixed(2)}% ${Math.max(color.c, 0).toFixed(4)} ${normalizeHue(color.h).toFixed(2)} / ${clamp(color.alpha, 0, 1).toFixed(3)})`;
}

function buildLinearGradient(stops: string[]): string {
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function resolveHueTrackLightness(chromaScale: number): number {
  const normalizedScale = clamp(chromaScale, 0, MAX_CHROMA_CONTROL_SCALE);
  return clamp(HUE_WHEEL_LIGHTNESS + (normalizedScale - 1) * 0.08, 0.62, 0.82);
}

function buildHueTrackBackground(
  chromaScale: number,
): string {
  const values = Array.from({ length: 73 }, (_, index) => -180 + index * 5);
  return buildLinearGradient(
    values.map((value, index) => {
      const color = previewCssColor({
        l: resolveHueTrackLightness(chromaScale),
        c: HUE_WHEEL_TRACK_CHROMA,
        // Keep the hue track anchored to a fixed wheel so the gradient stays stable.
        h: normalizeHue(value),
        alpha: 1,
      });
      return `${color} ${(index / (values.length - 1)) * 100}%`;
    }),
  );
}

function buildExposureTrackBackground(
  sample: OklchColor,
  {
    hue,
    chromaScale,
    contrast = 0,
    neutralThreshold = 0,
    allowNeutralTintFloor = false,
  }: {
    hue: number;
    chromaScale: number;
    contrast?: number;
    neutralThreshold?: number;
    allowNeutralTintFloor?: boolean;
  },
): string {
  const values = Array.from({ length: 21 }, (_, index) => -100 + index * 10);
  return buildLinearGradient(
    values.map((value, index) => {
      const color = previewCssColor(
        previewSampleOklch(sample, {
          hue,
          exposure: value,
          chromaScale,
          contrast,
          neutralThreshold,
          allowNeutralTintFloor,
        }),
      );
      return `${color} ${(index / (values.length - 1)) * 100}%`;
    }),
  );
}

function buildChromaTrackBackground(
  sample: OklchColor,
  {
    hue,
    exposure,
    resolveChromaScale,
    contrast = 0,
    neutralThreshold = 0,
    allowNeutralTintFloor = false,
  }: {
    hue: number;
    exposure: number;
    resolveChromaScale: (value: number) => number;
    contrast?: number;
    neutralThreshold?: number;
    allowNeutralTintFloor?: boolean;
  },
): string {
  const values = Array.from({ length: 21 }, (_, index) => index * 10);
  return buildLinearGradient(
    values.map((value, index) => {
      const color = previewCssColor(
        previewSampleOklch(sample, {
          hue,
          exposure,
          chromaScale: resolveChromaScale(value),
          contrast,
          neutralThreshold,
          allowNeutralTintFloor,
        }),
      );
      return `${color} ${(index / (values.length - 1)) * 100}%`;
    }),
  );
}

function resolveWheelRadialWeight(baseChroma: number, chromaScale: number): number {
  const baseWeight = clamp(baseChroma / WHEEL_MAX_CHROMA, 0, 1);
  const safeScale = Math.max(chromaScale, 0);
  if (safeScale <= 1) {
    return clamp(baseWeight * safeScale, 0, 1);
  }

  const lifted = clamp(
    (Math.min(safeScale, MAX_CHROMA_CONTROL_SCALE) - 1) /
      Math.max(MAX_CHROMA_CONTROL_SCALE - 1, 0.001),
    0,
    1,
  );
  return clamp(baseWeight + (1 - baseWeight) * lifted, 0, 1);
}

function App() {
  const [analysis, setAnalysis] = useState<SelectionAnalysisSummary | null>(null);
  const [status, setStatus] = useState("Reading current selection…");
  const [settings, setSettings] = useState<ExploreSettings>(DEFAULT_EXPLORE_SETTINGS);
  const [primaryTintEnabled, setPrimaryTintEnabled] = useState(false);
  const [globalRelationLightness, setGlobalRelationLightness] =
    useState<RelationLightnessValue>("0");
  const [extraHueGroups, setExtraHueGroups] = useState<ExtraHueGroup[]>([]);
  const [hiddenChromaticExtraHueGroupsByScopeId, setHiddenChromaticExtraHueGroupsByScopeId] =
    useState<Record<string, ExtraHueGroup>>({});
  const [fixedPassiveHueShiftByScopeId, setFixedPassiveHueShiftByScopeId] = useState<
    Record<string, number>
  >({});
  const [neutralRelationOverrideActive, setNeutralRelationOverrideActive] = useState(false);
  const [activeHueNodeId, setActiveHueNodeId] = useState<string | null>(null);
  const [globalLinkedEnabled, setGlobalLinkedEnabled] = useState(true);
  const [globalLinkedHueMode, setGlobalLinkedHueMode] =
    useState<ExtraHueGroupLinkMode>("manual");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    "neutral-fixed-group": true,
  });
  const [uiWidth, setUiWidth] = useState(DEFAULT_UI_WIDTH);
  const [pluginFocused, setPluginFocused] = useState(true);
  const [themeFlipEnabled, setThemeFlipEnabled] = useState(false);
  const [themeSettingsCollapsed, setThemeSettingsCollapsed] = useState(false);
  const [themeSettings, setThemeSettings] = useState<ThemeFlipSettings>(
    DEFAULT_THEME_FLIP_SETTINGS,
  );

  const shellRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const lastMappingRef = useRef<ColorMappingEntry[]>([]);
  const pluginFocusedRef = useRef(true);

  useLayoutEffect(() => {
    const applyUiColorScheme = () => {
      const nextScheme = inferUiColorScheme();
      document.documentElement.dataset.uiColorScheme = nextScheme;
      document.documentElement.style.colorScheme = nextScheme;
    };

    applyUiColorScheme();
    const rafId = window.requestAnimationFrame(applyUiColorScheme);
    window.addEventListener("focus", applyUiColorScheme);
    document.addEventListener("visibilitychange", applyUiColorScheme);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("focus", applyUiColorScheme);
      document.removeEventListener("visibilitychange", applyUiColorScheme);
    };
  }, []);

  useEffect(() => {
    const handler = (ev: MessageEvent<{ pluginMessage?: PluginToUiMessage }>) => {
      const msg = ev.data.pluginMessage;
      if (!msg) return;

      startTransition(() => {
        switch (msg.type) {
          case "selection-analysis":
            setAnalysis(msg.payload);
            setStatus(`${msg.payload.uniqueColorCount} colors · ${msg.payload.layerCount} layers`);
            break;
          case "selection-empty":
            setAnalysis(null);
            setActiveHueNodeId(null);
            setGlobalLinkedEnabled(true);
            setGlobalLinkedHueMode("manual");
            setPrimaryTintEnabled(false);
            setGlobalRelationLightness("0");
            setHiddenChromaticExtraHueGroupsByScopeId({});
            setFixedPassiveHueShiftByScopeId({});
            setNeutralRelationOverrideActive(false);
            setExtraHueGroups([]);
            setThemeFlipEnabled(false);
            setStatus(msg.message);
            break;
          case "plugin-error":
            setStatus(`Error: ${msg.message}`);
            break;
        }
      });
    };

    window.addEventListener("message", handler);
    postMsg({ type: "scan-selection" });

    return () => {
      window.removeEventListener("message", handler);
      postMsg({ type: "clear-preview" });
    };
  }, []);

  useEffect(() => {
    const syncFocus = () => {
      const nextFocused = document.visibilityState !== "hidden" && document.hasFocus();
      if (pluginFocusedRef.current === nextFocused) return;
      pluginFocusedRef.current = nextFocused;
      setPluginFocused(nextFocused);
      postMsg({ type: "ui-focus", active: nextFocused });
    };

    window.addEventListener("focus", syncFocus);
    window.addEventListener("blur", syncFocus);
    document.addEventListener("visibilitychange", syncFocus);
    syncFocus();

    return () => {
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
      document.removeEventListener("visibilitychange", syncFocus);
    };
  }, []);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    let frameId = 0;
    let lastWidth = 0;
    let lastHeight = 0;

    const syncSize = () => {
      frameId = 0;
      const inner = innerRef.current;
      const nextWidth = uiWidth;
      const nextHeight = Math.ceil(inner ? inner.offsetHeight : shell.scrollHeight);
      if (Math.abs(nextWidth - lastWidth) < 2 && Math.abs(nextHeight - lastHeight) < 2) {
        return;
      }
      lastWidth = nextWidth;
      lastHeight = nextHeight;
      postMsg({ type: "resize-ui", width: nextWidth, height: nextHeight });
    };

    const scheduleSync = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(syncSize);
    };

    const observer = new ResizeObserver(() => {
      scheduleSync();
    });

    observer.observe(shell);
    if (innerRef.current) observer.observe(innerRef.current);
    scheduleSync();

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [uiWidth]);

  const deferredAnalysis = useDeferredValue(analysis);
  const dynamicNeutralThreshold = useMemo(
    () => deriveNeutralThreshold(deferredAnalysis?.colors ?? []),
    [deferredAnalysis],
  );
  const effectiveExploreSettings = useMemo<ExploreSettings>(
    () => ({
      ...settings,
      protectNeutrals: true,
      neutralThreshold: dynamicNeutralThreshold,
      hueRange: {
        ...settings.hueRange,
        preset: "all",
        min: 0,
        max: 360,
        softness: 0,
        includeNeutrals: false,
      },
    }),
    [dynamicNeutralThreshold, settings],
  );
  const analysisColorByKey = useMemo(
    () => new Map((deferredAnalysis?.colors ?? []).map((color) => [color.key, color])),
    [deferredAnalysis],
  );
  const sourceColors = deferredAnalysis?.colors ?? [];
  const chromaticSourceColors = useMemo(
    () =>
      sourceColors.filter(
        (color) => !isNearNeutralChroma(color.oklch.c, effectiveExploreSettings.neutralThreshold),
      ),
    [effectiveExploreSettings.neutralThreshold, sourceColors],
  );
  const sourceTheme = deferredAnalysis?.themeDetection?.inferredSourceTheme ?? "light";
  const targetTheme: ThemeTarget = sourceTheme === "dark" ? "light" : "dark";
  const exploreRoleByKey = useMemo(
    () =>
      deferredAnalysis
        ? buildColorRoleIndex(deferredAnalysis.colors, effectiveExploreSettings.neutralThreshold)
        : new Map<string, ColorMappingEntry["role"]>(),
    [deferredAnalysis, effectiveExploreSettings.neutralThreshold],
  );
  const frameGroups = useMemo(
    () => buildFrameGroups(deferredAnalysis?.colors ?? [], effectiveExploreSettings.neutralThreshold),
    [deferredAnalysis, effectiveExploreSettings.neutralThreshold],
  );
  const chromaticGroups = useMemo(
    () => frameGroups.filter((group) => group.type === "chromatic"),
    [frameGroups],
  );
  const neutralGroup = useMemo(
    () => frameGroups.find((group) => group.type === "neutral") ?? null,
    [frameGroups],
  );
  const frameGroupById = useMemo(
    () => new Map(frameGroups.map((group) => [group.id, group])),
    [frameGroups],
  );
  const groupColorsById = useMemo(() => {
    const next = new Map<string, AnalysisColor[]>();
    for (const group of frameGroups) {
      const groupColors: AnalysisColor[] = [];
      for (const key of group.memberKeys) {
        const color = analysisColorByKey.get(key);
        if (color) {
          groupColors.push(color);
        }
      }
      next.set(group.id, groupColors);
    }
    return next;
  }, [analysisColorByKey, frameGroups]);
  const globalSample = useMemo(
    () =>
      summarizeOklchSample(
        chromaticSourceColors.length > 0 ? chromaticSourceColors : sourceColors,
        dominantHue(chromaticSourceColors.length > 0 ? chromaticSourceColors : sourceColors),
      ),
    [chromaticSourceColors, sourceColors],
  );
  const groupSampleById = useMemo(() => {
    const next = new Map<string, OklchColor>();
    for (const group of frameGroups) {
      next.set(
        group.id,
        summarizeOklchSample(groupColorsById.get(group.id) ?? [], group.hue ?? dominantHue(sourceColors)),
      );
    }
    return next;
  }, [frameGroups, groupColorsById, sourceColors]);
  const addedExtraGroupScopeIds = useMemo(
    () => new Set(extraHueGroups.map((group) => group.scopeId)),
    [extraHueGroups],
  );
  const extraHueGroupByScopeId = useMemo(
    () => new Map(extraHueGroups.map((group) => [group.scopeId, group])),
    [extraHueGroups],
  );
  const hiddenChromaticExtraHueGroups = useMemo(
    () => Object.values(hiddenChromaticExtraHueGroupsByScopeId),
    [hiddenChromaticExtraHueGroupsByScopeId],
  );
  const hiddenChromaticExtraHueGroupByScopeId = useMemo(
    () => new Map(hiddenChromaticExtraHueGroups.map((group) => [group.scopeId, group])),
    [hiddenChromaticExtraHueGroups],
  );
  const allExtraHueGroupByScopeId = useMemo(() => {
    const next = new Map(hiddenChromaticExtraHueGroupByScopeId);
    extraHueGroups.forEach((group) => {
      next.set(group.scopeId, group);
    });
    return next;
  }, [extraHueGroups, hiddenChromaticExtraHueGroupByScopeId]);
  const chromaticExtraHueGroups = useMemo(
    () => extraHueGroups.filter((group) => group.scopeId !== "neutral"),
    [extraHueGroups],
  );
  const primaryHueSettings = useMemo(
    () => createPrimaryScopeSettings(effectiveExploreSettings, settings.hueShift),
    [effectiveExploreSettings, settings.hueShift],
  );
  const paletteAnchorHue = useMemo(
    () => dominantHue(chromaticSourceColors.length > 0 ? chromaticSourceColors : sourceColors),
    [chromaticSourceColors, sourceColors],
  );
  const neutralAnchorHue = useMemo(
    () => normalizeHue(paletteAnchorHue),
    [paletteAnchorHue],
  );
  const masterDisplayHue = useMemo(
    () => resolveMasterHue(paletteAnchorHue, settings.hueShift),
    [paletteAnchorHue, settings.hueShift],
  );
  const primaryChromaticScopeId = chromaticGroups[0]?.id ?? null;
  const brandReferenceHue = useMemo(() => {
    if (!primaryChromaticScopeId || primaryTintEnabled) {
      return masterDisplayHue;
    }

    const primarySeparatedGroup = allExtraHueGroupByScopeId.get(primaryChromaticScopeId);
    if (!primarySeparatedGroup) {
      return masterDisplayHue;
    }

    return resolveExtraHueGroupDisplayHue(
      resolveEffectiveExtraHueGroup(primarySeparatedGroup),
      masterDisplayHue,
    );
  }, [
    allExtraHueGroupByScopeId,
    masterDisplayHue,
    primaryChromaticScopeId,
    primaryTintEnabled,
  ]);
  const brandReferenceLightness = useMemo(() => {
    if (!primaryChromaticScopeId) {
      return applyExposureToLightness(globalSample.l, settings.exposure);
    }

    const brandSample =
      groupSampleById.get(primaryChromaticScopeId) ??
      summarizeOklchSample(
        groupColorsById.get(primaryChromaticScopeId) ?? [],
        masterDisplayHue,
      );
    const primarySeparatedGroup = allExtraHueGroupByScopeId.get(primaryChromaticScopeId);
    const brandLocalExposure = primarySeparatedGroup
      ? resolveEffectiveExtraHueGroup(primarySeparatedGroup).exposure
      : 0;
    return applyExposureToLightness(brandSample.l, settings.exposure + brandLocalExposure);
  }, [
    allExtraHueGroupByScopeId,
    globalSample.l,
    groupColorsById,
    groupSampleById,
    masterDisplayHue,
    primaryChromaticScopeId,
    settings.exposure,
  ]);
  const globalPreviewSample = useMemo(
    () =>
      previewSampleOklch(globalSample, {
        hue: masterDisplayHue,
        exposure: settings.exposure,
        chromaScale: settings.chromaScale,
      }),
    [globalSample, masterDisplayHue, settings.chromaScale, settings.exposure],
  );
  const globalHueTrackBackground = useMemo(
    () => buildHueTrackBackground(settings.chromaScale),
    [settings.chromaScale],
  );
  const globalExposureTrackBackground = useMemo(
    () =>
      buildExposureTrackBackground(globalSample, {
        hue: masterDisplayHue,
        chromaScale: settings.chromaScale,
      }),
    [globalSample, masterDisplayHue, settings.chromaScale],
  );
  const globalChromaTrackBackground = useMemo(
    () =>
      buildChromaTrackBackground(globalSample, {
        hue: masterDisplayHue,
        exposure: settings.exposure,
        resolveChromaScale: (value) => value / 100,
      }),
    [globalSample, masterDisplayHue, settings.exposure],
  );
  const identityMappingByKey = useMemo(
    () => new Map(sourceColors.map((color) => [color.key, createIdentityMappingEntry(color)])),
    [sourceColors],
  );
  const activeChromaticScopeId = useMemo(() => {
    if (
      activeHueNodeId &&
      activeHueNodeId !== "all" &&
      activeHueNodeId !== "neutral" &&
      frameGroupById.get(activeHueNodeId)?.type === "chromatic"
    ) {
      return activeHueNodeId;
    }

    return chromaticExtraHueGroups[0]?.scopeId ?? chromaticGroups[0]?.id ?? null;
  }, [activeHueNodeId, chromaticExtraHueGroups, chromaticGroups, frameGroupById]);
  const activeChromaticScope = useMemo(
    () =>
      activeChromaticScopeId
        ? frameGroupById.get(activeChromaticScopeId) ?? null
        : null,
    [activeChromaticScopeId, frameGroupById],
  );
  const fixedMode = globalLinkedEnabled && globalLinkedHueMode === "manual";
  const neutralFreeMode = !globalLinkedEnabled && globalLinkedHueMode === "manual";
  const activeGlobalLinkMode = globalLinkedHueMode;
  const relationLightnessEnabled =
    activeGlobalLinkMode !== "manual" && chromaticGroups.length > 1;
  const globalLinkModeOptions = useMemo(
    () =>
      EXTRA_HUE_LINK_MODE_OPTIONS.map((option) =>
        option.value === "manual"
          ? { ...option, label: globalLinkedEnabled ? "Fixed" : "Free" }
          : option,
      ),
    [globalLinkedEnabled],
  );
  const globalRelationHueByScopeId = useMemo(() => {
    const next = new Map<string, number>();
    if (
      primaryTintEnabled ||
      globalLinkedHueMode === "manual" ||
      !primaryChromaticScopeId
    ) {
      return next;
    }

    chromaticGroups.forEach((group, index) => {
      if (!globalLinkedEnabled && allExtraHueGroupByScopeId.has(group.id)) {
        return;
      }

      next.set(
        group.id,
        resolveLinkedRelationHue(globalLinkedHueMode, brandReferenceHue, index),
      );
    });

    return next;
  }, [
    brandReferenceHue,
    chromaticGroups,
    allExtraHueGroupByScopeId,
    globalLinkedEnabled,
    globalLinkedHueMode,
    primaryChromaticScopeId,
    primaryTintEnabled,
  ]);
  const resolveRelationLightnessOffset = (
    scopeId: string,
    linkedRelationHue: number | undefined,
    sample: OklchColor,
    isNeutralScope = false,
  ): number => {
    if (
      !relationLightnessEnabled ||
      isNeutralScope ||
      linkedRelationHue === undefined ||
      scopeId === primaryChromaticScopeId
    ) {
      return 0;
    }

    if (globalRelationLightness === "same") {
      return resolveExposureForLightness(sample.l, brandReferenceLightness);
    }

    return Number(globalRelationLightness);
  };
  const capturePassiveFixedHueShifts = (currentGroups: ExtraHueGroup[]) => {
    const currentGroupByScopeId = new Map(
      [...hiddenChromaticExtraHueGroups, ...currentGroups].map((group) => [group.scopeId, group]),
    );

    return Object.fromEntries(
      chromaticGroups
        .filter((group) => !currentGroupByScopeId.has(group.id))
        .map((group) => {
          const currentHue =
            globalRelationHueByScopeId.get(group.id) ??
            (() => {
              const fixedHueShift = fixedPassiveHueShiftByScopeId[group.id];
              return fixedHueShift !== undefined
                ? normalizeHue(masterDisplayHue + fixedHueShift)
                : resolvePassiveGroupHue(
                    group,
                    masterDisplayHue,
                    settings.hueShift,
                    primaryTintEnabled,
                  );
            })();

          return [group.id, hueShiftBetween(masterDisplayHue, currentHue)];
        }),
    );
  };

  const wheelNodes = useMemo<HueRelationWheelNode[]>(() => {
    const next: HueRelationWheelNode[] = [
      {
        id: "all",
        kind: "master",
        label: "All colors",
        displayHue: masterDisplayHue,
      },
    ];

    for (const group of chromaticGroups) {
      const visibleGroup = extraHueGroupByScopeId.get(group.id);
      const separatedGroup = visibleGroup ?? hiddenChromaticExtraHueGroupByScopeId.get(group.id);
      const effectiveGroup = separatedGroup ? resolveEffectiveExtraHueGroup(separatedGroup) : null;
      const tintLocked = primaryTintEnabled;
      const sample =
        groupSampleById.get(group.id) ??
        summarizeOklchSample(groupColorsById.get(group.id) ?? [], group.hue ?? masterDisplayHue);
      const linkedRelationHue = globalRelationHueByScopeId.get(group.id);
      const relationLightnessOffset = resolveRelationLightnessOffset(
        group.id,
        linkedRelationHue,
        sample,
      );
      const fixedPassiveHueShift = fixedPassiveHueShiftByScopeId[group.id];
      const displayHue = tintLocked
        ? masterDisplayHue
        : linkedRelationHue !== undefined
        ? linkedRelationHue
        : effectiveGroup
        ? resolveExtraHueGroupDisplayHue(effectiveGroup, masterDisplayHue)
        : fixedPassiveHueShift !== undefined
        ? normalizeHue(masterDisplayHue + fixedPassiveHueShift)
        : resolvePassiveGroupHue(group, masterDisplayHue, settings.hueShift, primaryTintEnabled);
      const previewColor = previewSampleOklch(sample, {
        hue: displayHue,
        exposure: settings.exposure + relationLightnessOffset + (effectiveGroup?.exposure ?? 0),
        chromaScale: settings.chromaScale * (effectiveGroup?.chromaScale ?? 1),
      });

      next.push({
        id: group.id,
        kind: "group",
        label: group.name,
        displayHue,
        memberCount: group.memberKeys.length,
        accentHex: previewCssColor(previewColor),
        displayChroma: previewColor.c,
        radialWeight: resolveWheelRadialWeight(
          sample.c,
          settings.chromaScale * (effectiveGroup?.chromaScale ?? 1),
        ),
        isSeparated: Boolean(visibleGroup),
        isLinked: tintLocked || globalLinkedEnabled,
        isInteractive: !tintLocked,
        canActivate: false,
      });
    }

    if (neutralGroup) {
      const neutralControl = extraHueGroupByScopeId.get("neutral");
      const effectiveNeutralControl = neutralControl
        ? resolveEffectiveExtraHueGroup(neutralControl)
        : null;
      const neutralTintStrength = effectiveNeutralControl
        ? clamp((effectiveNeutralControl.chromaScale - 1) / MAX_NEUTRAL_WHEEL_TINT, 0, 1)
        : 0;
      const neutralSample =
        groupSampleById.get("neutral") ??
        summarizeOklchSample(groupColorsById.get("neutral") ?? [], neutralAnchorHue);
      const neutralBaseHue = effectiveNeutralControl
        ? resolveExtraHueGroupDisplayHue(effectiveNeutralControl, neutralAnchorHue)
        : neutralAnchorHue;
      const neutralRelationHue = neutralRelationOverrideActive
        ? undefined
        : resolveNeutralRelationHue(
            globalLinkedHueMode,
            brandReferenceHue,
            neutralBaseHue,
            effectiveNeutralControl?.chromaScale ?? 1,
          );
      const neutralPreviewColor = previewSampleOklch(neutralSample, {
        hue: neutralRelationHue ?? neutralBaseHue,
        exposure: effectiveNeutralControl?.exposure ?? 0,
        chromaScale: effectiveNeutralControl?.chromaScale ?? 1,
        contrast: effectiveNeutralControl?.contrast ?? 0,
        neutralThreshold: effectiveExploreSettings.neutralThreshold,
        allowNeutralTintFloor: true,
      });
      next.push({
        id: neutralGroup.id,
        kind: "neutral-center",
        label: neutralGroup.name,
        displayHue: neutralPreviewColor.h,
        memberCount: neutralGroup.memberKeys.length,
        accentHex: previewCssColor(neutralPreviewColor),
        displayChroma: neutralPreviewColor.c,
        radialWeight: neutralTintStrength,
        isSeparated: true,
        isInteractive: true,
        neutralTintStrength,
      });
    }

    return next;
  }, [
    chromaticGroups,
    effectiveExploreSettings.neutralThreshold,
    extraHueGroupByScopeId,
    hiddenChromaticExtraHueGroupByScopeId,
    fixedPassiveHueShiftByScopeId,
    brandReferenceLightness,
    globalRelationHueByScopeId,
    globalRelationLightness,
    globalLinkedHueMode,
    groupColorsById,
    groupSampleById,
    masterDisplayHue,
    neutralRelationOverrideActive,
    neutralAnchorHue,
    neutralGroup,
    globalLinkedEnabled,
    primaryTintEnabled,
    primaryChromaticScopeId,
    relationLightnessEnabled,
    settings.chromaScale,
    settings.exposure,
    settings.hueShift,
  ]);

  const demoEntries = useMemo<ColorMappingEntry[]>(() => {
    const primaryHueBaseMapping =
      sourceColors.length > 0
        ? buildExploreMapping(sourceColors, primaryHueSettings, exploreRoleByKey)
        : {};
    const primaryHueMapping =
      primaryTintEnabled && sourceColors.length > 0
        ? applyTintMapping(
            primaryHueBaseMapping,
            masterDisplayHue,
            effectiveExploreSettings.neutralThreshold,
          )
        : primaryHueBaseMapping;
    const globalRelationMapping = chromaticGroups.reduce<Record<string, ColorMappingEntry>>(
      (combined, group) => {
        const targetGroupHue = globalRelationHueByScopeId.get(group.id);
        if (targetGroupHue === undefined || group.id === primaryChromaticScopeId) {
          return combined;
        }

        const groupColors = groupColorsById.get(group.id) ?? [];
        if (groupColors.length === 0) {
          return combined;
        }
        const sample =
          groupSampleById.get(group.id) ??
          summarizeOklchSample(groupColors, group.hue ?? masterDisplayHue);
        const relationLightnessOffset = resolveRelationLightnessOffset(
          group.id,
          targetGroupHue,
          sample,
        );

        const groupSettings = createScopedHueSettings(
          {
            ...effectiveExploreSettings,
            hueRange: {
              ...effectiveExploreSettings.hueRange,
              preset: "all",
              min: 0,
              max: 360,
              softness: 0,
              includeNeutrals: false,
            },
          },
          group.hue === null
            ? normalizeSignedHueShift(targetGroupHue)
            : hueShiftBetween(group.hue, targetGroupHue),
          effectiveExploreSettings.exposure + relationLightnessOffset,
          effectiveExploreSettings.chromaScale,
        );

        return {
          ...combined,
          ...buildExploreMapping(groupColors, groupSettings, exploreRoleByKey),
        };
      },
      {},
    );
    const manualFixedMapping =
      globalLinkedHueMode === "manual"
        ? chromaticGroups.reduce<Record<string, ColorMappingEntry>>((combined, group) => {
            if (allExtraHueGroupByScopeId.has(group.id)) {
              return combined;
            }

            const fixedHueShift = fixedPassiveHueShiftByScopeId[group.id];
            if (fixedHueShift === undefined) {
              return combined;
            }

            const groupColors = groupColorsById.get(group.id) ?? [];
            if (groupColors.length === 0) {
              return combined;
            }

            const targetGroupHue = normalizeHue(masterDisplayHue + fixedHueShift);
            const groupSettings = createScopedHueSettings(
              {
                ...effectiveExploreSettings,
                hueRange: {
                  ...effectiveExploreSettings.hueRange,
                  preset: "all",
                  min: 0,
                  max: 360,
                  softness: 0,
                  includeNeutrals: false,
                },
              },
              group.hue === null
                ? normalizeSignedHueShift(targetGroupHue)
                : hueShiftBetween(group.hue, targetGroupHue),
              effectiveExploreSettings.exposure,
              effectiveExploreSettings.chromaScale,
            );

            return {
              ...combined,
              ...buildExploreMapping(groupColors, groupSettings, exploreRoleByKey),
            };
          }, {})
        : {};

    const extraHueMapping = [...hiddenChromaticExtraHueGroups, ...extraHueGroups].reduce<
      Record<string, ColorMappingEntry>
    >(
      (combined, group) => {
        const groupColors = groupColorsById.get(group.scopeId) ?? [];
        const scope = frameGroupById.get(group.scopeId);
        if (groupColors.length === 0 || !scope) {
          return combined;
        }

        const sample =
          groupSampleById.get(group.scopeId) ??
          summarizeOklchSample(groupColors, scope.hue ?? masterDisplayHue);
        const effectiveGroup = resolveEffectiveExtraHueGroup(group);
        const isNeutralScope = group.scopeId === "neutral";
        const neutralBaseHue = isNeutralScope
          ? resolveExtraHueGroupDisplayHue(effectiveGroup, neutralAnchorHue)
          : undefined;
        const linkedRelationHue = isNeutralScope
          ? neutralRelationOverrideActive
            ? undefined
            : resolveNeutralRelationHue(
                globalLinkedHueMode,
                brandReferenceHue,
                neutralBaseHue ?? neutralAnchorHue,
                effectiveGroup.chromaScale,
              )
          : globalRelationHueByScopeId.get(group.scopeId);
        const relationLightnessOffset = resolveRelationLightnessOffset(
          group.scopeId,
          linkedRelationHue,
          sample,
          isNeutralScope,
        );
        const targetGroupHue = isNeutralScope
          ? linkedRelationHue ?? (neutralBaseHue ?? neutralAnchorHue)
          : linkedRelationHue !== undefined
            ? linkedRelationHue
          : resolveExtraHueGroupDisplayHue(effectiveGroup, masterDisplayHue);
        const resolvedTintHue = isNeutralScope
          ? targetGroupHue
          : primaryTintEnabled
            ? masterDisplayHue
            : targetGroupHue;
        const combinedChromaScale =
          isNeutralScope
            ? effectiveGroup.chromaScale
            : effectiveExploreSettings.chromaScale * effectiveGroup.chromaScale;
        const groupSettings = createScopedHueSettings(
          {
            ...effectiveExploreSettings,
            protectNeutrals: isNeutralScope ? false : effectiveExploreSettings.protectNeutrals,
            hueRange: {
              ...effectiveExploreSettings.hueRange,
              preset: isNeutralScope ? "neutrals" : "all",
              min: 0,
              max: 360,
              softness: 0,
              includeNeutrals: isNeutralScope,
            },
          },
          scope.hue === null
            ? normalizeSignedHueShift(targetGroupHue)
            : hueShiftBetween(scope.hue, targetGroupHue),
          isNeutralScope
            ? effectiveGroup.exposure
            : effectiveExploreSettings.exposure + relationLightnessOffset + effectiveGroup.exposure,
          combinedChromaScale,
          isNeutralScope ? effectiveGroup.contrast : 0,
        );

        const groupMapping = buildExploreMapping(groupColors, groupSettings, exploreRoleByKey);
        const neutralLiftedMapping = isNeutralScope
          ? applyNeutralChromaFloor(
              groupMapping,
              targetGroupHue,
              effectiveExploreSettings.neutralThreshold,
              combinedChromaScale,
            )
          : groupMapping;
        const shouldTintScope = isNeutralScope
          ? (
              group.linkMode !== "manual" ||
              Math.abs(normalizeSignedHueShift(effectiveGroup.hueShift)) > 0.001 ||
              effectiveGroup.chromaScale > 1.001
            )
          : primaryTintEnabled;

        return {
          ...combined,
          ...(shouldTintScope
            ? applyTintMapping(
                neutralLiftedMapping,
                resolvedTintHue,
                effectiveExploreSettings.neutralThreshold,
                isNeutralScope,
              )
            : neutralLiftedMapping),
        };
      },
      {},
    );

    return sourceColors.map((color) => {
      const identity = identityMappingByKey.get(color.key) ?? createIdentityMappingEntry(color);
      return (
        extraHueMapping[color.key] ??
        manualFixedMapping[color.key] ??
        globalRelationMapping[color.key] ??
        primaryHueMapping[color.key] ??
        identity
      );
    });
  }, [
    chromaticGroups,
    effectiveExploreSettings,
    exploreRoleByKey,
    extraHueGroups,
    extraHueGroupByScopeId,
    frameGroupById,
    fixedPassiveHueShiftByScopeId,
    brandReferenceLightness,
    globalRelationLightness,
    globalRelationHueByScopeId,
    globalLinkedHueMode,
    groupColorsById,
    identityMappingByKey,
    primaryChromaticScopeId,
    primaryHueSettings,
    primaryTintEnabled,
    relationLightnessEnabled,
    brandReferenceHue,
    neutralRelationOverrideActive,
    sourceColors,
    masterDisplayHue,
    neutralAnchorHue,
  ]);

  const themedDemoEntries = useMemo(
    () =>
      themeFlipEnabled
        ? applyThemeFlip(
            demoEntries,
            analysisColorByKey,
            themeSettings,
            targetTheme,
            deferredAnalysis?.themeDetection,
          )
        : demoEntries,
    [
      analysisColorByKey,
      deferredAnalysis?.themeDetection,
      demoEntries,
      targetTheme,
      themeFlipEnabled,
      themeSettings,
    ],
  );

  useEffect(() => {
    setExtraHueGroups((current) =>
      current.filter((group) => frameGroupById.has(group.scopeId)),
    );
  }, [frameGroupById]);

  useEffect(() => {
    setFixedPassiveHueShiftByScopeId((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([scopeId]) => frameGroupById.get(scopeId)?.type === "chromatic",
        ),
      ),
    );
  }, [frameGroupById]);

  useEffect(() => {
    setHiddenChromaticExtraHueGroupsByScopeId((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([scopeId]) => frameGroupById.get(scopeId)?.type === "chromatic",
        ),
      ),
    );
  }, [frameGroupById]);

  useEffect(() => {
    setExtraHueGroups((current) => {
      const withoutNeutral = current.filter((group) => group.scopeId !== "neutral");
      if (!neutralGroup) {
        return withoutNeutral.length === current.length ? current : withoutNeutral;
      }

      const existingNeutral = current.find((group) => group.scopeId === "neutral");
      const nextNeutral = existingNeutral
        ? { ...existingNeutral, id: "neutral-fixed-group", scopeId: "neutral" }
        : createNeutralExtraHueGroup();
      return [nextNeutral, ...withoutNeutral];
    });
  }, [neutralGroup]);

  useEffect(() => {
    lastMappingRef.current = themedDemoEntries;
    if (!pluginFocused || !deferredAnalysis || themedDemoEntries.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      postMsg({ type: "preview-colors", mapping: themedDemoEntries });
    }, 60);

    return () => window.clearTimeout(timeoutId);
  }, [deferredAnalysis, pluginFocused, themedDemoEntries]);

  const handleReset = () => {
    setActiveHueNodeId(null);
    setGlobalLinkedEnabled(true);
    setGlobalLinkedHueMode("manual");
    setPrimaryTintEnabled(false);
    setGlobalRelationLightness("0");
    setHiddenChromaticExtraHueGroupsByScopeId({});
    setFixedPassiveHueShiftByScopeId({});
    setNeutralRelationOverrideActive(false);
    setExtraHueGroups([]);
    setSettings(DEFAULT_EXPLORE_SETTINGS);
    setThemeSettings(DEFAULT_THEME_FLIP_SETTINGS);
    setThemeFlipEnabled(false);
    postMsg({ type: "restore-baseline" });
  };

  const handleCompareStart = () => {
    postMsg({ type: "clear-preview" });
  };

  const handleCompareEnd = () => {
    if (lastMappingRef.current.length > 0) {
      postMsg({ type: "preview-colors", mapping: lastMappingRef.current });
    }
  };

  const upsertChromaticExtraHueGroup = (
    scopeId: string,
    nextLinkMode: ExtraHueGroupLinkMode = "manual",
  ) => {
    const hiddenGroup = hiddenChromaticExtraHueGroupByScopeId.get(scopeId);
    if (hiddenGroup) {
      setHiddenChromaticExtraHueGroupsByScopeId((current) => {
        const next = { ...current };
        delete next[scopeId];
        return next;
      });
      setExtraHueGroups((current) => {
        const existingGroup = current.find((group) => group.scopeId === scopeId);
        if (existingGroup) {
          return current;
        }

        const restoredGroup =
          nextLinkMode === "manual"
            ? materializeManualExtraHueGroup(hiddenGroup)
            : { ...materializeManualExtraHueGroup(hiddenGroup), linkMode: nextLinkMode };
        return [...current, restoredGroup];
      });
      return;
    }

    setExtraHueGroups((current) => {
      const existingGroup = current.find((group) => group.scopeId === scopeId);
      if (existingGroup) {
        if (existingGroup.linkMode === nextLinkMode) {
          return current;
        }
        return current.map((group) => {
          if (group.scopeId !== scopeId) return group;
          if (nextLinkMode === "manual") {
            return materializeManualExtraHueGroup(group);
          }
          return { ...group, linkMode: nextLinkMode };
        });
      }

      const scope = frameGroupById.get(scopeId);
      if (!scope || scope.type !== "chromatic") {
        return current;
      }
      const currentDisplayHue =
        globalRelationHueByScopeId.get(scopeId) ??
        (fixedPassiveHueShiftByScopeId[scopeId] !== undefined
          ? normalizeHue(masterDisplayHue + fixedPassiveHueShiftByScopeId[scopeId]!)
          :
        resolvePassiveGroupHue(
          scope,
          masterDisplayHue,
          settings.hueShift,
          primaryTintEnabled,
        ));
      return [
        ...current,
        {
          id: `${scopeId}-${Date.now()}`,
          scopeId,
          linkMode: nextLinkMode,
          hueShift: hueShiftBetween(masterDisplayHue, currentDisplayHue),
          exposure: 0,
          contrast: 0,
          chromaScale: 1,
        },
      ];
    });
  };

  const handleAddExtraHueGroup = (scopeId: string) => {
    upsertChromaticExtraHueGroup(scopeId);
    setActiveHueNodeId(scopeId);
  };

  const handleRemoveExtraHueGroup = (id: string) => {
    const removedGroup = extraHueGroups.find((group) => group.id === id);
    if (removedGroup && removedGroup.scopeId !== "neutral") {
      setHiddenChromaticExtraHueGroupsByScopeId((current) => ({
        ...current,
        [removedGroup.scopeId]: materializeManualExtraHueGroup(removedGroup),
      }));
    }
    setExtraHueGroups((current) =>
      current.filter((group) => group.id !== id || group.scopeId === "neutral"),
    );
  };

  const handleExtraHueGroupChange = (
    id: string,
    patch:
      | Partial<ExtraHueGroup>
      | ((group: ExtraHueGroup) => ExtraHueGroup),
  ) => {
    setExtraHueGroups((current) =>
      current.map((group) => {
        if (group.id !== id) return group;
        return typeof patch === "function" ? patch(group) : { ...group, ...patch };
      }),
    );
  };

  const handleExtraHueGroupManualSliderChange = (
    id: string,
    patch:
      | Partial<Pick<ExtraHueGroup, "hueShift" | "exposure" | "contrast" | "chromaScale">>
      | ((
          group: ExtraHueGroup,
        ) => Partial<Pick<ExtraHueGroup, "hueShift" | "exposure" | "contrast" | "chromaScale">>),
  ) => {
    handleExtraHueGroupChange(id, (group) => {
      const manualGroup =
        group.linkMode === "manual"
          ? group
          : materializeManualExtraHueGroup(group);
      const nextPatch = typeof patch === "function" ? patch(manualGroup) : patch;
      return { ...manualGroup, ...nextPatch };
    });
  };

  const handleGlobalExtraHueLinkToggle = (nextLinked: boolean) => {
    if (globalLinkedHueMode !== "manual") {
      setFixedPassiveHueShiftByScopeId(capturePassiveFixedHueShifts(extraHueGroups));
    }
    setNeutralRelationOverrideActive(false);
    setGlobalLinkedEnabled(nextLinked);
    setGlobalLinkedHueMode("manual");
    if (nextLinked) {
      return;
    }

    setExtraHueGroups((current) =>
      current.map((group) =>
        group.scopeId === "neutral" ? group : materializeManualExtraHueGroup(group),
      ),
    );
  };

  const handleGlobalExtraHueLinkModeChange = (nextMode: ExtraHueGroupLinkMode) => {
    if (nextMode === "manual" && globalLinkedHueMode !== "manual") {
      setFixedPassiveHueShiftByScopeId(capturePassiveFixedHueShifts(extraHueGroups));
    }
    if (nextMode !== "manual") {
      setFixedPassiveHueShiftByScopeId({});
      setNeutralRelationOverrideActive(false);
    }
    setGlobalLinkedHueMode(nextMode);
    if (nextMode !== "manual") {
      setGlobalLinkedEnabled(true);
    }
    if (activeChromaticScopeId) {
      setActiveHueNodeId(activeChromaticScopeId);
    }
  };

  const rotateFixedPaletteByDelta = (delta: number) => {
    const nextMasterHue = normalizeHue(masterDisplayHue + delta);
    setSettings((current) => ({
      ...current,
      hueShift: hueShiftBetween(paletteAnchorHue, nextMasterHue),
    }));
    setExtraHueGroups((current) =>
      current.map((group) => {
        if (group.scopeId !== "neutral") return group;
        const manualGroup =
          group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
        return {
          ...manualGroup,
          hueShift: normalizeSignedHueShift(manualGroup.hueShift + delta),
        };
      }),
    );
  };

  const handleMasterWheelChange = (nextHue: number) => {
    setActiveHueNodeId("all");
    if (fixedMode) {
      rotateFixedPaletteByDelta(hueShiftBetween(masterDisplayHue, nextHue));
      return;
    }

    setSettings((current) => ({
      ...current,
      hueShift: hueShiftBetween(paletteAnchorHue, nextHue),
    }));
  };

  const handleGroupWheelChange = (
    scopeId: string,
    nextHue: number,
    forceIndependent = false,
  ) => {
    setActiveHueNodeId(scopeId);
    if (forceIndependent && globalLinkedEnabled) {
      if (globalLinkedHueMode !== "manual") {
        setFixedPassiveHueShiftByScopeId(capturePassiveFixedHueShifts(extraHueGroups));
      }
      setGlobalLinkedEnabled(false);
      setGlobalLinkedHueMode("manual");
      setExtraHueGroups((current) => {
        const existingGroup = current.find((group) => group.scopeId === scopeId);
        if (!existingGroup) {
          const hiddenGroup = hiddenChromaticExtraHueGroupByScopeId.get(scopeId);
          if (hiddenGroup) {
            setHiddenChromaticExtraHueGroupsByScopeId((hiddenCurrent) => {
              const next = { ...hiddenCurrent };
              delete next[scopeId];
              return next;
            });
            return [
              ...current,
              {
                ...materializeManualExtraHueGroup(hiddenGroup),
                hueShift: hueShiftBetween(masterDisplayHue, nextHue),
              },
            ];
          }
          const scope = frameGroupById.get(scopeId);
          if (!scope || scope.type !== "chromatic") {
            return current;
          }
          return [
            ...current,
            {
              id: `${scopeId}-${Date.now()}`,
              scopeId,
              linkMode: "manual",
              hueShift: hueShiftBetween(masterDisplayHue, nextHue),
              exposure: 0,
              contrast: 0,
              chromaScale: 1,
            },
          ];
        }

        return current.map((group) => {
          if (group.scopeId !== scopeId) return group;
          const manualGroup =
            group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
          return {
            ...manualGroup,
            hueShift: hueShiftBetween(masterDisplayHue, nextHue),
          };
        });
      });
      return;
    }

    if (fixedMode) {
      const scope = frameGroupById.get(scopeId);
      if (!scope) {
        return;
      }

      const currentDisplayHue =
        fixedPassiveHueShiftByScopeId[scopeId] !== undefined
          ? normalizeHue(masterDisplayHue + fixedPassiveHueShiftByScopeId[scopeId]!)
          : (() => {
              const separatedGroup = allExtraHueGroupByScopeId.get(scopeId);
              return separatedGroup
                ? resolveExtraHueGroupDisplayHue(
                    resolveEffectiveExtraHueGroup(separatedGroup),
                    masterDisplayHue,
                  )
                : resolvePassiveGroupHue(
                    scope,
                    masterDisplayHue,
                    settings.hueShift,
                    primaryTintEnabled,
                  );
            })();
      rotateFixedPaletteByDelta(hueShiftBetween(currentDisplayHue, nextHue));
      return;
    }

    if (globalLinkedEnabled) {
      const scope = frameGroupById.get(scopeId);
      if (!scope) {
        return;
      }

      const currentDisplayHue =
        globalRelationHueByScopeId.get(scopeId) ??
        (() => {
          const separatedGroup = allExtraHueGroupByScopeId.get(scopeId);
          return separatedGroup
            ? resolveExtraHueGroupDisplayHue(
                resolveEffectiveExtraHueGroup(separatedGroup),
                masterDisplayHue,
              )
            : fixedPassiveHueShiftByScopeId[scopeId] !== undefined
              ? normalizeHue(masterDisplayHue + fixedPassiveHueShiftByScopeId[scopeId]!)
            : resolvePassiveGroupHue(
                scope,
                masterDisplayHue,
                settings.hueShift,
                primaryTintEnabled,
              );
        })();
      const delta = hueShiftBetween(currentDisplayHue, nextHue);
      const nextMasterHue = normalizeHue(masterDisplayHue + delta);
      setSettings((current) => ({
        ...current,
        hueShift: hueShiftBetween(paletteAnchorHue, nextMasterHue),
      }));
      return;
    }

    setExtraHueGroups((current) => {
      const existingGroup = current.find((group) => group.scopeId === scopeId);
      if (!existingGroup) {
        const hiddenGroup = hiddenChromaticExtraHueGroupByScopeId.get(scopeId);
        if (hiddenGroup) {
          setHiddenChromaticExtraHueGroupsByScopeId((hiddenCurrent) => {
            const next = { ...hiddenCurrent };
            delete next[scopeId];
            return next;
          });
          return [
            ...current,
            {
              ...materializeManualExtraHueGroup(hiddenGroup),
              hueShift: hueShiftBetween(masterDisplayHue, nextHue),
            },
          ];
        }
        const scope = frameGroupById.get(scopeId);
        if (!scope || scope.type !== "chromatic") {
          return current;
        }
        return [
          ...current,
          {
            id: `${scopeId}-${Date.now()}`,
            scopeId,
            linkMode: "manual",
            hueShift: hueShiftBetween(masterDisplayHue, nextHue),
            exposure: 0,
            contrast: 0,
            chromaScale: 1,
          },
        ];
      }

      return current.map((group) => {
        if (group.scopeId !== scopeId) return group;
        const manualGroup =
          group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
        return {
          ...manualGroup,
          hueShift: hueShiftBetween(masterDisplayHue, nextHue),
        };
      });
    });
  };

  const handleWheelGroupUnlink = (scopeId: string) => {
    if (!globalLinkedEnabled) {
      return;
    }

    if (globalLinkedHueMode !== "manual") {
      setFixedPassiveHueShiftByScopeId(capturePassiveFixedHueShifts(extraHueGroups));
    }
    handleAddExtraHueGroup(scopeId);
    setGlobalLinkedEnabled(false);
    setGlobalLinkedHueMode("manual");
    setActiveHueNodeId(scopeId);
  };

  const handleNeutralWheelChange = (
    nextHue: number,
    tintStrength: number,
    forceIndependent = false,
  ) => {
    setActiveHueNodeId("neutral");
    const neutralControl = extraHueGroupByScopeId.get("neutral");
    const effectiveNeutralControl = neutralControl
      ? resolveEffectiveExtraHueGroup(neutralControl)
      : createNeutralExtraHueGroup();
    const neutralBaseHue = resolveExtraHueGroupDisplayHue(
      effectiveNeutralControl,
      neutralAnchorHue,
    );
    const isNearCenter = tintStrength < 0.06;

    if (forceIndependent && !neutralFreeMode) {
      handleGlobalExtraHueLinkToggle(false);
      setNeutralRelationOverrideActive(false);
      setExtraHueGroups((current) =>
        current.map((group) => {
          if (group.scopeId !== "neutral") return group;
          const manualGroup =
            group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
          return {
            ...manualGroup,
            hueShift: isNearCenter ? 0 : hueShiftBetween(neutralAnchorHue, nextHue),
            chromaScale: isNearCenter
              ? 1
              : 1 + clamp(tintStrength, 0, 1) * MAX_NEUTRAL_WHEEL_TINT,
          };
        }),
      );
      return;
    }

    if (fixedMode) {
      rotateFixedPaletteByDelta(hueShiftBetween(neutralBaseHue, nextHue));
      return;
    }

    if (!neutralFreeMode) {
      setNeutralRelationOverrideActive(true);
      setExtraHueGroups((current) =>
        current.map((group) => {
          if (group.scopeId !== "neutral") return group;
          const manualGroup =
            group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
          return {
            ...manualGroup,
            hueShift: hueShiftBetween(neutralAnchorHue, nextHue),
          };
        }),
      );
      return;
    }

    setExtraHueGroups((current) =>
      current.map((group) => {
        if (group.scopeId !== "neutral") return group;
        const manualGroup =
          group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
        return {
          ...manualGroup,
          hueShift: isNearCenter ? 0 : hueShiftBetween(neutralAnchorHue, nextHue),
          chromaScale: isNearCenter
            ? 1
            : 1 + clamp(tintStrength, 0, 1) * MAX_NEUTRAL_WHEEL_TINT,
        };
      }),
    );
  };

  const handleNeutralWheelDoubleClick = () => {
    setActiveHueNodeId("neutral");

    if (neutralFreeMode) {
      setNeutralRelationOverrideActive(false);
      setExtraHueGroups((current) =>
        current.map((group) => {
          if (group.scopeId !== "neutral") return group;
          const manualGroup =
            group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
          return {
            ...manualGroup,
            hueShift: 0,
            chromaScale: 1,
          };
        }),
      );
      return;
    }

    const neutralControl = extraHueGroupByScopeId.get("neutral");
    const effectiveNeutralControl = neutralControl
      ? resolveEffectiveExtraHueGroup(neutralControl)
      : createNeutralExtraHueGroup();
    const neutralBaseHue = resolveExtraHueGroupDisplayHue(
      effectiveNeutralControl,
      neutralAnchorHue,
    );
    const neutralDisplayHue =
      (neutralRelationOverrideActive
        ? undefined
        : resolveNeutralRelationHue(
            globalLinkedHueMode,
            brandReferenceHue,
            neutralBaseHue,
            effectiveNeutralControl.chromaScale,
          )) ?? neutralBaseHue;

    handleGlobalExtraHueLinkToggle(false);
    setNeutralRelationOverrideActive(false);
    setExtraHueGroups((current) =>
      current.map((group) => {
        if (group.scopeId !== "neutral") return group;
        const manualGroup =
          group.linkMode === "manual" ? group : materializeManualExtraHueGroup(group);
        return {
          ...manualGroup,
          hueShift: hueShiftBetween(neutralAnchorHue, neutralDisplayHue),
        };
      }),
    );
  };

  const handleHueQuickShift = (preset: "-30" | "+30" | "comp" | "analog") => {
    const shifts = {
      "-30": -30,
      "+30": 30,
      comp: 180,
      analog: 30,
    } satisfies Record<"-30" | "+30" | "comp" | "analog", number>;

    setSettings((current) => ({
      ...current,
      hueShift: normalizeSignedHueShift(current.hueShift + shifts[preset]),
    }));
  };

  const handleResizeDragStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = uiWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(
        MIN_UI_WIDTH,
        Math.min(MAX_UI_WIDTH, Math.round(startWidth + (moveEvent.clientX - startX))),
      );
      setUiWidth(nextWidth);
    };

    const onUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toggleGroupCollapsed = (groupId: string) => {
    setCollapsedGroups((current) => ({
      ...current,
      [groupId]: !current[groupId],
    }));
  };

  return (
    <div className="shell" ref={shellRef}>
      <div ref={innerRef} className={`shell-inner${analysis ? "" : " is-empty"}`}>
        {!analysis ? (
          <div className="empty">
            <IconEmptyState />
            <p className="empty-text">Select a frame or layers with fills, strokes, or text colors to analyze them.</p>
          </div>
        ) : (
          <div className="content">
            <Section>
              <div className="control-stack">
                <div
                  className="main-controls hue-group-card main-controls-card"
                >
                  <CardHeader
                    title="All colors"
                    actions={
                      <div className="global-harmony-actions">
                        <button
                          type="button"
                          className={`btn-ghost icon-btn${globalLinkedEnabled ? " is-active" : ""}`}
                          title={globalLinkedEnabled ? "Linked" : "Unlinked"}
                          aria-label={globalLinkedEnabled ? "Linked" : "Unlinked"}
                          disabled={chromaticGroups.length === 0}
                          onClick={() => handleGlobalExtraHueLinkToggle(!globalLinkedEnabled)}
                        >
                          <IconLink linked={globalLinkedEnabled} />
                        </button>
                      </div>
                    }
                  />
                  <HueRelationWheel
                    nodes={wheelNodes}
                    activeId={activeHueNodeId}
                    onActiveChange={setActiveHueNodeId}
                    onMasterHueChange={handleMasterWheelChange}
                    onGroupHueChange={handleGroupWheelChange}
                    onGroupActivate={handleAddExtraHueGroup}
                    onGroupUnlink={handleWheelGroupUnlink}
                    onNeutralChange={handleNeutralWheelChange}
                    onNeutralDoubleClick={handleNeutralWheelDoubleClick}
                  />
                  <div className="global-harmony-controls">
                    <SelectField
                      ariaLabel={
                        activeChromaticScope
                          ? `${activeChromaticScope.name} relation`
                          : "Color relation"
                      }
                      value={activeGlobalLinkMode}
                      options={globalLinkModeOptions}
                      unstyled
                      disabled={!activeChromaticScope}
                      fill
                      onChange={(value) =>
                        handleGlobalExtraHueLinkModeChange(
                          value as ExtraHueGroupLinkMode,
                        )
                      }
                    />
                    <SelectField
                      ariaLabel="Relation lightness"
                      value={globalRelationLightness}
                      options={[...RELATION_LIGHTNESS_OPTIONS]}
                      unstyled
                      disabled={!relationLightnessEnabled}
                      fill
                      onChange={(value) =>
                        setGlobalRelationLightness(value as RelationLightnessValue)
                      }
                    />
                  </div>
                  <div className="hue-cluster">
                    <RangeField
                      label="Hue"
                      min={-180}
                      max={180}
                      step={1}
                      value={settings.hueShift}
                      display={fmt(settings.hueShift, "°")}
                      resetValue={0}
                      variant="hue"
                      inputStyle={{
                        "--range-track-background": globalHueTrackBackground,
                      } as CSSProperties}
                      onChange={(value) =>
                        setSettings((current) => ({ ...current, hueShift: value }))
                      }
                    />
                    <div className="button-row compact hue-quick-row">
                      {(["-30", "+30", "comp", "analog"] as const).map((preset) => (
                        <button
                          key={`primary-${preset}`}
                          className="btn-ghost"
                          onClick={() => handleHueQuickShift(preset)}
                        >
                          {preset === "-30"
                            ? "−30°"
                            : preset === "+30"
                              ? "+30°"
                              : preset === "comp"
                                ? "Comp"
                                : "Analog"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <RangeField
                    label="Exposure"
                    min={-100}
                    max={100}
                    step={1}
                    value={settings.exposure}
                    display={fmt(settings.exposure)}
                    resetValue={0}
                    inputStyle={{
                      "--range-track-background": globalExposureTrackBackground,
                    } as CSSProperties}
                    onChange={(value) =>
                      setSettings((current) => ({ ...current, exposure: value }))
                    }
                  />
                  <RangeField
                    label="Chroma scale"
                    min={0}
                    max={200}
                    step={1}
                    value={Math.round(settings.chromaScale * 100)}
                    display={`${Math.round(settings.chromaScale * 100)}%`}
                    resetValue={100}
                    className="main-chroma-field"
                    inputStyle={{
                      "--range-track-background": globalChromaTrackBackground,
                    } as CSSProperties}
                    onChange={(value) =>
                      setSettings((current) => ({ ...current, chromaScale: value / 100 }))
                    }
                  />
                </div>

                {extraHueGroups.length > 0 ? (
                  <div className="extra-hue-group-stack">
                    {extraHueGroups.map((group) => {
                      const scope = frameGroupById.get(group.scopeId);
                      if (!scope) return null;

                      const sample =
                        groupSampleById.get(group.scopeId) ??
                        summarizeOklchSample(
                          groupColorsById.get(group.scopeId) ?? [],
                          scope.hue ?? (group.scopeId === "neutral" ? neutralAnchorHue : masterDisplayHue),
                        );
                      const effectiveGroup = resolveEffectiveExtraHueGroup(group);
                      const isLinkedPreset = group.linkMode !== "manual";
                      const tintLocksChromaticHue = primaryTintEnabled && group.scopeId !== "neutral";
                      const isNeutralScope = group.scopeId === "neutral";
                      const neutralBaseHue = isNeutralScope
                        ? resolveExtraHueGroupDisplayHue(effectiveGroup, neutralAnchorHue)
                        : undefined;
                      const linkedRelationHue = isNeutralScope
                        ? neutralRelationOverrideActive
                          ? undefined
                          : resolveNeutralRelationHue(
                              globalLinkedHueMode,
                              brandReferenceHue,
                              neutralBaseHue ?? neutralAnchorHue,
                              effectiveGroup.chromaScale,
                            )
                        : globalRelationHueByScopeId.get(group.scopeId);
                      const relationLightnessOffset = resolveRelationLightnessOffset(
                        group.scopeId,
                        linkedRelationHue,
                        sample,
                        isNeutralScope,
                      );
                      const relationLocksChromaticHue =
                        !isNeutralScope &&
                        linkedRelationHue !== undefined &&
                        globalLinkedEnabled;
                      const groupBaseHue = isNeutralScope ? neutralAnchorHue : masterDisplayHue;
                      const effectiveHueShift =
                        linkedRelationHue !== undefined &&
                        (isNeutralScope || relationLocksChromaticHue)
                          ? hueShiftBetween(groupBaseHue, linkedRelationHue)
                          : effectiveGroup.hueShift;
                      const effectiveGroupHue = tintLocksChromaticHue
                        ? masterDisplayHue
                        : linkedRelationHue !== undefined
                          ? linkedRelationHue
                        : resolveExtraHueGroupDisplayHue(effectiveGroup, groupBaseHue);
                      const effectiveExposure = isNeutralScope
                        ? effectiveGroup.exposure
                        : settings.exposure + relationLightnessOffset + effectiveGroup.exposure;
                      const effectiveChromaScale = isNeutralScope
                        ? effectiveGroup.chromaScale
                        : settings.chromaScale * effectiveGroup.chromaScale;
                      const currentPreviewColor = previewSampleOklch(sample, {
                        hue: effectiveGroupHue,
                        exposure: effectiveExposure,
                        chromaScale: effectiveChromaScale,
                        contrast: isNeutralScope ? effectiveGroup.contrast : 0,
                        neutralThreshold: effectiveExploreSettings.neutralThreshold,
                        allowNeutralTintFloor: isNeutralScope,
                      });
                      const hueTrackBackground = buildHueTrackBackground(
                        effectiveChromaScale,
                      );
                      const exposureTrackBackground = buildExposureTrackBackground(sample, {
                        hue: effectiveGroupHue,
                        chromaScale: effectiveChromaScale,
                        contrast: isNeutralScope ? effectiveGroup.contrast : 0,
                        neutralThreshold: effectiveExploreSettings.neutralThreshold,
                        allowNeutralTintFloor: isNeutralScope,
                      });
                      const chromaTrackBackground = buildChromaTrackBackground(sample, {
                        hue: effectiveGroupHue,
                        exposure: effectiveExposure,
                        resolveChromaScale: (value) =>
                          isNeutralScope
                            ? value / 100
                            : settings.chromaScale * (value / 100),
                        contrast: isNeutralScope ? effectiveGroup.contrast : 0,
                        neutralThreshold: effectiveExploreSettings.neutralThreshold,
                        allowNeutralTintFloor: isNeutralScope,
                      });
                      const hasAccentSurface = group.scopeId !== "neutral";
                      const groupStyle = {
                        "--group-accent": hasAccentSurface
                          ? previewCssColor(currentPreviewColor)
                          : "transparent",
                      } as CSSProperties;

                      return (
                        <CollapsibleCard
                          key={group.id}
                          className={`hue-group-card${hasAccentSurface ? "" : " is-neutral-card"}${!collapsedGroups[group.id] ? " is-open" : ""}`}
                          style={groupStyle}
                          title={
                            <>
                              {scope.name}{" "}
                              <span className="hue-group-count">{scope.memberKeys.length}</span>
                            </>
                          }
                          collapsed={collapsedGroups[group.id]}
                          onToggle={() => toggleGroupCollapsed(group.id)}
                          chevronLabel={{
                            expand: `Expand ${scope.name}`,
                            collapse: `Collapse ${scope.name}`,
                          }}
                          onMouseEnter={() => setActiveHueNodeId(group.scopeId)}
                          actions={
                            group.scopeId !== "neutral" ? (
                              <button
                                className="btn-ghost icon-btn"
                                title={`Remove ${scope.name}`}
                                aria-label={`Remove ${scope.name}`}
                                onClick={() => handleRemoveExtraHueGroup(group.id)}
                              >
                                <IconMinus />
                              </button>
                            ) : null
                          }
                        >
                          <RangeField
                            label="Hue"
                            min={-180}
                            max={180}
                            step={1}
                            value={effectiveHueShift}
                            display={fmt(effectiveHueShift, "°")}
                            resetValue={0}
                            variant="hue"
                            disabled={tintLocksChromaticHue || relationLocksChromaticHue}
                            softDisabled={
                              !tintLocksChromaticHue &&
                              !relationLocksChromaticHue &&
                              isLinkedPreset
                            }
                            inputStyle={{
                              "--range-track-background": hueTrackBackground,
                            } as CSSProperties}
                            onChange={(value) =>
                              handleExtraHueGroupManualSliderChange(group.id, {
                                hueShift: value,
                              })
                            }
                          />
                          <RangeField
                            label="Exposure"
                            min={-100}
                            max={100}
                            step={1}
                            value={effectiveGroup.exposure}
                            display={fmt(effectiveGroup.exposure)}
                            resetValue={0}
                            softDisabled={isLinkedPreset}
                            inputStyle={{
                              "--range-track-background": exposureTrackBackground,
                            } as CSSProperties}
                            onChange={(value) =>
                              handleExtraHueGroupManualSliderChange(group.id, {
                                exposure: value,
                              })
                            }
                          />
                          {group.scopeId === "neutral" ? (
                            <RangeField
                              label="Contrast"
                              min={-100}
                              max={100}
                              step={1}
                              value={effectiveGroup.contrast}
                              display={fmt(effectiveGroup.contrast)}
                              resetValue={0}
                              softDisabled={isLinkedPreset}
                              onChange={(value) =>
                                handleExtraHueGroupManualSliderChange(group.id, {
                                  contrast: value,
                                })
                              }
                            />
                          ) : null}
                          <RangeField
                            label="Chroma scale"
                            min={0}
                            max={200}
                            step={1}
                            value={Math.round(effectiveGroup.chromaScale * 100)}
                            display={`${Math.round(effectiveGroup.chromaScale * 100)}%`}
                            resetValue={100}
                            softDisabled={isLinkedPreset}
                            inputStyle={{
                              "--range-track-background": chromaTrackBackground,
                            } as CSSProperties}
                            onChange={(value) =>
                              handleExtraHueGroupManualSliderChange(group.id, {
                                chromaScale: value / 100,
                              })
                            }
                          />
                        </CollapsibleCard>
                      );
                    })}
                  </div>
                ) : null}

                <div className="extra-hue-picker">
                  <div className="extra-hue-picker-head">
                    <strong>Separate control</strong>
                  </div>
                  {chromaticGroups.length > 0 ? (
                    <div className="button-row hue-add-row">
                      {chromaticGroups.map((group) => {
                        const isAdded = addedExtraGroupScopeIds.has(group.id);
                        return (
                          <button
                            key={`add-${group.id}`}
                            className={`hue-add-btn${isAdded ? " is-added" : ""}`}
                            disabled={isAdded || primaryTintEnabled}
                            onClick={() => handleAddExtraHueGroup(group.id)}
                          >
                            {isAdded ? (
                              group.name
                            ) : (
                              <>
                                <span className="btn-icon hue-add-icon">
                                  <IconPlus />
                                </span>
                                <span>{group.name}</span>
                              </>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="muted">No chromatic color groups detected on this page yet.</p>
                  )}
                </div>
              </div>
            </Section>

            {themeFlipEnabled && <Section>
              <CollapsibleCard
                className={`hue-group-card theme-settings-card${!themeSettingsCollapsed ? " is-open" : ""}`}
                title="Invert colors"
                collapsed={themeSettingsCollapsed}
                onToggle={() => setThemeSettingsCollapsed((value) => !value)}
                chevronLabel={{
                  expand: "Expand invert colors",
                  collapse: "Collapse invert colors",
                }}
                contentClassName="theme-settings-stack"
              >
                <RangeField
                  label="Background brightness"
                  min={0}
                  max={100}
                  step={1}
                  value={themeSettings.backgroundBrightness}
                  display={`${themeSettings.backgroundBrightness}%`}
                  resetValue={DEFAULT_THEME_FLIP_SETTINGS.backgroundBrightness}
                  onChange={(value) =>
                    setThemeSettings((current) => ({ ...current, backgroundBrightness: value }))
                  }
                />
                <RangeField
                  label="Surface separation"
                  min={0}
                  max={100}
                  step={1}
                  value={themeSettings.surfaceSeparation}
                  display={`${themeSettings.surfaceSeparation}%`}
                  resetValue={DEFAULT_THEME_FLIP_SETTINGS.surfaceSeparation}
                  onChange={(value) =>
                    setThemeSettings((current) => ({ ...current, surfaceSeparation: value }))
                  }
                />
                <RangeField
                  label="Accent saturation"
                  min={0}
                  max={150}
                  step={1}
                  value={themeSettings.accentSaturation}
                  display={`${themeSettings.accentSaturation}%`}
                  resetValue={DEFAULT_THEME_FLIP_SETTINGS.accentSaturation}
                  onChange={(value) =>
                    setThemeSettings((current) => ({ ...current, accentSaturation: value }))
                  }
                />
                <RangeField
                  label="Accent brightness"
                  min={-50}
                  max={50}
                  step={1}
                  value={themeSettings.accentBrightness}
                  display={fmt(themeSettings.accentBrightness)}
                  resetValue={DEFAULT_THEME_FLIP_SETTINGS.accentBrightness}
                  onChange={(value) =>
                    setThemeSettings((current) => ({ ...current, accentBrightness: value }))
                  }
                />
                <RangeField
                  label="Text contrast"
                  min={30}
                  max={95}
                  step={1}
                  value={themeSettings.textContrast}
                  display={`${themeSettings.textContrast}`}
                  resetValue={DEFAULT_THEME_FLIP_SETTINGS.textContrast}
                  onChange={(value) =>
                    setThemeSettings((current) => ({ ...current, textContrast: value }))
                  }
                />
                <RangeField
                  label="Text weight"
                  min={0}
                  max={100}
                  step={1}
                  value={themeSettings.textWeight}
                  display={`${themeSettings.textWeight}%`}
                  resetValue={DEFAULT_THEME_FLIP_SETTINGS.textWeight}
                  onChange={(value) =>
                    setThemeSettings((current) => ({ ...current, textWeight: value }))
                  }
                />
                <div className="theme-settings-options">
                  <ToggleCheck
                    label="Preserve button text"
                    checked={themeSettings.preserveButtonText}
                    onChange={(value) =>
                      setThemeSettings((current) => ({
                        ...current,
                        preserveButtonText: value,
                      }))
                    }
                  />
                </div>
              </CollapsibleCard>
            </Section>}

            <div className="footer">
              <span className="footer-status">{status}</span>
              <button
                className={`btn-ghost icon-btn${themeFlipEnabled ? " is-active" : ""}`}
                onClick={() => setThemeFlipEnabled((current) => !current)}
                title={themeFlipEnabled ? `Back to ${sourceTheme} theme` : `Switch to ${targetTheme} theme`}
                aria-label={themeFlipEnabled ? `Back to ${sourceTheme} theme` : `Switch to ${targetTheme} theme`}
              >
                <IconThemeFlip />
              </button>
              <button
                className="btn-ghost icon-btn"
                onMouseDown={handleCompareStart}
                onMouseUp={handleCompareEnd}
                onMouseLeave={handleCompareEnd}
                title="Hold to compare"
                aria-label="Hold to compare"
              >
                <IconCompareArrows />
              </button>
              <button
                className="btn-ghost icon-btn"
                onClick={handleReset}
                title="Reset"
                aria-label="Reset"
              >
                <IconReset />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderTitle({ children }: { children: ReactNode }) {
  return (
    <div className="hue-group-copy">
      <strong>{children}</strong>
    </div>
  );
}

function CardHeader({
  title,
  actions,
  collapsed,
  onToggle,
  onHeaderClick,
  chevronLabel,
}: {
  title: ReactNode;
  actions?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  onHeaderClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  chevronLabel?: {
    expand: string;
    collapse: string;
  };
}) {
  const headerClassName = [
    "hue-group-header",
    onToggle ? "" : "is-static",
    actions ? "" : "no-actions",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={headerClassName} onClick={onHeaderClick}>
      {onToggle ? (
        <button
          className="group-toggle"
          type="button"
          onClick={onToggle}
          aria-expanded={collapsed === undefined ? undefined : !collapsed}
        >
          <HeaderTitle>{title}</HeaderTitle>
        </button>
      ) : (
        <div className="group-toggle group-toggle-static">
          <HeaderTitle>{title}</HeaderTitle>
        </div>
      )}
      {actions ? <div className="hue-group-actions">{actions}</div> : null}
      {onToggle ? (
        <button
          className="group-chevron-btn icon-btn"
          type="button"
          onClick={onToggle}
          aria-label={
            chevronLabel
              ? collapsed
                ? chevronLabel.expand
                : chevronLabel.collapse
              : undefined
          }
          aria-expanded={collapsed === undefined ? undefined : !collapsed}
        >
          <span className={`group-chevron${collapsed ? " is-collapsed" : ""}`}>
            <IconChevronDown />
          </span>
        </button>
      ) : null}
    </div>
  );
}

function CollapsibleCard({
  className,
  style,
  title,
  actions,
  collapsed,
  onToggle,
  chevronLabel,
  contentClassName,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  className: string;
  style?: CSSProperties;
  title: ReactNode;
  actions?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  chevronLabel: {
    expand: string;
    collapse: string;
  };
  contentClassName?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  children: ReactNode;
}) {
  const handleCardClick = collapsed
    ? (event: React.MouseEvent<HTMLDivElement>) => {
        if (!isButtonTarget(event.target)) {
          onToggle();
        }
      }
    : undefined;
  const handleHeaderClick = !collapsed
    ? (event: React.MouseEvent<HTMLDivElement>) => {
        if (!isButtonTarget(event.target)) {
          onToggle();
        }
      }
    : undefined;

  return (
    <div
      className={className}
      style={style}
      onClick={handleCardClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="collapsible-card-header-shell">
        <CardHeader
          title={title}
          actions={actions}
          collapsed={collapsed}
          onToggle={onToggle}
          onHeaderClick={handleHeaderClick}
          chevronLabel={chevronLabel}
        />
      </div>
      <div className={`collapsible-grid${collapsed ? " is-collapsed" : ""}`} aria-hidden={collapsed}>
        <div className="collapsible-grid-inner">
          <div className={`collapsible-grid-content${contentClassName ? ` ${contentClassName}` : ""}`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="section">
      {label ? <div className="section-label">{label}</div> : null}
      {children}
    </div>
  );
}

function RangeField({
  label,
  min,
  max,
  step,
  value,
  display,
  resetValue,
  variant,
  accessory,
  disabled,
  softDisabled,
  className,
  inputStyle,
  onChange,
}: {
  label: ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  resetValue?: number;
  variant?: "default" | "hue";
  accessory?: ReactNode;
  disabled?: boolean;
  softDisabled?: boolean;
  className?: string;
  inputStyle?: CSSProperties;
  onChange: (v: number) => void;
}) {
  return (
    <div
      className={`range-field${softDisabled ? " is-soft-disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <div className="range-head">
        <div className="range-label">{label}</div>
        <div className="range-meta">
          {accessory}
          <strong>{display}</strong>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        className={variant === "hue" ? "is-hue" : undefined}
        style={inputStyle}
        disabled={disabled}
        onDoubleClick={() => {
          if (resetValue !== undefined && !disabled) {
            onChange(resetValue);
          }
        }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function ToggleCheck({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function SelectField({
  label,
  ariaLabel,
  value,
  options,
  unstyled,
  disabled,
  fill,
  onChange,
}: {
  label?: string;
  ariaLabel?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  unstyled?: boolean;
  disabled?: boolean;
  fill?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={`select-field${label ? "" : " is-compact"}${unstyled ? " is-unstyled" : ""}${fill ? " is-fill" : ""}`}
    >
      {label ? <span>{label}</span> : null}
      {unstyled ? (
        <span className="select-field-inline">
          <select
            aria-label={ariaLabel ?? label}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="select-field-chevron" aria-hidden="true">
            <IconChevronDown />
          </span>
        </span>
      ) : (
        <select
          aria-label={ariaLabel ?? label}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}

function IconReset() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

function IconCompareArrows() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h5v2h2V1h-2v2zm0 15H5l5-6v6zm9-15h-5v2h5v13l-5-6v9h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
    </svg>
  );
}

function IconMinus() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 13H5v-2h14v2z" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6-1.41-1.41z" />
    </svg>
  );
}

function IconEmptyState() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z" />
    </svg>
  );
}

function IconThemeFlip() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18V4c4.41 0 8 3.59 8 8s-3.59 8-8 8z" />
    </svg>
  );
}

function IconLink({ linked }: { linked: boolean }) {
  return (
    <svg className="icon-svg" viewBox="0 -960 960 960" aria-hidden="true">
      {linked ? (
        <path d="M432-288H288q-79.68 0-135.84-56.23Q96-400.45 96-480.23 96-560 152.16-616q56.16-56 135.84-56h144v72H288q-50 0-85 35t-35 85q0 50 35 85t85 35h144v72Zm-96-156v-72h288v72H336Zm192 156v-72h144q50 0 85-35t35-85q0-50-35-85t-85-35H528v-72h144q79.68 0 135.84 56.23 56.16 56.22 56.16 136Q864-400 807.84-344 751.68-288 672-288H528Z" />
      ) : (
        <path d="m754-308-56-55q41.78-11.3 67.89-43.65Q792-439 792-480q0-50-35-85t-85-35H528v-72h144q79.68 0 135.84 56.22 56.16 56.23 56.16 136Q864-425 834.5-379T754-308ZM618-444l-72-72h78v72h-6ZM768-90 90-768l51-51 678 678-51 51ZM432-288H288q-79.68 0-135.84-56.16T96-480q0-63.93 38-113.97Q172-644 242-673l70 73h-23q-51 0-86 35t-35 85q0 50 35 85t85 35h144v72Zm-96-156v-72h56l71 72H336Z" />
      )}
    </svg>
  );
}

function IconTint({ enabled }: { enabled: boolean }) {
  return (
    <svg className="icon-svg" viewBox="0 -960 960 960" aria-hidden="true">
      {enabled ? (
        <path d="M456-96q-29.7 0-50.85-21.15Q384-138.3 384-168v-167H264q-29.7 0-50.85-21.15Q192-377.3 192-407v-265q0-61 42-102.5T336-816h432v409q0 29.7-21.5 50.85Q725-335 696-335H576v167q0 29.7-21.5 50.85Q533-96 504-96h-48ZM264-552h432v-192h-48v144h-72v-144h-48v73h-72v-73H336q-29.7 0-50.85 20.5Q264-703 264-672v120Zm0 145h432v-73H264v73Zm0 0v-73 73Z" />
      ) : (
        <path d="M768-816v409q0 23.24-13 41.12T722-340l-67-67h41v-73H582.23L510-552h186v-192h-48v144h-72v-144h-48v73h-72v-73H318.15L265-797q16-9.5 33.5-14.25T336-816h432Zm0 726L576-282v114q0 29.7-21.5 50.85Q533-96 504-96h-48q-29.7 0-50.85-21.15Q384-138.3 384-168v-167H264q-29.7 0-50.85-21.15Q192-377.3 192-407v-260L90-769l51-51 678 679-51 51ZM264-407h187l-72-73H264v73Zm0-145h43l-43-43v43Zm187 145H264h187Zm204 0h41-41Z" />
      )}
    </svg>
  );
}

export default App;
