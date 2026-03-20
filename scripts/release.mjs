#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml');

const usage = () => {
  console.error('Usage: node scripts/release.mjs <version> [--dry-run] [--no-push]');
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const version = args.find((arg) => !arg.startsWith('--')) ?? '';

if (!version) {
  usage();
  process.exit(1);
}

const isDryRun = flags.has('--dry-run');
const shouldPush = !flags.has('--no-push');
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (!versionPattern.test(version)) {
  console.error(`Invalid version "${version}". Expected semver like 1.2.3 or 1.2.3-beta.1`);
  process.exit(1);
}

const runGit = (args, options = {}) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim();

const runCommand = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim();

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const currentVersion = typeof packageJson.version === 'string' ? packageJson.version.trim() : '';

if (!currentVersion) {
  console.error('package.json is missing version');
  process.exit(1);
}

if (currentVersion === version) {
  console.error(`Version is already ${version}`);
  process.exit(1);
}

const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
if (!branch || branch === 'HEAD') {
  console.error('Releasing from detached HEAD is not supported.');
  process.exit(1);
}

const tagName = `v${version}`;
const existingTag = runGit(['tag', '--list', tagName]);
if (existingTag) {
  console.error(`Tag ${tagName} already exists locally.`);
  process.exit(1);
}

const remoteTag = runGit(['ls-remote', '--tags', 'origin', `refs/tags/${tagName}`]);
if (remoteTag) {
  console.error(`Tag ${tagName} already exists on origin.`);
  process.exit(1);
}

const statusBeforeRelease = runGit(['status', '--short']);

const summary = [
  `repo: ${repoRoot}`,
  `branch: ${branch}`,
  `from: ${currentVersion}`,
  `to: ${version}`,
  `tag: ${tagName}`,
  `workspace-dirty: ${statusBeforeRelease ? 'yes' : 'no'}`,
  `push: ${shouldPush ? 'yes' : 'no'}`,
  `dry-run: ${isDryRun ? 'yes' : 'no'}`
].join('\n');

if (isDryRun) {
  console.log(summary);
  process.exit(0);
}

packageJson.version = version;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

if (existsSync(lockfilePath)) {
  runCommand('pnpm', ['install', '--lockfile-only', '--ignore-scripts']);
}

runGit(['add', '-A']);

runGit(['commit', '-m', `chore: release ${tagName}`]);
runGit(['tag', '-a', tagName, '-m', `Release ${tagName}`]);

if (shouldPush) {
  runGit(['push', 'origin', `HEAD:${branch}`]);
  runGit(['push', 'origin', tagName]);
}

console.log(summary);
