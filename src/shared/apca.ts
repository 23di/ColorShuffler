import { APCAcontrast, sRGBtoY } from "apca-w3";
import { clamp01, rgbToHex } from "./color";
import type { ColorRecordSummary, OklchColor, SerializedColor } from "./types";

export interface ApcaReferenceColor {
  key: string;
  hex: string;
  rgb: SerializedColor;
  label: string;
  lightness: number;
}

export interface ApcaContrastResult {
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

export function pickApcaReferences(colors: ColorRecordSummary[]): ColorRecordSummary[] {
  if (colors.length === 0) return [];

  const sortedByUsage = [...colors].sort((left, right) => right.usageCount - left.usageCount);
  const lightNeutral =
    [...colors]
      .filter((color) => color.oklch.c < 0.04)
      .sort((left, right) => right.oklch.l - left.oklch.l || right.usageCount - left.usageCount)[0] ??
    [...sortedByUsage].sort((left, right) => right.oklch.l - left.oklch.l)[0];
  const darkNeutral =
    [...colors]
      .filter((color) => color.oklch.c < 0.04)
      .sort((left, right) => left.oklch.l - right.oklch.l || right.usageCount - left.usageCount)[0] ??
    [...sortedByUsage].sort((left, right) => left.oklch.l - right.oklch.l)[0];
  const dominant = sortedByUsage[0];

  return [lightNeutral, darkNeutral, dominant].filter(
    (color, index, array) => array.findIndex((entry) => entry.key === color.key) === index,
  );
}

export function bestApcaAgainstReferences(
  color: SerializedColor,
  references: ColorRecordSummary[],
): ApcaContrastResult | undefined {
  const candidates = references
    .map((reference) => {
      const darkTextFirst = color.r + color.g + color.b <= reference.rgb.r + reference.rgb.g + reference.rgb.b;
      const text = darkTextFirst ? color : reference.rgb;
      const background = darkTextFirst ? reference.rgb : color;
      const contrast = calculateApcaContrast(text, background);
      return {
        contrast,
        absoluteContrast: Math.abs(contrast),
        text,
        background,
        reference: {
          key: reference.key,
          hex: reference.hex,
          rgb: reference.rgb,
          label: reference.role === "neutral" ? "Neutral anchor" : `Reference ${reference.hex}`,
          lightness: reference.oklch.l,
        },
      } satisfies ApcaContrastResult;
    })
    .sort((left, right) => right.absoluteContrast - left.absoluteContrast);

  return candidates[0];
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

export function oklchLightnessSweep(
  base: OklchColor,
  targetLightness: number,
  amount: number,
): OklchColor {
  return {
    ...base,
    l: clamp01(base.l + (targetLightness - base.l) * amount),
  };
}

export function describeApcaReference(reference: ColorRecordSummary): string {
  return `${reference.role} ${rgbToHex(reference.rgb)}`;
}
