import { types } from 'node:util';

const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_RECEIVER = Array;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_NUMBER_IS_FINITE = Number.isFinite;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_NUMBER_RECEIVER = Number;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_STRING_LOCALE_COMPARE = String.prototype.localeCompare;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_TYPE_ERROR = TypeError;
const CAPTURED_WEAK_SET = WeakSet;
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_DELETE = WeakSet.prototype.delete;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;

function invalidCanonicalJson(): never {
  throw new CAPTURED_TYPE_ERROR(
    'canonical JSON requires a finite, plain JSON graph',
  );
}

function replaceArrayValue<T>(values: T[], index: number, value: T): void {
  CAPTURED_REFLECT_APPLY(CAPTURED_OBJECT_DEFINE_PROPERTY, CAPTURED_OBJECT_RECEIVER, [
    values,
    `${index}`,
    {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    },
  ]);
}

function compareCanonicalKeys(left: string, right: string): number {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_STRING_LOCALE_COMPARE,
    left,
    [right, 'en-US'],
  ) as number;
}

function sortCanonicalKeys(keys: string[]): void {
  // Insertion sort keeps the historical locale ordering without consulting
  // mutable Array helpers or inherited numeric setters.
  for (let index = 1; index < keys.length; index += 1) {
    const value = keys[index]!;
    let cursor = index;
    while (
      cursor > 0
      && compareCanonicalKeys(keys[cursor - 1]!, value) > 0
    ) {
      replaceArrayValue(keys, cursor, keys[cursor - 1]!);
      cursor -= 1;
    }
    replaceArrayValue(keys, cursor, value);
  }
}

function primitiveJson(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (
    typeof value === 'number'
    && !CAPTURED_REFLECT_APPLY(
      CAPTURED_NUMBER_IS_FINITE,
      CAPTURED_NUMBER_RECEIVER,
      [value],
    )
  ) invalidCanonicalJson();
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    CAPTURED_JSON_RECEIVER,
    [value],
  ) as string;
}

function serializeCanonical(value: unknown, ancestors: WeakSet<object>): string {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) return primitiveJson(value);
  if (typeof value !== 'object') invalidCanonicalJson();
  if (CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])) {
    invalidCanonicalJson();
  }
  if (CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_HAS, ancestors, [value])) {
    invalidCanonicalJson();
  }
  CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_ADD, ancestors, [value]);
  try {
    const descriptors = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) as Record<PropertyKey, PropertyDescriptor>;
    const ownKeys = CAPTURED_REFLECT_APPLY(
      CAPTURED_REFLECT_OWN_KEYS,
      CAPTURED_REFLECT_RECEIVER,
      [descriptors],
    ) as PropertyKey[];
    if (CAPTURED_REFLECT_APPLY(
      CAPTURED_ARRAY_IS_ARRAY,
      CAPTURED_ARRAY_RECEIVER,
      [value],
    )) {
      const lengthDescriptor = descriptors['length'];
      if (
        lengthDescriptor === undefined
        || !('value' in lengthDescriptor)
        || !CAPTURED_REFLECT_APPLY(
          CAPTURED_NUMBER_IS_SAFE_INTEGER,
          CAPTURED_NUMBER_RECEIVER,
          [lengthDescriptor.value],
        )
        || lengthDescriptor.value < 0
      ) invalidCanonicalJson();
      const length = lengthDescriptor.value as number;
      if (ownKeys.length !== length + 1) invalidCanonicalJson();
      let json = '[';
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[`${index}`];
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !('value' in descriptor)
        ) invalidCanonicalJson();
        if (index !== 0) json += ',';
        json += serializeCanonical(descriptor.value, ancestors);
      }
      return `${json}]`;
    }
    const prototype = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    );
    if (prototype !== CAPTURED_OBJECT_PROTOTYPE && prototype !== null) {
      invalidCanonicalJson();
    }
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (typeof key !== 'string') invalidCanonicalJson();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !('value' in descriptor)
      ) invalidCanonicalJson();
    }
    const keys = ownKeys as string[];
    sortCanonicalKeys(keys);
    let json = '{';
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (index !== 0) json += ',';
      json += primitiveJson(key) + ':'
        + serializeCanonical(descriptors[key]!.value, ancestors);
    }
    return `${json}}`;
  } finally {
    CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_SET_DELETE, ancestors, [value]);
  }
}

/**
 * Archive metadata is canonical JSON so object insertion order cannot change
 * the content address when two clients construct equivalent values.
 */
export function canonicalizeTaktpackJson(value: unknown): string {
  return `${serializeCanonical(value, new CAPTURED_WEAK_SET<object>())}\n`;
}
