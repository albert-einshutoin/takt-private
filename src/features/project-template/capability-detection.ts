import { ProjectTemplateValidationError } from './errors.js';
import { parseProjectTemplateManifest } from './manifest.js';
import type { DetectedTemplateCapabilities } from './types.js';
import {
  assertAllowedKeys,
  MAX_TEMPLATE_ENTRIES,
  parseCapabilities,
  parsePortablePath,
  requireArray,
  requireRecord,
  validatePathIdentities,
} from './validation.js';

function parseDetection(value: unknown, index: number): DetectedTemplateCapabilities {
  const field = `detections[${index}]`;
  const detection = requireRecord(value, field);
  assertAllowedKeys(detection, ['path', 'capabilities'], field);
  const capabilities = parseCapabilities(
    detection['capabilities'],
    `${field}.capabilities`,
    'DETECTED_CAPABILITY_MISMATCH',
  );
  if (capabilities === undefined) {
    throw new ProjectTemplateValidationError(
      'DETECTED_CAPABILITY_MISMATCH',
      `${field}.capabilities is required`,
      `${field}.capabilities`,
    );
  }
  return {
    path: parsePortablePath(detection['path'], `${field}.path`),
    capabilities,
  };
}

/**
 * Ensures classifier/archive evidence never grants a pack more capability than
 * both its entry and manifest explicitly declared. This validates supplied
 * evidence only; callers must track inspection completeness separately.
 */
export function validateDetectedTemplateCapabilities(
  manifestValue: unknown,
  detectionsValue: unknown,
): void {
  const manifest = parseProjectTemplateManifest(manifestValue);
  const rawDetections = requireArray(
    detectionsValue,
    'detections',
    MAX_TEMPLATE_ENTRIES,
    'DETECTED_CAPABILITY_MISMATCH',
  );
  const detections = rawDetections.map(parseDetection);
  validatePathIdentities(detections, 'detections');

  const manifestCapabilities = new Set(manifest.capabilities ?? []);
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  for (const detection of detections) {
    const entry = entries.get(detection.path);
    if (entry === undefined) {
      throw new ProjectTemplateValidationError(
        'DETECTED_CAPABILITY_MISMATCH',
        `detection references unknown entry ${detection.path}`,
        'detections.path',
      );
    }
    const entryCapabilities = new Set(entry.capabilities ?? []);
    for (const capability of detection.capabilities) {
      if (!entryCapabilities.has(capability) || !manifestCapabilities.has(capability)) {
        throw new ProjectTemplateValidationError(
          'DETECTED_CAPABILITY_MISMATCH',
          `${detection.path} detected undeclared capability ${capability}`,
          'detections.capabilities',
        );
      }
    }
  }
}
