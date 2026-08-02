import { describe, expect, it, vi } from 'vitest';
import {
  isProjectTemplateCliExportApprovalError,
  parseProjectTemplateCliExportApprovals,
} from '../../features/project-template/cli-export-approvals.js';

describe('project template CLI export approvals', () => {
  it('returns the same canonical frozen projection for reordered approvals', () => {
    const left = parseProjectTemplateCliExportApprovals({
      policies: ['devloopd.yaml=merge', 'config.yaml=managed'],
      capabilities: ['github-write', 'external-command'],
    });
    const right = parseProjectTemplateCliExportApprovals({
      policies: ['config.yaml=managed', 'devloopd.yaml=merge'],
      capabilities: ['external-command', 'github-write'],
    });
    expect(left).toEqual(right);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.policies)).toBe(true);
    expect(Object.isFrozen(left.approvedCapabilities)).toBe(true);
  });

  it.each([
    ['accessor wrapper', () => Object.defineProperty({}, 'policies', {
      enumerable: true, get: vi.fn(),
    })],
    ['proxy wrapper', () => new Proxy({ policies: [] }, {})],
    ['extra key', () => ({ policies: [], unexpected: true })],
    ['symbol key', () => ({ policies: [], [Symbol('unexpected')]: true })],
  ])('rejects a %s as an exact invalid input', (_label, createInput) => {
    let thrown: unknown;
    try {
      parseProjectTemplateCliExportApprovals(createInput());
    } catch (error) {
      thrown = error;
    }
    expect(isProjectTemplateCliExportApprovalError(thrown)).toBe(true);
  });

  it('uses captured intrinsics after import without invoking poisoned methods', () => {
    const poison = () => { throw new Error('poisoned intrinsic invoked'); };
    const spies = [
      vi.spyOn(Array.prototype, 'sort'),
      vi.spyOn(String.prototype, 'indexOf'),
      vi.spyOn(String.prototype, 'lastIndexOf'),
      vi.spyOn(String.prototype, 'slice'),
    ];
    for (let index = 0; index < spies.length; index += 1) {
      spies[index]!.mockImplementation(poison);
    }
    let result;
    try {
      result = parseProjectTemplateCliExportApprovals({
        policies: ['config.yaml=managed', 'devloopd.yaml=merge'],
        capabilities: ['external-command'],
      });
    } finally {
      for (let index = spies.length - 1; index >= 0; index -= 1) spies[index]!.mockRestore();
    }
    expect(result).toEqual({
      policies: { 'config.yaml': 'managed', 'devloopd.yaml': 'merge' },
      approvedCapabilities: ['external-command'],
    });
  });
});
