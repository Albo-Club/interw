import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import {
  AUDIO_MIME_PREFERENCES,
  VIDEO_MIME_PREFERENCES,
} from '../src/lib/media/recorder'
import type { Page } from '@playwright/test'

// The seed and the database check are internal functions: only the deploy
// key in the environment can call them.
function convexRun<T>(fn: string, args: Record<string, unknown>): T {
  const out = execFileSync('npx', ['convex', 'run', fn, JSON.stringify(args)], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as T
}

/**
 * The premise of this test: the browser can encode the formats the product
 * records. Without a video format the device check rightly opens audio only,
 * and without an audio format it says the browser is unsupported — either
 * way the preview assertion would only report that no <video> exists. See
 * KNOWN_ISSUES.md § "The WebKit e2e leg: what removes the preview".
 */
async function expectRecordableFormats(page: Page) {
  const formats = await page.evaluate(
    (types) => types.filter((type) => MediaRecorder.isTypeSupported(type)),
    [...VIDEO_MIME_PREFERENCES, ...AUDIO_MIME_PREFERENCES],
  )
  const message = `MediaRecorder formats this browser encodes: ${JSON.stringify(formats)}`
  expect(formats.some((type) => type.startsWith('video/')), message).toBe(true)
  expect(formats.some((type) => type.startsWith('audio/')), message).toBe(true)
}

/** A black preview is the bug this guards against: frames must be arriving. */
async function expectLivePreview(page: Page) {
  const preview = page.locator('video')
  await expect(preview).toBeVisible()
  await expect
    .poll(() => preview.evaluate((video: HTMLVideoElement) => video.videoWidth))
    .toBeGreaterThan(0)
}

async function recordAnswer(page: Page) {
  await page.getByRole('button', { name: 'Start my answer' }).click()
  await expectLivePreview(page)
  await page.waitForTimeout(1_500)
  await test.info().attach('recording screen', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await page.getByRole('button', { name: "I've finished my answer" }).click()
}

test('a candidate records two answers, gets through a failed upload, and finishes', async ({
  page,
}) => {
  const { token } = convexRun<{ token: string }>(
    'interview:seedE2eSession',
    {},
  )
  try {
    await page.goto(`/s/${token}`)
    await expectRecordableFormats(page)
    await page
      .getByRole('checkbox', { name: 'I understand and agree to be recorded' })
      .check()
    await page.getByRole('button', { name: 'Agree and continue' }).click()

    await expect(
      page.getByRole('heading', {
        name: "Let's check your camera and microphone",
      }),
    ).toBeVisible()
    await expectLivePreview(page)
    await page
      .getByRole('button', { name: /start the interview|Start anyway/ })
      .click()

    await expect(page.getByText('Question 1 of 2')).toBeVisible()
    await recordAnswer(page)

    // The bucket drops out during the second upload: the failure is on
    // screen, and "Try again" sends the answer the page still holds.
    await expect(page.getByText('Question 2 of 2')).toBeVisible()
    const bucket = new URL(process.env.MEDIA_ORIGIN ?? '').origin
    await page.route(
      (url) => url.origin === bucket,
      (route) => route.abort(),
    )
    await recordAnswer(page)
    await expect(page.getByText("Your last answer didn't save")).toBeVisible()
    await page.unrouteAll()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByText('All 2 answers are saved.')).toBeVisible()

    // A reload resumes from the server's cursor, not from the page's memory.
    await page.reload()
    await expect(page.getByText('All 2 answers are saved.')).toBeVisible()

    await page.getByRole('button', { name: 'Finish the interview' }).click()
    await expect(
      page.getByRole('heading', { name: "That's it — thank you" }),
    ).toBeVisible()

    expect(convexRun('interview:e2eSessionState', { token })).toEqual({
      status: 'completed',
      uploadedSegments: 2,
    })
  } finally {
    // The deployment is shared: the test candidate is erased like a real one.
    convexRun('candidate:deleteMyData', { token })
  }
})
