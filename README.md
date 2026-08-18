# Color Shuffler

Figma plugin for exploring and adjusting UI color palettes directly on real designs. Shift colors across the OKLCH spectrum while preserving perceived lightness, tune neutrals separately, build more complementary palettes, and experiment with light/dark theme conversion.

Color Shuffler is completely free. Everything runs locally — no analytics, no tracking, and no network access.

[Open in Figma Community](https://www.figma.com/community/plugin/1622294161663649835)

## Features

- Explore color variations while preserving perceived lightness
- Shift colors across the OKLCH spectrum without losing visual balance
- Adjust neutral and near-neutral colors separately
- Turn existing colors into a more complementary palette
- Control hue, exposure, chroma, tint, and contrast in real time
- Preview changes and apply them directly to the selected design
- Experiment with light-to-dark and dark-to-light theme conversion

Theme conversion is still experimental and may not produce reliable results for every design.

## Tech Stack

- [React](https://react.dev/) — plugin interface
- [Culori](https://culorijs.org/) — color conversion and manipulation
- [APCA](https://github.com/Myndex/apca-w3) — perceptual contrast calculations
- [TypeScript](https://www.typescriptlang.org/) — application code
- [Vite](https://vite.dev/) and [esbuild](https://esbuild.github.io/) — build tooling


You can also try [TinyPics — Fast Local Image Compressor](https://www.figma.com/community/plugin/1612595698368227712/tinypics-fast-local-image-compressor).

## License

This project is licensed under the Creative Commons Attribution-NonCommercial
4.0 International License (CC BY-NC 4.0). See [LICENSE](LICENSE) for the full license text.
