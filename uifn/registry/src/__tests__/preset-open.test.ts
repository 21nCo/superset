import { expect, it, vi } from 'vitest';
const launch = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: launch }));
import { runCli } from '../cli';
import { encodePreset } from '../preset';
it('opens the editor, reports launch failure, and respects dry-run', async () => {
  const code = encodePreset({});
  const output = { stdout: () => {}, stderr: () => {} };
  launch.mockReturnValue({ status: 0 });
  expect((await runCli(['preset', 'open', code], output)).result).toMatchObject({ ok: true, opened: true });
  const [command, args, options] = launch.mock.calls[0];
  expect(command).toBe(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'powershell.exe' : 'xdg-open');
  expect(args.at(-1)).toContain(code);
  expect(options.shell).toBeUndefined();
  launch.mockReturnValue({ status: 1 });
  expect((await runCli(['preset', 'open', code], output)).result).toMatchObject({ ok: false, error: { code: 'UIFN_PRESET_OPEN_FAILED' } });
  launch.mockClear();
  expect((await runCli(['preset', 'open', code, '--dry-run'], output)).result).toMatchObject({ ok: true, opened: false });
  expect(launch).not.toHaveBeenCalled();
});

it('reports timed-out launches as unknown', async () => {
  launch.mockReturnValue({ status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
  expect((await runCli(['preset', 'open', encodePreset({})], { stdout: () => {}, stderr: () => {} })).result).toMatchObject({ ok: false, error: { code: 'UIFN_PRESET_OPEN_UNKNOWN' } });
});
it('rejects init with a missing template value before writing', async () => {
  expect((await runCli(['init', '--preset', encodePreset({}), '--template'], { stdout: () => {}, stderr: () => {} })).result).toMatchObject({ ok: false, written: [], error: { code: 'UIFN_PRESET_USAGE' } });
});
