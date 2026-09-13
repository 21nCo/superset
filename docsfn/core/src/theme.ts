export interface ThemeConfig {
  colors?: {
    primary?: string;
    secondary?: string;
    background?: string;
    foreground?: string;
    muted?: string;
    accent?: string;
    destructive?: string;
    border?: string;
  };
  fonts?: {
    sans?: string;
    mono?: string;
  };
  spacing?: {
    container?: string;
    section?: string;
  };
  darkMode?: "class" | "media" | false;
}

export interface DocsTheme {
  config: ThemeConfig;
  className: string;
}

/**
 * Generate CSS custom properties from theme config
 */
export function generateThemeCSS(config: ThemeConfig): string {
  const { colors = {}, fonts = {}, spacing = {} } = config;

  const properties: string[] = [];

  // Colors — names match --docsfn-color-* convention used by theme CSS
  if (colors.primary) properties.push(`--docsfn-color-primary: ${colors.primary};`);
  if (colors.secondary) properties.push(`--docsfn-color-secondary: ${colors.secondary};`);
  if (colors.background) properties.push(`--docsfn-color-bg: ${colors.background};`);
  if (colors.foreground) properties.push(`--docsfn-color-fg: ${colors.foreground};`);
  if (colors.muted) properties.push(`--docsfn-color-muted: ${colors.muted};`);
  if (colors.accent) properties.push(`--docsfn-color-accent-soft: ${colors.accent};`);
  if (colors.border) properties.push(`--docsfn-color-border: ${colors.border};`);

  // Fonts
  if (fonts.sans) properties.push(`--docsfn-font-sans: ${fonts.sans};`);
  if (fonts.mono) properties.push(`--docsfn-font-mono: ${fonts.mono};`);

  // Spacing
  if (spacing.container) properties.push(`--docsfn-container: ${spacing.container};`);
  if (spacing.section) properties.push(`--docsfn-section: ${spacing.section};`);

  return `:root {\n  ${properties.join("\n  ")}\n}`;
}

/**
 * Default light theme
 */
export const defaultLightTheme: ThemeConfig = {
  colors: {
    primary: "hsl(222, 47%, 11%)",
    secondary: "hsl(210, 40%, 96%)",
    background: "hsl(0, 0%, 100%)",
    foreground: "hsl(222, 47%, 11%)",
    muted: "hsl(210, 40%, 96%)",
    accent: "hsl(210, 40%, 96%)",
    border: "hsl(214, 32%, 91%)",
  },
  fonts: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Monaco, Consolas, monospace',
  },
  spacing: {
    container: "1280px",
    section: "2rem",
  },
  darkMode: "class",
};

/**
 * Default dark theme
 */
export const defaultDarkTheme: ThemeConfig = {
  colors: {
    primary: "hsl(210, 40%, 98%)",
    secondary: "hsl(217, 33%, 17%)",
    background: "hsl(222, 47%, 11%)",
    foreground: "hsl(210, 40%, 98%)",
    muted: "hsl(217, 33%, 17%)",
    accent: "hsl(217, 33%, 17%)",
    border: "hsl(217, 33%, 17%)",
  },
  darkMode: "class",
};
