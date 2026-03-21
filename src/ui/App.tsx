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
  buildExploreMapping,
  DEFAULT_EXPLORE_SETTINGS,
} from "../shared/explore";
import type { PluginToUiMessage, UiToPluginMessage } from "../shared/messages";
import type {
  ColorMappingEntry,
  ExploreSettings,
  SelectionAnalysisSummary,
} from "../shared/types";
import {
  buildColorRoleIndex,
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

type HueScopeId = "all" | string | null;
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
  baseHue: number | null;
  linkMode: ExtraHueGroupLinkMode;
  hueShift: number;
  exposure: number;
  contrast: number;
  chromaScale: number;
};

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
    ...createHueOnlySettings(base, hueShift),
    exposure,
    contrast,
    chromaScale,
  };
}

function absoluteHueToSigned(value: number): number {
  return normalizeSignedHueShift(normalizeHue(value));
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
          reason: "Tint aligned to main hue",
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

function collectScopeKeys(
  scopeId: HueScopeId,
  allColorKeys: ReadonlySet<string>,
  frameGroupById: ReadonlyMap<string, FrameGroup>,
  excludedKeys?: ReadonlySet<string>,
): Set<string> {
  const baseKeys =
    scopeId === "all" || scopeId === null
      ? new Set(allColorKeys)
      : new Set(frameGroupById.get(scopeId)?.memberKeys ?? []);

  if (!excludedKeys || excludedKeys.size === 0) {
    return baseKeys;
  }

  for (const key of excludedKeys) {
    baseKeys.delete(key);
  }
  return baseKeys;
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

function createNeutralExtraHueGroup(primaryHueShift: number): ExtraHueGroup {
  return {
    id: "neutral-fixed-group",
    scopeId: "neutral",
    baseHue: null,
    linkMode: "manual",
    hueShift: absoluteHueToSigned(primaryHueShift),
    exposure: 0,
    contrast: 0,
    chromaScale: 1,
  };
}

function App() {
  const [analysis, setAnalysis] = useState<SelectionAnalysisSummary | null>(null);
  const [status, setStatus] = useState("Reading current selection…");
  const [settings, setSettings] = useState<ExploreSettings>(DEFAULT_EXPLORE_SETTINGS);
  const [primaryHueScope, setPrimaryHueScope] = useState<HueScopeId>("all");
  const [primaryTintEnabled, setPrimaryTintEnabled] = useState(false);
  const [extraHueGroups, setExtraHueGroups] = useState<ExtraHueGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({
    "neutral-fixed-group": true,
  });
  const [uiWidth, setUiWidth] = useState(DEFAULT_UI_WIDTH);
  const [pluginFocused, setPluginFocused] = useState(true);

  const shellRef = useRef<HTMLDivElement>(null);
  const lastMappingRef = useRef<ColorMappingEntry[]>([]);
  const pluginFocusedRef = useRef(true);

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
            setPrimaryTintEnabled(false);
            setExtraHueGroups([]);
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
      const nextWidth = uiWidth;
      const nextHeight = Math.ceil(shell.scrollHeight);
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
  const primaryHueSettings = useMemo(
    () => createPrimaryScopeSettings(effectiveExploreSettings, settings.hueShift),
    [effectiveExploreSettings, settings.hueShift],
  );

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

    const primaryColors = sourceColors.filter((color) => primaryHueKeys.has(color.key));
    const primaryHueBaseMapping =
      primaryColors.length > 0
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
        const isNeutralScope = group.scopeId === "neutral";
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
          resolveExtraHueGroupRelativeShift(effectiveGroup, settings.hueShift),
          effectiveGroup.exposure,
          effectiveGroup.chromaScale,
          isNeutralScope ? effectiveGroup.contrast : 0,
        );

        const groupMapping = buildExploreMapping(groupColors, groupSettings, exploreRoleByKey);
        const neutralLiftedMapping = isNeutralScope
          ? applyNeutralChromaFloor(
              groupMapping,
              effectiveGroup.hueShift,
              effectiveExploreSettings.neutralThreshold,
              effectiveGroup.chromaScale,
            )
          : groupMapping;
        const shouldTintNeutralScope =
          isNeutralScope &&
          (group.linkMode !== "manual" ||
            Math.abs(normalizeSignedHueShift(effectiveGroup.hueShift)) > 0.001 ||
            effectiveGroup.chromaScale > 1.001);

        return {
          ...combined,
          ...(shouldTintNeutralScope
            ? applyTintMapping(
                neutralLiftedMapping,
                effectiveGroup.hueShift,
                effectiveExploreSettings.neutralThreshold,
                true,
              )
            : neutralLiftedMapping),
        };
      },
      {},
    );

    return sourceColors.map((color) => {
      const identity = originalIdentityByKey.get(color.key) ?? createIdentityMappingEntry(color);
      return extraHueMapping[color.key] ?? primaryHueMapping[color.key] ?? identity;
    });
  }, [
    allColorKeys,
    deferredAnalysis,
    effectiveExploreSettings,
    exploreRoleByKey,
    extraHueGroups,
    frameGroupById,
    primaryHueScope,
    primaryHueSettings,
    primaryTintEnabled,
    settings.hueShift,
  ]);

  useEffect(() => {
    setExtraHueGroups((current) =>
      current.filter((group) => frameGroupById.has(group.scopeId)),
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
        ? { ...existingNeutral, id: "neutral-fixed-group", scopeId: "neutral", baseHue: null }
        : createNeutralExtraHueGroup(settings.hueShift);
      return [nextNeutral, ...withoutNeutral];
    });
  }, [neutralGroup, settings.hueShift]);

  useEffect(() => {
    lastMappingRef.current = demoEntries;
    if (!pluginFocused || !deferredAnalysis || demoEntries.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      postMsg({ type: "preview-colors", mapping: demoEntries });
    }, 60);

    return () => window.clearTimeout(timeoutId);
  }, [deferredAnalysis, demoEntries, pluginFocused]);

  const handleReset = () => {
    setPrimaryHueScope("all");
    setPrimaryTintEnabled(false);
    setExtraHueGroups([]);
    setSettings(DEFAULT_EXPLORE_SETTINGS);
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

  const handleHueScopeChange = (nextScope: HueScopeId) => {
    if (nextScope === "all") {
      setPrimaryHueScope("all");
      return;
    }
    setPrimaryHueScope((current) => (current === nextScope ? "all" : nextScope));
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
          contrast: 0,
          chromaScale: 1,
        },
      ];
    });
    setPrimaryHueScope((current) => (current === scopeId ? "all" : current));
  };

  const handleRemoveExtraHueGroup = (id: string) => {
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
      {!analysis ? (
        <div className="empty">
          <p>Select a frame or layers with fills, strokes, or text colors to analyze them.</p>
          <button className="btn-secondary" onClick={() => postMsg({ type: "scan-selection" })}>
            Rescan
          </button>
        </div>
      ) : (
        <div className="content">
          <Section>
            <div className="control-stack">
              <div
                className={`main-controls hue-group-card main-controls-card${allChromaticGroupsSeparated ? " main-controls-disabled" : ""}`}
              >
                <div className="hue-group-header main-controls-header">
                  <div className="group-toggle group-toggle-static">
                    <div className="hue-group-copy">
                      <strong>All colors</strong>
                    </div>
                  </div>
                  <div className="toggle-row main-toggle-row">
                    <ToggleCheck
                      label="Tint"
                      checked={primaryTintEnabled}
                      disabled={allChromaticGroupsSeparated}
                      onChange={setPrimaryTintEnabled}
                    />
                  </div>
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
                    disabled={allChromaticGroupsSeparated}
                    onChange={(value) => setSettings((current) => ({ ...current, hueShift: value }))}
                  />
                  <div className="button-row compact hue-quick-row">
                    {(["-30", "+30", "comp", "analog"] as const).map((preset) => (
                      <button
                        key={`primary-${preset}`}
                        className="btn-ghost"
                        disabled={allChromaticGroupsSeparated}
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
                  disabled={allChromaticGroupsSeparated}
                  onChange={(value) => setSettings((current) => ({ ...current, exposure: value }))}
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
                  disabled={allChromaticGroupsSeparated}
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

                    const effectiveGroup = resolveEffectiveExtraHueGroup(group, settings.hueShift);
                    const isLinkedPreset = group.linkMode !== "manual";
                    const effectiveHueShift = effectiveGroup.hueShift;
                    const effectiveGroupHue = normalizeHue(effectiveHueShift);
                    const hasAccentSurface = group.scopeId !== "neutral";
                    const groupStyle = {
                      "--group-accent": hasAccentSurface
                        ? `hsl(${effectiveGroupHue} 86% 58%)`
                        : "transparent",
                    } as CSSProperties;

                    return (
                      <div
                        key={group.id}
                        className={`hue-group-card${hasAccentSurface ? "" : " is-neutral-card"}`}
                        style={groupStyle}
                      >
                        <div className="hue-group-header">
                          <button
                            className="group-toggle"
                            type="button"
                            onClick={() => toggleGroupCollapsed(group.id)}
                            aria-expanded={!collapsedGroups[group.id]}
                          >
                            <div className="hue-group-copy">
                              <strong>
                                {scope.name}{" "}
                                <span className="hue-group-count">{scope.memberKeys.length}</span>
                              </strong>
                            </div>
                          </button>
                          <div className="hue-group-actions">
                            {group.scopeId !== "neutral" ? (
                              <button
                                className="btn-ghost icon-btn"
                                title={`Remove ${scope.name}`}
                                aria-label={`Remove ${scope.name}`}
                                onClick={() => handleRemoveExtraHueGroup(group.id)}
                              >
                                <IconMinus />
                              </button>
                            ) : null}
                          </div>
                          <button
                            className="group-chevron-btn icon-btn icon-btn-plain"
                            type="button"
                            onClick={() => toggleGroupCollapsed(group.id)}
                            aria-label={collapsedGroups[group.id] ? `Expand ${scope.name}` : `Collapse ${scope.name}`}
                            aria-expanded={!collapsedGroups[group.id]}
                          >
                            <span className={`group-chevron${collapsedGroups[group.id] ? " is-collapsed" : ""}`}>
                              <IconChevronDown />
                            </span>
                          </button>
                        </div>
                        {!collapsedGroups[group.id] ? (
                          <>
                            <RangeField
                              label={
                                <SelectField
                                  ariaLabel={`${scope.name} hue link mode`}
                                  value={group.linkMode}
                                  unstyled
                                  onChange={(value) =>
                                    handleExtraHueGroupLinkModeChange(
                                      group.id,
                                      value as ExtraHueGroupLinkMode,
                                    )
                                  }
                                  options={[
                                    { value: "manual", label: "Free hue" },
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
                              }
                              min={-180}
                              max={180}
                              step={1}
                              value={effectiveHueShift}
                              display={fmt(effectiveHueShift, "°")}
                              resetValue={0}
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
                              resetValue={0}
                              softDisabled={isLinkedPreset}
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
                              onChange={(value) =>
                                handleExtraHueGroupManualSliderChange(group.id, {
                                  chromaScale: value / 100,
                                })
                              }
                            />
                          </>
                        ) : null}
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
              onClick={handleReset}
              title="Reset"
              aria-label="Reset"
            >
              ↺
            </button>
          </div>
        </div>
      )}

      <div className="window-resizer" onMouseDown={handleResizeDragStart} title="Resize window" />
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
  onChange,
}: {
  label?: string;
  ariaLabel?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  unstyled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`select-field${label ? "" : " is-compact"}${unstyled ? " is-unstyled" : ""}`}>
      {label ? <span>{label}</span> : null}
      {unstyled ? (
        <span className="select-field-inline">
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
          <span className="select-field-chevron" aria-hidden="true">
            <IconChevronDown />
          </span>
        </span>
      ) : (
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
      )}
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

function IconChevronDown() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
    </svg>
  );
}

export default App;
