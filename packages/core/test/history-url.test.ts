import { describe, expect, it } from 'vitest';

import {
  HistoryUrlError,
  describeHistoryTarget,
  parseHistoryUrl,
} from '../src/history/url.js';

describe('parseHistoryUrl', () => {
  it('given :memory: or an empty string -> when parseHistoryUrl runs -> then kind is memory', { tags: ['@unit', '@history-url'] }, () => {
    expect(parseHistoryUrl(':memory:').kind).toBe('memory');
    expect(parseHistoryUrl('').kind).toBe('memory');
  });

  /**
   * `--db` has always taken a path and must keep doing so. A Windows path
   * parses as a URL with scheme `c:`, so "reject unrecognised schemes" would
   * break the case the flag was built for.
   */
  it('given an unrecognised target such as a relative path or a Windows drive path -> when parseHistoryUrl runs -> then kind is sqlite with the path preserved verbatim', { tags: ['@unit', '@history-url'] }, () => {
    expect(parseHistoryUrl('.atest/history.sqlite')).toEqual({
      kind: 'sqlite',
      path: '.atest/history.sqlite',
    });
    expect(parseHistoryUrl('C:\\atest\\history.sqlite')).toEqual({
      kind: 'sqlite',
      path: 'C:\\atest\\history.sqlite',
    });
  });

  it('given an azblob shorthand target -> when parseHistoryUrl runs -> then it expands to the commercial blob endpoint with an empty prefix', { tags: ['@unit', '@history-url'] }, () => {
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

  it('given an azblob target with a multi-segment prefix -> when parseHistoryUrl runs -> then the prefix is normalised to end with a slash', { tags: ['@unit', '@history-url'] }, () => {
    const target = parseHistoryUrl('azblob://acct/atest-history/bjjeire/java');
    expect(target).toMatchObject({ prefix: 'bjjeire/java/' });
  });

  /** Sovereign clouds have different suffixes; hard coding one resolves nowhere. */
  it('given a non-commercial endpointSuffix -> when parseHistoryUrl runs -> then serviceUrl is built from that suffix', { tags: ['@unit', '@history-url'] }, () => {
    const target = parseHistoryUrl('azblob://acct/hist', {
      endpointSuffix: 'blob.core.usgovcloudapi.net',
    });
    expect(target).toMatchObject({ serviceUrl: 'https://acct.blob.core.usgovcloudapi.net' });
  });

  it('given a fully qualified blob URL -> when parseHistoryUrl runs -> then the account comes from the subdomain and the container and prefix from the path', { tags: ['@unit', '@history-url'] }, () => {
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
  it('given an Azurite emulator URL -> when parseHistoryUrl runs -> then the account is read from the first path segment and kept in serviceUrl', { tags: ['@unit', '@history-url'] }, () => {
    const target = parseHistoryUrl('http://127.0.0.1:10000/devstoreaccount1/atest-history');
    expect(target).toMatchObject({
      kind: 'azure-blob',
      account: 'devstoreaccount1',
      container: 'atest-history',
      serviceUrl: 'http://127.0.0.1:10000/devstoreaccount1',
    });
  });

  it('given window and readonly query modifiers -> when parseHistoryUrl runs -> then windowDays and readOnly reflect them, with a bare readonly flag meaning true', { tags: ['@unit', '@history-url'] }, () => {
    expect(parseHistoryUrl('azblob://acct/hist?window=30&readonly=1')).toMatchObject({
      windowDays: 30,
      readOnly: true,
    });
    // Bare `?readonly` is what somebody typing it means.
    expect(parseHistoryUrl('azblob://acct/hist?readonly')).toMatchObject({ readOnly: true });
    expect(parseHistoryUrl('azblob://acct/hist?readonly=0')).toMatchObject({ readOnly: false });
    expect(parseHistoryUrl('azblob://acct/hist?readonly=false')).toMatchObject({ readOnly: false });
  });

  it('given a malformed azblob target -> when parseHistoryUrl runs -> then it throws HistoryUrlError naming the offending part, before any credential is acquired', { tags: ['@unit', '@history-url'] }, () => {
    expect(() => parseHistoryUrl('azblob://acct')).toThrow(HistoryUrlError);
    expect(() => parseHistoryUrl('azblob://acct/Not_A_Container')).toThrow(/container name/);
    expect(() => parseHistoryUrl('azblob://xy/container')).toThrow(/storage account name/);
    expect(() => parseHistoryUrl('azblob://acct/hist?window=0')).toThrow(/positive integer/);
  });
});

describe('describeHistoryTarget', () => {
  it('given a memory target -> when describeHistoryTarget renders it -> then the description says the history is discarded', { tags: ['@unit', '@history-url'] }, () => {
    expect(describeHistoryTarget(parseHistoryUrl(':memory:'))).toContain('discarded');
  });

  it('given a read-only blob target -> when describeHistoryTarget renders it -> then the description says read-only, so a PR log explains why nothing was written', { tags: ['@unit', '@history-url'] }, () => {
    expect(describeHistoryTarget(parseHistoryUrl('azblob://acct/hist?readonly=1'))).toContain(
      'read-only',
    );
  });
});
