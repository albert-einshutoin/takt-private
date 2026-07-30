import { inspect } from 'node:util';
import {
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createProjectTemplateArtifactRedirectState,
  ProjectTemplateArtifactRedirectError,
  validateProjectTemplateArtifactDnsAnswers,
} from '../../infra/github/project-template-artifact-redirect.js';

const ASSET_API_URL =
  'https://api.github.com/repos/octo/demo/releases/assets/123';

function expectCode(operation: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ProjectTemplateArtifactRedirectError);
  expect(thrown).toMatchObject({ code });
  expect(String(thrown)).not.toContain('octo');
  expect(String(thrown)).not.toContain('secret');
}

function consumeRedirect(
  state: ReturnType<typeof createProjectTemplateArtifactRedirectState>,
  location: string,
): void {
  state.resolve(302, location).consume().dispose();
}

describe('project-template artifact redirect state F2b-A', () => {
  it('accepts only the canonical api.github.com release asset API base', () => {
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Reflect.ownKeys(state)).toEqual(['resolve', 'dispose']);
    expect(JSON.stringify(state)).toBe('{}');
    expect(inspect(state)).not.toContain('octo');
    state.dispose();

    for (const invalid of [
      'http://api.github.com/repos/octo/demo/releases/assets/123',
      'https://API.github.com/repos/octo/demo/releases/assets/123',
      'https://api.github.com:444/repos/octo/demo/releases/assets/123',
      'https://api.github.com/repos/octo/demo/releases/assets/123/',
      'https://api.github.com/repos/octo/demo/releases/assets/0',
      'https://api.github.com/repos/octo/demo/releases/assets/9007199254740992',
      'https://api.github.com/repos/octo/demo/releases/assets/9223372036854775808',
      `https://api.github.com/repos/octo/demo/releases/assets/${'9'.repeat(256)}`,
      'https://api.github.com/repos/octo/demo/releases/assets/123?secret=1',
      'https://release-assets.githubusercontent.com/x',
      'https://api.github.com/repos/owner--name/demo/releases/assets/123',
      'https://api.github.com/repos/owner-/demo/releases/assets/123',
      'https://api.github.com/repos/octo/./releases/assets/123',
      'https://api.github.com/repos/octo/../releases/assets/123',
      'https://api.github.com/repos/octo/demo.git/releases/assets/123',
      `https://api.github.com/repos/octo/${'r'.repeat(101)}/releases/assets/123`,
    ]) {
      expectCode(
        () => createProjectTemplateArtifactRedirectState(invalid),
        'INVALID_ARGUMENT',
      );
    }

    const maximum = createProjectTemplateArtifactRedirectState(
      'https://api.github.com/repos/Owner/repo..template/releases/assets/9007199254740991',
    );
    maximum.dispose();
  });

  it.each([301, 302, 303, 307, 308])(
    'resolves allowed status %i without exposing the target',
    (status) => {
      const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
      const grant = state.resolve(
        status,
        'https://release-assets.githubusercontent.com/github-production-release-asset/1/file.takt?sp=secret',
      );
      expect(Object.isFrozen(grant)).toBe(true);
      expect(Reflect.ownKeys(grant)).toEqual(['consume', 'dispose']);
      expect(JSON.stringify(grant)).toBe('{}');
      expect(inspect(grant)).not.toContain('file.takt');
      expect(String(grant.consume)).not.toContain('file.takt');

      const hop = grant.consume();
      expect(Object.isFrozen(hop)).toBe(true);
      expect(Reflect.ownKeys(hop)).toEqual(['dispose']);
      expect(JSON.stringify(hop)).toBe('{}');
      expect(inspect(hop)).not.toContain('secret');
      hop.dispose();
      state.dispose();
    },
  );

  it.each([200, 300, 304, 305, 306, 309, 399, Number.NaN])(
    'rejects non-redirect status %s with the finite redirect contract',
    (status) => {
      const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
      expectCode(
        () => state.resolve(status, 'https://objects.githubusercontent.com/x'),
        'INVALID_REDIRECT',
      );
      state.dispose();
    },
  );

  it.each([
    '',
    ' '.repeat(2),
    `https://objects.githubusercontent.com/${'a'.repeat(8193)}`,
    'https://objects.githubusercontent.com/a b',
    'https://objects.githubusercontent.com/a\\b',
    'https://objects.githubusercontent.com/a\nsecret',
    'https://objects.githubusercontent.com/é',
  ])('rejects invalid raw Location %j', (location) => {
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    expectCode(() => state.resolve(302, location), 'INVALID_REDIRECT');
    state.dispose();
  });

  it.each([
    'http://objects.githubusercontent.com/file',
    'https://user:secret@objects.githubusercontent.com/file',
    'https://objects.githubusercontent.com:444/file',
    'https://objects.githubusercontent.com/file#fragment',
    'https://objects.githubusercontent.com./file',
    'https://127.0.0.1/file',
    'https://[::1]/file',
    'https://objects.githubusercontent.com.evil.example/file',
    'https://evilobjects.githubusercontent.com/file',
    'https://xn--githubcontent-9jg.com/file',
    'https://OBJECTS.githubusercontent.com/file',
    '//OBJECTS.githubusercontent.com/file',
    'https://%6fbjects.githubusercontent.com/file',
    'https://@objects.githubusercontent.com/file',
    '//@objects.githubusercontent.com/file',
    'https://objects.githubusercontent.com/file#',
    '/relative#',
  ])('rejects forbidden redirect target %s', (location) => {
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    expectCode(() => state.resolve(302, location), 'REDIRECT_FORBIDDEN');
    state.dispose();
  });

  it('allows @ and encoded # as path/query data', () => {
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    const grant = state.resolve(302, '/path@name?value=@%23');
    grant.dispose();
    state.dispose();
  });

  it('limits consumed redirect hops to three without spending failures', () => {
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    expectCode(
      () => state.resolve(200, '/invalid-status'),
      'INVALID_REDIRECT',
    );
    expectCode(
      () => state.resolve(302, 'https://evil.example/forbidden'),
      'REDIRECT_FORBIDDEN',
    );
    const discarded = state.resolve(302, '/discarded');
    discarded.dispose();

    consumeRedirect(state, '/one');
    consumeRedirect(state, '/two');
    consumeRedirect(state, '/three');
    expectCode(() => state.resolve(302, '/four'), 'REDIRECT_LIMIT');
    state.dispose();
  });

  it('keeps loop rejection distinct and visited identity bounded under replay', () => {
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    const add = vi.spyOn(Set.prototype, 'add');
    const identityAddCount = (): number => add.mock.calls.filter(
      ([value]) => typeof value === 'string' && value.startsWith('https://'),
    ).length;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      expectCode(
        () => state.resolve(302, ASSET_API_URL),
        'REDIRECT_LOOP',
      );
    }
    expect(identityAddCount()).toBe(0);
    consumeRedirect(state, '/one');
    consumeRedirect(state, '/two');
    consumeRedirect(state, '/three');
    expect(identityAddCount()).toBe(3);
    expectCode(() => state.resolve(302, '/four'), 'REDIRECT_LIMIT');
    state.dispose();
  });

  it('uses normalized percent encoding only for loop identity', () => {
    const pathState = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    consumeRedirect(
      pathState,
      'https://objects.githubusercontent.com/%66ile',
    );
    expectCode(
      () => pathState.resolve(
        302,
        'https://objects.githubusercontent.com/file',
      ),
      'REDIRECT_LOOP',
    );
    pathState.dispose();

    const queryState = createProjectTemplateArtifactRedirectState(
      ASSET_API_URL,
    );
    consumeRedirect(
      queryState,
      'https://objects.githubusercontent.com/file?token=%61',
    );
    expectCode(
      () => queryState.resolve(
        302,
        'https://objects.githubusercontent.com/file?token=a',
      ),
      'REDIRECT_LOOP',
    );
    queryState.dispose();

    const reservedState = createProjectTemplateArtifactRedirectState(
      ASSET_API_URL,
    );
    consumeRedirect(
      reservedState,
      'https://objects.githubusercontent.com/folder%2fname?token=%2f',
    );
    expectCode(
      () => reservedState.resolve(
        302,
        'https://objects.githubusercontent.com/folder%2Fname?token=%2F',
      ),
      'REDIRECT_LOOP',
    );
    const distinct = reservedState.resolve(
      302,
      'https://objects.githubusercontent.com/folder/name?token=/',
    );
    distinct.dispose();
    reservedState.dispose();
  });

  it('resolves relative locations, advances only on consume, and rejects loops', () => {
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    const first = state.resolve(302, '/redirected');
    expectCode(
      () => state.resolve(302, '/other'),
      'INVALID_ARGUMENT',
    );
    const hop = first.consume();
    expectCode(() => first.consume(), 'INVALID_ARGUMENT');
    expectCode(() => state.resolve(307, ASSET_API_URL), 'REDIRECT_LOOP');
    hop.dispose();
    state.dispose();
  });

  it('disposal invalidates authority, clears weak maps, and is idempotent', () => {
    const weakMapDelete = vi.spyOn(WeakMap.prototype, 'delete');
    const state = createProjectTemplateArtifactRedirectState(ASSET_API_URL);
    const grant = state.resolve(
      302,
      'https://objects.githubusercontent.com/private/secret',
    );
    grant.dispose();
    grant.dispose();
    expectCode(() => grant.consume(), 'INVALID_ARGUMENT');

    const next = state.resolve(
      302,
      'https://objects.githubusercontent.com/private/next',
    );
    const hop = next.consume();
    state.dispose();
    state.dispose();
    expectCode(
      () => state.resolve(302, 'https://objects.githubusercontent.com/x'),
      'INVALID_ARGUMENT',
    );
    hop.dispose();
    hop.dispose();
    expect(weakMapDelete).toHaveBeenCalled();
  });
});

describe('project-template artifact DNS validation F2b-A', () => {
  it('accepts exact all-public IPv4 and IPv6 snapshots and returns no data', () => {
    expect(validateProjectTemplateArtifactDnsAnswers([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])).toBeUndefined();
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '100::1',
    '2001:2::1',
    '2001:db8::1',
    '2002::1',
    '3ffe::',
    '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '3fff::',
    '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fc00::1',
    'fe80::1',
    'ff00::1',
  ])('rejects non-public DNS address %s', (address) => {
    expectCode(
      () => validateProjectTemplateArtifactDnsAnswers([{
        address,
        family: address.includes(':') ? 6 : 4,
      }]),
      'DNS_REJECTED',
    );
  });

  it('keeps addresses just outside the added IPv6 ranges public', () => {
    expect(validateProjectTemplateArtifactDnsAnswers([
      {
        address: '3ffd:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        family: 6,
      },
      {
        address: '3fff:1000::',
        family: 6,
      },
    ])).toBeUndefined();
  });

  it('rejects mixed public/private answers', () => {
    expectCode(
      () => validateProjectTemplateArtifactDnsAnswers([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
      'DNS_REJECTED',
    );
  });

  it.each([
    [[]],
    [[{ address: '127.1', family: 4 }]],
    [[{ address: '01.2.3.4', family: 4 }]],
    [[{ address: 'fe80::1%lo0', family: 6 }]],
  ])('rejects empty or non-canonical DNS answers %#', (answers) => {
    expectCode(
      () => validateProjectTemplateArtifactDnsAnswers(answers),
      'DNS_REJECTED',
    );
  });

  it.each([
    [[{ address: '8.8.8.8', family: 6 }]],
    [[{ address: '8.8.8.8', family: 'IPv4' }]],
    [[{ address: '8.8.8.8', family: 4, extra: true }]],
    [[Object.defineProperty({}, 'address', { get: () => '8.8.8.8' })]],
    [new Proxy([{ address: '8.8.8.8', family: 4 }], {
      ownKeys: () => { throw new Error('secret trap'); },
    })],
    [[new Proxy({ address: '8.8.8.8', family: 4 }, {
      get: () => { throw new Error('secret trap'); },
    })]],
  ])('rejects hostile or non-exact DNS snapshot %#', (answers) => {
    expectCode(
      () => validateProjectTemplateArtifactDnsAnswers(answers as never),
      'INVALID_ARGUMENT',
    );
  });
});
