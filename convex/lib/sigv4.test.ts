import { describe, expect, it } from 'vitest'

import {
  buildCanonicalRequest,
  formatAmzDate,
  presign,
  uriEncode,
  uriEncodePath,
} from './sigv4'

/**
 * AWS's own worked example for a presigned GET.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 *
 * Both intermediates are asserted, not just the final signature: if the
 * canonical request drifts, the failure names which half broke.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  origin: 'https://examplebucket.s3.amazonaws.com',
  path: '/test.txt',
  date: new Date('2013-05-24T00:00:00Z'),
  expiresIn: 86400,
} as const

describe('sigv4', () => {
  it('formats the AMZ date and date stamp in UTC', () => {
    expect(formatAmzDate(new Date('2013-05-24T00:00:00Z'))).toEqual({
      amzDate: '20130524T000000Z',
      dateStamp: '20130524',
    })
  })

  it('percent-encodes the characters encodeURIComponent leaves alone', () => {
    expect(uriEncode("a!b'c(d)e*f")).toBe('a%21b%27c%28d%29e%2Af')
    expect(uriEncode('a/b')).toBe('a%2Fb')
  })

  it('keeps path separators while encoding each segment', () => {
    expect(uriEncodePath('orgs/o 1/sessions/s1/q0.webm')).toBe(
      'orgs/o%201/sessions/s1/q0.webm',
    )
  })

  it('builds the canonical request AWS documents', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'GET',
      ...AWS_EXAMPLE,
    })
    expect(canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        'host:examplebucket.s3.amazonaws.com',
        '',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    )
  })

  it('reproduces the signature from the AWS worked example', async () => {
    const url = await presign({ method: 'GET', ...AWS_EXAMPLE })
    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
  })

  it('signs extra headers, so the client cannot deviate from them', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'PUT',
      ...AWS_EXAMPLE,
      extraSignedHeaders: { 'Content-Type': 'video/webm' },
    })
    expect(canonicalRequest).toContain('content-type:video/webm\n')
    expect(canonicalRequest).toContain('content-type;host')
  })
})
