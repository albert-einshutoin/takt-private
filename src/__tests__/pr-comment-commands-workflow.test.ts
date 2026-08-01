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

function readReviewContract(): {
  readonly condition: string;
  readonly permissions: Readonly<Record<string, string>>;
} {
  const workflow = parseYaml(readFileSync(workflowPath, 'utf8')) as {
    readonly on?: { readonly issue_comment?: { readonly types?: readonly string[] } };
    readonly jobs?: {
      readonly review?: {
        readonly if?: string;
        readonly permissions?: Readonly<Record<string, string>>;
      };
    };
  };
  expect(workflow.on?.issue_comment?.types).toEqual(['created']);
  expect(workflow.jobs?.review?.if).toBeTypeOf('string');
  return {
    condition: workflow.jobs!.review!.if!,
    permissions: workflow.jobs!.review!.permissions!,
  };
}

function matchesReviewSourceContract(
  condition: string,
  event: ReviewEventFixture,
): boolean {
  const normalized = condition.replace(/\s+/gu, ' ').trim();
  const exactMatch = normalized.match(
    /github\.event\.comment\.body == '(\/[a-z]+)'/u,
  );
  const associationsMatch = normalized.match(
    /contains\(fromJSON\('(\[[^']+\])'\), github\.event\.comment\.author_association\)/u,
  );
  expect(exactMatch).not.toBeNull();
  expect(associationsMatch).not.toBeNull();
  const command = exactMatch![1]!;
  const allowedAssociations = JSON.parse(associationsMatch![1]!) as string[];

  expect(normalized).toContain(
    `github.event.issue.pull_request != null &&`,
  );
  expect(normalized).toContain(
    `startsWith(github.event.comment.body, '${command} ')`,
  );
  expect(normalized).toContain(
    `startsWith(github.event.comment.body, format('${command}{0}', fromJSON('"\\n"')))`,
  );

  const commandMatches = event.body === command
    || event.body.startsWith(`${command} `)
    || event.body.startsWith(`${command}\n`);
  return event.isPullRequest
    && commandMatches
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
    const { condition } = readReviewContract();

    expect(matchesReviewSourceContract(condition, {
      body,
      isPullRequest: true,
      authorAssociation: 'OWNER',
    })).toBe(expected);
  });

  it('keeps review restricted to PR comments from trusted associations', () => {
    const { condition, permissions } = readReviewContract();

    expect(matchesReviewSourceContract(condition, {
      body: '/review', isPullRequest: false, authorAssociation: 'OWNER',
    })).toBe(false);
    expect(matchesReviewSourceContract(condition, {
      body: '/review', isPullRequest: true, authorAssociation: 'CONTRIBUTOR',
    })).toBe(false);
    expect(['OWNER', 'MEMBER', 'COLLABORATOR'].every((authorAssociation) => (
      matchesReviewSourceContract(condition, {
        body: '/review', isPullRequest: true, authorAssociation,
      })
    ))).toBe(true);
    expect(permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });
});
