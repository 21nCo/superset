import { For, createSignal, type Setter } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import catalog from '../../../catalog/generated/catalog.json';
import manifest from '../../../evidence/generated/phase-13/phase-13-solid-compounds.json';
import { Accordion, AngleSlider, Checkbox, Command, Dialog, Form, Input } from '../index.js';
import type { SolidPrimitiveBridge } from '../internal/compound.jsx';
import { createSolidPartPropsBinding, toSolidUserPartProps } from '../props.js';
import { AllRootsHarness } from './fixtures/AllRootsHarness.jsx';

const disposers: Array<() => void> = [];

function mount(component: () => unknown): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(component as never, host));
  return host;
}

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new TypeError('Expected a clickable HTMLElement.');
  element.click();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  document.body.innerHTML = '';
});

describe('TV-SOLID-001-P: catalog-complete native Solid compounds', () => {
  it('separates declared component inputs from intrinsic root props', async () => {
    const host = mount(() => (
      <>
        <Input aria-label="Work email" placeholder="you@company.com" />
        <Command placeholder="Type a command or search…">
          <Command.Label>Commands</Command.Label>
          <Command.Input />
          <Command.List />
        </Command>
      </>
    ));
    await settle();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Work email"]')?.placeholder).toBe('you@company.com');
    expect(host.querySelector<HTMLInputElement>('[role="combobox"]')?.placeholder).toBe('Type a command or search…');
  });

  it('routes AngleSlider form names through the public adapter', async () => {
    let setName!: Setter<string>;
    const host = mount(() => {
      const [name, updateName] = createSignal('angle');
      setName = updateName;
      return (
        <AngleSlider name={name()} data-testid="angle-root">
          <AngleSlider.HiddenInput data-testid="angle-input" />
        </AngleSlider>
      );
    });
    await settle();
    expect(host.querySelector('[data-testid="angle-root"]')?.hasAttribute('name')).toBe(false);
    expect(host.querySelector<HTMLInputElement>('[data-testid="angle-input"]')?.name).toBe('angle');
    setName('bearing');
    await settle();
    expect(host.querySelector<HTMLInputElement>('[data-testid="angle-input"]')?.name).toBe('bearing');
  });

  it('preserves native form submission attributes', async () => {
    const host = mount(() => (
      <Form.Root action="/save" method="post" enctype="multipart/form-data" data-testid="native-form" />
    ));
    await settle();
    const form = host.querySelector('[data-testid="native-form"]');
    expect(form?.getAttribute('action')).toBe('/save');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.getAttribute('enctype')).toBe('multipart/form-data');
  });

  it('reconciles live part attributes without blurring the focused element', () => {
    const trigger = document.createElement('div');
    document.body.append(trigger);
    const binding = createSolidPartPropsBinding(trigger, {
      id: 'context-trigger',
      tabIndex: 0,
      data: { state: 'open' },
    });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    binding.update({
      id: 'context-trigger',
      tabIndex: 0,
      data: { state: 'closed' },
    });

    expect(document.activeElement).toBe(trigger);
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.dataset.state).toBe('closed');
    binding.destroy();
  });

  it('does not eagerly evaluate reserved child accessors while projecting DOM props', () => {
    let childReads = 0;
    const input = Object.defineProperty({}, 'children', {
      enumerable: true,
      get() {
        childReads += 1;
        return 'child';
      },
    });
    expect(toSolidUserPartProps(input)).toEqual({});
    expect(childReads).toBe(0);
  });

  it('mounts every one of the 69 public compound roots', async () => {
    const host = mount(() => <AllRootsHarness />);
    await settle();
    expect(manifest.primitiveCount).toBe(69);
    expect(manifest.anatomyCount).toBe(465);
    expect(manifest.primitives.map((primitive) => primitive.id)).toEqual(catalog.primitives.map((primitive) => primitive.id));
    for (const primitive of catalog.primitives) {
      expect(host.querySelector(`[data-testid="${primitive.id}-root"]`) ?? document.body.querySelector(`[data-testid="${primitive.id}-root"]`)).not.toBeNull();
    }
  }, 20_000);

  it('assigns unique controller IDs across independent Solid render roots', async () => {
    const first = mount(() => <Checkbox.Root><Checkbox.Control>First</Checkbox.Control></Checkbox.Root>);
    const second = mount(() => <Checkbox.Root><Checkbox.Control>Second</Checkbox.Control></Checkbox.Root>);
    await settle();
    const firstId = first.querySelector('[role="checkbox"]')?.id;
    const secondId = second.querySelector('[role="checkbox"]')?.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
  });

  it('keeps controlled accessors live and does not reconstruct the controller or DOM tree', async () => {
    let setValue!: Setter<string[]>;
    let bridge!: SolidPrimitiveBridge;
    const host = mount(() => {
      const [value, updateValue] = createSignal<string[]>([]);
      setValue = updateValue;
      return (
        <Accordion.Root
          type="multiple"
          value={value()}
          onValueChange={(next) => updateValue(next as string[])}
          render={(payload) => {
            bridge = payload.bridge;
            return (
              <div {...payload.props()} data-testid="lifecycle-root">
                <span data-testid="stable-child">stable</span>
                <output
                  data-testid="counters"
                  data-generation={payload.counters().controllerGeneration}
                  data-dom-generation={payload.counters().domGeneration}
                  data-dom-destroy-count={payload.counters().domDestroyCount}
                  data-value={JSON.stringify(payload.state().value)}
                />
                <Accordion.Item value="one">
                  <Accordion.Header value="one">
                    <Accordion.Trigger value="one">First section</Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content value="one">First content</Accordion.Content>
                </Accordion.Item>
              </div>
            );
          }}
        />
      );
    });
    await settle();
    const root = host.querySelector('[data-testid="lifecycle-root"]')!;
    const child = host.querySelector('[data-testid="stable-child"]');
    const counters = host.querySelector('[data-testid="counters"]')!;
    const generation = counters.getAttribute('data-generation');
    const domGeneration = counters.getAttribute('data-dom-generation');
    const domDestroyCount = counters.getAttribute('data-dom-destroy-count');
    const childMutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => childMutations.push(...records.filter((record) => record.type === 'childList')));
    observer.observe(root, { subtree: true, childList: true });

    setValue(['one']);
    await settle();
    observer.disconnect();

    expect(counters.getAttribute('data-generation')).toBe(generation);
    expect(counters.getAttribute('data-dom-generation')).toBe(domGeneration);
    expect(counters.getAttribute('data-dom-destroy-count')).toBe(domDestroyCount);
    expect(counters.getAttribute('data-value')).toBe('["one"]');
    expect(host.querySelector('[data-testid="stable-child"]')).toBe(child);
    expect(childMutations).toHaveLength(0);
    expect(bridge.getLifecycleCounters().controllerGeneration).toBe(2);
  });

  it('updates dynamic collections through accessors and public compound parts', async () => {
    let append!: () => void;
    const host = mount(() => {
      const [items, setItems] = createSignal(['one', 'two']);
      const [value, setValue] = createSignal<string[]>([]);
      append = () => setItems((current) => [...current, 'three']);
      return (
        <Accordion.Root type="multiple" items={items()} value={value()} onValueChange={(next) => setValue(next as string[])}>
          <For each={items()}>{(item) => (
            <Accordion.Item value={item}>
              <Accordion.Header value={item}>
                <Accordion.Trigger value={item}>{item}</Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Content value={item}>{item} content</Accordion.Content>
            </Accordion.Item>
          )}</For>
          <output data-testid="dynamic-value">{JSON.stringify(value())}</output>
        </Accordion.Root>
      );
    });
    await settle();
    append();
    await settle();
    click(Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'three') ?? null);
    await settle();
    expect(host.querySelector('[data-testid="dynamic-value"]')?.textContent).toBe('["three"]');
  });

  it('uses DOM-owned portals, native forms, and clears all resources on abrupt owner disposal', async () => {
    const bridges: SolidPrimitiveBridge[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const dispose = render(() => (
      <form>
        <Dialog.Root defaultOpen render={(payload) => {
          bridges.push(payload.bridge);
          return <div {...payload.props()}>{[
            <Dialog.Trigger>Open</Dialog.Trigger>,
            <Dialog.Portal data-testid="dialog-portal">
              <Dialog.Content>
                <Dialog.Title>Dialog title</Dialog.Title>
                <Dialog.Description>Dialog description</Dialog.Description>
              </Dialog.Content>
            </Dialog.Portal>,
          ]}</div>;
        }} />
        <Checkbox.Root name="terms" value="accepted" defaultChecked={false} render={(payload) => {
          bridges.push(payload.bridge);
          return <label {...payload.props()}>{[
            <Checkbox.Control data-testid="checkbox-control">Accept</Checkbox.Control>,
            <Checkbox.HiddenInput />,
          ]}</label>;
        }} />
      </form>
    ), host);
    await settle();
    const portal = document.body.querySelector('[data-testid="dialog-portal"]');
    expect(portal?.parentElement).toBe(document.body);
    click(document.body.querySelector('[data-testid="checkbox-control"]'));
    await settle();
    const input = document.body.querySelector<HTMLInputElement>('input[name="terms"]');
    expect(input?.checked).toBe(true);
    expect(input?.value).toBe('accepted');

    dispose();
    await settle();
    for (const bridge of bridges) {
      const counters = bridge.getLifecycleCounters();
      expect(counters.activeControllers).toBe(0);
      expect(counters.registeredElements).toBe(0);
      expect(counters.subscribers).toBe(0);
      expect(counters.domDestroyCount).toBe(counters.domGeneration);
    }
    host.remove();
  });
});
