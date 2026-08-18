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
  dirtyFills?: boolean;
  dirtyStrokes?: boolean;
  dirtyEffects?: boolean;
  dirtyTextSegments?: boolean;
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

type ForegroundContextAggregate = TextContextAggregate;

export interface SelectionAnalysisInternal {
  summary: SelectionAnalysisSummary;
  bindings: NodeBinding[];
  originalStates: Map<string, NodeOriginalState>;
  nodeById: Map<string, SceneNode>;
  rootNodeIds: string[];
}

function clonePaints(paints: ReadonlyArray<Paint>): Paint[] {
  return JSON.parse(JSON.stringify(paints)) as Paint[];
}

function sanitizeColorStop(stop: ColorStop): ColorStop {
  const { boundVariables: _boundVariables, ...rest } = stop as ColorStop & {
    boundVariables?: ColorStop["boundVariables"];
  };
  return rest;
}

function sanitizePaint(paint: Paint): Paint {
  switch (paint.type) {
    case "SOLID": {
      const { boundVariables: _boundVariables, ...rest } = paint as SolidPaint & {
        boundVariables?: SolidPaint["boundVariables"];
      };
      return rest;
    }
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND":
      return {
        ...paint,
        gradientStops: paint.gradientStops.map(sanitizeColorStop),
      };
    case "IMAGE": {
      const base: ImagePaint = {
        type: "IMAGE",
        scaleMode: paint.scaleMode,
        imageHash: paint.imageHash,
        visible: paint.visible,
        opacity: paint.opacity,
        blendMode: paint.blendMode,
        filters: paint.filters,
      };
      if (paint.scaleMode === "CROP" && paint.imageTransform) {
        return {
          ...base,
          imageTransform: paint.imageTransform,
        };
      }
      if (paint.scaleMode === "TILE" && paint.scalingFactor !== undefined) {
        return {
          ...base,
          scalingFactor: paint.scalingFactor,
          rotation: paint.rotation,
        };
      }
      if (paint.scaleMode === "FILL" || paint.scaleMode === "FIT") {
        return {
          ...base,
          rotation: paint.rotation,
        };
      }
      return base;
    }
    case "VIDEO":
      return paint;
    default:
      return paint;
  }
}

function sanitizePaints(paints: ReadonlyArray<Paint>): Paint[] {
  return paints.map(sanitizePaint);
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

function aggregateContextFor(sourceKind: SourceKind): "text" | "paint" {
  return sourceKind === "text" || sourceKind === "gradient-text" ? "text" : "paint";
}

// Split text usages that sit on a chromatic background into their own
// aggregate bucket. This lets "#FFF on blue button" and "#FFF on dark body"
// map to different targets during a theme flip, instead of being yoked to
// a single global mapping for the color.
const TEXT_ACCENT_CONTEXT = "text_accent" as const;
const CHROMATIC_BG_THRESHOLD = 0.05;

function isChromaticBackground(bg: SerializedColor | null | undefined): boolean {
  if (!bg) return false;
  return rgbToOklch(bg).c > CHROMATIC_BG_THRESHOLD;
}

function recordColor(
  aggregates: Map<string, ColorAggregate>,
  nodeId: string,
  sourceKind: SourceKind,
  rgb: SerializedColor,
  contextOverride?: string,
): string {
  const context = contextOverride ?? aggregateContextFor(sourceKind);
  const key = `${buildColorKey(rgb)}__${context}`;
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

function getAbsoluteBounds(node: SceneNode): Rect | null {
  return "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
}

function boundsOverlap(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return false;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0;
}

function findBackgroundInSubtree(
  node: SceneNode,
  targetBounds: Rect | null,
): SerializedColor | null {
  if ("visible" in node && node.visible === false) {
    return null;
  }

  if ("fills" in node && Array.isArray(node.fills) && boundsOverlap(getAbsoluteBounds(node), targetBounds)) {
    const background = pickVisiblePaintColor(node.fills);
    if (background) {
      return background;
    }
  }

  if ("children" in node) {
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child.type === "SLICE") continue;
      const background = findBackgroundInSubtree(child, targetBounds);
      if (background) {
        return background;
      }
    }
  }

  return null;
}

function findNearestBackground(node: SceneNode): SerializedColor | null {
  const targetBounds = getAbsoluteBounds(node);
  let current: SceneNode = node;

  while (current.parent && current.parent.type !== "PAGE" && current.parent.type !== "DOCUMENT") {
    const parent = current.parent;

    if ("visible" in parent && parent.visible === false) {
      current = parent;
      continue;
    }

    if ("fills" in parent && Array.isArray(parent.fills)) {
      const background = pickVisiblePaintColor(parent.fills);
      if (background) {
        return background;
      }
    }

    if ("children" in parent) {
      const currentIndex = parent.children.findIndex((child) => child.id === current.id);
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const sibling = parent.children[index];
        if (sibling.type === "SLICE") continue;
        const background = findBackgroundInSubtree(sibling, targetBounds);
        if (background) {
          return background;
        }
      }
      for (let index = currentIndex + 1; index < parent.children.length; index += 1) {
        const sibling = parent.children[index];
        if (sibling.type === "SLICE") continue;
        const background = findBackgroundInSubtree(sibling, targetBounds);
        if (background) {
          return background;
        }
      }
    }

    current = parent as SceneNode;
  }

  return null;
}

function getNearestBackground(
  node: SceneNode,
  cache: Map<string, SerializedColor | null>,
): SerializedColor | null {
  if (cache.has(node.id)) {
    return cache.get(node.id) ?? null;
  }
  const background = findNearestBackground(node);
  cache.set(node.id, background);
  return background;
}

function recordSurfaceContext(
  contexts: Map<string, TextContextAggregate | ForegroundContextAggregate>,
  sourceKey: string,
  foregroundColor: SerializedColor,
  backgroundColor: SerializedColor,
): void {
  const backgroundKey = buildColorKey(backgroundColor);
  const contrast = calculateApcaContrast(foregroundColor, backgroundColor);
  const existingContext = contexts.get(sourceKey);
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
    return;
  }

  contexts.set(sourceKey, {
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

function isForegroundIconCandidate(node: SceneNode, property: PaintProperty): boolean {
  if (property === "strokes") return true;
  switch (node.type) {
    case "VECTOR":
    case "BOOLEAN_OPERATION":
    case "STAR":
    case "ELLIPSE":
    case "POLYGON":
    case "LINE":
      return true;
    default:
      return false;
  }
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
  backgroundCache: Map<string, SerializedColor | null>,
  textContexts?: Map<string, TextContextAggregate>,
  foregroundContexts?: Map<string, ForegroundContextAggregate>,
): void {
  const textBackground =
    node.type === "TEXT" && property === "fills"
      ? getNearestBackground(node, backgroundCache)
      : null;
  const localBackground =
    node.type !== "TEXT" && isForegroundIconCandidate(node, property)
      ? getNearestBackground(node, backgroundCache)
      : null;
  paints.forEach((paint, paintIndex) => {
    if (!paintVisible(paint)) return;

    if (isSolidPaint(paint)) {
      const rgb = figmaColorToSerialized(paint.color, paint.opacity ?? 1);
      const isText = node.type === "TEXT" && property === "fills";
      const textOnChromatic = isText && isChromaticBackground(textBackground);
      const sourceKey = recordColor(
        aggregates,
        node.id,
        sourceKindFor(node, property, false),
        rgb,
        textOnChromatic ? TEXT_ACCENT_CONTEXT : undefined,
      );
      if (textContexts && isText) {
        const backgroundColor = textBackground ?? { r: 1, g: 1, b: 1, a: 1 };
        recordSurfaceContext(textContexts, sourceKey, rgb, backgroundColor);
      }
      if (foregroundContexts && localBackground) {
        const contrast = Math.abs(calculateApcaContrast(rgb, localBackground));
        if (contrast >= 45) {
          recordSurfaceContext(foregroundContexts, sourceKey, rgb, localBackground);
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
      const isText = node.type === "TEXT" && property === "fills";
      const textOnChromatic = isText && isChromaticBackground(textBackground);
      const sourceKey = recordColor(
        aggregates,
        node.id,
        sourceKindFor(node, property, true),
        average,
        textOnChromatic ? TEXT_ACCENT_CONTEXT : undefined,
      );
      if (textContexts && isText) {
        const backgroundColor = textBackground ?? { r: 1, g: 1, b: 1, a: 1 };
        recordSurfaceContext(textContexts, sourceKey, average, backgroundColor);
      }
      if (foregroundContexts && localBackground) {
        const contrast = Math.abs(calculateApcaContrast(average, localBackground));
        if (contrast >= 45) {
          recordSurfaceContext(foregroundContexts, sourceKey, average, localBackground);
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
  backgroundCache: Map<string, SerializedColor | null>,
): void {
  const background = getNearestBackground(node, backgroundCache);
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

    const textOnChromatic = isChromaticBackground(background);
    const contextOverride = textOnChromatic ? TEXT_ACCENT_CONTEXT : undefined;

    if (isSolidPaint(paint)) {
      const rgb = figmaColorToSerialized(paint.color, paint.opacity ?? 1);
      const sourceKey = recordColor(aggregates, node.id, "text", rgb, contextOverride);
      const backgroundColor = background ?? { r: 1, g: 1, b: 1, a: 1 };
      recordSurfaceContext(textContexts, sourceKey, rgb, backgroundColor);
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
      const sourceKey = recordColor(aggregates, node.id, "gradient-text", average, contextOverride);
      const backgroundColor = background ?? { r: 1, g: 1, b: 1, a: 1 };
      recordSurfaceContext(textContexts, sourceKey, average, backgroundColor);
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
  foregroundContexts: Map<string, ForegroundContextAggregate>,
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
        const foregroundContext = foregroundContexts.get(color.key);
        const preferredContext = textContext ?? foregroundContext;
        const CHROMATIC_BG_THRESHOLD = 0.05;
        let dominantBackground: { rgb: SerializedColor; count: number } | null = null;
        let hasChromaticTextBackground = false;
        if (preferredContext) {
          for (const entry of preferredContext.backgroundCounts.values()) {
            const entryContrast = Math.abs(calculateApcaContrast(color.rgb, entry.rgb));
            const dominantContrast = dominantBackground
              ? Math.abs(calculateApcaContrast(color.rgb, dominantBackground.rgb))
              : -1;
            if (rgbToOklch(entry.rgb).c > CHROMATIC_BG_THRESHOLD) {
              hasChromaticTextBackground = true;
            }
            if (
              !dominantBackground ||
              entryContrast > dominantContrast + 0.5 ||
              (Math.abs(entryContrast - dominantContrast) <= 0.5 && entry.count > dominantBackground.count)
            ) {
              dominantBackground = entry;
            }
          }
        }
        const resolvedContrast = dominantBackground
          ? calculateApcaContrast(color.rgb, dominantBackground.rgb)
          : preferredContext
            ? preferredContext.contrastTotal / Math.max(preferredContext.usageCount, 1)
            : undefined;
        const textMeta = preferredContext
          ? {
              originalLc: resolvedContrast,
              textPriority: resolveTextPriority(resolvedContrast ?? 0),
              textBackground: dominantBackground?.rgb,
              textBackgroundHex: dominantBackground ? rgbToHex(dominantBackground.rgb) : undefined,
              hasChromaticTextBackground,
            }
          : {};
        const textOnly = color.sourceKinds.every(
          (kind) => kind === "text" || kind === "gradient-text",
        );
        const textShare = textContext
          ? textContext.usageCount / Math.max(color.usageCount, 1)
          : 0;
        const textDominant = textOnly || textShare >= 0.35;
        if (textContext && textDominant) {
          return {
            kind: "text",
            saturation,
            ...textMeta,
          } satisfies ThemeColorContext;
        }

        return {
          kind: saturation > 0.18 ? "chromatic" : "neutral",
          saturation,
          ...textMeta,
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
  const foregroundContexts = new Map<string, ForegroundContextAggregate>();
  const bindings: NodeBinding[] = [];
  const originalStates = new Map<string, NodeOriginalState>();
  const nodeById = new Map<string, SceneNode>();
  const backgroundCache = new Map<string, SerializedColor | null>();
  let fillAreaTotal = 0;
  let fillLightnessWeighted = 0;

  for (const node of nodes) {
    if ("visible" in node && node.visible === false) continue;
    nodeById.set(node.id, node);
    if ("fills" in node && Array.isArray(node.fills)) {
      originalStates.set(node.id, {
        ...(originalStates.get(node.id) ?? { nodeId: node.id }),
        fills: clonePaints(node.fills),
        fillStyleId: "fillStyleId" in node ? node.fillStyleId : undefined,
        fonts: node.type === "TEXT" ? cloneFonts(uniqueFontsForText(node)) : undefined,
      });
      inspectPaintArray(
        node,
        "fills",
        node.fills,
        aggregates,
        bindings,
        backgroundCache,
        textContexts,
        foregroundContexts,
      );
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
      inspectTextSegments(node, aggregates, bindings, textContexts, backgroundCache);
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
      inspectPaintArray(
        node,
        "strokes",
        node.strokes,
        aggregates,
        bindings,
        backgroundCache,
        textContexts,
        foregroundContexts,
      );
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
      foregroundContexts,
      themeDetection,
    ),
    bindings,
    originalStates,
    nodeById,
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
  const chromaScale =
    averageOklch.c > 0.0001 ? mapping.targetOklch.c / averageOklch.c : 0;
  const deltaH = shortestHueDelta(averageOklch.h, mapping.targetOklch.h);

  return {
    ...paint,
    gradientStops: paint.gradientStops.map((stop) => {
      const source = rgbToOklch(figmaColorToSerialized(stop.color, stop.color.a));
      const adjusted = {
        l: Math.max(0, Math.min(1, source.l + deltaL)),
        // Scale chroma proportionally so a zero-chroma target really desaturates
        // every stop instead of only shifting them toward the average color.
        c: Math.max(0, source.c * chromaScale),
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

export function restoreSelectionSync(analysis: SelectionAnalysisInternal): void {
  for (const state of analysis.originalStates.values()) {
    try {
      const node = analysis.nodeById.get(state.nodeId) ?? figma.getNodeById(state.nodeId);
      if (!node || node.removed) continue;
      if (state.fills && "fills" in node) {
        node.fills = sanitizePaints(clonePaints(state.fills));
        if ("fillStyleId" in node && state.fillStyleId !== undefined) {
          try { (node as SceneNode & { fillStyleId: typeof state.fillStyleId }).fillStyleId = state.fillStyleId; } catch {}
        }
      }
      if (state.strokes && "strokes" in node) {
        node.strokes = sanitizePaints(clonePaints(state.strokes));
        if ("strokeStyleId" in node && state.strokeStyleId !== undefined) {
          try { (node as SceneNode & { strokeStyleId: string }).strokeStyleId = state.strokeStyleId as string; } catch {}
        }
      }
      if (state.effects && "effects" in node) {
        node.effects = cloneEffects(state.effects);
      }
      if (state.textSegments && node.type === "TEXT") {
        for (const segment of state.textSegments) {
          try {
            node.setRangeFills(segment.start, segment.end, sanitizePaints(clonePaints(segment.fills)));
          } catch {
            // fonts may not be loaded — skip this segment
          }
        }
      }
    } catch {
      // ignore errors during plugin teardown
    }
  }
}

export async function restoreSelection(
  analysis: SelectionAnalysisInternal,
): Promise<number> {
  const fillNodeIds = new Set(
    analysis.bindings
      .filter(
        (binding) =>
          (binding.kind === "solid" || binding.kind === "gradient") &&
          binding.property === "fills",
      )
      .map((binding) => binding.nodeId),
  );
  const strokeNodeIds = new Set(
    analysis.bindings
      .filter(
        (binding) =>
          (binding.kind === "solid" || binding.kind === "gradient") &&
          binding.property === "strokes",
      )
      .map((binding) => binding.nodeId),
  );
  const effectNodeIds = new Set(
    analysis.bindings
      .filter((binding) => binding.kind === "effect")
      .map((binding) => binding.nodeId),
  );
  const textSegmentNodeIds = new Set(
    analysis.bindings
      .filter(
        (binding) =>
          binding.kind === "text-segment-solid" || binding.kind === "text-segment-gradient",
      )
      .map((binding) => binding.nodeId),
  );
  let restored = 0;

  const states = [...analysis.originalStates.values()];
  const nodes = states.map((state) => analysis.nodeById.get(state.nodeId) ?? null);

  await Promise.all(states.map((s, i) => {
    const node = nodes[i];
    return node && !node.removed && node.type === "TEXT" ? ensureFontsLoaded(s.fonts) : undefined;
  }));

  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const node = nodes[i];
    if (!node || node.removed) continue;
    try {
      if (state.fills && "fills" in node && fillNodeIds.has(state.nodeId)) {
        node.fills = sanitizePaints(clonePaints(state.fills));
        if ("fillStyleId" in node && state.fillStyleId !== undefined) {
          try { (node as SceneNode & { fillStyleId: typeof state.fillStyleId }).fillStyleId = state.fillStyleId; } catch {}
        }
        restored += 1;
      }
      if (state.strokes && "strokes" in node && strokeNodeIds.has(state.nodeId)) {
        node.strokes = sanitizePaints(clonePaints(state.strokes));
        if ("strokeStyleId" in node && state.strokeStyleId !== undefined) {
          try { (node as SceneNode & { strokeStyleId: string }).strokeStyleId = state.strokeStyleId as string; } catch {}
        }
        restored += 1;
      }
      if (state.effects && "effects" in node && effectNodeIds.has(state.nodeId)) {
        node.effects = cloneEffects(state.effects);
        restored += 1;
      }
      if (state.textSegments && node.type === "TEXT" && textSegmentNodeIds.has(state.nodeId)) {
        for (const segment of state.textSegments) {
          node.setRangeFills(
            segment.start,
            segment.end,
            sanitizePaints(clonePaints(segment.fills)),
          );
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
        if (binding.property === "fills") {
          state.dirtyFills = true;
        } else {
          state.dirtyStrokes = true;
        }
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
        if (binding.property === "fills") {
          state.dirtyFills = true;
        } else {
          state.dirtyStrokes = true;
        }
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
      state.dirtyEffects = true;
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
      state.dirtyTextSegments = true;
    }
  }

  let updated = 0;

  const states = [...nextStates.values()];
  const nodes = states.map((state) => analysis.nodeById.get(state.nodeId) ?? null);

  await Promise.all(states.map((s, i) => {
    const node = nodes[i];
    return node && !node.removed && node.type === "TEXT" ? ensureFontsLoaded(s.fonts) : undefined;
  }));

  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const node = nodes[i];
    if (!node || node.removed) continue;
    try {
      if (state.fills && state.dirtyFills && "fills" in node) {
        if ("fillStyleId" in node) {
          try { node.fillStyleId = ""; } catch {}
        }
        node.fills = sanitizePaints(state.fills);
        updated += 1;
      }
      if (state.strokes && state.dirtyStrokes && "strokes" in node) {
        if ("strokeStyleId" in node) {
          try { node.strokeStyleId = ""; } catch {}
        }
        node.strokes = sanitizePaints(state.strokes);
        updated += 1;
      }
      if (state.effects && state.dirtyEffects && "effects" in node) {
        if ("effectStyleId" in node) {
          try { node.effectStyleId = ""; } catch {}
        }
        node.effects = state.effects;
        updated += 1;
      }
      if (state.textSegments && state.dirtyTextSegments && node.type === "TEXT") {
        for (const segment of state.textSegments) {
          node.setRangeFills(
            segment.start,
            segment.end,
            sanitizePaints(segment.fills),
          );
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
