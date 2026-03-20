import { customColor } from "@material/material-color-utilities";
import { oklchToRgb, rgbToHex, rgbToOklch } from "./color";
import {
  assignMaterialSemanticRole,
  argbToSerialized,
  buildMaterialScheme,
  getMaterialRoleByName,
  getMaterialSchemeRoles,
  pairedTextRoleForBackground,
  pickMaterialSeed,
  serializedToArgb,
} from "./material";
import type {
  ColorMappingEntry,
  SelectionAnalysisSummary,
  SerializedColor,
  SourceKind,
  ThemeSwitcherSettings,
} from "./types";

export const DEFAULT_THEME_SWITCHER_SETTINGS: ThemeSwitcherSettings = {
  direction: "auto",
  schemeVariant: "content",
  contrastLevel: 0,
  saturationThreshold: 0.18,
  killColorCast: true,
  primaryTargetLc: 80,
  secondaryTargetLc: 50,
  invertShadows: false,
  swapFillsAndStrokes: false,
};

function resolveTargetDirection(
  summary: SelectionAnalysisSummary,
  settings: ThemeSwitcherSettings,
): "light" | "dark" {
  if (settings.direction === "light" || settings.direction === "dark") {
    return settings.direction;
  }

  return summary.themeDetection?.inferredSourceTheme === "light" ? "dark" : "light";
}

export function resolveThemeTargetDirection(
  summary: SelectionAnalysisSummary,
  settings: ThemeSwitcherSettings,
): "light" | "dark" {
  return resolveTargetDirection(summary, settings);
}

function applySurfaceTintPolicy(
  source: SerializedColor,
  resolved: SerializedColor,
  settings: ThemeSwitcherSettings,
): SerializedColor {
  if (settings.killColorCast) {
    return resolved;
  }

  const sourceHct = rgbToOklch(source);
  if (sourceHct.c > settings.saturationThreshold) {
    return resolved;
  }

  const resolvedHct = rgbToOklch(resolved);
  return oklchToRgb(
    {
      l: resolvedHct.l,
      c: sourceHct.c,
      h: sourceHct.h,
      alpha: source.a,
    },
    { clampToGamut: true },
  );
}

function resolveMaterialCustomSurface(
  rgb: SerializedColor,
  seedArgb: number,
  sourceIsDark: boolean,
  targetIsDark: boolean,
): { rgb: SerializedColor; roleName: string } {
  const group = customColor(seedArgb, {
    name: "selection",
    value: serializedToArgb(rgb),
    blend: true,
  });
  const sourceGroup = sourceIsDark ? group.dark : group.light;
  const targetGroup = targetIsDark ? group.dark : group.light;
  const sourceHct = rgbToOklch(rgb);
  const sourceCandidates = [
    {
      key: "color",
      rgb: argbToSerialized(sourceGroup.color, rgb.a),
      target: argbToSerialized(targetGroup.color, rgb.a),
    },
    {
      key: "colorContainer",
      rgb: argbToSerialized(sourceGroup.colorContainer, rgb.a),
      target: argbToSerialized(targetGroup.colorContainer, rgb.a),
    },
  ] as const;

  const winner = sourceCandidates.reduce((best, candidate) => {
    const candidateHct = rgbToOklch(candidate.rgb);
    const bestHct = rgbToOklch(best.rgb);
    const candidateScore =
      Math.abs(sourceHct.l - candidateHct.l) / 0.18 +
      Math.abs(sourceHct.c - candidateHct.c) / 0.12;
    const bestScore =
      Math.abs(sourceHct.l - bestHct.l) / 0.18 +
      Math.abs(sourceHct.c - bestHct.c) / 0.12;
    return candidateScore < bestScore ? candidate : best;
  });

  return {
    rgb: winner.target,
    roleName: winner.key === "color" ? "custom-color" : "custom-color-container",
  };
}

export interface ThemeRoleResolver {
  targetDirection: "light" | "dark";
  resolveSurface: (rgb: SerializedColor, sourceKinds: SourceKind[]) => { rgb: SerializedColor; roleName: string };
  resolveText: (background: SerializedColor) => { rgb: SerializedColor; roleName: string };
}

export function buildThemeRoleResolver(
  summary: SelectionAnalysisSummary,
  settings: ThemeSwitcherSettings = DEFAULT_THEME_SWITCHER_SETTINGS,
): ThemeRoleResolver {
  const targetDirection = resolveTargetDirection(summary, settings);
  const sourceIsDark = summary.themeDetection?.inferredSourceTheme === "dark";
  const targetIsDark = targetDirection === "dark";
  const seedArgb = pickMaterialSeed(summary.colors);
  const contrastLevel = settings.contrastLevel;
  const sourceScheme = buildMaterialScheme(
    seedArgb,
    sourceIsDark,
    contrastLevel,
    settings.schemeVariant,
  );
  const targetScheme = buildMaterialScheme(
    seedArgb,
    targetDirection === "dark",
    contrastLevel,
    settings.schemeVariant,
  );
  const sourceRoles = getMaterialSchemeRoles(sourceScheme);
  const targetRoles = getMaterialSchemeRoles(targetScheme);

  return {
    targetDirection,
    resolveSurface: (rgb, sourceKinds) => {
      const sourceHct = rgbToOklch(rgb);
      const useCustomColor =
        sourceHct.c >= settings.saturationThreshold &&
        !sourceKinds.some((kind) => kind === "effect" || kind === "text" || kind === "gradient-text");
      if (useCustomColor) {
        return resolveMaterialCustomSurface(rgb, seedArgb, sourceIsDark, targetIsDark);
      }

      const sourceRole = assignMaterialSemanticRole({ rgb, sourceKinds }, sourceRoles);
      const targetRole = getMaterialRoleByName(targetRoles, sourceRole.name) ?? sourceRole;
      return {
        rgb: applySurfaceTintPolicy(rgb, targetRole.rgb, settings),
        roleName: targetRole.name,
      };
    },
    resolveText: (background) => {
      const backgroundRole = assignMaterialSemanticRole(
        { rgb: background, sourceKinds: ["fill"] },
        targetRoles,
      );
      const targetRoleName = pairedTextRoleForBackground(backgroundRole.name);
      const targetRole = getMaterialRoleByName(targetRoles, targetRoleName) ?? backgroundRole;
      return { rgb: targetRole.rgb, roleName: targetRole.name };
    },
  };
}

export function transformThemeSurfaceRgb(
  rgb: SerializedColor,
  settings: ThemeSwitcherSettings,
  targetDirection: "light" | "dark",
  options?: { allowShadows?: boolean; sourceKinds?: SourceKind[]; summary?: SelectionAnalysisSummary },
): SerializedColor {
  if (options?.allowShadows === false) {
    return rgb;
  }
  if (!options?.summary) {
    return rgb;
  }
  const resolver = buildThemeRoleResolver(options.summary, {
    ...settings,
    direction: targetDirection,
  });
  return resolver.resolveSurface(rgb, options.sourceKinds ?? ["fill"]).rgb;
}

export function solveThemeTextColor(
  source: SerializedColor,
  background: SerializedColor,
  targetLc: number,
  summary?: SelectionAnalysisSummary,
  settings: ThemeSwitcherSettings = DEFAULT_THEME_SWITCHER_SETTINGS,
): SerializedColor {
  void source;
  void targetLc;
  if (!summary) {
    return background;
  }
  const resolver = buildThemeRoleResolver(summary, settings);
  return resolver.resolveText(background).rgb;
}

export function buildThemeSwitchMapping(
  summary: SelectionAnalysisSummary,
  settings: ThemeSwitcherSettings = DEFAULT_THEME_SWITCHER_SETTINGS,
): ColorMappingEntry[] {
  const resolver = buildThemeRoleResolver(summary, settings);

  return summary.colors.map((color) => {
    const surfaceMatch = resolver.resolveSurface(color.rgb, color.sourceKinds);
    const textTarget =
      color.theme?.kind === "text" && color.theme.textBackground
        ? resolver.resolveText(
            resolver.resolveSurface(color.theme.textBackground, ["fill"]).rgb,
          ).rgb
        : surfaceMatch.rgb;
    const target = color.theme?.kind === "text" ? textTarget : surfaceMatch.rgb;

    return {
      key: color.key,
      source: color.rgb,
      sourceHex: color.hex,
      target,
      targetHex: rgbToHex(target),
      targetOklch: rgbToOklch(target),
      role: color.role,
      semanticRole: color.theme?.kind === "text" ? undefined : surfaceMatch.roleName,
      reason:
        color.theme?.kind === "text"
          ? "MCU theme role inversion · paired on-role"
          : `MCU theme role inversion · ${surfaceMatch.roleName}`,
    } satisfies ColorMappingEntry;
  });
}
