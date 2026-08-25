import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { ProjectTemplateValidationError } from '../../features/project-template/errors.js';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  disposeProjectTemplateRepertoireDependencyInspection,
  disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  inspectProjectTemplateRepertoireDependencies,
  ProjectTemplateRepertoireDependencyInspectionError,
  type ProjectTemplateRepertoireDependencyInspectionPort,
} from '../../features/project-template/repertoire-dependency-inspection-port.js';

const SOURCE_DESCRIPTOR_SHA256 = 'a'.repeat(64);
const MANIFEST_SHA256 = 'b'.repeat(64);
const WITNESS_SHA256 = 'c'.repeat(64);
const COMMIT = 'd'.repeat(40);
const SECOND_COMMIT = 'e'.repeat(40);

function dependency(
  scope = '@acme/repertoire',
  commit = COMMIT,
) {
  const repository = scope.slice(1);
  return {
    scope: scope as `@${string}/${string}`,
    version: '1.2.3',
    source: `github:${repository}@v1.2.3` as const,
    commit,
    capabilities: ['edit'] as const,
  };
}

function request(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceDescriptorSha256: SOURCE_DESCRIPTOR_SHA256,
    manifestSha256: MANIFEST_SHA256,
    dependencies: [dependency()],
    deadlineMs: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

function installedObservation(
  scope = '@acme/repertoire',
  overrides: Record<string, unknown> = {},
) {
  return {
    scope,
    state: 'installed',
    installed: {
      source: 'github:acme/repertoire',
      ref: 'v1.2.3',
      version: '1.2.3',
      commit: COMMIT,
      capabilities: ['edit'],
      ...overrides,
    },
  };
}

function rawResult(
  observations: readonly unknown[] = [installedObservation()],
  witnessSha256 = WITNESS_SHA256,
) {
  return { witnessSha256, observations };
}

function portReturning(value: unknown): ProjectTemplateRepertoireDependencyInspectionPort {
  return {
    inspect() {
      return value;
    },
  };
}

function expectCode(
  operation: () => unknown,
  code: ProjectTemplateRepertoireDependencyInspectionError['code'],
): void {
  expect(operation).toThrow(expect.objectContaining({ code }));
}

describe('project template repertoire dependency inspection authority G2', () => {
  it('snapshots canonical observations and derives deterministic bound tokens', () => {
    const first = inspectProjectTemplateRepertoireDependencies({
      request: request(),
      port: portReturning(rawResult()),
    });
    const second = inspectProjectTemplateRepertoireDependencies({
      request: request(),
      port: portReturning(rawResult()),
    });

    expect(first).toEqual({
      kind: 'verified-project-template-repertoire-dependency-inspection',
      sourceDescriptorSha256: SOURCE_DESCRIPTOR_SHA256,
      manifestSha256: MANIFEST_SHA256,
      declarationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      preconditionToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      observations: [installedObservation()],
    });
    expect(first.declarationSha256).toBe(second.declarationSha256);
    expect(first.declarationSha256).toBe(
      createHash('sha256')
        .update(JSON.stringify([dependency()]), 'utf8')
        .digest('hex'),
    );
    expect(first.declarationSha256).toBe(
      'f672d85e355b31ff0ffde241213b3f7c0b8ca769a516f8386252166c080b83ab',
    );
    expect(first.preconditionToken).toBe(
      '794b2bf0f674da876a9b89ec50ca6ed14d62f360a79c7145e3e11b6e7a23c580',
    );
    expect(first.preconditionToken).toBe(second.preconditionToken);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.observations)).toBe(true);
    expect(Object.isFrozen(first.observations[0])).toBe(true);

    const changedWitness = inspectProjectTemplateRepertoireDependencies({
      request: request(),
      port: portReturning(rawResult(undefined, 'f'.repeat(64))),
    });
    const changedDeclaration = inspectProjectTemplateRepertoireDependencies({
      request: request({
        dependencies: [dependency('@acme/repertoire', SECOND_COMMIT)],
      }),
      port: portReturning(rawResult([
        installedObservation('@acme/repertoire', { commit: SECOND_COMMIT }),
      ])),
    });
    expect(changedWitness.preconditionToken).not.toBe(first.preconditionToken);
    expect(changedDeclaration.declarationSha256)
      .not.toBe(first.declarationSha256);
    expect(changedDeclaration.preconditionToken)
      .not.toBe(first.preconditionToken);
    const changedManifest = inspectProjectTemplateRepertoireDependencies({
      request: request({ manifestSha256: 'c'.repeat(64) }),
      port: portReturning(rawResult()),
    });
    const changedObservation = inspectProjectTemplateRepertoireDependencies({
      request: request(),
      port: portReturning(rawResult([{
        scope: '@acme/repertoire',
        state: 'missing',
      }])),
    });
    expect(changedManifest.preconditionToken).not.toBe(first.preconditionToken);
    expect(changedObservation.preconditionToken)
      .not.toBe(first.preconditionToken);
  });

  it('passes an immutable snapshot to the original port receiver', () => {
    let calls = 0;
    const receiver = {
      inspect(input: unknown) {
        expect(this).toBe(receiver);
        calls += 1;
        expect(input).not.toBe(requestValue);
        expect(Object.isFrozen(input)).toBe(true);
        return rawResult();
      },
    };
    const requestValue = request();
    inspectProjectTemplateRepertoireDependencies({
      request: requestValue,
      port: receiver,
    });
    expect(calls).toBe(1);
  });

  it('does not delegate dependency validation to a poisoned Array.map', () => {
    const originalMap = Array.prototype.map;
    const requestValue = request();
    let mapCalls = 0;
    let reentryCalls = 0;
    let reentering = false;
    let seenScope: string | undefined;
    let verified;
    try {
      Array.prototype.map = function poisonedMap() {
        mapCalls += 1;
        // If the shared parser calls a mutable callback boundary, hostile code
        // can reenter and replace the validated dependency result entirely.
        if (!reentering) {
          reentryCalls += 1;
          reentering = true;
          try {
            inspectProjectTemplateRepertoireDependencies({
              request: request({ dependencies: [] }) as never,
              port: portReturning(rawResult([])),
            });
          } catch {
            // A reentrant result is irrelevant: invoking the hook is the bug.
          } finally {
            reentering = false;
          }
        }
        return [dependency('@evil/forged')];
      } as typeof Array.prototype.map;
      verified = inspectProjectTemplateRepertoireDependencies({
        request: requestValue as never,
        port: {
          inspect(input) {
            seenScope = input.dependencies[0]?.scope;
            return rawResult([{
              scope: seenScope,
              state: 'missing',
            }]);
          },
        },
      });
    } finally {
      Array.prototype.map = originalMap;
    }
    expect(mapCalls).toBe(0);
    expect(reentryCalls).toBe(0);
    expect(seenScope).toBe('@acme/repertoire');
    expect(verified?.observations[0]?.scope).toBe('@acme/repertoire');
  });

  it('does not traverse inspection keys through a poisoned Array iterator', () => {
    const originalIterator = Array.prototype[Symbol.iterator];
    const validOptions = {
      request: request() as never,
      port: portReturning(rawResult()),
    };
    const invalidOptions = {
      request: request({ manifestSha256: 'A'.repeat(64) }) as never,
      port: portReturning(rawResult()),
    };
    const reentryOptions = {
      request: request({ dependencies: [] }) as never,
      port: portReturning(rawResult([])),
    };
    let iteratorCalls = 0;
    let reentryCalls = 0;
    let attemptedReentry = false;
    let reentryInspection:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let verified:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let invalidFailure: unknown;

    try {
      Array.prototype[Symbol.iterator] = function poisonedIterator() {
        iteratorCalls += 1;
        if (!attemptedReentry) {
          attemptedReentry = true;
          reentryCalls += 1;
          try {
            reentryInspection =
              inspectProjectTemplateRepertoireDependencies(reentryOptions);
          } catch {
            // Calling the nested inspection boundary is itself the violation.
          }
        }
        return Reflect.apply(originalIterator, this, []);
      };
      verified = inspectProjectTemplateRepertoireDependencies(validOptions);
      try {
        inspectProjectTemplateRepertoireDependencies(invalidOptions);
      } catch (error) {
        invalidFailure = error;
      }
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }

    const reentryMinted = reentryInspection !== undefined;
    if (reentryInspection !== undefined) {
      disposeProjectTemplateRepertoireDependencyInspection(
        reentryInspection,
      );
    }
    expect(iteratorCalls).toBe(0);
    expect(reentryCalls).toBe(0);
    expect(reentryMinted).toBe(false);
    expect(invalidFailure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const claim =
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(verified);
    const snapshot =
      consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
        claim,
      );
    expect(snapshot.observations[0]?.scope).toBe('@acme/repertoire');
  });

  it('snapshots inspection arrays without species or inherited index hooks', () => {
    const defineProperty = Object.defineProperty;
    const originalConstructor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'constructor',
    )!;
    const originalMap = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'map',
    )!;
    const originalPush = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'push',
    )!;
    const originalZero = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    const originalOne = Object.getOwnPropertyDescriptor(Array.prototype, '1');
    const validOptions = {
      request: request() as never,
      port: portReturning(rawResult()),
    };
    const equivalentOptions = {
      request: request() as never,
      port: portReturning(rawResult()),
    };
    const invalidOptions = {
      request: request({ manifestSha256: 'A'.repeat(64) }) as never,
      port: portReturning(rawResult()),
    };
    const reentryOptions = {
      request: request({ dependencies: [] }) as never,
      port: portReturning(rawResult([])),
    };
    let constructorCalls = 0;
    let indexSetterCalls = 0;
    let mapCalls = 0;
    let pushCalls = 0;
    let reentryCalls = 0;
    let attemptedReentry = false;
    let reentryInspection:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let first:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let second:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let validFailure: unknown;
    let invalidFailure: unknown;

    const attemptReentry = () => {
      if (attemptedReentry) return;
      attemptedReentry = true;
      reentryCalls += 1;
      try {
        reentryInspection =
          inspectProjectTemplateRepertoireDependencies(reentryOptions);
      } catch {
        // Invoking the nested authority boundary is itself the violation.
      }
    };
    const constructorGetter = () => {
      constructorCalls += 1;
      attemptReentry();
      return Array;
    };
    const indexSetter = (_value: unknown) => {
      indexSetterCalls += 1;
      attemptReentry();
    };
    const poisonedMap = function poisonedMap(): never {
      mapCalls += 1;
      attemptReentry();
      throw new Error('poisoned map called');
    };
    const poisonedPush = function poisonedPush(): never {
      pushCalls += 1;
      attemptReentry();
      throw new Error('poisoned push called');
    };

    try {
      defineProperty(Array.prototype, 'constructor', {
        configurable: true,
        get: constructorGetter,
      });
      defineProperty(Array.prototype, '0', {
        configurable: true,
        set: indexSetter,
      });
      defineProperty(Array.prototype, '1', {
        configurable: true,
        set: indexSetter,
      });
      defineProperty(Array.prototype, 'map', {
        ...originalMap,
        value: poisonedMap,
      });
      defineProperty(Array.prototype, 'push', {
        ...originalPush,
        value: poisonedPush,
      });
      try {
        first = inspectProjectTemplateRepertoireDependencies(validOptions);
        second =
          inspectProjectTemplateRepertoireDependencies(equivalentOptions);
      } catch (error) {
        validFailure = error;
      }
      try {
        inspectProjectTemplateRepertoireDependencies(invalidOptions);
      } catch (error) {
        invalidFailure = error;
      }
    } finally {
      defineProperty(Array.prototype, 'constructor', originalConstructor);
      defineProperty(Array.prototype, 'map', originalMap);
      defineProperty(Array.prototype, 'push', originalPush);
      if (originalZero === undefined) {
        Reflect.deleteProperty(Array.prototype, '0');
      } else {
        defineProperty(Array.prototype, '0', originalZero);
      }
      if (originalOne === undefined) {
        Reflect.deleteProperty(Array.prototype, '1');
      } else {
        defineProperty(Array.prototype, '1', originalOne);
      }
    }

    const reentryMinted = reentryInspection !== undefined;
    if (reentryInspection !== undefined) {
      disposeProjectTemplateRepertoireDependencyInspection(
        reentryInspection,
      );
    }
    expect(constructorCalls).toBe(0);
    expect(indexSetterCalls).toBe(0);
    expect(mapCalls).toBe(0);
    expect(pushCalls).toBe(0);
    expect(reentryCalls).toBe(0);
    expect(reentryMinted).toBe(false);
    expect(validFailure).toBeUndefined();
    expect(invalidFailure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(first?.preconditionToken).toBe(second?.preconditionToken);
    const claim =
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(first);
    const snapshot =
      consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
        claim,
      );
    expect(snapshot.observations[0]?.scope).toBe('@acme/repertoire');
    disposeProjectTemplateRepertoireDependencyInspection(second);
  });

  it('does not resolve mutable global receivers or Error after initialization', () => {
    const intrinsicObject = Object;
    const intrinsicReflect = Reflect;
    const intrinsicJson = JSON;
    const intrinsicError = Error;
    const defineProperty = intrinsicObject.defineProperty;
    const objectDescriptor = intrinsicObject.getOwnPropertyDescriptor(
      globalThis,
      'Object',
    )!;
    const reflectDescriptor = intrinsicObject.getOwnPropertyDescriptor(
      globalThis,
      'Reflect',
    )!;
    const jsonDescriptor = intrinsicObject.getOwnPropertyDescriptor(
      globalThis,
      'JSON',
    )!;
    const errorDescriptor = intrinsicObject.getOwnPropertyDescriptor(
      globalThis,
      'Error',
    )!;
    const validOptions = {
      request: request() as never,
      port: portReturning(rawResult()),
    };
    const invalidOptions = {
      request: request() as never,
      port: portReturning(rawResult()),
      unexpected: true,
    };
    const reentryOptions = {
      request: request({ dependencies: [] }) as never,
      port: portReturning(rawResult([])),
    };
    let objectCalls = 0;
    let reflectCalls = 0;
    let jsonCalls = 0;
    let errorCalls = 0;
    let reentryCalls = 0;
    let attemptedReentry = false;
    let reentryInspection:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let verified:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let validFailure: unknown;
    let invalidFailure: unknown;

    const attemptReentry = () => {
      if (attemptedReentry) return;
      attemptedReentry = true;
      reentryCalls += 1;
      try {
        reentryInspection =
          inspectProjectTemplateRepertoireDependencies(reentryOptions);
      } catch {
        // Invoking the nested authority boundary is itself the violation.
      }
    };
    const objectGetter = () => {
      objectCalls += 1;
      attemptReentry();
      return intrinsicObject;
    };
    const reflectGetter = () => {
      reflectCalls += 1;
      attemptReentry();
      return intrinsicReflect;
    };
    const jsonGetter = () => {
      jsonCalls += 1;
      attemptReentry();
      return intrinsicJson;
    };
    const errorGetter = () => {
      errorCalls += 1;
      attemptReentry();
      return intrinsicError;
    };
    const poisonedObjectDescriptor = {
      configurable: true,
      get: objectGetter,
    };
    const poisonedReflectDescriptor = {
      configurable: true,
      get: reflectGetter,
    };
    const poisonedJsonDescriptor = {
      configurable: true,
      get: jsonGetter,
    };
    const poisonedErrorDescriptor = {
      configurable: true,
      get: errorGetter,
    };

    try {
      defineProperty(globalThis, 'Object', poisonedObjectDescriptor);
      defineProperty(globalThis, 'Reflect', poisonedReflectDescriptor);
      defineProperty(globalThis, 'JSON', poisonedJsonDescriptor);
      defineProperty(globalThis, 'Error', poisonedErrorDescriptor);
      try {
        verified = inspectProjectTemplateRepertoireDependencies(validOptions);
      } catch (error) {
        validFailure = error;
      }
      try {
        inspectProjectTemplateRepertoireDependencies(invalidOptions as never);
      } catch (error) {
        invalidFailure = error;
      }
    } finally {
      defineProperty(globalThis, 'Object', objectDescriptor);
      defineProperty(globalThis, 'Reflect', reflectDescriptor);
      defineProperty(globalThis, 'JSON', jsonDescriptor);
      defineProperty(globalThis, 'Error', errorDescriptor);
    }

    const reentryMinted = reentryInspection !== undefined;
    if (reentryInspection !== undefined) {
      disposeProjectTemplateRepertoireDependencyInspection(
        reentryInspection,
      );
    }
    expect(objectCalls).toBe(0);
    expect(reflectCalls).toBe(0);
    expect(jsonCalls).toBe(0);
    expect(errorCalls).toBe(0);
    expect(reentryCalls).toBe(0);
    expect(reentryMinted).toBe(false);
    expect(validFailure).toBeUndefined();
    expect(invalidFailure).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const claim =
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(verified);
    const snapshot =
      consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
        claim,
      );
    expect(snapshot.observations[0]?.scope).toBe('@acme/repertoire');
  });

  it('defines public error names without prototype setter reentry', () => {
    const defineProperty = Object.defineProperty;
    const inspectionNameDescriptor = Object.getOwnPropertyDescriptor(
      ProjectTemplateRepertoireDependencyInspectionError.prototype,
      'name',
    );
    const validationNameDescriptor = Object.getOwnPropertyDescriptor(
      ProjectTemplateValidationError.prototype,
      'name',
    );
    const invalidDependencyOptions = {
      request: request({
        dependencies: [dependency('@acme/repertoire', 'short')],
      }) as never,
      port: portReturning(rawResult()),
    };
    const reentryOptions = {
      request: request({ dependencies: [] }) as never,
      port: portReturning(rawResult([])),
    };
    let inspectionSetterCalls = 0;
    let validationSetterCalls = 0;
    let inspectionReentryCalls = 0;
    let validationReentryCalls = 0;
    let attemptedInspectionReentry = false;
    let attemptedValidationReentry = false;
    let inspectionReentry:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let validationReentry:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let invalidOptionsFailure: unknown;
    let invalidDependencyFailure: unknown;
    let directInspectionError:
      ProjectTemplateRepertoireDependencyInspectionError | undefined;
    let directValidationError: ProjectTemplateValidationError | undefined;

    const inspectionNameSetter = (_value: unknown) => {
      inspectionSetterCalls += 1;
      if (attemptedInspectionReentry) return;
      attemptedInspectionReentry = true;
      inspectionReentryCalls += 1;
      try {
        inspectionReentry =
          inspectProjectTemplateRepertoireDependencies(reentryOptions);
      } catch {
        // Invoking the nested authority boundary is itself the violation.
      }
    };
    const validationNameSetter = (_value: unknown) => {
      validationSetterCalls += 1;
      if (attemptedValidationReentry) return;
      attemptedValidationReentry = true;
      validationReentryCalls += 1;
      try {
        validationReentry =
          inspectProjectTemplateRepertoireDependencies(reentryOptions);
      } catch {
        // Invoking the nested authority boundary is itself the violation.
      }
    };

    try {
      defineProperty(
        ProjectTemplateRepertoireDependencyInspectionError.prototype,
        'name',
        { configurable: true, set: inspectionNameSetter },
      );
      defineProperty(
        ProjectTemplateValidationError.prototype,
        'name',
        { configurable: true, set: validationNameSetter },
      );
      try {
        inspectProjectTemplateRepertoireDependencies({} as never);
      } catch (error) {
        invalidOptionsFailure = error;
      }
      try {
        inspectProjectTemplateRepertoireDependencies(
          invalidDependencyOptions,
        );
      } catch (error) {
        invalidDependencyFailure = error;
      }
      directInspectionError =
        new ProjectTemplateRepertoireDependencyInspectionError(
          'INVALID_ARGUMENT',
          'invalid inspection',
        );
      directValidationError = new ProjectTemplateValidationError(
        'INVALID_SOURCE',
        'invalid source',
        'request.dependencies',
      );
    } finally {
      if (inspectionNameDescriptor === undefined) {
        Reflect.deleteProperty(
          ProjectTemplateRepertoireDependencyInspectionError.prototype,
          'name',
        );
      } else {
        defineProperty(
          ProjectTemplateRepertoireDependencyInspectionError.prototype,
          'name',
          inspectionNameDescriptor,
        );
      }
      if (validationNameDescriptor === undefined) {
        Reflect.deleteProperty(
          ProjectTemplateValidationError.prototype,
          'name',
        );
      } else {
        defineProperty(
          ProjectTemplateValidationError.prototype,
          'name',
          validationNameDescriptor,
        );
      }
    }

    const inspectionReentryMinted = inspectionReentry !== undefined;
    const validationReentryMinted = validationReentry !== undefined;
    if (inspectionReentry !== undefined) {
      disposeProjectTemplateRepertoireDependencyInspection(
        inspectionReentry,
      );
    }
    if (validationReentry !== undefined) {
      disposeProjectTemplateRepertoireDependencyInspection(
        validationReentry,
      );
    }
    expect(inspectionSetterCalls).toBe(0);
    expect(validationSetterCalls).toBe(0);
    expect(inspectionReentryCalls).toBe(0);
    expect(validationReentryCalls).toBe(0);
    expect(inspectionReentryMinted).toBe(false);
    expect(validationReentryMinted).toBe(false);
    expect(invalidOptionsFailure).toMatchObject({
      name: 'ProjectTemplateRepertoireDependencyInspectionError',
      code: 'INVALID_ARGUMENT',
    });
    expect(invalidDependencyFailure).toMatchObject({
      name: 'ProjectTemplateRepertoireDependencyInspectionError',
      code: 'INVALID_ARGUMENT',
    });
    expect(Object.hasOwn(directInspectionError!, 'name')).toBe(true);
    expect(directInspectionError).toMatchObject({
      name: 'ProjectTemplateRepertoireDependencyInspectionError',
      code: 'INVALID_ARGUMENT',
    });
    expect(Object.hasOwn(directValidationError!, 'name')).toBe(true);
    expect(directValidationError).toMatchObject({
      name: 'ProjectTemplateValidationError',
      code: 'INVALID_SOURCE',
      field: 'request.dependencies',
    });
  });

  it('cannot hide an unexpected key through a poisoned Array iterator', () => {
    const originalIterator = Array.prototype[Symbol.iterator];
    const options = {
      request: request() as never,
      port: portReturning(rawResult()),
      unexpected: true,
    };
    let iteratorCalls = 0;
    let inspection:
      ReturnType<typeof inspectProjectTemplateRepertoireDependencies>
      | undefined;
    let failure: unknown;
    try {
      Array.prototype[Symbol.iterator] = function filteredIterator() {
        iteratorCalls += 1;
        const values = this;
        let index = 0;
        return {
          next(): IteratorResult<unknown> {
            while (index < values.length) {
              const value = values[index];
              index += 1;
              if (value === 'unexpected') continue;
              return { done: false, value };
            }
            return { done: true, value: undefined };
          },
        };
      };
      try {
        inspection = inspectProjectTemplateRepertoireDependencies(
          options as never,
        );
      } catch (error) {
        failure = error;
      }
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    if (inspection !== undefined) {
      disposeProjectTemplateRepertoireDependencyInspection(inspection);
    }
    expect(iteratorCalls).toBe(0);
    expect(inspection).toBeUndefined();
    expect(failure).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('fails array lengths before enumerating oversized bridge values', async () => {
    const oversizedObservations: unknown[] = [];
    oversizedObservations.length = 1_000_000_000;
    const oversizedCapabilities: unknown[] = [];
    oversizedCapabilities.length = 1_000_000_000;
    let hostileLengthCalls = 0;
    const hostileObservations = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length') hostileLengthCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const originalDescriptors = Object.getOwnPropertyDescriptors;
    let observationDescriptorCalls = 0;
    let capabilityDescriptorCalls = 0;
    Object.getOwnPropertyDescriptors = ((value: object) => {
      if (value === oversizedObservations) {
        observationDescriptorCalls += 1;
      }
      if (value === oversizedCapabilities) {
        capabilityDescriptorCalls += 1;
      }
      return originalDescriptors(value);
    }) as typeof Object.getOwnPropertyDescriptors;
    vi.resetModules();
    let fresh;
    try {
      fresh = await import(
        '../../features/project-template/repertoire-dependency-inspection-port.js'
      );
    } finally {
      Object.getOwnPropertyDescriptors = originalDescriptors;
    }

    const originalIterator = Array.prototype[Symbol.iterator];
    let iteratorCalls = 0;
    let mismatchFailure: unknown;
    let capabilityFailure: unknown;
    let hostileFailure: unknown;
    try {
      Array.prototype[Symbol.iterator] = function poisonedIterator(): never {
        iteratorCalls += 1;
        throw new Error('oversized bridge iterator invoked');
      };
      try {
        fresh.inspectProjectTemplateRepertoireDependencies({
          request: request() as never,
          port: portReturning(rawResult(oversizedObservations)),
        });
      } catch (error) {
        mismatchFailure = error;
      }
      try {
        fresh.inspectProjectTemplateRepertoireDependencies({
          request: request() as never,
          port: portReturning(rawResult([
            installedObservation('@acme/repertoire', {
              capabilities: oversizedCapabilities,
            }),
          ])),
        });
      } catch (error) {
        capabilityFailure = error;
      }
      try {
        fresh.inspectProjectTemplateRepertoireDependencies({
          request: request() as never,
          port: portReturning(rawResult(hostileObservations)),
        });
      } catch (error) {
        hostileFailure = error;
      }
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(observationDescriptorCalls).toBe(0);
    expect(capabilityDescriptorCalls).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(hostileLengthCalls).toBe(0);
    expect(mismatchFailure).toMatchObject({ code: 'BRIDGE_FAILURE' });
    expect(capabilityFailure).toMatchObject({ code: 'BRIDGE_FAILURE' });
    expect(hostileFailure).toMatchObject({ code: 'BRIDGE_FAILURE' });
  });

  it.each([
    ['undefined options', undefined],
    ['array options', []],
    ['extra options', { request: request(), port: portReturning(rawResult()), extra: true }],
    ['symbol options', Object.assign(
      { request: request(), port: portReturning(rawResult()) },
      { [Symbol('extra')]: true },
    )],
    ['proxy options', new Proxy(
      { request: request(), port: portReturning(rawResult()) },
      {},
    )],
    ['cross-realm options', runInNewContext('({ request: {}, port: {} })')],
  ])('rejects exact options boundary attacks: %s', (_label, value) => {
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies(value as never),
      'INVALID_ARGUMENT',
    );
  });

  it('rejects accessors and unknown keys without invoking them', () => {
    const requestGetter = vi.fn(() => request());
    const options = {
      get request() {
        return requestGetter();
      },
      port: portReturning(rawResult()),
    };
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies(options as never),
      'INVALID_ARGUMENT',
    );
    expect(requestGetter).not.toHaveBeenCalled();

    const thenGetter = vi.fn(() => () => undefined);
    const result = Object.defineProperty(
      rawResult(),
      'then',
      { enumerable: true, get: thenGetter },
    );
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies({
        request: request(),
        port: portReturning(result),
      }),
      'BRIDGE_FAILURE',
    );
    expect(thenGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['uppercase hash', request({ manifestSha256: 'A'.repeat(64) })],
    ['negative deadline', request({ deadlineMs: -1 })],
    ['infinite deadline', request({ deadlineMs: Number.POSITIVE_INFINITY })],
    ['extra request key', request({ extra: true })],
    ['proxy request', new Proxy(request(), {})],
    ['invalid dependency', request({
      dependencies: [{ ...dependency(), source: 'github:acme/repertoire@main' }],
    })],
  ])('rejects malformed request input: %s', (_label, requestValue) => {
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies({
        request: requestValue as never,
        port: portReturning(rawResult()),
      }),
      'INVALID_ARGUMENT',
    );
  });

  it('rejects malformed ports and proxied inspect methods', () => {
    const proxiedMethod = new Proxy(() => rawResult(), {});
    for (const value of [
      {},
      { inspect: () => rawResult(), extra: true },
      new Proxy({ inspect: () => rawResult() }, {}),
      { inspect: proxiedMethod },
    ]) {
      expectCode(
        () => inspectProjectTemplateRepertoireDependencies({
          request: request() as never,
          port: value as never,
        }),
        'INVALID_ARGUMENT',
      );
    }
  });

  it('maps native promises, functions, and thenables to bridge failure', () => {
    const thenGetter = vi.fn(() => () => undefined);
    const thenable = Object.defineProperty({}, 'then', {
      enumerable: true,
      get: thenGetter,
    });
    for (const value of [
      Promise.resolve(rawResult()),
      runInNewContext('Promise.resolve({})'),
      () => rawResult(),
      thenable,
    ]) {
      expectCode(
        () => inspectProjectTemplateRepertoireDependencies({
          request: request() as never,
          port: portReturning(value),
        }),
        'BRIDGE_FAILURE',
      );
    }
    expect(thenGetter).not.toHaveBeenCalled();
  });

  it('redacts arbitrary port failures without inspecting the thrown value', () => {
    const secretGetter = vi.fn(() => 'SECRET');
    const thrown = Object.defineProperty({}, 'message', { get: secretGetter });
    let failure: unknown;
    try {
      inspectProjectTemplateRepertoireDependencies({
        request: request() as never,
        port: {
          inspect() {
            throw thrown;
          },
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'INSPECTION_FAILED',
      message: 'Project template repertoire dependency inspection failed',
    });
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false);
    expect(secretGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong count', rawResult([])],
    ['wrong scope', rawResult([{ scope: '@acme/other', state: 'missing' }])],
    ['extra missing field', rawResult([{
      scope: '@acme/repertoire', state: 'missing', reason: 'none',
    }])],
    ['wrong invalid reason', rawResult([{
      scope: '@acme/repertoire', state: 'invalid', reason: 'CORRUPT',
    }])],
    ['extra installed field', rawResult([{
      ...installedObservation(),
      installed: {
        ...installedObservation().installed,
        importedAt: 'SECRET',
      },
    }])],
    ['noncanonical installed source', rawResult([
      installedObservation('@acme/repertoire', {
        source: 'github:Acme/Repertoire',
      }),
    ])],
    ['short installed commit', rawResult([
      installedObservation('@acme/repertoire', { commit: 'd'.repeat(39) }),
    ])],
    ['smuggled capability', rawResult([
      installedObservation('@acme/repertoire', { capabilities: ['execute'] }),
    ])],
  ])('rejects observation mismatch and smuggling: %s', (_label, result) => {
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies({
        request: request() as never,
        port: portReturning(result),
      }),
      'BRIDGE_FAILURE',
    );
  });

  it('gives abort priority before and after the synchronous port call', () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const prePort = { inspect: vi.fn(() => rawResult()) };
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies({
        request: request({
          signal: preAborted.signal,
          deadlineMs: 0,
        }) as never,
        port: prePort,
      }),
      'ABORTED',
    );
    expect(prePort.inspect).not.toHaveBeenCalled();

    const postController = new AbortController();
    const postPort = {
      inspect: vi.fn(() => {
        postController.abort();
        return rawResult();
      }),
    };
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies({
        request: request({
          signal: postController.signal,
          deadlineMs: Number.MAX_SAFE_INTEGER,
        }) as never,
        port: postPort,
      }),
      'ABORTED',
    );
    expect(postPort.inspect).toHaveBeenCalledOnce();
  });

  it('rejects expired deadlines before invoking the port', () => {
    const port = { inspect: vi.fn(() => rawResult()) };
    expectCode(
      () => inspectProjectTemplateRepertoireDependencies({
        request: request({ deadlineMs: 0 }) as never,
        port,
      }),
      'TIMEOUT',
    );
    expect(port.inspect).not.toHaveBeenCalled();
  });

  it('rejects a deadline that expires during exactly one port call', async () => {
    let clock = 10;
    const now = vi.spyOn(performance, 'now')
      .mockImplementation(() => clock);
    vi.resetModules();
    try {
      const fresh = await import(
        '../../features/project-template/repertoire-dependency-inspection-port.js'
      );
      const port = {
        inspect: vi.fn(() => {
          clock = 20;
          return rawResult();
        }),
      };
      expect(() => fresh.inspectProjectTemplateRepertoireDependencies({
        request: request({ deadlineMs: 15 }) as never,
        port,
      })).toThrow(expect.objectContaining({ code: 'TIMEOUT' }));
      expect(port.inspect).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  });

  it('rejects fake, proxied, accessor, and cross-realm-like abort signals', () => {
    const getter = vi.fn(() => false);
    const accessorSignal = Object.create(AbortSignal.prototype);
    Object.defineProperty(accessorSignal, 'aborted', { get: getter });
    for (const signal of [
      { aborted: false },
      new Proxy(new AbortController().signal, {}),
      accessorSignal,
      Object.create(Object.freeze({ foreignAbortSignal: true })),
    ]) {
      expectCode(
        () => inspectProjectTemplateRepertoireDependencies({
          request: request({ signal }) as never,
          port: portReturning(rawResult()),
        }),
        'INVALID_ARGUMENT',
      );
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('enforces single-winner planning ownership and invalidates clones', () => {
    const verified = inspectProjectTemplateRepertoireDependencies({
      request: request() as never,
      port: portReturning(rawResult()),
    });
    expectCode(
      () => claimProjectTemplateRepertoireDependencyInspectionForPlanning({
        ...verified,
      }),
      'INVALID_AUTHORITY',
    );
    expectCode(
      () => claimProjectTemplateRepertoireDependencyInspectionForPlanning(
        new Proxy(verified, {}),
      ),
      'INVALID_AUTHORITY',
    );

    const claim =
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(verified);
    expect(claim.inspection).toBe(verified);
    expectCode(
      () => claimProjectTemplateRepertoireDependencyInspectionForPlanning(
        verified,
      ),
      'INVALID_AUTHORITY',
    );
    expectCode(
      () => disposeProjectTemplateRepertoireDependencyInspection(verified),
      'INVALID_AUTHORITY',
    );
    expectCode(
      () => consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim({
        inspection: verified,
      }),
      'INVALID_AUTHORITY',
    );

    const snapshot =
      consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(claim);
    expect(snapshot).toEqual({
      ...verified,
      kind: 'project-template-repertoire-dependency-inspection-snapshot',
    });
    expectCode(
      () => consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
        claim,
      ),
      'INVALID_AUTHORITY',
    );
    expectCode(
      () => disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
        claim,
      ),
      'INVALID_AUTHORITY',
    );
  });

  it('supports explicit disposal without invoking caller hooks', () => {
    const verified = inspectProjectTemplateRepertoireDependencies({
      request: request() as never,
      port: portReturning(rawResult()),
    });
    const hook = vi.fn();
    Object.defineProperties(Object.prototype, {
      toJSON: { configurable: true, get: hook },
      [Symbol.dispose]: { configurable: true, get: hook },
    });
    try {
      disposeProjectTemplateRepertoireDependencyInspection(verified);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'toJSON');
      Reflect.deleteProperty(Object.prototype, Symbol.dispose);
    }
    expect(hook).not.toHaveBeenCalled();

    const second = inspectProjectTemplateRepertoireDependencies({
      request: request() as never,
      port: portReturning(rawResult()),
    });
    const claim =
      claimProjectTemplateRepertoireDependencyInspectionForPlanning(second);
    disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim(claim);
    expectCode(
      () => consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim(
        claim,
      ),
      'INVALID_AUTHORITY',
    );
  });

  it('uses captured intrinsics for authority transitions', () => {
    const verified = inspectProjectTemplateRepertoireDependencies({
      request: request() as never,
      port: portReturning(rawResult()),
    });
    const originals = {
      freeze: Object.freeze,
      reflectApply: Reflect.apply,
      weakGet: WeakMap.prototype.get,
      weakSet: WeakMap.prototype.set,
      weakDelete: WeakMap.prototype.delete,
    };
    const hook = vi.fn(() => {
      throw new Error('poisoned intrinsic invoked');
    });
    let claim;
    try {
      Object.freeze = hook as never;
      Reflect.apply = hook as never;
      WeakMap.prototype.get = hook as never;
      WeakMap.prototype.set = hook as never;
      WeakMap.prototype.delete = hook as never;
      claim =
        claimProjectTemplateRepertoireDependencyInspectionForPlanning(
          verified,
        );
    } finally {
      Object.freeze = originals.freeze;
      Reflect.apply = originals.reflectApply;
      WeakMap.prototype.get = originals.weakGet;
      WeakMap.prototype.set = originals.weakSet;
      WeakMap.prototype.delete = originals.weakDelete;
    }
    disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim(claim);
    expect(hook).not.toHaveBeenCalled();
  });

  it('does not expose witness bytes or an apply authority API', () => {
    const verified = inspectProjectTemplateRepertoireDependencies({
      request: request() as never,
      port: portReturning(rawResult()),
    }) as unknown as Record<string, unknown>;
    expect(verified).not.toHaveProperty('witnessSha256');
    expect(verified).not.toHaveProperty('apply');
    expect(verified).not.toHaveProperty('claimForApply');
  });
});
