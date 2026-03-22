declare const __html__: string;

import type { PluginToUiMessage, UiToPluginMessage } from "../shared/messages";
import type { SelectionAnalysisSummary } from "../shared/types";
import {
  applyColorMapping,
  extractSelectionAnalysis,
  restoreSelection,
  restoreSelectionSync,
  type SelectionAnalysisInternal,
} from "./selection";

figma.skipInvisibleInstanceChildren = true;
const UI_DEFAULT_WIDTH = 380;
const UI_MIN_WIDTH = 380;
const UI_MAX_WIDTH = 760;
const UI_MIN_HEIGHT = 280;
const UI_MAX_HEIGHT = 960;

figma.showUI(__html__, {
  width: UI_DEFAULT_WIDTH,
  height: 420,
  themeColors: true,
});

let currentAnalysis: SelectionAnalysisInternal | null = null;
let baselineAnalysis: SelectionAnalysisInternal | null = null;
let previewActive = false;
let uiFocused = true;
let selectionSignatureOnBlur: string | null = null;

function buildAnalysisRootKey(analysis: SelectionAnalysisInternal | null): string {
  if (!analysis) {
    return "empty";
  }
  return [...analysis.rootNodeIds].sort().join("|");
}

function postMessage(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

function buildSelectionSignature(summary: SelectionAnalysisSummary | null): string {
  if (!summary) {
    return "empty";
  }

  return JSON.stringify({
    nodeCount: summary.nodeCount,
    layerCount: summary.layerCount,
    uniqueColorCount: summary.uniqueColorCount,
    colors: summary.colors.map((color) => ({
      key: color.key,
      usageCount: color.usageCount,
      nodeCount: color.nodeCount,
      sourceKinds: color.sourceKinds,
    })),
  });
}

function captureCurrentSelectionSignature(): string {
  return buildSelectionSignature(extractSelectionAnalysis()?.summary ?? null);
}

async function refreshSelection(options?: { preserveCurrentCanvas?: boolean }): Promise<void> {
  if (previewActive && currentAnalysis) {
    const analysis = baselineAnalysis ?? currentAnalysis;
    if (options?.preserveCurrentCanvas) {
      previewActive = false;
    } else {
      await restoreSelection(analysis);
      previewActive = false;
    }
  }

  const nextAnalysis = extractSelectionAnalysis();
  currentAnalysis = nextAnalysis;
  if (!currentAnalysis) {
      baselineAnalysis = null;
      postMessage({
        type: "selection-empty",
        message:
        "Select a frame or layers with fills, strokes, or text colors to analyze them in HCT.",
      });
    return;
  }

  if (
    !baselineAnalysis ||
    buildAnalysisRootKey(baselineAnalysis) !== buildAnalysisRootKey(currentAnalysis)
  ) {
    baselineAnalysis = currentAnalysis;
  }

  postMessage({
    type: "selection-analysis",
    payload: currentAnalysis.summary,
  });
}

figma.on("selectionchange", () => {
  // Always refresh so colours update immediately when the user selects a frame,
  // even if the plugin panel doesn't have keyboard focus at that moment.
  // preserveCurrentCanvas = true: don't attempt to restore a preview that was
  // painted on a frame the user may have just navigated away from.
  void refreshSelection({ preserveCurrentCanvas: true });
});

figma.on("close", () => {
  try {
    if (previewActive && (baselineAnalysis ?? currentAnalysis)) {
      restoreSelectionSync(baselineAnalysis ?? currentAnalysis!);
    }
  } catch {
    // ignore errors during plugin teardown
  }
});

figma.ui.onmessage = async (message: UiToPluginMessage) => {
  try {
    switch (message.type) {
      case "scan-selection": {
        await refreshSelection();
        return;
      }
      case "ui-focus": {
        uiFocused = message.active;
        if (!message.active) {
          selectionSignatureOnBlur = captureCurrentSelectionSignature();
          return;
        }

        const currentSignature = captureCurrentSelectionSignature();
        const selectionChangedWhileBlurred =
          selectionSignatureOnBlur !== null && selectionSignatureOnBlur !== currentSignature;
        selectionSignatureOnBlur = null;

        if (selectionChangedWhileBlurred) {
          await refreshSelection({ preserveCurrentCanvas: true });
        }
        return;
      }
      case "resize-ui": {
        const nextWidth = Math.max(UI_MIN_WIDTH, Math.min(UI_MAX_WIDTH, Math.round(message.width)));
        const nextHeight = Math.max(UI_MIN_HEIGHT, Math.min(UI_MAX_HEIGHT, Math.round(message.height)));
        figma.ui.resize(nextWidth, nextHeight);
        return;
      }
      case "preview-colors": {
        if (!currentAnalysis) {
          await refreshSelection();
        }
        if (!currentAnalysis) return;

        const updated = await applyColorMapping(currentAnalysis, message.mapping);
        previewActive = true;
        postMessage({ type: "preview-applied", count: updated });
        return;
      }
      case "clear-preview": {
        if (previewActive && (baselineAnalysis ?? currentAnalysis)) {
          await restoreSelection(baselineAnalysis ?? currentAnalysis!);
        }
        previewActive = false;
        postMessage({ type: "preview-cleared" });
        return;
      }
      case "restore-baseline": {
        if (baselineAnalysis) {
          await restoreSelection(baselineAnalysis);
          previewActive = false;
          currentAnalysis = extractSelectionAnalysis();
          if (currentAnalysis) {
            postMessage({ type: "selection-analysis", payload: currentAnalysis.summary });
          } else {
            baselineAnalysis = null;
            postMessage({
              type: "selection-empty",
              message:
                "Select a frame or layers with fills, strokes, or text colors to analyze them in HCT.",
            });
          }
        } else if (currentAnalysis && previewActive) {
          await restoreSelection(currentAnalysis);
          previewActive = false;
          postMessage({ type: "preview-cleared" });
        }
        return;
      }
      case "apply-colors": {
        if (!currentAnalysis) {
          await refreshSelection();
        }
        if (!currentAnalysis) return;

        await applyColorMapping(currentAnalysis, message.mapping);
        previewActive = false;
        figma.notify("Colors applied to the current selection.");
        await refreshSelection();
        return;
      }
      default: {
        const unreachable: never = message;
        throw new Error(`Unknown message type: ${JSON.stringify(unreachable)}`);
      }
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Unknown plugin error";
    figma.notify(messageText, { error: true });
    postMessage({ type: "plugin-error", message: messageText });
  }
};

void refreshSelection();
