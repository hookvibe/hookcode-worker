import { buildCliUpgradeCommand, buildGlobalInstallCommand, normalizeTargetVersion, resolveNpmExecutable } from '../packageInfo';
import { resolveUpgradeTargetArg } from '../upgrade';

const TEST_VERSION = '9.9.9';

describe('worker upgrade helpers', () => {
  test('normalizes empty versions to latest', () => {
    expect(normalizeTargetVersion('')).toBe('latest');
    expect(normalizeTargetVersion(undefined)).toBe('latest');
    expect(normalizeTargetVersion(TEST_VERSION)).toBe(TEST_VERSION);
  });

  test('builds upgrade commands from the target version', () => {
    expect(buildGlobalInstallCommand(TEST_VERSION)).toBe(`npm install -g @hookvibe/hookcode-worker@${TEST_VERSION}`);
    expect(buildCliUpgradeCommand(TEST_VERSION)).toBe(`hookcode-worker upgrade --to ${TEST_VERSION}`);
  });

  test('resolves npm executable per platform', () => {
    expect(resolveNpmExecutable('win32')).toBe('npm.cmd');
    expect(resolveNpmExecutable('linux')).toBe('npm');
  });

  test('parses explicit upgrade targets from argv', () => {
    expect(resolveUpgradeTargetArg(['--to', TEST_VERSION])).toBe(TEST_VERSION);
    expect(resolveUpgradeTargetArg([])).toBe('latest');
  });
});
