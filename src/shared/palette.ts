import { TonalPalette } from "@material/material-color-utilities";
import {
  clamp01,
  familyFromHue,
  hctToCss,
  lerp,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
} from "./color";
import { harmonizeColors, DEFAULT_HARMONIZE_SETTINGS } from "./harmonize";
import {
  type ColorRecordSummary,
  type FamilySummary,
  type HarmonizeResult,
  type MatrixCell,
  type OklchColor,
  type PaletteAssignment,
  type PaletteFamily,
  type PaletteMatrix,
  type PaletteResult,
  type PaletteToken,
} from "./types";

export const DEFAULT_SCALE_STEPS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900];

const STEP_TO_TONE: Record<number, number> = {
  0: 99,
  50: 98,
  100: 95,
  200: 90,
  300: 80,
  400: 70,
  500: 60,
  600: 50,
  700: 40,
  800: 30,
  900: 20,
};

function buildLightnessScale(steps: number[]): Map<number, number> {
  const result = new Map<number, number>();
  steps.forEach((step, index) => {
    const tone =
      STEP_TO_TONE[step] ??
      lerp(99, 20, steps.length === 1 ? 0 : index / (steps.length - 1));
    result.set(step, tone / 100);
  });

  return result;
}


function nearestTokenByLightness(
  source: OklchColor,
  tokens: PaletteToken[],
): PaletteToken {
  return tokens.reduce((best, token) => {
    const distance = Math.abs(source.l - token.oklch.l);
    const bestDistance = Math.abs(source.l - best.oklch.l);
    return distance < bestDistance ? token : best;
  });
}

export function generatePalette(
  colors: ColorRecordSummary[],
  harmonized?: HarmonizeResult,
  steps = DEFAULT_SCALE_STEPS,
): PaletteResult {
  const result =
    harmonized ?? harmonizeColors(colors, DEFAULT_HARMONIZE_SETTINGS);
  const lightnessScale = buildLightnessScale(steps);
  const tokenFamilies: PaletteFamily[] = [];

  for (const family of result.families) {
    if (family.memberKeys.length === 0) continue;

    const familyIdentity =
      family.semanticRole
        ? { id: family.semanticRole, name: family.name }
        : family.type === "neutral"
          ? { id: "neutral", name: "Neutral" }
          : familyFromHue(family.hue, family.chroma);
    const palette = TonalPalette.fromHueAndChroma(
      family.hue ?? 0,
      Math.max(0.8, family.chroma * 100),
    );
    const tokens = steps.map((step) => {
      const targetTone = (lightnessScale.get(step) ?? 0.5) * 100;
      const targetHct = palette.getHct(targetTone);
      const targetOklch = {
        l: targetHct.tone / 100,
        c: targetHct.chroma / 100,
        h: targetHct.hue,
        alpha: 1,
      } satisfies OklchColor;
      const rgb = oklchToRgb(targetOklch, { clampToGamut: true });
      return {
        familyId: familyIdentity.id,
        familyName: familyIdentity.name,
        step,
        name: family.semanticRole
          ? `md.sys.color.${familyIdentity.id}.${step}`
          : `color.${familyIdentity.id}.${step}`,
        rgb,
        hex: rgbToHex(rgb),
        oklch: targetOklch,
        sourceKeys: family.memberKeys,
        semanticRole: family.semanticRole,
      } satisfies PaletteToken;
    });

    tokenFamilies.push({
      id: familyIdentity.id,
      name: familyIdentity.name,
      type: family.type,
      baseHue: family.hue,
      baseChroma: family.chroma,
      tokens,
      sourceKeys: family.memberKeys,
    });
  }

  const tokens = tokenFamilies.flatMap((family) => family.tokens);
  const familyById = new Map(tokenFamilies.map((family) => [family.id, family]));

  const assignments = result.entries.map<PaletteAssignment>((entry) => {
    const family = familyById.get(entry.familyId ?? "") ?? tokenFamilies[0];
    const nearest = nearestTokenByLightness(entry.targetOklch, family.tokens);
    return {
      sourceKey: entry.key,
      sourceHex: entry.sourceHex,
      familyId: family.id,
      familyName: family.name,
      tokenName: nearest.name,
      tokenHex: nearest.hex,
      semanticRole: nearest.semanticRole ?? entry.semanticRole,
    };
  });

  const tokenJson = Object.fromEntries(
    tokens.map((token) => [
      token.name,
      {
        value: token.hex,
        type: "color" as const,
        hct: hctToCss(token.oklch),
        role: token.semanticRole,
      },
    ]),
  );

  return {
    families: tokenFamilies,
    tokens,
    assignments,
    tokenJson,
  };
}

// Steps run from 0 (darkest, top row) to 900 (lightest, bottom row).
// Higher step number = lighter shade (e.g. white-900 ≈ white, blue-0 ≈ near-black).
export const PALETTE_STEPS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];

const STEP_LIGHTNESS: Record<number, number> = {
  900: 0.98,
  800: 0.93,
  700: 0.87,
  600: 0.78,
  500: 0.68,
  400: 0.56,
  300: 0.44,
  200: 0.34,
  100: 0.25,
  0:   0.18,
};

function stepToLightness(step: number): number {
  if (STEP_LIGHTNESS[step] !== undefined) {
    return STEP_LIGHTNESS[step]!;
  }
  // step / 900 grows from 0 (darkest) to 1 (lightest)
  const normalized = clamp01(step / 900);
  return lerp(STEP_LIGHTNESS[0]!, STEP_LIGHTNESS[900]!, normalized);
}

function lightnessToStep(l: number, steps = PALETTE_STEPS): number {
  let nearest = steps[Math.floor(steps.length / 2)] ?? 500;
  let minDist = Infinity;
  for (const step of steps) {
    const dist = Math.abs(l - stepToLightness(step));
    if (dist < minDist) {
      minDist = dist;
      nearest = step;
    }
  }
  return nearest;
}

export function buildPaletteSteps(count: number): number[] {
  if (count <= 0) return [...PALETTE_STEPS];
  if (count === 1) return [500];

  // Ascending: first step = 0 (darkest, top row), last = 900 (lightest, bottom row).
  return Array.from({ length: count }, (_, index) =>
    Math.round((index * 900) / (count - 1)),
  );
}

export function generateMatrixCell(family: FamilySummary, step: number): MatrixCell {
  const targetTone = stepToLightness(step) * 100;
  const targetHct = TonalPalette.fromHueAndChroma(
    family.hue ?? 0,
    Math.max(0.8, family.chroma * 100),
  ).getHct(targetTone);
  const targetOklch: OklchColor = {
    l: targetHct.tone / 100,
    c: targetHct.chroma / 100,
    h: targetHct.hue,
    alpha: 1,
  };
  const rgb = oklchToRgb(targetOklch, { clampToGamut: true });
  return {
    familyId: family.id,
    familyName: family.name,
    step,
    color: { rgb, hex: rgbToHex(rgb), oklch: targetOklch },
    isGenerated: true,
    isLocked: false,
    useInExport: true,
    sourceKeys: [],
    semanticRole: family.semanticRole,
  };
}

export function buildPaletteMatrix(
  colors: ColorRecordSummary[],
  harmonized: HarmonizeResult,
  options?: {
    collapseByLightness?: boolean;
    lightnessTolerance?: number;
  },
): {
  familyIds: string[];
  familyNames: Record<string, string>;
  families: FamilySummary[];
  matrix: PaletteMatrix;
  steps: number[];
} {
  type FamilyEntry = {
    entry: HarmonizeResult["entries"][number];
    color: ColorRecordSummary;
    sourceKeys: string[];
  };

  const colorByKey = new Map(colors.map((color) => [color.key, color]));
  const matrix: PaletteMatrix = {};
  const familyEntries = new Map<string, FamilyEntry[]>();

  for (const entry of harmonized.entries) {
    const color = colorByKey.get(entry.key);
    if (!color) continue;
    const familyId = entry.familyId ?? "unknown";
    const existing = familyEntries.get(familyId);
    const item = { entry, color, sourceKeys: [color.key] } satisfies FamilyEntry;
    if (existing) {
      existing.push(item);
    } else {
      familyEntries.set(familyId, [item]);
    }
  }

  const normalizeLightnessTolerance = (value: number | undefined): number =>
    Math.max(0, Math.min(1, (value ?? 50) / 100));

  const collapseLightnessEntries = (items: FamilyEntry[]): FamilyEntry[] => {
    if (!options?.collapseByLightness || items.length <= 1) {
      return items;
    }

    const detail = normalizeLightnessTolerance(options.lightnessTolerance);
    const mergeThreshold = lerp(0.22, 0.012, detail);
    const clusters: FamilyEntry[][] = [];

    for (const item of items) {
      const currentCluster = clusters[clusters.length - 1];
      if (!currentCluster) {
        clusters.push([item]);
        continue;
      }

      const currentUsage = currentCluster.reduce(
        (sum, candidate) => sum + candidate.color.usageCount,
        0,
      );
      const currentAverageLightness =
        currentCluster.reduce(
          (sum, candidate) => sum + candidate.color.oklch.l * candidate.color.usageCount,
          0,
        ) / Math.max(1, currentUsage);

      if (Math.abs(item.color.oklch.l - currentAverageLightness) <= mergeThreshold) {
        currentCluster.push(item);
      } else {
        clusters.push([item]);
      }
    }

    return clusters.map((cluster) => {
      const totalUsage = cluster.reduce((sum, candidate) => sum + candidate.color.usageCount, 0);
      const targetLightness =
        cluster.reduce(
          (sum, candidate) => sum + candidate.color.oklch.l * candidate.color.usageCount,
          0,
        ) / Math.max(1, totalUsage);

      const representative = cluster.reduce((best, candidate) => {
        const candidateDistance = Math.abs(candidate.color.oklch.l - targetLightness);
        const bestDistance = Math.abs(best.color.oklch.l - targetLightness);
        if (candidateDistance === bestDistance) {
          return candidate.color.usageCount > best.color.usageCount ? candidate : best;
        }
        return candidateDistance < bestDistance ? candidate : best;
      });

      return {
        ...representative,
        sourceKeys: [...new Set(cluster.flatMap((candidate) => candidate.sourceKeys))],
      };
    });
  };

  const familyIds: string[] = [];
  const familyNames: Record<string, string> = {};
  const collapsedFamilyEntries = new Map(
    [...familyEntries.entries()].map(([familyId, items]) => [
      familyId,
      collapseLightnessEntries(
        [...items].sort((left, right) => left.color.oklch.l - right.color.oklch.l),
      ),
    ]),
  );

  // Each color is placed at the PALETTE_STEPS row nearest to its actual lightness.
  // This means colours at similar brightness land in the same row across all families,
  // and rows with no colour for a given family show an empty "+" slot.
  // buildPaletteSteps is still used to expose which rows are actually occupied.
  const usedSteps = new Set<number>();

  for (const [familyId, items] of collapsedFamilyEntries.entries()) {
    for (const { entry, color, sourceKeys } of items) {
      const step = lightnessToStep(color.oklch.l);
      usedSteps.add(step);
      const cellKey = `${familyId}-${step}`;

      const existing = matrix[cellKey];
      if (existing) {
        // Multiple colors from the same family map to the same step.
        // Accumulate all sourceKeys so buildMatrixMapping can find each
        // original color, and keep the representative with the highest
        // usageCount so the most-used shade "wins" the visible cell color.
        const existingUsage = colorByKey.get(existing.sourceKeys[0] ?? "")?.usageCount ?? 0;
        const incomingUsage = colorByKey.get(sourceKeys[0] ?? "")?.usageCount ?? 0;
        matrix[cellKey] = {
          ...existing,
          color: incomingUsage > existingUsage
            ? { rgb: color.rgb, hex: color.hex, oklch: color.oklch }
            : existing.color,
          sourceKeys: [...new Set([...existing.sourceKeys, ...sourceKeys])],
        };
      } else {
        matrix[cellKey] = {
          familyId,
          familyName: entry.familyName ?? "Unknown",
          step,
          color: { rgb: color.rgb, hex: color.hex, oklch: color.oklch },
          isGenerated: false,
          isLocked: false,
          useInExport: true,
          sourceKeys,
          semanticRole: entry.semanticRole,
        };
      }
    }
  }

  const orderedFamilies = harmonized.families
    .filter((family) => Object.values(matrix).some((cell) => cell.familyId === family.id))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "neutral" ? -1 : 1;
      }
      if (left.hue === null || right.hue === null) {
        return right.usageCount - left.usageCount;
      }
      return left.hue - right.hue;
    });

  for (const family of orderedFamilies) {
    familyIds.push(family.id);
    familyNames[family.id] = family.name;
  }

  // Expose only the rows that have at least one real colour, sorted ascending
  // (darkest / step 0 at top, lightest / step 900 at bottom).
  const steps = [...usedSteps].sort((a, b) => a - b);

  return {
    familyIds,
    familyNames,
    families: orderedFamilies,
    matrix,
    steps,
  };
}

export function autoFillMatrix(
  current: PaletteMatrix,
  families: FamilySummary[],
  preserveManual: boolean,
  steps = PALETTE_STEPS,
): PaletteMatrix {
  const next = { ...current };
  for (const family of families) {
    for (const step of steps) {
      const key = `${family.id}-${step}`;
      const existing = next[key];
      if (existing) {
        if (preserveManual && (existing.isLocked || !existing.isGenerated)) continue;
        if (existing.color) continue;
      }
      next[key] = generateMatrixCell(family, step);
    }
  }
  return next;
}

export function matrixToTokens(
  matrix: PaletteMatrix,
  skipMissing: boolean,
): PaletteToken[] {
  return Object.values(matrix)
    .filter((cell) => cell.useInExport && (!skipMissing || cell.color !== null))
    .filter((cell) => cell.color !== null)
    .map((cell) => ({
      familyId: cell.familyId,
      familyName: cell.familyName,
      step: cell.step,
      name: cell.semanticRole
        ? `md.sys.color.${cell.semanticRole}.${cell.step}`
        : `color.${cell.familyId}.${cell.step}`,
      rgb: cell.color!.rgb,
      hex: cell.color!.hex,
      oklch: cell.color!.oklch,
      sourceKeys: cell.sourceKeys,
      semanticRole: cell.semanticRole,
    }))
    .sort((a, b) => {
      if (a.familyId !== b.familyId) return a.familyId.localeCompare(b.familyId);
      return a.step - b.step;
    });
}

export function matrixToTokenJson(
  tokens: PaletteToken[],
): Record<string, { value: string; type: "color"; hct: string; role?: string }> {
  return Object.fromEntries(
    tokens.map((t) => [
      t.name,
      {
        value: t.hex,
        type: "color" as const,
        hct: hctToCss(t.oklch),
        role: t.semanticRole,
      },
    ]),
  );
}
