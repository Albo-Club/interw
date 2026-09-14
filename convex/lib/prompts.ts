/**
 * Every prompt the product sends to a model, in one reviewable place.
 *
 * Written in English and parameterised by the interview language, rather than
 * hardcoded French as in the previous build — that was listed as debt there,
 * and it made an English-language project impossible. The model is told which
 * language to answer in; the source stays in the language the rest of the
 * codebase is written in, per CLAUDE.md.
 *
 * Two rules run through all of them, and both are obligations rather than
 * style: every claim must be anchored to a quote the candidate actually said,
 * and no assessment may rest on origin, age, gender, appearance, family
 * situation, health or any other protected characteristic.
 */

export type PromptLanguage = 'fr' | 'en'

const LANGUAGE_NAME: Record<PromptLanguage, string> = {
  fr: 'French',
  en: 'English',
}

/** Shared preamble: the model is an evaluator, and it is accountable. */
export function antiDiscriminationClause(): string {
  return [
    'Never assess, mention or infer origin, ethnicity, age, gender, religion,',
    'family situation, health, disability, physical appearance or accent.',
    'If the transcript touches on any of them, ignore it entirely — it is not',
    'evidence. Judge only what the candidate demonstrated about the work.',
  ].join(' ')
}

export type JobImportPromptInput = {
  language: PromptLanguage
  pageText: string
  questionCount: number
  criteriaCount: number
}

/**
 * Turn a job ad into a draft interview.
 *
 * The structure is fixed — a warm opener, role-specific middle, an open
 * closer — because that shape is what makes a candidate's first answer usable
 * instead of a nervous throat-clearing.
 */
export function jobImportPrompt(input: JobImportPromptInput): {
  system: string
  user: string
} {
  const language = LANGUAGE_NAME[input.language]
  return {
    system: [
      `You design structured pre-screening interviews. Write every user-facing`,
      `string in ${language}.`,
      '',
      'Question list structure, in this order:',
      '1. One warm opening question that puts the candidate at ease and asks',
      '   them to introduce themselves briefly.',
      `2. ${input.questionCount - 2} core questions: open, behavioural or`,
      '   situational, and SPECIFIC to this ad — its missions, its skills, its',
      '   sector. No generic "tell me about yourself" or "what are your',
      '   qualities" in the core.',
      '3. One closing question that hands the floor back to the candidate.',
      '',
      'Rules:',
      `- Exactly ${input.questionCount} questions in total, opener and closer`,
      '  included.',
      `- Exactly ${input.criteriaCount} weighted evaluation criteria, calibrated`,
      '  on the key skills in the ad. Weights are integers summing to 100.',
      '- A question must be answerable out loud in under two minutes.',
      `- ${antiDiscriminationClause()}`,
      '',
      'Return JSON only, matching the provided schema.',
    ].join('\n'),
    user: [
      'Here is a job ad extracted from a web page:',
      '',
      '---',
      input.pageText,
      '---',
      '',
      'Produce:',
      '- a short internal project title (role + company if you can find it)',
      '- the public-facing job title',
      `- exactly ${input.questionCount} questions`,
      `- exactly ${input.criteriaCount} weighted criteria summing to 100`,
    ].join('\n'),
  }
}
