import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

export type HueRelationWheelNode = {
  id: string;
  kind: "master" | "group" | "neutral-center";
  label: string;
  displayHue: number | null;
  displayChroma?: number;
  radialWeight?: number;
  memberCount?: number;
  shortLabel?: string;
  accentHex?: string;
  labelColor?: string;
  isSeparated?: boolean;
  isLinked?: boolean;
  isInteractive?: boolean;
  canActivate?: boolean;
  neutralTintStrength?: number;
};

type DragTarget =
  | { kind: "master"; id: string }
  | { kind: "group"; id: string; forceIndependent?: boolean }
  | { kind: "neutral"; id: string; forceIndependent?: boolean };

const WHEEL_SIZE = 220;
const WHEEL_CENTER = WHEEL_SIZE / 2;
const GROUP_NODE_SIZE = 18;
const MIN_GROUP_RADIUS = 36;
const RADIUS_STEP = 4;
const NEUTRAL_RING_RADIUS = 32;
const MAX_GROUP_RADIUS = WHEEL_CENTER - GROUP_NODE_SIZE / 2 - 1;

function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function angleToCartesian(hue: number, radius: number): { x: number; y: number } {
  const radians = ((normalizeHue(hue) - 90) * Math.PI) / 180;
  return {
    x: WHEEL_CENTER + Math.cos(radians) * radius,
    y: WHEEL_CENTER + Math.sin(radians) * radius,
  };
}

function hueFromPointer(
  container: HTMLDivElement,
  event: Pick<PointerEvent, "clientX" | "clientY">,
): number {
  const rect = container.getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  return normalizeHue((Math.atan2(y, x) * 180) / Math.PI + 90);
}

function spreadOffset(index: number): number {
  if (index === 0) return 0;
  const step = Math.ceil(index / 2) * RADIUS_STEP;
  return index % 2 === 1 ? step : -step;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function spokeStyle(hue: number, radius: number): CSSProperties {
  return {
    left: `${WHEEL_CENTER}px`,
    top: `${WHEEL_CENTER - radius}px`,
    height: `${radius}px`,
    transform: `translateX(-50%) rotate(${normalizeHue(hue)}deg)`,
  };
}

export function HueRelationWheel({
  nodes,
  activeId,
  onActiveChange,
  onMasterHueChange,
  onGroupHueChange,
  onGroupActivate,
  onGroupUnlink,
  onNeutralChange,
  onNeutralDoubleClick,
}: {
  nodes: HueRelationWheelNode[];
  activeId: string | null;
  onActiveChange?: (id: string | null) => void;
  onMasterHueChange: (nextHue: number) => void;
  onGroupHueChange: (groupId: string, nextHue: number, forceIndependent?: boolean) => void;
  onGroupActivate: (groupId: string) => void;
  onGroupUnlink: (groupId: string) => void;
  onNeutralChange: (nextHue: number, tintStrength: number, forceIndependent?: boolean) => void;
  onNeutralDoubleClick: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const discCanvasRef = useRef<HTMLCanvasElement>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragMovedRef = useRef(false);
  const lastTapRef = useRef<{ kind: "group" | "neutral"; id: string; at: number } | null>(null);
  const suppressNextNeutralDoubleClickRef = useRef(false);

  const neutralNode = nodes.find((node) => node.kind === "neutral-center") ?? null;
  const groupNodes = useMemo(
    () =>
      nodes.filter(
        (node): node is HueRelationWheelNode & { kind: "group"; displayHue: number } =>
          node.kind === "group" && node.displayHue !== null,
      ),
    [nodes],
  );

  const placementById = useMemo(() => {
    const bucketCounts = new Map<number, number>();
    const next = new Map<string, number>();
    const sorted = [...groupNodes].sort((left, right) => left.displayHue - right.displayHue);

    for (const node of sorted) {
      const bucket = Math.round(normalizeHue(node.displayHue) / 12);
      const index = bucketCounts.get(bucket) ?? 0;
      bucketCounts.set(bucket, index + 1);
      next.set(node.id, spreadOffset(index));
    }

    return next;
  }, [groupNodes]);

  const resolveGroupRadius = (node: HueRelationWheelNode & { kind: "group"; displayHue: number }) => {
    const chromaWeight = clamp01(node.radialWeight ?? 0);
    const baseRadius =
      MIN_GROUP_RADIUS + chromaWeight * (MAX_GROUP_RADIUS - MIN_GROUP_RADIUS);
    return clamp(
      baseRadius + (placementById.get(node.id) ?? 0),
      MIN_GROUP_RADIUS,
      MAX_GROUP_RADIUS,
    );
  };

  useEffect(() => {
    const canvas = discCanvasRef.current;
    if (!canvas) return;

    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const renderScale = Math.min(devicePixelRatio, 2);
    const renderSize = Math.round(WHEEL_SIZE * renderScale);
    canvas.width = renderSize;
    canvas.height = renderSize;

    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) / 2;
    const image = context.createImageData(width, height);
    const data = image.data;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = 1;
    tempCanvas.height = 1;
    const tempContext = tempCanvas.getContext("2d", { willReadFrequently: true });
    if (!tempContext) return;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const radiusRatio = distance / radius;
        const pixelIndex = (y * width + x) * 4;

        if (radiusRatio > 1) {
          data[pixelIndex + 3] = 0;
          continue;
        }

        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (angle < 0) angle += 360;

        tempContext.clearRect(0, 0, 1, 1);
        tempContext.fillStyle = `oklch(0.7 ${radiusRatio * 0.25} ${angle})`;
        tempContext.fillRect(0, 0, 1, 1);
        const pixel = tempContext.getImageData(0, 0, 1, 1).data;

        data[pixelIndex] = pixel[0];
        data[pixelIndex + 1] = pixel[1];
        data[pixelIndex + 2] = pixel[2];
        const edgeFeather = Math.max(1, renderScale * 1.25);
        const edgeAlpha = clamp((radius - distance) / edgeFeather, 0, 1);
        data[pixelIndex + 3] = Math.round(edgeAlpha * 255);
      }
    }

    context.putImageData(image, 0, 0);
    context.beginPath();
    context.arc(centerX, centerY, radius - renderScale / 2, 0, Math.PI * 2);
    context.strokeStyle = "rgba(255,255,255,0.15)";
    context.lineWidth = renderScale;
    context.stroke();
  }, []);

  useEffect(() => {
    if (!dragTarget) return;

    const onPointerMove = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const pointerStart = pointerStartRef.current;
      if (pointerStart && !dragMovedRef.current) {
        if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) {
          dragMovedRef.current = true;
        }
      }
      if (dragTarget.kind === "master") {
        const nextHue = hueFromPointer(container, event);
        onMasterHueChange(nextHue);
        return;
      }
      if (dragTarget.kind === "neutral") {
        const rect = container.getBoundingClientRect();
        const x = event.clientX - rect.left - rect.width / 2;
        const y = event.clientY - rect.top - rect.height / 2;
        const nextHue = normalizeHue((Math.atan2(y, x) * 180) / Math.PI + 90);
        const tintStrength = clamp01(Math.hypot(x, y) / NEUTRAL_RING_RADIUS);
        onNeutralChange(nextHue, tintStrength, dragTarget.forceIndependent);
        return;
      }
      const nextHue = hueFromPointer(container, event);
      onGroupHueChange(dragTarget.id, nextHue, dragTarget.forceIndependent);
    };

    const onPointerUp = () => {
      if (
        dragTarget.kind === "neutral" &&
        dragTarget.forceIndependent &&
        dragMovedRef.current
      ) {
        suppressNextNeutralDoubleClickRef.current = true;
      }
      if ((dragTarget.kind === "group" || dragTarget.kind === "neutral") && !dragMovedRef.current) {
        lastTapRef.current = {
          kind: dragTarget.kind,
          id: dragTarget.id,
          at: Date.now(),
        };
      }
      pointerStartRef.current = null;
      dragMovedRef.current = false;
      setDragTarget(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragTarget, onGroupHueChange, onMasterHueChange, onNeutralChange]);

  const startDrag = (
    event: ReactPointerEvent<HTMLElement>,
    target: DragTarget,
  ) => {
    event.preventDefault();
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
    dragMovedRef.current = false;
    setDragTarget(target);
    onActiveChange?.(target.id);
  };

  return (
    <div className="hue-wheel-panel">
      <div
        ref={containerRef}
        className={`hue-wheel${dragTarget ? " is-dragging" : ""}${dragTarget?.kind === "master" ? " is-master-dragging" : ""}`}
        onPointerDown={(event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.closest("button")) {
            return;
          }
          startDrag(event, {
            kind: "master",
            id: "all",
          });
        }}
      >
        <canvas
          ref={discCanvasRef}
          className="hue-wheel-disc"
          width={WHEEL_SIZE}
          height={WHEEL_SIZE}
          aria-hidden="true"
        />
        <div
          className="hue-wheel-neutral-orbit"
          style={{
            inset: `${WHEEL_CENTER - NEUTRAL_RING_RADIUS}px`,
          }}
          aria-hidden="true"
        />
        <div className="hue-wheel-overlay" aria-hidden="true">
          {groupNodes.map((node) => {
            const radius = resolveGroupRadius(node);
            return (
              <div
                key={`spoke-${node.id}`}
                className={`hue-wheel-spoke${activeId === node.id ? " is-active" : ""}`}
                style={spokeStyle(node.displayHue, radius)}
              />
            );
          })}
          {neutralNode && (neutralNode.neutralTintStrength ?? 0) > 0.001 ? (() => {
            const radius = (neutralNode.neutralTintStrength ?? 0) * NEUTRAL_RING_RADIUS;
            return (
              <div
                className={`hue-wheel-spoke hue-wheel-spoke-neutral${activeId === neutralNode.id ? " is-active" : ""}`}
                style={spokeStyle(neutralNode.displayHue ?? 0, radius)}
              />
            );
          })() : null}
        </div>

        {groupNodes.map((node) => {
          const radius = resolveGroupRadius(node);
          const position = angleToCartesian(node.displayHue, radius);
          const style = {
            left: `${position.x}px`,
            top: `${position.y}px`,
            "--node-accent": node.accentHex ?? `hsl(${node.displayHue} 84% 58%)`,
          } as CSSProperties;
          const isActive = activeId === node.id;
          const title = node.isInteractive
            ? node.isLinked
              ? `${node.label}: drag to rotate the linked palette`
              : !node.isSeparated
                ? `${node.label}: drag to create a separate control`
              : `${node.label}: drag to retune this group`
            : node.canActivate
              ? `${node.label}: click to create a separate control`
              : `${node.label}: shared preview`;

          return (
            <button
              key={node.id}
              type="button"
              className={[
                "hue-wheel-node",
                "hue-wheel-node-group",
                node.isSeparated ? "is-separated" : "is-passive",
                node.isLinked ? "is-linked" : "",
                isActive ? "is-active" : "",
                dragTarget?.kind === "group" && dragTarget.id === node.id ? "is-dragging" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={style}
              aria-label={title}
              title={title}
              onMouseEnter={() => onActiveChange?.(node.id)}
              onClick={() => {
                if (!node.isInteractive && node.canActivate) {
                  onGroupActivate(node.id);
                }
              }}
              onDoubleClick={() => onGroupUnlink(node.id)}
              onPointerDown={(event) => {
                if (node.isInteractive) {
                  const recentTap = lastTapRef.current;
                  const forceIndependent =
                    node.isLinked &&
                    recentTap?.kind === "group" &&
                    recentTap?.id === node.id &&
                    Date.now() - recentTap.at < 380;
                  if (forceIndependent) {
                    lastTapRef.current = null;
                  }
                  startDrag(event, {
                    kind: "group",
                    id: node.id,
                    forceIndependent,
                  });
                }
              }}
            />
          );
        })}

        {neutralNode ? (() => {
          const tintStrength = neutralNode.neutralTintStrength ?? 0;
          const position =
            neutralNode.displayHue === null || tintStrength <= 0
              ? { x: WHEEL_CENTER, y: WHEEL_CENTER }
              : angleToCartesian(neutralNode.displayHue, tintStrength * NEUTRAL_RING_RADIUS);
          const style = {
            left: `${position.x}px`,
            top: `${position.y}px`,
            "--node-accent": neutralNode.accentHex ?? "transparent",
          } as CSSProperties;

          return (
            <button
              type="button"
              className={`hue-wheel-neutral${activeId === neutralNode.id ? " is-active" : ""}${dragTarget?.kind === "neutral" ? " is-dragging" : ""}`}
              style={style}
              aria-label="Neutrals: drag to tint neutral colors"
              title="Neutrals: drag to tint neutral colors"
              onMouseEnter={() => onActiveChange?.(neutralNode.id)}
              onDoubleClick={() => {
                if (suppressNextNeutralDoubleClickRef.current) {
                  suppressNextNeutralDoubleClickRef.current = false;
                  return;
                }
                onNeutralDoubleClick();
              }}
              onPointerDown={(event) => {
                const recentTap = lastTapRef.current;
                const forceIndependent =
                  recentTap?.kind === "neutral" &&
                  recentTap.id === neutralNode.id &&
                  Date.now() - recentTap.at < 380;
                if (forceIndependent) {
                  lastTapRef.current = null;
                }
                startDrag(event, {
                  kind: "neutral",
                  id: neutralNode.id,
                  forceIndependent,
                });
              }}
            />
          );
        })() : null}
      </div>
    </div>
  );
}
