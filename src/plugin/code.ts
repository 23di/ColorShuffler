declare const __html__: string;

import type { PluginToUiMessage, UiToPluginMessage } from "../shared/messages";
import type { ColorMappingEntry } from "../shared/types";
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
let canvasMutationQueue: Promise<void> = Promise.resolve();
let queuedPreviewMapping: ColorMappingEntry[] | null = null;
let previewFlushPromise: Promise<void> | null = null;

function buildAnalysisRootKey(analysis: SelectionAnalysisInternal | null): string {
  if (!analysis) {
    return "empty";
  }
  return [...analysis.rootNodeIds].sort().join("|");
}

function postMessage(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

function captureCurrentSelectionSignature(): string {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return "empty";
  }

  return selection
    .map((node) => node.id)
    .sort()
    .join("|");
}

function enqueueCanvasMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = canvasMutationQueue.then(operation, operation);
  canvasMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function flushQueuedPreview(): Promise<void> {
  if (previewFlushPromise) {
    await previewFlushPromise;
    return;
  }

  previewFlushPromise = enqueueCanvasMutation(async () => {
    try {
      let lastUpdated = 0;

      while (queuedPreviewMapping) {
        const mapping = queuedPreviewMapping;
        queuedPreviewMapping = null;

        if (!currentAnalysis) {
          await refreshSelection();
        }
        if (!currentAnalysis) {
          continue;
        }

        lastUpdated = await applyColorMapping(currentAnalysis, mapping);
        previewActive = true;
      }

      if (previewActive) {
        postMessage({ type: "preview-applied", count: lastUpdated });
      }
    } finally {
      previewFlushPromise = null;
      if (queuedPreviewMapping) {
        void flushQueuedPreview();
      }
    }
  });

  await previewFlushPromise;
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
  void enqueueCanvasMutation(() => refreshSelection({ preserveCurrentCanvas: true }));
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
        await enqueueCanvasMutation(() => refreshSelection());
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
          await enqueueCanvasMutation(() => refreshSelection({ preserveCurrentCanvas: true }));
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
        queuedPreviewMapping = message.mapping;
        await flushQueuedPreview();
        return;
      }
      case "clear-preview": {
        queuedPreviewMapping = null;
        await enqueueCanvasMutation(async () => {
          if (previewActive && (baselineAnalysis ?? currentAnalysis)) {
            await restoreSelection(baselineAnalysis ?? currentAnalysis!);
          }
          previewActive = false;
          postMessage({ type: "preview-cleared" });
        });
        return;
      }
      case "restore-baseline": {
        queuedPreviewMapping = null;
        await enqueueCanvasMutation(async () => {
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
        });
        return;
      }
      case "apply-colors": {
        queuedPreviewMapping = null;
        await enqueueCanvasMutation(async () => {
          if (!currentAnalysis) {
            await refreshSelection();
          }
          if (!currentAnalysis) return;

          await applyColorMapping(currentAnalysis, message.mapping);
          previewActive = false;
          figma.notify("Colors applied to the current selection.");
          await refreshSelection();
        });
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
