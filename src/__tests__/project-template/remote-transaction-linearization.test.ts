import { describe, expect, it } from 'vitest';
import {
  linearizePreparedProjectTemplateRemoteTransaction,
} from '../../features/project-template/remote-transaction-linearization.js';

describe('remote transaction approval linearization', () => {
  it('keeps approval retryable when preparation fails before consume', async () => {
    const events: string[] = [];
    let attempts = 0;
    let consumed = false;
    const run = () => linearizePreparedProjectTemplateRemoteTransaction({
      async prepare() {
        events.push('prepare');
        attempts += 1;
        if (attempts === 1) throw new Error('private preparation failure');
        return Object.freeze({ journalId: 'prepared' });
      },
      async consumeApproval() {
        events.push('consume');
        consumed = true;
        return true;
      },
      async publish() {
        events.push('publish');
        return 'committed' as const;
      },
      assertAuthority() {
        events.push('assert');
      },
    });

    await expect(run()).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
    expect(consumed).toBe(false);
    await expect(run()).resolves.toBe('committed');
    expect(events).toEqual([
      'prepare',
      'prepare', 'assert',
      'consume', 'assert',
      'publish', 'assert',
    ]);
  });

  it('allows only one concurrent consumer to reach publish', async () => {
    let consumed = false;
    let publishes = 0;
    const run = () => linearizePreparedProjectTemplateRemoteTransaction({
      async prepare() {
        return Object.freeze({ journalId: 'prepared' });
      },
      async consumeApproval() {
        if (consumed) return false;
        consumed = true;
        await Promise.resolve();
        return true;
      },
      async publish() {
        publishes += 1;
        return 'committed' as const;
      },
      assertAuthority() {},
    });

    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((result) => result.status === 'fulfilled'))
      .toHaveLength(1);
    expect(results.filter((result) => (
      result.status === 'rejected'
      && result.reason?.code === 'APPROVAL_INVALID'
    ))).toHaveLength(1);
    expect(publishes).toBe(1);
  });

  it('burns approval before a publish failure and rejects every retry', async () => {
    let consumed = false;
    let publishes = 0;
    const run = () => linearizePreparedProjectTemplateRemoteTransaction({
      async prepare() {
        return Object.freeze({ journalId: 'prepared' });
      },
      async consumeApproval() {
        if (consumed) return false;
        consumed = true;
        return true;
      },
      async publish() {
        publishes += 1;
        throw new Error('private publish failure');
      },
      assertAuthority() {},
    });

    await expect(run()).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    await expect(run()).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(publishes).toBe(1);
  });

  it.each(['prepare', 'consumeApproval', 'publish'] as const)(
    'reasserts lease authority immediately after %s await',
    async (lostAfter) => {
      let authority = true;
      const run = linearizePreparedProjectTemplateRemoteTransaction({
        async prepare() {
          if (lostAfter === 'prepare') authority = false;
          return Object.freeze({ journalId: 'prepared' });
        },
        async consumeApproval() {
          if (lostAfter === 'consumeApproval') authority = false;
          return true;
        },
        async publish() {
          if (lostAfter === 'publish') authority = false;
          return 'committed' as const;
        },
        assertAuthority() {
          if (!authority) throw Object.assign(new Error('lease lost'), {
            code: 'PROJECT_TEMPLATE_COORDINATION_UNAVAILABLE',
          });
        },
      });

      await expect(run).rejects.toMatchObject({
        code: 'PROJECT_TEMPLATE_COORDINATION_UNAVAILABLE',
      });
    },
  );
});
