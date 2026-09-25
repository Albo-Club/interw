import { useEffect, useState } from 'react'

import { DARK_FRAME_BRIGHTNESS, frameBrightness } from './devices'

const SAMPLE_MS = 500
/** Three seconds of black, so a blink or a hand across the lens is not one. */
const DARK_SAMPLES = 6

/**
 * True once `video` has shown nothing but black for a few seconds.
 *
 * The microphone had a meter; the camera had nothing, and a privacy shutter
 * left closed records a whole interview of a black rectangle while every
 * check says it works — the stream is live, the track is fine.
 */
export function useCameraDark(video: HTMLVideoElement | null): boolean {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    setDark(false)
    if (!video) return
    // A few dozen pixels say whether there is an image; the frame's own size
    // would cost a full-resolution copy twice a second.
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 18
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return
    let darkInARow = 0

    const timer = setInterval(() => {
      // Nothing decoded yet is not a verdict on the camera.
      if (video.videoWidth === 0) return
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      darkInARow =
        frameBrightness(data) < DARK_FRAME_BRIGHTNESS ? darkInARow + 1 : 0
      setDark(darkInARow >= DARK_SAMPLES)
    }, SAMPLE_MS)

    return () => clearInterval(timer)
  }, [video])

  return dark
}
