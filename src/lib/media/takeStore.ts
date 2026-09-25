/**
 * The answer being recorded, copied to IndexedDB as it is recorded.
 *
 * A candidate gets one attempt, and until this existed that attempt lived
 * only in the tab's memory: a crash, a reload, a flat battery or a tab closed
 * while the upload crawled lost it. The recorder now hands over a chunk every
 * couple of seconds; each is written here, and a reload finds the take and
 * sends it.
 *
 * Best effort by design. A browser without IndexedDB, or one that refuses it
 * (Safari private browsing, a full disk), records exactly as before — from
 * memory. Nothing here may fail an answer.
 *
 * The copy is the candidate's own recording on the candidate's own device,
 * and it goes as soon as the server holds the answer, when they skip it, when
 * they finish, or after a day — a shared computer must not keep it.
 */

import type { Recording } from './recorder'

const DB_NAME = 'interw-takes'
const TAKES = 'takes'
const CHUNKS = 'chunks'
/** A take nobody came back for is gone after a day. */
export const TAKE_MAX_AGE_MS = 24 * 60 * 60 * 1000

type Track = 'audio' | 'video'

type TakeRow = {
  id: string
  token: string
  questionIndex: number
  audioMimeType: string
  videoMimeType: string | null
  startedAt: number
}

/** `at` is when the chunk arrived: the last one is the recovered take's end. */
type ChunkRow = { takeId: string; track: Track; blob: Blob; at: number }

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'))
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  const open = factory.open(DB_NAME, 1)
  open.onupgradeneeded = () => {
    const db = open.result
    db.createObjectStore(TAKES, { keyPath: 'id' }).createIndex('token', 'token')
    // Auto-incremented keys keep the chunks of a take in recording order.
    db.createObjectStore(CHUNKS, { autoIncrement: true }).createIndex(
      'takeId',
      'takeId',
    )
  }
  return request(open)
}

/** What the interview does with the copy; a no-op without IndexedDB. */
export type Takes = {
  begin: (
    questionIndex: number,
    mimeTypes: { audio: string; video: string | null },
  ) => Promise<void>
  append: (questionIndex: number, track: Track, blob: Blob) => Promise<void>
  load: (questionIndex: number) => Promise<Recording | null>
  remove: (questionIndex: number) => Promise<void>
  prune: (keep?: (questionIndex: number) => boolean) => Promise<void>
}

class TakeStore implements Takes {
  private readonly db: Promise<IDBDatabase>
  /** Writes run one after another, so a chunk never lands before its take. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly token: string,
    factory: IDBFactory,
  ) {
    this.db = openDatabase(factory)
    // Every caller sees the failure through `run`; this only stops a store
    // that is never used from reporting an unhandled rejection.
    this.db.catch(() => undefined)
  }

  private takeId(questionIndex: number): string {
    return `${this.token}:${questionIndex}`
  }

  private run<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.db).then(work)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** A new take for this question, replacing any earlier one. */
  begin(
    questionIndex: number,
    mimeTypes: { audio: string; video: string | null },
  ): Promise<void> {
    return this.run(async (db) => {
      const id = this.takeId(questionIndex)
      const tx = db.transaction([TAKES, CHUNKS], 'readwrite')
      await deleteTake(tx, id)
      tx.objectStore(TAKES).put({
        id,
        token: this.token,
        questionIndex,
        audioMimeType: mimeTypes.audio,
        videoMimeType: mimeTypes.video,
        startedAt: Date.now(),
      } satisfies TakeRow)
      await done(tx)
    })
  }

  append(questionIndex: number, track: Track, blob: Blob): Promise<void> {
    return this.run(async (db) => {
      const tx = db.transaction(CHUNKS, 'readwrite')
      tx.objectStore(CHUNKS).add({
        takeId: this.takeId(questionIndex),
        track,
        blob,
        at: Date.now(),
      } satisfies ChunkRow)
      await done(tx)
    })
  }

  /** The take held for this question, as the recorder would have produced it. */
  load(questionIndex: number): Promise<Recording | null> {
    return this.run(async (db) => {
      const id = this.takeId(questionIndex)
      const tx = db.transaction([TAKES, CHUNKS], 'readonly')
      const take = (await request(tx.objectStore(TAKES).get(id))) as
        | TakeRow
        | undefined
      const chunks = (await request(
        tx.objectStore(CHUNKS).index('takeId').getAll(id),
      )) as Array<ChunkRow>
      const audioChunks = chunks.filter((c) => c.track === 'audio')
      if (!take || audioChunks.length === 0) return null
      const videoChunks = chunks.filter((c) => c.track === 'video')
      const videoMimeType =
        take.videoMimeType && videoChunks.length > 0 ? take.videoMimeType : null
      return {
        audio: new Blob(
          audioChunks.map((c) => c.blob),
          { type: take.audioMimeType },
        ),
        audioMimeType: take.audioMimeType,
        video: videoMimeType
          ? new Blob(
              videoChunks.map((c) => c.blob),
              { type: videoMimeType },
            )
          : null,
        videoMimeType,
        durationSeconds: Math.round(
          (Math.max(...chunks.map((c) => c.at)) - take.startedAt) / 1000,
        ),
      }
    })
  }

  remove(questionIndex: number): Promise<void> {
    return this.run(async (db) => {
      const tx = db.transaction([TAKES, CHUNKS], 'readwrite')
      await deleteTake(tx, this.takeId(questionIndex))
      await done(tx)
    })
  }

  /**
   * Everything this interview holds, when `keep` says no — or everything of
   * any interview once it is older than a day.
   */
  prune(keep: (questionIndex: number) => boolean = () => false): Promise<void> {
    return this.run(async (db) => {
      const tx = db.transaction([TAKES, CHUNKS], 'readwrite')
      const takes = (await request(
        tx.objectStore(TAKES).getAll(),
      )) as Array<TakeRow>
      const cutoff = Date.now() - TAKE_MAX_AGE_MS
      for (const take of takes) {
        const stale = take.startedAt < cutoff
        const ours = take.token === this.token
        if (stale || (ours && !keep(take.questionIndex))) {
          await deleteTake(tx, take.id)
        }
      }
      await done(tx)
    })
  }
}

async function deleteTake(tx: IDBTransaction, id: string): Promise<void> {
  tx.objectStore(TAKES).delete(id)
  const chunks = tx.objectStore(CHUNKS)
  const keys = await request(chunks.index('takeId').getAllKeys(id))
  for (const key of keys) chunks.delete(key)
}

const NO_TAKES: Takes = {
  begin: () => Promise.resolve(),
  append: () => Promise.resolve(),
  load: () => Promise.resolve(null),
  remove: () => Promise.resolve(),
  prune: () => Promise.resolve(),
}

/** Without IndexedDB, a store that keeps nothing: recording works from memory. */
export function openTakeStore(
  token: string,
  factory: IDBFactory | undefined = 'indexedDB' in globalThis
    ? globalThis.indexedDB
    : undefined,
): Takes {
  return factory ? new TakeStore(token, factory) : NO_TAKES
}
