import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeTaktpackJson,
} from '../../features/project-template/canonical-json.js';

describe('taktpack canonical JSON intrinsic boundary', () => {
  it('preserves established canonical bytes without mutable collection helpers', () => {
    const descriptors = [
      [JSON, 'stringify'],
      [Array.prototype, 'map'],
      [Array.prototype, 'sort'],
      [Object, 'entries'],
      [Object, 'fromEntries'],
      [String.prototype, 'localeCompare'],
    ].map(([receiver, key]) => [
      receiver,
      key,
      Object.getOwnPropertyDescriptor(receiver, key as PropertyKey)!,
    ] as const);
    let calls = 0;
    let result = '';
    try {
      for (const [receiver, key, descriptor] of descriptors) {
        Object.defineProperty(receiver, key, {
          ...descriptor,
          value() {
            calls += 1;
            throw new Error(`poisoned ${String(key)}`);
          },
        });
      }
      result = canonicalizeTaktpackJson({
        b: 2,
        a: [1, 'x', true, null],
      });
    } finally {
      for (const [receiver, key, descriptor] of descriptors) {
        Object.defineProperty(receiver, key, descriptor);
      }
    }
    expect(calls).toBe(0);
    expect(result).toBe('{"a":[1,"x",true,null],"b":2}\n');
  });

  it('rejects hostile or non-JSON graphs without invoking accessors or proxies', () => {
    const accessor = vi.fn();
    const proxy = vi.fn();
    const accessorValue = {};
    Object.defineProperty(accessorValue, 'value', {
      enumerable: true,
      get: accessor,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const hole = Array(1);
    const symbolKey = { value: 1 } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = 2;
    for (const value of [
      new Proxy({}, { get: proxy, ownKeys: proxy }),
      accessorValue,
      cyclic,
      hole,
      symbolKey,
      { value: Number.NaN },
      { value: undefined },
      { value() {} },
      runInNewContext('({ value: 1 })'),
    ]) expect(() => canonicalizeTaktpackJson(value)).toThrow();
    expect(accessor).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });
});
