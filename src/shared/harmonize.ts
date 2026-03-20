import { Hct, TonalPalette } from "@material/material-color-utilities";
import { pickApcaReferences } from "./apca";
import {
  buildColorRoleIndex,
  classifyColorRole,
  familyFromHue,
  hueDistance,
  isNearNeutralChroma,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
  weightedAverageHue,
} from "./color";
import {
  buildMaterialScheme,
  harmonizeArgb,
  pickMaterialSeed,
  serializedToArgb,
} from "./material";
import type {
  ColorMappingEntry,
  ColorRecordSummary,
  FamilySummary,
  HarmonizeResult,
  HarmonizeSettings,
} from "./types";

interface MaterialPaletteFamily {
  id: string;
  name: string;
  type: FamilySummary["type"];
  semanticRole?: string;
  hue: number | null;
  chroma: number;
  lightness: number;
  palette: TonalPalette;
  seedArgb: number;
}

interface ClusterFamily extends MaterialPaletteFamily {
  usageCount: number;
  memberKeys: string[];
  samples: ColorRecordSummary[];
}

// Matches the palette step convention: 900 = lightest (tone 99), 0 = darkest (tone 20).
const STEP_TO_TONE: Record<number, number> = {
  900: 99,
  800: 95,
  700: 90,
  600: 80,
  500: 70,
  400: 60,
  300: 50,
  200: 40,
  100: 30,
  0:   20,
};

export const DEFAULT_HARMONIZE_SETTINGS: HarmonizeSettings = {
  strength: 60,
  familyTolerance: 52,
  mergeNearDuplicates: true,
  pullOutliers: true,
  protectNeutrals: true,
  preserveContrast: true,
  neutralThreshold: 0.03,
  schemeVariant: "content",
  contrastLevel: 0,
  harmonyMode: "normalize",
  harmonyStrategy: "smart",
  apca: {
    enabled: false,
    targetLc: 60,
    influence: 60,
  },
};

function toneToStep(tone: number): number {
  return Object.entries(STEP_TO_TONE).reduce(
    (best, [step, candidateTone]) =>
      Math.abs(candidateTone - tone) < Math.abs(best.tone - tone)
        ? { step: Number(step), tone: candidateTone }
        : best,
    { step: 500, tone: STEP_TO_TONE[500] },
  ).step;
}

function buildMaterialFamilies(
  seedArgb: number,
  settings: HarmonizeSettings,
): MaterialPaletteFamily[] {
  const scheme = buildMaterialScheme(
    seedArgb,
    false,
    settings.contrastLevel,
    settings.schemeVariant,
  );
  const primary = Hct.fromInt(scheme.primaryPaletteKeyColor);
  const secondary = Hct.fromInt(scheme.secondaryPaletteKeyColor);
  const tertiary = Hct.fromInt(scheme.tertiaryPaletteKeyColor);
  const neutral = Hct.fromInt(scheme.neutralPaletteKeyColor);
  const neutralVariant = Hct.fromInt(scheme.neutralVariantPaletteKeyColor);

  return [
    {
      id: "material-primary",
      name: "Primary",
      type: "chromatic",
      semanticRole: "primary",
      hue: primary.hue,
      chroma: scheme.primaryPalette.chroma / 100,
      lightness: primary.tone / 100,
      palette: scheme.primaryPalette,
      seedArgb: scheme.primaryPaletteKeyColor,
    },
    {
      id: "material-secondary",
      name: "Secondary",
      type: "chromatic",
      semanticRole: "secondary",
      hue: secondary.hue,
      chroma: scheme.secondaryPalette.chroma / 100,
      lightness: secondary.tone / 100,
      palette: scheme.secondaryPalette,
      seedArgb: scheme.secondaryPaletteKeyColor,
    },
    {
      id: "material-tertiary",
      name: "Tertiary",
      type: "chromatic",
      semanticRole: "tertiary",
      hue: tertiary.hue,
      chroma: scheme.tertiaryPalette.chroma / 100,
      lightness: tertiary.tone / 100,
      palette: scheme.tertiaryPalette,
      seedArgb: scheme.tertiaryPaletteKeyColor,
    },
    {
      id: "material-surface",
      name: "Surface",
      type: "neutral",
      semanticRole: "surface",
      hue: neutral.hue,
      chroma: scheme.neutralPalette.chroma / 100,
      lightness: neutral.tone / 100,
      palette: scheme.neutralPalette,
      seedArgb: scheme.neutralPaletteKeyColor,
    },
    {
      id: "material-surface-variant",
      name: "Surface Variant",
      type: "neutral",
      semanticRole: "surface-variant",
      hue: neutralVariant.hue,
      chroma: scheme.neutralVariantPalette.chroma / 100,
      lightness: neutralVariant.tone / 100,
      palette: scheme.neutralVariantPalette,
      seedArgb: scheme.neutralVariantPaletteKeyColor,
    },
  ];
}

function summarizeCluster(
  samples: ColorRecordSummary[],
  type: FamilySummary["type"],
): Omit<ClusterFamily, "id" | "name" | "semanticRole" | "palette" | "seedArgb"> {
  const usageCount = samples.reduce((sum, color) => sum + color.usageCount, 0);
  const hueSamples = samples
    .filter((color) => color.oklch.c > 0.001)
    .map((color) => ({
      hue: color.oklch.h,
      weight: Math.max(1, color.usageCount) * Math.max(color.oklch.c, 0.01),
    }));

  return {
    type,
    hue: type === "neutral" ? null : weightedAverageHue(hueSamples),
    chroma:
      samples.reduce((sum, color) => sum + color.oklch.c * color.usageCount, 0) /
      Math.max(1, usageCount),
    lightness:
      samples.reduce((sum, color) => sum + color.oklch.l * color.usageCount, 0) /
      Math.max(1, usageCount),
    usageCount,
    memberKeys: samples.map((color) => color.key),
    samples,
  };
}


function chooseMaterialFamilyForCluster(
  cluster: Omit<ClusterFamily, "id" | "name" | "semanticRole" | "palette" | "seedArgb">,
  materialFamilies: MaterialPaletteFamily[],
): MaterialPaletteFamily {
  if (cluster.type === "neutral") {
    const variantPreference = cluster.samples.some((sample) =>
      sample.sourceKinds.some((kind) => kind === "stroke" || kind === "gradient-stroke" || kind === "effect"),
    );
    return materialFamilies.find((family) =>
      family.semanticRole === (variantPreference ? "surface-variant" : "surface"),
    ) ?? materialFamilies[0]!;
  }

  const chromaticFamilies = materialFamilies.filter((family) => family.type === "chromatic");
  return chromaticFamilies.reduce((best, candidate) => {
    const candidateScore =
      hueDistance(cluster.hue ?? candidate.hue ?? 0, candidate.hue ?? 0) / 36 +
      Math.abs(cluster.chroma - candidate.chroma) / 0.08 +
      Math.abs(cluster.lightness - candidate.lightness) / 0.16;
    const bestScore =
      hueDistance(cluster.hue ?? best.hue ?? 0, best.hue ?? 0) / 36 +
      Math.abs(cluster.chroma - best.chroma) / 0.08 +
      Math.abs(cluster.lightness - best.lightness) / 0.16;
    return candidateScore < bestScore ? candidate : best;
  }, chromaticFamilies[0] ?? materialFamilies[0]!);
}

function buildClusterFamilies(
  colors: ColorRecordSummary[],
  materialFamilies: MaterialPaletteFamily[],
  settings: HarmonizeSettings,
): ClusterFamily[] {
  // Hue-first grouping: every color goes into its nearest hue-family bucket.
  //
  // Neutral separation uses isNearNeutralChroma (which applies normalizeNeutralThreshold,
  // giving ~2× the raw threshold). This keeps slightly-tinted grays (e.g. rgb(149,162,166)
  // with HCT chroma ~5%) in the "Neutral" column where the user expects them, while
  // clearly chromatic colors (e.g. light blues with HCT chroma ~10%+) go to their hue
  // family bucket.
  //
  // For the hue lookup we pass chroma=1.0 to familyFromHue so that lightly-saturated
  // chromatic colors are NOT misclassified as neutral by the built-in guard.
  const buckets = new Map<string, ColorRecordSummary[]>();

  for (const color of colors) {
    const bucketId = isNearNeutralChroma(color.oklch.c, settings.neutralThreshold)
      ? "neutral"
      : familyFromHue(color.oklch.h, 1.0).id;

    const bucket = buckets.get(bucketId);
    if (bucket) {
      bucket.push(color);
    } else {
      buckets.set(bucketId, [color]);
    }
  }

  const clusterFamilies: ClusterFamily[] = [];

  for (const [bucketId, samples] of buckets) {
    const type: FamilySummary["type"] = bucketId === "neutral" ? "neutral" : "chromatic";
    const summary = summarizeCluster(samples, type);
    const materialFamily = chooseMaterialFamilyForCluster(summary, materialFamilies);
    const identity =
      bucketId === "neutral"
        ? { id: "neutral", name: "Neutral" }
        : familyFromHue(summary.hue ?? 0, 1.0);

    clusterFamilies.push({
      ...summary,
      id: `${bucketId}-1`,
      name: identity.name,
      semanticRole: materialFamily.semanticRole,
      palette: materialFamily.palette,
      seedArgb: materialFamily.seedArgb,
    });
  }

  // familyTolerance controls how aggressively nearby hue families are merged.
  // At tolerance=0: all fine-grained hue families stay separate (up to 13 columns).
  // At tolerance=100: merge radius reaches ~35°.
  // At tolerance=200: merge radius reaches ~70°, allowing very broad family buckets.
  const mergeRadius = Math.max(0, Math.min(2, settings.familyTolerance / 100)) * 35;

  if (mergeRadius > 0) {
    let anyMerged = true;
    while (anyMerged) {
      anyMerged = false;
      outer: for (let i = 0; i < clusterFamilies.length; i++) {
        for (let j = i + 1; j < clusterFamilies.length; j++) {
          const a = clusterFamilies[i]!;
          const b = clusterFamilies[j]!;
          if (a.type !== "chromatic" || b.type !== "chromatic") continue;
          if (hueDistance(a.hue ?? 0, b.hue ?? 0) > mergeRadius) continue;

          // Merge b into a: combine samples, recompute summary and material family.
          const combined = [...a.samples, ...b.samples];
          const summary = summarizeCluster(combined, "chromatic");
          const materialFamily = chooseMaterialFamilyForCluster(summary, materialFamilies);
          const identity = familyFromHue(summary.hue ?? 0, 1.0);

          clusterFamilies[i] = {
            ...summary,
            id: a.id,
            name: identity.name,
            semanticRole: materialFamily.semanticRole,
            palette: materialFamily.palette,
            seedArgb: materialFamily.seedArgb,
          };
          clusterFamilies.splice(j, 1);
          anyMerged = true;
          break outer;
        }
      }
    }
  }

  return clusterFamilies.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "neutral" ? -1 : 1;
    }
    if (right.usageCount !== left.usageCount) {
      return right.usageCount - left.usageCount;
    }
    return (left.hue ?? 0) - (right.hue ?? 0);
  });
}

function buildTargetColor(
  color: ColorRecordSummary,
  family: ClusterFamily,
  settings: HarmonizeSettings,
): ColorMappingEntry {
  const sourceArgb = serializedToArgb(color.rgb);
  const sourceTone = color.oklch.l * 100;
  const paletteArgb = family.palette.tone(sourceTone);
  const strength = Math.max(0, Math.min(1, settings.strength / 100));
  const harmonizedArgb =
    family.type === "neutral"
      ? paletteArgb
      : harmonizeArgb(sourceArgb, family.seedArgb, strength);
  const targetArgb =
    family.type === "neutral"
      ? paletteArgb
      : strength < 0.25
        ? harmonizedArgb
        : harmonizeArgb(harmonizedArgb, paletteArgb, 0.35 + strength * 0.3);
  const targetRgb = (() => {
    const base = rgbToOklch(color.rgb);
    const targetHct = Hct.fromInt(targetArgb);
    return oklchToRgb(
      {
        l: targetHct.tone / 100,
        c: targetHct.chroma / 100,
        h: targetHct.hue,
        alpha: base.alpha,
      },
      { clampToGamut: true },
    );
  })();

  return {
    key: color.key,
    source: color.rgb,
    sourceHex: color.hex,
    target: targetRgb,
    targetHex: rgbToHex(targetRgb),
    targetOklch: rgbToOklch(targetRgb),
    role: color.role,
    familyId: family.id,
    familyName: family.name,
    matrixStep: toneToStep(sourceTone),
    semanticRole: family.semanticRole,
    reason:
      family.type === "neutral"
        ? `MCU ${family.semanticRole ?? "surface"} tonal palette`
        : `MCU harmony via ${family.semanticRole ?? "accent"} · ${family.name}`,
  };
}

export function harmonizeColors(
  colors: ColorRecordSummary[],
  settings: HarmonizeSettings = DEFAULT_HARMONIZE_SETTINGS,
): HarmonizeResult {
  if (colors.length === 0) {
    return {
      entries: [],
      mapping: {},
      families: [],
      uniqueColorCount: 0,
      reducedColorCount: 0,
      apcaReferences: [],
    };
  }

  const seedArgb = settings.seedArgb ?? pickMaterialSeed(colors);
  const materialFamilies = buildMaterialFamilies(seedArgb, settings);
  const families = buildClusterFamilies(colors, materialFamilies, settings);
  const familyByKey = new Map(
    families.flatMap((family) => family.memberKeys.map((key) => [key, family] as const)),
  );
  const roleByKey = buildColorRoleIndex(colors, settings.neutralThreshold);

  const entries = colors.map((color) => {
    const family = familyByKey.get(color.key) ?? families[0]!;
    return buildTargetColor(
      {
        ...color,
        role: roleByKey.get(color.key) ?? classifyColorRole(color, colors, settings.neutralThreshold),
      },
      family,
      settings,
    );
  });

  const mapping = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
  const familySummaries = families.map<FamilySummary>((family) => ({
    id: family.id,
    name: family.name,
    type: family.type,
    semanticRole: family.semanticRole,
    hue: family.hue,
    chroma: family.chroma,
    lightness: family.lightness,
    usageCount: family.usageCount,
    memberKeys: family.memberKeys,
  }));

  return {
    entries,
    mapping,
    families: familySummaries,
    uniqueColorCount: colors.length,
    reducedColorCount: familySummaries.length,
    apcaReferences: pickApcaReferences(colors),
  };
}
