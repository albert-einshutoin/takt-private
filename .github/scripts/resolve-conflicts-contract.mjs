#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

const SCHEMA_VERSION = 1;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_REPLACEMENT_BYTES = 512 * 1024;
const CONTEXT_LINES = 3;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MARKER_LINE_PATTERN = /^(?:<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)(?: .*|)\r?$/gm;
const BLOCK_PATTERN = /^<<<<<<< ([^\r\n]+)\r?\n([\s\S]*?)^\|\|\|\|\|\|\| ([^\r\n]+)\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> ([^\r\n]+)(?:\r?\n|$)/gm;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function ownKeysExactly(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains missing or unexpected keys`);
  }
}

function decodeUtf8(buffer, label, allowNul = false) {
  if (!allowNul && buffer.includes(0)) fail(`${label} contains NUL bytes`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function assertValidString(value, label, maxBytes) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (value.includes('\0')) fail(`${label} contains NUL`);
  // JSON can represent lone UTF-16 surrogates, but encoding them would silently
  // replace bytes. Rejecting them keeps the proposal-to-file transform exact.
  if (/[\uD800-\uDFFF]/u.test(value)) fail(`${label} contains an invalid Unicode surrogate`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail(`${label} exceeds its byte limit`);
}

function git(repoRoot, args, encoding = 'buffer') {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding,
    maxBuffer: MAX_TOTAL_BYTES * 4,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function normalizeRepoRoot(repoRootArg) {
  const root = realpathSync(resolve(repoRootArg));
  if (!lstatSync(root).isDirectory()) fail('repository root is not a directory');
  const topLevel = git(root, ['rev-parse', '--show-toplevel'], 'utf8').trim();
  if (realpathSync(topLevel) !== root) fail('repository root must be the Git top level');
  return root;
}

function validateRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.includes('\\')) {
    fail('conflict path is invalid');
  }
  if (isAbsolute(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail(`conflict path escapes the repository: ${path}`);
  }
}

function resolveRegularPath(repoRoot, path) {
  validateRelativePath(path);
  const absolute = resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) fail('conflict path escapes repository');
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${path} is not a regular file`);
  // A regular leaf can still escape through a symlinked parent. realpath closes
  // that gap before any model-controlled path is read or replaced.
  const canonical = realpathSync(absolute);
  const canonicalRel = relative(repoRoot, canonical);
  if (canonicalRel.startsWith(`..${sep}`) || canonicalRel === '..' || isAbsolute(canonicalRel)) {
    fail(`${path} resolves outside the repository`);
  }
  return { absolute, mode: stat.mode & 0o777 };
}

function unresolvedEntries(repoRoot) {
  const namesRaw = git(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const namesText = decodeUtf8(namesRaw, 'unresolved path list', true);
  const paths = namesText.length === 0 ? [] : namesText.slice(0, -1).split('\0');
  if (namesText.length > 0 && !namesText.endsWith('\0')) fail('Git returned a malformed path list');
  if (paths.length === 0) fail('no unresolved conflict files found');
  if (paths.length > MAX_FILES) fail(`more than ${MAX_FILES} unresolved files`);
  if (new Set(paths).size !== paths.length) fail('Git returned duplicate unresolved paths');

  const stageRaw = git(repoRoot, ['ls-files', '-u', '-z']);
  const stageText = decodeUtf8(stageRaw, 'unmerged index', true);
  if (stageText.length > 0 && !stageText.endsWith('\0')) fail('Git returned a malformed unmerged index');
  const byPath = new Map();
  for (const record of stageText.length === 0 ? [] : stageText.slice(0, -1).split('\0')) {
    const match = /^(\d{6}) [a-f0-9]{40,64} ([123])\t([\s\S]+)$/.exec(record);
    if (!match) fail('Git returned a malformed unmerged index record');
    const [, mode, stage, path] = match;
    if (mode === '160000') fail(`${path} is a submodule conflict`);
    if (!mode.startsWith('100')) fail(`${path} is not a regular-file conflict`);
    const stages = byPath.get(path) ?? new Set();
    if (stages.has(stage)) fail(`${path} has a duplicate index stage`);
    stages.add(stage);
    byPath.set(path, stages);
  }
  for (const path of paths) {
    validateRelativePath(path);
    const stages = byPath.get(path);
    if (!stages || stages.size !== 3 || !['1', '2', '3'].every((stage) => stages.has(stage))) {
      fail(`${path} must have exactly base, HEAD, and theirs index stages`);
    }
  }
  if (byPath.size !== paths.length) fail('unmerged index and unresolved path list disagree');
  return paths.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

function surroundingLines(text, start, end) {
  const before = text.slice(0, start).replace(/\r?\n$/, '').split(/\r?\n/).filter(Boolean).slice(-CONTEXT_LINES);
  const after = text.slice(end).split(/\r?\n/).filter(Boolean).slice(0, CONTEXT_LINES);
  return { before, after };
}

function parseBlocks(text, path, preimageSha) {
  const blocks = [];
  const coveredMarkers = [];
  let match;
  BLOCK_PATTERN.lastIndex = 0;
  while ((match = BLOCK_PATTERN.exec(text)) !== null) {
    const [raw, headLabel, ours, baseLabel, base, theirs, theirsLabel] = match;
    if (!headLabel || !baseLabel || !theirsLabel) fail(`${path} has an empty conflict label`);
    for (const section of [ours, base, theirs]) {
      if (MARKER_LINE_PATTERN.test(section)) fail(`${path} has nested or ambiguous conflict markers`);
      MARKER_LINE_PATTERN.lastIndex = 0;
    }
    const start = match.index;
    const end = start + raw.length;
    const context = surroundingLines(text, start, end);
    const ordinal = blocks.length;
    blocks.push({
      conflict_id: sha256(`${path}\0${preimageSha}\0${ordinal}\0${raw}`),
      path,
      preimage_sha256: preimageSha,
      marker_start: start,
      marker_end: end,
      context_before: context.before,
      ours,
      base,
      theirs,
      context_after: context.after,
    });
    let marker;
    MARKER_LINE_PATTERN.lastIndex = start;
    while ((marker = MARKER_LINE_PATTERN.exec(text)) !== null && marker.index < end) {
      coveredMarkers.push(marker.index);
    }
  }
  const allMarkers = [...text.matchAll(MARKER_LINE_PATTERN)].map((item) => item.index);
  if (blocks.length === 0 || allMarkers.length !== blocks.length * 4 ||
      coveredMarkers.length !== allMarkers.length || coveredMarkers.some((value, index) => value !== allMarkers[index])) {
    fail(`${path} contains malformed or ambiguous diff3 conflict markers`);
  }
  return blocks;
}

function canonicalPayload(conflicts) {
  return { schema_version: SCHEMA_VERSION, conflicts };
}

function buildContract(repoRoot) {
  const conflicts = [];
  let totalBytes = 0;
  for (const path of unresolvedEntries(repoRoot)) {
    const { absolute } = resolveRegularPath(repoRoot, path);
    const bytes = readFileSync(absolute);
    if (bytes.length > MAX_FILE_BYTES) fail(`${path} exceeds the per-file byte limit`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail('conflict files exceed the total byte limit');
    const text = decodeUtf8(bytes, path);
    conflicts.push(...parseBlocks(text, path, sha256(bytes)));
  }
  const payload = canonicalPayload(conflicts);
  return { ...payload, input_digest: sha256(JSON.stringify(payload)) };
}

function atomicWrite(path, bytes, mode) {
  const temp = `${path}.takt-resolve-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readJson(path, label) {
  const bytes = readFileSync(path);
  if (bytes.length > MAX_TOTAL_BYTES * 4) fail(`${label} exceeds its byte limit`);
  const text = decodeUtf8(bytes, label);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function validateInput(input) {
  ownKeysExactly(input, ['schema_version', 'conflicts', 'input_digest'], 'input contract');
  if (input.schema_version !== SCHEMA_VERSION || !HASH_PATTERN.test(input.input_digest)) fail('input contract version or digest is invalid');
  if (!Array.isArray(input.conflicts) || input.conflicts.length === 0) fail('input contract has no conflicts');
  for (const [index, conflict] of input.conflicts.entries()) {
    ownKeysExactly(conflict, [
      'conflict_id', 'path', 'preimage_sha256', 'marker_start', 'marker_end',
      'context_before', 'ours', 'base', 'theirs', 'context_after',
    ], `input conflict ${index}`);
    validateRelativePath(conflict.path);
    if (!HASH_PATTERN.test(conflict.conflict_id) || !HASH_PATTERN.test(conflict.preimage_sha256)) fail('input conflict hash is invalid');
    if (!Number.isSafeInteger(conflict.marker_start) || !Number.isSafeInteger(conflict.marker_end) || conflict.marker_start < 0 || conflict.marker_end <= conflict.marker_start) fail('input marker range is invalid');
    if (!Array.isArray(conflict.context_before) || !Array.isArray(conflict.context_after)) fail('input context is invalid');
    for (const value of [...conflict.context_before, ...conflict.context_after, conflict.ours, conflict.base, conflict.theirs]) {
      assertValidString(value, 'input conflict text', MAX_FILE_BYTES);
    }
  }
  const payload = canonicalPayload(input.conflicts);
  if (sha256(JSON.stringify(payload)) !== input.input_digest) fail('input digest mismatch');
}

function validateProposal(proposal, input) {
  ownKeysExactly(proposal, ['schema_version', 'input_digest', 'resolutions'], 'proposal');
  if (proposal.schema_version !== SCHEMA_VERSION || proposal.input_digest !== input.input_digest) fail('proposal input digest mismatch');
  if (!Array.isArray(proposal.resolutions)) fail('proposal resolutions must be an array');
  const expected = new Set(input.conflicts.map((item) => item.conflict_id));
  if (expected.size !== input.conflicts.length) fail('input contains duplicate conflict IDs');
  const seen = new Set();
  for (const [index, resolution] of proposal.resolutions.entries()) {
    ownKeysExactly(resolution, ['conflict_id', 'replacement'], `resolution ${index}`);
    if (typeof resolution.conflict_id !== 'string' || !expected.has(resolution.conflict_id) || seen.has(resolution.conflict_id)) {
      fail('proposal contains an unknown or duplicate conflict ID');
    }
    assertValidString(resolution.replacement, 'replacement', MAX_REPLACEMENT_BYTES);
    if (MARKER_LINE_PATTERN.test(resolution.replacement)) fail('replacement contains conflict markers');
    MARKER_LINE_PATTERN.lastIndex = 0;
    seen.add(resolution.conflict_id);
  }
  if (seen.size !== expected.size) fail('proposal must resolve every conflict exactly once');
}

function prepare(repoRootArg, outputPath) {
  const repoRoot = normalizeRepoRoot(repoRootArg);
  const contract = buildContract(repoRoot);
  atomicWrite(resolve(outputPath), Buffer.from(`${JSON.stringify(contract, null, 2)}\n`), 0o600);
}

function apply(repoRootArg, inputPath, proposalPath) {
  const repoRoot = normalizeRepoRoot(repoRootArg);
  const input = readJson(resolve(inputPath), 'input contract');
  const proposal = readJson(resolve(proposalPath), 'proposal');
  validateInput(input);
  validateProposal(proposal, input);

  // Rebuilding from Git and disk immediately before applying makes stale or
  // model-tampered preimages fail closed. All files are validated before writes.
  const current = buildContract(repoRoot);
  if (JSON.stringify(current) !== JSON.stringify(input)) fail('conflict preimage changed after prepare');
  const replacements = new Map(proposal.resolutions.map((item) => [item.conflict_id, item.replacement]));
  const plans = [];
  const grouped = new Map();
  for (const conflict of input.conflicts) {
    const entries = grouped.get(conflict.path) ?? [];
    entries.push(conflict);
    grouped.set(conflict.path, entries);
  }
  for (const [path, conflicts] of grouped) {
    const { absolute, mode } = resolveRegularPath(repoRoot, path);
    const original = decodeUtf8(readFileSync(absolute), path);
    let result = original;
    for (const conflict of [...conflicts].sort((a, b) => b.marker_start - a.marker_start)) {
      result = result.slice(0, conflict.marker_start) + replacements.get(conflict.conflict_id) + result.slice(conflict.marker_end);
    }
    if (MARKER_LINE_PATTERN.test(result)) fail(`${path} still contains conflict markers`);
    MARKER_LINE_PATTERN.lastIndex = 0;
    plans.push({ absolute, mode, bytes: Buffer.from(result, 'utf8') });
  }
  for (const plan of plans) atomicWrite(plan.absolute, plan.bytes, plan.mode);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 2) return prepare(args[0], args[1]);
  if (command === 'apply' && args.length === 3) return apply(args[0], args[1], args[2]);
  fail('usage: resolve-conflicts-contract.mjs prepare <repoRoot> <outputJson> | apply <repoRoot> <inputJson> <proposalJson>');
}

try {
  main();
} catch (error) {
  process.stderr.write(`resolve-conflicts-contract: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
