import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// The seed and the database check are internal functions: only the deploy
// key in the environment can call them.
function convexRun<T>(fn: string, args: Record<string, unknown>): T {
  const out = execFileSync('npx', ['convex', 'run', fn, JSON.stringify(args)], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as T
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
