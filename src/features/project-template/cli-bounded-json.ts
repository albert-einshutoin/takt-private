import { types } from 'node:util';
import { ProjectTemplateCliContractError } from './cli-contract-error.js';

export const PROJECT_TEMPLATE_CLI_JSON_LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 20_001,
  maxContainerEntries: 10_000,
});

const localeCompare = String.prototype.localeCompare;
const arraySort = Array.prototype.sort;

function invalidGraph(): never {
  throw new ProjectTemplateCliContractError(
    'PROTOCOL_ERROR',
    'machine output must be a bounded plain JSON graph',
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validatePrimitive(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalidGraph();
    return true;
  }
  return typeof value === 'string';
}

function validateBoundedGraph(root: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stringBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (
      nodes > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxNodes
      || current.depth > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxDepth
    ) invalidGraph();

    const value = current.value;
    if (validatePrimitive(value)) {
      if (typeof value === 'string') {
        stringBytes += utf8Bytes(value);
        if (stringBytes > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxBytes) invalidGraph();
      }
      continue;
    }
    if (
      value === null
      || typeof value !== 'object'
      || types.isProxy(value)
      || seen.has(value)
    ) {
      invalidGraph();
    }
    seen.add(value);

    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) invalidGraph();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined
        || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxContainerEntries
        || lengthDescriptor.value > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxNodes - nodes
      ) invalidGraph();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== lengthDescriptor.value + 1) invalidGraph();
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)
        ) invalidGraph();
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) invalidGraph();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxContainerEntries
      || keys.length > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxNodes - nodes
    ) invalidGraph();
    for (const key of keys) {
      if (typeof key !== 'string') invalidGraph();
      stringBytes += utf8Bytes(key);
      if (stringBytes > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxBytes) invalidGraph();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) invalidGraph();
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function compareKeys(left: string, right: string): number {
  return Reflect.apply(localeCompare, left, [right, 'en-US']) as number;
}

export function serializeProjectTemplateCliJson(value: unknown): string {
  validateBoundedGraph(value);
  const chunks: string[] = [];
  let outputBytes = 0;
  const append = (chunk: string): void => {
    outputBytes += utf8Bytes(chunk);
    if (outputBytes > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxBytes) invalidGraph();
    chunks.push(chunk);
  };

  const serialize = (current: unknown): void => {
    if (validatePrimitive(current)) {
      append(JSON.stringify(current) as string);
      return;
    }
    if (Array.isArray(current)) {
      append('[');
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) append(',');
        const descriptor = Object.getOwnPropertyDescriptor(current, `${index}`)!;
        serialize(descriptor.value);
      }
      append(']');
      return;
    }
    const record = current as object;
    const keys = Reflect.ownKeys(record) as string[];
    Reflect.apply(arraySort, keys, [compareKeys]);
    append('{');
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) append(',');
      const key = keys[index]!;
      append(JSON.stringify(key));
      append(':');
      serialize(Object.getOwnPropertyDescriptor(record, key)!.value);
    }
    append('}');
  };

  serialize(value);
  return `${chunks.join('')}\n`;
}

export function snapshotProjectTemplateCliJson(value: unknown): unknown {
  const snapshot = JSON.parse(serializeProjectTemplateCliJson(value)) as unknown;
  const pending: object[] = [];
  if (snapshot !== null && typeof snapshot === 'object') pending.push(snapshot);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
    Object.freeze(current);
  }
  return snapshot;
}
