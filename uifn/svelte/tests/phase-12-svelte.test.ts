import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render as renderClient, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import catalog from '../../catalog/generated/catalog.json';
import manifest from '../../evidence/generated/phase-12/phase-12-svelte-compounds.json';
import AccordionHarness from './fixtures/AccordionHarness.svelte';
import AllRootsHarness from './fixtures/AllRootsHarness.svelte';
import LifecycleHarness from './fixtures/LifecycleHarness.svelte';
import MenubarHarness from './fixtures/MenubarHarness.svelte';
import PortalFormHarness from './fixtures/PortalFormHarness.svelte';

afterEach(() => cleanup());

describe('TV-SVELTE-001-P: catalog-complete Svelte 5 compounds', () => {
  it('renders all 69 public compound roots from the generated catalog', async () => {
    const view = renderClient(AllRootsHarness, { props: { angleName: 'angle' } });
    await tick();
    expect(manifest.primitiveCount).toBe(69);
    expect(manifest.anatomyCount).toBe(465);
    expect(manifest.primitives.map((primitive) => primitive.id)).toEqual(
      catalog.primitives.map((primitive) => primitive.id),
    );
    for (const primitive of catalog.primitives) {
      expect(view.getByTestId(`${primitive.id}-root`)).toBeTruthy();
    }
    expect(view.getByTestId('angle-slider-root').hasAttribute('name')).toBe(false);
    expect(view.getByTestId('angle-slider-input').getAttribute('name')).toBe('angle');
    expect(view.getByTestId('form-root').getAttribute('action')).toBe('/save');
    expect(view.getByTestId('form-root').getAttribute('method')).toBe('post');
    expect(view.getByTestId('form-root').getAttribute('enctype')).toBe('multipart/form-data');
    await view.rerender({ angleName: 'bearing' });
    await tick();
    expect(view.getByTestId('angle-slider-input').getAttribute('name')).toBe('bearing');
  }, 20_000);

  it('runs core behavior through concrete compound parts and bind:value', async () => {
    const view = renderClient(AccordionHarness);
    const trigger = view.getByRole('button', { name: 'First section' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);
    await tick();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(view.getByTestId('accordion-value').textContent).toContain('one');
  });

  it('updates controller inputs without recreating the live service', async () => {
    const view = renderClient(LifecycleHarness, { props: { value: [] } });
    await tick();
    const diagnostic = view.getByTestId('lifecycle');
    const generation = diagnostic.getAttribute('data-generation');
    const domGeneration = diagnostic.getAttribute('data-dom-generation');
    const domDestroyCount = diagnostic.getAttribute('data-dom-destroy-count');
    expect(generation).toBe('2');
    expect(Number(domGeneration)).toBeGreaterThan(0);
    await view.rerender({ value: ['one'] });
    await tick();
    expect(diagnostic.getAttribute('data-generation')).toBe(generation);
    expect(diagnostic.getAttribute('data-dom-generation')).toBe(domGeneration);
    expect(diagnostic.getAttribute('data-dom-destroy-count')).toBe(domDestroyCount);
    expect(diagnostic.getAttribute('data-value')).toBe('["one"]');
  });

  it('uses DOM-owned portals and native form participation', async () => {
    const view = renderClient(PortalFormHarness);
    await tick();
    const portal = view.getByTestId('dialog-portal');
    expect(portal.parentElement).toBe(document.body);
    const control = view.getByTestId('checkbox-control');
    expect(control.getAttribute('type')).toBe('button');
    await fireEvent.click(control);
    await tick();
    expect(view.getByTestId('checked-value').textContent).toBe('true');
    const input = view.container.querySelector<HTMLInputElement>('input[name="terms"]');
    expect(input?.checked).toBe(true);
    expect(input?.value).toBe('accepted');
  });

  it('moves Menubar focus after Svelte commits and restores it on Escape', async () => {
    const view = renderClient(MenubarHarness);
    const trigger = view.getByRole('menuitem', { name: 'File' });
    const item = view.getByRole('menuitem', { name: 'New file', hidden: true });
    const content = view.getByTestId('menubar-content');

    trigger.focus();
    await fireEvent.keyDown(trigger, { key: 'Enter' });
    await tick();
    await waitFor(() => expect(document.activeElement).toBe(item));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(content.hasAttribute('hidden')).toBe(false);

    await fireEvent.keyDown(item, { key: 'Escape' });
    await tick();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(content.hasAttribute('hidden')).toBe(true);
  });
});
