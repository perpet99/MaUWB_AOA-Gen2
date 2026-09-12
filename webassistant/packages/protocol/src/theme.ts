/**
 * Chart tokens for the live viewer.
 *
 * The categorical slots are assigned in fixed order and never cycled: tag #5
 * falls into the muted "other" slot rather than reusing tag #1's colour. Every
 * tag marker is also direct-labelled with its short address, so identity never
 * rests on colour alone -- which is what relieves the sub-3:1 contrast of the
 * aqua slot.
 *
 * The four-slot order below was validated against the light chart surface on
 * the all-pairs list (scatter-type form): lightness band, chroma floor, CVD
 * separation (worst dE 9.2 deutan), and normal-vision floor (worst dE 16.3)
 * all pass. The dark values are the same hues re-anchored for a dark surface.
 */

export interface ThemeTokens {
  surface: string;
  plane: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  series: readonly string[];
  other: string;
  status: Readonly<Record<'good' | 'warning' | 'serious' | 'critical', string>>;
}

export const LIGHT: ThemeTokens = {
  surface: '#fcfcfb',
  plane: '#f9f9f7',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7'],
  other: '#898781',
  status: {
    good: '#0ca30c',
    warning: '#fab219',
    serious: '#ec835a',
    critical: '#d03b3b',
  },
};

export const DARK: ThemeTokens = {
  surface: '#16171a',
  plane: '#101113',
  ink: '#f2f2f0',
  ink2: '#b9b8b4',
  muted: '#86857f',
  grid: '#2a2c30',
  axis: '#3c3f44',
  series: ['#5fa4f0', '#f4895c', '#3fcb96', '#9186e8'],
  other: '#86857f',
  status: {
    good: '#3dc23d',
    warning: '#f5c451',
    serious: '#f0a07e',
    critical: '#ef6a6a',
  },
};

export const FONT_STACK =
  'ui-sans-serif, system-ui, "Segoe UI", "Noto Sans KR", "Malgun Gothic", sans-serif';

export const MONO_STACK =
  'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Liberation Mono", monospace';

/** Colour for categorical slot `slot` (0-based), folding past slot 4. */
export function seriesColor(tokens: ThemeTokens, slot: number): string {
  return slot >= 0 && slot < tokens.series.length ? tokens.series[slot]! : tokens.other;
}
