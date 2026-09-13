/** Layout only: component appearance belongs to @uifn/components/styles.css. */
export function fixtureCss(): string {
  return `.preset-fixture{padding:1.5rem;font-family:var(--uifn-typography-family-sans);color:var(--uifn-color-text-primary);}
.preset-fixture h1,.preset-fixture h2{font-family:var(--uifn-typography-family-heading);}
.preset-fixture-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));}
.preset-fixture-row{display:flex;gap:.5rem;flex-wrap:wrap;}`;
}
