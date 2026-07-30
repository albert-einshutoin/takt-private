import { lookup as dnsLookup } from 'node:dns';
import { EventEmitter } from 'node:events';
import {
  request as httpsRequest,
  type RequestOptions,
} from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { types } from 'node:util';

const MAX_LOCATION_LENGTH = 8_192;
const MAX_DNS_ANSWERS = 64;
const MAX_IPV4_ADDRESS_LENGTH = 15;
const MAX_IPV6_ADDRESS_LENGTH = 45;
const MAX_REDIRECTS = 3;
const MAX_ASSET_ID = BigInt(Number.MAX_SAFE_INTEGER);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_HOSTS = new Set([
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const ASSET_API_PATH =
  /^\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/([1-9][0-9]*)$/;
const OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export type ProjectTemplateArtifactRedirectErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_REDIRECT'
  | 'REDIRECT_FORBIDDEN'
  | 'REDIRECT_LOOP'
  | 'REDIRECT_LIMIT'
  | 'DNS_REJECTED';

export class ProjectTemplateArtifactRedirectError extends Error {
  constructor(
    public readonly code: ProjectTemplateArtifactRedirectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectTemplateArtifactRedirectError';
  }
}

declare const ARTIFACT_REDIRECT_HOP_BRAND: unique symbol;

export interface DisposableProjectTemplateArtifactRedirectHop {
  readonly [ARTIFACT_REDIRECT_HOP_BRAND]: never;
  dispose(): void;
}

export interface DisposableProjectTemplateArtifactRedirectGrant {
  consume(): DisposableProjectTemplateArtifactRedirectHop;
  dispose(): void;
}

export interface DisposableProjectTemplateArtifactRedirectState {
  resolve(
    statusCode: number,
    location: string,
  ): DisposableProjectTemplateArtifactRedirectGrant;
  dispose(): void;
}

interface RedirectStateAuthority {
  currentUrl: URL | undefined;
  visited: Set<string> | undefined;
  pendingGrant: DisposableProjectTemplateArtifactRedirectGrant | undefined;
  children: Set<object> | undefined;
  redirectCount: number | undefined;
}

interface RedirectGrantAuthority {
  owner: DisposableProjectTemplateArtifactRedirectState | undefined;
  targetUrl: URL | undefined;
  identity: string | undefined;
}

interface RedirectHopAuthority {
  state: DisposableProjectTemplateArtifactRedirectState | undefined;
  owner: RedirectStateAuthority | undefined;
  targetUrl: URL | undefined;
}

interface ProjectTemplateArtifactDnsAnswerSnapshot {
  readonly address: string;
  readonly family: 4 | 6;
  readonly bytes: readonly number[];
}

interface IpCidr {
  readonly prefix: readonly number[];
  readonly prefixLength: number;
}

// Versioned snapshot of ALLOCATED RIR prefixes from:
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.xhtml
// Last Updated: 2025-10-10.
//
// IANA reserves every unlisted part of 2000::/3 for future allocation. Keeping
// a dated allow-table prevents a registry change from silently widening this
// SSRF boundary; update this table and its first/last/neighbor tests together.
// The partially allocated 2001::/23 and special-purpose 2002::/16 are
// intentionally absent.
const IANA_ALLOCATED_IPV6_CIDRS = Object.freeze(([
  ['2001:200::', 23],
  ['2001:400::', 23],
  ['2001:600::', 23],
  ['2001:800::', 22],
  ['2001:c00::', 23],
  ['2001:e00::', 23],
  ['2001:1200::', 23],
  ['2001:1400::', 22],
  ['2001:1800::', 23],
  ['2001:1a00::', 23],
  ['2001:1c00::', 22],
  ['2001:2000::', 19],
  ['2001:4000::', 23],
  ['2001:4200::', 23],
  ['2001:4400::', 23],
  ['2001:4600::', 23],
  ['2001:4800::', 23],
  ['2001:4a00::', 23],
  ['2001:4c00::', 23],
  ['2001:5000::', 20],
  ['2001:8000::', 19],
  ['2001:a000::', 20],
  ['2001:b000::', 20],
  ['2003::', 18],
  ['2400::', 12],
  ['2410::', 12],
  ['2600::', 12],
  ['2610::', 23],
  ['2620::', 23],
  ['2630::', 12],
  ['2800::', 12],
  ['2a00::', 12],
  ['2a10::', 12],
  ['2c00::', 12],
] as const satisfies readonly (readonly [string, number])[]).map(
  ([address, prefixLength]) => createIpCidr(address, prefixLength),
));

const stateAuthorities = new WeakMap<
DisposableProjectTemplateArtifactRedirectState,
RedirectStateAuthority
>();
const grantAuthorities = new WeakMap<
DisposableProjectTemplateArtifactRedirectGrant,
RedirectGrantAuthority
>();
const hopAuthorities = new WeakMap<
DisposableProjectTemplateArtifactRedirectHop,
RedirectHopAuthority
>();
const stateFacades = new WeakSet<object>();
const grantFacades = new WeakSet<object>();
const hopFacades = new WeakSet<object>();

function redirectError(
  code: ProjectTemplateArtifactRedirectErrorCode,
): ProjectTemplateArtifactRedirectError {
  const messages: Record<ProjectTemplateArtifactRedirectErrorCode, string> = {
    INVALID_ARGUMENT: 'Artifact redirect input is invalid',
    INVALID_REDIRECT: 'Artifact redirect response is invalid',
    REDIRECT_FORBIDDEN: 'Artifact redirect target is forbidden',
    REDIRECT_LOOP: 'Artifact redirect loop was rejected',
    REDIRECT_LIMIT: 'Artifact redirect limit was exceeded',
    DNS_REJECTED: 'Artifact redirect DNS answers were rejected',
  };
  return Object.freeze(
    new ProjectTemplateArtifactRedirectError(code, messages[code]),
  );
}

function invalidArgument(): ProjectTemplateArtifactRedirectError {
  return redirectError('INVALID_ARGUMENT');
}

function invalidRedirect(): ProjectTemplateArtifactRedirectError {
  return redirectError('INVALID_REDIRECT');
}

function forbiddenRedirect(): ProjectTemplateArtifactRedirectError {
  return redirectError('REDIRECT_FORBIDDEN');
}

function isRawLocationSafe(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_LOCATION_LENGTH
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x5c) return false;
  }
  return true;
}

function locationHasForbiddenRawAuthority(location: string): boolean {
  const match =
    /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]*)/.exec(location);
  if (match === null) return false;
  const authority = match[1]!;
  if (authority.includes('@')) return true;
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostAndPort.startsWith('[')) return true;
  const host = hostAndPort.split(':', 1)[0]!;
  return host !== host.toLowerCase() || !/^[a-z0-9.-]+$/.test(host);
}

function parseAllowedRedirectTarget(base: URL, location: unknown): URL {
  if (!isRawLocationSafe(location)) throw invalidRedirect();
  if (
    location.includes('#')
    || locationHasForbiddenRawAuthority(location)
  ) {
    throw forbiddenRedirect();
  }

  let target: URL;
  try {
    target = new URL(location, base);
  } catch {
    throw invalidRedirect();
  }
  const hostname = target.hostname;
  const unbracketedHostname = hostname.startsWith('[')
    ? hostname.slice(1, -1)
    : hostname;
  if (
    target.protocol !== 'https:'
    || (target.port !== '' && target.port !== '443')
    || target.username !== ''
    || target.password !== ''
    || target.hash !== ''
    || hostname.endsWith('.')
    || hostname !== hostname.toLowerCase()
    || !/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith('[')
    || isIP(unbracketedHostname) !== 0
    || !REDIRECT_HOSTS.has(hostname)
  ) {
    throw forbiddenRedirect();
  }
  return target;
}

function parseCanonicalAssetApiUrl(value: unknown): URL {
  if (!isRawLocationSafe(value)) throw invalidArgument();
  if (value.includes('?') || value.includes('#')) throw invalidArgument();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidArgument();
  }
  const pathMatch = ASSET_API_PATH.exec(parsed.pathname);
  // The first request carries GitHub API authorization. Keeping this entry
  // point narrower than the redirect allowlist prevents future callers from
  // accidentally starting an authenticated request at an asset CDN.
  if (
    parsed.href !== value
    || parsed.protocol !== 'https:'
    || parsed.hostname !== 'api.github.com'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || pathMatch === null
  ) {
    throw invalidArgument();
  }
  const owner = pathMatch[1]!;
  const repo = pathMatch[2]!;
  const assetId = pathMatch[3]!;
  // Keep this transport boundary aligned with github-source-spec grammar so a
  // URL cannot bypass the portable repository-coordinate contract.
  if (
    !OWNER_PATTERN.test(owner)
    || owner.includes('--')
    || !REPOSITORY_PATTERN.test(repo)
    || repo === '.'
    || repo === '..'
    || repo.toLowerCase().endsWith('.git')
  ) {
    throw invalidArgument();
  }
  try {
    if (BigInt(assetId) > MAX_ASSET_ID) throw invalidArgument();
  } catch (error) {
    if (error instanceof ProjectTemplateArtifactRedirectError) throw error;
    throw invalidArgument();
  }
  return parsed;
}

function canonicalRedirectIdentity(target: URL): string {
  // Identity normalization is deliberately separate from targetUrl. Signed
  // GitHub asset URLs must be requested byte-for-byte as WHATWG serialized
  // them; only loop comparison decodes RFC 3986 unreserved escapes.
  return target.href.replace(/%([0-9A-Fa-f]{2})/g, (_match, rawHex: string) => {
    const code = Number.parseInt(rawHex, 16);
    const character = String.fromCharCode(code);
    return /^[A-Za-z0-9._~-]$/.test(character)
      ? character
      : `%${rawHex.toUpperCase()}`;
  });
}

function disposeGrantAuthority(
  grant: DisposableProjectTemplateArtifactRedirectGrant,
): void {
  const authority = grantAuthorities.get(grant);
  if (authority === undefined) return;
  const owner = authority.owner;
  authority.owner = undefined;
  authority.targetUrl = undefined;
  authority.identity = undefined;
  grantAuthorities.delete(grant);
  const ownerAuthority = owner === undefined
    ? undefined
    : stateAuthorities.get(owner);
  if (ownerAuthority?.pendingGrant === grant) {
    ownerAuthority.pendingGrant = undefined;
  }
  ownerAuthority?.children?.delete(grant);
}

function disposeHopAuthority(
  hop: DisposableProjectTemplateArtifactRedirectHop,
): void {
  const authority = hopAuthorities.get(hop);
  if (authority === undefined) return;
  authority.owner?.children?.delete(hop);
  authority.state = undefined;
  authority.owner = undefined;
  authority.targetUrl = undefined;
  hopAuthorities.delete(hop);
}

function createRedirectHop(
  state: DisposableProjectTemplateArtifactRedirectState,
  ownerAuthority: RedirectStateAuthority,
  targetUrl: URL,
): DisposableProjectTemplateArtifactRedirectHop {
  const hop = Object.freeze({
    dispose(this: DisposableProjectTemplateArtifactRedirectHop): void {
      if (!hopFacades.has(this)) throw invalidArgument();
      disposeHopAuthority(this);
    },
  }) as DisposableProjectTemplateArtifactRedirectHop;
  hopFacades.add(hop);
  hopAuthorities.set(hop, {
    state,
    owner: ownerAuthority,
    targetUrl,
  });
  ownerAuthority.children?.add(hop);
  return hop;
}

function createRedirectGrant(
  owner: DisposableProjectTemplateArtifactRedirectState,
  ownerAuthority: RedirectStateAuthority,
  targetUrl: URL,
  identity: string,
): DisposableProjectTemplateArtifactRedirectGrant {
  const grant = Object.freeze<DisposableProjectTemplateArtifactRedirectGrant>({
    consume(this: DisposableProjectTemplateArtifactRedirectGrant):
    DisposableProjectTemplateArtifactRedirectHop {
      const authority = grantAuthorities.get(this);
      if (
        authority === undefined
        || authority.owner === undefined
        || authority.targetUrl === undefined
        || authority.identity === undefined
      ) {
        throw invalidArgument();
      }
      const stateAuthority = stateAuthorities.get(authority.owner);
      if (
        stateAuthority === undefined
        || stateAuthority.pendingGrant !== this
        || stateAuthority.visited === undefined
        || stateAuthority.redirectCount === undefined
      ) {
        disposeGrantAuthority(this);
        throw invalidArgument();
      }
      const consumedTarget = authority.targetUrl;
      const consumedIdentity = authority.identity;
      stateAuthority.currentUrl = consumedTarget;
      stateAuthority.visited.add(consumedIdentity);
      stateAuthority.redirectCount += 1;
      const state = authority.owner;
      disposeGrantAuthority(this);
      return createRedirectHop(state, stateAuthority, consumedTarget);
    },
    dispose(this: DisposableProjectTemplateArtifactRedirectGrant): void {
      if (!grantFacades.has(this)) throw invalidArgument();
      disposeGrantAuthority(this);
    },
  });
  grantFacades.add(grant);
  grantAuthorities.set(grant, { owner, targetUrl, identity });
  ownerAuthority.pendingGrant = grant;
  ownerAuthority.children?.add(grant);
  return grant;
}

export function createProjectTemplateArtifactRedirectState(
  baseCanonicalUrl: string,
): DisposableProjectTemplateArtifactRedirectState {
  const base = parseCanonicalAssetApiUrl(baseCanonicalUrl);
  const state = Object.freeze<DisposableProjectTemplateArtifactRedirectState>({
    resolve(
      this: DisposableProjectTemplateArtifactRedirectState,
      statusCode: number,
      location: string,
    ): DisposableProjectTemplateArtifactRedirectGrant {
      const authority = stateAuthorities.get(this);
      if (
        authority === undefined
        || authority.currentUrl === undefined
        || authority.visited === undefined
        || authority.redirectCount === undefined
        || authority.pendingGrant !== undefined
      ) {
        throw invalidArgument();
      }
      if (
        typeof statusCode !== 'number'
        || !Number.isSafeInteger(statusCode)
        || !REDIRECT_STATUSES.has(statusCode)
      ) {
        throw invalidRedirect();
      }
      const target = parseAllowedRedirectTarget(
        authority.currentUrl,
        location,
      );
      const identity = canonicalRedirectIdentity(target);
      if (authority.visited.has(identity)) {
        throw redirectError('REDIRECT_LOOP');
      }
      if (authority.redirectCount >= MAX_REDIRECTS) {
        throw redirectError('REDIRECT_LIMIT');
      }
      return createRedirectGrant(this, authority, target, identity);
    },
    dispose(this: DisposableProjectTemplateArtifactRedirectState): void {
      if (!stateFacades.has(this)) throw invalidArgument();
      const authority = stateAuthorities.get(this);
      if (authority === undefined) return;
      for (const child of authority.children ?? []) {
        if (grantFacades.has(child)) {
          disposeGrantAuthority(
            child as DisposableProjectTemplateArtifactRedirectGrant,
          );
        } else if (hopFacades.has(child)) {
          disposeHopAuthority(
            child as DisposableProjectTemplateArtifactRedirectHop,
          );
        }
      }
      authority.children?.clear();
      authority.visited?.clear();
      authority.currentUrl = undefined;
      authority.visited = undefined;
      authority.pendingGrant = undefined;
      authority.children = undefined;
      authority.redirectCount = undefined;
      stateAuthorities.delete(this);
    },
  });
  stateFacades.add(state);
  stateAuthorities.set(state, {
    currentUrl: base,
    visited: new Set([canonicalRedirectIdentity(base)]),
    pendingGrant: undefined,
    children: new Set(),
    redirectCount: 0,
  });
  return state;
}

function exactDnsAnswerRecord(value: unknown): {
  address: unknown;
  family: unknown;
} {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidArgument();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2
    || !keys.includes('address')
    || !keys.includes('family')
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const address = descriptors['address'];
  const family = descriptors['family'];
  if (
    address === undefined
    || family === undefined
    || !('value' in address)
    || !('value' in family)
  ) {
    throw invalidArgument();
  }
  return { address: address.value, family: family.value };
}

function parseCanonicalIpv4(address: string): readonly number[] | undefined {
  if (!/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    return undefined;
  }
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets;
}

function parseIpv6(address: string): readonly number[] | undefined {
  if (
    address.includes('%')
    || address.length === 0
    || address.split('::').length > 2
  ) {
    return undefined;
  }
  const halves = address.split('::');
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length === 1 || halves[1] === ''
    ? []
    : halves[1]!.split(':');
  const groups = [...left, ...right];
  const expanded: number[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    if (group.includes('.')) {
      if (index !== groups.length - 1) return undefined;
      const ipv4 = parseCanonicalIpv4(group);
      if (ipv4 === undefined) return undefined;
      expanded.push((ipv4[0]! << 8) | ipv4[1]!);
      expanded.push((ipv4[2]! << 8) | ipv4[3]!);
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return undefined;
      expanded.push(Number.parseInt(group, 16));
    }
  }
  if (halves.length === 1) {
    if (expanded.length !== 8) return undefined;
  } else {
    const missing = 8 - expanded.length;
    if (missing < 1) return undefined;
    expanded.splice(left.length, 0, ...new Array<number>(missing).fill(0));
  }
  if (expanded.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const group of expanded) {
    bytes.push(group >>> 8, group & 0xff);
  }
  return bytes;
}

function createIpCidr(address: string, prefixLength: number): IpCidr {
  const prefix = parseIpv6(address);
  if (
    prefix === undefined
    || !Number.isSafeInteger(prefixLength)
    || prefixLength < 0
    || prefixLength > prefix.length * 8
  ) {
    throw invalidArgument();
  }
  return Object.freeze({
    prefix: Object.freeze([...prefix]),
    prefixLength,
  });
}

function matchesCidr(
  address: readonly number[],
  cidr: IpCidr,
): boolean {
  if (
    address.length !== cidr.prefix.length
    || cidr.prefixLength < 0
    || cidr.prefixLength > address.length * 8
  ) {
    return false;
  }
  const completeBytes = Math.floor(cidr.prefixLength / 8);
  for (let index = 0; index < completeBytes; index += 1) {
    if (address[index] !== cidr.prefix[index]) return false;
  }
  const remainingBits = cidr.prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (
    (address[completeBytes]! & mask)
    === (cidr.prefix[completeBytes]! & mask)
  );
}

function isPublicIpv4(bytes: readonly number[]): boolean {
  const [a, b] = bytes;
  if (a === undefined || b === undefined) return false;
  return !(
    a === 0
    || a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 88 && bytes[2] === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && bytes[2] === 100)
    || (a === 203 && b === 0 && bytes[2] === 113)
    || a >= 224
  );
}

function isPublicIpv6(bytes: readonly number[]): boolean {
  if (bytes.length !== 16) return false;
  if (!IANA_ALLOCATED_IPV6_CIDRS.some(
    (cidr) => matchesCidr(bytes, cidr),
  )) {
    return false;
  }
  const first = (bytes[0]! << 8) | bytes[1]!;
  const second = (bytes[2]! << 8) | bytes[3]!;
  const third = (bytes[4]! << 8) | bytes[5]!;
  // An ALLOCATED parent can still contain non-routable special-purpose child
  // ranges (for example 2001:db8::/32 inside 2001:c00::/23). Public therefore
  // means allocated AND not special-purpose, never merely table membership.
  if (
    first === 0x2002
    || first === 0x3ffe
    || (first === 0x3fff && (second & 0xf000) === 0)
    || (
      first === 0x2001
      && (
        second === 0x0000
        || (second === 0x0002 && third === 0)
        || (second & 0xfff0) === 0x0010
        || (second & 0xfff0) === 0x0020
        || second === 0x0db8
      )
    )
  ) {
    return false;
  }
  return true;
}

function snapshotPublicDnsAnswers(
  value: unknown,
): readonly ProjectTemplateArtifactDnsAnswerSnapshot[] {
  if (
    !Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw invalidArgument();
  }
  const keys = Reflect.ownKeys(value);
  if (
    value.length > MAX_DNS_ANSWERS
    || keys.length !== value.length + 1
    || keys[keys.length - 1] !== 'length'
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshots: ProjectTemplateArtifactDnsAnswerSnapshot[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw invalidArgument();
    }
    const record = exactDnsAnswerRecord(descriptor.value);
    if (
      typeof record.address !== 'string'
      || (record.family !== 4 && record.family !== 6)
    ) {
      throw invalidArgument();
    }
    // Canonical IPv4/IPv6 text cannot exceed these RFC representation bounds.
    // Reject by length before native or string parsing so hostile DNS adapters
    // cannot turn one answer into unbounded validation work.
    const maximumAddressLength = record.family === 4
      ? MAX_IPV4_ADDRESS_LENGTH
      : MAX_IPV6_ADDRESS_LENGTH;
    if (
      record.address.length === 0
      || record.address.length > maximumAddressLength
    ) {
      throw redirectError('DNS_REJECTED');
    }
    const detectedFamily = isIP(record.address);
    if (detectedFamily !== 0 && detectedFamily !== record.family) {
      throw invalidArgument();
    }
    const bytes = record.family === 4
      ? parseCanonicalIpv4(record.address)
      : parseIpv6(record.address);
    if (
      bytes === undefined
      || detectedFamily !== record.family
      || (
        record.family === 4
          ? !isPublicIpv4(bytes)
          : !isPublicIpv6(bytes)
      )
    ) {
      throw redirectError('DNS_REJECTED');
    }
    snapshots.push(Object.freeze({
      address: record.address,
      family: record.family,
      bytes: Object.freeze([...bytes]),
    }));
  }
  if (snapshots.length === 0) throw redirectError('DNS_REJECTED');
  // The private immutable snapshot is intentionally ready for the next slice
  // to pin socket selection to the addresses that passed this validation.
  return Object.freeze(snapshots);
}

export function validateProjectTemplateArtifactDnsAnswers(
  value: unknown,
): void {
  snapshotPublicDnsAnswers(value);
}

export interface ProjectTemplateArtifactPinnedTransportHandlers {
  readonly onDnsRejected: () => void;
  readonly onResponse: (statusCode: number) => void;
  readonly onInvalidResponse: () => void;
  readonly onData: (chunk: unknown) => void;
  readonly onEnd: () => void;
  readonly onResponseAborted: () => void;
  readonly onResponseError: () => void;
  readonly onResponseClose: () => void;
  readonly onRequestError: () => void;
  readonly onRequestClose: () => void;
}

export interface ProjectTemplateArtifactPinnedTransport {
  start(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  dispose(): void;
}

interface PinnedTransportAuthority {
  state?: DisposableProjectTemplateArtifactRedirectState;
  targetUrl?: URL;
  dnsSnapshot?: readonly ProjectTemplateArtifactDnsAnswerSnapshot[];
  request?: ClientRequest;
  requestDestroy?: (...args: unknown[]) => unknown;
  requestEnd?: (...args: unknown[]) => unknown;
  requestListeners: ReadonlyArray<
    readonly [event: string, listener: (...args: unknown[]) => void]
  >;
  started: boolean;
  dnsSettled: boolean;
  terminal: boolean;
  disposed: boolean;
  release: () => void;
}

const pinnedTransportAuthorities = new WeakMap<
  object,
  PinnedTransportAuthority
>();
const pinnedTransportFacades = new WeakSet<object>();

function exactPinnedHandlers(
  value: unknown,
): Record<
  keyof ProjectTemplateArtifactPinnedTransportHandlers,
  (...args: unknown[]) => unknown
> {
  const names = [
    'onDnsRejected',
    'onResponse',
    'onInvalidResponse',
    'onData',
    'onEnd',
    'onResponseAborted',
    'onResponseError',
    'onResponseClose',
    'onRequestError',
    'onRequestClose',
  ] as const;
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidArgument();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length
    || names.some((name) => !keys.includes(name))
  ) {
    throw invalidArgument();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {} as Record<
    keyof ProjectTemplateArtifactPinnedTransportHandlers,
    (...args: unknown[]) => unknown
  >;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (
      descriptor === undefined
      || !('value' in descriptor)
      || typeof descriptor.value !== 'function'
      || types.isProxy(descriptor.value)
    ) {
      throw invalidArgument();
    }
    result[name] = descriptor.value;
  }
  return result;
}

function findPinnedMethod(
  value: object,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      return 'value' in descriptor && typeof descriptor.value === 'function'
        ? descriptor.value as (...args: unknown[]) => unknown
        : undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/**
 * Creates the unauthenticated transport for a validated redirect hop.
 *
 * This factory deliberately lives beside the private hop and DNS authorities:
 * neither the signed URL nor validated addresses can cross a public seam, and
 * no credential-shaped value can satisfy the nominal hop capability.
 */
export function createProjectTemplateArtifactPinnedTransport(
  initialHop: DisposableProjectTemplateArtifactRedirectHop,
  handlersValue: ProjectTemplateArtifactPinnedTransportHandlers,
): ProjectTemplateArtifactPinnedTransport {
  const handlers = exactPinnedHandlers(handlersValue);
  const handlerReceiver = handlersValue;
  const hopAuthority = (
    typeof initialHop === 'object'
    && initialHop !== null
    && !types.isProxy(initialHop)
  )
    ? hopAuthorities.get(initialHop)
    : undefined;
  if (
    hopAuthority === undefined
    || hopAuthority.state === undefined
    || hopAuthority.owner === undefined
    || hopAuthority.targetUrl === undefined
    || !stateAuthorities.has(hopAuthority.state)
  ) {
    throw invalidArgument();
  }

  // Move all authority before constructing the facade. A copied method,
  // forged object, or second factory call can no longer recover this hop.
  const state = hopAuthority.state;
  const targetUrl = hopAuthority.targetUrl;
  hopAuthority.owner.children?.delete(initialHop);
  hopAuthority.state = undefined;
  hopAuthority.owner = undefined;
  hopAuthority.targetUrl = undefined;
  hopAuthorities.delete(initialHop);

  const holder: { current?: PinnedTransportAuthority } = {};
  const invoke = (
    name: keyof ProjectTemplateArtifactPinnedTransportHandlers,
    args: readonly unknown[] = [],
  ): boolean => {
    try {
      Reflect.apply(handlers[name], handlerReceiver, args);
      return true;
    } catch {
      return false;
    }
  };
  const removeRequestListeners = (
    request: ClientRequest | undefined,
    listeners: PinnedTransportAuthority['requestListeners'],
  ): void => {
    if (request === undefined) return;
    for (const [event, listener] of listeners) {
      try {
        EventEmitter.prototype.removeListener.call(
          request,
          event,
          listener,
        );
      } catch {
        // Detached terminal ownership remains authoritative.
      }
    }
  };
  const destroyRequest = (
    request: ClientRequest | undefined,
    destroy: ((...args: unknown[]) => unknown) | undefined,
  ): void => {
    if (request === undefined || destroy === undefined) return;
    try {
      Reflect.apply(destroy, request, []);
    } catch {
      // Public handlers receive no transport cause.
    }
  };
  const terminate = (
    authority: PinnedTransportAuthority,
    notification?: keyof ProjectTemplateArtifactPinnedTransportHandlers,
  ): void => {
    if (authority.terminal || authority.disposed) return;
    authority.terminal = true;
    authority.release();
    const ownedState = authority.state;
    const request = authority.request;
    const requestDestroy = authority.requestDestroy;
    const listeners = authority.requestListeners;
    authority.state = undefined;
    authority.targetUrl = undefined;
    authority.dnsSnapshot = undefined;
    authority.request = undefined;
    authority.requestDestroy = undefined;
    authority.requestEnd = undefined;
    authority.requestListeners = [];
    removeRequestListeners(request, listeners);
    try {
      ownedState?.dispose();
    } catch {
      // Terminal capability deletion remains authoritative.
    }
    destroyRequest(request, requestDestroy);
    if (notification !== undefined && !authority.disposed) {
      invoke(notification);
    }
  };
  const containedResponses = new WeakSet<object>();
  const responseQueue: IncomingMessage[] = [];
  let drainingResponses = false;
  const containResponse = (response: IncomingMessage): void => {
    if (
      typeof response !== 'object'
      || response === null
      || containedResponses.has(response)
    ) {
      return;
    }
    containedResponses.add(response);
    responseQueue.push(response);
    if (drainingResponses) return;
    drainingResponses = true;
    let cursor = 0;
    try {
      while (cursor < responseQueue.length) {
        const candidate = responseQueue[cursor];
        cursor += 1;
        if (candidate === undefined) continue;
        const destroy = findPinnedMethod(candidate, 'destroy');
        if (destroy === undefined) continue;
        try {
          Reflect.apply(destroy, candidate, []);
        } catch {
          // Invalid response details never reach a handler or error.
        }
      }
    } finally {
      responseQueue.length = 0;
      drainingResponses = false;
    }
  };
  const authority: PinnedTransportAuthority = {
    state,
    targetUrl,
    requestListeners: [],
    started: false,
    dnsSettled: false,
    terminal: false,
    disposed: false,
    release: () => {
      holder.current = undefined;
    },
  };
  holder.current = authority;

  const startRequest = (
    current: PinnedTransportAuthority,
  ): void => {
    const url = current.targetUrl;
    if (url === undefined || current.terminal || current.disposed) return;
    const hostname = url.hostname;
    const pinnedLookup: NonNullable<RequestOptions['lookup']> = (
      requestedHostname,
      options,
      callback,
    ) => {
      const snapshot = current.dnsSnapshot;
      const family = options.family ?? 0;
      const all = options.all ?? false;
      if (
        current.terminal
        || current.disposed
        || snapshot === undefined
        || requestedHostname !== hostname
        || (family !== 0 && family !== 4 && family !== 6)
        || typeof all !== 'boolean'
      ) {
        Reflect.apply(callback, undefined, [invalidArgument()]);
        return;
      }
      const matches = snapshot.filter(
        (answer) => family === 0 || answer.family === family,
      );
      if (matches.length === 0) {
        Reflect.apply(callback, undefined, [invalidArgument()]);
        return;
      }
      if (all) {
        Reflect.apply(callback, undefined, [
          null,
          matches.map((answer) => ({
            address: answer.address,
            family: answer.family,
          })),
        ]);
      } else {
        const selected = matches[0]!;
        Reflect.apply(callback, undefined, [
          null,
          selected.address,
          selected.family,
        ]);
      }
    };
    let request: ClientRequest;
    try {
      request = httpsRequest({
        agent: false,
        protocol: 'https:',
        hostname,
        servername: hostname,
        port: 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          Host: hostname,
          'User-Agent': 'takt-project-template',
        },
        lookup: pinnedLookup,
      }, (response) => {
        const active = holder.current;
        if (active === undefined) {
          containResponse(response);
          return;
        }
        // Claim and detach all authority before response.destroy(), which is
        // event-capable and may synchronously invoke this callback again.
        terminate(active);
        containResponse(response);
        if (!active.disposed) invoke('onInvalidResponse');
      });
    } catch {
      terminate(current, 'onInvalidResponse');
      return;
    }
    const requestDestroy = findPinnedMethod(request, 'destroy');
    const requestEnd = findPinnedMethod(request, 'end');
    if (
      current.terminal
      || current.disposed
      || holder.current !== current
      || requestDestroy === undefined
      || requestEnd === undefined
    ) {
      destroyRequest(request, requestDestroy);
      if (!current.terminal && !current.disposed) {
        terminate(current, 'onInvalidResponse');
      }
      return;
    }
    current.request = request;
    current.requestDestroy = requestDestroy;
    current.requestEnd = requestEnd;
    const listeners: PinnedTransportAuthority['requestListeners'] = [
      ['error', () => {
        if (!current.terminal && !current.disposed) {
          invoke('onRequestError');
          terminate(current);
        }
      }],
      ['close', () => {
        if (!current.terminal && !current.disposed) {
          invoke('onRequestClose');
        }
      }],
    ];
    current.requestListeners = listeners;
    try {
      for (const [event, listener] of listeners) {
        EventEmitter.prototype.on.call(request, event, listener);
        if (current.terminal || current.disposed) {
          try {
            EventEmitter.prototype.removeListener.call(
              request,
              event,
              listener,
            );
          } catch {
            // Terminal request ownership is already detached.
          }
          removeRequestListeners(request, listeners);
          return;
        }
      }
      Reflect.apply(requestEnd, request, []);
    } catch {
      terminate(current, 'onInvalidResponse');
    }
  };

  const facade = Object.freeze<ProjectTemplateArtifactPinnedTransport>({
    start(this: ProjectTemplateArtifactPinnedTransport): void {
      const current = pinnedTransportAuthorities.get(this);
      if (current === undefined || current.disposed || current.terminal) {
        throw invalidArgument();
      }
      if (current.started) return;
      current.started = true;
      const url = current.targetUrl;
      if (url === undefined) {
        terminate(current, 'onDnsRejected');
        return;
      }
      try {
        dnsLookup(
          url.hostname,
          { all: true, verbatim: true },
          (error, answers) => {
            if (
              current.dnsSettled
              || current.terminal
              || current.disposed
              || holder.current !== current
            ) {
              return;
            }
            current.dnsSettled = true;
            if (error !== null) {
              terminate(current, 'onDnsRejected');
              return;
            }
            let snapshot:
              readonly ProjectTemplateArtifactDnsAnswerSnapshot[];
            try {
              snapshot = snapshotPublicDnsAnswers(answers);
            } catch {
              terminate(current, 'onDnsRejected');
              return;
            }
            current.dnsSnapshot = snapshot;
            startRequest(current);
          },
        );
      } catch {
        terminate(current, 'onDnsRejected');
      }
    },
    pause(this: ProjectTemplateArtifactPinnedTransport): void {
      if (!pinnedTransportAuthorities.has(this)) throw invalidArgument();
      throw invalidArgument();
    },
    resume(this: ProjectTemplateArtifactPinnedTransport): void {
      if (!pinnedTransportAuthorities.has(this)) throw invalidArgument();
      throw invalidArgument();
    },
    destroy(this: ProjectTemplateArtifactPinnedTransport): void {
      const current = pinnedTransportAuthorities.get(this);
      if (current === undefined || current.disposed) throw invalidArgument();
      terminate(current);
    },
    dispose(this: ProjectTemplateArtifactPinnedTransport): void {
      if (!pinnedTransportFacades.has(this)) throw invalidArgument();
      const current = pinnedTransportAuthorities.get(this);
      if (current === undefined || current.disposed) return;
      current.disposed = true;
      current.release();
      const ownedState = current.state;
      const request = current.request;
      const requestDestroy = current.requestDestroy;
      const listeners = current.requestListeners;
      current.state = undefined;
      current.targetUrl = undefined;
      current.dnsSnapshot = undefined;
      current.request = undefined;
      current.requestDestroy = undefined;
      current.requestEnd = undefined;
      current.requestListeners = [];
      pinnedTransportAuthorities.delete(this);
      removeRequestListeners(request, listeners);
      try {
        ownedState?.dispose();
      } catch {
        // Explicit disposal is authoritative.
      }
      destroyRequest(request, requestDestroy);
    },
  });
  pinnedTransportFacades.add(facade);
  pinnedTransportAuthorities.set(facade, authority);
  return facade;
}
