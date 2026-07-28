import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowConfig } from '../core/models/index.js';
import {
  iterateWorkflowDir,
  loadAllWorkflowsWithSourcesFromDirs,
} from '../infra/config/loaders/workflowDiscovery.js';

describe('workflowDiscovery', () => {
  it.each(['en', 'ja'] as const)('persists a shared report for every raw fix step in %s workflows', (language) => {
    const rootDir = process.cwd();
    const workflowsDir = join(rootDir, 'builtins', language, 'workflows');
    const workflows = loadAllWorkflowsWithSourcesFromDirs<WorkflowConfig>(
      rootDir,
      [{ dir: workflowsDir, source: 'builtin' }],
      undefined,
      undefined,
      true,
    );
    const rawFixSteps = Array.from(iterateWorkflowDir(workflowsDir, 'builtin')).flatMap((entry) => {
      const rawWorkflow = parseYaml(readFileSync(entry.path, 'utf-8')) as {
        steps?: Array<{ name?: unknown; instruction?: unknown }>;
      };
      const rawFixStepNames = (rawWorkflow.steps ?? [])
        .filter((step) => step.instruction === 'fix')
        .map((step) => step.name);
      const workflow = workflows.get(entry.name);

      expect(workflow).toBeDefined();
      return rawFixStepNames.map((stepName) => {
        expect(typeof stepName).toBe('string');
        const normalizedStep = workflow?.config.steps.find((candidate) => candidate.name === stepName);
        expect(normalizedStep).toBeDefined();
        return normalizedStep!;
      });
    });

    // Raw instruction matching intentionally excludes private maintenance/supervisor variants:
    // their finding lifecycles and output contracts are independent from the shared fix step.
    expect(rawFixSteps.length).toBeGreaterThan(0);
    for (const step of rawFixSteps) {
      expect(step.outputContracts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'fix-report.md',
          format: expect.stringContaining('decision_id'),
          useJudge: false,
        }),
      ]));
    }
  });

  it('keeps the shared raw fix workflow set aligned between en and ja', () => {
    const rawFixWorkflowNames = (language: 'en' | 'ja'): string[] => {
      const workflowsDir = join(process.cwd(), 'builtins', language, 'workflows');
      return Array.from(iterateWorkflowDir(workflowsDir, 'builtin'))
        .filter((entry) => {
          const rawWorkflow = parseYaml(readFileSync(entry.path, 'utf-8')) as {
            steps?: Array<{ instruction?: unknown }>;
          };
          return (rawWorkflow.steps ?? []).some((step) => step.instruction === 'fix');
        })
        .map((entry) => entry.name)
        .sort();
    };

    expect(rawFixWorkflowNames('ja')).toEqual(rawFixWorkflowNames('en'));
  });

  it.each([
    {
      language: 'en',
      headings: [
        '## Addressed Findings',
        '## Remaining Findings',
        '## Verification',
        '## Family Coverage',
        '## Decision and Resume Continuity',
      ],
      privacyRule: 'Never include secrets, credentials, tokens, full prompts, raw decision text, verbatim private source text, or unbounded logs.',
    },
    {
      language: 'ja',
      headings: [
        '## 対応した指摘',
        '## 残存する指摘',
        '## 検証',
        '## ファミリー網羅性',
        '## 判断と再開の連続性',
      ],
      privacyRule: '秘密情報、認証情報、トークン、プロンプト全文、判断回答の原文、privateなソース原文、無制限のログを含めないこと。',
    },
  ])('keeps the $language fix report complete and privacy-bounded', ({ language, headings, privacyRule }) => {
    const contract = readFileSync(
      join(process.cwd(), 'builtins', language, 'facets', 'output-contracts', 'fix-report.md'),
      'utf-8',
    );

    for (const heading of headings) {
      expect(contract).toContain(heading);
    }
    expect(contract).toContain(privacyRule);
    expect(contract).toContain('decision_id');
  });

  it('repo 直下でも builtin の privileged workflow を discovery で skip しない', () => {
    const onWarning = vi.fn();
    const workflows = loadAllWorkflowsWithSourcesFromDirs(
      process.cwd(),
      [{
        dir: join(process.cwd(), 'builtins', 'ja', 'workflows'),
        source: 'builtin',
      }],
      { onWarning },
    );

    expect(onWarning.mock.calls).toEqual([]);
    expect(workflows.has('auto-improvement-loop')).toBe(true);
  });

  it('provider-options ディレクトリ内の YAML を workflow として discovery しない', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'takt-workflow-discovery-'));
    try {
      mkdirSync(join(tempDir, 'provider-options'));
      writeFileSync(join(tempDir, 'provider-options', 'review-readonly.yaml'), [
        'name: review-readonly',
        'steps:',
        '  - name: review',
        '    instruction: "{task}"',
      ].join('\n'));
      writeFileSync(join(tempDir, 'sample.yaml'), [
        'name: sample',
        'steps:',
        '  - name: plan',
        '    instruction: "{task}"',
      ].join('\n'));

      const workflows = loadAllWorkflowsWithSourcesFromDirs(
        process.cwd(),
        [{ dir: tempDir, source: 'project' }],
      );

      expect(workflows.has('sample')).toBe(true);
      expect(workflows.has('provider-options/review-readonly')).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
