#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseVersion(rawVersion) {
  const parts = rawVersion.trim().replace(/^v/, '').split('.');
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`Unsupported version: ${rawVersion}`);
  }
  return [Number(parts[0]), Number(parts[1] ?? 0), Number(parts[2] ?? 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const normalized = comparator.trim();
  if (normalized.startsWith('^')) {
    const minimum = parseVersion(normalized.slice(1));
    if (minimum[0] === 0) {
      throw new Error(`Unsupported zero-major caret range: ${normalized}`);
    }
    return version[0] === minimum[0] && compareVersions(version, minimum) >= 0;
  }
  if (normalized.startsWith('>=')) {
    return compareVersions(version, parseVersion(normalized.slice(2))) >= 0;
  }
  return compareVersions(version, parseVersion(normalized)) === 0;
}

function satisfiesRange(rawVersion, range) {
  const version = parseVersion(rawVersion);
  return range.split('||').some((alternative) => satisfiesComparator(version, alternative));
}

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const nodeRange = packageJson.devEngines?.runtime?.version;
const npmRange = packageJson.devEngines?.packageManager?.version;
if (typeof nodeRange !== 'string' || typeof npmRange !== 'string') {
  throw new Error('package.json devEngines runtime and packageManager ranges are required');
}

const nodeVersion = argumentValue('--node-version') ?? process.versions.node;
// Nix owns the npm patch version. Reading its executable here checks the actual
// flake.lock result while packageManager keeps Corepack users reproducible.
const npmVersion = argumentValue('--npm-version')
  ?? execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();

if (!satisfiesRange(nodeVersion, nodeRange)) {
  throw new Error(`Node ${nodeVersion} is outside development range ${nodeRange}`);
}
if (!satisfiesRange(npmVersion, npmRange)) {
  throw new Error(`npm ${npmVersion} is outside development range ${npmRange}`);
}

process.stdout.write(`Node ${nodeVersion} and npm ${npmVersion} are compatible\n`);
