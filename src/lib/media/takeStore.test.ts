import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TAKE_MAX_AGE_MS, openTakeStore } from './takeStore'

const TOKEN = 't'.repeat(43)
const mimeTypes = { audio: 'audio/webm', video: 'video/mp4' }

async function text(blob: Blob | null): Promise<string | null> {
  return blob ? await blob.text() : null
}

describe('TakeStore', () => {
  let factory: IDBFactory

  beforeEach(() => {
    factory = new IDBFactory()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives back a take, chunks in recording order, after a reload', async () => {
    const recording = openTakeStore(TOKEN, factory)
    void recording.begin(2, mimeTypes)
    void recording.append(2, 'audio', new Blob(['a1']))
    void recording.append(2, 'video', new Blob(['v1']))
    await recording.append(2, 'audio', new Blob(['a2']))

    // A new store over the same database: what a reloaded tab opens.
    const take = await openTakeStore(TOKEN, factory).load(2)
    expect(await text(take!.audio)).toBe('a1a2')
    expect(await text(take!.video)).toBe('v1')
    expect(take!.audio.type).toBe('audio/webm')
    expect(take!.videoMimeType).toBe('video/mp4')
  })

  it('holds nothing to send when no audio arrived', async () => {
    const store = openTakeStore(TOKEN, factory)
    await store.begin(0, mimeTypes)
    await store.append(0, 'video', new Blob(['v']))
    expect(await store.load(0)).toBeNull()
  })

  it('keeps an audio-only take audio-only', async () => {
    const store = openTakeStore(TOKEN, factory)
    await store.begin(0, { audio: 'audio/mp4', video: null })
    await store.append(0, 'audio', new Blob(['a']))
    const take = await store.load(0)
    expect(take!.video).toBeNull()
    expect(take!.videoMimeType).toBeNull()
  })

  it('starts a new take over the old one', async () => {
    const store = openTakeStore(TOKEN, factory)
    await store.begin(1, mimeTypes)
    await store.append(1, 'audio', new Blob(['old']))
    await store.begin(1, mimeTypes)
    await store.append(1, 'audio', new Blob(['new']))
    expect(await text((await store.load(1))!.audio)).toBe('new')
  })

  it('forgets a take once removed', async () => {
    const store = openTakeStore(TOKEN, factory)
    await store.begin(0, mimeTypes)
    await store.append(0, 'audio', new Blob(['a']))
    await store.remove(0)
    expect(await store.load(0)).toBeNull()
  })

  it('prunes what it is told to, and never another interview’s take', async () => {
    const ours = openTakeStore(TOKEN, factory)
    const theirs = openTakeStore('o'.repeat(43), factory)
    for (const q of [0, 1]) {
      await ours.begin(q, mimeTypes)
      await ours.append(q, 'audio', new Blob(['a']))
    }
    await theirs.begin(0, mimeTypes)
    await theirs.append(0, 'audio', new Blob(['b']))

    await ours.prune((q) => q === 1)
    expect(await ours.load(0)).toBeNull()
    expect(await ours.load(1)).not.toBeNull()
    expect(await theirs.load(0)).not.toBeNull()
  })

  it('drops any take older than a day, whoever it belongs to', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const theirs = openTakeStore('o'.repeat(43), factory)
    await theirs.begin(0, mimeTypes)
    await theirs.append(0, 'audio', new Blob(['b']))

    vi.setSystemTime(Date.now() + TAKE_MAX_AGE_MS + 1)
    await openTakeStore(TOKEN, factory).prune(() => true)
    expect(await theirs.load(0)).toBeNull()
  })

  it('keeps nothing, and fails nothing, where the browser has no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const store = openTakeStore(TOKEN)
    await store.begin(0, mimeTypes)
    await store.append(0, 'audio', new Blob(['a']))
    expect(await store.load(0)).toBeNull()
    vi.unstubAllGlobals()
  })
})
