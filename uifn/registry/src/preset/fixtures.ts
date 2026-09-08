import type { PresetCompilePlan } from './compiler';

export function fixtureMarkup(plan: PresetCompilePlan): string {
  const { preset, theme } = plan;
  const chart = theme.chartPalette.map((color, index) => `<span class="uifn-chart-swatch" style="background:${color}" title="series ${index + 1}"></span>`).join('');
  return `<section class="uifn-fixture" data-uifn-style="${preset.style}" data-uifn-density="${preset.density}" data-uifn-menu="${preset.menuTreatment}" data-uifn-radius="${preset.radius}">
  <header class="uifn-fixture-header">
    <p class="uifn-kicker">Public token preview</p>
    <h1>Workspace overview</h1>
    <p>These fixtures are painted only with public <code>--uifn-*</code> variables. Catalog CSS does not own component appearance.</p>
  </header>
  <div class="uifn-fixture-grid">
    <article class="uifn-card" data-uifn-component="card" data-uifn-part="root">
      <h2>Actions</h2>
      <div class="uifn-row">
        <button data-uifn-component="button" data-uifn-part="root" type="button">Continue</button>
        <button data-uifn-component="button" data-uifn-part="root" data-uifn-variant="secondary" type="button">Secondary</button>
        <button data-uifn-component="button" data-uifn-part="root" data-uifn-variant="outline" type="button">Outline</button>
        <button data-uifn-component="button" data-uifn-part="root" data-uifn-variant="danger" type="button">Delete</button>
      </div>
    </article>
    <article class="uifn-card" data-uifn-component="card" data-uifn-part="root">
      <h2>Field</h2>
      <label class="uifn-field" data-uifn-component="field" data-uifn-part="root">
        <span data-uifn-component="field" data-uifn-part="label">Project name</span>
        <input data-uifn-component="input" data-uifn-part="root" value="Northwind" />
      </label>
      <label class="uifn-check">
        <input data-uifn-component="checkbox" data-uifn-part="control" data-state="checked" type="checkbox" checked />
        <span>Send weekly digest</span>
      </label>
      <label class="uifn-switch">
        <input data-uifn-component="switch" data-uifn-part="control" data-state="checked" type="checkbox" role="switch" checked />
        <span>Live preview</span>
      </label>
    </article>
    <article class="uifn-card" data-uifn-component="card" data-uifn-part="root">
      <h2>Navigation</h2>
      <div class="uifn-tabs" role="tablist">
        <button data-uifn-component="tabs" data-uifn-part="trigger" type="button" role="tab" aria-selected="true">Overview</button>
        <button data-uifn-component="tabs" data-uifn-part="trigger" type="button" role="tab">Members</button>
        <button data-uifn-component="tabs" data-uifn-part="trigger" type="button" role="tab">Billing</button>
      </div>
      <div class="uifn-menu" data-treatment="${preset.menuTreatment}">
        <button type="button">Open menu</button>
        <div class="uifn-menu-panel">
          <button data-uifn-component="menu" data-uifn-part="item" type="button">Duplicate</button>
          <button data-uifn-component="menu" data-uifn-part="item" type="button">Archive</button>
          <button data-uifn-component="menu" data-uifn-part="item" type="button">Share</button>
        </div>
      </div>
    </article>
    <article class="uifn-card" data-uifn-component="card" data-uifn-part="root">
      <h2>Table</h2>
      <table class="uifn-table" data-uifn-component="table" data-uifn-part="root">
        <thead><tr><th>Name</th><th>Status</th><th>Load</th></tr></thead>
        <tbody>
          <tr><td>Ingest</td><td>Ready</td><td>12%</td></tr>
          <tr><td>Compile</td><td>Running</td><td>64%</td></tr>
          <tr><td>Publish</td><td>Queued</td><td>4%</td></tr>
        </tbody>
      </table>
      <div class="uifn-chart" aria-label="Chart palette">${chart}</div>
    </article>
  </div>
</section>`;
}

export function fixtureCss(): string {
  return `.uifn-fixture{font-family:var(--uifn-typography-family-sans);color:var(--uifn-color-text-primary);background:var(--uifn-color-surface-canvas);padding:1.5rem;min-height:100%;}
.uifn-fixture h1,.uifn-fixture h2{font-family:var(--uifn-typography-family-heading);margin:0 0 .5rem;}
.uifn-kicker{color:var(--uifn-color-text-muted);text-transform:uppercase;letter-spacing:.08em;font-size:.75rem;margin:0 0 .35rem;}
.uifn-fixture-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));}
.uifn-card{padding:1rem;}
.uifn-row,.uifn-tabs{display:flex;flex-wrap:wrap;gap:.5rem;}
.uifn-field{display:grid;gap:.35rem;margin:0 0 .75rem;color:var(--uifn-color-text-secondary);}
.uifn-check,.uifn-switch{display:flex;gap:.5rem;align-items:center;margin:.4rem 0;color:var(--uifn-color-text-secondary);}
.uifn-menu{position:relative;margin-top:.75rem;}
.uifn-menu-panel{margin-top:.5rem;display:grid;background:var(--uifn-color-surface-overlay);border:1px solid var(--uifn-color-border-default);border-radius:var(--uifn-radius-md);overflow:hidden;}
.uifn-menu[data-treatment="inset"] .uifn-menu-panel{background:var(--uifn-color-surface-sunken);}
.uifn-menu[data-treatment="bordered"] .uifn-menu-panel{border-width:2px;border-color:var(--uifn-color-border-strong);}
.uifn-menu[data-treatment="elevated"] .uifn-menu-panel{box-shadow:0 18px 48px rgb(15 23 42 / 16%);}
.uifn-table{width:100%;border-collapse:collapse;font-size:.9rem;}
.uifn-table th,.uifn-table td{border-bottom:1px solid var(--uifn-color-border-subtle);padding:.45rem 0;text-align:left;}
.uifn-chart{display:flex;gap:.4rem;margin-top:.75rem;}
.uifn-chart-swatch{flex:1;height:2rem;border-radius:var(--uifn-radius-sm);}
@media (prefers-reduced-motion: reduce){.uifn-button,.uifn-input,.uifn-menu-panel{transition:none;}}`;
}
