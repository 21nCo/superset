---
title: core — Theme
description: ThemeConfig and CSS generation in @docsfn/core.
---

# Theme (`@docsfn/core`)

## `ThemeConfig`

Optional nested object:

- **`colors`** — `primary`, `secondary`, `background`, `foreground`, `muted`, `accent`, `destructive`, `border`.
- **`fonts`** — `sans`, `mono`.
- **`spacing`** — `container`, `section`.
- **`darkMode`** — `"class"` \| `"media"` \| `false`.

## `generateThemeCSS(config)`

Returns a `:root { ... }` string of **`--docsfn-*`** custom properties for every provided key (see [Theming](../../core-concepts/theming)).

**Note:** `destructive` color is accepted on **`ThemeConfig`** but may not yet emit a CSS variable — set manually if needed.

## Presets

- **`defaultLightTheme`**
- **`defaultDarkTheme`**

## `DocsTheme`

`{ config: ThemeConfig; className: string }` — used when bundling class-based dark mode toggles.
