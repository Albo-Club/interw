import { describe, expect, it, vi } from 'vitest'

import { UploadError, uploadToSignedUrl } from './upload'
import type { UploadProgress } from './upload'

const blob = new Blob(['x'], { type: 'video/webm' })

function run(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof uploadToSignedUrl>[0]> = {},
) {
  const progress: Array<UploadProgress> = []
  return {
    progress,
    promise: uploadToSignedUrl({
      url: 'https://bucket.example/key',
      blob,
      contentType: 'video/webm',
      fetchImpl,
      sleepImpl: async () => {},
      onProgress: (p) => progress.push(p),
      ...overrides,
    }),
  }
}

const ok = () => new Response(null, { status: 200 })
const fail = (status: number) => () => new Response(null, { status })

describe('uploadToSignedUrl', () => {
  it('sends the exact content type the URL was signed with', async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) => ok())
    await run(fetchImpl as unknown as typeof fetch).promise
    const init = fetchImpl.mock.calls[0][1]
    expect(init?.method).toBe('PUT')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe(
      'video/webm',
    )
  })

  it('reports done on the first try', async () => {
    const { progress, promise } = run(vi.fn(ok) as unknown as typeof fetch)
    await promise
    expect(progress.map((p) => p.phase)).toEqual(['uploading', 'done'])
  })

  it('retries a 500 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(fail(503))
      .mockImplementationOnce(ok)
    const { progress, promise } = run(fetchImpl)
    await promise
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(progress.map((p) => p.phase)).toEqual([
      'uploading',
      'retrying',
      'done',
    ])
  })

  it('retries a network drop — the case it exists for', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(ok)
    await run(fetchImpl).promise
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  // An expired or malformed signature will never succeed; retrying only
  // delays telling the candidate something is wrong.
  it('does not retry a 403', async () => {
    const fetchImpl = vi.fn(fail(403))
    const { promise } = run(fetchImpl as unknown as typeof fetch)
    await expect(promise).rejects.toThrow(UploadError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failure instead of resolving quietly', async () => {
    const { progress, promise } = run(vi.fn(fail(500)) as unknown as typeof fetch)
    await expect(promise).rejects.toThrow(/HTTP 500/)
    expect(progress.at(-1)?.phase).toBe('failed')
  })

  it('gives up after maxAttempts', async () => {
    const fetchImpl = vi.fn(fail(500))
    const { promise } = run(fetchImpl as unknown as typeof fetch, {
      maxAttempts: 4,
    })
    await expect(promise).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('stops immediately when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(ok)
    await expect(
      run(fetchImpl as unknown as typeof fetch, { signal: controller.signal })
        .promise,
    ).rejects.toThrow(/aborted/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
