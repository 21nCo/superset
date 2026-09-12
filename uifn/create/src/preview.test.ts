// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PRESET_FIELD_ORDER } from '@uifn/registry/preset';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('renders public components and schema controls with working tabs', async () => {
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

it('portals the positioner together with its select content', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SelectRoot, SelectPositioner, SelectContent } = await import('@uifn/components-react/select');
  const host = document.createElement('div');
  const portal = document.createElement('div');
  document.body.append(host, portal);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(SelectRoot, {},
      React.createElement(SelectPositioner, { container: portal }, React.createElement(SelectContent, { forceMount: true }, 'Popup')))));
    const positioner = portal.querySelector('[data-uifn-part="positioner"]');
    expect(positioner?.querySelector('[data-uifn-part="content"]')?.textContent).toBe('Popup');
    expect(host.querySelector('[data-uifn-part="positioner"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); portal.remove(); }
});

it('rejects a container supplied on content inside its positioner', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SelectRoot, SelectPositioner, SelectContent } = await import('@uifn/components-react/select');
  const host = document.createElement('div');
  document.body.append(host);
  class Boundary extends React.Component<{ children?: React.ReactNode }, { error?: Error }> {
    state: { error?: Error } = {};
    static getDerivedStateFromError(error: Error) { return { error }; }
    render() { return this.state.error ? this.state.error.message : this.props.children; }
  }
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Boundary, {}, React.createElement(SelectRoot, {},
      React.createElement(SelectPositioner, {}, React.createElement(SelectContent, { container: document.body, forceMount: true }, 'Popup'))))));
    expect(host.textContent).toContain('Pass container to Positioner');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('keeps automatic portals inside the root iframe document', async () => {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SelectRoot, SelectPositioner, SelectContent } = await import('@uifn/components-react/select');
  const frame = document.createElement('iframe'); document.body.append(frame);
  const owner = frame.contentDocument!;
  const host = owner.createElement('div'); owner.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(SelectRoot, {}, React.createElement(SelectPositioner, {}, React.createElement(SelectContent, { forceMount: true }, 'Iframe popup')))));
    const popup = owner.body.querySelector('[data-uifn-part="positioner"]');
    expect(popup?.textContent).toBe('Iframe popup');
    expect(popup?.parentElement).toBe(owner.body);
    expect(document.body.textContent).not.toContain('Iframe popup');
  } finally { await act(async () => root.unmount()); frame.remove(); }
});
