---
title: Theming
description: docsfn theme configuration, CSS custom properties, Tailwind, and dark mode.
---

# Theming

docsfn themes are plain **`ThemeConfig`** objects: colors, fonts, spacing, and a **`darkMode`** strategy. **`generateThemeCSS`** turns that config into **`:root`** declarations using the **`--docsfn-*`** custom property namespace.

See also: [Configuration](./configuration).

## CSS custom properties (`--docsfn-*`)

`generateThemeCSS` emits variables **only for keys you set**. Supported outputs today (these match **`@docsfn/svelte/theme.css`** and **`@docsfn/react/theme.css`**):

| Token | CSS variable |
| --- | --- |
| `colors.primary` | `--docsfn-color-primary` |
| `colors.secondary` | `--docsfn-color-secondary` |
| `colors.background` | `--docsfn-color-bg` |
| `colors.foreground` | `--docsfn-color-fg` |
| `colors.muted` | `--docsfn-color-muted` |
| `colors.accent` | `--docsfn-color-accent-soft` |
| `colors.border` | `--docsfn-color-border` |
| `fonts.sans` | `--docsfn-font-sans` |
| `fonts.mono` | `--docsfn-font-mono` |
| `spacing.container` | `--docsfn-container` |
| `spacing.section` | `--docsfn-section` |

**Default theme CSS** also defines related tokens (override in your own CSS after importing the theme): `--docsfn-color-surface`, `--docsfn-color-surface-raised`, `--docsfn-color-primary-hover`, `--docsfn-color-primary-fg`, and code-block colors.

**Note:** `ThemeConfig.colors.destructive` is a valid config field for your own UI, but **`generateThemeCSS` does not yet emit** a matching variable. Set it manually in CSS if needed.

## `ThemeConfig` structure

```ts
type DarkModeStrategy = "class" | "media" | false;

interface ThemeConfig {
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
  darkMode?: DarkModeStrategy;
}
```

## Default presets

Core exports:

- **`defaultLightTheme`** — light surfaces, `darkMode: "class"`.
- **`defaultDarkTheme`** — dark surfaces, `darkMode: "class"`.

Use them as starting points and override individual keys.

## Overriding in CSS

Because tokens are ordinary custom properties, you can override them in global CSS:

```css
:root {
  --docsfn-color-primary: hsl(220 90% 56%);
  --docsfn-color-bg: hsl(0 0% 98%);
  --docsfn-color-border: hsl(214 32% 91%);
}
```

For dark mode, either repeat tokens inside `@media (prefers-color-scheme: dark) { :root { ... } }` (to override the default theme’s dark palette) or scope class-based themes under `.dark` / `html.dark` depending on your app.

For dark mode with **`darkMode: "class"`**, scope overrides under `.dark` (or your root dark class) in your app.

## Tailwind integration

Map docsfn tokens in `tailwind.config` (v4 theme or `@theme`) so utilities align with components:

```js
// Example: tailwind v3-style extension (adapt for v4 @theme as needed)
theme: {
  extend: {
    colors: {
      primary: "var(--docsfn-color-primary)",
      background: "var(--docsfn-color-bg)",
    },
    fontFamily: {
      sans: ["var(--docsfn-font-sans)", "system-ui", "sans-serif"],
      mono: ["var(--docsfn-font-mono)", "ui-monospace", "monospace"],
    },
    maxWidth: {
      docs: "var(--docsfn-container)",
    },
  },
},
```

## Dark mode strategies

| `darkMode` | Behavior |
| --- | --- |
| `"class"` | You toggle a class on `<html>` or `<body>`; pair with CSS overrides for dark palettes. |
| `"media"` | Rely on **`prefers-color-scheme`** in your own CSS (docsfn tokens are still single `:root` unless you branch). |
| `false` | No built-in switching hook; supply static colors only. |

`defaultLightTheme` / `defaultDarkTheme` both use **`"class"`** so adapters can swap themes predictably.
