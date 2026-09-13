# UIFnPresetV1

Canonical, versioned preset contract shared by the CLI, compiler, and `uifn/create` editor.

Ownership: `uifn-maintainer`. Schema version `1` is immutable once encoded. Unknown future versions fail closed with `UIFN_PRESET_UNSUPPORTED_VERSION`. Unknown fields and option values fail closed.

## Encoding

Preset codes are self-contained. Equivalent normalized configurations encode to the same URL-safe code:

```text
uifn1_<base64url(version || field-indices || crc8)>
```

No credentials, paths, identities, or private registry material are permitted in a code.

## Axes

| Field | Defaults | Notes |
| --- | --- | --- |
| `style` | `nova` | Original families: nova, meridian, atlas |
| `baseColor` | `zinc` | Neutral hue/chroma family |
| `theme` | `default` | `default` or `high-contrast` |
| `chartColor` | `spectrum` | Chart palette |
| `font` / `headingFont` | `inter` / `inherit` | Families with system fallbacks; stylesheets are optional URLs, not vendored files |
| `iconLibrary` | `lucide` | Package name only; MIT catalogs |
| `radius` / `density` / `menuTreatment` | `md` / `comfortable` / `elevated` | Token-backed |
| `framework` / `installMode` | `react` / `package` | Encoded for all stable frameworks; V1 mutation supports `react-vite` only |

## Approved V1 support matrix

- Template: `react-vite`
- Framework: `react`
- Package manager: `npm`
- Install modes: `package`, `source`
- Partial apply: `theme`, `font`

Svelte and Solid remain valid encoded values so a shared visual preset can be reopened later. `uifn init` and `uifn apply` reject them until those adapters are approved.

## Commands

```bash
uifn preset encode --style atlas --base-color mauve
uifn preset decode uifn1_...
uifn preset url uifn1_...
uifn preset open uifn1_...
uifn preset resolve --cwd .
uifn init --preset uifn1_... --dry-run
uifn apply --preset uifn1_... --only theme,font --dry-run
```

Mutating commands plan first. Reapplying an identical preset is a no-op. Consumer-modified managed files return `UIFN_REGISTRY_DIRTY_CONFLICT` with base/local/incoming hashes. Interrupted writes roll back through the existing registry transaction.

## Compatibility

V1 decoders must remain available for the life of schema version 1. Adding a field requires a new schema version, documented defaults, and a new code prefix.

## Safe application and public previews

Apply requires valid managed preset state. Existing files without a recorded base
hash, and locally edited managed files, are conflicts. Partial apply retains all
untouched hashes and merges only the selected theme or font axes. Theme includes
style, color, theme contrast, chart, radius, density and menu tokens; font includes body and heading.
A source-mode dry run lists the complete trusted registry plan without creating the
project directory. Failed initialization removes only directories it created that
are empty after rollback.

Create and generated React apps render the same `presetFixtureTree` using public
styled components and `@uifn/components/styles.css`. Source mode imports the same
parts from registry-installed files. Fixture CSS owns layout only. Tests compare
package/source rendered HTML and exercise the editor's actual public tabs.
Visual baseline approval remains separate from functional parity and build checks.
