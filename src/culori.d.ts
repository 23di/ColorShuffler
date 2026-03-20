declare module "culori" {
  export interface Rgb {
    mode?: "rgb";
    r?: number;
    g?: number;
    b?: number;
    alpha?: number;
  }

  export interface Oklch {
    mode?: "oklch";
    l?: number;
    c?: number;
    h?: number;
    alpha?: number;
  }

  export function converter(
    mode: "oklch" | "rgb",
  ): (color: Rgb | Oklch) => Rgb | Oklch | undefined;
}
