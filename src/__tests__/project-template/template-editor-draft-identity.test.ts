import { describe, expect, it, vi } from 'vitest';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import {
  calculateProjectTemplateDraftId,
} from '../../features/project-template/template-editor-draft-identity.js';

const identity = () => ({
  parentArchiveSha256: 'a'.repeat(64),
  parentManifestSha256: 'b'.repeat(64),
  parentPackVersion: '1.2.3',
  editDocumentSha256: 'd'.repeat(64),
});

describe('project template editor draft identity', () => {
  it('binds a stable content-addressed draft ID to its base and canonical edit document', () => {
    expect(calculateProjectTemplateDraftId(identity())).toBe(
      '5198ee162708cc1228cfc395628c783b0016f243bc4b4b538cf61bb1964eeddc',
    );
  });

  it.each([
    ['parent archive', { parentArchiveSha256: 'c'.repeat(64) }],
    ['parent manifest', { parentManifestSha256: 'c'.repeat(64) }],
    ['parent version', { parentPackVersion: '1.2.4' }],
    ['edit document', { editDocumentSha256: 'c'.repeat(64) }],
  ])('changes when the %s identity changes', (_label, change) => {
    expect(calculateProjectTemplateDraftId({ ...identity(), ...change }))
      .not.toBe(calculateProjectTemplateDraftId(identity()));
  });

  it.each([
    ['parentArchiveSha256', { parentArchiveSha256: 'not-a-hash' }],
    ['parentManifestSha256', { parentManifestSha256: 'A'.repeat(64) }],
    ['parentPackVersion', { parentPackVersion: 'v1.2.3' }],
    ['editDocumentSha256', { editDocumentSha256: 'd'.repeat(63) }],
  ])('rejects an invalid %s before issuing an identity', (field, change) => {
    expect(() => calculateProjectTemplateDraftId({ ...identity(), ...change }))
      .toThrow(ProjectTemplateValidationError);
    try {
      calculateProjectTemplateDraftId({ ...identity(), ...change });
    } catch (error) {
      expect((error as ProjectTemplateValidationError).field).toBe(field);
    }
  });

  it('rejects accessors and proxies without invoking caller-owned hooks', () => {
    const accessor = vi.fn();
    const proxy = vi.fn();
    const accessorInput = identity() as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'editDocumentSha256', {
      enumerable: true,
      get: accessor,
    });

    expect(() => calculateProjectTemplateDraftId(accessorInput)).toThrow();
    expect(() => calculateProjectTemplateDraftId(new Proxy({}, {
      get: proxy,
      ownKeys: proxy,
    }))).toThrow();
    expect(accessor).not.toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
  });
});
