import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  DownloadedGithubTemplateSource,
  DownloadGithubTemplateSourceOptions,
  GithubTemplateArchiveAssetInput,
  GithubTemplateArchiveAssetPort,
  GithubTemplateDownloadOrchestratorErrorCode,
  GithubTemplateSourceAdvisory,
  GithubTemplateSourceResolutionInput,
  GithubTemplateSourceResolverPort,
  PreparedProjectTemplateApplyPlan,
  ProjectTemplateApplyMergeDiagnostics,
  ProjectTemplateBaseContent,
  ProjectTemplateGithubRefSourceSpec,
  ProjectTemplateGithubReleaseAssetSourceSpec,
  ProjectTemplateGithubSourceSpec,
  ProjectTemplateRepertoireCapabilityV1,
  ProjectTemplateRepertoireDependencyV1,
  ProjectTemplateGithubSourceComposition,
  ProjectTemplateGithubSourceCompositionDependencies,
  ProjectTemplateSourceDescriptorPackV1,
  ProjectTemplateSourceDescriptorV1,
  ProjectTemplateApplyPreview,
  ProjectTemplateApplyPreviewApprovalEvidence,
  ProjectTemplateApplyPreviewBindings,
  ProjectTemplateApplyPreviewCompositionConflictCode,
  ProjectTemplateApplyPreviewContentHardConflict,
  ResolvedGithubTemplateSource,
  GithubTemplateSourceMetadataPort,
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
    const compositionDeclaration = readFileSync(
      join(
        packageRoot,
        'dist',
        'infra',
        'github',
        'project-template-github-source-composition.d.ts',
      ),
      'utf8',
    );
    expect(declarationEntry).not.toContain(
      'resolveGithubTemplateSourceForAuthenticatedDownload',
    );

    const result = runSelfReferenceImport(`
      const api = await import('takt');
      process.stdout.write(JSON.stringify({
        create: typeof api.createProjectTemplateApplyPlan,
        prepare: typeof api.prepareProjectTemplateApplyPlan,
        apply: typeof api.applyProjectTemplatePlan,
        parseGithubSource: typeof api.parseProjectTemplateGithubSourceSpec,
        parseSourceDescriptor: typeof api.parseProjectTemplateSourceDescriptor,
        serializeSourceDescriptor: typeof api.serializeProjectTemplateSourceDescriptor,
        hashSourceDescriptor: typeof api.calculateProjectTemplateSourceDescriptorSha256,
        parseSourceDescriptorJson: typeof api.parseProjectTemplateSourceDescriptorJson,
        sourceDescriptorPath: api.PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_PATH,
        sourceDescriptorMaxBytes: api.MAX_PROJECT_TEMPLATE_SOURCE_DESCRIPTOR_BYTES,
        sourceDescriptorSchema: typeof api.projectTemplateSourceDescriptorV1JsonSchema,
        resolveGithubTemplateSource: typeof api.resolveGithubTemplateSource,
        demoteGithubTemplateSource:
          typeof api.demoteResolvedGithubTemplateSourceToAdvisory,
        discardGithubTemplateSource:
          typeof api.discardResolvedGithubTemplateSource,
        sourceResolutionError: typeof api.GithubTemplateSourceResolutionError,
        downloadGithubTemplateSource: typeof api.downloadGithubTemplateSource,
        downloadOrchestratorError:
          typeof api.GithubTemplateDownloadOrchestratorError,
        createGithubSourceComposition:
          typeof api.createProjectTemplateGithubSourceComposition,
      }));
    `);

    expect(JSON.parse(result)).toEqual({
      create: 'function',
      prepare: 'function',
      apply: 'function',
      parseGithubSource: 'function',
      parseSourceDescriptor: 'function',
      serializeSourceDescriptor: 'function',
      hashSourceDescriptor: 'function',
      parseSourceDescriptorJson: 'function',
      sourceDescriptorPath: '.takt-template-source.json',
      sourceDescriptorMaxBytes: 65536,
      sourceDescriptorSchema: 'object',
      resolveGithubTemplateSource: 'function',
      demoteGithubTemplateSource: 'function',
      discardGithubTemplateSource: 'function',
      sourceResolutionError: 'function',
      downloadGithubTemplateSource: 'function',
      downloadOrchestratorError: 'function',
      createGithubSourceComposition: 'function',
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
    expectTypeOf<ProjectTemplateSourceDescriptorV1>()
      .toMatchTypeOf<{
        schemaVersion: '1.0';
        repertoireDependencies: readonly unknown[];
      }>();
    expectTypeOf<ProjectTemplateSourceDescriptorPackV1>()
      .toMatchTypeOf<{ version: string; sha256: string }>();
    expectTypeOf<ProjectTemplateRepertoireDependencyV1>()
      .toMatchTypeOf<{ scope: `@${string}/${string}`; version: string }>();
    expectTypeOf<ProjectTemplateRepertoireCapabilityV1>()
      .toEqualTypeOf<'edit'>();
    expectTypeOf<ResolvedGithubTemplateSource>()
      .toMatchTypeOf<{
        canonicalSource: string;
        commit: string;
        downloadEligible: boolean;
      }>();
    expectTypeOf<GithubTemplateSourceAdvisory>()
      .toMatchTypeOf<{
        kind: 'github-template-source-advisory';
        source: { commit: string };
        release: { asset: { id: number } };
      }>();
    expectTypeOf<GithubTemplateSourceMetadataPort>()
      .toHaveProperty('resolveRefToCommit');
    expectTypeOf<GithubTemplateSourceResolverPort>()
      .toHaveProperty('resolveForDownload');
    expectTypeOf<GithubTemplateSourceResolutionInput>()
      .toMatchTypeOf<{ source: string }>();
    expectTypeOf<DownloadGithubTemplateSourceOptions>()
      .toHaveProperty('resolver');
    expectTypeOf<DownloadGithubTemplateSourceOptions>()
      .toHaveProperty('asset');
    expectTypeOf<DownloadedGithubTemplateSource>()
      .toMatchTypeOf<{
        status: 'downloaded';
        artifactState: 'cache-published';
        receiptState: 'receipt-published';
      }>();
    expectTypeOf<GithubTemplateArchiveAssetInput>()
      .toMatchTypeOf<{
        owner: string;
        repo: string;
        releaseId: number;
        assetId: number;
        maxBytes: number;
      }>();
    expectTypeOf<GithubTemplateArchiveAssetPort>()
      .toHaveProperty('openReleaseAsset');
    expectTypeOf<GithubTemplateDownloadOrchestratorErrorCode>()
      .toMatchTypeOf<string>();
    expectTypeOf<ProjectTemplateGithubSourceComposition>()
      .toMatchTypeOf<{
        resolver: GithubTemplateSourceResolverPort;
        archive: GithubTemplateArchiveAssetPort;
      }>();
    expectTypeOf<ProjectTemplateGithubSourceCompositionDependencies>()
      .toHaveProperty('requestMetadata');
    expect(declarationEntry).toContain('ProjectTemplateBaseContent');
    expect(declarationEntry).toContain('ProjectTemplateApplyMergeDiagnostics');
    expect(declarationEntry).toContain('ProjectTemplateGithubRefSourceSpec');
    expect(declarationEntry).toContain('ProjectTemplateGithubReleaseAssetSourceSpec');
    expect(declarationEntry).toContain('ProjectTemplateGithubSourceSpec');
    expect(declarationEntry).toContain('ProjectTemplateSourceDescriptorV1');
    expect(declarationEntry).toContain('ProjectTemplateSourceDescriptorPackV1');
    expect(declarationEntry).toContain('ProjectTemplateRepertoireDependencyV1');
    expect(declarationEntry).toContain('ProjectTemplateRepertoireCapabilityV1');
    expect(declarationEntry).toContain('ResolvedGithubTemplateSource');
    expect(declarationEntry).toContain('GithubTemplateSourceAdvisory');
    expect(declarationEntry).toContain('GithubTemplateSourceMetadataPort');
    expect(declarationEntry).toContain('GithubTemplateSourceResolverPort');
    expect(declarationEntry).toContain('GithubTemplateSourceResolutionInput');
    expect(declarationEntry).toContain('DownloadGithubTemplateSourceOptions');
    expect(declarationEntry).toContain('DownloadedGithubTemplateSource');
    expect(declarationEntry).toContain('GithubTemplateArchiveAssetInput');
    expect(declarationEntry).toContain('GithubTemplateArchiveAssetPort');
    expect(declarationEntry)
      .toContain('GithubTemplateDownloadOrchestratorErrorCode');
    expect(declarationEntry)
      .toContain('ProjectTemplateGithubSourceComposition');
    expect(declarationEntry)
      .toContain('ProjectTemplateGithubSourceCompositionDependencies');
    expect(compositionDeclaration).toContain('does not enforce approval');
    expect(compositionDeclaration)
      .toContain('downloadGithubTemplateSource(...).asset');
  });

  it('keeps GitHub template download storage authority out of the root API', () => {
    const result = runSelfReferenceImport(`
      const api = await import('takt');
      process.stdout.write(JSON.stringify({
        stage: typeof api.stageGithubTemplateDownload,
        materialize: typeof api.materializeGithubTemplateCache,
        discard: typeof api.discardStagedGithubTemplateDownload,
        prepareReceipt: typeof api.prepareGithubTemplateDownloadReceipt,
        storeReceipt: typeof api.storeGithubTemplateDownloadReceipt,
        claimReceipt: typeof api.claimPreparedGithubTemplateDownloadReceiptForStorage,
      }));
    `);
    expect(JSON.parse(result)).toEqual({
      stage: 'undefined',
      materialize: 'undefined',
      discard: 'undefined',
      prepareReceipt: 'undefined',
      storeReceipt: 'undefined',
      claimReceipt: 'undefined',
    });

    const declarationEntry = readFileSync(
      join(packageRoot, 'dist', 'index.d.ts'),
      'utf8',
    );
    expect(declarationEntry).not.toContain('StagedGithubTemplateDownload');
    expect(declarationEntry).not.toContain('MaterializedGithubTemplateCache');
    expect(declarationEntry).not.toContain('PreparedGithubTemplateDownloadReceipt');
    expect(declarationEntry).not.toContain('StoredGithubTemplateDownloadReceipt');
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

  it('publishes only the safe apply-preview review surface', () => {
    const result = runSelfReferenceImport(`
      const api = await import('takt');
      process.stdout.write(JSON.stringify({
        renderHuman: typeof api.renderProjectTemplateApplyPreviewHuman,
        renderJson: typeof api.renderProjectTemplateApplyPreviewJson,
        create: typeof api.createProjectTemplateApplyPreview,
        assert: typeof api.assertProjectTemplateApplyPreview,
        hash: typeof api.projectTemplateApplyPreviewReviewSurfaceSha256,
        issue: typeof api.issueTrustedProjectTemplateApplyPreviewApproval,
        consume: typeof api.consumeProjectTemplateApplyPreviewApproval,
        revoke: typeof api.revokeProjectTemplateApplyPreviewApproval,
        isEvidence: typeof api.isProjectTemplateApplyPreviewApprovalEvidence,
      }));
    `);
    expect(JSON.parse(result)).toEqual({
      renderHuman: 'function',
      renderJson: 'function',
      create: 'undefined',
      assert: 'undefined',
      hash: 'undefined',
      issue: 'undefined',
      consume: 'undefined',
      revoke: 'undefined',
      isEvidence: 'undefined',
    });

    expectTypeOf<ProjectTemplateApplyPreview>()
      .toHaveProperty('bindings');
    expectTypeOf<ProjectTemplateApplyPreviewBindings>()
      .toHaveProperty('repertoireDependencyPlanId');
    expectTypeOf<ProjectTemplateApplyPreviewCompositionConflictCode>()
      .toEqualTypeOf<'MANIFEST_BINDING_MISMATCH'>();
    expectTypeOf<ProjectTemplateApplyPreviewContentHardConflict>()
      .toHaveProperty('code');
    expectTypeOf<ProjectTemplateApplyPreviewApprovalEvidence>()
      .toHaveProperty('approvalId');

    const declarationEntry = readFileSync(
      join(packageRoot, 'dist', 'index.d.ts'),
      'utf8',
    );
    for (const exported of [
      'renderProjectTemplateApplyPreviewHuman',
      'renderProjectTemplateApplyPreviewJson',
      'ProjectTemplateApplyPreview',
      'ProjectTemplateApplyPreviewBindings',
      'ProjectTemplateApplyPreviewCompositionConflictCode',
      'ProjectTemplateApplyPreviewContentHardConflict',
      'ProjectTemplateApplyPreviewApprovalEvidence',
    ]) expect(declarationEntry).toContain(exported);
    for (const forbidden of [
      'createProjectTemplateApplyPreview',
      'assertProjectTemplateApplyPreview',
      'projectTemplateApplyPreviewReviewSurfaceSha256',
      'issueTrustedProjectTemplateApplyPreviewApproval',
      'consumeProjectTemplateApplyPreviewApproval',
      'revokeProjectTemplateApplyPreviewApproval',
      'isProjectTemplateApplyPreviewApprovalEvidence',
      'ProjectTemplateApplyPreviewOptions',
      'ProjectTemplateApplyStorage',
    ]) expect(declarationEntry).not.toContain(forbidden);
  });

  it.each([
    'apply-preview.js',
    'apply-preview-approval.js',
    'apply-storage.js',
  ])('blocks internal project-template %s deep imports', (moduleName) => {
    const result = runSelfReferenceImport(`
      try {
        await import('takt/dist/features/project-template/${moduleName}');
        process.stdout.write('unexpected-success');
      } catch (error) {
        process.stdout.write(error?.code ?? error?.name ?? 'unknown-error');
      }
    `);
    expect(result).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
  });

  it('keeps low-level project-template mutation leases internal', () => {
    const result = runSelfReferenceImport(`
      const api = await import('takt');
      process.stdout.write(JSON.stringify({
        acquireMutationLease: typeof api.acquireProjectTemplateMutationLease,
        assertMutationLease: typeof api.assertProjectTemplateMutationLeaseOwned,
        acquireApplyLease: typeof api.acquireProjectTemplateApplyLease,
      }));
    `);
    expect(JSON.parse(result)).toEqual({
      acquireMutationLease: 'undefined',
      assertMutationLease: 'undefined',
      acquireApplyLease: 'undefined',
    });

    const declarationEntry = readFileSync(
      join(packageRoot, 'dist', 'index.d.ts'),
      'utf8',
    );
    expect(declarationEntry).not.toContain('ProjectTemplateMutationLease');
    expect(declarationEntry).not.toContain('acquireProjectTemplateApplyLease');
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
