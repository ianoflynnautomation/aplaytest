import { describe, expect, it } from 'vitest';

import {
  HistoryUrlError,
  describeHistoryTarget,
  parseHistoryUrl,
} from '../src/history/url.js';

describe('parseHistoryUrl', () => {
  it('treats :memory: and the empty string as throwaway', () => {
    expect(parseHistoryUrl(':memory:').kind).toBe('memory');
    expect(parseHistoryUrl('').kind).toBe('memory');
  });

  /**
   * `--db` has always taken a path and must keep doing so. A Windows path
   * parses as a URL with scheme `c:`, so "reject unrecognised schemes" would
   * break the case the flag was built for.
   */
  it('treats anything unrecognised as a file path, including Windows paths', () => {
    expect(parseHistoryUrl('.atest/history.sqlite')).toEqual({
      kind: 'sqlite',
      path: '.atest/history.sqlite',
    });
    expect(parseHistoryUrl('C:\\atest\\history.sqlite')).toEqual({
      kind: 'sqlite',
      path: 'C:\\atest\\history.sqlite',
    });
  });

  it('expands the azblob shorthand to a blob endpoint', () => {
    expect(parseHistoryUrl('azblob://bjjeireatest/atest-history')).toEqual({
      kind: 'azure-blob',
      serviceUrl: 'https://bjjeireatest.blob.core.windows.net',
      account: 'bjjeireatest',
      container: 'atest-history',
      prefix: '',
      windowDays: null,
      readOnly: false,
    });
  });

  it('normalises a multi-segment prefix to end with a slash', () => {
    const target = parseHistoryUrl('azblob://acct/atest-history/bjjeire/java');
    expect(target).toMatchObject({ prefix: 'bjjeire/java/' });
  });

  /** Sovereign clouds have different suffixes; hard coding one resolves nowhere. */
  it('honours a non-commercial endpoint suffix', () => {
    const target = parseHistoryUrl('azblob://acct/hist', {
      endpointSuffix: 'blob.core.usgovcloudapi.net',
    });
    expect(target).toMatchObject({ serviceUrl: 'https://acct.blob.core.usgovcloudapi.net' });
  });

  it('accepts a fully qualified blob URL and takes the account from the subdomain', () => {
    const target = parseHistoryUrl('https://bjjeireatest.blob.core.windows.net/atest-history/x');
    expect(target).toMatchObject({
      kind: 'azure-blob',
      account: 'bjjeireatest',
      container: 'atest-history',
      prefix: 'x/',
      serviceUrl: 'https://bjjeireatest.blob.core.windows.net',
    });
  });

  /** Azurite serves every account from one host, so the account is in the path. */
  it('reads the emulator form, with the account as the first path segment', () => {
    const target = parseHistoryUrl('http://127.0.0.1:10000/devstoreaccount1/atest-history');
    expect(target).toMatchObject({
      kind: 'azure-blob',
      account: 'devstoreaccount1',
      container: 'atest-history',
      serviceUrl: 'http://127.0.0.1:10000/devstoreaccount1',
    });
  });

  it('parses the read and window modifiers', () => {
    expect(parseHistoryUrl('azblob://acct/hist?window=30&readonly=1')).toMatchObject({
      windowDays: 30,
      readOnly: true,
    });
    // Bare `?readonly` is what somebody typing it means.
    expect(parseHistoryUrl('azblob://acct/hist?readonly')).toMatchObject({ readOnly: true });
    expect(parseHistoryUrl('azblob://acct/hist?readonly=0')).toMatchObject({ readOnly: false });
    expect(parseHistoryUrl('azblob://acct/hist?readonly=false')).toMatchObject({ readOnly: false });
  });

  it('rejects a malformed target before any credential is acquired', () => {
    expect(() => parseHistoryUrl('azblob://acct')).toThrow(HistoryUrlError);
    expect(() => parseHistoryUrl('azblob://acct/Not_A_Container')).toThrow(/container name/);
    expect(() => parseHistoryUrl('azblob://xy/container')).toThrow(/storage account name/);
    expect(() => parseHistoryUrl('azblob://acct/hist?window=0')).toThrow(/positive integer/);
  });
});

describe('describeHistoryTarget', () => {
  it('says plainly that memory is discarded, which is the whole trap', () => {
    expect(describeHistoryTarget(parseHistoryUrl(':memory:'))).toContain('discarded');
  });

  it('marks a read-only store, so a PR log says why nothing was written', () => {
    expect(describeHistoryTarget(parseHistoryUrl('azblob://acct/hist?readonly=1'))).toContain(
      'read-only',
    );
  });
});
