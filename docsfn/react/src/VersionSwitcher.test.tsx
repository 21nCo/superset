import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { VersionSwitcher } from './VersionSwitcher';
afterEach(cleanup);
it.each([undefined, { v1: '/docs/v1/guide' }, { v1: '/docs/v1/guide', v2: '/docs/v2/guide' }])('respects explicitly available version routes %j', versionLinks => {
  const changed = vi.fn();
  const surface = { versions: [{ slug: 'v1', label: 'One' }, { slug: 'v2', label: 'Two' }], currentVersion: 'v1', versionLinks } as any;
  const view = render(<VersionSwitcher surface={surface} onVersionChange={changed} />);
  fireEvent.click(view.getByText('Two'));
  if (versionLinks && !('v2' in versionLinks)) expect(changed).not.toHaveBeenCalled();
  else expect(changed).toHaveBeenCalledWith('v2');
});
