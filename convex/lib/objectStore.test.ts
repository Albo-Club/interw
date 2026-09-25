import { describe, expect, it } from 'vitest'

import {
  candidateDocumentKey,
  extensionForMimeType,
  mimeTypeForKey,
  playbackMedia,
  projectMediaKey,
  resolveTarget,
  segmentKey,
  sessionPrefix,
  thumbnailKey,
} from './objectStore'

const CONFIG = {
  origin: 'https://s3.fr-par.scw.cloud',
  region: 'fr-par',
  bucket: 'interw-media',
  accessKeyId: 'k',
  secretAccessKey: 's',
  forcePathStyle: false,
}

describe('resolveTarget', () => {
  it('uses virtual-hosted addressing by default', () => {
    expect(resolveTarget(CONFIG, 'orgs/o1/sessions/s1/q0.webm')).toEqual({
      origin: 'https://interw-media.s3.fr-par.scw.cloud',
      path: '/orgs/o1/sessions/s1/q0.webm',
    })
  })

  it('puts the bucket in the path when forced (MinIO in local dev)', () => {
    expect(
      resolveTarget({ ...CONFIG, forcePathStyle: true }, 'orgs/o1/cv.pdf'),
    ).toEqual({
      origin: 'https://s3.fr-par.scw.cloud',
      path: '/interw-media/orgs/o1/cv.pdf',
    })
  })

  it('encodes each segment without eating the separators', () => {
    expect(resolveTarget(CONFIG, 'orgs/o 1/a+b.webm').path).toBe(
      '/orgs/o%201/a%2Bb.webm',
    )
  })
})

describe('key conventions', () => {
  // Purging a session must be a known, enumerable set — which only holds if
  // every key for that session starts with the session prefix.
  it('nests every candidate object under the session prefix', () => {
    const prefix = sessionPrefix('o1', 's1')
    expect(prefix).toBe('orgs/o1/sessions/s1')
    for (const key of [
      segmentKey('o1', 's1', 0, 'webm'),
      thumbnailKey('o1', 's1', 0),
      candidateDocumentKey('o1', 's1', 'cv', 'pdf'),
      candidateDocumentKey('o1', 's1', 'cover', 'pdf'),
    ]) {
      expect(key.startsWith(`${prefix}/`)).toBe(true)
    }
  })

  it('keeps recruiter project media out of the session prefix', () => {
    // Otherwise purging one candidate would delete the question videos the
    // other candidates still need.
    expect(projectMediaKey('o1', 'p1', 'intro', 'webm')).toBe(
      'orgs/o1/projects/p1/intro.webm',
    )
    expect(projectMediaKey('o1', 'p1', 'q-abc', 'webm')).toBe(
      'orgs/o1/projects/p1/q-abc.webm',
    )
    expect(
      projectMediaKey('o1', 'p1', 'intro', 'webm').startsWith(
        sessionPrefix('o1', 's1'),
      ),
    ).toBe(false)
  })

  it('gives distinct keys to distinct questions', () => {
    expect(segmentKey('o1', 's1', 0, 'webm')).not.toBe(
      segmentKey('o1', 's1', 1, 'webm'),
    )
  })
})

describe('extensionForMimeType', () => {
  it('strips the codec parameters MediaRecorder appends', () => {
    expect(extensionForMimeType('video/webm;codecs=vp8,opus')).toBe('webm')
    expect(extensionForMimeType('audio/webm;codecs=opus')).toBe('weba')
  })

  it('handles the Safari-flavoured types', () => {
    expect(extensionForMimeType('video/mp4')).toBe('mp4')
    expect(extensionForMimeType('audio/mp4')).toBe('m4a')
  })

  it('falls back rather than trusting an unknown type', () => {
    expect(extensionForMimeType('text/html')).toBe('bin')
  })
})

describe('mimeTypeForKey', () => {
  it('reads back the type every accepted recording was stored under', () => {
    for (const type of ['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4']) {
      const key = segmentKey('org', 'session', 0, extensionForMimeType(type))
      expect(mimeTypeForKey(key)).toBe(type)
    }
  })

  it('labels a Safari answer as MP4 audio, not WebM', () => {
    expect(mimeTypeForKey('orgs/o/sessions/s/q2.m4a')).toBe('audio/mp4')
  })

  it('does not guess for an unknown extension', () => {
    expect(mimeTypeForKey('orgs/o/sessions/s/q0.bin')).toBe(
      'application/octet-stream',
    )
  })
})

describe('playbackMedia', () => {
  it('keeps playing the video of answers recorded before the flag existed', () => {
    expect(playbackMedia({ videoKey: 'q0.webm', audioKey: 'q0.weba' })).toEqual({
      key: 'q0.webm',
      kind: 'video',
    })
  })

  it('falls back to the audio when the video never landed', () => {
    expect(
      playbackMedia({
        videoKey: 'q0.mp4',
        audioKey: 'q0.weba',
        videoUploaded: false,
      }),
    ).toEqual({ key: 'q0.weba', kind: 'audio' })
  })

  it('has nothing to play without a key', () => {
    expect(playbackMedia({})).toBeNull()
  })
})
