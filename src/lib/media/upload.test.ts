import { describe, expect, it, vi } from 'vitest'

import { UploadError, uploadToSignedUrl } from './upload'
import type { PutRequest, SendImpl, UploadProgress } from './upload'

const blob = new Blob(['0123456789'], { type: 'video/webm' })

function run(
  sendImpl: SendImpl,
  overrides: Partial<Parameters<typeof uploadToSignedUrl>[0]> = {},
) {
  const progress: Array<UploadProgress> = []
  return {
    progress,
    promise: uploadToSignedUrl({
      url: 'https://bucket.example/key',
      blob,
      contentType: 'video/webm',
      sendImpl,
      sleepImpl: async () => {},
      onProgress: (p) => progress.push(p),
      ...overrides,
    }),
  }
}

const ok = () => Promise.resolve(200)
const fail = (status: number) => () => Promise.resolve(status)

describe('uploadToSignedUrl', () => {
  it('sends the exact content type the URL was signed with', async () => {
    const sendImpl = vi.fn((_request: PutRequest) => ok())
    await run(sendImpl).promise
    const request = sendImpl.mock.calls[0][0]
    expect(request.contentType).toBe('video/webm')
    expect(request.body).toBe(blob)
  })

  it('reports done on the first try', async () => {
    const { progress, promise } = run(vi.fn(ok))
    await promise
    expect(progress.map((p) => p.phase)).toEqual(['uploading', 'done'])
  })

  /**
   * E9. `fetch` reported nothing between "started" and "done": a 40 MB answer
   * over 4G was minutes of a frozen screen, and a candidate who reloads it
   * loses the answer.
   */
  it('reports the bytes sent while the upload runs', async () => {
    const { progress, promise } = run(({ onUploadProgress }) => {
      onUploadProgress(4)
      onUploadProgress(10)
      return ok()
    })
    await promise
    expect(progress.map((p) => [p.phase, p.loaded, p.total])).toEqual([
      ['uploading', 0, 10],
      ['uploading', 4, 10],
      ['uploading', 10, 10],
      ['done', 10, 10],
    ])
  })

  it('retries a 500 and succeeds', async () => {
    const sendImpl = vi
      .fn<SendImpl>()
      .mockImplementationOnce(fail(503))
      .mockImplementationOnce(ok)
    const { progress, promise } = run(sendImpl)
    await promise
    expect(sendImpl).toHaveBeenCalledTimes(2)
    expect(progress.map((p) => p.phase)).toEqual([
      'uploading',
      'retrying',
      'done',
    ])
  })

  it('retries a network drop — the case it exists for', async () => {
    const sendImpl = vi
      .fn<SendImpl>()
      .mockRejectedValueOnce(new Error('network error'))
      .mockImplementationOnce(ok)
    await run(sendImpl).promise
    expect(sendImpl).toHaveBeenCalledTimes(2)
  })

  // An expired or malformed signature will never succeed; retrying only
  // delays telling the candidate something is wrong.
  it('does not retry a 403', async () => {
    const sendImpl = vi.fn(fail(403))
    const { promise } = run(sendImpl)
    await expect(promise).rejects.toThrow(UploadError)
    expect(sendImpl).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failure instead of resolving quietly', async () => {
    const { progress, promise } = run(vi.fn(fail(500)))
    await expect(promise).rejects.toThrow(/HTTP 500/)
    expect(progress.at(-1)?.phase).toBe('failed')
  })

  it('gives up after maxAttempts', async () => {
    const sendImpl = vi.fn(fail(500))
    const { promise } = run(sendImpl, { maxAttempts: 4 })
    await expect(promise).rejects.toThrow()
    expect(sendImpl).toHaveBeenCalledTimes(4)
  })

  it('stops immediately when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const sendImpl = vi.fn(ok)
    await expect(
      run(sendImpl, { signal: controller.signal }).promise,
    ).rejects.toThrow(/aborted/)
    expect(sendImpl).not.toHaveBeenCalled()
  })
})
