import type {
  ColorMappingEntry,
  ColorRecordSummary,
  OklchColor,
  SerializedColor,
} from "../types";
import { rgbToOklch } from "../color";

export type FlipDirection = "toLight" | "toDark";

export type FlipRole =
  | "surface-base"
  | "surface-raised"
  | "surface-overlay"
  | "border"
  | "divider"
  | "chromatic-surface"
  | "accent-chromatic"
  | "text-primary"
  | "text-secondary"
  | "text-decorative"
  | "text-on-accent"
  | "shadow";

export const DECORATIVE_TEXT_MAX_CONTRAST = 15;
const CHROMATIC_THRESHOLD = 0.04;
const ACCENT_CHROMA_THRESHOLD = 0.06;
const STROKE_BORDER_CHROMA_CAP = 0.03;

export interface ClassifiedColor {
  entry: ColorMappingEntry;
  summary: ColorRecordSummary | undefined;
  role: FlipRole;
  sourceOklch: OklchColor;
  backgroundRgb: SerializedColor | null;
  tierIndex: number;
  tierCount: number;
}

function isEffectOnly(summary: ColorRecordSummary | undefined): boolean {
  const kinds = summary?.sourceKinds ?? [];
  return kinds.length > 0 && kinds.every((kind) => kind === "effect");
}

function isTextLike(summary: ColorRecordSummary | undefined): boolean {
  if (summary?.theme?.kind === "text") return true;
  const kinds = summary?.sourceKinds ?? [];
  return (
    kinds.length > 0 &&
    kinds.every((kind) => kind === "text" || kind === "gradient-text")
  );
}

function isStrokeLike(summary: ColorRecordSummary | undefined): boolean {
  // Classify as stroke-family only when the color is PREDOMINANTLY a stroke.
  // If the same color also appears as a fill (common for neutral bg that also
  // doubles as a 1px divider), fill semantics win — otherwise the main bg
  // gets routed through the border window and never reaches the pole.
  const kinds = summary?.sourceKinds ?? [];
  if (kinds.length === 0) return false;
  return kinds.every(
    (kind) => kind === "stroke" || kind === "gradient-stroke",
  );
}

function isNeutralByChroma(
  summary: ColorRecordSummary | undefined,
  oklch: OklchColor,
): boolean {
  return summary?.theme?.kind === "neutral" || oklch.c <= CHROMATIC_THRESHOLD;
}

function classifyTextRole(
  summary: ColorRecordSummary | undefined,
  backgroundOklch: OklchColor | null,
): FlipRole {
  const originalLc = Math.abs(summary?.theme?.originalLc ?? Infinity);
  if (Number.isFinite(originalLc) && originalLc <= DECORATIVE_TEXT_MAX_CONTRAST) {
    return "text-decorative";
  }
  if (backgroundOklch && backgroundOklch.c > 0.05) {
    return "text-on-accent";
  }
  if (summary?.theme?.textPriority === "secondary") {
    return "text-secondary";
  }
  return "text-primary";
}

function classifySurfaceRole(
  summary: ColorRecordSummary | undefined,
  oklch: OklchColor,
): FlipRole {
  if (isStrokeLike(summary)) {
    return oklch.c <= STROKE_BORDER_CHROMA_CAP ? "border" : "divider";
  }

  if (isNeutralByChroma(summary, oklch)) {
    return "surface-base";
  }

  const role = summary?.role;
  if ((role === "accent" || role === "outlier") && oklch.c > ACCENT_CHROMA_THRESHOLD) {
    return "accent-chromatic";
  }
  return "chromatic-surface";
}

function resolveBackgroundOklch(
  summary: ColorRecordSummary | undefined,
): OklchColor | null {
  const bg = summary?.theme?.textBackground;
  if (!bg) return null;
  return rgbToOklch(bg);
}

export function classifyRoles(
  entries: ColorMappingEntry[],
  analysisColorByKey: ReadonlyMap<string, ColorRecordSummary>,
): ClassifiedColor[] {
  const classified: ClassifiedColor[] = entries.map((entry) => {
    const summary = analysisColorByKey.get(entry.key);
    const sourceOklch = entry.targetOklch;
    const backgroundOklch = resolveBackgroundOklch(summary);
    const backgroundRgb = summary?.theme?.textBackground ?? null;

    let role: FlipRole;
    if (isEffectOnly(summary)) {
      role = "shadow";
    } else if (isTextLike(summary)) {
      role = classifyTextRole(summary, backgroundOklch);
    } else {
      role = classifySurfaceRole(summary, sourceOklch);
    }

    return {
      entry,
      summary,
      role,
      sourceOklch,
      backgroundRgb,
      tierIndex: 0,
      tierCount: 1,
    };
  });

  return classified;
}

/**
 * Promote neutral surfaces into tiered slots (surface-base / raised / overlay)
 * based on their source lightness ordering. Tier assignment is
 * direction-aware: the darkest source is the main bg when flipping dark→light
 * (becomes surface-base → brightest target), but is the deepest layer when
 * flipping light→dark (becomes surface-overlay → brightest target in dark).
 */
export function buildSurfaceTiers(
  classified: ClassifiedColor[],
  direction: FlipDirection,
): void {
  const surfaces = classified.filter(
    (c) =>
      c.role === "surface-base" ||
      c.role === "surface-raised" ||
      c.role === "surface-overlay",
  );
  if (surfaces.length <= 1) return;

  const sorted = [...surfaces].sort(
    (a, b) => a.sourceOklch.l - b.sourceOklch.l,
  );
  const count = sorted.length;

  sorted.forEach((c, index) => {
    const rank = direction === "toLight" ? index : count - 1 - index;
    c.tierIndex = rank;
    c.tierCount = count;

    if (count === 2) {
      c.role = rank === 0 ? "surface-base" : "surface-raised";
    } else if (rank === 0) {
      c.role = "surface-base";
    } else if (rank === count - 1) {
      c.role = "surface-overlay";
    } else {
      c.role = "surface-raised";
    }
  });
}

