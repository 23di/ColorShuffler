import { APCAcontrast, sRGBtoY } from "apca-w3";
import { clamp01 } from "./color";
import type { SerializedColor } from "./types";

interface ApcaReferenceColor {
  key: string;
  hex: string;
  rgb: SerializedColor;
  label: string;
  lightness: number;
}

interface ApcaContrastResult {
  contrast: number;
  absoluteContrast: number;
  text: SerializedColor;
  background: SerializedColor;
  reference: ApcaReferenceColor;
}

function toApcaRgb(color: SerializedColor): [number, number, number, number] {
  return [
    Math.round(clamp01(color.r) * 255),
    Math.round(clamp01(color.g) * 255),
    Math.round(clamp01(color.b) * 255),
    clamp01(color.a),
  ];
}

export function calculateApcaContrast(
  textColor: SerializedColor,
  backgroundColor: SerializedColor,
): number {
  return APCAcontrast(sRGBtoY(toApcaRgb(textColor)), sRGBtoY(toApcaRgb(backgroundColor)));
}

export function apcaStatus(
  before: number,
  after: number,
  target: number,
): "pass" | "improved" | "watch" | "fail" {
  const absBefore = Math.abs(before);
  const absAfter = Math.abs(after);
  if (absAfter >= target) return "pass";
  if (absAfter > absBefore) return "improved";
  if (absAfter >= target * 0.8) return "watch";
  return "fail";
}

