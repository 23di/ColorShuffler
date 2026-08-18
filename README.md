# Color Shuffler

Figma plugin for exploring and adjusting UI color palettes directly on real designs. Shift colors across the OKLCH spectrum while preserving perceived lightness, tune neutrals separately, build more complementary palettes, and experiment with light/dark theme conversion.

Color Shuffler is completely free. Everything runs locally — no analytics, no tracking, and no network access.

## Features

- Explore color variations while preserving perceived lightness
- Shift colors across the OKLCH spectrum without losing visual balance
- Adjust neutral and near-neutral colors separately
- Turn existing colors into a more complementary palette
- Control hue, exposure, chroma, tint, and contrast in real time
- Preview changes and apply them directly to the selected design
- Experiment with light-to-dark and dark-to-light theme conversion

Theme conversion is still experimental and may not produce reliable results for every design.

## Project Structure

```
src/plugin/    — Figma plugin runtime, selection analysis, and canvas updates
src/ui/        — React interface and color controls
src/shared/    — Shared color models, OKLCH utilities, and theme conversion logic
scripts/       — Build scripts
manifest.json  — Figma plugin manifest
```

## Tech Stack

- [React](https://react.dev/) — plugin interface
- [Culori](https://culorijs.org/) — color conversion and manipulation
- [APCA](https://github.com/Myndex/apca-w3) — perceptual contrast calculations
- [TypeScript](https://www.typescriptlang.org/) — application code
- [Vite](https://vite.dev/) and [esbuild](https://esbuild.github.io/) — build tooling

## Development

```bash
npm install
npm run check
npm run build
```

Load the plugin in Figma via `Plugins → Development → Import plugin from manifest…` and select `manifest.json`.

## More Plugins

You can also try [TinyPics — Fast Local Image Compressor](https://www.figma.com/community/plugin/1612595698368227712/tinypics-fast-local-image-compressor).
