import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  overrides?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<string, {
    version?: string;
    dependencies?: Record<string, string>;
    engines?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  }>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as PackageJson;
}

function readPackageLock(): PackageLock {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'package-lock.json'), 'utf-8'),
  ) as PackageLock;
}

function getLockedPackage(packageLock: PackageLock, path: string): {
  version?: string;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} {
  const lockedPackage = packageLock.packages?.[path];
  if (!lockedPackage) {
    throw new Error(`${path} is not present in package-lock.json`);
  }
  return lockedPackage;
}

type NodeVersion = readonly [number, number, number];

function parseNodeVersion(version: string): NodeVersion {
  const normalized = version.replace(/^[vV]/, '');
  const parts = normalized.split('.');
  if (parts.length > 3 || parts.length === 0) {
    throw new Error(`Unsupported Node version: ${version}`);
  }

  return [parseVersionPart(parts[0]), parseVersionPart(parts[1]), parseVersionPart(parts[2])];
}

function parseVersionPart(part: string | undefined): number {
  if (part === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(part)) {
    throw new Error(`Unsupported Node version part: ${part}`);
  }
  return Number(part);
}

function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function getMinimumNodeVersion(range: string): NodeVersion {
  const normalized = range.trim().replace(/^>=\s+/, '>=');
  const match = normalized.match(/^>=(\d+(?:\.\d+){0,2})$/);
  if (!match?.[1]) {
    throw new Error(`Root Node engine must be a lower-bound range: ${range}`);
  }
  return parseNodeVersion(match[1]);
}

function satisfiesNodeRange(version: NodeVersion, range: string): boolean {
  return range.split('||').some((alternative) => satisfiesNodeAlternative(version, alternative));
}

function satisfiesNodeAlternative(version: NodeVersion, alternative: string): boolean {
  const normalized = alternative.trim().replace(/([<>=]=?|\^)\s+/g, '$1');
  if (!normalized) {
    throw new Error(`Unsupported empty Node engine range: ${alternative}`);
  }

  return normalized.split(/\s+/).every((comparator) => satisfiesNodeComparator(version, comparator));
}

function satisfiesNodeComparator(version: NodeVersion, comparator: string): boolean {
  if (comparator.startsWith('>=')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(2))) >= 0;
  }
  if (comparator.startsWith('>')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(1))) > 0;
  }
  if (comparator.startsWith('<=')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(2))) <= 0;
  }
  if (comparator.startsWith('<')) {
    return compareNodeVersions(version, parseNodeVersion(comparator.slice(1))) < 0;
  }
  if (comparator.startsWith('^')) {
    const minimum = parseNodeVersion(comparator.slice(1));
    return compareNodeVersions(version, minimum) >= 0
      && compareNodeVersions(version, getCaretUpperBound(minimum)) < 0;
  }
  return compareNodeVersions(version, parseNodeVersion(comparator)) === 0;
}

function getCaretUpperBound(version: NodeVersion): NodeVersion {
  if (version[0] > 0) {
    return [version[0] + 1, 0, 0];
  }
  if (version[1] > 0) {
    return [0, version[1] + 1, 0];
  }
  return [0, 0, version[2] + 1];
}

describe('dependency versions', () => {
  it('declares OpenTelemetry foundation dependencies', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();
    const otelDependencies = [
      '@opentelemetry/api',
      '@opentelemetry/exporter-metrics-otlp-http',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/sdk-metrics',
      '@opentelemetry/sdk-node',
      '@opentelemetry/sdk-trace-base',
    ] as const;

    for (const dependencyName of otelDependencies) {
      expect(packageJson.dependencies).toHaveProperty(dependencyName);
      expect(packageLock.packages).toHaveProperty(`node_modules/${dependencyName}`);
    }
  });

  it('locks the OpenTelemetry security release train without changing transport', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();

    // Keep the existing OTLP/HTTP transport while moving the complete SDK train
    // together; mixing OpenTelemetry release trains can fail only at runtime.
    expect(packageJson.dependencies?.['@opentelemetry/api']).toBe('^1.9.1');
    expect(packageJson.dependencies?.['@opentelemetry/exporter-metrics-otlp-http']).toBe('^0.221.0');
    expect(packageJson.dependencies?.['@opentelemetry/exporter-trace-otlp-http']).toBe('^0.221.0');
    expect(packageJson.dependencies?.['@opentelemetry/sdk-node']).toBe('^0.221.0');
    expect(packageJson.dependencies?.['@opentelemetry/sdk-metrics']).toBe('^2.10.0');
    expect(packageJson.dependencies?.['@opentelemetry/sdk-trace-base']).toBe('^2.10.0');
    expect(packageJson.dependencies).not.toHaveProperty('@opentelemetry/exporter-metrics-otlp-proto');
    expect(packageJson.dependencies).not.toHaveProperty('@opentelemetry/exporter-trace-otlp-proto');

    expect(getLockedPackage(packageLock, 'node_modules/@opentelemetry/api').version).toBe('1.9.1');
    expect(
      getLockedPackage(packageLock, 'node_modules/@opentelemetry/exporter-metrics-otlp-http').version,
    ).toBe('0.221.0');
    expect(
      getLockedPackage(packageLock, 'node_modules/@opentelemetry/exporter-trace-otlp-http').version,
    ).toBe('0.221.0');
    expect(getLockedPackage(packageLock, 'node_modules/@opentelemetry/sdk-node').version).toBe('0.221.0');
    expect(getLockedPackage(packageLock, 'node_modules/@opentelemetry/sdk-metrics').version).toBe('2.10.0');
    expect(getLockedPackage(packageLock, 'node_modules/@opentelemetry/sdk-trace-base').version).toBe('2.10.0');
    expect(getLockedPackage(packageLock, 'node_modules/@opentelemetry/propagator-jaeger').version).toBe('2.10.0');
  });

  it('declares Node support compatible with runtime dependency engines', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();
    const dependencies = packageJson.dependencies;
    const rootNodeRange = packageJson.engines?.node;
    if (!dependencies) {
      throw new Error('package.json dependencies are required');
    }
    if (!rootNodeRange) {
      throw new Error('package.json engines.node is required');
    }

    expect(rootNodeRange).toBe('>=20.6.0');

    const rootMinimum = getMinimumNodeVersion(rootNodeRange);
    const incompatibleDependencies = Object.keys(dependencies).sort().flatMap((dependencyName) => {
      const lockedPackage = getLockedPackage(packageLock, `node_modules/${dependencyName}`);
      const dependencyNodeRange = lockedPackage.engines?.node;
      if (!dependencyNodeRange) {
        return [];
      }
      if (!lockedPackage.version) {
        throw new Error(`${dependencyName} is missing a locked version`);
      }
      if (satisfiesNodeRange(rootMinimum, dependencyNodeRange)) {
        return [];
      }
      return [`${dependencyName}@${lockedPackage.version} requires ${dependencyNodeRange}`];
    });

    expect(incompatibleDependencies).toEqual([]);
  });

  it('locks yaml to the patched 2.9.0 release', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();

    expect(packageJson.dependencies?.yaml).toBe('^2.9.0');
    expect(packageLock.packages?.['node_modules/yaml']?.version).toBe('2.9.0');
  });

  it('locks runtime transitive dependencies to patched security releases', () => {
    const packageLock = readPackageLock();

    // Exact versions keep future lock refreshes from silently restoring known-vulnerable releases.
    expect(getLockedPackage(packageLock, 'node_modules/ajv').version).toBe('6.15.0');
    expect(getLockedPackage(packageLock, 'node_modules/body-parser').version).toBe('2.3.0');
    expect(getLockedPackage(packageLock, 'node_modules/fast-uri').version).toBe('3.1.4');
    expect(getLockedPackage(packageLock, 'node_modules/hono').version).toBe('4.12.32');
    expect(getLockedPackage(packageLock, 'node_modules/postcss').version).toBe('8.5.23');
    expect(getLockedPackage(packageLock, 'node_modules/protobufjs').version).toBe('7.6.5');
  });

  it('locks the MCP Hono server chain to the compatible path traversal fix', () => {
    const packageLock = readPackageLock();
    const claudeAgentSdk = getLockedPackage(
      packageLock,
      'node_modules/@anthropic-ai/claude-agent-sdk',
    );
    const mcpSdk = getLockedPackage(packageLock, 'node_modules/@modelcontextprotocol/sdk');
    const honoNodeServer = getLockedPackage(packageLock, 'node_modules/@hono/node-server');

    // @hono/node-server 2.0.5 is the first release patched for GHSA-frvp-7c67-39w9.
    // Exact versions make a future lock refresh visibly re-evaluate this production boundary.
    expect(mcpSdk.version).toBe('1.30.0');
    expect(mcpSdk.dependencies?.['@hono/node-server']).toBe('^1.19.9 || ^2.0.5');
    expect(honoNodeServer.version).toBe('2.0.12');
    expect(
      compareNodeVersions(
        parseNodeVersion(honoNodeServer.version ?? ''),
        parseNodeVersion('2.0.5'),
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(honoNodeServer.engines?.node).toBe('>=20');
    expect(honoNodeServer.peerDependencies?.hono).toBe('^4');
    expect(getLockedPackage(packageLock, 'node_modules/hono').version).toBe('4.12.32');
    expect(claudeAgentSdk.peerDependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
    expect(
      satisfiesNodeRange(
        parseNodeVersion(mcpSdk.version ?? ''),
        claudeAgentSdk.peerDependencies?.['@modelcontextprotocol/sdk'] ?? '',
      ),
    ).toBe(true);

    const rootNodeRange = readPackageJson().engines?.node;
    if (!rootNodeRange) {
      throw new Error('package.json engines.node is required');
    }
    expect(satisfiesNodeRange(getMinimumNodeVersion(rootNodeRange), honoNodeServer.engines?.node ?? ''))
      .toBe(true);
  });

  it('keeps unrelated toolchain security refreshes inside their existing majors', () => {
    const packageLock = readPackageLock();

    expect(getLockedPackage(packageLock, 'node_modules/brace-expansion').version).toBe('2.1.2');
    expect(getLockedPackage(packageLock, 'node_modules/minimatch').version).toBe('9.0.9');
    expect(
      getLockedPackage(
        packageLock,
        'node_modules/@typescript-eslint/visitor-keys/node_modules/eslint-visitor-keys',
      ).version,
    ).toBe('4.2.1');
  });

  it('locks test runner transitive dependencies to patched security releases', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();

    expect(packageJson.devDependencies?.vitest).toBe('^3.2.6');
    expect(packageJson.overrides?.vite).toBe('6.4.3');
    expect(packageJson.overrides?.esbuild).toBe('0.28.1');
    expect(getLockedPackage(packageLock, 'node_modules/vitest').version).toBe('3.2.6');
    expect(getLockedPackage(packageLock, 'node_modules/vite').version).toBe('6.4.3');
    expect(getLockedPackage(packageLock, 'node_modules/esbuild').version).toBe('0.28.1');
  });

  it('resolves traced-config through its public entrypoint', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const resolved = import.meta.resolve('traced-config'); const mod = await import('traced-config'); process.stdout.write(JSON.stringify({ resolved, hasFactory: typeof mod.tracedConfig === 'function' }));",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
      },
    );

    const result = JSON.parse(stdout) as { resolved: string; hasFactory: boolean };
    expect(result.resolved.startsWith('file://')).toBe(true);
    expect(result.hasFactory).toBe(true);
  });
});
