export type SourceKind =
  | "fill"
  | "stroke"
  | "text"
  | "gradient-fill"
  | "gradient-stroke"
  | "gradient-text"
  | "effect";

export type ColorRole = "neutral" | "accent" | "support" | "outlier";
export type FamilyType = "neutral" | "chromatic";
export type ToneBand = "shadows" | "midtones" | "highlights";
export type MaterialSchemeVariant =
  | "content"
  | "tonal-spot"
  | "fidelity"
  | "vibrant"
  | "expressive"
  | "neutral"
  | "monochrome"
  | "rainbow"
  | "fruit-salad";
export type MaterialContrastPresetId = "low" | "standard" | "medium" | "high" | "custom";
export type HarmonyStrategy =
  | "smart"
  | "analogous"
  | "complementary"
  | "split-complementary"
  | "triadic";
export type HuePreset =
  | "none"
  | "negative30"
  | "positive30"
  | "complementary"
  | "analogous";

export interface SerializedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

// Compatibility shape: l/c/h now carry OKLCH lightness/chroma/hue values.
export interface HctColor {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

export type OklchColor = HctColor;

export interface ColorRecordSummary {
  key: string;
  rgb: SerializedColor;
  hex: string;
  oklch: OklchColor;
  usageCount: number;
  nodeCount: number;
  sourceKinds: SourceKind[];
  role: ColorRole;
  theme?: ThemeColorContext;
}

export interface SelectionAnalysisSummary {
  selectionName: string;
  nodeCount: number;
  layerCount: number;
  uniqueColorCount: number;
  colors: ColorRecordSummary[];
  timestamp: number;
  themeDetection?: ThemeDetectionSummary;
}

export type ThemeTextPriority = "primary" | "secondary";
export type ThemeColorKind = "text" | "neutral" | "chromatic";
export type ThemeDirection = "auto" | "light" | "dark";

export interface ThemeColorContext {
  kind: ThemeColorKind;
  saturation: number;
  originalLc?: number;
  textPriority?: ThemeTextPriority;
  textBackground?: SerializedColor;
  textBackgroundHex?: string;
  /** True if the text color was observed at least once on a chromatic (c > 0.05) background. */
  hasChromaticTextBackground?: boolean;
}

export interface ThemeDetectionSummary {
  averageFillLightness: number;
  inferredSourceTheme: "light" | "dark";
}

export interface ThemeFlipSettings {
  /** 0..100 — how close the main background goes to the pure pole (#FFF / #000). */
  backgroundBrightness: number;
  /** 0..100 — contrast between surface tiers (base / raised / overlay / border). */
  surfaceSeparation: number;
  /** 0..150 — chroma scale for chromatic roles. 0 = grayscale, 100 = source, 150 = boost. */
  accentSaturation: number;
  /** -50..+50 — lightness shift for chromatic/accent roles (independent of neutrals). */
  accentBrightness: number;
  /** 30..95 — APCA min |Lc| target for primary body text. */
  textContrast: number;
  /** 0..100 — how far past the APCA threshold text is pulled toward the extreme pole. */
  textWeight: number;
  /**
   * When true, near-pole text (pure white / pure black) that was ever observed
   * on a chromatic background (e.g. button labels, badge text) keeps its source
   * lightness even if elsewhere the same color lives on a neutral surface.
   * Tradeoff: if the same #FFF is shared between a button label AND a body
   * title, the title will also stay white after flipping to light.
   */
  preserveButtonText: boolean;
}

export interface ExploreBandAdjustment {
  hueShift: number;
  chromaScale: number;
}

export interface ExploreSettings {
  exposure: number;
  contrast: number;
  vibrance: number;
  saturation: number;
  hueShift: number;
  chromaScale: number;
  protectNeutrals: boolean;
  neutralThreshold: number;
  clampOutOfGamut: boolean;
  huePreset: HuePreset;
  hueRange: HueRangeSettings;
  grading: Record<ToneBand, ExploreBandAdjustment>;
}

export interface HarmonizeSettings {
  strength: number;
  familyTolerance: number;
  mergeNearDuplicates: boolean;
  pullOutliers: boolean;
  protectNeutrals: boolean;
  preserveContrast: boolean;
  neutralThreshold: number;
  schemeVariant: MaterialSchemeVariant;
  contrastLevel: number;
  seedArgb?: number;
  harmonyMode?: "normalize" | "auto";
  harmonyStrategy?: HarmonyStrategy;
  primaryFamilyId?: string;
  apca: {
    enabled: boolean;
    targetLc: number;
    influence: number;
  };
}

export interface ColorMappingEntry {
  key: string;
  source: SerializedColor;
  sourceHex: string;
  target: SerializedColor;
  targetHex: string;
  targetOklch: OklchColor;
  matrixStep?: number;
  role: ColorRole;
  familyId?: string;
  familyName?: string;
  reason?: string;
  tokenName?: string;
  semanticRole?: string;
  apcaBefore?: number;
  apcaAfter?: number;
  apcaTarget?: number;
  apcaReferenceHex?: string;
  apcaStatus?: "pass" | "improved" | "watch" | "fail";
}

export interface FamilySummary {
  id: string;
  name: string;
  type: FamilyType;
  hue: number | null;
  chroma: number;
  lightness: number;
  usageCount: number;
  memberKeys: string[];
  semanticRole?: string;
}

export interface HarmonizeResult {
  entries: ColorMappingEntry[];
  mapping: Record<string, ColorMappingEntry>;
  families: FamilySummary[];
  uniqueColorCount: number;
  reducedColorCount: number;
  apcaReferences: ColorRecordSummary[];
}

export interface PaletteToken {
  familyId: string;
  familyName: string;
  step: number;
  name: string;
  rgb: SerializedColor;
  hex: string;
  oklch: OklchColor;
  sourceKeys: string[];
  semanticRole?: string;
}

export interface PaletteFamily {
  id: string;
  name: string;
  type: FamilyType;
  baseHue: number | null;
  baseChroma: number;
  tokens: PaletteToken[];
  sourceKeys: string[];
}

export interface PaletteAssignment {
  sourceKey: string;
  sourceHex: string;
  familyId: string;
  familyName: string;
  tokenName: string;
  tokenHex: string;
  semanticRole?: string;
}

export interface PaletteResult {
  families: PaletteFamily[];
  tokens: PaletteToken[];
  assignments: PaletteAssignment[];
  tokenJson: Record<string, { value: string; type: "color"; hct: string; role?: string }>;
}

export type HuePresetChip =
  | "all"
  | "reds"
  | "yellows"
  | "greens"
  | "cyans"
  | "blues"
  | "purples"
  | "neutrals"
  | "custom";

export interface HueRangeSettings {
  preset: HuePresetChip;
  min: number;
  max: number;
  softness: number;
  includeNeutrals: boolean;
}

export interface MatrixCellColor {
  rgb: SerializedColor;
  hex: string;
  oklch: OklchColor;
}

export interface MatrixCell {
  familyId: string;
  familyName: string;
  step: number;
  color: MatrixCellColor | null;
  isGenerated: boolean;
  isLocked: boolean;
  useInExport: boolean;
  sourceKeys: string[];
  semanticRole?: string;
}

export type PaletteMatrix = Record<string, MatrixCell>;

export type ExportFormat = "variables" | "styles" | "json";
