# @uifn/react

Headless React adapter for `uifn` primitives.

`@uifn/react` is permanently headless. It renders accessible behavior and
anatomy from `@uifn/core` and `@uifn/dom`, but it does not ship visual CSS,
tokens, themes, or component styling. Use it to build a design system; use
`@uifn/components-react` plus `@uifn/components/styles.css` for the maintained
styled compounds.

SFN-15 requires this package to expose React hooks, compound components, optional slot-style composition, headless prop getters, SSR/hydration coverage, and conformance through `@uifn/adapter-kit`.

Status: `ga-candidate`.

Layer: `adapter`.

## Workbench

The React Workbench app is `@uifn/example-react-workbench` under `uifn/examples/react-workbench`.

```bash
npm --workspace @uifn/examples run dev:react
npm run verify:uifn-browser -- --framework react
```

For Select, Menu, and ContextMenu popups, pass a custom `container` to `Positioner` when nesting `Content` inside it. Positioner and Content share that portal; a nested Content container throws a descriptive error. A standalone Content can receive its own container.
