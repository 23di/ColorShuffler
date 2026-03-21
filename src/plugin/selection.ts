import {
  averageColor,
  buildColorKey,
  classifyColorRole,
  compareByUsageThenHue,
  hslToRgb,
  rgbToHsl,
  rgbToHex,
  oklchToRgb,
  rgbToOklch,
} from "../shared/color";
import { calculateApcaContrast } from "../shared/apca";
import type {
  ColorMappingEntry,
  OklchColor,
  SelectionAnalysisSummary,
  SerializedColor,
  SourceKind,
  ThemeColorContext,
  ThemeDetectionSummary,
  ThemeTextPriority,
} from "../shared/types";

type PaintProperty = "fills" | "strokes";
type StyleIdState = string | typeof figma.mixed;

interface SolidBinding {
  kind: "solid";
  nodeId: string;
  property: PaintProperty;
  paintIndex: number;
  sourceKey: string;
}

interface GradientBinding {
  kind: "gradient";
  nodeId: string;
  property: PaintProperty;
  paintIndex: number;
  sourceKey: string;
  averageOklch: OklchColor;
}

interface TextSegmentBinding {
  kind: "text-segment-solid" | "text-segment-gradient";
  nodeId: string;
  start: number;
  end: number;
  sourceKey: string;
  averageOklch?: OklchColor;
}

interface EffectBinding {
  kind: "effect";
  nodeId: string;
  effectIndex: number;
  sourceKey: string;
}

type NodeBinding = SolidBinding | GradientBinding | TextSegmentBinding | EffectBinding;

interface TextSegmentState {
  start: number;
  end: number;
  fills: Paint[];
}

interface NodeOriginalState {
  nodeId: string;
  fills?: Paint[];
  strokes?: Paint[];
  effects?: Effect[];
  textSegments?: TextSegmentState[];
  fonts?: FontName[];
  fillStyleId?: StyleIdState;
  strokeStyleId?: StyleIdState;
  effectStyleId?: StyleIdState;
}

interface MutableNodeState extends NodeOriginalState {
  textSegmentIndex?: Map<string, TextSegmentState>;
}

interface ColorAggregate {
  rgb: SerializedColor;
  usageCount: number;
  nodeIds: Set<string>;
  sourceKinds: Set<SourceKind>;
}

interface TextContextAggregate {
  sourceKey: string;
  usageCount: number;
  contrastTotal: number;
  backgroundCounts: Map<string, { rgb: SerializedColor; count: number }>;
}

export interface SelectionAnalysisInternal {
  summary: SelectionAnalysisSummary;
  bindings: NodeBinding[];
  originalStates: Map<string, NodeOriginalState>;
  rootNodeIds: string[];
}

function clonePaints(paints: ReadonlyArray<Paint>): Paint[] {
  return JSON.parse(JSON.stringify(paints)) as Paint[];
}

function cloneEffects(effects: ReadonlyArray<Effect>): Effect[] {
  return JSON.parse(JSON.stringify(effects)) as Effect[];
}

function cloneFonts(fonts: readonly FontName[]): FontName[] {
  return fonts.map((font) => ({ ...font }));
}

function figmaColorToSerialized(
  color: RGB | RGBA,
  opacity = 1,
): SerializedColor {
  return {
    r: color.r,
    g: color.g,
    b: color.b,
    a: "a" in color ? color.a : opacity,
  };
}

function serializedToFigmaColor(color: SerializedColor): RGB {
  return { r: color.r, g: color.g, b: color.b };
}

function isGradientPaint(paint: Paint): paint is GradientPaint {
  return (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  );
}

function isSolidPaint(paint: Paint): paint is SolidPaint {
  return paint.type === "SOLID";
}

function isShadowEffect(effect: Effect): effect is DropShadowEffect | InnerShadowEffect {
  return effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW";
}

function paintVisible(paint: Paint): boolean {
  return paint.visible !== false && (paint.opacity ?? 1) > 0;
}

function sourceKindFor(
  node: SceneNode,
  property: PaintProperty,
  gradient: boolean,
): SourceKind {
  if (node.type === "TEXT" && property === "fills") {
    return gradient ? "gradient-text" : "text";
  }
  if (property === "strokes") {
    return gradient ? "gradient-stroke" : "stroke";
  }
  return gradient ? "gradient-fill" : "fill";
}

function recordColor(
  aggregates: Map<string, ColorAggregate>,
  nodeId: string,
  sourceKind: SourceKind,
  rgb: SerializedColor,
): string {
  const key = buildColorKey(rgb);
  const existing = aggregates.get(key);
  if (!existing) {
    aggregates.set(key, {
      rgb,
      usageCount: 1,
      nodeIds: new Set([nodeId]),
      sourceKinds: new Set([sourceKind]),
    });
    return key;
  }

  existing.usageCount += 1;
  existing.nodeIds.add(nodeId);
  existing.sourceKinds.add(sourceKind);
  return key;
}

function averageGradientPaint(paint: GradientPaint): SerializedColor {
  return averageColor(
    paint.gradientStops.map((stop) => figmaColorToSerialized(stop.color, stop.color.a)),
  );
}

function pickVisiblePaintColor(paints: ReadonlyArray<Paint>): SerializedColor | null {
  for (const paint of paints) {
    if (!paintVisible(paint)) continue;
    if (isSolidPaint(paint)) {
      return figmaColorToSerialized(paint.color, paint.opacity ?? 1);
    }
    if (isGradientPaint(paint)) {
      return averageGradientPaint(paint);
    }
  }
  return null;
}

function findNearestParentBackground(node: SceneNode): SerializedColor | null {
  let current = node.parent;
  while (current && current.type !== "PAGE") {
    if ("visible" in current && current.visible === false) {
      current = current.parent;
      continue;
    }
    if ("fills" in current && Array.isArray(current.fills)) {
      const background = pickVisiblePaintColor(current.fills);
      if (background) {
        return background;
      }
    }
    current = current.parent;
  }
  return null;
}

function nodeArea(node: SceneNode): number {
  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    return Math.max(0, node.absoluteBoundingBox.width * node.absoluteBoundingBox.height);
  }
  return 0;
}

function resolveTextPriority(contrast: number): ThemeTextPriority {
  return Math.abs(contrast) > 65 ? "primary" : "secondary";
}

function selectionRoots(selection: readonly SceneNode[]): SceneNode[] {
  const selected = new Set(selection.map((node) => node.id));
  return selection.filter((node) => {
    let parent = node.parent;
    while (parent && parent.type !== "PAGE") {
      if ("id" in parent && selected.has(parent.id)) {
        return false;
      }
      parent = parent.parent;
    }
    return true;
  });
}

function traverseNodes(roots: readonly SceneNode[]): SceneNode[] {
  const visited = new Set<string>();
  const result: SceneNode[] = [];
  const stack = [...roots];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || visited.has(node.id)) continue;
    visited.add(node.id);
    result.push(node);
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child.type !== "SLICE") {
          stack.push(child);
        }
      }
    }
  }

  return result;
}

function uniqueFontsForText(node: TextNode): FontName[] {
  const segments = node.getStyledTextSegments(["fontName"]);
  const seen = new Set<string>();
  const fonts: FontName[] = [];
  for (const segment of segments) {
    const key = `${segment.fontName.family}__${segment.fontName.style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fonts.push({ ...segment.fontName });
  }
  return fonts;
}

function captureTextSegments(node: TextNode): TextSegmentState[] {
  const segments = node.getStyledTextSegments(["fills"]);
  return segments
    .filter((segment) => Array.isArray(segment.fills) && segment.fills.length > 0)
    .map((segment) => ({
      start: segment.start,
      end: segment.end,
      fills: clonePaints(segment.fills),
    }));
}

function inspectPaintArray(
  node: SceneNode,
  property: PaintProperty,
  paints: ReadonlyArray<Paint>,
  aggregates: Map<string, ColorAggregate>,
  bindings: NodeBinding[],
  textContexts?: Map<string, TextContextAggregate>,
): void {
  const textBackground =
    node.type === "TEXT" && property === "fills" ? findNearestParentBackground(node) : null;
  paints.forEach((paint, paintIndex) => {
    if (!paintVisible(paint)) return;

    if (isSolidPaint(paint)) {
      const rgb = figmaColorToSerialized(paint.color, paint.opacity ?? 1);
      const sourceKey = recordColor(
        aggregates,
        node.id,
        sourceKindFor(node, property, false),
        rgb,
      );
      if (textContexts && node.type === "TEXT" && property === "fills") {
        const backgroundColor = textBackground ?? { r: 1, g: 1, b: 1, a: 1 };
        const backgroundKey = buildColorKey(backgroundColor);
        const contrast = calculateApcaContrast(rgb, backgroundColor);
        const existingContext = textContexts.get(sourceKey);
        if (existingContext) {
          existingContext.usageCount += 1;
          existingContext.contrastTotal += contrast;
          const existingBackground = existingContext.backgroundCounts.get(backgroundKey);
          if (existingBackground) {
            existingBackground.count += 1;
          } else {
            existingContext.backgroundCounts.set(backgroundKey, {
              rgb: backgroundColor,
              count: 1,
            });
          }
        } else {
          textContexts.set(sourceKey, {
            sourceKey,
            usageCount: 1,
            contrastTotal: contrast,
            backgroundCounts: new Map([
              [
                backgroundKey,
                {
                  rgb: backgroundColor,
                  count: 1,
                },
              ],
            ]),
          });
        }
      }
      bindings.push({
        kind: "solid",
        nodeId: node.id,
        property,
        paintIndex,
        sourceKey,
      });
      return;
    }

    if (isGradientPaint(paint)) {
      const average = averageGradientPaint(paint);
      const sourceKey = recordColor(
        aggregates,
        node.id,
        sourceKindFor(node, property, true),
        average,
      );
      if (textContexts && node.type === "TEXT" && property === "fills") {
        const backgroundColor = textBackground ?? { r: 1, g: 1, b: 1, a: 1 };
        const backgroundKey = buildColorKey(backgroundColor);
        const contrast = calculateApcaContrast(average, backgroundColor);
        const existingContext = textContexts.get(sourceKey);
        if (existingContext) {
          existingContext.usageCount += 1;
          existingContext.contrastTotal += contrast;
          const existingBackground = existingContext.backgroundCounts.get(backgroundKey);
          if (existingBackground) {
            existingBackground.count += 1;
          } else {
            existingContext.backgroundCounts.set(backgroundKey, {
              rgb: backgroundColor,
              count: 1,
            });
          }
        } else {
          textContexts.set(sourceKey, {
            sourceKey,
            usageCount: 1,
            contrastTotal: contrast,
            backgroundCounts: new Map([
              [
                backgroundKey,
                {
                  rgb: backgroundColor,
                  count: 1,
                },
              ],
            ]),
          });
        }
      }
      bindings.push({
        kind: "gradient",
        nodeId: node.id,
        property,
        paintIndex,
        sourceKey,
        averageOklch: rgbToOklch(average),
      });
    }
  });
}

function inspectTextSegments(
  node: TextNode,
  aggregates: Map<string, ColorAggregate>,
  bindings: NodeBinding[],
  textContexts: Map<string, TextContextAggregate>,
): void {
  const background = findNearestParentBackground(node);
  const segments = node.getStyledTextSegments(["fills"]);
  for (const segment of segments) {
    if (!Array.isArray(segment.fills)) continue;
    let paint: Paint | undefined;
    for (const candidate of segment.fills) {
      if (paintVisible(candidate)) {
        paint = candidate;
        break;
      }
    }
    if (!paint) continue;

    if (isSolidPaint(paint)) {
      const rgb = figmaColorToSerialized(paint.color, paint.opacity ?? 1);
      const sourceKey = recordColor(aggregates, node.id, "text", rgb);
      const backgroundColor = background ?? { r: 1, g: 1, b: 1, a: 1 };
      const backgroundKey = buildColorKey(backgroundColor);
      const contrast = calculateApcaContrast(rgb, backgroundColor);
      const existingContext = textContexts.get(sourceKey);
      if (existingContext) {
        existingContext.usageCount += 1;
        existingContext.contrastTotal += contrast;
        const existingBackground = existingContext.backgroundCounts.get(backgroundKey);
        if (existingBackground) {
          existingBackground.count += 1;
        } else {
          existingContext.backgroundCounts.set(backgroundKey, {
            rgb: backgroundColor,
            count: 1,
          });
        }
      } else {
        textContexts.set(sourceKey, {
          sourceKey,
          usageCount: 1,
          contrastTotal: contrast,
          backgroundCounts: new Map([
            [
              backgroundKey,
              {
                rgb: backgroundColor,
                count: 1,
              },
            ],
          ]),
        });
      }
      bindings.push({
        kind: "text-segment-solid",
        nodeId: node.id,
        start: segment.start,
        end: segment.end,
        sourceKey,
      });
      continue;
    }

    if (isGradientPaint(paint)) {
      const average = averageGradientPaint(paint);
      const sourceKey = recordColor(aggregates, node.id, "gradient-text", average);
      const backgroundColor = background ?? { r: 1, g: 1, b: 1, a: 1 };
      const backgroundKey = buildColorKey(backgroundColor);
      const contrast = calculateApcaContrast(average, backgroundColor);
      const existingContext = textContexts.get(sourceKey);
      if (existingContext) {
        existingContext.usageCount += 1;
        existingContext.contrastTotal += contrast;
        const existingBackground = existingContext.backgroundCounts.get(backgroundKey);
        if (existingBackground) {
          existingBackground.count += 1;
        } else {
          existingContext.backgroundCounts.set(backgroundKey, {
            rgb: backgroundColor,
            count: 1,
          });
        }
      } else {
        textContexts.set(sourceKey, {
          sourceKey,
          usageCount: 1,
          contrastTotal: contrast,
          backgroundCounts: new Map([
            [
              backgroundKey,
              {
                rgb: backgroundColor,
                count: 1,
              },
            ],
          ]),
        });
      }
      bindings.push({
        kind: "text-segment-gradient",
        nodeId: node.id,
        start: segment.start,
        end: segment.end,
        sourceKey,
        averageOklch: rgbToOklch(average),
      });
    }
  }
}

function inspectEffectArray(
  node: SceneNode,
  effects: ReadonlyArray<Effect>,
  aggregates: Map<string, ColorAggregate>,
  bindings: NodeBinding[],
): void {
  effects.forEach((effect, effectIndex) => {
    if (effect.visible === false || !isShadowEffect(effect)) return;
    const rgb = figmaColorToSerialized(effect.color, effect.color.a);
    const sourceKey = recordColor(aggregates, node.id, "effect", rgb);
    bindings.push({
      kind: "effect",
      nodeId: node.id,
      effectIndex,
      sourceKey,
    });
  });
}

function buildSummary(
  aggregates: Map<string, ColorAggregate>,
  selectionName: string,
  nodeCount: number,
  layerCount: number,
  textContexts: Map<string, TextContextAggregate>,
  themeDetection?: ThemeDetectionSummary,
): SelectionAnalysisSummary {
  const provisionalColors = [...aggregates.entries()].map(([key, aggregate]) => ({
    key,
    rgb: aggregate.rgb,
    hex: rgbToHex(aggregate.rgb),
    oklch: rgbToOklch(aggregate.rgb),
    usageCount: aggregate.usageCount,
    nodeCount: aggregate.nodeIds.size,
    sourceKinds: [...aggregate.sourceKinds].sort(),
    role: "support" as const,
  }));

  const colors = provisionalColors
    .map((color) => ({
      ...color,
      role: classifyColorRole(color, provisionalColors, 0.03),
      theme: (() => {
        const saturation = rgbToHsl(color.rgb).s;
        const textContext = textContexts.get(color.key);
        const textOnly = color.sourceKinds.every(
          (kind) => kind === "text" || kind === "gradient-text",
        );
        if (textContext && textOnly) {
          let dominantBackground: { rgb: SerializedColor; count: number } | null = null;
          for (const entry of textContext.backgroundCounts.values()) {
            if (!dominantBackground || entry.count > dominantBackground.count) {
              dominantBackground = entry;
            }
          }
          const averageContrast = textContext.contrastTotal / Math.max(textContext.usageCount, 1);
          return {
            kind: "text",
            saturation,
            originalLc: averageContrast,
            textPriority: resolveTextPriority(averageContrast),
            textBackground: dominantBackground?.rgb,
            textBackgroundHex: dominantBackground ? rgbToHex(dominantBackground.rgb) : undefined,
          } satisfies ThemeColorContext;
        }

        return {
          kind: saturation > 0.18 ? "chromatic" : "neutral",
          saturation,
        } satisfies ThemeColorContext;
      })(),
    }))
    .sort(compareByUsageThenHue);

  return {
    selectionName,
    nodeCount,
    layerCount,
    uniqueColorCount: colors.length,
    colors,
    timestamp: Date.now(),
    themeDetection,
  };
}

export function extractSelectionAnalysis(): SelectionAnalysisInternal | null {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) return null;

  const roots = selectionRoots(selection);
  const nodes = traverseNodes(roots);
  const aggregates = new Map<string, ColorAggregate>();
  const textContexts = new Map<string, TextContextAggregate>();
  const bindings: NodeBinding[] = [];
  const originalStates = new Map<string, NodeOriginalState>();
  let fillAreaTotal = 0;
  let fillLightnessWeighted = 0;

  for (const node of nodes) {
    if ("visible" in node && node.visible === false) continue;
    if ("fills" in node && Array.isArray(node.fills)) {
      originalStates.set(node.id, {
        ...(originalStates.get(node.id) ?? { nodeId: node.id }),
        fills: clonePaints(node.fills),
        fillStyleId: "fillStyleId" in node ? node.fillStyleId : undefined,
        fonts: node.type === "TEXT" ? cloneFonts(uniqueFontsForText(node)) : undefined,
      });
      inspectPaintArray(node, "fills", node.fills, aggregates, bindings, textContexts);
      if (node.type !== "TEXT") {
        const background = pickVisiblePaintColor(node.fills);
        const area = nodeArea(node);
        if (background && area > 0) {
          fillAreaTotal += area;
          fillLightnessWeighted += rgbToHsl(background).l * area;
        }
      }
    } else if (node.type === "TEXT" && node.fills === figma.mixed) {
      originalStates.set(node.id, {
        ...(originalStates.get(node.id) ?? { nodeId: node.id }),
        textSegments: captureTextSegments(node),
        fonts: cloneFonts(uniqueFontsForText(node)),
      });
      inspectTextSegments(node, aggregates, bindings, textContexts);
    }

    if ("strokes" in node && Array.isArray(node.strokes)) {
      originalStates.set(node.id, {
        ...(originalStates.get(node.id) ?? { nodeId: node.id }),
        strokes: clonePaints(node.strokes),
        strokeStyleId: "strokeStyleId" in node ? node.strokeStyleId : undefined,
        fonts:
          originalStates.get(node.id)?.fonts ??
          (node.type === "TEXT" ? cloneFonts(uniqueFontsForText(node)) : undefined),
      });
      inspectPaintArray(node, "strokes", node.strokes, aggregates, bindings, textContexts);
    }

    if ("effects" in node && Array.isArray(node.effects)) {
      originalStates.set(node.id, {
        ...(originalStates.get(node.id) ?? { nodeId: node.id }),
        effects: cloneEffects(node.effects),
        effectStyleId: "effectStyleId" in node ? node.effectStyleId : undefined,
        fonts:
          originalStates.get(node.id)?.fonts ??
          (node.type === "TEXT" ? cloneFonts(uniqueFontsForText(node)) : undefined),
      });
      inspectEffectArray(node, node.effects, aggregates, bindings);
    }
  }

  if (bindings.length === 0) {
    return null;
  }

  const selectionName =
    roots.length === 1 ? roots[0].name : `${roots.length} selected layers`;
  const averageFillLightness = fillAreaTotal > 0 ? fillLightnessWeighted / fillAreaTotal : 0;
  const themeDetection: ThemeDetectionSummary | undefined =
    fillAreaTotal > 0
      ? {
          averageFillLightness,
          inferredSourceTheme: averageFillLightness < 0.45 ? "dark" : "light",
        }
      : undefined;

  return {
    summary: buildSummary(
      aggregates,
      selectionName,
      roots.length,
      nodes.length,
      textContexts,
      themeDetection,
    ),
    bindings,
    originalStates,
    rootNodeIds: roots.map((node) => node.id),
  };
}

async function ensureFontsLoaded(fonts: readonly FontName[] | undefined): Promise<void> {
  if (!fonts || fonts.length === 0) return;
  for (const font of fonts) {
    await figma.loadFontAsync(font);
  }
}

function shortestHueDelta(from: number, to: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  if (!Number.isFinite(delta)) delta = 0;
  return delta;
}

function applySolidPaint(paint: Paint, target: SerializedColor): Paint {
  if (!isSolidPaint(paint)) return paint;
  const { boundVariables: _boundVariables, ...rest } = paint as SolidPaint & {
    boundVariables?: SolidPaint["boundVariables"];
  };
  return {
    ...rest,
    color: serializedToFigmaColor(target),
    opacity: target.a,
  };
}

function applyGradientPaint(
  paint: Paint,
  averageOklch: OklchColor,
  mapping: ColorMappingEntry,
): Paint {
  if (!isGradientPaint(paint)) return paint;
  const deltaL = mapping.targetOklch.l - averageOklch.l;
  const deltaC = mapping.targetOklch.c - averageOklch.c;
  const deltaH = shortestHueDelta(averageOklch.h, mapping.targetOklch.h);

  return {
    ...paint,
    gradientStops: paint.gradientStops.map((stop) => {
      const source = rgbToOklch(figmaColorToSerialized(stop.color, stop.color.a));
      const adjusted = {
        l: Math.max(0, Math.min(1, source.l + deltaL)),
        c: Math.max(0, source.c + deltaC),
        h: source.h + deltaH,
        alpha: source.alpha,
      } satisfies OklchColor;
      const rgb = oklchToRgb(adjusted, { clampToGamut: true });
      const { boundVariables: _boundVariables, ...restStop } = stop as ColorStop & {
        boundVariables?: ColorStop["boundVariables"];
      };
      return {
        ...restStop,
        color: {
          r: rgb.r,
          g: rgb.g,
          b: rgb.b,
          a: rgb.a,
        },
      };
    }),
  };
}

function textSegmentKey(start: number, end: number): string {
  return `${start}:${end}`;
}

function ensureMutablePaints(
  state: MutableNodeState,
  property: PaintProperty,
  clonedStateIds: Set<string>,
): Paint[] | undefined {
  const paints = state[property];
  if (!paints) return undefined;
  if (!clonedStateIds.has(state.nodeId)) {
    state[property] = clonePaints(paints);
    clonedStateIds.add(state.nodeId);
  }
  return state[property];
}

function ensureMutableEffects(
  state: MutableNodeState,
  clonedStateIds: Set<string>,
): Effect[] | undefined {
  if (!state.effects) return undefined;
  if (!clonedStateIds.has(state.nodeId)) {
    state.effects = cloneEffects(state.effects);
    clonedStateIds.add(state.nodeId);
  }
  return state.effects;
}

function ensureMutableTextSegments(
  state: MutableNodeState,
  clonedStateIds: Set<string>,
): Map<string, TextSegmentState> | undefined {
  if (!state.textSegments) return undefined;
  if (!clonedStateIds.has(state.nodeId)) {
    state.textSegments = state.textSegments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      fills: clonePaints(segment.fills),
    }));
    clonedStateIds.add(state.nodeId);
  }
  if (!state.textSegmentIndex) {
    state.textSegmentIndex = new Map(
      state.textSegments.map((segment) => [textSegmentKey(segment.start, segment.end), segment]),
    );
  }
  return state.textSegmentIndex;
}

function isMissingNodeMutationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("does not exist") || message.includes("node not found");
}

export async function restoreSelection(
  analysis: SelectionAnalysisInternal,
): Promise<number> {
  let restored = 0;
  for (const state of analysis.originalStates.values()) {
    const node = await figma.getNodeByIdAsync(state.nodeId);
    if (!node || node.removed) continue;
    try {
      if (node.type === "TEXT") {
        await ensureFontsLoaded(state.fonts);
      }
      if (state.fills && "fills" in node) {
        node.fills = clonePaints(state.fills);
        if ("fillStyleId" in node && state.fillStyleId !== undefined) {
          try { (node as SceneNode & { fillStyleId: typeof state.fillStyleId }).fillStyleId = state.fillStyleId; } catch {}
        }
        restored += 1;
      }
      if (state.strokes && "strokes" in node) {
        node.strokes = clonePaints(state.strokes);
        if ("strokeStyleId" in node && state.strokeStyleId !== undefined) {
          try { (node as SceneNode & { strokeStyleId: string }).strokeStyleId = state.strokeStyleId as string; } catch {}
        }
        restored += 1;
      }
      if (state.effects && "effects" in node) {
        node.effects = cloneEffects(state.effects);
        restored += 1;
      }
      if (state.textSegments && node.type === "TEXT") {
        for (const segment of state.textSegments) {
          node.setRangeFills(segment.start, segment.end, clonePaints(segment.fills));
          restored += 1;
        }
      }
    } catch (error) {
      if (isMissingNodeMutationError(error)) {
        continue;
      }
      throw error;
    }
  }
  return restored;
}

export async function applyColorMapping(
  analysis: SelectionAnalysisInternal,
  mappingEntries: ColorMappingEntry[],
): Promise<number> {
  const mapping = new Map(mappingEntries.map((entry) => [entry.key, entry]));
  const nextStates = new Map<string, MutableNodeState>(
    [...analysis.originalStates.entries()].map(([nodeId, state]) => [
      nodeId,
      { ...state },
    ]),
  );
  const clonedFillStateIds = new Set<string>();
  const clonedStrokeStateIds = new Set<string>();
  const clonedEffectStateIds = new Set<string>();
  const clonedTextStateIds = new Set<string>();

  for (const binding of analysis.bindings) {
    const state = nextStates.get(binding.nodeId);
    const mappingEntry = mapping.get(binding.sourceKey);
    if (!state || !mappingEntry) continue;

    if (binding.kind === "solid") {
      const paints = ensureMutablePaints(
        state,
        binding.property,
        binding.property === "fills" ? clonedFillStateIds : clonedStrokeStateIds,
      );
      if (!paints) continue;
      const original = paints[binding.paintIndex];
      if (original) {
        paints[binding.paintIndex] = applySolidPaint(original, mappingEntry.target);
      }
      continue;
    }

    if (binding.kind === "gradient") {
      const paints = ensureMutablePaints(
        state,
        binding.property,
        binding.property === "fills" ? clonedFillStateIds : clonedStrokeStateIds,
      );
      if (!paints) continue;
      const original = paints[binding.paintIndex];
      if (original) {
        paints[binding.paintIndex] = applyGradientPaint(
          original,
          binding.averageOklch,
          mappingEntry,
        );
      }
      continue;
    }

    if (binding.kind === "effect") {
      const effects = ensureMutableEffects(state, clonedEffectStateIds);
      if (!effects) continue;
      const original = effects[binding.effectIndex];
      if (!original || !isShadowEffect(original)) continue;
      const { boundVariables: _boundVariables, ...restEffect } = original as
        (DropShadowEffect | InnerShadowEffect) & {
          boundVariables?: DropShadowEffect["boundVariables"] | InnerShadowEffect["boundVariables"];
        };
      effects[binding.effectIndex] = {
        ...restEffect,
        color: {
          r: mappingEntry.target.r,
          g: mappingEntry.target.g,
          b: mappingEntry.target.b,
          a: original.color.a,
        },
      };
      continue;
    }

    if (
      state.textSegments &&
      (binding.kind === "text-segment-solid" || binding.kind === "text-segment-gradient")
    ) {
      const segment = ensureMutableTextSegments(
        state,
        clonedTextStateIds,
      );
      const currentSegment = segment?.get(textSegmentKey(binding.start, binding.end));
      if (!currentSegment) continue;
      const originalPaint = currentSegment.fills[0];
      if (!originalPaint) continue;

      if (binding.kind === "text-segment-solid") {
        currentSegment.fills = [applySolidPaint(originalPaint, mappingEntry.target)];
      } else if (binding.kind === "text-segment-gradient") {
        currentSegment.fills = [
          applyGradientPaint(originalPaint, binding.averageOklch ?? mappingEntry.targetOklch, mappingEntry),
        ];
      }
    }
  }

  let updated = 0;

  for (const state of nextStates.values()) {
    const node = await figma.getNodeByIdAsync(state.nodeId);
    if (!node || node.removed) continue;
    try {
      if (node.type === "TEXT") {
        await ensureFontsLoaded(state.fonts);
      }
      if (state.fills && "fills" in node) {
        if ("fillStyleId" in node) {
          try { node.fillStyleId = ""; } catch {}
        }
        node.fills = state.fills;
        updated += 1;
      }
      if (state.strokes && "strokes" in node) {
        if ("strokeStyleId" in node) {
          try { node.strokeStyleId = ""; } catch {}
        }
        node.strokes = state.strokes;
        updated += 1;
      }
      if (state.effects && "effects" in node) {
        if ("effectStyleId" in node) {
          try { node.effectStyleId = ""; } catch {}
        }
        node.effects = state.effects;
        updated += 1;
      }
      if (state.textSegments && node.type === "TEXT") {
        for (const segment of state.textSegments) {
          node.setRangeFills(segment.start, segment.end, segment.fills);
          updated += 1;
        }
      }
    } catch (error) {
      if (isMissingNodeMutationError(error)) {
        continue;
      }
      throw error;
    }
  }

  return updated;
}
