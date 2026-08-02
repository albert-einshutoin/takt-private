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
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

const SCHEMA_VERSION = 1;
const MAX_FILES = 20;
const MAX_CONFLICTS = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_CONTRACT_JSON_BYTES = 2 * 1024 * 1024;
const MAX_REPLACEMENT_BYTES = 512 * 1024;
const CONTEXT_LINES = 3;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MARKER_LINE_PATTERN = /^(?:<{7,}|\|{7,}|={7,}|>{7,})(?: .*|)\r?$/gm;
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
  const canonicalParent = realpathSync(dirname(absolute));
  const parentStat = lstatSync(canonicalParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail(`${path} parent is not a canonical directory`);
  const canonical = realpathSync(absolute);
  if (dirname(canonical) !== canonicalParent || basename(canonical) !== basename(absolute)) {
    fail(`${path} target identity is ambiguous`);
  }
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isFile() || canonicalStat.isSymbolicLink()) fail(`${path} canonical target is not a regular file`);
  const canonicalRel = relative(repoRoot, canonical);
  if (canonicalRel.startsWith(`..${sep}`) || canonicalRel === '..' || isAbsolute(canonicalRel)) {
    fail(`${path} resolves outside the repository`);
  }
  return {
    absolute: canonical,
    canonicalParent,
    targetName: basename(canonical),
    parentDev: parentStat.dev,
    parentIno: parentStat.ino,
    targetDev: canonicalStat.dev,
    targetIno: canonicalStat.ino,
    mode: canonicalStat.mode & 0o777,
  };
}

function classifyStages(path, stages) {
  const signature = stages.map((entry) => entry.stage).join(',');
  if (signature === '1,2,3') return 'content';
  if (signature === '2,3') return 'add-add';
  if (signature === '1,2' || signature === '1,3') return 'modify-delete';
  fail(`${path} has unsupported or ambiguous unmerged stages (${signature || 'none'}); rename conflicts require manual resolution`);
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
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([123])\t([\s\S]+)$/.exec(record);
    if (!match) fail('Git returned a malformed unmerged index record');
    const [, mode, oid, stageTextValue, path] = match;
    if (mode === '160000') fail(`${path} is a submodule conflict`);
    if (mode !== '100644' && mode !== '100755') fail(`${path} is not a supported regular-file conflict`);
    const stages = byPath.get(path) ?? [];
    const stage = Number(stageTextValue);
    if (stages.some((entry) => entry.stage === stage)) fail(`${path} has a duplicate index stage`);
    stages.push({ stage, mode, oid });
    byPath.set(path, stages);
  }
  const entries = [];
  for (const path of paths) {
    validateRelativePath(path);
    const stages = byPath.get(path);
    if (!stages) fail(`${path} has no unmerged index stages`);
    stages.sort((left, right) => left.stage - right.stage);
    entries.push({ path, kind: classifyStages(path, stages), stages });
  }
  if (byPath.size !== paths.length) fail('unmerged index and unresolved path list disagree');
  return entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}

function surroundingLines(text, start, end) {
  const before = text.slice(0, start).replace(/\r?\n$/, '').split(/\r?\n/).filter(Boolean).slice(-CONTEXT_LINES);
  const after = text.slice(end).split(/\r?\n/).filter(Boolean).slice(0, CONTEXT_LINES);
  return { before, after };
}

function parseBlocks(text, path, preimageSha, kind, stages, worktreeMode) {
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
    const identity = JSON.stringify({ path, kind, stages, worktree_mode: worktreeMode, preimage_sha256: preimageSha, ordinal, raw });
    blocks.push({
      conflict_id: sha256(identity),
      kind,
      path,
      stages,
      worktree_mode: worktreeMode,
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
  // The coverage loop may look one marker past the current block. Reset the
  // stateful global regexp so malformed trailing markers cannot be skipped.
  MARKER_LINE_PATTERN.lastIndex = 0;
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

function readStageText(repoRoot, entry, stage) {
  const metadata = entry.stages.find((candidate) => candidate.stage === stage);
  if (!metadata) return '';
  const bytes = git(repoRoot, ['cat-file', 'blob', metadata.oid]);
  if (bytes.length > MAX_FILE_BYTES) fail(`${entry.path} stage ${stage} exceeds the byte limit`);
  return decodeUtf8(bytes, `${entry.path} stage ${stage}`);
}

function buildModifyDeleteConflict(repoRoot, entry, text, bytes, worktreeMode) {
  const preimageSha = sha256(bytes);
  const ours = readStageText(repoRoot, entry, 2);
  const base = readStageText(repoRoot, entry, 1);
  const theirs = readStageText(repoRoot, entry, 3);
  const presentSide = entry.stages.some((stage) => stage.stage === 2) ? ours : theirs;
  if (text !== presentSide) fail(`${entry.path} worktree does not match the surviving modify/delete stage`);
  const identity = JSON.stringify({
    path: entry.path,
    kind: entry.kind,
    stages: entry.stages,
    worktree_mode: worktreeMode,
    preimage_sha256: preimageSha,
  });
  return {
    conflict_id: sha256(identity),
    kind: entry.kind,
    path: entry.path,
    stages: entry.stages,
    worktree_mode: worktreeMode,
    preimage_sha256: preimageSha,
    marker_start: 0,
    marker_end: text.length,
    context_before: [],
    ours,
    base,
    theirs,
    context_after: [],
  };
}

function buildContract(repoRoot) {
  const conflicts = [];
  let totalBytes = 0;
  for (const entry of unresolvedEntries(repoRoot)) {
    const { path } = entry;
    const { absolute, mode: worktreeMode } = resolveRegularPath(repoRoot, path);
    const bytes = readFileSync(absolute);
    if (bytes.length > MAX_FILE_BYTES) fail(`${path} exceeds the per-file byte limit`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail('conflict files exceed the total byte limit');
    const text = decodeUtf8(bytes, path);
    const fileConflicts = entry.kind === 'modify-delete'
      ? [buildModifyDeleteConflict(repoRoot, entry, text, bytes, worktreeMode)]
      : parseBlocks(text, path, sha256(bytes), entry.kind, entry.stages, worktreeMode);
    // Keep this aligned with the workflow response schema. Otherwise a valid
    // prepare result could be impossible for the tool-less model to return.
    if (conflicts.length + fileConflicts.length > MAX_CONFLICTS) {
      fail(`more than ${MAX_CONFLICTS} conflict blocks`);
    }
    conflicts.push(...fileConflicts);
  }
  const payload = canonicalPayload(conflicts);
  return { ...payload, input_digest: sha256(JSON.stringify(payload)) };
}

function atomicWriteUnbound(path, bytes, mode) {
  const temp = `${path}.takt-resolve-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function assertParentBinding(binding) {
  const canonicalNow = realpathSync(binding.canonicalParent);
  const stat = lstatSync(binding.canonicalParent);
  if (canonicalNow !== binding.canonicalParent || !stat.isDirectory() || stat.isSymbolicLink() ||
      stat.dev !== binding.parentDev || stat.ino !== binding.parentIno) {
    fail('canonical parent directory identity changed');
  }
}

function targetPathFor(binding) {
  const target = resolve(binding.canonicalParent, binding.targetName);
  if (dirname(target) !== binding.canonicalParent || basename(target) !== binding.targetName) {
    fail('bound target no longer resolves inside its canonical parent');
  }
  return target;
}

function assertBoundTarget(binding, expectedBytes) {
  assertParentBinding(binding);
  const target = targetPathFor(binding);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(target) !== target ||
      stat.dev !== binding.targetDev || stat.ino !== binding.targetIno ||
      (stat.mode & 0o777) !== binding.mode || sha256(readFileSync(target)) !== sha256(expectedBytes)) {
    fail('bound target identity, mode, or content changed');
  }
  return target;
}

function assertBoundTargetMissing(binding) {
  assertParentBinding(binding);
  const target = targetPathFor(binding);
  try {
    lstatSync(target);
    fail('bound target unexpectedly exists');
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  return target;
}

function refreshBinding(binding, expectedBytes, mode) {
  assertParentBinding(binding);
  const target = targetPathFor(binding);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(target) !== target ||
      (stat.mode & 0o777) !== mode || sha256(readFileSync(target)) !== sha256(expectedBytes)) {
    fail('mutated target did not retain its canonical identity, mode, and bytes');
  }
  return { ...binding, absolute: target, targetDev: stat.dev, targetIno: stat.ino, mode };
}

function atomicWriteBound(binding, expectedBytes, bytes, mode) {
  const target = assertBoundTarget(binding, expectedBytes);
  const temp = resolve(binding.canonicalParent, `.${binding.targetName}.takt-resolve-${process.pid}-${randomBytes(8).toString('hex')}`);
  if (dirname(temp) !== binding.canonicalParent) fail('temporary path escaped its canonical parent');
  try {
    // Node does not expose openat/renameat with a retained directory fd. These
    // repeated dev/ino checks minimize the remaining syscall-sized race while
    // ensuring neither lexical repository paths nor exchanged symlinks are used.
    assertParentBinding(binding);
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    chmodSync(temp, mode);
    assertParentBinding(binding);
    assertBoundTarget(binding, expectedBytes);
    renameSync(temp, target);
    return refreshBinding(binding, bytes, mode);
  } finally {
    rmSync(temp, { force: true });
  }
}

function atomicCreateBound(binding, bytes, mode) {
  const target = assertBoundTargetMissing(binding);
  const temp = resolve(binding.canonicalParent, `.${binding.targetName}.takt-resolve-${process.pid}-${randomBytes(8).toString('hex')}`);
  if (dirname(temp) !== binding.canonicalParent) fail('temporary path escaped its canonical parent');
  try {
    assertParentBinding(binding);
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    chmodSync(temp, mode);
    assertParentBinding(binding);
    assertBoundTargetMissing(binding);
    renameSync(temp, target);
    return refreshBinding(binding, bytes, mode);
  } finally {
    rmSync(temp, { force: true });
  }
}

function deleteBound(binding, expectedBytes) {
  const target = assertBoundTarget(binding, expectedBytes);
  assertParentBinding(binding);
  assertBoundTarget(binding, expectedBytes);
  rmSync(target);
  assertBoundTargetMissing(binding);
}

function waitForTestMutationGate(index) {
  if (process.env.NODE_ENV !== 'test' || Number(process.env.TAKT_RESOLVE_TEST_GATE_AT) !== index + 1) return;
  const signal = process.env.TAKT_RESOLVE_TEST_GATE_SIGNAL;
  const release = process.env.TAKT_RESOLVE_TEST_GATE_RELEASE;
  if (!signal || !release) fail('test mutation gate paths are missing');
  writeFileSync(signal, 'ready\n', { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      lstatSync(release);
      return;
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  fail('test mutation gate timed out');
}

function readJson(path, label) {
  const bytes = readFileSync(path);
  if (bytes.length > MAX_CONTRACT_JSON_BYTES) fail(`${label} exceeds its serialized byte limit`);
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
  if (!Array.isArray(input.conflicts) || input.conflicts.length === 0 || input.conflicts.length > MAX_CONFLICTS) fail('input contract conflict count is invalid');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_CONTRACT_JSON_BYTES) fail('input contract exceeds its serialized byte limit');
  for (const [index, conflict] of input.conflicts.entries()) {
    ownKeysExactly(conflict, [
      'conflict_id', 'kind', 'path', 'stages', 'worktree_mode', 'preimage_sha256', 'marker_start', 'marker_end',
      'context_before', 'ours', 'base', 'theirs', 'context_after',
    ], `input conflict ${index}`);
    validateRelativePath(conflict.path);
    if (!['content', 'add-add', 'modify-delete'].includes(conflict.kind)) fail('input conflict kind is invalid');
    if (!Array.isArray(conflict.stages)) fail('input conflict stages are invalid');
    for (const [stageIndex, stage] of conflict.stages.entries()) {
      ownKeysExactly(stage, ['stage', 'mode', 'oid'], `input conflict stage ${stageIndex}`);
      if (![1, 2, 3].includes(stage.stage) || !['100644', '100755'].includes(stage.mode) || !/^[a-f0-9]{40,64}$/.test(stage.oid)) {
        fail('input conflict stage metadata is invalid');
      }
    }
    if (classifyStages(conflict.path, conflict.stages) !== conflict.kind) fail('input conflict kind and stages disagree');
    if (!Number.isInteger(conflict.worktree_mode) || conflict.worktree_mode < 0 || conflict.worktree_mode > 0o777) fail('input worktree mode is invalid');
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
  if (Buffer.byteLength(JSON.stringify(proposal), 'utf8') > MAX_CONTRACT_JSON_BYTES) fail('proposal exceeds its serialized byte limit');
  const expected = new Set(input.conflicts.map((item) => item.conflict_id));
  const conflictById = new Map(input.conflicts.map((item) => [item.conflict_id, item]));
  if (expected.size !== input.conflicts.length) fail('input contains duplicate conflict IDs');
  const seen = new Set();
  for (const [index, resolution] of proposal.resolutions.entries()) {
    if (resolution === null || typeof resolution !== 'object' || Array.isArray(resolution)) fail(`resolution ${index} must be an object`);
    const isReplace = resolution.action === 'replace';
    const isDelete = resolution.action === 'delete';
    ownKeysExactly(resolution, isReplace ? ['conflict_id', 'action', 'replacement'] : ['conflict_id', 'action'], `resolution ${index}`);
    if (typeof resolution.conflict_id !== 'string' || !expected.has(resolution.conflict_id) || seen.has(resolution.conflict_id)) {
      fail('proposal contains an unknown or duplicate conflict ID');
    }
    const conflict = conflictById.get(resolution.conflict_id);
    if (!isReplace && !isDelete) fail('resolution action is invalid');
    if (isDelete && conflict.kind !== 'modify-delete') fail('delete is only valid for modify/delete conflicts');
    if (isReplace) {
      assertValidString(resolution.replacement, 'replacement', MAX_REPLACEMENT_BYTES);
      if (MARKER_LINE_PATTERN.test(resolution.replacement)) fail('replacement contains conflict markers');
      MARKER_LINE_PATTERN.lastIndex = 0;
    }
    seen.add(resolution.conflict_id);
  }
  if (seen.size !== expected.size) fail('proposal must resolve every conflict exactly once');
}

function prepare(repoRootArg, outputPath) {
  const repoRoot = normalizeRepoRoot(repoRootArg);
  const contract = buildContract(repoRoot);
  const serialized = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
  // Measure the bytes actually handed to the model after JSON escaping rather
  // than only the smaller source file bytes.
  if (serialized.length > MAX_CONTRACT_JSON_BYTES) fail('input contract exceeds its serialized byte limit');
  atomicWriteUnbound(resolve(outputPath), serialized, 0o600);
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
  const resolutions = new Map(proposal.resolutions.map((item) => [item.conflict_id, item]));
  const plans = [];
  const grouped = new Map();
  for (const conflict of input.conflicts) {
    const entries = grouped.get(conflict.path) ?? [];
    entries.push(conflict);
    grouped.set(conflict.path, entries);
  }
  for (const [path, conflicts] of grouped) {
    const binding = resolveRegularPath(repoRoot, path);
    const { absolute, mode } = binding;
    const originalBytes = readFileSync(absolute);
    const original = decodeUtf8(originalBytes, path);
    const representative = conflicts[0];
    if (mode !== representative.worktree_mode || sha256(originalBytes) !== representative.preimage_sha256) {
      fail(`${path} mode or content changed while planning`);
    }
    if (representative.kind === 'modify-delete') {
      const resolution = resolutions.get(representative.conflict_id);
      plans.push({
        path,
        binding,
        mode,
        stages: representative.stages,
        kind: representative.kind,
        originalBytes,
        delete: resolution.action === 'delete',
        bytes: resolution.action === 'replace' ? Buffer.from(resolution.replacement, 'utf8') : undefined,
      });
      continue;
    }
    let result = original;
    for (const conflict of [...conflicts].sort((a, b) => b.marker_start - a.marker_start)) {
      result = result.slice(0, conflict.marker_start) + resolutions.get(conflict.conflict_id).replacement + result.slice(conflict.marker_end);
    }
    if (MARKER_LINE_PATTERN.test(result)) fail(`${path} still contains conflict markers`);
    MARKER_LINE_PATTERN.lastIndex = 0;
    plans.push({
      path,
      binding,
      mode,
      stages: representative.stages,
      kind: representative.kind,
      originalBytes,
      delete: false,
      bytes: Buffer.from(result, 'utf8'),
    });
  }

  const applied = [];
  try {
    for (const [index, plan] of plans.entries()) {
      waitForTestMutationGate(index);
      const currentEntry = unresolvedEntries(repoRoot).find((entry) => entry.path === plan.path);
      if (!currentEntry || currentEntry.kind !== plan.kind || JSON.stringify(currentEntry.stages) !== JSON.stringify(plan.stages)) {
        fail(`${plan.path} index stages changed immediately before mutation`);
      }
      const currentPath = resolveRegularPath(repoRoot, plan.path);
      const currentBytes = readFileSync(currentPath.absolute);
      if (currentPath.absolute !== plan.binding.absolute || currentPath.canonicalParent !== plan.binding.canonicalParent ||
          currentPath.parentDev !== plan.binding.parentDev || currentPath.parentIno !== plan.binding.parentIno ||
          currentPath.targetDev !== plan.binding.targetDev || currentPath.targetIno !== plan.binding.targetIno ||
          currentPath.mode !== plan.mode || sha256(currentBytes) !== sha256(plan.originalBytes)) {
        fail(`${plan.path} canonical path, mode, or content changed immediately before mutation`);
      }
      // Test-only failpoint proves that a later-file failure restores earlier
      // mutations. In production, the variable is inert and can only fail closed.
      if (process.env.NODE_ENV === 'test' && Number(process.env.TAKT_RESOLVE_TEST_FAIL_WRITE_AT) === index + 1) {
        fail(`injected write failure at mutation ${index + 1}`);
      }
      const postBinding = plan.delete
        ? (deleteBound(plan.binding, plan.originalBytes), undefined)
        : atomicWriteBound(plan.binding, plan.originalBytes, plan.bytes, plan.mode);
      applied.push({ plan, postBinding });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const appliedMutation of [...applied].reverse()) {
      const { plan, postBinding } = appliedMutation;
      try {
        if (plan.delete) atomicCreateBound(plan.binding, plan.originalBytes, plan.mode);
        else atomicWriteBound(postBinding, plan.bytes, plan.originalBytes, plan.mode);
      } catch (rollbackError) {
        rollbackErrors.push(`${plan.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) fail(`apply failed and rollback was incomplete: ${rollbackErrors.join('; ')}`);
    throw error;
  }
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
