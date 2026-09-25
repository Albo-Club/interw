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
 * Whether this browser records video, which decides the path under test: the
 * product opens the devices audio only when the browser encodes no video
 * format. Chromium must record video. WebKit may not: Playwright's Linux
 * build is not Safari, and its encoders are its own. An audio format is
 * required everywhere, since without one the page only says the browser is
 * unsupported. See KNOWN_ISSUES.md § "The WebKit e2e leg: what removes the
 * preview".
 */
async function recordsVideo(page: Page, browserName: string) {
  const formats = await page.evaluate(
    (types) => types.filter((type) => MediaRecorder.isTypeSupported(type)),
    [...VIDEO_MIME_PREFERENCES, ...AUDIO_MIME_PREFERENCES],
  )
  const description = `MediaRecorder formats this browser encodes: ${JSON.stringify(formats)}`
  test.info().annotations.push({ type: 'recording formats', description })
  const video = formats.some((type) => type.startsWith('video/'))
  expect(formats.some((type) => type.startsWith('audio/')), description).toBe(true)
  expect(video || browserName === 'webkit', description).toBe(true)
  return video
}

/**
 * What the candidate sees of their own capture. With video, a black preview
 * is the bug this guards against: frames must be arriving. Audio only, the
 * page must say so rather than show an empty frame.
 */
async function expectCapture(page: Page, video: boolean) {
  const preview = page.locator('video')
  if (!video) {
    await expect(page.getByText(/^Audio only/)).toBeVisible()
    await expect(preview).toHaveCount(0)
    return
  }
  await expect(preview).toBeVisible()
  await expect
    .poll(() => preview.evaluate((element: HTMLVideoElement) => element.videoWidth))
    .toBeGreaterThan(0)
}

async function recordAnswer(page: Page, video: boolean) {
  await page.getByRole('button', { name: 'Start my answer' }).click()
  await expectCapture(page, video)
  await page.waitForTimeout(1_500)
  await test.info().attach('recording screen', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  await page.getByRole('button', { name: "I've finished my answer" }).click()
}

test('a candidate records two answers, gets through a failed upload, and finishes', async ({
  page,
  browserName,
}) => {
  const { token } = convexRun<{ token: string }>(
    'interview:seedE2eSession',
    {},
  )
  try {
    await page.goto(`/s/${token}`)
    const video = await recordsVideo(page, browserName)
    await page
      .getByRole('checkbox', { name: 'I understand and agree to be recorded' })
      .check()
    await page.getByRole('button', { name: 'Agree and continue' }).click()

    await expect(
      page.getByRole('heading', {
        name: "Let's check your camera and microphone",
      }),
    ).toBeVisible()
    await expectCapture(page, video)
    await page
      .getByRole('button', { name: /start the interview|Start anyway/ })
      .click()

    await expect(page.getByText('Question 1 of 2')).toBeVisible()
    await recordAnswer(page, video)

    // The bucket drops out during the second upload: the failure is on
    // screen, and "Try again" sends the answer the page still holds.
    await expect(page.getByText('Question 2 of 2')).toBeVisible()
    const bucket = new URL(process.env.MEDIA_ORIGIN ?? '').origin
    await page.route(
      (url) => url.origin === bucket,
      (route) => route.abort(),
    )
    await recordAnswer(page, video)
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
