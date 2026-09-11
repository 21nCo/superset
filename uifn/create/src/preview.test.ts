// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { PRESET_FIELD_ORDER } from '@uifn/registry/preset';

it('renders public components and schema controls with working tabs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.innerHTML = '<div id="app"></div>';
  await act(async () => { await import('./main'); });
  await vi.waitFor(() => expect(document.querySelector('[data-uifn-component="button"]')).not.toBeNull());
  expect([...document.querySelectorAll('select[data-axis]')].map(element => element.getAttribute('data-axis'))).toEqual([...PRESET_FIELD_ORDER]);
  expect(document.querySelector('[data-uifn-component="table"] table')).not.toBeNull();
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs).toHaveLength(2);
  await act(async () => { tabs[1].click(); });
  await vi.waitFor(() => expect(tabs[1].getAttribute('aria-selected')).toBe('true'));
  expect(document.querySelectorAll('[role="tabpanel"]').length).toBeGreaterThan(0);
  const trigger = document.querySelector<HTMLButtonElement>('[data-uifn-component="select"][data-uifn-part="trigger"]')!;
  await act(async () => { trigger.click(); });
  const option = document.querySelector<HTMLElement>('[role="option"][data-value="staging"]')!;
  await act(async () => { option.click(); });
  expect(document.querySelector('[data-uifn-component="select"][data-uifn-part="valueText"]')?.textContent).toBe('Staging');
  const style = [...document.querySelectorAll('style')].map(node => node.textContent).join('');
  expect(style).not.toContain('.uifn-button{');
  expect(style).toContain('fonts.googleapis.com');
});
