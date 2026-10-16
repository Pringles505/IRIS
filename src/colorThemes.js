function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;

  const int = Number.parseInt(full, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

export function withAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const colorThemes = {
  uiBase: '#080D1A',             // Main app chrome — deep navy
  uiRaised: '#06091A',           // Top bars and elevated shells
  uiField: '#0D1326',            // Inputs and inset surfaces
  uiAccentSurface: '#0E1830',    // Active blue button surface
  uiBorderStrong: '#142038',     // Primary borders
  uiBorderSoft: '#0F1830',       // Secondary borders

  canvasBackground: '#0A0F1E',   // Main diagram canvas background
  canvasTexturePrimary: '#76A8FF',
  canvasTextureSecondary: '#5076D6',
  canvasTextureTertiary: '#385CA8',

  textMain: '#E5E7EB',
  textMuted: '#94A3B8',
  textDim: '#5B6B86',
  textFaint: '#2F3A4E',

  purpleAccent: '#3B82F6',       // Logo-matching blue (was purple #8a5bd6)
  blueMain: '#1D4ED8',           // Logo's primary blue — ring, arms, play triangle
  blueBright: '#7FB0FF',
  blueSelection: '#93C5FD',
  blueLink: '#60A5FA',
  blueNodeFill: '#0E1E40',
  blueNodeStroke: '#3B82F6',

  successMain: '#10B981',
  successDark: '#065F46',
  successBright: '#34D399',

  warningMain: '#F59E0B',
  warningBright: '#FBBF24',
  warningSoft: '#FDE68A',

  tokenMain: '#D946EF',          // Timeline tokens — distinct from blue links
  tokenBright: '#E879F9',

  dangerMain: '#EF4444',
  dangerBright: '#F87171',
  dangerSoft: '#FCA5A5',

  rulerText: '#4B5563',
  rulerMajorTick: '#374151',
  rulerMinorTick: '#1F2937',
  timelineTextMuted: '#6B7280',
  timelineSectionBackground: '#06080F',
  timelineRowDivider: '#0D1117',

  scrollbarThumb: '#1A2E50',
  scrollbarThumbHover: '#2A4470',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
};

export const pageColors = {
  ...colorThemes,
  inputFocusRing: withAlpha(colorThemes.purpleAccent, 0.14),
  purpleSurfaceSoft: withAlpha(colorThemes.purpleAccent, 0.22),
  purpleSurfacePanel: withAlpha(colorThemes.purpleAccent, 0.24),
  purpleBorderSoft: withAlpha(colorThemes.purpleAccent, 0.45),
  purpleBorderStrong: withAlpha(colorThemes.purpleAccent, 0.5),
  purpleGlow: withAlpha(colorThemes.purpleAccent, 0.45),
  purpleHover: withAlpha(colorThemes.purpleAccent, 0.18),

  blueSurfaceSoft: withAlpha(colorThemes.blueLink, 0.15),
  blueLinkDim: withAlpha(colorThemes.blueLink, 0.3),

  dangerSurfaceSoft: withAlpha(colorThemes.dangerMain, 0.1),
  dangerBorderSoft: withAlpha(colorThemes.dangerMain, 0.2),
  dangerLineSoft: withAlpha(colorThemes.dangerMain, 0.65),
  dangerGlow: withAlpha(colorThemes.dangerMain, 0.55),
  dangerTooltip: withAlpha(colorThemes.dangerMain, 0.9),

  warningSurfaceSoft: withAlpha(colorThemes.warningMain, 0.08),
  warningBorderSoft: withAlpha(colorThemes.warningMain, 0.18),

  canvasGridDot: withAlpha(colorThemes.blueBright, 0.28),
  canvasGridMinor: withAlpha(colorThemes.blueBright, 0.025),
  canvasGridMajor: withAlpha(colorThemes.blueBright, 0.12),
  canvasTexturePrimarySoft: withAlpha(colorThemes.canvasTexturePrimary, 0.18),
  canvasTextureSecondarySoft: withAlpha(colorThemes.canvasTextureSecondary, 0.14),
  canvasTextureTertiarySoft: withAlpha(colorThemes.canvasTextureTertiary, 0.12),
  whiteVeilSoft: withAlpha(colorThemes.white, 0.03),
  whiteVeilFaint: withAlpha(colorThemes.white, 0.025),
  whiteHintSoft: withAlpha(colorThemes.white, 0.12),
  whiteHintDim: withAlpha(colorThemes.white, 0.2),
  whiteInnerHighlight: withAlpha(colorThemes.white, 0.08),

  blackShadowNode: withAlpha(colorThemes.black, 0.45),
  blackShadowMenu: withAlpha(colorThemes.black, 0.6),
  // Use fully transparent hit areas to avoid any chance of dark tinting during
  // group opacity/scale compositing in Konva
  blackHitArea: colorThemes.transparent,

  timelineSectionBorder: withAlpha(colorThemes.purpleAccent, 0.13),
  timelineHeaderGlow: withAlpha(colorThemes.purpleAccent, 0.18),
  timelineHeaderBorder: withAlpha(colorThemes.purpleAccent, 0.35),
};

export const cssColorVars = {
  '--app-bg': pageColors.uiBase,
  '--panel-bg': pageColors.uiBase,
  '--panel-bg-2': pageColors.uiRaised,
  '--panel-bg-3': pageColors.uiField,
  '--panel-blue': pageColors.uiAccentSurface,
  '--border-strong': pageColors.uiBorderStrong,
  '--border-soft': pageColors.uiBorderSoft,
  '--text-main': pageColors.textMain,
  '--text-muted': pageColors.textMuted,
  '--text-dim': pageColors.textDim,
  '--text-faint': pageColors.textFaint,
  '--purple-main': pageColors.purpleAccent,
  '--purple-bright': pageColors.purpleAccent,
  '--blue-main': pageColors.blueMain,
  '--blue-bright': pageColors.blueBright,
  '--white': pageColors.white,
  '--transparent': pageColors.transparent,
  '--success-main': pageColors.successMain,
  '--success-dark': pageColors.successDark,
  '--success-bright': pageColors.successBright,
  '--warning-main': pageColors.warningMain,
  '--warning-bright': pageColors.warningBright,
  '--warning-soft': pageColors.warningSoft,
  '--warning-surface-soft': pageColors.warningSurfaceSoft,
  '--warning-border-soft': pageColors.warningBorderSoft,
  '--danger-main': pageColors.dangerMain,
  '--danger-bright': pageColors.dangerBright,
  '--danger-soft': pageColors.dangerSoft,
  '--danger-surface-soft': pageColors.dangerSurfaceSoft,
  '--danger-border-soft': pageColors.dangerBorderSoft,
  '--purple-surface-soft': pageColors.purpleSurfaceSoft,
  '--purple-surface-panel': pageColors.purpleSurfacePanel,
  '--purple-border-soft': pageColors.purpleBorderSoft,
  '--purple-border-strong': pageColors.purpleBorderStrong,
  '--purple-glow': pageColors.purpleGlow,
  '--purple-hover': pageColors.purpleHover,
  '--input-focus-ring': pageColors.inputFocusRing,
  '--scrollbar-thumb': pageColors.scrollbarThumb,
  '--scrollbar-thumb-hover': pageColors.scrollbarThumbHover,
  '--menu-shadow': pageColors.blackShadowMenu,
};

export function applyColorTheme(target = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!target) return;
  for (const [name, value] of Object.entries(cssColorVars)) {
    target.style.setProperty(name, value);
  }
}
