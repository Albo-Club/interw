/**
 * Para-verbal analysis: HOW an answer was delivered, not what it said.
 *
 * Every figure here is computed from the timestamped transcript. No model is
 * asked to score any of it, for a reason that matters: this stack has no
 * audio-capable model, so a "vocal warmth" or "confidence" score would be an
 * invention wearing the clothes of a measurement — and nothing in a hiring
 * report may be invented. Speaking rate, hesitation, pausing and length
 * discipline are the measurable substance of para-verbal delivery, and they
 * come free with timestamps we already hold.
 *
 * Being deterministic also means it is testable, reproducible, and identical
 * on a replay — which is what the pipeline's idempotency requires.
 */

import type { TimedChunk } from './evidence'

export type ParaverbalDimensionKey =
  | 'pace'
  | 'fluency'
  | 'pauses'
  | 'concision'
  | 'consistency'
  | 'engagement'

export type ParaverbalDimension = {
  key: ParaverbalDimensionKey
  /** 0..10. */
  score: number
  /** The raw measurement, so the UI can show the number behind the score. */
  measure: number
}

export type ParaverbalResult = {
  dimensions: Array<ParaverbalDimension>
  wordsPerMinute: number
  totalSpeakingSeconds: number
}

export type AnswerTiming = {
  chunks: ReadonlyArray<TimedChunk>
  /** Length of the recording, in seconds. */
  durationSeconds: number
  /** What the recruiter allowed for this question. */
  maxResponseSeconds: number
}

/** Hesitation markers, French and English. Matched as whole words. */
const FILLERS = [
  'euh',
  'heu',
  'hum',
  'hmm',
  'ben',
  'bah',
  'genre',
  'voila',
  'enfin',
  'um',
  'uh',
  'erm',
  'like',
  'basically',
  'actually',
]

const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * 10 inside the ideal band, falling to 0 at the outer bounds.
 *
 * A band rather than a target: there is no single correct speaking rate, and
 * scoring a steady 135 words a minute below a steady 140 would be noise
 * dressed as insight.
 */
export function bandScore(
  value: number,
  { idealLow, idealHigh, hardLow, hardHigh }: {
    idealLow: number
    idealHigh: number
    hardLow: number
    hardHigh: number
  },
): number {
  if (value >= idealLow && value <= idealHigh) return 10
  if (value <= hardLow || value >= hardHigh) return 0
  const distance =
    value < idealLow ? (value - hardLow) / (idealLow - hardLow) : (hardHigh - value) / (hardHigh - idealHigh)
  return round1(Math.max(0, Math.min(10, distance * 10)))
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

function countFillers(text: string): number {
  const normalized = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  let total = 0
  for (const filler of FILLERS) {
    const matches = normalized.match(new RegExp(`\\b${filler}\\b`, 'g'))
    total += matches ? matches.length : 0
  }
  return total
}

/** Total silence inside an answer: the gaps between spoken chunks. */
function silenceSeconds(chunks: ReadonlyArray<TimedChunk>): number {
  let silence = 0
  for (let i = 1; i < chunks.length; i++) {
    silence += Math.max(0, chunks[i].start - chunks[i - 1].end)
  }
  return silence
}

/** Population standard deviation, used for answer-length consistency. */
function standardDeviation(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export function computeParaverbal(
  answers: ReadonlyArray<AnswerTiming>,
): ParaverbalResult | null {
  const usable = answers.filter(
    (answer) => answer.durationSeconds > 0 && answer.chunks.length > 0,
  )
  // One answer is not a delivery profile, and pretending otherwise would put
  // a confident-looking chart on a recruiter's screen with nothing behind it.
  if (usable.length === 0) return null

  const allText = usable
    .flatMap((answer) => answer.chunks.map((chunk) => chunk.text))
    .join(' ')
  const words = countWords(allText)
  const totalSpeakingSeconds = usable.reduce(
    (sum, answer) => sum + answer.durationSeconds,
    0,
  )
  const wordsPerMinute =
    totalSpeakingSeconds > 0 ? (words / totalSpeakingSeconds) * 60 : 0

  const fillerPerHundredWords = words > 0 ? (countFillers(allText) / words) * 100 : 0

  const silenceRatio =
    totalSpeakingSeconds > 0
      ? usable.reduce((sum, answer) => sum + silenceSeconds(answer.chunks), 0) /
        totalSpeakingSeconds
      : 0

  const usageRatios = usable.map((answer) =>
    answer.maxResponseSeconds > 0
      ? answer.durationSeconds / answer.maxResponseSeconds
      : 0,
  )
  const meanUsage =
    usageRatios.reduce((sum, ratio) => sum + ratio, 0) / usageRatios.length

  const durations = usable.map((answer) => answer.durationSeconds)
  const meanDuration =
    durations.reduce((sum, value) => sum + value, 0) / durations.length
  const coefficientOfVariation =
    meanDuration > 0 ? standardDeviation(durations) / meanDuration : 0

  const dimensions: Array<ParaverbalDimension> = [
    {
      key: 'pace',
      // Comfortable conversational French sits around 130-160 words a minute.
      measure: round1(wordsPerMinute),
      score: bandScore(wordsPerMinute, {
        idealLow: 120,
        idealHigh: 170,
        hardLow: 60,
        hardHigh: 240,
      }),
    },
    {
      key: 'fluency',
      measure: round1(fillerPerHundredWords),
      // Some hesitation is human; two per hundred words is unremarkable.
      score: bandScore(fillerPerHundredWords, {
        idealLow: 0,
        idealHigh: 2,
        hardLow: -1,
        hardHigh: 10,
      }),
    },
    {
      key: 'pauses',
      measure: round1(silenceRatio * 100),
      score: bandScore(silenceRatio, {
        idealLow: 0,
        idealHigh: 0.15,
        hardLow: -1,
        hardHigh: 0.6,
      }),
    },
    {
      key: 'concision',
      measure: round1(meanUsage * 100),
      // Answering in five seconds and running to the buzzer every time are
      // both signals; using half to four-fifths of the time is the sweet spot.
      score: bandScore(meanUsage, {
        idealLow: 0.4,
        idealHigh: 0.85,
        hardLow: 0.05,
        hardHigh: 1.05,
      }),
    },
    {
      key: 'consistency',
      measure: round1(coefficientOfVariation * 100),
      score: bandScore(coefficientOfVariation, {
        idealLow: 0,
        idealHigh: 0.35,
        hardLow: -1,
        hardHigh: 1.2,
      }),
    },
    {
      key: 'engagement',
      measure: round1(totalSpeakingSeconds),
      score: bandScore(meanUsage, {
        idealLow: 0.35,
        idealHigh: 1,
        hardLow: 0.02,
        hardHigh: 1.5,
      }),
    },
  ]

  return {
    dimensions,
    wordsPerMinute: round1(wordsPerMinute),
    totalSpeakingSeconds: Math.round(totalSpeakingSeconds),
  }
}
