# Color Shuffler

Color Shuffler is a Figma plugin for fast palette exploration on real UI screens. It analyzes the current selection, groups colors by family, lets you shift hue/exposure/chroma in real time, and gives you separate controls for individual color families and neutrals.

## What it does

- Analyzes fills, strokes, text, gradients, and supported shadow colors in the current selection
- Applies a global `All colors` control for broad hue and tone exploration
- Creates `Separate control` cards for individual detected color families
- Keeps a dedicated `Neutrals` group when a real low-chroma cluster exists
- Supports live preview, reset to baseline, and direct apply back to the canvas
- Includes a role-based light/dark theme flip with adjustable parameters

## Main UI

- `All colors`: global hue, tint, exposure, and chroma controls
- `Neutrals`: separate handling for low-chroma colors with hue/exposure/contrast/chroma
- `Separate control`: add focused controls for detected color families like teal, rose, or indigo
- `Invert colors`: role-based theme switching for exploring light/dark variants

## Development

```bash
npm install
npm run check
npm run build
```

Load the plugin in Figma via `Plugins -> Development -> Import plugin from manifest...` and select:

`/Users/a23/Desktop/bin/color_shuffler light/manifest.json`

## Project structure

- `src/plugin` — Figma plugin runtime, selection analysis, and canvas mutations
- `src/ui` — React UI for controls and preview state
- `src/shared` — shared color models, mapping types, and theme-flip logic

## Notes

- The plugin is tuned for iterative exploration, so previews are throttled/coalesced before applying changes to the canvas.
- The repo intentionally ignores local build output, exports, and local assistant tooling.
