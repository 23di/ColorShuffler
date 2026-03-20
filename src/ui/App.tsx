import {
  Fragment,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  buildExploreMapping,
  DEFAULT_EXPLORE_SETTINGS,
  applySurpriseMe,
} from "../shared/explore";
import { harmonizeColors, DEFAULT_HARMONIZE_SETTINGS } from "../shared/harmonize";
import {
  buildThemeSwitchMapping,
  DEFAULT_THEME_SWITCHER_SETTINGS,
  resolveThemeTargetDirection,
} from "../shared/theme-switcher";
import {
  buildPaletteMatrix,
  buildPaletteSteps,
  generateMatrixCell,
  autoFillMatrix,
  matrixToTokens,
  matrixToTokenJson,
} from "../shared/palette";
import type { PluginToUiMessage, UiToPluginMessage } from "../shared/messages";
import type {
  ColorMappingEntry,
  ExploreSettings,
  FamilySummary,
  HarmonizeResult,
  HarmonizeSettings,
  MaterialSchemeVariant,
  MatrixCell,
  PaletteMatrix,
  PaletteToken,
  SelectionAnalysisSummary,
  ExportFormat,
  MaterialContrastPresetId,
  ThemeSwitcherSettings,
} from "../shared/types";
import {
  buildColorRoleIndex,
  clamp01,
  hueDistance,
  normalizeHue,
  oklchToRgb,
  rgbToCss,
  rgbToHex,
  hctToCss,
} from "../shared/color";
import {
  buildMaterialScheme,
  MATERIAL_CONTRAST_PRESETS,
  MATERIAL_SCHEME_VARIANTS,
  getMaterialSchemeRoles,
  pickMaterialSeed,
  resolveMaterialContrastPreset,
} from "../shared/material";

type TabId = "demo" | "theme" | "palette" | "export";
type HueScopeId = "all" | string | null;
type SecondaryHueRelation = "manual" | "complement" | "analog-plus" | "analog-minus" | "triad";
type ExtraHueGroupLinkMode =
  | "manual"
  | "monochrome"
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
type FrameGroup = Pick<FamilySummary, "id" | "name" | "type" | "memberKeys" | "usageCount" | "hue">;
type ExtraHueGroup = {
  id: string;
  scopeId: string;
  baseHue: number | null;
  linkMode: ExtraHueGroupLinkMode;
  hueShift: number;
  exposure: number;
  chromaScale: number;
};
const DEFAULT_UI_WIDTH = 430;
const MIN_UI_WIDTH = 380;
const MAX_UI_WIDTH = 760;

const EMPTY_HARMONIZE: HarmonizeResult = {
  entries: [],
  mapping: {},
  families: [],
  uniqueColorCount: 0,
  reducedColorCount: 0,
  apcaReferences: [],
};

function postMsg(message: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function fmt(v: number, suffix = ""): string {
  const r = Math.round(v * 10) / 10;
  return r > 0 ? `+${r}${suffix}` : `${r}${suffix}`;
}

function normalizeSignedHueShift(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function createHueOnlySettings(base: ExploreSettings, hueShift: number): ExploreSettings {
  return {
    ...base,
    exposure: 0,
    contrast: 0,
    vibrance: 0,
    saturation: 0,
    chromaScale: 1,
    hueShift,
    huePreset: "none",
    grading: {
      shadows: { ...base.grading.shadows, hueShift: 0, chromaScale: 1 },
      midtones: { ...base.grading.midtones, hueShift: 0, chromaScale: 1 },
      highlights: { ...base.grading.highlights, hueShift: 0, chromaScale: 1 },
    },
  };
}

function createPrimaryScopeSettings(base: ExploreSettings, hueShift: number): ExploreSettings {
  return {
    ...base,
    hueShift,
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
): ExploreSettings {
  return {
    ...createHueOnlySettings(base, hueShift),
    exposure,
    chromaScale,
  };
}

function absoluteHueToSigned(value: number): number {
  return normalizeSignedHueShift(normalizeHue(value));
}

function relationHueOffset(relation: SecondaryHueRelation): number {
  switch (relation) {
    case "complement":
      return 180;
    case "analog-plus":
      return 30;
    case "analog-minus":
      return -30;
    case "triad":
      return 120;
    default:
      return 0;
  }
}

function extraHueGroupOffset(relation: ExtraHueGroupLinkMode): number {
  switch (relation) {
    case "monochrome":
      return 0;
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

function resolveExtraHueGroupShift(group: ExtraHueGroup, primaryHueShift: number): number {
  if (group.linkMode === "manual") {
    return group.hueShift;
  }
  return absoluteHueToSigned(normalizeHue(primaryHueShift + extraHueGroupOffset(group.linkMode)));
}

function resolveExtraHueGroupRelativeShift(
  group: ExtraHueGroup,
  primaryHueShift: number,
): number {
  const targetAbsoluteHue = normalizeHue(resolveExtraHueGroupShift(group, primaryHueShift));
  if (group.baseHue === null) {
    return absoluteHueToSigned(targetAbsoluteHue);
  }
  return normalizeSignedHueShift(targetAbsoluteHue - normalizeHue(group.baseHue));
}

function resolveAutoPairingValues(
  group: ExtraHueGroup,
  primaryHueShift: number,
): {
  exposure: number;
  chromaScale: number;
} {
  switch (group.linkMode) {
    case "monochrome":
      return { exposure: 0, chromaScale: 0.78 };
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
      const primaryHue = normalizeHue(primaryHueShift);
      const targetHue = normalizeHue(resolveExtraHueGroupShift(group, primaryHueShift));
      const distance = hueDistance(primaryHue, targetHue);

      if (distance < 30) return { exposure: 0, chromaScale: 0.8 };
      if (distance < 90) return { exposure: 1, chromaScale: 0.9 };
      if (distance < 150) return { exposure: 3, chromaScale: 1.02 };
      return { exposure: 2, chromaScale: 0.94 };
    }
  }
}

function resolveEffectiveExtraHueGroup(
  group: ExtraHueGroup,
  primaryHueShift: number,
): ExtraHueGroup {
  if (group.linkMode === "manual") {
    return group;
  }

  const autoValues = resolveAutoPairingValues(group, primaryHueShift);
  return {
    ...group,
    hueShift: resolveExtraHueGroupShift(group, primaryHueShift),
    exposure: autoValues.exposure,
    chromaScale: autoValues.chromaScale,
  };
}

function materializeManualExtraHueGroup(
  group: ExtraHueGroup,
  primaryHueShift: number,
): ExtraHueGroup {
  const effectiveGroup = resolveEffectiveExtraHueGroup(group, primaryHueShift);
  return {
    ...effectiveGroup,
    linkMode: "manual",
  };
}

function applyTintMapping(
  mapping: Record<string, ColorMappingEntry>,
  targetHue: number,
  neutralThreshold: number,
): Record<string, ColorMappingEntry> {
  return Object.fromEntries(
    Object.entries(mapping).map(([key, entry]) => {
      if (entry.targetOklch.c < neutralThreshold) {
        return [key, entry];
      }

      const nextOklch = {
        ...entry.targetOklch,
        h: normalizeHue(targetHue),
      };
      const nextRgb = oklchToRgb(nextOklch, { clampToGamut: true });

      return [
        key,
        {
          ...entry,
          target: nextRgb,
          targetHex: rgbToHex(nextRgb),
          targetOklch: nextOklch,
          reason: entry.reason ? `${entry.reason}; tint to target hue` : "Tint to target hue",
        } satisfies ColorMappingEntry,
      ];
    }),
  );
}

function collectScopeKeys(
  scope: HueScopeId,
  allKeys: ReadonlySet<string>,
  groupsById: ReadonlyMap<string, FrameGroup>,
  excludedKeys: ReadonlySet<string> = new Set<string>(),
): Set<string> {
  if (scope === "all") {
    return new Set([...allKeys].filter((key) => !excludedKeys.has(key)));
  }
  if (!scope) {
    return new Set<string>();
  }
  return new Set(groupsById.get(scope)?.memberKeys ?? []);
}

function isNeutralFamilyId(id: string): boolean {
  return id === "neutral" || id === "surface" || id === "surface-variant";
}

function applyInvertMode(
  entries: ColorMappingEntry[],
  summary: SelectionAnalysisSummary | null,
  settings: ThemeSwitcherSettings,
  enabled: boolean,
): ColorMappingEntry[] {
  if (!enabled || !summary) return entries;

  const invertedEntries = buildThemeSwitchMapping(summary, settings);
  const invertedByKey = new Map(invertedEntries.map((entry) => [entry.key, entry]));

  return entries.map((entry) => {
    const inverted = invertedByKey.get(entry.key);
    if (!inverted) return entry;
    return {
      ...entry,
      target: inverted.target,
      targetHex: inverted.targetHex,
      targetOklch: inverted.targetOklch,
      reason: inverted.reason,
    };
  });
}

function formatContrastLevel(level: number): string {
  const rounded = Math.round(level * 10) / 10;
  return rounded > 0 ? `+${rounded.toFixed(1)}` : rounded.toFixed(1);
}

function attachGroupingData(
  entries: ColorMappingEntry[],
  groupedEntries: ColorMappingEntry[],
): ColorMappingEntry[] {
  const groupingByKey = new Map(groupedEntries.map((entry) => [entry.key, entry]));
  return entries.map((entry) => {
    const grouping = groupingByKey.get(entry.key);
    if (!grouping) return entry;
    return {
      ...entry,
      familyId: grouping.familyId,
      familyName: grouping.familyName,
      matrixStep: grouping.matrixStep,
      reason: grouping.reason ?? entry.reason,
    };
  });
}

function createIdentityMappingEntry(
  color: AnalysisColor,
  role = color.role,
): ColorMappingEntry {
  return {
    key: color.key,
    source: color.rgb,
    sourceHex: color.hex,
    target: color.rgb,
    targetHex: color.hex,
    targetOklch: color.oklch,
    role,
  };
}

function mappingEntriesToColorSummaries(
  entries: ColorMappingEntry[],
  colorByKey: ReadonlyMap<string, AnalysisColor>,
): AnalysisColor[] {
  return entries
    .map((entry) => {
      const source = colorByKey.get(entry.key);
      if (!source) return null;
      return {
        ...source,
        rgb: entry.target,
        hex: entry.targetHex,
        oklch: entry.targetOklch,
        role: entry.role,
      } satisfies AnalysisColor;
    })
    .filter((entry): entry is AnalysisColor => entry !== null);
}

function buildMatrixMapping(
  matrixCellsByFamily: ReadonlyMap<string, MatrixCell[]>,
  sourceEntries: ColorMappingEntry[],
): ColorMappingEntry[] {
  return sourceEntries.map((entry) => {
    const familyId = entry.familyId ?? "neutral";
    const familyCells = matrixCellsByFamily.get(familyId) ?? [];
    let best =
      familyCells.find((cell) => cell.color && cell.sourceKeys.includes(entry.key)) ??
      (entry.matrixStep !== undefined
        ? familyCells.find((cell) => cell.step === entry.matrixStep && cell.color) ?? null
        : null);
    let bestDist = Infinity;

    if (!best) {
      for (const cell of familyCells) {
        if (!cell.color) continue;
        const dist =
          entry.matrixStep !== undefined
            ? Math.abs(entry.matrixStep - cell.step)
            : Math.abs(entry.targetOklch.l - cell.color.oklch.l);
        if (dist < bestDist) {
          bestDist = dist;
          best = cell;
        }
      }
    }

    if (!best?.color) return entry;
    return {
      ...entry,
      target: best.color.rgb,
      targetHex: best.color.hex,
      targetOklch: best.color.oklch,
      tokenName: `color.${familyId}.${best.step}`,
      reason: `Matrix cell ${familyId}/${best.step}`,
    };
  });
}

function countSharedMemberKeys(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  let count = 0;
  for (const key of right) {
    if (leftSet.has(key)) {
      count += 1;
    }
  }
  return count;
}

// ─── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [tab, setTab] = useState<TabId>("demo");
  const [analysis, setAnalysis] = useState<SelectionAnalysisSummary | null>(null);
  const [status, setStatus] = useState("Reading current selection…");

  // Demo tab state
  const [settings, setSettings] = useState<ExploreSettings>(DEFAULT_EXPLORE_SETTINGS);
  const [primaryHueScope, setPrimaryHueScope] = useState<HueScopeId>("all");
  const [secondaryHueScope, setSecondaryHueScope] = useState<HueScopeId>(null);
  const [primaryTintEnabled, setPrimaryTintEnabled] = useState(false);
  const [extraHueGroups, setExtraHueGroups] = useState<ExtraHueGroup[]>([]);
  const [secondaryHueRelation, setSecondaryHueRelation] = useState<SecondaryHueRelation>("manual");
  const [accent2HueShift, setAccent2HueShift] = useState(120);
  const [invertPassCount, setInvertPassCount] = useState(0);
  const [harmonizeSettings] = useState<HarmonizeSettings>(DEFAULT_HARMONIZE_SETTINGS);
  const [themeSwitcherSettings, setThemeSwitcherSettings] = useState<ThemeSwitcherSettings>(
    DEFAULT_THEME_SWITCHER_SETTINGS,
  );

  // Palette tab state
  const [matrix, setMatrix] = useState<PaletteMatrix>({});
  const [matrixFamilyIds, setMatrixFamilyIds] = useState<string[]>([]);
  const [matrixSteps, setMatrixSteps] = useState<number[]>(buildPaletteSteps(10));
  const [matrixFamilyNames, setMatrixFamilyNames] = useState<Record<string, string>>({});
  const [matrixFamilies, setMatrixFamilies] = useState<FamilySummary[]>([]);
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [ignoreNeutrals, setIgnoreNeutrals] = useState(false);
  const [preserveManual, setPreserveManual] = useState(true);
  const [skipMissing, setSkipMissing] = useState(true);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("variables");
  const [paletteHarmonized, setPaletteHarmonized] = useState(false);
  const [paletteFamilyTolerance, setPaletteFamilyTolerance] = useState(
    DEFAULT_HARMONIZE_SETTINGS.familyTolerance,
  );
  const [collapseByLightness, setCollapseByLightness] = useState(false);
  const [lightnessCollapseTolerance, setLightnessCollapseTolerance] = useState(50);
  const [paletteSchemeVariant, setPaletteSchemeVariant] = useState<MaterialSchemeVariant>(
    DEFAULT_HARMONIZE_SETTINGS.schemeVariant,
  );
  const [paletteContrastLevel, setPaletteContrastLevel] = useState(
    DEFAULT_HARMONIZE_SETTINGS.contrastLevel,
  );
  const [paletteHarmonizeStrength, setPaletteHarmonizeStrength] = useState(
    DEFAULT_HARMONIZE_SETTINGS.strength,
  );
  const [palettePrimaryFamilyId, setPalettePrimaryFamilyId] = useState<string | null>(null);
  const [paletteApcaEnabled, setPaletteApcaEnabled] = useState(
    DEFAULT_HARMONIZE_SETTINGS.apca.enabled,
  );
  const [paletteApcaTargetLc, setPaletteApcaTargetLc] = useState(
    DEFAULT_HARMONIZE_SETTINGS.apca.targetLc,
  );
  const [paletteApcaInfluence, setPaletteApcaInfluence] = useState(
    DEFAULT_HARMONIZE_SETTINGS.apca.influence,
  );
  const [uiWidth, setUiWidth] = useState(DEFAULT_UI_WIDTH);
  const [pluginFocused, setPluginFocused] = useState(true);

  // Compare state
  const shellRef = useRef<HTMLDivElement>(null);
  const compareRef = useRef(false);
  const lastMappingRef = useRef<ColorMappingEntry[]>([]);
  const lastThemeSettingsRef = useRef(themeSwitcherSettings);
  const pluginFocusedRef = useRef(true);

  // ── Message listener ────────────────────────────────────────────────────────
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
            setMatrix({});
            setMatrixFamilyIds([]);
            setMatrixFamilyNames({});
            setMatrixFamilies([]);
            setMatrixSteps(buildPaletteSteps(10));
            setSelectedCellKey(null);
            setPaletteHarmonized(false);
            setPalettePrimaryFamilyId(null);
            setPaletteSchemeVariant(DEFAULT_HARMONIZE_SETTINGS.schemeVariant);
            setPaletteContrastLevel(DEFAULT_HARMONIZE_SETTINGS.contrastLevel);
            setPaletteHarmonizeStrength(DEFAULT_HARMONIZE_SETTINGS.strength);
            setCollapseByLightness(false);
            setLightnessCollapseTolerance(50);
            setPrimaryTintEnabled(false);
            setExtraHueGroups([]);
            setSecondaryHueRelation("manual");
            setInvertPassCount(0);
            setStatus(msg.message);
            break;
          case "export-complete":
            setStatus(
              msg.kind === "variables"
                ? `Created ${msg.created} variables.`
                : `Created ${msg.created} styles.`,
            );
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
      const contentHeight = Math.ceil(shell.scrollHeight);
      const nextWidth = uiWidth;
      const nextHeight = contentHeight;
      if (Math.abs(nextHeight - lastHeight) < 2 && Math.abs(nextWidth - lastWidth) < 2) return;
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
    scheduleSync();

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [analysis, status, tab, uiWidth]);

  // ── Computed values ─────────────────────────────────────────────────────────
  const deferredAnalysis = useDeferredValue(analysis);
  const effectiveExploreSettings = useMemo<ExploreSettings>(
    () => ({
      ...settings,
      hueRange: {
        ...settings.hueRange,
        preset: "all",
        min: 0,
        max: 360,
        softness: 0,
        includeNeutrals: !settings.protectNeutrals,
      },
    }),
    [settings],
  );
  const analysisColorByKey = useMemo(
    () => new Map((deferredAnalysis?.colors ?? []).map((color) => [color.key, color])),
    [deferredAnalysis],
  );
  const exploreRoleByKey = useMemo(
    () =>
      deferredAnalysis
        ? buildColorRoleIndex(deferredAnalysis.colors, effectiveExploreSettings.neutralThreshold)
        : new Map<string, ColorMappingEntry["role"]>(),
    [deferredAnalysis, effectiveExploreSettings.neutralThreshold],
  );
  const matrixCellsByFamily = useMemo(() => {
    const grouped = new Map<string, MatrixCell[]>();
    for (const cell of Object.values(matrix)) {
      if (!cell.color) continue;
      const existing = grouped.get(cell.familyId);
      if (existing) {
        existing.push(cell);
      } else {
        grouped.set(cell.familyId, [cell]);
      }
    }
    return grouped;
  }, [matrix]);

  const primaryHueSettings = useMemo(
    () => createPrimaryScopeSettings(effectiveExploreSettings, settings.hueShift),
    [effectiveExploreSettings, settings.hueShift],
  );
  const effectiveAccent2HueShift = useMemo(
    () =>
      secondaryHueRelation === "manual"
        ? accent2HueShift
        : normalizeSignedHueShift(
            settings.hueShift + relationHueOffset(secondaryHueRelation),
          ),
    [accent2HueShift, secondaryHueRelation, settings.hueShift],
  );
  const secondaryHueSettings = useMemo<ExploreSettings>(
    () =>
      createHueOnlySettings(
        {
          ...effectiveExploreSettings,
          hueRange: {
            ...effectiveExploreSettings.hueRange,
            preset: "all",
            min: 0,
            max: 360,
            softness: 0,
            includeNeutrals: !effectiveExploreSettings.protectNeutrals,
          },
        },
        effectiveAccent2HueShift,
      ),
    [effectiveAccent2HueShift, effectiveExploreSettings],
  );

  const analysisHarmonized = useMemo(
    () => deferredAnalysis ? harmonizeColors(deferredAnalysis.colors, harmonizeSettings) : EMPTY_HARMONIZE,
    [deferredAnalysis, harmonizeSettings],
  );
  const frameGroups = useMemo<FrameGroup[]>(
    () =>
      analysisHarmonized.families
        .filter((family) => family.memberKeys.length > 0)
        .filter((family) => !settings.protectNeutrals || family.type !== "neutral")
        .map((family) => ({
          id: family.id,
          name: family.name,
          type: family.type,
          hue: family.hue,
          memberKeys: family.memberKeys,
          usageCount: family.usageCount,
        })),
    [analysisHarmonized.families, settings.protectNeutrals],
  );
  const chromaticGroups = useMemo(
    () => frameGroups.filter((group) => group.type !== "neutral"),
    [frameGroups],
  );
  const frameGroupById = useMemo(
    () => new Map(frameGroups.map((group) => [group.id, group])),
    [frameGroups],
  );
  const allColorKeys = useMemo(
    () => new Set((deferredAnalysis?.colors ?? []).map((color) => color.key)),
    [deferredAnalysis],
  );
  const addedExtraGroupScopeIds = useMemo(
    () => new Set(extraHueGroups.map((group) => group.scopeId)),
    [extraHueGroups],
  );
  const allChromaticGroupsSeparated = useMemo(
    () =>
      chromaticGroups.length > 0 &&
      chromaticGroups.every((group) => addedExtraGroupScopeIds.has(group.id)),
    [addedExtraGroupScopeIds, chromaticGroups],
  );
  const invertActive = invertPassCount % 2 === 1;
  const demoEntries = useMemo<ColorMappingEntry[]>(() => {
    const extraHueKeys = new Set<string>();
    for (const group of extraHueGroups) {
      for (const key of frameGroupById.get(group.scopeId)?.memberKeys ?? []) {
        extraHueKeys.add(key);
      }
    }

    const primaryHueKeys = collectScopeKeys(
      primaryHueScope,
      allColorKeys,
      frameGroupById,
      extraHueKeys,
    );

    const sourceColors = deferredAnalysis?.colors ?? [];
    const originalIdentityByKey = new Map(
      sourceColors.map((color) => [color.key, createIdentityMappingEntry(color)]),
    );

    const primaryColors = sourceColors.filter(
      (color) => primaryHueKeys.has(color.key),
    );

    const primaryHueBaseMapping = primaryColors.length > 0
      ? buildExploreMapping(primaryColors, primaryHueSettings, exploreRoleByKey)
      : {};
    const primaryHueMapping =
      primaryTintEnabled && primaryColors.length > 0
        ? applyTintMapping(
            primaryHueBaseMapping,
            settings.hueShift,
            effectiveExploreSettings.neutralThreshold,
          )
        : primaryHueBaseMapping;
    const extraHueMapping = extraHueGroups.reduce<Record<string, ColorMappingEntry>>(
      (combined, group) => {
        const groupKeys = new Set(frameGroupById.get(group.scopeId)?.memberKeys ?? []);
        const groupColors = sourceColors.filter((color) => groupKeys.has(color.key));
        if (groupColors.length === 0) {
          return combined;
        }
        const effectiveGroup = resolveEffectiveExtraHueGroup(group, settings.hueShift);
        const groupSettings = createScopedHueSettings(
          {
            ...effectiveExploreSettings,
            hueRange: {
              ...effectiveExploreSettings.hueRange,
              preset: "all",
              min: 0,
              max: 360,
              softness: 0,
              includeNeutrals: !effectiveExploreSettings.protectNeutrals,
            },
          },
          resolveExtraHueGroupRelativeShift(effectiveGroup, settings.hueShift),
          effectiveGroup.exposure,
          effectiveGroup.chromaScale,
        );

        return {
          ...combined,
          ...buildExploreMapping(groupColors, groupSettings, exploreRoleByKey),
        };
      },
      {},
    );

    const baseEntries = sourceColors.map((color) => {
      const identity = originalIdentityByKey.get(color.key) ?? createIdentityMappingEntry(color);
      return extraHueMapping[color.key] ?? primaryHueMapping[color.key] ?? identity;
    });

    return applyInvertMode(baseEntries, deferredAnalysis, themeSwitcherSettings, invertActive);
  }, [
    allColorKeys,
    analysisColorByKey,
    deferredAnalysis,
    extraHueGroups,
    exploreRoleByKey,
    effectiveExploreSettings,
    frameGroupById,
    invertActive,
    primaryTintEnabled,
    primaryHueScope,
    primaryHueSettings,
    settings.hueShift,
    effectiveExploreSettings.neutralThreshold,
    themeSwitcherSettings,
  ]);
  const currentPageColors = useMemo(
    () => mappingEntriesToColorSummaries(demoEntries, analysisColorByKey),
    [analysisColorByKey, demoEntries],
  );
  const paletteBaseHarmonizeSettings = useMemo<HarmonizeSettings>(
    () => ({
      ...harmonizeSettings,
      familyTolerance: paletteFamilyTolerance,
      schemeVariant: paletteSchemeVariant,
      contrastLevel: paletteContrastLevel,
    }),
    [harmonizeSettings, paletteContrastLevel, paletteFamilyTolerance, paletteSchemeVariant],
  );
  const paletteGrouping = useMemo(
    () => harmonizeColors(currentPageColors, paletteBaseHarmonizeSettings),
    [currentPageColors, paletteBaseHarmonizeSettings],
  );
  const defaultPalettePrimaryFamilyId = useMemo(
    () => paletteGrouping.families.find((family) => family.type === "chromatic")?.id ?? null,
    [paletteGrouping.families],
  );
  const resolvedPalettePrimaryFamilyId = useMemo(() => {
    if (
      palettePrimaryFamilyId &&
      paletteGrouping.families.some((family) => family.id === palettePrimaryFamilyId)
    ) {
      return palettePrimaryFamilyId;
    }
    return defaultPalettePrimaryFamilyId;
  }, [defaultPalettePrimaryFamilyId, paletteGrouping.families, palettePrimaryFamilyId]);
  const paletteSeedArgb = useMemo(() => {
    if (!resolvedPalettePrimaryFamilyId) return undefined;
    const selectedFamily = paletteGrouping.families.find(
      (family) => family.id === resolvedPalettePrimaryFamilyId,
    );
    if (!selectedFamily) return undefined;
    const familyColors = currentPageColors.filter((color) =>
      selectedFamily.memberKeys.includes(color.key),
    );
    return familyColors.length > 0 ? pickMaterialSeed(familyColors) : undefined;
  }, [currentPageColors, paletteGrouping.families, resolvedPalettePrimaryFamilyId]);
  const paletteHarmonySettings = useMemo<HarmonizeSettings>(
    () => ({
      ...harmonizeSettings,
      familyTolerance: paletteFamilyTolerance,
      schemeVariant: paletteSchemeVariant,
      contrastLevel: paletteContrastLevel,
      harmonyMode: "auto",
      primaryFamilyId: resolvedPalettePrimaryFamilyId ?? undefined,
      seedArgb: paletteSeedArgb,
      strength: paletteHarmonizeStrength,
      apca: {
        enabled: paletteApcaEnabled,
        targetLc: paletteApcaTargetLc,
        influence: paletteApcaInfluence,
      },
    }),
    [
      harmonizeSettings,
      paletteApcaEnabled,
      paletteApcaInfluence,
      paletteApcaTargetLc,
      paletteContrastLevel,
      paletteFamilyTolerance,
      paletteHarmonizeStrength,
      paletteSchemeVariant,
      paletteSeedArgb,
      resolvedPalettePrimaryFamilyId,
    ],
  );
  const paletteHarmonyGrouping = useMemo(
    () => harmonizeColors(currentPageColors, paletteHarmonySettings),
    [currentPageColors, paletteHarmonySettings],
  );
  const paletteRawEntries = useMemo(
    () => attachGroupingData(demoEntries, paletteGrouping.entries),
    [demoEntries, paletteGrouping.entries],
  );
  const paletteActiveEntries = useMemo<ColorMappingEntry[]>(
    () => (paletteHarmonized ? paletteHarmonyGrouping.entries : paletteRawEntries),
    [paletteHarmonyGrouping.entries, paletteHarmonized, paletteRawEntries],
  );
  const paletteSourceColors = useMemo(
    () => mappingEntriesToColorSummaries(paletteActiveEntries, analysisColorByKey),
    [analysisColorByKey, paletteActiveEntries],
  );
  const paletteMatrixGrouping = useMemo(
    () => (paletteHarmonized ? paletteHarmonyGrouping : paletteGrouping),
    [paletteGrouping, paletteHarmonyGrouping, paletteHarmonized],
  );
  const paletteApcaSummary = useMemo(() => {
    const measuredEntries = paletteHarmonyGrouping.entries.filter(
      (entry) => entry.apcaBefore !== undefined && entry.apcaAfter !== undefined,
    );
    const counts = {
      pass: 0,
      improved: 0,
      watch: 0,
      fail: 0,
    };

    for (const entry of measuredEntries) {
      if (entry.apcaStatus) {
        counts[entry.apcaStatus] += 1;
      }
    }

    const averageBefore =
      measuredEntries.length > 0
        ? measuredEntries.reduce((sum, entry) => sum + (entry.apcaBefore ?? 0), 0) /
          measuredEntries.length
        : 0;
    const averageAfter =
      measuredEntries.length > 0
        ? measuredEntries.reduce((sum, entry) => sum + (entry.apcaAfter ?? 0), 0) /
          measuredEntries.length
        : 0;

    return {
      total: measuredEntries.length,
      averageBefore,
      averageAfter,
      counts,
      references: paletteHarmonyGrouping.apcaReferences,
    };
  }, [paletteHarmonyGrouping]);
  const matrixMapping = useMemo(
    () => buildMatrixMapping(matrixCellsByFamily, paletteActiveEntries),
    [matrixCellsByFamily, paletteActiveEntries],
  );
  const themeEntries = useMemo<ColorMappingEntry[]>(
    () => (deferredAnalysis ? buildThemeSwitchMapping(deferredAnalysis, themeSwitcherSettings) : []),
    [deferredAnalysis, themeSwitcherSettings],
  );
  const themeContrastPreset = useMemo(
    () => resolveMaterialContrastPreset(themeSwitcherSettings.contrastLevel),
    [themeSwitcherSettings.contrastLevel],
  );
  const paletteContrastPreset = useMemo(
    () => resolveMaterialContrastPreset(paletteContrastLevel),
    [paletteContrastLevel],
  );
  const themeStats = useMemo(() => {
    if (!deferredAnalysis) return null;
    const total = deferredAnalysis.colors.length;
    const textCount = deferredAnalysis.colors.filter((color) => color.theme?.kind === "text").length;
    const chromaticCount = deferredAnalysis.colors.filter(
      (color) => color.theme?.kind === "chromatic",
    ).length;
    const neutralCount = total - textCount - chromaticCount;
    return {
      total,
      textCount,
      chromaticCount,
      neutralCount,
      sourceTheme: deferredAnalysis.themeDetection?.inferredSourceTheme ?? "unknown",
      avgLightness: deferredAnalysis.themeDetection?.averageFillLightness ?? 0,
    };
  }, [deferredAnalysis]);
  const themeSchemePreview = useMemo(() => {
    if (!deferredAnalysis) return null;
    const seedArgb = pickMaterialSeed(deferredAnalysis.colors);
    const sourceIsDark = deferredAnalysis.themeDetection?.inferredSourceTheme === "dark";
    const targetDirection = resolveThemeTargetDirection(deferredAnalysis, themeSwitcherSettings);
    const sourceScheme = buildMaterialScheme(
      seedArgb,
      sourceIsDark,
      themeSwitcherSettings.contrastLevel,
      themeSwitcherSettings.schemeVariant,
    );
    const targetScheme = buildMaterialScheme(
      seedArgb,
      targetDirection === "dark",
      themeSwitcherSettings.contrastLevel,
      themeSwitcherSettings.schemeVariant,
    );
    const sourceRoles = getMaterialSchemeRoles(sourceScheme);
    const targetRoles = getMaterialSchemeRoles(targetScheme);
    const swatchRoles = [
      ["background", "onBackground"],
      ["surface", "onSurface"],
      ["primary", "onPrimary"],
      ["secondary", "onSecondary"],
      ["tertiary", "onTertiary"],
    ] as const;

    const pickRole = (name: string, roles: ReturnType<typeof getMaterialSchemeRoles>) =>
      roles.find((role) => role.name === name) ?? roles[0];
    const variantLabel =
      MATERIAL_SCHEME_VARIANTS.find(
        (option) => option.value === themeSwitcherSettings.schemeVariant,
      )?.label ?? themeSwitcherSettings.schemeVariant;

    return {
      variantLabel,
      targetDirection,
      contrastPreset: resolveMaterialContrastPreset(themeSwitcherSettings.contrastLevel),
      swatches: swatchRoles.map(([surfaceName, textName]) => ({
        label: surfaceName,
        source: pickRole(surfaceName, sourceRoles),
        sourceText: pickRole(textName, sourceRoles),
        target: pickRole(surfaceName, targetRoles),
        targetText: pickRole(textName, targetRoles),
      })),
    };
  }, [deferredAnalysis, themeSwitcherSettings]);

  useEffect(() => {
    if (
      !palettePrimaryFamilyId ||
      !paletteGrouping.families.some((family) => family.id === palettePrimaryFamilyId)
    ) {
      setPalettePrimaryFamilyId(defaultPalettePrimaryFamilyId);
    }
  }, [defaultPalettePrimaryFamilyId, paletteGrouping.families, palettePrimaryFamilyId]);

  useEffect(() => {
    setExtraHueGroups((current) =>
      current.filter((group) => frameGroupById.has(group.scopeId)),
    );
  }, [frameGroupById]);

  // ── Shared helper: commit a buildPaletteMatrix result to state ──────────────
  const applyMatrixResult = useCallback(
    (result: ReturnType<typeof buildPaletteMatrix>) => {
      setMatrix(result.matrix);
      setMatrixFamilyIds(
        result.familyIds.filter((id: string) => !ignoreNeutrals || !isNeutralFamilyId(id)),
      );
      setMatrixSteps(result.steps);
      setMatrixFamilyNames(result.familyNames);
      setMatrixFamilies(result.families);
    },
    [ignoreNeutrals],
  );

  // Build matrix from current demo result when selection changes
  useEffect(() => {
    if (!deferredAnalysis) return;
    applyMatrixResult(
      buildPaletteMatrix(paletteSourceColors, paletteMatrixGrouping, {
        collapseByLightness,
        lightnessTolerance: lightnessCollapseTolerance,
      }),
    );
  }, [
    applyMatrixResult,
    collapseByLightness,
    deferredAnalysis,
    lightnessCollapseTolerance,
    paletteMatrixGrouping,
    paletteSourceColors,
  ]);

  const populatePalette = (entries: ColorMappingEntry[], grouping: HarmonizeResult) => {
    const basePaletteColors = mappingEntriesToColorSummaries(entries, analysisColorByKey);
    applyMatrixResult(
      buildPaletteMatrix(basePaletteColors, grouping, {
        collapseByLightness,
        lightnessTolerance: lightnessCollapseTolerance,
      }),
    );
    setPaletteHarmonized(false);
    setSelectedCellKey(null);
    setTab("palette");
  };
  const populatePaletteFromDemo = () => {
    populatePalette(paletteRawEntries, paletteGrouping);
  };
  const populatePaletteFromTheme = () => {
    const themePaletteSettings = {
      ...paletteBaseHarmonizeSettings,
      schemeVariant: themeSwitcherSettings.schemeVariant,
      contrastLevel: themeSwitcherSettings.contrastLevel,
    } satisfies HarmonizeSettings;
    setPaletteSchemeVariant(themeSwitcherSettings.schemeVariant);
    setPaletteContrastLevel(themeSwitcherSettings.contrastLevel);
    const themedGrouping = harmonizeColors(
      mappingEntriesToColorSummaries(themeEntries, analysisColorByKey),
      themePaletteSettings,
    );
    populatePalette(themeEntries, themedGrouping);
  };
  const handleTabChange = (nextTab: TabId) => {
    if (nextTab === "palette" && tab === "demo") {
      populatePaletteFromDemo();
      return;
    }
    if (nextTab === "palette" && tab === "theme") {
      populatePaletteFromTheme();
      return;
    }
    setTab(nextTab);
  };
  const selectedMatrixPrimaryFamilyId = useMemo(() => {
    if (!resolvedPalettePrimaryFamilyId) return null;
    if (matrixFamilies.some((family) => family.id === resolvedPalettePrimaryFamilyId)) {
      return resolvedPalettePrimaryFamilyId;
    }

    const sourceFamily = paletteGrouping.families.find(
      (family) => family.id === resolvedPalettePrimaryFamilyId,
    );
    if (!sourceFamily) return null;

    return (
      matrixFamilies
        .filter((family) => family.type === "chromatic")
        .reduce<FamilySummary | null>((best, family) => {
          const overlap = countSharedMemberKeys(sourceFamily.memberKeys, family.memberKeys);
          if (!best) return overlap > 0 ? family : null;
          const bestOverlap = countSharedMemberKeys(sourceFamily.memberKeys, best.memberKeys);
          return overlap > bestOverlap ? family : best;
        }, null)
        ?.id ?? null
    );
  }, [matrixFamilies, paletteGrouping.families, resolvedPalettePrimaryFamilyId]);
  const selectedMatrixPrimaryFamilyName = useMemo(
    () =>
      selectedMatrixPrimaryFamilyId
        ? matrixFamilyNames[selectedMatrixPrimaryFamilyId] ?? selectedMatrixPrimaryFamilyId
        : null,
    [matrixFamilyNames, selectedMatrixPrimaryFamilyId],
  );

  const handleSelectPrimaryPaletteFamily = (familyId: string) => {
    const displayedFamily = matrixFamilies.find((family) => family.id === familyId);
    if (!displayedFamily || displayedFamily.type !== "chromatic") return;

    if (paletteGrouping.families.some((family) => family.id === familyId)) {
      setPalettePrimaryFamilyId(familyId);
      return;
    }

    const matchedSourceFamily = paletteGrouping.families
      .filter((family) => family.type === "chromatic")
      .reduce<FamilySummary | null>((best, family) => {
        const overlap = countSharedMemberKeys(displayedFamily.memberKeys, family.memberKeys);
        if (!best) return overlap > 0 ? family : null;
        const bestOverlap = countSharedMemberKeys(displayedFamily.memberKeys, best.memberKeys);
        return overlap > bestOverlap ? family : best;
      }, null);

    setPalettePrimaryFamilyId(matchedSourceFamily?.id ?? displayedFamily.id);
  };

  const activeMapping = useMemo<ColorMappingEntry[]>(
    () =>
      tab === "demo"
        ? demoEntries
        : tab === "theme"
          ? themeEntries
          : matrixMapping,
    [demoEntries, matrixMapping, tab, themeEntries],
  );

  // ── Live preview ────────────────────────────────────────────────────────────
  const previewSig = activeMapping.map(e => `${e.key}:${e.targetHex}`).join("|");
  const themePreviewSig = JSON.stringify(themeSwitcherSettings);

  useEffect(() => {
    lastMappingRef.current = activeMapping;
    lastThemeSettingsRef.current = themeSwitcherSettings;
    if (!pluginFocused || !deferredAnalysis) return;
    const t = window.setTimeout(() => {
      // Theme tab: preview is intentionally NOT sent automatically here.
      // The user must click "Apply" to push the transformation to Figma,
      // so they can freely tweak settings without touching the canvas.
      if (tab === "theme") return;
      if (activeMapping.length === 0) return;
      postMsg({ type: "preview-colors", mapping: activeMapping });
    }, 60);
    return () => window.clearTimeout(t);
  }, [activeMapping, deferredAnalysis, pluginFocused, previewSig, tab, themePreviewSig, themeSwitcherSettings]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleReset = () => {
    setPrimaryHueScope("all");
    setSecondaryHueScope(null);
    setPrimaryTintEnabled(false);
    setExtraHueGroups([]);
    setSecondaryHueRelation("manual");
    setAccent2HueShift(120);
    setInvertPassCount(0);
    setPaletteHarmonized(false);
    setPaletteSchemeVariant(DEFAULT_HARMONIZE_SETTINGS.schemeVariant);
    setPaletteContrastLevel(DEFAULT_HARMONIZE_SETTINGS.contrastLevel);
    setPaletteHarmonizeStrength(DEFAULT_HARMONIZE_SETTINGS.strength);
    setSettings(DEFAULT_EXPLORE_SETTINGS);
    setThemeSwitcherSettings(DEFAULT_THEME_SWITCHER_SETTINGS);
    postMsg({ type: "clear-preview" });
  };

  const handleCompareStart = () => {
    compareRef.current = true;
    postMsg({ type: "clear-preview" });
  };

  const handleCompareEnd = () => {
    compareRef.current = false;
    if (tab === "theme") {
      postMsg({ type: "preview-theme", settings: lastThemeSettingsRef.current });
      return;
    }
    if (lastMappingRef.current.length > 0) {
      postMsg({ type: "preview-colors", mapping: lastMappingRef.current });
    }
  };

  const handleHueScopeChange = (target: "primary" | "secondary", nextScope: HueScopeId) => {
    let nextPrimary = primaryHueScope;
    let nextSecondary = secondaryHueScope;

    if (target === "primary") {
      nextPrimary = primaryHueScope === nextScope && nextScope !== "all" ? null : nextScope;
      if (nextPrimary === "all" && nextSecondary === "all") {
        nextSecondary = null;
      }
      if (nextPrimary && nextPrimary !== "all" && nextSecondary === nextPrimary) {
        nextSecondary = null;
      }
    } else {
      nextSecondary = secondaryHueScope === nextScope && nextScope !== "all" ? null : nextScope;
      if (nextSecondary === "all" && nextPrimary === "all") {
        nextPrimary = null;
      }
      if (nextSecondary && nextSecondary !== "all" && nextPrimary === nextSecondary) {
        nextPrimary = null;
      }
    }

    setPrimaryHueScope(nextPrimary);
    setSecondaryHueScope(nextSecondary);
  };

  const handleAddExtraHueGroup = (scopeId: string) => {
    setExtraHueGroups((current) => {
      if (current.some((group) => group.scopeId === scopeId)) {
        return current;
      }
      const scope = frameGroupById.get(scopeId);
      const initialHue = scope?.hue ?? normalizeHue(settings.hueShift);
      return [
        ...current,
        {
          id: `${scopeId}-${Date.now()}`,
          scopeId,
          baseHue: scope?.hue ?? null,
          linkMode: "manual",
          hueShift: absoluteHueToSigned(initialHue),
          exposure: 0,
          chromaScale: 1,
        },
      ];
    });
    setPrimaryHueScope((current) => (current === scopeId ? "all" : current));
  };

  const handleRemoveExtraHueGroup = (id: string) => {
    setExtraHueGroups((current) => current.filter((group) => group.id !== id));
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
      | Partial<Pick<ExtraHueGroup, "hueShift" | "exposure" | "chromaScale">>
      | ((
          group: ExtraHueGroup,
        ) => Partial<Pick<ExtraHueGroup, "hueShift" | "exposure" | "chromaScale">>),
  ) => {
    handleExtraHueGroupChange(id, (group) => {
      const manualGroup =
        group.linkMode === "manual"
          ? group
          : materializeManualExtraHueGroup(group, settings.hueShift);
      const nextPatch = typeof patch === "function" ? patch(manualGroup) : patch;
      return { ...manualGroup, ...nextPatch };
    });
  };

  const handleExtraHueGroupLinkModeChange = (
    id: string,
    nextLinkMode: ExtraHueGroupLinkMode,
  ) => {
    handleExtraHueGroupChange(id, (group) => {
      if (group.linkMode === nextLinkMode) {
        return group;
      }
      if (nextLinkMode === "manual") {
        return materializeManualExtraHueGroup(group, settings.hueShift);
      }
      return { ...group, linkMode: nextLinkMode };
    });
  };

  const handleHueQuickShift = (
    target: "primary" | "secondary",
    preset: "-30" | "+30" | "comp" | "analog",
  ) => {
    const shifts = {
      "-30": -30,
      "+30": 30,
      comp: 180,
      analog: 30,
    } satisfies Record<"-30" | "+30" | "comp" | "analog", number>;

    if (target === "primary") {
      setSettings((current) => ({
        ...current,
        hueShift: normalizeSignedHueShift(current.hueShift + shifts[preset]),
      }));
      return;
    }

    setAccent2HueShift((current) => normalizeSignedHueShift(current + shifts[preset]));
  };

  const handleSecondaryHueRelationChange = (nextRelation: SecondaryHueRelation) => {
    if (nextRelation === secondaryHueRelation) return;

    if (nextRelation === "manual") {
      setAccent2HueShift(effectiveAccent2HueShift);
    }

    setSecondaryHueRelation(nextRelation);
  };

  const handleSurprise = () => {
    setSettings((current) => applySurpriseMe(current));
  };
  const handleInvert = () => {
    setInvertPassCount((current) => current + 1);
  };
  const updateThemeSettings = (
    patch: Partial<ThemeSwitcherSettings> | ((current: ThemeSwitcherSettings) => ThemeSwitcherSettings),
  ) => {
    setThemeSwitcherSettings((current) =>
      typeof patch === "function" ? patch(current) : { ...current, ...patch },
    );
  };
  const applyThemeContrastPreset = (presetId: Exclude<MaterialContrastPresetId, "custom">) => {
    const preset = MATERIAL_CONTRAST_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    updateThemeSettings({ contrastLevel: preset.level });
  };
  const applyPaletteContrastPreset = (presetId: Exclude<MaterialContrastPresetId, "custom">) => {
    const preset = MATERIAL_CONTRAST_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setPaletteContrastLevel(preset.level);
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

  const handleAddCell = (cellKey: string, familyId: string, step: number) => {
    const family = matrixFamilies.find(f => f.id === familyId);
    if (!family) return;
    const cell = generateMatrixCell(family, step);
    setMatrix(m => ({ ...m, [cellKey]: cell }));
    setSelectedCellKey(cellKey);
  };

  const handleUpdateCell = (cellKey: string, updated: MatrixCell) => {
    setMatrix(m => ({ ...m, [cellKey]: updated }));
  };

  const handleAutoFill = () => {
    setMatrix(m => autoFillMatrix(m, matrixFamilies, preserveManual, matrixSteps));
  };

  const handleResetMatrix = () => {
    if (paletteSourceColors.length === 0) return;
    applyMatrixResult(
      buildPaletteMatrix(paletteSourceColors, paletteMatrixGrouping, {
        collapseByLightness,
        lightnessTolerance: lightnessCollapseTolerance,
      }),
    );
    setSelectedCellKey(null);
  };

  const exportTokens = useMemo(
    () => matrixToTokens(matrix, skipMissing),
    [matrix, skipMissing],
  );

  const handleExport = () => {
    if (exportFormat === "variables") {
      postMsg({ type: "export-variables", tokens: exportTokens, collectionName: "Color Shuffler Light" });
    } else if (exportFormat === "styles") {
      postMsg({ type: "export-styles", tokens: exportTokens, styleGroupName: "Color Shuffler Light" });
    } else {
      const json = JSON.stringify(matrixToTokenJson(exportTokens), null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "color-shifter-light.tokens.json"; a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleCopyJson = () => {
    const json = JSON.stringify(matrixToTokenJson(exportTokens), null, 2);
    navigator.clipboard
      .writeText(json)
      .then(() => setStatus("JSON copied to clipboard."))
      .catch(() => setStatus("Copy failed — clipboard not available."));
  };

  const selectedCell = selectedCellKey ? matrix[selectedCellKey] : null;
  const filledCount = useMemo(
    () => Object.values(matrix).filter((cell) => cell.color).length,
    [matrix],
  );
  const totalCells = matrixFamilyIds.length * matrixSteps.length;
  const missingCount = totalCells - filledCount;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="shell" ref={shellRef}>
      {/* Empty state */}
      {!analysis ? (
        <div className="empty">
          <p>Select a frame or component to analyze in HCT.</p>
          <button className="btn-secondary" onClick={() => postMsg({ type: "scan-selection" })}>
            Rescan
          </button>
        </div>
      ) : (
        <div className="content">

          {/* ── DEMO TAB ── */}
          {tab === "demo" && (
            <>
              <Section>
                <div className="control-stack">
                  <div className={`main-controls${allChromaticGroupsSeparated ? " main-controls-disabled" : ""}`}>
                    <div className="hue-cluster">
                      <div className="scope-row">
                        <div className="chip-row">
                          <button
                            className={`chip ${primaryHueScope === "all" ? "is-active" : ""}`}
                            disabled={allChromaticGroupsSeparated}
                            onClick={() => handleHueScopeChange("primary", "all")}
                          >
                            All
                          </button>
                          {chromaticGroups.map((group) => {
                            const isClaimedByExtraGroup = addedExtraGroupScopeIds.has(group.id);
                            return (
                              <button
                                key={`primary-${group.id}`}
                                className={`chip ${primaryHueScope === group.id ? "is-active" : ""}`}
                                disabled={isClaimedByExtraGroup || allChromaticGroupsSeparated}
                                onClick={() => handleHueScopeChange("primary", group.id)}
                                title={
                                  isClaimedByExtraGroup
                                    ? `${group.name} is controlled by an extra hue group`
                                    : undefined
                                }
                              >
                                {group.name}
                              </button>
                            );
                          })}
                        </div>
                        <div className="toggle-row main-toggle-row">
                          <ToggleCheck
                            label="Neutrals"
                            checked={settings.protectNeutrals}
                            disabled={allChromaticGroupsSeparated}
                            onChange={(protectNeutrals) =>
                              setSettings((current) => ({ ...current, protectNeutrals }))
                            }
                          />
                          <ToggleCheck
                            label="Tint"
                            checked={primaryTintEnabled}
                            disabled={allChromaticGroupsSeparated}
                            onChange={setPrimaryTintEnabled}
                          />
                        </div>
                      </div>
                      <RangeField
                        label="Hue"
                        min={-180}
                        max={180}
                        step={1}
                        value={settings.hueShift}
                        display={fmt(settings.hueShift, "°")}
                        variant="hue"
                        disabled={allChromaticGroupsSeparated}
                        onChange={(v) => setSettings((s) => ({ ...s, hueShift: v }))}
                      />
                      <div className="button-row compact hue-quick-row">
                        {(["-30", "+30", "comp", "analog"] as const).map((preset) => (
                          <button
                            key={`primary-${preset}`}
                            className="btn-ghost"
                            disabled={allChromaticGroupsSeparated}
                            onClick={() => handleHueQuickShift("primary", preset)}
                          >
                            {preset === "-30" ? "−30°" : preset === "+30" ? "+30°" : preset === "comp" ? "Comp" : "Analog"}
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
                      disabled={allChromaticGroupsSeparated}
                      onChange={(v) => setSettings((s) => ({ ...s, exposure: v }))}
                    />
                    <RangeField
                      label="Contrast"
                      min={-100}
                      max={100}
                      step={1}
                      value={settings.contrast}
                      display={fmt(settings.contrast)}
                      disabled={allChromaticGroupsSeparated}
                      onChange={(v) => setSettings((s) => ({ ...s, contrast: v }))}
                    />
                    <RangeField
                      label="Chroma scale"
                      min={0}
                      max={200}
                      step={1}
                      value={Math.round(settings.chromaScale * 100)}
                      display={`${Math.round(settings.chromaScale * 100)}%`}
                      className="main-chroma-field"
                      disabled={allChromaticGroupsSeparated}
                      onChange={(v) => setSettings((s) => ({ ...s, chromaScale: v / 100 }))}
                    />
                  </div>

                  {extraHueGroups.length > 0 ? (
                    <div className="extra-hue-group-stack">
                      {extraHueGroups.map((group) => {
                        const scope = frameGroupById.get(group.scopeId);
                        if (!scope) return null;
                        const effectiveGroup = resolveEffectiveExtraHueGroup(group, settings.hueShift);
                        const isLinkedPreset = group.linkMode !== "manual";
                        const effectiveHueShift = effectiveGroup.hueShift;
                        const effectiveGroupHue = normalizeHue(effectiveHueShift);
                        const groupStyle = {
                          "--group-accent": `hsl(${effectiveGroupHue} 86% 58%)`,
                        } as CSSProperties;
                        return (
                          <div key={group.id} className="hue-group-card" style={groupStyle}>
                            <div className="hue-group-header">
                              <div className="hue-group-copy">
                                <strong>
                                  {scope.name}{" "}
                                  <span className="hue-group-count">{scope.memberKeys.length}</span>
                                </strong>
                              </div>
                              <div className="hue-group-actions">
                                <SelectField
                                  ariaLabel={`${scope.name} hue link mode`}
                                  value={group.linkMode}
                                  onChange={(value) =>
                                    handleExtraHueGroupLinkModeChange(
                                      group.id,
                                      value as ExtraHueGroupLinkMode,
                                    )
                                  }
                                  options={[
                                    { value: "manual", label: "Free" },
                                    { value: "monochrome", label: "Monochrome" },
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
                                  ]}
                                />
                                <button
                                  className="btn-ghost icon-btn"
                                  title={`Remove ${scope.name}`}
                                  aria-label={`Remove ${scope.name}`}
                                  onClick={() => handleRemoveExtraHueGroup(group.id)}
                                >
                                  <IconMinus />
                                </button>
                              </div>
                            </div>
                            <RangeField
                              label={`${scope.name} hue`}
                              min={-180}
                              max={180}
                              step={1}
                              value={effectiveHueShift}
                              display={fmt(effectiveHueShift, "°")}
                              variant="hue"
                              softDisabled={isLinkedPreset}
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
                              softDisabled={isLinkedPreset}
                              onChange={(value) =>
                                handleExtraHueGroupManualSliderChange(group.id, {
                                  exposure: value,
                                })
                              }
                            />
                            <RangeField
                              label="Chroma scale"
                              min={0}
                              max={200}
                              step={1}
                              value={Math.round(effectiveGroup.chromaScale * 100)}
                              display={`${Math.round(effectiveGroup.chromaScale * 100)}%`}
                              softDisabled={isLinkedPreset}
                              onChange={(value) =>
                                handleExtraHueGroupManualSliderChange(group.id, {
                                  chromaScale: value / 100,
                                })
                              }
                            />
                          </div>
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
                              className={`btn-secondary hue-add-btn${isAdded ? " is-added" : ""}`}
                              disabled={isAdded}
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

              {/* Footer */}
              <div className="footer">
                <span className="footer-status">{status}</span>
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
                <button className="btn-ghost icon-btn" onClick={handleReset} title="Reset" aria-label="Reset">
                  ↺
                </button>
              </div>
            </>
          )}

          {tab === "theme" && (
            <>
              <div className="mode-shell theme-shell">

                {/* ── Compact header ── */}
                <div className="theme-header">
                  <div className="theme-header-top">
                    <div className="mode-toggle-row">
                      {([
                        ["auto", "Auto"],
                        ["light", "→ Light"],
                        ["dark", "→ Dark"],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          className={`mode-toggle ${themeSwitcherSettings.direction === value ? "is-active" : ""}`}
                          onClick={() => updateThemeSettings({ direction: value })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="theme-info-chips">
                      <span className="summary-chip is-accent">
                        {MATERIAL_SCHEME_VARIANTS.find((v) => v.value === themeSwitcherSettings.schemeVariant)?.label ??
                          themeSwitcherSettings.schemeVariant}
                      </span>
                      <span className="summary-chip">
                        Contrast {formatContrastLevel(themeSwitcherSettings.contrastLevel)}
                      </span>
                      {themeStats && (
                        <>
                          <span className="summary-chip">
                            {themeStats.sourceTheme === "unknown" ? "src unknown" : `${themeStats.sourceTheme} src`}
                          </span>
                          <span className="summary-chip">
                            {themeStats.neutralCount}n · {themeStats.chromaticCount}c · {themeStats.textCount}t
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Scheme preview ── */}
                <div className="mode-card theme-preview-card-full">
                  <div className="mode-card-head">
                    <strong>Scheme preview</strong>
                    <span>Source → target Material role swatches for the selected variant.</span>
                  </div>
                  {themeSchemePreview ? (
                    <MaterialSchemePreview preview={themeSchemePreview} />
                  ) : (
                    <p className="muted">Select a frame to build a Material scheme preview.</p>
                  )}
                </div>

                {/* ── Settings grid (2 columns) ── */}
                <div className="mode-grid theme-settings-grid">
                  <div className="mode-card">
                    <div className="mode-card-head">
                      <strong>Variant & contrast</strong>
                      <span>Scheme personality and dynamic contrast curve.</span>
                    </div>
                    <div className="tool-panel-body">
                      <SelectField
                        label="Variant"
                        value={themeSwitcherSettings.schemeVariant}
                        onChange={(value) =>
                          updateThemeSettings({ schemeVariant: value as MaterialSchemeVariant })
                        }
                        options={MATERIAL_SCHEME_VARIANTS.map((variant) => ({
                          value: variant.value,
                          label: variant.label,
                        }))}
                      />
                      <div className="theme-preset-row">
                        {MATERIAL_CONTRAST_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            className={`chip ${themeContrastPreset === preset.id ? "is-active" : ""}`}
                            onClick={() => applyThemeContrastPreset(preset.id)}
                            title={preset.description}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      <RangeField
                        label="Contrast level"
                        min={-100}
                        max={100}
                        step={1}
                        value={Math.round(themeSwitcherSettings.contrastLevel * 100)}
                        display={formatContrastLevel(themeSwitcherSettings.contrastLevel)}
                        onChange={(value) => updateThemeSettings({ contrastLevel: value / 100 })}
                      />
                      <p className="tool-panel-note">
                        {MATERIAL_SCHEME_VARIANTS.find(
                          (v) => v.value === themeSwitcherSettings.schemeVariant,
                        )?.description}
                      </p>
                    </div>
                  </div>

                  <div className="mode-card">
                    <div className="mode-card-head">
                      <strong>Surface handling</strong>
                      <span>How neutral planes, shadows and strokes flip during inversion.</span>
                    </div>
                    <div className="tool-panel-body">
                      <RangeField
                        label="Neutral threshold"
                        min={0}
                        max={40}
                        step={1}
                        value={Math.round(themeSwitcherSettings.saturationThreshold * 100)}
                        display={`${Math.round(themeSwitcherSettings.saturationThreshold * 100)}%`}
                        onChange={(value) => updateThemeSettings({ saturationThreshold: value / 100 })}
                      />
                      <ToggleCheck
                        label="Neutralize tinted surfaces"
                        checked={themeSwitcherSettings.killColorCast}
                        appearance="switch"
                        onChange={(killColorCast) => updateThemeSettings({ killColorCast })}
                      />
                      <ToggleCheck
                        label="Invert shadows"
                        checked={themeSwitcherSettings.invertShadows}
                        appearance="switch"
                        onChange={(invertShadows) => updateThemeSettings({ invertShadows })}
                      />
                      <ToggleCheck
                        label="Swap fills / strokes"
                        checked={themeSwitcherSettings.swapFillsAndStrokes}
                        appearance="switch"
                        onChange={(swapFillsAndStrokes) =>
                          updateThemeSettings({ swapFillsAndStrokes })
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="footer">
                <span className="footer-status">{status}</span>
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
                  onClick={() => setThemeSwitcherSettings(DEFAULT_THEME_SWITCHER_SETTINGS)}
                  title="Reset theme settings"
                  aria-label="Reset theme settings"
                >
                  ↺
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => postMsg({ type: "preview-theme", settings: themeSwitcherSettings })}
                  title="Apply theme preview to Figma"
                >
                  ▶ Apply
                </button>
                <button className="btn-primary" onClick={populatePaletteFromTheme}>
                  <span className="btn-icon">
                    <IconArrowRight />
                  </span>
                  <span>To Palette</span>
                </button>
              </div>
            </>
          )}

          {/* ── PALETTE TAB ── */}
          {tab === "palette" && (
            <>
              <div className="mode-shell palette-shell">

                {/* ── Compact palette header ── */}
                <div className="palette-header">
                  <div className="palette-header-stats">
                    <span className="summary-chip">{matrixFamilyIds.length} columns</span>
                    <span className="summary-chip">{matrixSteps.length} steps</span>
                    <span className="summary-chip">{filledCount} filled</span>
                    {missingCount > 0 && <span className="summary-chip">{missingCount} missing</span>}
                    {selectedMatrixPrimaryFamilyName ? (
                      <span className="summary-chip is-accent">Base: {selectedMatrixPrimaryFamilyName}</span>
                    ) : null}
                  </div>
                </div>

                <div className="mode-grid palette-control-grid">
                  <div className="mode-card">
                    <div className="mode-card-head">
                      <strong>Grouping</strong>
                      <span>Control how colors collapse into matrix columns and rows.</span>
                    </div>
                    <div className="tool-panel-body">
                      <ToggleCheck
                        label="Ignore neutrals"
                        checked={ignoreNeutrals}
                        onChange={setIgnoreNeutrals}
                      />
                      <RangeField
                        label="Family tolerance"
                        min={0}
                        max={200}
                        step={1}
                        value={paletteFamilyTolerance}
                        display={`${paletteFamilyTolerance}%`}
                        onChange={setPaletteFamilyTolerance}
                      />
                      <ToggleCheck
                        label="Collapse by tone"
                        checked={collapseByLightness}
                        onChange={setCollapseByLightness}
                      />
                      <RangeField
                        label="Tone tolerance"
                        min={0}
                        max={100}
                        step={1}
                        value={lightnessCollapseTolerance}
                        display={`${lightnessCollapseTolerance}%`}
                        disabled={!collapseByLightness}
                        onChange={setLightnessCollapseTolerance}
                      />
                    </div>
                  </div>

                  <div className="mode-card">
                    <div className="mode-card-head">
                      <strong>Material harmonize</strong>
                      <span>Use Material only as an optional layer around the matrix, not instead of it.</span>
                    </div>
                    <div className="tool-panel-body">
                      <ToggleCheck
                        label="≈ Harmonize"
                        checked={paletteHarmonized}
                        onChange={setPaletteHarmonized}
                      />
                      <SelectField
                        label="Variant"
                        value={paletteSchemeVariant}
                        onChange={(value) => setPaletteSchemeVariant(value as MaterialSchemeVariant)}
                        options={MATERIAL_SCHEME_VARIANTS.map((variant) => ({
                          value: variant.value,
                          label: variant.label,
                        }))}
                      />
                      <div className="theme-preset-row">
                        {MATERIAL_CONTRAST_PRESETS.map((preset) => (
                          <button
                            key={`palette-${preset.id}`}
                            className={`chip ${paletteContrastPreset === preset.id ? "is-active" : ""}`}
                            onClick={() => applyPaletteContrastPreset(preset.id)}
                            title={preset.description}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                      <RangeField
                        label="Contrast level"
                        min={-100}
                        max={100}
                        step={1}
                        value={Math.round(paletteContrastLevel * 100)}
                        display={formatContrastLevel(paletteContrastLevel)}
                        onChange={(value) => setPaletteContrastLevel(value / 100)}
                      />
                      <RangeField
                        label="Harmonize strength"
                        min={0}
                        max={100}
                        step={1}
                        value={paletteHarmonizeStrength}
                        display={`${paletteHarmonizeStrength}%`}
                        onChange={setPaletteHarmonizeStrength}
                      />
                      <p className="tool-panel-note">
                        {selectedMatrixPrimaryFamilyName
                          ? `Base column: ${selectedMatrixPrimaryFamilyName}. Its colors are used as the Material harmonization seed.`
                          : "Click any chromatic column header in the matrix to choose the seed family for harmonization."}
                      </p>
                    </div>
                  </div>

                  <div className="mode-card">
                    <div className="mode-card-head">
                      <strong>Accessibility</strong>
                      <span>Track APCA pressure while you refine the matrix.</span>
                    </div>
                    <div className="tool-panel-body">
                      <ToggleCheck
                        label="APCA"
                        checked={paletteApcaEnabled}
                        onChange={setPaletteApcaEnabled}
                      />
                      <RangeField
                        label="APCA target"
                        min={30}
                        max={90}
                        step={1}
                        value={paletteApcaTargetLc}
                        display={`Lc ${paletteApcaTargetLc}`}
                        disabled={!paletteApcaEnabled}
                        onChange={setPaletteApcaTargetLc}
                      />
                      <RangeField
                        label="APCA influence"
                        min={0}
                        max={100}
                        step={1}
                        value={paletteApcaInfluence}
                        display={`${paletteApcaInfluence}%`}
                        disabled={!paletteApcaEnabled}
                        onChange={setPaletteApcaInfluence}
                      />
                      {paletteApcaEnabled ? (
                        <div className="apca-panel">
                          {!paletteHarmonized ? (
                            <p className="muted">APCA adjustments apply when Harmonize is enabled.</p>
                          ) : null}
                          <div className="stat-row apca-stats">
                            <span>Avg Lc {Math.round(paletteApcaSummary.averageBefore)} → {Math.round(paletteApcaSummary.averageAfter)}</span>
                            <span>{paletteApcaSummary.counts.pass} pass</span>
                            <span>{paletteApcaSummary.counts.improved} improved</span>
                            <span>{paletteApcaSummary.counts.watch} watch</span>
                            <span>{paletteApcaSummary.counts.fail} fail</span>
                          </div>
                          {paletteApcaSummary.references.length > 0 ? (
                            <div className="apca-reference-row">
                              {paletteApcaSummary.references.map((reference) => (
                                <div key={reference.key} className="apca-reference-chip">
                                  <span
                                    className="token-swatch"
                                    style={{ background: rgbToCss(reference.rgb) }}
                                  />
                                  <span>{reference.role === "neutral" ? "Neutral" : reference.hex}</span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="matrix-panel">
                  <div className="matrix-panel-head">
                    <span className="matrix-panel-hint">Click a chromatic column header to set the seed.</span>
                    <div className="matrix-toolbar-actions">
                      <ToggleCheck
                        label="Preserve"
                        checked={preserveManual}
                        onChange={setPreserveManual}
                      />
                      <button className="btn-ghost" onClick={handleResetMatrix}>Reset</button>
                      <button className="btn-ghost" onClick={handleAutoFill}>Auto-fill</button>
                    </div>
                  </div>
                  {matrixFamilyIds.length === 0 ? (
                    <p className="muted">No families detected. Adjust settings and rescan.</p>
                  ) : (
                    <PaletteMatrixGrid
                      familyIds={matrixFamilyIds}
                      families={matrixFamilies}
                      steps={matrixSteps}
                      familyNames={matrixFamilyNames}
                      matrix={matrix}
                      primaryFamilyId={selectedMatrixPrimaryFamilyId}
                      onSelectFamily={handleSelectPrimaryPaletteFamily}
                      selectedCellKey={selectedCellKey}
                      onSelectCell={setSelectedCellKey}
                      onAddCell={handleAddCell}
                    />
                  )}
                </div>

                {selectedCell && selectedCellKey ? (
                  <div className="editor-panel">
                    <div className="mode-card-head">
                      <strong>{selectedCell.familyName} / {selectedCell.step}</strong>
                      <span>Fine-tune the selected matrix cell without leaving the grid context.</span>
                    </div>
                    <CellEditor
                      cell={selectedCell}
                      onUpdate={(updated) => handleUpdateCell(selectedCellKey, updated)}
                    />
                  </div>
                ) : null}
              </div>

              {/* Footer */}
              <div className="footer">
                <span className="footer-status">{status}</span>
                <button className="btn-primary" onClick={() => setTab("export")}>
                  ⇢ To Export
                </button>
              </div>
            </>
          )}

          {/* ── EXPORT TAB ── */}
          {tab === "export" && (
            <>
              {/* Summary */}
              <Section label="Summary">
                <div className="stat-row">
                  <span>{matrixFamilyIds.length} families</span>
                  <span>{filledCount} filled</span>
                  <span>{missingCount} missing</span>
                </div>
              </Section>

              {/* Token preview */}
              <Section label="Token preview">
                <div className="token-list">
                  {exportTokens.slice(0, 40).map(t => (
                    <div key={t.name} className="token-row">
                      <span className="token-swatch" style={{ background: rgbToCss(t.rgb) }} />
                      <div className="token-copy">
                        <span className="token-name">{t.name}</span>
                        <span className="token-meta">
                          {t.semanticRole ? <span className="token-role">{t.semanticRole}</span> : null}
                          <span className="token-hex">{t.hex}</span>
                          <span className="token-hct">{hctToCss(t.oklch)}</span>
                        </span>
                      </div>
                    </div>
                  ))}
                  {exportTokens.length > 40 && (
                    <div className="muted">… and {exportTokens.length - 40} more</div>
                  )}
                  {exportTokens.length === 0 && (
                    <div className="muted">No tokens. Add cells to the palette matrix.</div>
                  )}
                </div>
              </Section>

              {/* Component preview */}
              <Section label="Component preview">
                <ComponentPreview tokens={exportTokens} families={matrixFamilyIds} />
              </Section>

              {/* Export settings */}
              <Section label="Export settings">
                <div className="radio-group">
                  {(["variables", "styles", "json"] as ExportFormat[]).map(f => (
                    <label key={f} className="radio-row">
                      <input
                        type="radio"
                        name="format"
                        value={f}
                        checked={exportFormat === f}
                        onChange={() => setExportFormat(f)}
                      />
                      <span>{f === "variables" ? "Variables" : f === "styles" ? "Local Styles" : "JSON"}</span>
                    </label>
                  ))}
                </div>
                <CheckRow label="Skip missing steps" checked={skipMissing} onChange={setSkipMissing} />
              </Section>

              {/* Footer */}
              <div className="footer">
                <span className="footer-status">{status}</span>
                <button className="btn-ghost" onClick={() => setTab("palette")}>← Back</button>
                <button className="btn-ghost" onClick={handleCopyJson}>Copy JSON</button>
                <button className="btn-primary" onClick={handleExport}>Export palette</button>
              </div>
            </>
          )}

        </div>
      )}
      <div className="window-resizer" onMouseDown={handleResizeDragStart} title="Resize window" />
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="section">
      {label ? <div className="section-label">{label}</div> : null}
      {children}
    </div>
  );
}

function MaterialSchemePreview({
  preview,
}: {
  preview: {
    variantLabel: string;
    targetDirection: "light" | "dark";
    contrastPreset: MaterialContrastPresetId;
    swatches: Array<{
      label: string;
      source: { rgb: AnalysisColor["rgb"] };
      sourceText: { rgb: AnalysisColor["rgb"] };
      target: { rgb: AnalysisColor["rgb"] };
      targetText: { rgb: AnalysisColor["rgb"] };
    }>;
  };
}) {
  return (
    <div className="material-preview">
      <div className="material-preview-meta">
        <span>{preview.variantLabel}</span>
        <span>{preview.targetDirection === "dark" ? "Target dark" : "Target light"}</span>
        <span>{preview.contrastPreset}</span>
      </div>
      <div className="material-preview-columns">
        <div className="material-preview-column">
          <span className="material-preview-heading">Source</span>
          {preview.swatches.map((swatch) => (
            <div
              key={`source-${swatch.label}`}
              className="material-preview-swatch"
              style={{
                background: rgbToCss(swatch.source.rgb),
                color: rgbToCss(swatch.sourceText.rgb),
              }}
            >
              <span>{swatch.label}</span>
            </div>
          ))}
        </div>
        <div className="material-preview-column">
          <span className="material-preview-heading">Target</span>
          {preview.swatches.map((swatch) => (
            <div
              key={`target-${swatch.label}`}
              className="material-preview-swatch"
              style={{
                background: rgbToCss(swatch.target.rgb),
                color: rgbToCss(swatch.targetText.rgb),
              }}
            >
              <span>{swatch.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── PaletteMatrixGrid ────────────────────────────────────────────────────────

function PaletteMatrixGrid({
  familyIds,
  families,
  steps,
  familyNames,
  matrix,
  primaryFamilyId,
  onSelectFamily,
  selectedCellKey,
  onSelectCell,
  onAddCell,
}: {
  familyIds: string[];
  families: FamilySummary[];
  steps: number[];
  familyNames: Record<string, string>;
  matrix: PaletteMatrix;
  primaryFamilyId: string | null;
  onSelectFamily: (familyId: string) => void;
  selectedCellKey: string | null;
  onSelectCell: (key: string) => void;
  onAddCell: (key: string, familyId: string, step: number) => void;
}) {
  const gridTemplateColumns = `40px repeat(${familyIds.length}, minmax(56px, 1fr))`;
  const familyById = useMemo(
    () => new Map(families.map((family) => [family.id, family])),
    [families],
  );

  return (
    <div className="matrix-scroll">
      <div
        className="matrix-grid"
        style={{ gridTemplateColumns }}
        >
        <div className="matrix-corner" />
        {familyIds.map((id) => (
          <button
            key={id}
            className={`matrix-family-head${primaryFamilyId === id ? " is-primary" : ""}${familyById.get(id)?.type === "chromatic" ? " is-clickable" : ""}`}
            onClick={() => onSelectFamily(id)}
            type="button"
            title={
              familyById.get(id)?.type === "chromatic"
                ? `${familyNames[id]} is the harmony base`
                : familyNames[id]
            }
          >
            <span>{familyNames[id]}</span>
            {familyById.get(id)?.semanticRole ? (
              <span className="matrix-family-role">{familyById.get(id)!.semanticRole}</span>
            ) : null}
            {primaryFamilyId === id ? <span className="matrix-family-badge">Base</span> : null}
          </button>
        ))}

        {steps.map((step) => (
          <Fragment key={step}>
            <div className="matrix-step-cell">{step}</div>
            {familyIds.map((fId) => {
              const key = `${fId}-${step}`;
              const cell = matrix[key];
              const isSelected = selectedCellKey === key;
              if (cell?.color) {
                return (
                  <button
                    key={key}
                    type="button"
                    className={`matrix-cell filled${isSelected ? " selected" : ""}`}
                    onClick={() => onSelectCell(key)}
                    aria-pressed={isSelected}
                    aria-label={`${familyNames[fId] ?? fId} step ${step} — ${cell.color.hex}`}
                    title={cell.color.hex}
                  >
                    <span
                      className="cell-swatch"
                      style={{ background: rgbToCss(cell.color.rgb) }}
                    />
                  </button>
                );
              }

              return (
                <button
                  key={key}
                  type="button"
                  className="matrix-cell empty"
                  onClick={() => onAddCell(key, fId, step)}
                  aria-label={`Add ${familyNames[fId] ?? fId} step ${step}`}
                  title={`Add ${familyNames[fId]} ${step}`}
                >
                  <span className="add-btn">+</span>
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ─── CellEditor ───────────────────────────────────────────────────────────────

function CellEditor({
  cell,
  onUpdate,
}: {
  cell: MatrixCell;
  onUpdate: (updated: MatrixCell) => void;
}) {
  const [hueOff, setHueOff] = useState(0);
  const [chromaAdj, setChromaAdj] = useState(0);
  const [lightAdj, setLightAdj] = useState(0);

  useEffect(() => {
    setHueOff(0);
    setChromaAdj(0);
    setLightAdj(0);
  }, [cell.familyId, cell.step]);

  const base = cell.color;

  const modOklch = base ? {
    l: clamp01(base.oklch.l + lightAdj / 100),
    c: Math.max(0, base.oklch.c + chromaAdj / 100),
    h: normalizeHue(base.oklch.h + hueOff),
    alpha: 1,
  } : null;

  const modRgb = modOklch ? oklchToRgb(modOklch, { clampToGamut: true }) : null;
  const modHex = modRgb ? rgbToHex(modRgb) : null;

  const applyEdit = () => {
    if (!modRgb || !modOklch || !modHex) return;
    onUpdate({ ...cell, color: { rgb: modRgb, hex: modHex, oklch: modOklch } });
    setHueOff(0); setChromaAdj(0); setLightAdj(0);
  };

  if (!base) {
    return <p className="muted">No color set for this cell.</p>;
  }

  return (
    <div className="cell-editor">
      <div className="cell-editor-preview">
        <span className="preview-swatch" style={{ background: rgbToCss(base.rgb) }} />
        <span className="arrow">→</span>
        <span className="preview-swatch" style={{ background: modRgb ? rgbToCss(modRgb) : "transparent" }} />
        <span className="preview-hex">{modHex}</span>
        {cell.semanticRole ? <span className="token-role">{cell.semanticRole}</span> : null}
      </div>
      <RangeField label="Hue offset" min={-180} max={180} step={1}
        value={hueOff} display={fmt(hueOff, "°")} onChange={setHueOff} />
      <RangeField label="Chroma" min={-50} max={50} step={1}
        value={chromaAdj} display={fmt(chromaAdj)} onChange={setChromaAdj} />
      <RangeField label="Tone" min={-50} max={50} step={1}
        value={lightAdj} display={fmt(lightAdj)} onChange={setLightAdj} />
      <div className="cell-editor-row">
        <button className="btn-primary sm" onClick={applyEdit}>Apply</button>
        <CheckRow
          label="Lock"
          checked={cell.isLocked}
          onChange={v => onUpdate({ ...cell, isLocked: v })}
          inline
        />
        <CheckRow
          label="Export"
          checked={cell.useInExport}
          onChange={v => onUpdate({ ...cell, useInExport: v })}
          inline
        />
      </div>
    </div>
  );
}

// ─── ComponentPreview ─────────────────────────────────────────────────────────

function ComponentPreview({ tokens, families }: { tokens: PaletteToken[]; families: string[] }) {
  const tokenByFamilyAndStep = useMemo(
    () => new Map(tokens.map((token) => [`${token.familyId}:${token.step}`, token])),
    [tokens],
  );
  const find = (familyId: string, step: number) =>
    tokenByFamilyAndStep.get(`${familyId}:${step}`);

  const neutralId = families.find((familyId) => isNeutralFamilyId(familyId)) ?? families[0] ?? "surface";
  const accentFamilyIds = families.filter((familyId) => !isNeutralFamilyId(familyId));
  const accentId = families.find((familyId) => familyId === "primary") ?? accentFamilyIds[0] ?? families[0] ?? "primary";
  const accent2Id =
    families.find((familyId) => familyId === "secondary") ??
    families.find((familyId) => familyId === "tertiary") ??
    accentFamilyIds[1] ??
    accentFamilyIds[0] ??
    accentId;
  const hasSecondAccent = accentFamilyIds.length > 1;

  const bg = find(neutralId, 0);
  const ink = find(neutralId, 900);
  const primary = find(accentId, 500);
  const primaryHover = find(accentId, 700);
  const secondary = find(accent2Id, 400) ?? find(accent2Id, 500);
  const secondarySoft = find(accent2Id, 100) ?? find(accent2Id, 200) ?? secondary;

  const style: CSSProperties = {
    "--cp-bg": bg ? rgbToCss(bg.rgb) : "#f8f8f8",
    "--cp-ink": ink ? rgbToCss(ink.rgb) : "#111",
    "--cp-primary": primary ? rgbToCss(primary.rgb) : "#3060f0",
    "--cp-primary-hover": primaryHover ? rgbToCss(primaryHover.rgb) : "#1a3ccc",
    "--cp-secondary": secondary ? rgbToCss(secondary.rgb) : "#0f8a6c",
    "--cp-secondary-soft": secondarySoft ? rgbToCss(secondarySoft.rgb) : "rgba(15, 138, 108, 0.14)",
  } as CSSProperties;

  return (
    <div className="cp-wrap" style={style}>
      <div className="cp-card">
        <div className="cp-chip-row">
          <span className="cp-chip cp-chip-primary">Accent 1</span>
          <span className="cp-chip cp-chip-secondary">
            {hasSecondAccent ? "Accent 2" : "Accent 2 (fallback)"}
          </span>
        </div>
        <button className="cp-btn-primary">Primary action</button>
        <button className="cp-btn-secondary">Secondary accent</button>
        <div className="cp-input">Input field</div>
        <div className="cp-surface">
          <div className="cp-surface-title">Card surface</div>
          <div className="cp-surface-copy">
            Primary CTA uses the first accent family, while supporting actions and highlights use the second.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RangeField ───────────────────────────────────────────────────────────────

function RangeField({
  label,
  min,
  max,
  step,
  value,
  display,
  variant,
  accessory,
  disabled,
  softDisabled,
  className,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  variant?: "default" | "hue";
  accessory?: ReactNode;
  disabled?: boolean;
  softDisabled?: boolean;
  className?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div
      className={`range-field${softDisabled ? " is-soft-disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <div className="range-head">
        <span>{label}</span>
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
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// ─── CheckRow ─────────────────────────────────────────────────────────────────

function CheckRow({
  label,
  checked,
  onChange,
  inline,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  inline?: boolean;
}) {
  return (
    <label className={`check-row${inline ? " inline" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function ToggleCheck({
  label,
  checked,
  appearance,
  controlSide,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  appearance?: "check" | "switch";
  controlSide?: "left" | "right";
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`toggle-check${appearance === "switch" ? " is-switch" : ""}${controlSide === "right" ? " is-right" : ""}`}
    >
      {controlSide === "right" ? <span>{label}</span> : null}
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {appearance === "switch" ? <span className="toggle-switch-ui" aria-hidden="true" /> : null}
      {controlSide === "right" ? null : <span>{label}</span>}
    </label>
  );
}

function SelectField({
  label,
  ariaLabel,
  value,
  options,
  onChange,
}: {
  label?: string;
  ariaLabel?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`select-field${label ? "" : " is-compact"}`}>
      {label ? <span>{label}</span> : null}
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function IconCompareArrows() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.83 8H20v2H7.83l3.58 3.59L10 15l-6-6 6-6 1.41 1.41L7.83 8zm8.34 6H4v2h12.17l-3.58 3.59L14 21l6-6-6-6-1.41 1.41L16.17 14z" />
    </svg>
  );
}

function IconMinus() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 11h14v2H5z" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h11.17l-4.58-4.59L13 6l7 7-7 7-1.41-1.41L16.17 14H5v-2z" />
    </svg>
  );
}

export default App;
