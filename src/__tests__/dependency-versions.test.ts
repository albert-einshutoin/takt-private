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
  packages?: Record<string, { version?: string; engines?: Record<string, string> }>;
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
  engines?: Record<string, string>;
} {
  const lockedPackage = packageLock.packages?.[path];
  if (!lockedPackage) {
    throw new Error(`${path} is not present in package-lock.json`);
  }
  return lockedPackage;
}

type VersionTuple = readonly [number, number, number];

function assertAllLockedPackageVersions(
  packageLock: PackageLock,
  packageName: string,
  isSafe: (version: string) => boolean,
): void {
  const packageSuffix = `node_modules/${packageName}`;
  // Why: npm may retain a vulnerable nested copy even when the top-level instance is patched.
  const instances = Object.entries(packageLock.packages ?? {})
    .filter(([path]) => path === packageSuffix || path.endsWith(`/${packageSuffix}`));
  if (instances.length === 0) {
    throw new Error(`${packageName} is not present in package-lock.json`);
  }
  for (const [path, lockedPackage] of instances) {
    const version = lockedPackage.version;
    if (!version || !isSafe(version)) {
      throw new Error(`${path}@${version ?? '<missing>'} has an unsafe locked version`);
    }
  }
}

function parseStablePackageVersion(version: string): VersionTuple | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeastStableVersion(version: string, minimum: VersionTuple): boolean {
  const parsed = parseStablePackageVersion(version);
  return parsed !== undefined && compareVersionTuples(parsed, minimum) >= 0;
}

function isStableVersionInSeries(version: string, major: number, minor: number): boolean {
  const parsed = parseStablePackageVersion(version);
  return parsed !== undefined && parsed[0] === major && parsed[1] === minor;
}

function isSafeBraceExpansionVersion(version: string): boolean {
  const parsed = parseStablePackageVersion(version);
  // The advisory has separate patched releases on the lockfile's supported 1.x and 2.x lines.
  if (parsed?.[0] === 1) return compareVersionTuples(parsed, [1, 1, 18]) >= 0;
  if (parsed?.[0] === 2) return compareVersionTuples(parsed, [2, 1, 4]) >= 0;
  return false;
}

function parseNodeVersion(version: string): VersionTuple {
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

function compareVersionTuples(left: VersionTuple, right: VersionTuple): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function getMinimumNodeVersion(range: string): VersionTuple {
  const normalized = range.trim().replace(/^>=\s+/, '>=');
  const match = normalized.match(/^>=(\d+(?:\.\d+){0,2})$/);
  if (!match?.[1]) {
    throw new Error(`Root Node engine must be a lower-bound range: ${range}`);
  }
  return parseNodeVersion(match[1]);
}

function satisfiesNodeRange(version: VersionTuple, range: string): boolean {
  return range.split('||').some((alternative) => satisfiesNodeAlternative(version, alternative));
}

function satisfiesNodeAlternative(version: VersionTuple, alternative: string): boolean {
  const normalized = alternative.trim().replace(/([<>=]=?|\^)\s+/g, '$1');
  if (!normalized) {
    throw new Error(`Unsupported empty Node engine range: ${alternative}`);
  }

  return normalized.split(/\s+/).every((comparator) => satisfiesNodeComparator(version, comparator));
}

function satisfiesNodeComparator(version: VersionTuple, comparator: string): boolean {
  if (comparator.startsWith('>=')) {
    return compareVersionTuples(version, parseNodeVersion(comparator.slice(2))) >= 0;
  }
  if (comparator.startsWith('>')) {
    return compareVersionTuples(version, parseNodeVersion(comparator.slice(1))) > 0;
  }
  if (comparator.startsWith('<=')) {
    return compareVersionTuples(version, parseNodeVersion(comparator.slice(2))) <= 0;
  }
  if (comparator.startsWith('<')) {
    return compareVersionTuples(version, parseNodeVersion(comparator.slice(1))) < 0;
  }
  if (comparator.startsWith('^')) {
    const minimum = parseNodeVersion(comparator.slice(1));
    return compareVersionTuples(version, minimum) >= 0
      && compareVersionTuples(version, getCaretUpperBound(minimum)) < 0;
  }
  return compareVersionTuples(version, parseNodeVersion(comparator)) === 0;
}

function getCaretUpperBound(version: VersionTuple): VersionTuple {
  if (version[0] > 0) {
    return [version[0] + 1, 0, 0];
  }
  if (version[1] > 0) {
    return [0, version[1] + 1, 0];
  }
  return [0, 0, version[2] + 1];
}

describe('dependency versions', () => {
  it('rejects a vulnerable nested instance even when the top-level package is patched', () => {
    const safeFixture: PackageLock = {
      packages: {
        'node_modules/brace-expansion': { version: '2.1.4' },
        'node_modules/example/node_modules/brace-expansion': { version: '1.1.18' },
      },
    };
    expect(() => assertAllLockedPackageVersions(
      safeFixture,
      'brace-expansion',
      isSafeBraceExpansionVersion,
    )).not.toThrow();

    const vulnerableFixture: PackageLock = {
      packages: {
        ...safeFixture.packages,
        'node_modules/vulnerable/node_modules/brace-expansion': { version: '1.1.11' },
      },
    };

    expect(() => assertAllLockedPackageVersions(
      vulnerableFixture,
      'brace-expansion',
      isSafeBraceExpansionVersion,
    )).toThrow(/node_modules\/vulnerable\/node_modules\/brace-expansion@1\.1\.11/u);

    const mixedOtelFixture: PackageLock = {
      packages: {
        'node_modules/@opentelemetry/sdk-metrics': { version: '2.9.0' },
        'node_modules/example/node_modules/@opentelemetry/sdk-metrics': { version: '2.8.0' },
      },
    };
    expect(() => assertAllLockedPackageVersions(
      mixedOtelFixture,
      '@opentelemetry/sdk-metrics',
      (version) => isStableVersionInSeries(version, 2, 9),
    )).toThrow(/node_modules\/example\/node_modules\/@opentelemetry\/sdk-metrics@2\.8\.0/u);
  });

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

    expect(getLockedPackage(packageLock, 'node_modules/ajv').version).toBe('6.15.0');
    assertAllLockedPackageVersions(packageLock, '@modelcontextprotocol/sdk',
      (version) => isAtLeastStableVersion(version, [1, 30, 0]));
    assertAllLockedPackageVersions(packageLock, '@hono/node-server',
      (version) => isAtLeastStableVersion(version, [2, 0, 5]));
    assertAllLockedPackageVersions(packageLock, 'body-parser',
      (version) => isAtLeastStableVersion(version, [2, 3, 0]));
    expect(getLockedPackage(packageLock, 'node_modules/express-rate-limit').version).toBe('8.5.2');
    assertAllLockedPackageVersions(packageLock, 'fast-uri',
      (version) => isAtLeastStableVersion(version, [3, 1, 4]));
    assertAllLockedPackageVersions(packageLock, 'hono',
      (version) => isAtLeastStableVersion(version, [4, 12, 27]));
    expect(getLockedPackage(packageLock, 'node_modules/ip-address').version).toBe('10.2.0');
    assertAllLockedPackageVersions(packageLock, 'protobufjs',
      (version) => isAtLeastStableVersion(version, [7, 6, 5]));
    expect(getLockedPackage(packageLock, 'node_modules/qs').version).toBe('6.15.2');
  });

  it('aligns the OpenTelemetry package family on the patched compatible generation', () => {
    const packageJson = readPackageJson();
    const packageLock = readPackageLock();
    const expected = {
      '@opentelemetry/exporter-metrics-otlp-http': ['^0.220.0', 0, 220],
      '@opentelemetry/exporter-trace-otlp-http': ['^0.220.0', 0, 220],
      '@opentelemetry/sdk-metrics': ['^2.9.0', 2, 9],
      '@opentelemetry/sdk-node': ['^0.220.0', 0, 220],
      '@opentelemetry/sdk-trace-base': ['^2.9.0', 2, 9],
    } as const;

    for (const [name, [declared, major, minor]] of Object.entries(expected)) {
      expect(packageJson.dependencies?.[name]).toBe(declared);
      assertAllLockedPackageVersions(packageLock, name,
        (version) => isStableVersionInSeries(version, major, minor));
    }
    assertAllLockedPackageVersions(packageLock, '@opentelemetry/propagator-jaeger',
      (version) => isStableVersionInSeries(version, 2, 9));
  });

  it('imports the real Anthropic and MCP SDK entrypoints', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "const [anthropic, mcp] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('@modelcontextprotocol/sdk/client')]); process.stdout.write(JSON.stringify({ anthropic: Object.keys(anthropic).length > 0, mcp: Object.keys(mcp).length > 0 }));",
      ],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );

    expect(JSON.parse(stdout)).toEqual({ anthropic: true, mcp: true });
  });

  it('contains malformed Jaeger propagation headers without throwing', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { ROOT_CONTEXT } from '@opentelemetry/api'; import { JaegerPropagator } from '@opentelemetry/propagator-jaeger'; const carrier = { 'uber-trace-id': '%E0%A4%A' }; const getter = { keys: value => Object.keys(value), get: (value, key) => value[key] }; const result = new JaegerPropagator().extract(ROOT_CONTEXT, carrier, getter); process.stdout.write(result === ROOT_CONTEXT ? 'contained' : 'context');",
      ],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );

    expect(stdout).toBe('contained');
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
    assertAllLockedPackageVersions(packageLock, 'postcss',
      (version) => isAtLeastStableVersion(version, [8, 5, 25]));
    assertAllLockedPackageVersions(packageLock, 'js-yaml',
      (version) => isAtLeastStableVersion(version, [4, 3, 1]));
    assertAllLockedPackageVersions(
      packageLock,
      'brace-expansion',
      isSafeBraceExpansionVersion,
    );
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
