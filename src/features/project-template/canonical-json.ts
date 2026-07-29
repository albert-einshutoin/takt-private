function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/**
 * Archive metadata is canonical JSON so object insertion order cannot change
 * the content address when two clients construct equivalent values.
 */
export function canonicalizeTaktpackJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}
