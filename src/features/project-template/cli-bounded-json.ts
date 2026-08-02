import { types } from 'node:util';
import { ProjectTemplateCliContractError } from './cli-contract-error.js';

export const PROJECT_TEMPLATE_CLI_JSON_LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 20_001,
  maxContainerEntries: 10_000,
});

const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_VALUES = Object.values;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_IS = Object.is;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_RECEIVER = Array;
const CAPTURED_ARRAY_PROTOTYPE = Array.prototype;
const CAPTURED_ARRAY_POP = Array.prototype.pop;
const CAPTURED_ARRAY_PUSH = Array.prototype.push;
const CAPTURED_ARRAY_SORT = Array.prototype.sort;
const CAPTURED_ARRAY_JOIN = Array.prototype.join;
const CAPTURED_JSON_PARSE = JSON.parse;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_BUFFER_BYTE_LENGTH = Buffer.byteLength;
const CAPTURED_BUFFER_RECEIVER = Buffer;
const CAPTURED_NUMBER_IS_FINITE = Number.isFinite;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_NUMBER_RECEIVER = Number;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_STRING_LOCALE_COMPARE = String.prototype.localeCompare;
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;

function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: unknown[]): T {
  return CAPTURED_REFLECT_APPLY(fn, receiver, args) as T;
}

function invalidGraph(): never {
  throw new ProjectTemplateCliContractError(
    'PROTOCOL_ERROR',
    'machine output must be a bounded plain JSON graph',
  );
}

function utf8Bytes(value: string): number {
  return apply(CAPTURED_BUFFER_BYTE_LENGTH, CAPTURED_BUFFER_RECEIVER, [value, 'utf8']);
}

function validatePrimitive(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') {
    if (
      !apply(CAPTURED_NUMBER_IS_FINITE, CAPTURED_NUMBER_RECEIVER, [value])
      || apply(CAPTURED_OBJECT_IS, CAPTURED_OBJECT_RECEIVER, [value, -0])
    ) invalidGraph();
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
    const current = apply(CAPTURED_ARRAY_POP, pending, [])!;
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
      || apply(CAPTURED_TYPES_IS_PROXY, types, [value])
      || apply(CAPTURED_WEAK_SET_HAS, seen, [value])
    ) {
      invalidGraph();
    }
    apply(CAPTURED_WEAK_SET_ADD, seen, [value]);

    const prototype = apply(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    );
    if (apply(CAPTURED_ARRAY_IS_ARRAY, CAPTURED_ARRAY_RECEIVER, [value])) {
      if (prototype !== CAPTURED_ARRAY_PROTOTYPE) invalidGraph();
      const lengthDescriptor = apply(
        CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
        CAPTURED_OBJECT_RECEIVER,
        [value, 'length'],
      );
      if (
        lengthDescriptor === undefined
        || !('value' in lengthDescriptor)
        || !apply(
          CAPTURED_NUMBER_IS_SAFE_INTEGER,
          CAPTURED_NUMBER_RECEIVER,
          [lengthDescriptor.value],
        )
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxContainerEntries
        || lengthDescriptor.value > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxNodes - nodes
      ) invalidGraph();
      const keys = apply(CAPTURED_REFLECT_OWN_KEYS, CAPTURED_REFLECT_RECEIVER, [value]);
      if (keys.length !== lengthDescriptor.value + 1) invalidGraph();
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = apply(
          CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
          CAPTURED_OBJECT_RECEIVER,
          [value, `${index}`],
        );
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)
        ) invalidGraph();
        apply(CAPTURED_ARRAY_PUSH, pending, [{
          value: descriptor.value,
          depth: current.depth + 1,
        }]);
      }
      continue;
    }

    if (prototype !== CAPTURED_OBJECT_PROTOTYPE && prototype !== null) invalidGraph();
    const keys = apply(CAPTURED_REFLECT_OWN_KEYS, CAPTURED_REFLECT_RECEIVER, [value]);
    if (
      keys.length > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxContainerEntries
      || keys.length > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxNodes - nodes
    ) invalidGraph();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (typeof key !== 'string') invalidGraph();
      stringBytes += utf8Bytes(key);
      if (stringBytes > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxBytes) invalidGraph();
      const descriptor = apply(
        CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
        CAPTURED_OBJECT_RECEIVER,
        [value, key],
      );
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) invalidGraph();
      apply(CAPTURED_ARRAY_PUSH, pending, [{
        value: descriptor.value,
        depth: current.depth + 1,
      }]);
    }
  }
}

function compareKeys(left: string, right: string): number {
  return apply(CAPTURED_STRING_LOCALE_COMPARE, left, [right, 'en-US']);
}

export function serializeProjectTemplateCliJson(value: unknown): string {
  validateBoundedGraph(value);
  const chunks: string[] = [];
  let outputBytes = 0;
  const append = (chunk: string): void => {
    outputBytes += utf8Bytes(chunk);
    if (outputBytes > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxBytes) invalidGraph();
    apply(CAPTURED_ARRAY_PUSH, chunks, [chunk]);
  };

  const serialize = (current: unknown): void => {
    if (validatePrimitive(current)) {
      append(apply(CAPTURED_JSON_STRINGIFY, CAPTURED_JSON_RECEIVER, [current]));
      return;
    }
    if (apply(CAPTURED_ARRAY_IS_ARRAY, CAPTURED_ARRAY_RECEIVER, [current])) {
      const array = current as readonly unknown[];
      append('[');
      for (let index = 0; index < array.length; index += 1) {
        if (index > 0) append(',');
        const descriptor = apply(
          CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
          CAPTURED_OBJECT_RECEIVER,
          [array, `${index}`],
        )!;
        serialize(descriptor.value);
      }
      append(']');
      return;
    }
    const record = current as object;
    const keys = apply(
      CAPTURED_REFLECT_OWN_KEYS,
      CAPTURED_REFLECT_RECEIVER,
      [record],
    ) as string[];
    apply(CAPTURED_ARRAY_SORT, keys, [compareKeys]);
    append('{');
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) append(',');
      const key = keys[index]!;
      append(apply(CAPTURED_JSON_STRINGIFY, CAPTURED_JSON_RECEIVER, [key]));
      append(':');
      serialize(apply(
        CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
        CAPTURED_OBJECT_RECEIVER,
        [record, key],
      )!.value);
    }
    append('}');
  };

  serialize(value);
  return `${apply(CAPTURED_ARRAY_JOIN, chunks, [''])}\n`;
}

export function snapshotProjectTemplateCliJson(value: unknown): unknown {
  const snapshot = apply(
    CAPTURED_JSON_PARSE,
    CAPTURED_JSON_RECEIVER,
    [serializeProjectTemplateCliJson(value)],
  ) as unknown;
  const pending: object[] = [];
  if (snapshot !== null && typeof snapshot === 'object') {
    apply(CAPTURED_ARRAY_PUSH, pending, [snapshot]);
  }
  while (pending.length > 0) {
    const current = apply(CAPTURED_ARRAY_POP, pending, [])!;
    const children = apply(CAPTURED_OBJECT_VALUES, CAPTURED_OBJECT_RECEIVER, [current]);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child !== null && typeof child === 'object') {
        apply(CAPTURED_ARRAY_PUSH, pending, [child]);
      }
    }
    apply(CAPTURED_OBJECT_FREEZE, CAPTURED_OBJECT_RECEIVER, [current]);
  }
  return snapshot;
}

export function parseProjectTemplateCliJson(text: unknown): unknown {
  if (
    typeof text !== 'string'
    || utf8Bytes(text) > PROJECT_TEMPLATE_CLI_JSON_LIMITS.maxBytes
  ) invalidGraph();
  let parsed: unknown;
  try {
    parsed = apply(CAPTURED_JSON_PARSE, CAPTURED_JSON_RECEIVER, [text]);
  } catch {
    invalidGraph();
  }
  return snapshotProjectTemplateCliJson(parsed);
}
