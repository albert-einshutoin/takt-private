import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatPrReviewAsTask } from '../infra/git/format.js';
import type { PrReviewData } from '../infra/git/types.js';
import {
  collectPrImageAttachments,
  extractPrImageReferences,
} from '../features/tasks/prImageAttachments.js';

const mockExecFileSync = vi.hoisted(() => vi.fn(() => 'gh-token\n'));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

const tempRoots = new Set<string>();
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-pr-image-attachments-test-'));
  tempRoots.add(root);
  return root;
}

function createPrReview(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    number: 42,
    title: 'Screenshot PR',
    body: '',
    url: 'https://github.com/owner/repo/pull/42',
    headRefName: 'feature/screenshots',
    baseRefName: 'main',
    comments: [],
    reviews: [],
    files: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

beforeEach(() => {
  mockExecFileSync.mockClear();
  mockExecFileSync.mockReturnValue('gh-token\n');
});

describe('extractPrImageReferences', () => {
  it('extracts GitHub markdown and HTML image URLs from PR body, comments, and review threads', () => {
    const firstUrl = 'https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111';
    const secondUrl = 'https://github.com/owner/repo/assets/22222222-2222-2222-2222-222222222222';
    const externalUrl = 'https://example.com/not-downloaded.png';

    const refs = extractPrImageReferences(createPrReview({
      body: `![body shot](${firstUrl})`,
      comments: [{ author: 'dev', body: `<img src="${secondUrl}" />` }],
      reviews: [{ author: 'reviewer', body: `![duplicate](${firstUrl}) ![external](${externalUrl})` }],
    }));

    expect(refs.map((ref) => ref.url)).toEqual([firstUrl, secondUrl]);
  });
});

describe('collectPrImageAttachments', () => {
  it('downloads PR image references, writes task attachments, and rewrites task content to placeholders', async () => {
    const firstUrl = 'https://github.com/user-attachments/assets/11111111-1111-1111-1111-111111111111';
    const secondUrl = 'https://github.com/owner/repo/assets/22222222-2222-2222-2222-222222222222';
    const tmpRoot = createTempRoot();
    const prReview = createPrReview({
      body: `Please inspect ![body shot](${firstUrl}).`,
      comments: [{ author: 'dev', body: `<img src="${secondUrl}" />` }],
    });
    const headersByUrl = new Map<string, Record<string, string>>();

    const result = await collectPrImageAttachments(prReview, '/repo', {
      tmpRoot,
      sessionId: 'pr-42',
      fetchImage: async (url, options) => {
        headersByUrl.set(url, options.headers);
        return {
          data: url === firstUrl ? pngBytes : jpegBytes,
          contentType: url === firstUrl ? 'image/png' : 'image/jpeg',
        };
      },
    });
    const rewritten = result.rewriteTaskContent(formatPrReviewAsTask(prReview));

    expect(result.attachments).toEqual([
      {
        placeholder: '[Image #1]',
        tempPath: path.join(tmpRoot, 'takt', 'pr-42', 'attachments', 'image-1.png'),
        fileName: 'image-1.png',
      },
      {
        placeholder: '[Image #2]',
        tempPath: path.join(tmpRoot, 'takt', 'pr-42', 'attachments', 'image-2.jpg'),
        fileName: 'image-2.jpg',
      },
    ]);
    expect(fs.readFileSync(result.attachments[0]!.tempPath)).toEqual(pngBytes);
    expect(fs.readFileSync(result.attachments[1]!.tempPath)).toEqual(jpegBytes);
    expect(rewritten).toContain('Please inspect [Image #1].');
    expect(rewritten).toContain('**dev**: [Image #2]');
    expect(rewritten).not.toContain(firstUrl);
    expect(rewritten).not.toContain(secondUrl);
    expect(headersByUrl.get(firstUrl)).toEqual({ Authorization: 'Bearer gh-token' });
    expect(headersByUrl.get(secondUrl)).toEqual({ Authorization: 'Bearer gh-token' });
  });

  it('does not send gh auth headers to user-images CDN downloads', async () => {
    const url = 'https://user-images.githubusercontent.com/123456/shot.png';
    const tmpRoot = createTempRoot();
    const headersByUrl = new Map<string, Record<string, string>>();

    await collectPrImageAttachments(createPrReview({
      body: `![cdn shot](${url})`,
    }), '/repo', {
      tmpRoot,
      fetchImage: async (downloadUrl, options) => {
        headersByUrl.set(downloadUrl, options.headers);
        return {
          data: pngBytes,
          contentType: 'image/png',
        };
      },
    });

    expect(headersByUrl.get(url)).toEqual({});
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('rejects downloads whose content type and magic bytes do not describe a supported image', async () => {
    const url = 'https://github.com/user-attachments/assets/33333333-3333-3333-3333-333333333333';

    await expect(collectPrImageAttachments(createPrReview({
      body: `![bad](${url})`,
    }), '/repo', {
      tmpRoot: createTempRoot(),
      fetchImage: async () => ({
        data: Buffer.from('not an image'),
        contentType: 'image/png',
      }),
    })).rejects.toThrow(`Invalid PR image attachment content: ${url}`);
  });
});
