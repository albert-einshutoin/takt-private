import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  PreparedProjectTemplateApplyPlan,
  ProjectTemplateApplyMergeDiagnostics,
  ProjectTemplateBaseContent,
  ProjectTemplateGithubRefSourceSpec,
  ProjectTemplateGithubReleaseAssetSourceSpec,
  ProjectTemplateGithubSourceSpec,
} from 'takt';

interface PackageContract {
  exports?: unknown;
  bin?: Record<string, string>;
}

const packageRoot = process.cwd();
const packageContract = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
) as PackageContract;

function runSelfReferenceImport(source: string): string {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: packageRoot,
      encoding: 'utf8',
    },
  ).trim();
}

describe('package exports contract', () => {
  it('exposes the documented root API through package self-reference', () => {
    expect(existsSync(join(packageRoot, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(packageRoot, 'dist', 'index.d.ts'))).toBe(true);
    const declarationEntry = readFileSync(
      join(packageRoot, 'dist', 'index.d.ts'),
      'utf8',
    );

    const result = runSelfReferenceImport(`
      const api = await import('takt');
      process.stdout.write(JSON.stringify({
        create: typeof api.createProjectTemplateApplyPlan,
        prepare: typeof api.prepareProjectTemplateApplyPlan,
        apply: typeof api.applyProjectTemplatePlan,
        parseGithubSource: typeof api.parseProjectTemplateGithubSourceSpec,
      }));
    `);

    expect(JSON.parse(result)).toEqual({
      create: 'function',
      prepare: 'function',
      apply: 'function',
      parseGithubSource: 'function',
    });
    expectTypeOf<PreparedProjectTemplateApplyPlan['resolvedContents']>()
      .toMatchTypeOf<readonly unknown[]>();
    expectTypeOf<ProjectTemplateBaseContent>()
      .toMatchTypeOf<{ path: string; content: Uint8Array }>();
    expectTypeOf<ProjectTemplateApplyMergeDiagnostics>()
      .toMatchTypeOf<{ status: string }>();
    expectTypeOf<ProjectTemplateGithubRefSourceSpec>()
      .toMatchTypeOf<{ kind: 'github-ref'; ref: string }>();
    expectTypeOf<ProjectTemplateGithubReleaseAssetSourceSpec>()
      .toMatchTypeOf<{
        kind: 'github-release-asset';
        assetName: string;
      }>();
    expectTypeOf<ProjectTemplateGithubSourceSpec>()
      .toMatchTypeOf<
        ProjectTemplateGithubRefSourceSpec
        | ProjectTemplateGithubReleaseAssetSourceSpec
      >();
    expect(declarationEntry).toContain('ProjectTemplateBaseContent');
    expect(declarationEntry).toContain('ProjectTemplateApplyMergeDiagnostics');
    expect(declarationEntry).toContain('ProjectTemplateGithubRefSourceSpec');
    expect(declarationEntry).toContain('ProjectTemplateGithubReleaseAssetSourceSpec');
    expect(declarationEntry).toContain('ProjectTemplateGithubSourceSpec');
  });

  it('blocks internal project-template approval deep imports', () => {
    const result = runSelfReferenceImport(`
      try {
        await import('takt/dist/features/project-template/apply-approval.js');
        process.stdout.write('unexpected-success');
      } catch (error) {
        process.stdout.write(error?.code ?? error?.name ?? 'unknown-error');
      }
    `);

    expect(result).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('preserves every documented bin mapping and its built entrypoint', () => {
    expect(packageContract.bin).toEqual({
      takt: './bin/takt',
      'takt-dev': './bin/takt',
      'takt-cli': './dist/app/cli/index.js',
      devloopd: './bin/devloopd.mjs',
    });
    for (const entrypoint of new Set(Object.values(packageContract.bin ?? {}))) {
      expect(existsSync(join(packageRoot, entrypoint))).toBe(true);
    }
  });
});
