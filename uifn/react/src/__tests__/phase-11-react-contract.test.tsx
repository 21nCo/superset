import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CarouselProps } from '@uifn/core/primitives/carousel';
import type { SignaturePadProps } from '@uifn/core/primitives/signature-pad';
import catalog from '../../../catalog/generated/catalog.json';
import manifest from '../../../evidence/generated/phase-11/phase-11-react-compounds.json';
import * as UIFnReact from '../index';
import type { ReactPrimitiveBridge } from '../internal/compound';

const fixture: Record<string, Record<string, unknown>> = {
  Carousel: { itemCount: 3, reducedMotion: true },
  ImageCropper: { src: '/image.png' },
  Meter: { value: 50 },
  Pagination: { count: 20 },
  QRCode: { value: 'https://example.com', label: 'Example' },
  Steps: { count: 3 },
  Timer: { duration: 1_000 },
  Tour: { steps: [{ id: 'intro', title: 'Introduction', description: 'Welcome' }] },
  TreeView: { items: [] },
};

function publicCompound(name: string): React.ElementType & Record<string, React.ElementType> {
  return (UIFnReact as Record<string, unknown>)[name] as React.ElementType & Record<string, React.ElementType>;
}

const numericParts = new Set([
  'Carousel.item',
  'Carousel.indicator',
  'Pagination.item',
  'Pagination.pageTrigger',
  'PinInput.input',
  'RatingGroup.item',
  'RatingGroup.itemIndicator',
  'Slider.thumb',
  'Slider.valueText',
  'Slider.hiddenInput',
  'Splitter.panel',
  'Splitter.resizeTrigger',
  'Splitter.resizeHandle',
  'Steps.item',
  'Steps.trigger',
  'Steps.indicator',
  'Steps.separator',
  'Steps.content',
  'Steps.completed',
]);

const partValues: Record<string, unknown> = {
  'ColorPicker.channelSlider': 'r',
  'ColorPicker.channelInput': 'r',
  'DateInput.segment': 'day',
  'DatePicker.segment': 'day',
  'DatePicker.cell': '2024-01-01',
  'DatePicker.cellTrigger': '2024-01-01',
  'FloatingPanel.resizeHandle': 'east',
  'ImageCropper.handle': 'east',
  'Pagination.ellipsis': 'start',
  'ScrollArea.scrollbar': 'vertical',
  'ScrollArea.thumb': 'vertical',
};

function partValue(primitive: string, part: string): unknown {
  const key = `${primitive}.${part}`;
  if (key in partValues) return partValues[key];
  return numericParts.has(key) ? 0 : 'item';
}

const childlessElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'textarea', 'track', 'wbr']);

describe('PHASE_11 public React contract', () => {
  it('mounts all 69 public compounds in StrictMode with complete catalog anatomy and no warnings', () => {
    expect(manifest.primitiveCount).toBe(69);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const primitive of catalog.primitives) {
        const Compound = publicCompound(primitive.name);
        expect(Compound, primitive.name).toBeTypeOf('object');
        expect(Compound.Provider, `${primitive.name}.Provider`).toBeTruthy();
        for (const part of primitive.anatomy) {
          const componentName = part.id.split('-').map((value) => value[0].toUpperCase() + value.slice(1)).join('');
          expect(Compound[componentName], `${primitive.name}.${componentName}`).toBeTruthy();
        }
        const renderPart = (part: (typeof primitive.anatomy)[number], children?: React.ReactNode) => {
          const componentName = part.id.split('-').map((value) => value[0].toUpperCase() + value.slice(1)).join('');
          const Part = Compound[componentName];
          const partProps = {
            key: part.id,
            ...(part.cardinality === 'many' ? { value: partValue(primitive.name, part.id) } : {}),
            'data-phase-11-part': part.id,
            ...(primitive.name === 'DatePicker' && ['grid', 'gridLabel', 'cell'].includes(part.id)
              ? { render: <div /> }
              : {}),
          };
          return React.createElement(
            Part,
            partProps,
            childlessElements.has(part.element)
              ? undefined
              : (children ?? `${primitive.name} ${componentName}`),
          );
        };
        const byId = (id: string) => primitive.anatomy.find((part) => part.id === id)!;
        const anatomyChildren = primitive.name === 'Table'
          ? [
              renderPart(byId('table'), [
                renderPart(byId('caption')),
                renderPart(byId('header'), React.createElement('tr', null, renderPart(byId('head')))),
                renderPart(byId('body'), renderPart(byId('row'), renderPart(byId('cell')))),
                renderPart(byId('footer'), React.createElement('tr', null, React.createElement('td', null, 'Table footer'))),
              ]),
            ]
          : primitive.anatomy.slice(1).map((part) => renderPart(part));
        const publicTree = React.createElement(
          Compound,
          { ...(fixture[primitive.name] ?? {}), 'data-phase-11': primitive.id },
          anatomyChildren.length > 0 ? anatomyChildren : undefined,
        );
        const mounted = render(<React.StrictMode>{publicTree}</React.StrictMode>);
        expect(mounted.container.querySelector(`[data-phase-11="${primitive.id}"]`)).not.toBeNull();
        for (const part of primitive.anatomy.slice(1)) {
          const selector = `[data-phase-11-part="${part.id}"]`;
          const renderedPart = mounted.container.querySelector(selector) ?? document.body.querySelector(selector);
          expect(renderedPart, `${primitive.name}.${part.id}`).not.toBeNull();
        }
        mounted.unmount();
        expect(document.body.querySelector('[data-phase-11-part]'), `${primitive.name} portal cleanup`).toBeNull();
      }
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 20_000);

  it('uses one core controller for uncontrolled, controlled, composition, refs, and callback ordering', () => {
    const changes: Array<readonly string[]> = [];
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <UIFnReact.Accordion defaultValue={[]} onValueChange={(value) => changes.push(value)}>
        <UIFnReact.Accordion.Item value="profile">
          <UIFnReact.Accordion.Header value="profile">
            <UIFnReact.Accordion.Trigger value="profile" asChild ref={ref}>
              <button onClick={(event) => event.preventDefault()}>Profile</button>
            </UIFnReact.Accordion.Trigger>
          </UIFnReact.Accordion.Header>
          <UIFnReact.Accordion.Content value="profile">Details</UIFnReact.Accordion.Content>
        </UIFnReact.Accordion.Item>
      </UIFnReact.Accordion>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Profile' }));
    fireEvent.click(ref.current!);
    expect(changes).toEqual([]);
  });

  it('separates declared component inputs from intrinsic root props', () => {
    render(
      <>
        <UIFnReact.Input aria-label="Work email" placeholder="you@company.com" />
        <UIFnReact.Command placeholder="Type a command or search…">
          <UIFnReact.Command.Label>Commands</UIFnReact.Command.Label>
          <UIFnReact.Command.Input />
          <UIFnReact.Command.List />
        </UIFnReact.Command>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Work email' })).toHaveAttribute('placeholder', 'you@company.com');
    expect(screen.getByRole('combobox', { name: 'Commands' })).toHaveAttribute('placeholder', 'Type a command or search…');
  });

  it('routes Carousel dir and orientation to the controller', () => {
    let bridge: ReactPrimitiveBridge<CarouselProps> | undefined;
    const carousel = (orientation: 'horizontal' | 'vertical') => (
      <UIFnReact.Carousel
        defaultIndex={1}
        itemCount={3}
        dir="rtl"
        orientation={orientation}
        reducedMotion
        render={(payload) => {
          bridge = payload.bridge as ReactPrimitiveBridge<CarouselProps>;
          return <section {...payload.props}><UIFnReact.Carousel.Viewport data-testid="carousel-viewport" /></section>;
        }}
      />
    );
    const mounted = render(carousel('horizontal'));
    expect(mounted.container.querySelector('section')).toHaveAttribute('dir', 'rtl');
    const actions = bridge?.getActions() as {
      dragStart(id: number, point: { x: number; y: number }): void;
      dragMove(id: number, point: { x: number; y: number }): void;
      dragEnd(id: number): void;
    };
    act(() => {
      actions.dragStart(1, { x: 100, y: 0 });
      actions.dragMove(1, { x: 50, y: 0 });
      actions.dragEnd(1);
    });
    expect(bridge?.getSnapshot().state).toMatchObject({ index: 0, dir: 'rtl' });
    mounted.rerender(carousel('vertical'));
    expect(bridge?.getSnapshot().state).toMatchObject({ orientation: 'vertical', dir: 'rtl' });
  });

  it('preserves controlled SignaturePad requests and live callbacks across rerenders', () => {
    const point = { x: 1, y: 2, pressure: 0.5, time: 10 };
    const value = [[point]] as const;
    const change = vi.fn();
    let bridge: ReactPrimitiveBridge<SignaturePadProps> | undefined;
    const signature = (name: string, onValueChange?: SignaturePadProps['onValueChange']) => (
      <UIFnReact.SignaturePad
        value={value}
        name={name}
        onValueChange={onValueChange}
        render={(payload) => {
          bridge = payload.bridge as ReactPrimitiveBridge<SignaturePadProps>;
          return <div {...payload.props} />;
        }}
      />
    );
    const mounted = render(signature('first'));
    const actions = bridge?.getActions() as {
      pointerStart(id: number, point: typeof point): void;
      pointerEnd(id: number): void;
      clear(): void;
    };
    act(() => {
      actions.pointerStart(1, point);
      actions.pointerEnd(1);
    });
    expect(bridge?.getSnapshot().state.requestedValue).toHaveLength(2);

    mounted.rerender(signature('second'));
    expect(bridge?.getSnapshot().state.requestedValue).toHaveLength(2);
    mounted.rerender(signature('second', change));
    act(() => actions.clear());
    expect(change).toHaveBeenCalledWith([]);
  });

  it('preserves intrinsic semantics, refs, accessible names, and disabled behavior for asChild and render', () => {
    const asChildRef = React.createRef<HTMLAnchorElement>();
    const renderRef = React.createRef<HTMLAnchorElement>();
    const disabledChildClick = vi.fn();
    const changes = vi.fn();
    render(
      <>
        <UIFnReact.Collapsible onOpenChange={changes}>
          <UIFnReact.Collapsible.Trigger asChild ref={asChildRef}>
            <a href="#details">Open details</a>
          </UIFnReact.Collapsible.Trigger>
          <UIFnReact.Collapsible.Content>Details</UIFnReact.Collapsible.Content>
        </UIFnReact.Collapsible>
        <UIFnReact.Collapsible disabled>
          <UIFnReact.Collapsible.Trigger render={<a ref={renderRef} href="#disabled" onClick={disabledChildClick}>Unavailable</a>} />
          <UIFnReact.Collapsible.Content>Unavailable details</UIFnReact.Collapsible.Content>
        </UIFnReact.Collapsible>
      </>,
    );
    const link = screen.getByRole('link', { name: 'Open details' });
    expect(asChildRef.current).toBe(link);
    fireEvent.click(link);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(link).toHaveAttribute('aria-expanded', 'true');

    const disabled = screen.getByRole('link', { name: 'Unavailable' });
    expect(renderRef.current).toBe(disabled);
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).toHaveAttribute('tabindex', '-1');
    fireEvent.click(disabled);
    expect(disabledChildClick).not.toHaveBeenCalled();
    expect(disabled).toHaveAttribute('aria-expanded', 'false');
  });

  it('fails deterministically when asChild loses a required part ref', () => {
    function RefDroppingTrigger() { return <button>Open</button>; }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(
        <UIFnReact.Collapsible>
          <UIFnReact.Collapsible.Trigger asChild>
            <RefDroppingTrigger />
          </UIFnReact.Collapsible.Trigger>
        </UIFnReact.Collapsible>,
      )).toThrow(expect.objectContaining({ code: 'UIFN_PART_REF_LOST' }));
    } finally {
      error.mockRestore();
    }
  });

  it('restores uncontrolled form state through the shared DOM reset service', () => {
    render(
      <form aria-label="settings">
        <UIFnReact.RatingGroup defaultValue={2} name="rating">
          <UIFnReact.RatingGroup.Item value={2}>Two</UIFnReact.RatingGroup.Item>
          <UIFnReact.RatingGroup.Item value={4}>Four</UIFnReact.RatingGroup.Item>
          <UIFnReact.RatingGroup.HiddenInput />
        </UIFnReact.RatingGroup>
      </form>,
    );
    fireEvent.click(screen.getByRole('radio', { name: /4/ }));
    expect(document.querySelector<HTMLInputElement>('input[name="rating"]')?.value).toBe('4');
    fireEvent.reset(screen.getByRole('form', { name: 'settings' }));
    expect(document.querySelector<HTMLInputElement>('input[name="rating"]')?.value).toBe('2');
  });
});
