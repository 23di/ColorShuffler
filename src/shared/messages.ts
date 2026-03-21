import type { ColorMappingEntry, SelectionAnalysisSummary } from "./types";

export type UiToPluginMessage =
  | { type: "scan-selection" }
  | { type: "ui-focus"; active: boolean }
  | { type: "resize-ui"; width: number; height: number }
  | { type: "preview-colors"; mapping: ColorMappingEntry[] }
  | { type: "clear-preview" }
  | { type: "restore-baseline" }
  | { type: "apply-colors"; mapping: ColorMappingEntry[] };

export type PluginToUiMessage =
  | { type: "selection-analysis"; payload: SelectionAnalysisSummary }
  | { type: "selection-empty"; message: string }
  | { type: "preview-applied"; count: number }
  | { type: "preview-cleared" }
  | { type: "plugin-error"; message: string };
