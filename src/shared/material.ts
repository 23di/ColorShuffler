import {
  Blend,
  Hct,
  MaterialDynamicColors,
  SchemeExpressive,
  SchemeFidelity,
  SchemeFruitSalad,
  SchemeMonochrome,
  SchemeNeutral,
  SchemeRainbow,
  SchemeContent,
  SchemeTonalSpot,
  SchemeVibrant,
  Score,
  TemperatureCache,
  argbFromRgb,
  blueFromArgb,
  greenFromArgb,
  redFromArgb,
} from "@material/material-color-utilities";
import { clamp01, hueDistance, normalizeHue, rgbToOklch } from "./color";
import type {
  ColorRecordSummary,
  MaterialContrastPresetId,
  MaterialSchemeVariant,
  SerializedColor,
  SourceKind,
} from "./types";

export interface MaterialRoleColor {
  name: string;
  argb: number;
  rgb: SerializedColor;
  hct: Hct;
}

export interface MaterialVariantOption {
  value: MaterialSchemeVariant;
  label: string;
  description: string;
}

export interface MaterialContrastPreset {
  id: Exclude<MaterialContrastPresetId, "custom">;
  label: string;
  level: number;
  description: string;
}

export const MATERIAL_SCHEME_VARIANTS: MaterialVariantOption[] = [
  {
    value: "content",
    label: "Content",
    description: "Keeps stronger source fidelity and content-like accents.",
  },
  {
    value: "tonal-spot",
    label: "Tonal Spot",
    description: "Default Material 3 feel with softer accent separation.",
  },
  {
    value: "fidelity",
    label: "Fidelity",
    description: "Preserves source hue/chroma as closely as the scheme allows.",
  },
  {
    value: "vibrant",
    label: "Vibrant",
    description: "Pushes accents further for bolder, higher-chroma palettes.",
  },
  {
    value: "expressive",
    label: "Expressive",
    description: "Rotates accents into a more stylized, editorial palette.",
  },
  {
    value: "neutral",
    label: "Neutral",
    description: "Reduces chroma for quiet, muted UI surfaces and accents.",
  },
  {
    value: "monochrome",
    label: "Monochrome",
    description: "Builds a near-monochrome scheme around tone alone.",
  },
  {
    value: "rainbow",
    label: "Rainbow",
    description: "Uses wider hue separation across accent families.",
  },
  {
    value: "fruit-salad",
    label: "Fruit Salad",
    description: "Skews accents toward playful split-hue relationships.",
  },
];

export const MATERIAL_CONTRAST_PRESETS: MaterialContrastPreset[] = [
  {
    id: "low",
    label: "Low",
    level: -1,
    description: "Minimum contrast curve from Material dynamic color.",
  },
  {
    id: "standard",
    label: "Standard",
    level: 0,
    description: "Default spec contrast for Material dynamic schemes.",
  },
  {
    id: "medium",
    label: "Medium",
    level: 0.5,
    description: "Medium contrast curve from Material dynamic color.",
  },
  {
    id: "high",
    label: "High",
    level: 1,
    description: "Maximum contrast curve from Material dynamic color.",
  },
];

const ROLE_NAMES = [
  "background",
  "onBackground",
  "surface",
  "surfaceDim",
  "surfaceBright",
  "surfaceContainerLowest",
  "surfaceContainerLow",
  "surfaceContainer",
  "surfaceContainerHigh",
  "surfaceContainerHighest",
  "onSurface",
  "surfaceVariant",
  "onSurfaceVariant",
  "outline",
  "outlineVariant",
  "shadow",
  "scrim",
  "surfaceTint",
  "inverseSurface",
  "inverseOnSurface",
  "primary",
  "primaryDim",
  "onPrimary",
  "primaryContainer",
  "onPrimaryContainer",
  "primaryFixed",
  "primaryFixedDim",
  "onPrimaryFixed",
  "onPrimaryFixedVariant",
  "inversePrimary",
  "secondary",
  "secondaryDim",
  "onSecondary",
  "secondaryContainer",
  "onSecondaryContainer",
  "secondaryFixed",
  "secondaryFixedDim",
  "onSecondaryFixed",
  "onSecondaryFixedVariant",
  "tertiary",
  "tertiaryDim",
  "onTertiary",
  "tertiaryContainer",
  "onTertiaryContainer",
  "tertiaryFixed",
  "tertiaryFixedDim",
  "onTertiaryFixed",
  "onTertiaryFixedVariant",
  "error",
  "onError",
  "errorContainer",
  "onErrorContainer",
] as const;

export function serializedToArgb(color: SerializedColor): number {
  return argbFromRgb(
    Math.round(clamp01(color.r) * 255),
    Math.round(clamp01(color.g) * 255),
    Math.round(clamp01(color.b) * 255),
  );
}

export function argbToSerialized(argb: number, alpha = 1): SerializedColor {
  return {
    r: redFromArgb(argb) / 255,
    g: greenFromArgb(argb) / 255,
    b: blueFromArgb(argb) / 255,
    a: clamp01(alpha),
  };
}

export function hctFromSerialized(color: SerializedColor): Hct {
  return Hct.fromInt(serializedToArgb(color));
}

export function pickMaterialSeed(colors: ColorRecordSummary[]): number {
  const population = new Map<number, number>();
  for (const color of colors) {
    population.set(serializedToArgb(color.rgb), Math.max(1, color.usageCount));
  }
  return Score.score(population, { desired: 4 })[0] ?? serializedToArgb(colors[0]?.rgb ?? {
    r: 0.2588,
    g: 0.5216,
    b: 0.9569,
    a: 1,
  });
}

export function buildMaterialScheme(
  seedArgb: number,
  isDark: boolean,
  contrastLevel = 0,
  variant: MaterialSchemeVariant = "content",
) {
  const source = Hct.fromInt(seedArgb);
  switch (variant) {
    case "tonal-spot":
      return new SchemeTonalSpot(source, isDark, contrastLevel);
    case "fidelity":
      return new SchemeFidelity(source, isDark, contrastLevel);
    case "vibrant":
      return new SchemeVibrant(source, isDark, contrastLevel);
    case "expressive":
      return new SchemeExpressive(source, isDark, contrastLevel);
    case "neutral":
      return new SchemeNeutral(source, isDark, contrastLevel);
    case "monochrome":
      return new SchemeMonochrome(source, isDark, contrastLevel);
    case "rainbow":
      return new SchemeRainbow(source, isDark, contrastLevel);
    case "fruit-salad":
      return new SchemeFruitSalad(source, isDark, contrastLevel);
    case "content":
    default:
      return new SchemeContent(source, isDark, contrastLevel);
  }
}

export function resolveMaterialContrastPreset(level: number): MaterialContrastPresetId {
  const matched = MATERIAL_CONTRAST_PRESETS.find(
    (preset) => Math.abs(level - preset.level) < 0.001,
  );
  return matched?.id ?? "custom";
}

export function getMaterialSchemeRoles(
  scheme: ReturnType<typeof buildMaterialScheme>,
): MaterialRoleColor[] {
  const colors = new MaterialDynamicColors();
  return ROLE_NAMES.map((name) => {
    const dynamic = (colors as unknown as Record<string, () => { getArgb: (scheme: unknown) => number }>)[
      name
    ]();
    const argb = dynamic.getArgb(scheme);
    const rgb = argbToSerialized(argb);
    return {
      name,
      argb,
      rgb,
      hct: Hct.fromInt(argb),
    } satisfies MaterialRoleColor;
  });
}

function sourceKindsSuggestText(sourceKinds: readonly SourceKind[]): boolean {
  return sourceKinds.some((kind) => kind === "text" || kind === "gradient-text");
}

function sourceKindsSuggestEffect(sourceKinds: readonly SourceKind[]): boolean {
  return sourceKinds.includes("effect");
}

function allowedRoleName(name: string, sourceKinds: readonly SourceKind[]): boolean {
  if (sourceKindsSuggestText(sourceKinds)) {
    return name.startsWith("on") || name === "inverseOnSurface";
  }
  if (sourceKindsSuggestEffect(sourceKinds)) {
    return name === "outline" || name === "outlineVariant" || name === "shadow";
  }
  return !name.startsWith("on");
}

export function pairedTextRoleForBackground(roleName: string): string {
  if (roleName === "background") return "onBackground";
  if (roleName.startsWith("surface") || roleName === "inverseSurface") {
    return roleName === "surfaceVariant" ? "onSurfaceVariant" : "onSurface";
  }
  if (roleName === "primary" || roleName === "primaryDim") {
    return "onPrimary";
  }
  if (roleName === "primaryContainer") {
    return "onPrimaryContainer";
  }
  if (roleName === "primaryFixed") {
    return "onPrimaryFixed";
  }
  if (roleName === "primaryFixedDim") {
    return "onPrimaryFixedVariant";
  }
  if (roleName === "secondary" || roleName === "secondaryDim") {
    return "onSecondary";
  }
  if (roleName === "secondaryContainer") {
    return "onSecondaryContainer";
  }
  if (roleName === "secondaryFixed") {
    return "onSecondaryFixed";
  }
  if (roleName === "secondaryFixedDim") {
    return "onSecondaryFixedVariant";
  }
  if (roleName === "tertiary" || roleName === "tertiaryDim") {
    return "onTertiary";
  }
  if (roleName === "tertiaryContainer") {
    return "onTertiaryContainer";
  }
  if (roleName === "tertiaryFixed") {
    return "onTertiaryFixed";
  }
  if (roleName === "tertiaryFixedDim") {
    return "onTertiaryFixedVariant";
  }
  if (roleName.startsWith("error")) {
    return roleName === "error" ? "onError" : "onErrorContainer";
  }
  if (roleName.startsWith("outline")) {
    return "onSurfaceVariant";
  }
  return "onSurface";
}

function materialDistance(source: Hct, target: Hct): number {
  const toneGap = Math.abs(source.tone - target.tone) / 18;
  const chromaGap = Math.abs(source.chroma - target.chroma) / 24;
  const hueGap = hueDistance(source.hue, target.hue) / 45;
  return toneGap + chromaGap + hueGap;
}

export function assignMaterialSemanticRole(
  color: Pick<ColorRecordSummary, "rgb" | "sourceKinds">,
  roles: MaterialRoleColor[],
): MaterialRoleColor {
  const source = hctFromSerialized(color.rgb);
  const filtered = roles.filter((role) => allowedRoleName(role.name, color.sourceKinds));
  const candidates = filtered.length > 0 ? filtered : roles;
  return candidates.reduce(
    (best, candidate) =>
      materialDistance(source, candidate.hct) < materialDistance(source, best.hct)
        ? candidate
        : best,
    candidates[0] ?? roles[0],
  );
}

export function getMaterialRoleByName(
  roles: MaterialRoleColor[],
  roleName: string,
): MaterialRoleColor | undefined {
  return roles.find((role) => role.name === roleName);
}

export function buildMaterialSemanticSeeds(seedArgb: number) {
  const hct = Hct.fromInt(seedArgb);
  const temperature = new TemperatureCache(hct);
  const analogous = temperature.analogous(5, 12);
  return {
    primary: hct,
    secondary: analogous[1] ?? Hct.from(hct.hue, Math.max(16, hct.chroma * 0.5), hct.tone),
    tertiary:
      temperature.complement ??
      analogous[analogous.length - 1] ??
      Hct.from(normalizeHue(hct.hue + 60), Math.max(24, hct.chroma * 0.7), hct.tone),
  };
}

export function harmonizeArgb(designArgb: number, sourceArgb: number, amount: number): number {
  const blended = Blend.hctHue(designArgb, sourceArgb, clamp01(amount));
  return amount >= 0.85 ? Blend.harmonize(blended, sourceArgb) : blended;
}

export function sourceTone(color: SerializedColor): number {
  return rgbToOklch(color).l * 100;
}
