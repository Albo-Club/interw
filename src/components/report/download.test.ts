import { describe, expect, it, vi } from 'vitest'

import { downloadMedia } from './download'

function respond(chunks: Array<number>, headers: Record<string, string> = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size))
      controller.close()
    },
  })
  return vi.fn(() => Promise.resolve(new Response(body, { headers })))
}

describe('downloadMedia', () => {
  it('reports progress against Content-Length and returns the whole file', async () => {
    vi.stubGlobal(
      'fetch',
      respond([25, 25, 50], {
        'content-length': '100',
        'content-type': 'video/webm',
      }),
    )
    const seen: Array<number | null> = []
    const blob = await downloadMedia('https://bucket.test/q0.webm', (p) =>
      seen.push(p),
    )
    expect(seen).toEqual([25, 50, 100])
    expect(blob.size).toBe(100)
    expect(blob.type).toBe('video/webm')
  })

  it('reports each percent once, not each chunk', async () => {
    vi.stubGlobal('fetch', respond([1, 1, 1, 997], { 'content-length': '1000' }))
    const seen: Array<number | null> = []
    await downloadMedia('https://bucket.test/q0.mp4', (p) => seen.push(p))
    expect(seen).toEqual([0, 100])
  })

  it('reports no percent when the size is unknown', async () => {
    vi.stubGlobal('fetch', respond([10, 10]))
    const seen: Array<number | null> = []
    await downloadMedia('https://bucket.test/q0.mp4', (p) => seen.push(p))
    expect(seen).toEqual([null])
  })

  // An expired signed URL answers 403 with an XML body: that must never be
  // handed to the player as if it were the video.
  it('fails on an error status instead of returning its body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('denied', { status: 403 }))),
    )
    await expect(
      downloadMedia('https://bucket.test/q0.mp4', () => {}),
    ).rejects.toThrow('403')
  })
})
