import { buildCliUpgradeCommand, buildGlobalInstallCommand, normalizeTargetVersion, resolveNpmExecutable } from '../packageInfo';
import { resolveUpgradeTargetArg } from '../upgrade';

describe('worker upgrade helpers', () => {
  test('normalizes empty versions to latest', () => {
    expect(normalizeTargetVersion('')).toBe('latest');
    expect(normalizeTargetVersion(undefined)).toBe('latest');
    expect(normalizeTargetVersion('0.1.2')).toBe('0.1.2');
  });

  test('builds upgrade commands from the target version', () => {
    expect(buildGlobalInstallCommand('0.1.2')).toBe('npm install -g @hookvibe/hookcode-worker@0.1.2');
    expect(buildCliUpgradeCommand('0.1.2')).toBe('hookcode-worker upgrade --to 0.1.2');
  });

  test('resolves npm executable per platform', () => {
    expect(resolveNpmExecutable('win32')).toBe('npm.cmd');
    expect(resolveNpmExecutable('linux')).toBe('npm');
  });

  test('parses explicit upgrade targets from argv', () => {
    expect(resolveUpgradeTargetArg(['--to', '0.1.2'])).toBe('0.1.2');
    expect(resolveUpgradeTargetArg([])).toBe('latest');
  });
});
