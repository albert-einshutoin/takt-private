import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import {
  expandInstructionPartials,
  resolveInstructionPartialByName,
} from '../infra/config/loaders/instructionPartials.js';
import type { FacetResolutionContext } from '../infra/config/loaders/resource-resolver.js';

function writePartial(root: string, name: string, content: string): void {
  const dir = join(root, '.takt', 'facets', 'partials', 'instructions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf-8');
}

function buildWorkflow(instruction: string): Record<string, unknown> {
  return {
    name: 'partial-test',
    workflow_config: {},
    steps: [
      {
        name: 'review',
        persona: 'reviewer',
        instruction,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

describe('instruction partials', () => {
  let tempDir: string;
  let projectDir: string;
  let globalDir: string;
  let previousTaktConfigDir: string | undefined;
  let context: FacetResolutionContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-instruction-partials-'));
    projectDir = join(tempDir, 'project');
    globalDir = join(tempDir, 'global');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    previousTaktConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalDir;
    context = { projectDir, workflowDir: projectDir, lang: 'en' };
  });

  afterEach(() => {
    if (previousTaktConfigDir === undefined) {
      delete process.env.TAKT_CONFIG_DIR;
    } else {
      process.env.TAKT_CONFIG_DIR = previousTaktConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('expands a project instruction partial while preserving built-in template variables', () => {
    writePartial(projectDir, 'review-common', 'Shared review baseline for {task}');

    const config = normalizeWorkflowConfig(
      buildWorkflow('Review the diff.\n\n{review-common}\n\nTask: {task}'),
      projectDir,
      context,
    );

    expect(config.steps[0]!.instruction).toContain('Shared review baseline for {task}');
    expect(config.steps[0]!.instruction).toContain('Task: {task}');
  });

  it('prefers project partials over global partials', () => {
    writePartial(projectDir, 'review-common', 'project review rules');
    writePartial(globalDir, 'review-common', 'global review rules');

    const resolved = resolveInstructionPartialByName('review-common', context);

    expect(resolved?.content).toBe('project review rules');
  });

  it('falls back to builtin instruction partials', () => {
    const resolved = resolveInstructionPartialByName('review-common', context);

    expect(resolved?.sourcePath).toContain(join('builtins', 'en', 'facets', 'partials', 'instructions', 'review-common.md'));
    expect(resolved?.content).toContain('Common review baseline');
  });

  it('expands nested instruction partials', () => {
    writePartial(projectDir, 'review-common', 'Common:\n{review-contract}');
    writePartial(projectDir, 'review-contract', 'Check original requirements.');

    const expanded = expandInstructionPartials('Start\n{review-common}', context);

    expect(expanded).toContain('Common:\nCheck original requirements.');
  });

  it('throws on cyclic instruction partial references', () => {
    writePartial(projectDir, 'review-common', 'Common -> {review-contract}');
    writePartial(projectDir, 'review-contract', 'Contract -> {review-common}');

    expect(() => expandInstructionPartials('{review-common}', context)).toThrow(
      /Instruction partial cycle detected: review-common -> review-contract -> review-common/,
    );
  });

  it('throws when an explicit partial reference cannot be resolved', () => {
    expect(() => expandInstructionPartials('{partial:missing-common}', context)).toThrow(
      /Instruction partial "missing-common" not found/,
    );
  });

  it('leaves illustrative brace placeholders untouched when no matching partial exists', () => {
    const expanded = expandInstructionPartials('Use {report-name}.* and keep {task}.', context);

    expect(expanded).toBe('Use {report-name}.* and keep {task}.');
  });
});
