import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const workflowPath = resolve('.github/workflows/pr-comment-commands.yml');

interface ReviewEventFixture {
  readonly body: string;
  readonly isPullRequest: boolean;
  readonly authorAssociation: string;
}

interface WorkflowStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, string | boolean | number>>;
  readonly ['working-directory']?: string;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string;
  readonly environment?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps: readonly WorkflowStep[];
}

interface WorkflowContract {
  readonly on?: { readonly issue_comment?: { readonly types?: readonly string[] } };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

function readWorkflow(source = readFileSync(workflowPath, 'utf8')): WorkflowContract {
  return parseYaml(source) as WorkflowContract;
}

function findStep(job: WorkflowJob, idOrName: string): WorkflowStep {
  const step = job.steps.find(candidate => (
    candidate.id === idOrName || candidate.name === idOrName
  ));
  expect(step, `missing workflow step: ${idOrName}`).toBeDefined();
  return step as WorkflowStep;
}

function compileReviewCondition(
  condition: string,
): (event: ReviewEventFixture) => boolean {
  const normalized = condition.replace(/\s+/gu, ' ').trim();
  const semanticShape = normalized.match(
    /^github\.event\.issue\.pull_request != null && \( github\.event\.comment\.body == '(\/[a-z]+)' \|\| startsWith\(github\.event\.comment\.body, '\1 '\) \|\| startsWith\(github\.event\.comment\.body, format\('\1\{0\}', fromJSON\('"\\n"'\)\)\) \) && contains\(fromJSON\('(\[[^']+\])'\), github\.event\.comment\.author_association\)$/u,
  );
  if (semanticShape === null) {
    throw new Error('review condition is outside the closed security grammar');
  }

  const command = semanticShape[1]!;
  const allowedAssociations = JSON.parse(semanticShape[2]!) as unknown;
  if (!Array.isArray(allowedAssociations)
    || allowedAssociations.some(value => typeof value !== 'string')
    || JSON.stringify(allowedAssociations) !== JSON.stringify([
      'OWNER', 'MEMBER', 'COLLABORATOR',
    ])) {
    throw new Error('review condition changed the trusted association set');
  }

  return (event) => event.isPullRequest
    && (
      event.body === command
      || event.body.startsWith(`${command} `)
      || event.body.startsWith(`${command}\n`)
    )
    && allowedAssociations.includes(event.authorAssociation);
}

describe('PR Comment Commands workflow contract', () => {
  it.each([
    ['/review', true],
    ['/review args', true],
    ['/review\nbody', true],
    ['/reviewer', false],
    ['/review-other', false],
    ['/review\tbody', false],
    [' /review', false],
  ] as const)('matches review command body %j: %s', (body, expected) => {
    const workflow = readWorkflow();
    const matches = compileReviewCondition(workflow.jobs.review!.if!);

    expect(matches({
      body,
      isPullRequest: true,
      authorAssociation: 'OWNER',
    })).toBe(expected);
  });

  it('keeps review restricted to PR comments from the exact trusted associations', () => {
    const workflow = readWorkflow();
    const matches = compileReviewCondition(workflow.jobs.review!.if!);

    expect(workflow.on?.issue_comment?.types).toEqual(['created']);
    expect(matches({
      body: '/review', isPullRequest: false, authorAssociation: 'OWNER',
    })).toBe(false);
    expect(matches({
      body: '/review', isPullRequest: true, authorAssociation: 'CONTRIBUTOR',
    })).toBe(false);
    expect(['OWNER', 'MEMBER', 'COLLABORATOR'].every((authorAssociation) => (
      matches({ body: '/review', isPullRequest: true, authorAssociation })
    ))).toBe(true);
  });

  it.each([
    ['OR changed to AND', (condition: string) => condition.replace(/\|\|/u, '&&')],
    ['unconditional suffix', (condition: string) => `${condition.trim()} || true`],
    [
      'association added',
      (condition: string) => condition.replace(
        '"COLLABORATOR"]', '"COLLABORATOR", "CONTRIBUTOR"]',
      ),
    ],
    [
      'association case changed',
      (condition: string) => condition.replace('"OWNER"', '"owner"'),
    ],
  ] as const)('fails closed when source mutation changes semantics: %s', (
    _description,
    mutate,
  ) => {
    const condition = readWorkflow().jobs.review!.if!;
    expect(() => compileReviewCondition(mutate(condition))).toThrow();
  });

  it('runs review only from the immutable trusted base with a fixed builtin workflow', () => {
    const workflow = readWorkflow();
    const review = workflow.jobs.review!;
    const checkout = review.steps.find(step => step.uses === 'actions/checkout@v4')!;
    const run = findStep(review, 'Run trusted TAKT review');
    const allSource = JSON.stringify(review);

    expect(workflow.permissions).toEqual({});
    expect(review.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(checkout.with).toMatchObject({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
    expect(allSource).not.toMatch(/steps\.pr\.outputs|github\.event\.pull_request\.head/iu);
    expect(run['working-directory']).toBe('${{ runner.temp }}/takt-review-workspace');
    expect(run.run).toContain('"$GITHUB_WORKSPACE/dist/app/cli/index.js"');
    expect(run.run).toContain(
      '-w "$GITHUB_WORKSPACE/builtins/en/workflows/review-takt-default.yaml"',
    );
    expect(run.run).toContain('--provider claude');
    expect(run.run).toContain('--task "$REVIEW_TASK"');
    expect(run.run).not.toMatch(/(?:^|\s)--pr(?:\s|$)/u);
    expect(run.run).not.toMatch(/npm install|npm exec|\bbash\b|\bsh\b/iu);
  });

  it('isolates project/user overrides and removes agent shell, web, and extension routes', () => {
    const review = readWorkflow().jobs.review!;
    const run = findStep(review, 'Run trusted TAKT review');
    const providerOptions = JSON.parse(run.env!.TAKT_PROVIDER_OPTIONS!) as {
      claude: { allowed_tools: string[] };
      codex: { network_access: boolean; skills: { repo: boolean; user: boolean } };
      opencode: { network_access: boolean; allowed_tools: string[] };
    };

    expect(run.env).toMatchObject({
      HOME: '${{ runner.temp }}/takt-review-home',
      XDG_CONFIG_HOME: '${{ runner.temp }}/takt-review-home/xdg',
      TAKT_OBSERVABILITY_ENABLED: 'false',
      TAKT_WORKFLOW_ARPEGGIO_CUSTOM_DATA_SOURCE_MODULES: 'false',
      TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_FILES: 'false',
      TAKT_WORKFLOW_ARPEGGIO_CUSTOM_MERGE_INLINE_JS: 'false',
      TAKT_WORKFLOW_COMMAND_GATES_CUSTOM_SCRIPTS: 'false',
      TAKT_WORKFLOW_MCP_SERVERS_HTTP: 'false',
      TAKT_WORKFLOW_MCP_SERVERS_SSE: 'false',
      TAKT_WORKFLOW_MCP_SERVERS_STDIO: 'false',
      TAKT_WORKFLOW_RUNTIME_PREPARE_CUSTOM_SCRIPTS: 'false',
    });
    expect(providerOptions).toEqual({
      claude: { allowed_tools: ['Read', 'Glob', 'Grep'] },
      codex: {
        network_access: false,
        skills: { repo: false, user: false },
      },
      opencode: {
        network_access: false,
        allowed_tools: ['read', 'glob', 'grep'],
      },
    });
    expect(JSON.stringify(providerOptions)).not.toMatch(
      /bash|shell|websearch|webfetch|network_access":true/iu,
    );
  });

  it('separates immutable PR data collection from provider-secret execution', () => {
    const review = readWorkflow().jobs.review!;
    const run = findStep(review, 'Run trusted TAKT review');
    const collect = findStep(review, 'Collect immutable PR data without provider secrets');
    const secretSteps = review.steps.filter(step => (
      JSON.stringify(step.env ?? {}).includes('ANTHROPIC_API_KEY')
    ));

    expect(secretSteps).toEqual([run]);
    expect(run.env).toMatchObject({
      ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}',
      PR_NUMBER: '${{ github.event.issue.number }}',
    });
    expect(run.env).not.toHaveProperty('GH_TOKEN');
    expect(collect.env).toMatchObject({
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      PR_NUMBER: '${{ github.event.issue.number }}',
    });
    expect(collect.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(collect.run).toContain("PR-METADATA.json");
    expect(collect.run).toContain("PR-DIFF.patch");
    expect(collect.run).toContain('head_before');
    expect(collect.run).toContain('head_after');
    expect(collect.run).toContain('5242880');
    expect(collect.run).not.toMatch(/eval|source\s|\.[ \\t]+PR-/iu);
  });

  it('publishes only the exact verified report artifact without checkout or provider secret', () => {
    const workflow = readWorkflow();
    const review = workflow.jobs.review!;
    const publish = workflow.jobs['publish-review']!;
    const upload = findStep(review, 'reports');
    const download = publish.steps.find(step => step.uses === 'actions/download-artifact@v4')!;
    const post = findStep(publish, 'Validate and publish review report');

    expect(review.outputs).toEqual({
      artifact_id: '${{ steps.reports.outputs.artifact-id }}',
    });
    expect(upload.with).toMatchObject({
      name: 'takt-review-report',
      path: '${{ runner.temp }}/takt-review-artifact',
      'if-no-files-found': 'error',
    });
    expect(publish.needs).toBe('review');
    expect(publish.permissions).toEqual({ 'pull-requests': 'write' });
    expect(download.with).toMatchObject({
      'artifact-ids': '${{ needs.review.outputs.artifact_id }}',
      path: '${{ runner.temp }}/takt-review-publish',
      'merge-multiple': true,
    });
    expect(publish.steps.some(step => step.uses === 'actions/checkout@v4')).toBe(false);
    expect(JSON.stringify(publish)).not.toMatch(/ANTHROPIC|TAKT_PROVIDER|npm install/iu);
    expect(post.uses).toBe('actions/github-script@v7');
    expect(post.with?.script).toContain("lstatSync(reportPath)");
    expect(post.with?.script).toContain("createHash('sha256')");
    expect(post.with?.script).toContain('timingSafeEqual');
    expect(post.with?.script).toContain('new TextDecoder');
    expect(post.with?.script).toContain('github.rest.issues.createComment');
  });

  it('never interpolates untrusted comment or PR data into a shell script', () => {
    const review = readWorkflow().jobs.review!;
    const scripts = review.steps
      .map(step => step.run ?? '')
      .join('\n');
    expect(scripts).not.toMatch(
      /\$\{\{\s*github\.event\.(?:comment|issue\.(?:title|body)|pull_request)/u,
    );
  });
});
