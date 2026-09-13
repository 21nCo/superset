# uifn Create

Private visual editor for versioned `UIFnPresetV1` codes.

The editor does not own component styling. Every control is generated from `PRESET_AXES` in `@uifn/registry/preset`. The preview renders public `@uifn/components-react` compounds with `@uifn/components/styles.css` and applies public `--uifn-*` CSS variables, the same contract written by `uifn init --preset` and `uifn apply --preset`.

```bash
npm --workspace @uifn/create run dev
```

Shareable URLs use `https://uifn.dev/create?preset=<code>`.
