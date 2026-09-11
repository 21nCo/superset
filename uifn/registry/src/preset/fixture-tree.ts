import type { PresetCompilePlan } from './compiler';

/** Shared public-component tree used by Create and generated consumer apps. */
export interface PresetFixtureNode {
  type: string;
  props?: Record<string, unknown>;
  children?: Array<PresetFixtureNode | string>;
}
export const PRESET_FIXTURE_COMPONENTS = {
  ButtonRoot: 'button', CardRoot: 'card', CardHeader: 'card', CardTitle: 'card', CardContent: 'card',
  FieldRoot: 'field', FieldLabel: 'field',
  SelectRoot: 'select', SelectLabel: 'select', SelectTrigger: 'select', SelectValueText: 'select', SelectContent: 'select', SelectItem: 'select', InputRoot: 'input',
  CheckboxRoot: 'checkbox', CheckboxControl: 'checkbox', CheckboxLabel: 'checkbox',
  SwitchRoot: 'switch', SwitchControl: 'switch', SwitchThumb: 'switch', SwitchLabel: 'switch',
  TabsRoot: 'tabs', TabsList: 'tabs', TabsTrigger: 'tabs', TabsContent: 'tabs',
  MenuRoot: 'menu', MenuTrigger: 'menu', MenuContent: 'menu', MenuItem: 'menu',
  DialogRoot: 'dialog', DialogPortal: 'dialog', DialogTrigger: 'dialog', DialogContent: 'dialog', DialogTitle: 'dialog', DialogClose: 'dialog',
  TableRoot: 'table', TableTable: 'table', TableHeader: 'table', TableBody: 'table', TableRow: 'table', TableHead: 'table', TableCell: 'table',
} as const;
const n = (type: string, props: Record<string, unknown> = {}, ...children: Array<PresetFixtureNode | string>): PresetFixtureNode => ({ type, props, children });
export function presetFixtureTree(plan: PresetCompilePlan): PresetFixtureNode {
  const card = (title: string, ...children: PresetFixtureNode[]) => n('CardRoot', {}, n('CardHeader', {}, n('CardTitle', {}, title)), n('CardContent', {}, ...children));
  return n('section', { className: 'preset-fixture' },
    n('h1', {}, 'Workspace overview'),
    n('p', {}, 'Public uifn components with the selected theme.'),
    n('div', { className: 'preset-fixture-grid' },
      card('Actions', n('div', { className: 'preset-fixture-row' },
        ...['default', 'secondary', 'ghost', 'danger'].map(variant => n('ButtonRoot', { variant }, variant)))),
      card('Settings', n('FieldRoot', {}, n('FieldLabel', {}, 'Project name'), n('InputRoot', { defaultValue: 'Northwind', 'aria-label': 'Project name' })),
        n('CheckboxRoot', { defaultChecked: true }, n('CheckboxControl'), n('CheckboxLabel', {}, 'Weekly digest')),
        n('SwitchRoot', { defaultChecked: true }, n('SwitchControl', {}, n('SwitchThumb')), n('SwitchLabel', {}, 'Live preview'))),
      card('Navigation', n('TabsRoot', { defaultValue: 'overview', items: ['overview', 'members'] },
        n('TabsList', { 'aria-label': 'Workspace sections' }, n('TabsTrigger', { value: 'overview' }, 'Overview'), n('TabsTrigger', { value: 'members' }, 'Members')),
        n('TabsContent', { value: 'overview' }, 'Workspace activity'), n('TabsContent', { value: 'members' }, 'Team members')),
        n('MenuRoot', {}, n('MenuTrigger', {}, 'Actions'), n('MenuContent', {}, n('MenuItem', { value: 'duplicate' }, 'Duplicate'), n('MenuItem', { value: 'archive' }, 'Archive')))),
      card('Environment', n('SelectRoot', { defaultValue: ['production'], items: [{value:'production',label:'Production'},{value:'staging',label:'Staging'}] }, n('SelectLabel', {}, 'Environment'), n('SelectTrigger', {}, n('SelectValueText')), n('SelectContent', {}, n('SelectItem', { value: 'production' }, 'Production'), n('SelectItem', { value: 'staging' }, 'Staging')))),
      card('Confirmation', n('DialogRoot', {}, n('DialogTrigger', {}, 'Review change'), n('DialogPortal', {}, n('DialogContent', {}, n('DialogTitle', {}, 'Review change'), n('p', {}, 'Confirm the workspace settings.'), n('DialogClose', {}, 'Close'))))),
      card('Jobs', n('TableRoot', {}, n('TableTable', {}, n('TableHeader', {}, n('TableRow', { value: 'header' }, n('TableHead', { value: 'name' }, 'Name'), n('TableHead', { value: 'status' }, 'Status'))),
        n('TableBody', {}, ...['Ingest', 'Compile', 'Publish'].map(name => n('TableRow', { value: name }, n('TableCell', { value: name + '-name' }, name), n('TableCell', { value: name + '-status' }, 'Ready'))))))),
      card('Chart palette', n('div', { className: 'preset-fixture-row' }, ...plan.theme.chartPalette.map((background, index) => n('span', { style: { background: `var(--uifn-chart-${index + 1})`, width: '2rem', height: '2rem', display: 'inline-block' }, title: `Series ${index + 1}` })))),
    ));
}
