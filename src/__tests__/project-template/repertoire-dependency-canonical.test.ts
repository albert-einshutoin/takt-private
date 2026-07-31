import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from '../../features/project-template/repertoire-dependency-canonical.js';

const COMMIT = 'd'.repeat(40);

function dependency(scope = '@acme/repertoire', edit = true) {
  return {
    scope: scope as `@${string}/${string}`,
    version: '1.2.3',
    source: `github:${scope.slice(1)}@v1.2.3` as const,
    commit: COMMIT,
    capabilities: edit ? ['edit'] as const : [] as const,
  };
}

function expected(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

describe('project template repertoire dependency canonical declaration G4.1', () => {
  it('preserves canonical bytes for empty, readonly, and edit declarations', () => {
    for (const dependencies of [
      [],
      [dependency('@acme/readonly', false)],
      [dependency('@acme/edit')],
    ]) {
      expect(calculateProjectTemplateRepertoireDependencyDeclarationSha256(
        dependencies,
      )).toBe(expected(dependencies));
    }
    expect(calculateProjectTemplateRepertoireDependencyDeclarationSha256([
      dependency(),
    ])).toBe('f672d85e355b31ff0ffde241213b3f7c0b8ca769a516f8386252166c080b83ab');
  });

  it('seals the canonical 128 dependency upper bound', () => {
    const dependencies = Array.from({ length: 128 }, (_, index) =>
      dependency(`@a/p${String(index).padStart(3, '0')}`, index % 2 === 0));
    expect(calculateProjectTemplateRepertoireDependencyDeclarationSha256(
      dependencies,
    )).toBe(expected(dependencies));
  });

  it('rejects proxies, accessors, and cross-realm arrays without invoking hooks', () => {
    const proxyGet = vi.fn();
    const accessorGet = vi.fn(() => '@acme/repertoire');
    const accessor = { ...dependency() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'scope', {
      enumerable: true,
      get: accessorGet,
    });
    for (const value of [
      new Proxy([], { get: proxyGet }),
      [accessor],
      runInNewContext(`[{ scope: '@acme/repertoire' }]`),
    ]) {
      expect(() =>
        calculateProjectTemplateRepertoireDependencyDeclarationSha256(value),
      ).toThrow();
    }
    expect(proxyGet).not.toHaveBeenCalled();
    expect(accessorGet).not.toHaveBeenCalled();
  });

  it('does not delegate sealing to post-init mutable intrinsics', () => {
    const jsonDescriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify')!;
    const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'map')!;
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    )!;
    let calls = 0;
    try {
      Object.defineProperty(JSON, 'stringify', {
        ...jsonDescriptor,
        value() {
          calls += 1;
          throw new Error('poisoned stringify');
        },
      });
      Object.defineProperty(Array.prototype, 'map', {
        ...mapDescriptor,
        value() {
          calls += 1;
          throw new Error('poisoned map');
        },
      });
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        ...iteratorDescriptor,
        value() {
          calls += 1;
          throw new Error('poisoned iterator');
        },
      });
      expect(calculateProjectTemplateRepertoireDependencyDeclarationSha256([
        dependency(),
      ])).toBe('f672d85e355b31ff0ffde241213b3f7c0b8ca769a516f8386252166c080b83ab');
    } finally {
      Object.defineProperty(JSON, 'stringify', jsonDescriptor);
      Object.defineProperty(Array.prototype, 'map', mapDescriptor);
      Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
    }
    expect(calls).toBe(0);
  });
});
