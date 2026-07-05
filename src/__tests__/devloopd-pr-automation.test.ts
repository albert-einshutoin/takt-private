import { describe, expect, it } from 'vitest';
import {
  findCurrentHeadBlockingReview,
  findDuplicateIssueCoverage,
  parseAutomationPullRequests,
  selectAutomationPullRequests,
} from '../devloopd/prAutomation.js';

describe('devloopd PR automation orchestration', () => {
  it('discovers non-draft automation PRs from mocked GitHub output', () => {
    const prs = parseAutomationPullRequests(JSON.stringify([
      {
        number: 10,
        title: 'fix: issue 40',
        body: 'Closes #40',
        headRefName: 'takt/issue-40',
        headRefOid: 'abc123',
        isDraft: false,
        author: { login: 'dev' },
        labels: [{ name: 'agent:ready' }],
      },
      {
        number: 11,
        title: 'draft',
        body: 'Closes #41',
        headRefName: 'takt/issue-41',
        headRefOid: 'def456',
        isDraft: true,
        author: { login: 'dev' },
        labels: [],
      },
      {
        number: 12,
        title: 'deps',
        body: '',
        headRefName: 'dependabot/npm',
        headRefOid: 'fedcba',
        isDraft: false,
        author: { login: 'dependabot[bot]' },
        labels: [],
      },
    ]));

    expect(selectAutomationPullRequests(prs).map((pr) => pr.number)).toEqual([10]);
  });

  it('keeps duplicate issue coverage as a distinct stop rule', () => {
    const prs = parseAutomationPullRequests(JSON.stringify([
      {
        number: 10,
        title: 'fix: issue 40',
        body: 'Closes #40',
        headRefName: 'takt/issue-40-a',
        headRefOid: 'abc123',
        isDraft: false,
        author: { login: 'dev' },
        labels: [],
      },
      {
        number: 11,
        title: 'fix: issue 40 again',
        body: 'Fixes #40',
        headRefName: 'automation/issue-40-b',
        headRefOid: 'def456',
        isDraft: false,
        author: { login: 'dev' },
        labels: [],
      },
    ]));

    expect(findDuplicateIssueCoverage(prs)).toEqual([
      {
        issue: 40,
        prNumbers: [10, 11],
        stopRule: 'Duplicate or already covered',
      },
    ]);
  });

  it('detects current-head Mergeable: NO reviews as a review-fix stop rule', () => {
    const blocker = findCurrentHeadBlockingReview({
      headSha: 'abc123',
      comments: [
        {
          body: '<!-- takt-loop-mergeability-review -->\nHead SHA: `old456`\n\nMergeable: NO\nReason: stale',
        },
        {
          body: '<!-- takt-loop-mergeability-review -->\nHead SHA: `abc123`\n\nMergeable: NO\nReason: current blocker',
        },
      ],
    });

    expect(blocker).toMatchObject({
      reviewer: 'agy',
      decision: 'blocked',
      headSha: 'abc123',
    });
  });
});
