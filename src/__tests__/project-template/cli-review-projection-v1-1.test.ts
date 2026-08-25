import { describe, expect, it, vi } from 'vitest';
import { types } from 'node:util';
import {
  MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1,
  createProjectTemplateCliReviewProjectionV1_1,
} from '../../features/project-template/cli-review-projection-v1-1.js';

const MANIFEST_ID = 'a'.repeat(64);

function item(path: string, overrides: Record<string, unknown> = {}) {
  return {
    path,
    policy: 'managed',
    action: 'update',
    reason: 'UPSTREAM_CHANGED',
    reviewRequired: false,
    capabilities: [],
    ...overrides,
  };
}

describe('project template CLI review projection v1.1', () => {
  it('creates canonical, order-independent stable identifiers from safe fields', () => {
    const left = createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: [
        item('zeta.yaml', { capabilities: ['github-write', 'executable'] }),
        item('alpha.yaml', {
          action: 'conflict',
          reason: 'BOTH_CHANGED',
          reviewRequired: true,
        }),
      ],
    });
    const right = createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: [
        item('alpha.yaml', {
          action: 'conflict',
          reason: 'BOTH_CHANGED',
          reviewRequired: true,
        }),
        item('zeta.yaml', { capabilities: ['executable', 'github-write'] }),
      ],
    });

    expect(left).toEqual(right);
    expect(left.items.map(({ path }) => path)).toEqual(['alpha.yaml', 'zeta.yaml']);
    expect(left.items[0]).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/u),
      targetId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      path: 'alpha.yaml',
    });
    expect(left.items[0]!.id).not.toBe(left.items[0]!.targetId);
    expect(left.conflicts).toEqual([{
      id: expect.stringMatching(/^[a-f0-9]{64}$/u),
      targetId: left.items[0]!.targetId,
      path: 'alpha.yaml',
      reason: 'BOTH_CHANGED',
      safeDefaultAction: 'abort',
      allowedActions: ['abort'],
    }]);
    expect(left.warnings.map(({ capability }) => capability)).toEqual([
      'executable', 'github-write',
    ]);
  });

  it('keeps target identity stable while item identity binds review semantics', () => {
    const before = createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: [item('workflow.yaml', { action: 'keep', reason: 'UNCHANGED' })],
    });
    const after = createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: [item('workflow.yaml')],
    });

    expect(before.items[0]!.targetId).toBe(after.items[0]!.targetId);
    expect(before.items[0]!.id).not.toBe(after.items[0]!.id);
  });

  it('reports deterministic truncation instead of silently returning an oversized list', () => {
    const items = Array.from(
      { length: MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1 + 1 },
      (_, index) => item(`workflows/${String(index).padStart(3, '0')}.yaml`, {
        capabilities: ['external-command'],
      }),
    );

    const projection = createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items,
    });

    expect(projection.items).toHaveLength(MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1);
    expect(projection.warnings).toHaveLength(MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1);
    expect(projection.summary).toEqual({
      totalItems: 257,
      emittedItems: 256,
      omittedItems: 1,
      totalConflicts: 0,
      emittedConflicts: 0,
      omittedConflicts: 0,
      totalWarnings: 257,
      emittedWarnings: 256,
      omittedWarnings: 1,
      truncated: true,
    });
  });

  it('projects the full bounded core population before applying the public item limit', () => {
    const projection = createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: Array.from({ length: 4_096 }, (_, index) => item(
        `workflows/${String(index).padStart(4, '0')}.yaml`,
      )),
    });

    expect(projection.items).toHaveLength(MAX_PROJECT_TEMPLATE_CLI_REVIEW_ITEMS_V1_1);
    expect(projection.summary).toMatchObject({
      totalItems: 4_096,
      emittedItems: 256,
      omittedItems: 3_840,
      truncated: true,
    });
  });

  it.each([
    '/etc/passwd',
    'C:\\Users\\alice\\secret.yaml',
    '\\\\server\\share\\secret.yaml',
    '../secret.yaml',
    'safe/../secret.yaml',
    `github_pat_${'x'.repeat(30)}.yaml`,
  ])('rejects unsafe or secret-bearing paths: %s', (path) => {
    expect(() => createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: [item(path)],
    })).toThrow();
  });

  it.each([
    [item('workflow.yaml', { policy: 'unknown' })],
    [item('workflow.yaml', { action: 'execute' })],
    [item('workflow.yaml', { reason: 'FREE_FORM_REASON' })],
    [item('workflow.yaml', { capabilities: ['network'] })],
    [item('workflow.yaml'), item('workflow.yaml')],
  ])('rejects duplicate identities and unknown closed enums', (items) => {
    expect(() => createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items,
    })).toThrow();
  });

  it('rejects authority-shaped extra input instead of accidentally projecting it', () => {
    expect(() => createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: [item('workflow.yaml')],
      receiptKey: 'receipt-1',
    } as never)).toThrow();
    expect(() => createProjectTemplateCliReviewProjectionV1_1({
      manifestId: MANIFEST_ID,
      items: [{ ...item('workflow.yaml'), preconditionToken: 'secret' }],
    } as never)).toThrow();
  });

  it('rejects hostile getters and proxies without running their traps', () => {
    const getter = vi.fn(() => [item('workflow.yaml')]);
    const hostile = Object.defineProperty({ manifestId: MANIFEST_ID }, 'items', {
      enumerable: true,
      get: getter,
    });
    const getTrap = vi.fn(Reflect.get);
    const proxy = new Proxy({
      manifestId: MANIFEST_ID,
      items: [item('workflow.yaml')],
    }, { get: getTrap });

    expect(() => createProjectTemplateCliReviewProjectionV1_1(hostile as never)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => createProjectTemplateCliReviewProjectionV1_1(proxy)).toThrow();
    expect(getTrap).not.toHaveBeenCalled();
  });

  it('uses captured intrinsics when ambient validation methods are poisoned', () => {
    const poison = () => { throw new Error('poisoned intrinsic must not run'); };
    const restores: Array<() => void> = [];
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const defineProperty = Object.defineProperty;
    const replace = (receiver: object, key: PropertyKey, value: unknown): void => {
      const descriptor = getDescriptor(receiver, key)!;
      restores.push(() => defineProperty(receiver, key, descriptor));
      defineProperty(receiver, key, { ...descriptor, value });
    };
    let projection;
    try {
      replace(Object, 'getPrototypeOf', poison);
      replace(Object, 'getOwnPropertyDescriptors', poison);
      replace(Object, 'getOwnPropertyDescriptor', poison);
      replace(Reflect, 'ownKeys', poison);
      replace(Array, 'isArray', poison);
      replace(Number, 'isSafeInteger', poison);
      replace(RegExp.prototype, 'test', poison);
      replace(Set.prototype, 'has', poison);
      replace(types, 'isProxy', poison);
      projection = createProjectTemplateCliReviewProjectionV1_1({
        manifestId: MANIFEST_ID,
        items: [item('workflow.yaml', { capabilities: ['executable'] })],
      });
    } finally {
      for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]!();
    }

    expect(projection).toMatchObject({
      items: [{ path: 'workflow.yaml' }],
      warnings: [{ capability: 'executable' }],
    });
  });
});
