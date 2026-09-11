import { describe, expect, it } from 'vitest';
import { PRESET_AXES, PRESET_FIELD_ORDER, compilePreset, encodePreset, presetFromUrl } from '@uifn/registry/preset';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('create editor contract', () => {
  it('derives every control from the canonical preset axes', () => {
    const source = readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    expect(source).toContain('PRESET_FIELD_ORDER.map');
    expect(source).toContain('PRESET_AXES[axis]');
    for (const axis of PRESET_FIELD_ORDER) {
      expect(PRESET_AXES[axis].length).toBeGreaterThan(1);
    }
  });

  it('shares encode/URL/compile with CLI', () => {
    const preset = { style: 'atlas', radius: 'sm' } as const;
    const plan = compilePreset({
      version: 1,
      style: 'atlas',
      baseColor: 'zinc',
      theme: 'default',
      chartColor: 'spectrum',
      font: 'inter',
      headingFont: 'inherit',
      iconLibrary: 'lucide',
      radius: 'sm',
      density: 'comfortable',
      menuTreatment: 'elevated',
      framework: 'react',
      installMode: 'package',
    });
    expect(plan.commands.init).toContain(encodePreset(preset));
    expect(presetFromUrl(plan.url).style).toBe('atlas');
  });
});

it('renders equivalent public components from package and source scaffolds', async () => {
  const { mkdtempSync, rmSync, readFileSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { initProject } = await import('../../registry/src/preset/project');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const parent = mkdtempSync(path.join(tmpdir(), 'uifn-public-parity-'));
  try {
    symlinkSync(path.resolve(__dirname, '../../../node_modules'), path.join(parent, 'node_modules'));
    const html: string[] = [];
    for (const installMode of ['package', 'source'] as const) {
      const rootDir = path.join(parent, installMode);
      expect(initProject({ rootDir, preset: encodePreset({ installMode }) }).ok).toBe(true);
      const source = readFileSync(path.join(rootDir, 'src/App.tsx'), 'utf8');
      expect(source).not.toContain('dangerouslySetInnerHTML');
      expect(source).toContain(installMode === 'source' ? '../components/uifn/react/button' : '@uifn/components-react/button');
      const { App } = await import(/* @vite-ignore */ path.join(rootDir, 'src/App.tsx'));
      html.push(renderToStaticMarkup(createElement(App)));
    }
    expect(html[0]).toContain('data-uifn-component="button"');
    expect(html[0]).toEqual(html[1]);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
