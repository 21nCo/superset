import {
  PRESET_AXES,
  PRESET_AXIS_LABELS,
  PRESET_DEFAULTS,
  PRESET_FIELD_ORDER,
  compilePreset,
  encodePreset,
  fixtureCss,
  fixtureMarkup,
  normalizePreset,
  presetFromUrl,
  randomPreset,
  themeTokenDocument,
  type PresetAxis,
  type UIFnPresetV1,
} from '@uifn/registry/preset';
import '@uifn/components/styles.css';

const VIEWPORTS = {
  desktop: 1120,
  tablet: 768,
  mobile: 390,
} as const;

function parseState(): UIFnPresetV1 {
  try {
    return presetFromUrl(window.location.href);
  } catch {
    return { ...PRESET_DEFAULTS };
  }
}

function optionControl(axis: PresetAxis, preset: UIFnPresetV1, locked: Set<PresetAxis>): string {
  const options = (PRESET_AXES[axis] as readonly string[]).map((value) => `<option value="${value}" ${preset[axis] === value ? 'selected' : ''}>${value}</option>`).join('');
  return `<label class="axis">
    <span>
      <input type="checkbox" data-lock="${axis}" ${locked.has(axis) ? 'checked' : ''} />
      ${PRESET_AXIS_LABELS[axis]}
    </span>
    <select data-axis="${axis}">${options}</select>
  </label>`;
}

function render(preset: UIFnPresetV1, locked: Set<PresetAxis>, mode: 'light' | 'dark', viewport: keyof typeof VIEWPORTS) {
  const plan = compilePreset(preset);
  const tokens = themeTokenDocument(preset);
  const app = document.querySelector('#app');
  if (!app) return;
  app.innerHTML = `
    <header class="shell-header">
      <div>
        <p class="kicker">uifn Create</p>
        <h1>Versioned presets</h1>
      </div>
      <div class="header-actions">
        <button type="button" data-action="random">Randomize unlocked</button>
        <button type="button" data-action="copy-code">Copy code</button>
        <button type="button" data-action="copy-url">Copy URL</button>
      </div>
    </header>
    <main class="layout">
      <form class="controls" aria-label="Preset axes">
        ${PRESET_FIELD_ORDER.map((axis: PresetAxis) => optionControl(axis, preset, locked)).join('')}
      </form>
      <section class="preview-pane">
        <div class="preview-toolbar">
          <div class="segmented" role="group" aria-label="Color mode">
            <button type="button" data-mode="light" ${mode === 'light' ? 'aria-pressed="true"' : 'aria-pressed="false"'}>Light</button>
            <button type="button" data-mode="dark" ${mode === 'dark' ? 'aria-pressed="true"' : 'aria-pressed="false"'}>Dark</button>
          </div>
          <div class="segmented" role="group" aria-label="Viewport">
            ${Object.keys(VIEWPORTS).map((name) => `<button type="button" data-viewport="${name}" ${viewport === name ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${name}</button>`).join('')}
          </div>
        </div>
        <div class="preview-frame" data-mode="${mode}" style="width:${VIEWPORTS[viewport]}px">
          <style>${plan.css.light}${plan.css.dark}${fixtureCss()}</style>
          <div class="preview-root" data-uifn-mode="${mode}">${fixtureMarkup(plan)}</div>
        </div>
        <section class="outputs">
          <article>
            <h2>New project</h2>
            <pre><code>${plan.commands.init}</code></pre>
          </article>
          <article>
            <h2>Existing project</h2>
            <pre><code>${plan.commands.apply}</code></pre>
            <pre><code>${plan.commands.applyTheme}</code></pre>
          </article>
          <article>
            <h2>Preset code</h2>
            <pre><code>${plan.code}</code></pre>
            <p><a href="${plan.url}">${plan.url}</a></p>
          </article>
          <article>
            <h2>Theme tokens</h2>
            <pre><code>${JSON.stringify(tokens.light, null, 2)}</code></pre>
          </article>
        </section>
      </section>
    </main>
  `;
  const previewRoot = app.querySelector('.preview-root') as HTMLElement | null;
  if (previewRoot) {
    const vars = mode === 'dark' ? plan.theme.darkVars : plan.theme.lightVars;
    Object.entries(vars).forEach(([name, value]) => previewRoot.style.setProperty(name, String(value)));
    previewRoot.style.background = vars['--uifn-color-surface-canvas'];
    previewRoot.style.color = vars['--uifn-color-text-primary'];
    previewRoot.style.fontFamily = vars['--uifn-typography-family-sans'];
  }
}

function syncUrl(preset: UIFnPresetV1) {
  const url = new URL(window.location.href);
  url.searchParams.set('preset', encodePreset(preset));
  window.history.replaceState(null, '', `${url.pathname}${url.search}`);
}

function boot() {
  let preset = parseState();
  const locked = new Set<PresetAxis>(['framework', 'installMode']);
  let mode: 'light' | 'dark' = 'light';
  let viewport: keyof typeof VIEWPORTS = 'desktop';
  const paint = () => {
    syncUrl(preset);
    render(preset, locked, mode, viewport);
  };
  paint();
  document.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    const axis = target.getAttribute('data-axis') as PresetAxis | null;
    const lock = target.getAttribute('data-lock') as PresetAxis | null;
    if (axis && target instanceof HTMLSelectElement) {
      preset = normalizePreset({ ...preset, [axis]: target.value });
      paint();
    }
    if (lock && target instanceof HTMLInputElement) {
      if (target.checked) locked.add(lock);
      else locked.delete(lock);
    }
  });
  document.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const action = target.getAttribute('data-action');
    const nextMode = target.getAttribute('data-mode') as 'light' | 'dark' | null;
    const nextViewport = target.getAttribute('data-viewport') as keyof typeof VIEWPORTS | null;
    if (nextMode) { mode = nextMode; paint(); }
    if (nextViewport) { viewport = nextViewport; paint(); }
    if (action === 'random') { preset = randomPreset({ seed: Date.now(), locks: Object.fromEntries([...locked].map((axis) => [axis, true])), base: preset }); paint(); }
    if (action === 'copy-code') await navigator.clipboard?.writeText(encodePreset(preset));
    if (action === 'copy-url') await navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?preset=${encodePreset(preset)}`);
  });
}

boot();
