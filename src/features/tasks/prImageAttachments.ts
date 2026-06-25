import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrReviewData } from '../../infra/git/types.js';
import type { TaskAttachment } from './attachments.js';

export interface PrImageReference {
  url: string;
}

export interface DownloadedPrImage {
  data: Buffer;
  contentType?: string;
}

export interface CollectPrImageAttachmentsOptions {
  tmpRoot?: string;
  sessionId?: string;
  maxBytes?: number;
  fetchImage?: (
    url: string,
    options: { headers: Record<string, string>; maxBytes: number; cwd: string },
  ) => Promise<DownloadedPrImage>;
}

export interface CollectedPrImageAttachments {
  attachments: TaskAttachment[];
  rewriteTaskContent(taskContent: string): string;
}

type ImageKind = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  extension: 'png' | 'jpg' | 'gif' | 'webp';
};

type DownloadedAttachment = TaskAttachment & {
  sourceUrl: string;
};

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\r\n]*]\(\s*(<[^>\r\n]+>|[^)\s\r\n]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMAGE_PATTERN = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  fs.chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
}

function normalizeCandidateUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim().replace(/^<|>$/g, '');
  try {
    const url = new URL(trimmed);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function isAllowedGithubImageUrl(urlText: string): boolean {
  const url = new URL(urlText);
  if (url.protocol !== 'https:') {
    return false;
  }

  // PR comment content is untrusted, so downloads are limited to GitHub-hosted image attachment URLs.
  if (url.hostname === 'user-images.githubusercontent.com') {
    return true;
  }
  if (url.hostname !== 'github.com') {
    return false;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  return (
    (segments[0] === 'user-attachments' && segments[1] === 'assets' && segments.length >= 3)
    || (segments.length >= 4 && segments[2] === 'assets')
  );
}

function extractImageUrlsFromText(text: string): string[] {
  const urls: string[] = [];

  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const url = match[1] ? normalizeCandidateUrl(match[1]) : undefined;
    if (url && isAllowedGithubImageUrl(url)) {
      urls.push(url);
    }
  }

  for (const match of text.matchAll(HTML_IMAGE_PATTERN)) {
    const rawUrl = match[1] ?? match[2] ?? match[3];
    const url = rawUrl ? normalizeCandidateUrl(rawUrl) : undefined;
    if (url && isAllowedGithubImageUrl(url)) {
      urls.push(url);
    }
  }

  return urls;
}

export function extractPrImageReferences(prReview: PrReviewData): PrImageReference[] {
  const seen = new Set<string>();
  const refs: PrImageReference[] = [];
  const texts = [
    prReview.body,
    ...prReview.comments.map((comment) => comment.body),
    ...prReview.reviews.map((review) => review.body),
  ];

  for (const text of texts) {
    for (const url of extractImageUrlsFromText(text)) {
      if (seen.has(url)) {
        continue;
      }
      seen.add(url);
      refs.push({ url });
    }
  }

  return refs;
}

function resolveGhAuthHeaders(urlText: string, cwd: string): Record<string, string> {
  const url = new URL(urlText);
  if (url.hostname !== 'github.com') {
    return {};
  }
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function defaultFetchImage(
  url: string,
  options: { headers: Record<string, string>; maxBytes: number },
): Promise<DownloadedPrImage> {
  const response = await fetch(url, {
    headers: options.headers,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > options.maxBytes) {
    throw new Error(`image is larger than ${options.maxBytes} bytes`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength > options.maxBytes) {
    throw new Error(`image is larger than ${options.maxBytes} bytes`);
  }

  return {
    data,
    contentType: response.headers.get('content-type') ?? undefined,
  };
}

function normalizeContentType(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0]?.trim().toLowerCase();
}

function detectImageKind(data: Buffer): ImageKind | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    data.length >= 6
    && (data.subarray(0, 6).equals(Buffer.from('GIF87a')) || data.subarray(0, 6).equals(Buffer.from('GIF89a')))
  ) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (
    data.length >= 12
    && data.subarray(0, 4).equals(Buffer.from('RIFF'))
    && data.subarray(8, 12).equals(Buffer.from('WEBP'))
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return undefined;
}

function validateDownloadedImage(url: string, image: DownloadedPrImage): ImageKind {
  const kind = detectImageKind(image.data);
  const contentType = normalizeContentType(image.contentType);
  const supportedContentTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

  if (!kind) {
    throw new Error(`Invalid PR image attachment content: ${url}`);
  }
  if (contentType?.startsWith('image/') && !supportedContentTypes.has(contentType)) {
    throw new Error(`Unsupported PR image attachment content type for ${url}: ${contentType}`);
  }
  if (contentType && supportedContentTypes.has(contentType) && contentType !== kind.mimeType) {
    throw new Error(`PR image attachment content type does not match bytes for ${url}: ${contentType}`);
  }
  return kind;
}

function replaceMarkdownImageReferences(content: string, sourceUrl: string, placeholder: string): string {
  return content.replace(MARKDOWN_IMAGE_PATTERN, (match, rawUrl: string) => {
    const normalized = normalizeCandidateUrl(rawUrl);
    return normalized === sourceUrl ? placeholder : match;
  });
}

function replaceHtmlImageReferences(content: string, sourceUrl: string, placeholder: string): string {
  return content.replace(HTML_IMAGE_PATTERN, (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
    const normalized = normalizeCandidateUrl(doubleQuoted ?? singleQuoted ?? bare ?? '');
    return normalized === sourceUrl ? placeholder : match;
  });
}

function rewriteTaskContentWithAttachments(taskContent: string, attachments: readonly DownloadedAttachment[]): string {
  return attachments.reduce((content, attachment) => {
    const markdownRewritten = replaceMarkdownImageReferences(content, attachment.sourceUrl, attachment.placeholder);
    return replaceHtmlImageReferences(markdownRewritten, attachment.sourceUrl, attachment.placeholder);
  }, taskContent);
}

export async function collectPrImageAttachments(
  prReview: PrReviewData,
  cwd: string,
  options: CollectPrImageAttachmentsOptions = {},
): Promise<CollectedPrImageAttachments> {
  const refs = extractPrImageReferences(prReview);
  if (refs.length === 0) {
    return {
      attachments: [],
      rewriteTaskContent: (taskContent) => taskContent,
    };
  }

  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const sessionId = options.sessionId ?? `pr-${prReview.number}-${randomUUID()}`;
  const sessionDir = path.join(tmpRoot, 'takt', sessionId);
  const attachmentDir = path.join(sessionDir, 'attachments');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const fetchImage = options.fetchImage ?? defaultFetchImage;
  const attachments: DownloadedAttachment[] = [];

  try {
    ensurePrivateDirectory(sessionDir);
    ensurePrivateDirectory(attachmentDir);

    for (const ref of refs) {
      // Private GitHub asset URLs may need the gh token, but CDN hosts should not receive credentials.
      const headers = resolveGhAuthHeaders(ref.url, cwd);
      const downloaded = await fetchImage(ref.url, { headers, maxBytes, cwd });
      const imageKind = validateDownloadedImage(ref.url, downloaded);
      const index = attachments.length + 1;
      const fileName = `image-${index}.${imageKind.extension}`;
      const tempPath = path.join(attachmentDir, fileName);
      fs.writeFileSync(tempPath, downloaded.data, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
      attachments.push({
        placeholder: `[Image #${index}]`,
        tempPath,
        fileName,
        sourceUrl: ref.url,
      });
    }
  } catch (error) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    throw error;
  }

  const taskAttachments = attachments.map((attachment) => ({
    placeholder: attachment.placeholder,
    tempPath: attachment.tempPath,
    fileName: attachment.fileName,
  }));
  return {
    attachments: taskAttachments,
    rewriteTaskContent: (taskContent) => rewriteTaskContentWithAttachments(taskContent, attachments),
  };
}
