import type {
  ColorMappingEntry,
  PaletteToken,
  SelectionAnalysisSummary,
  ThemeSwitcherSettings,
} from "./types";

export type UiToPluginMessage =
  | { type: "scan-selection" }
  | { type: "ui-focus"; active: boolean }
  | { type: "resize-ui"; width: number; height: number }
  | { type: "preview-colors"; mapping: ColorMappingEntry[] }
  | { type: "preview-theme"; settings: ThemeSwitcherSettings }
  | { type: "clear-preview" }
  | { type: "apply-colors"; mapping: ColorMappingEntry[] }
  | { type: "apply-theme"; settings: ThemeSwitcherSettings }
  | {
      type: "export-variables";
      tokens: PaletteToken[];
      collectionName: string;
    }
  | {
      type: "export-styles";
      tokens: PaletteToken[];
      styleGroupName: string;
    };

export type PluginToUiMessage =
  | { type: "selection-analysis"; payload: SelectionAnalysisSummary }
  | { type: "selection-empty"; message: string }
  | { type: "preview-applied"; count: number }
  | { type: "preview-cleared" }
  | {
      type: "export-complete";
      kind: "variables" | "styles";
      created: number;
      collectionName?: string;
    }
  | { type: "plugin-error"; message: string };
