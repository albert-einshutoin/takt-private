import { createHash, type Hash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  calculateProjectTemplateManifestSha256,
  validateManifestLockPair,
} from '../../features/project-template/binding.js';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import {
  parseProjectTemplateManifest,
  serializeProjectTemplateManifest,
} from '../../features/project-template/manifest.js';

function manifest(entrySha = 'a'.repeat(64)) {
  return {
    schemaVersion: '1.0',
    packVersion: '1.2.3',
    takt: { minVersion: '0.48.0', maxVersion: '0.49.0' },
    source: {
      kind: 'github',
      uri: 'https://github.com/example/project-template',
      ref: 'v1.2.3',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    capabilities: ['executable'],
    entries: [{
      path: 'hooks/prepare.sh',
      policy: 'managed',
      mode: '0755',
      sha256: entrySha,
      capabilities: ['executable'],
    }],
  };
}

function lockFor(value: ReturnType<typeof manifest>) {
  return {
    schemaVersion: '1.0',
    manifestSha256: calculateProjectTemplateManifestSha256(value),
    packVersion: value.packVersion,
    source: { ...value.source },
    capabilities: [...value.capabilities],
    entries: value.entries.map((entry) => ({
      ...entry,
      capabilities: [...entry.capabilities],
    })),
  };
}

describe('project template manifest composition binding hardening', () => {
  it('preserves the established pretty-JSON manifest digest fixture', () => {
    expect(calculateProjectTemplateManifestSha256(manifest())).toBe(
      '411086b2f823249160e85a6c4663199d7a1e5b8f05f3311c423c32830844bcd1',
    );
  });

  it('preserves pretty-JSON bytes across every optional schema branch', () => {
    const variants = [
      manifest(),
      {
        schemaVersion: '1.0',
        packVersion: '1.0.0',
        takt: { minVersion: '0.48.0' },
        source: {
          kind: 'local',
          uri: '.',
          ref: 'workspace',
          commit: 'b'.repeat(40),
        },
        entries: [],
      },
      {
        ...manifest(),
        capabilities: [],
        entries: [
          {
            path: 'config.yaml',
            policy: 'merge',
            mode: '0644',
            sha256: 'c'.repeat(64),
          },
          {
            path: 'workflows/test.yaml',
            policy: 'managed',
            mode: '0644',
            sha256: 'd'.repeat(64),
            capabilities: [],
          },
        ],
      },
    ];
    for (let index = 0; index < variants.length; index += 1) {
      const parsed = parseProjectTemplateManifest(variants[index]);
      expect(serializeProjectTemplateManifest(variants[index]))
        .toBe(JSON.stringify(parsed, null, 2));
    }
  });

  it('binds distinct manifests without consulting post-init mutable hooks', () => {
    const first = manifest();
    const second = manifest('b'.repeat(64));
    const hashPrototype = Object.getPrototypeOf(createHash('sha256')) as Hash;
    const descriptors = [
      [JSON, 'stringify'],
      [Array.prototype, 'map'],
      [Array.prototype, 'sort'],
      [Array.prototype, 'find'],
      [Array.prototype, 'includes'],
      [Array.prototype, 'push'],
      [Array.prototype, Symbol.iterator],
      [Array, 'from'],
      [Array, 'isArray'],
      [Object, 'entries'],
      [Object, 'values'],
      [Object, 'fromEntries'],
      [Object, 'getOwnPropertyDescriptors'],
      [Object, 'getPrototypeOf'],
      [Reflect, 'apply'],
      [Reflect, 'ownKeys'],
      [hashPrototype, 'update'],
      [hashPrototype, 'digest'],
    ].map(([receiver, key]) => ({
      descriptor: Object.getOwnPropertyDescriptor(receiver, key as PropertyKey)!,
      key: key as PropertyKey,
      receiver,
    }));
    let calls = 0;
    let firstDigest = '';
    let secondDigest = '';
    try {
      for (let index = 0; index < descriptors.length; index += 1) {
        const item = descriptors[index]!;
        Object.defineProperty(item.receiver, item.key, {
          ...item.descriptor,
          value() {
            calls += 1;
            throw new Error('poisoned manifest binding hook');
          },
        });
      }
      firstDigest = calculateProjectTemplateManifestSha256(first);
      secondDigest = calculateProjectTemplateManifestSha256(second);
    } finally {
      for (let index = descriptors.length - 1; index >= 0; index -= 1) {
        const item = descriptors[index]!;
        Object.defineProperty(item.receiver, item.key, item.descriptor);
      }
    }
    expect(calls).toBe(0);
    expect(firstDigest).toBe(
      '411086b2f823249160e85a6c4663199d7a1e5b8f05f3311c423c32830844bcd1',
    );
    expect(secondDigest).not.toBe(firstDigest);
  });

  it('rejects proxy, accessor, and cross-realm manifests without hooks', () => {
    const proxyHook = vi.fn();
    const accessorHook = vi.fn();
    const accessor = manifest() as Record<string, unknown>;
    Object.defineProperty(accessor, 'packVersion', {
      enumerable: true,
      get: accessorHook,
    });
    for (const value of [
      new Proxy({}, { get: proxyHook, ownKeys: proxyHook }),
      accessor,
      runInNewContext('({ schemaVersion: "1.0" })'),
    ]) expect(() => calculateProjectTemplateManifestSha256(value)).toThrow();
    expect(proxyHook).not.toHaveBeenCalled();
    expect(accessorHook).not.toHaveBeenCalled();
  });

  it('compares every source and capability field under poisoned hooks', () => {
    const base = manifest();
    base.capabilities.push('github-write');
    base.entries[0]!.mode = '0644';
    const validLock = lockFor(base);
    const mismatchLocks = [
      { ...validLock, source: { ...validLock.source, commit: 'b'.repeat(40) } },
      { ...validLock, source: { ...validLock.source, ref: 'v1.2.4' } },
      {
        ...validLock,
        source: {
          kind: 'github',
          uri: 'https://github.com/example/another-template',
          ref: validLock.source.ref,
          commit: validLock.source.commit,
        },
      },
      {
        ...validLock,
        source: {
          kind: 'git',
          uri: 'https://git.example.com/project/template.git',
          ref: validLock.source.ref,
          commit: validLock.source.commit,
        },
      },
      { ...validLock, capabilities: ['executable'] },
      {
        ...validLock,
        entries: [{ ...validLock.entries[0]!, capabilities: [] }],
      },
    ];
    const expectedFields = [
      'source', 'source', 'source', 'source',
      'capabilities', 'entries[0].capabilities',
    ];
    const hookTargets = [
      [JSON, 'stringify'],
      [Array.prototype, 'map'],
      [Array.prototype, Symbol.iterator],
      [Object, 'entries'],
      [Object, 'values'],
      [Object, 'fromEntries'],
    ].map(([receiver, key]) => ({
      descriptor: Object.getOwnPropertyDescriptor(receiver, key as PropertyKey)!,
      key: key as PropertyKey,
      receiver,
    }));
    let calls = 0;
    let validError: unknown;
    const actualFields: string[] = [];
    try {
      for (let index = 0; index < hookTargets.length; index += 1) {
        const item = hookTargets[index]!;
        Object.defineProperty(item.receiver, item.key, {
          ...item.descriptor,
          value() {
            calls += 1;
            throw new Error('poisoned manifest lock comparison hook');
          },
        });
      }
      try {
        validateManifestLockPair(base, validLock);
      } catch (error) {
        validError = error;
      }
      for (let index = 0; index < mismatchLocks.length; index += 1) {
        try {
          validateManifestLockPair(base, mismatchLocks[index]);
        } catch (error) {
          if (error instanceof ProjectTemplateValidationError) {
            actualFields.push(error.field ?? '');
          }
        }
      }
    } finally {
      for (let index = hookTargets.length - 1; index >= 0; index -= 1) {
        const item = hookTargets[index]!;
        Object.defineProperty(item.receiver, item.key, item.descriptor);
      }
    }
    expect(validError).toBeUndefined();
    expect(calls).toBe(0);
    expect(actualFields).toEqual(expectedFields);
  });

  it('rejects hostile lock shapes without invoking their hooks', () => {
    const base = manifest();
    const validLock = lockFor(base);
    const proxyHook = vi.fn();
    const accessorHook = vi.fn();
    const accessor = { ...validLock } as Record<string, unknown>;
    Object.defineProperty(accessor, 'packVersion', {
      enumerable: true,
      get: accessorHook,
    });
    for (const value of [
      new Proxy({}, { get: proxyHook, ownKeys: proxyHook }),
      accessor,
      runInNewContext('({ schemaVersion: "1.0" })'),
    ]) expect(() => validateManifestLockPair(base, value)).toThrow();
    expect(proxyHook).not.toHaveBeenCalled();
    expect(accessorHook).not.toHaveBeenCalled();
  });
});
