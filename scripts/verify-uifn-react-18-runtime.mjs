#!/usr/bin/env node

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import React from 'react';
import { JSDOM } from 'jsdom';
import { hydrateRoot } from 'react-dom/client';
import { renderToPipeableStream, renderToString } from 'react-dom/server.node';
import * as UIFnReact from '../uifn/react/dist/index.mjs';

assert.equal(React.version, '18.3.1');
assert.equal(typeof globalThis.document, 'undefined');
const tabs = React.createElement(UIFnReact.Tabs, { defaultValue: 'account', items: ['account'] },
  React.createElement(UIFnReact.Tabs.List, null,
    React.createElement(UIFnReact.Tabs.Trigger, { value: 'account' }, 'Account')),
  React.createElement(UIFnReact.Tabs.Content, { value: 'account' }, 'Panel'));
const first = renderToString(tabs);
assert.equal(renderToString(tabs), first);
assert.match(first, /Account/);

const streamHtml = await new Promise((resolve, reject) => {
  let html = '';
  const sink = new PassThrough();
  sink.setEncoding('utf8');
  sink.on('data', (chunk) => { html += chunk; });
  sink.on('end', () => resolve(html));
  sink.on('error', reject);
  const accordion = React.createElement(UIFnReact.Accordion, { defaultValue: ['profile'] },
    React.createElement(UIFnReact.Accordion.Trigger, { value: 'profile' }, 'Profile'));
  const stream = renderToPipeableStream(React.createElement(React.Suspense, { fallback: 'loading' }, accordion), {
    onAllReady: () => stream.pipe(sink),
    onError: reject,
  });
});
assert.match(streamHtml, /Profile/);

const hydrationApp = React.createElement(UIFnReact.Collapsible, { defaultOpen: true },
  React.createElement(UIFnReact.Collapsible.Trigger, null, 'Open'),
  React.createElement(UIFnReact.Collapsible.Content, null, 'Content'));
const hydrationHtml = renderToString(hydrationApp);
const dom = new JSDOM(`<!doctype html><html><body><div id="root">${hydrationHtml}</div></body></html>`, { url: 'https://example.test/' });
for (const key of ['window','document','navigator','Node','Element','HTMLElement','HTMLFormElement','HTMLInputElement','ShadowRoot','MutationObserver','DOMRect','Event','MouseEvent','KeyboardEvent','PointerEvent']) {
  const value = dom.window[key];
  if (value) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle.bind(dom.window), configurable: true, writable: true });
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class {
  constructor(_callback, _options) {}
  observe() {}
  unobserve() {}
  disconnect() {}
};
const warnings = [];
const originalError = console.error;
const originalWarn = console.warn;
console.error = (...args) => warnings.push(['error', ...args]);
console.warn = (...args) => warnings.push(['warn', ...args]);
const container = document.getElementById('root');
const hydrated = hydrateRoot(container, hydrationApp, { onRecoverableError: (error) => warnings.push(['recoverable', error]) });
await new Promise((resolve) => setTimeout(resolve, 50));
assert.match(container.textContent, /Content/);
hydrated.unmount();
await new Promise((resolve) => setTimeout(resolve, 0));
console.error = originalError;
console.warn = originalWarn;
assert.deepEqual(warnings, []);
console.log(JSON.stringify({
  ok: true,
  command: 'verify:uifn-react-18-runtime',
  react: React.version,
  workspaceBuildConsumer: true,
  rscSafeImport: true,
  deterministicSsr: true,
  streamingSsr: true,
  hydration: true,
  abruptUnmount: true,
  warnings: 0,
}, null, 2));
