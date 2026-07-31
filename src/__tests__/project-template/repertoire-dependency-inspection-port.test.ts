import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  claimProjectTemplateRepertoireDependencyInspectionForPlanning,
  consumeProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  disposeProjectTemplateRepertoireDependencyInspection,
  disposeProjectTemplateRepertoireDependencyInspectionPlanningClaim,
  inspectProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyInspectionError,
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
