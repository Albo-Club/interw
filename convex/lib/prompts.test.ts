import { describe, expect, it } from 'vitest'

import { antiDiscriminationClause, reportPrompt } from './prompts'

const input = {
  language: 'fr' as const,
  jobTitle: 'Backend Engineer',
  criteria: [
    { label: 'Technical depth', description: null, weight: 60 },
    { label: 'Ownership', description: null, weight: 40 },
  ],
  answers: [
    {
      question: 'Tell me about a migration you led.',
      transcript: "J'ai dirigé la migration vers Postgres.",
    },
  ],
}

describe('the evaluation prompt', () => {
  /**
   * The transcript has to leave the deployment — it is what is being assessed.
   * The name does not have to go with it: nothing in the report needs it, the
   * recruiter knows whose report they opened, and sending it turned an
   * interview transcript into a named one at a third-party provider for no
   * gain at all.
   */
  it('does not name the candidate', () => {
    const { system, user } = reportPrompt(input)
    const sent = `${system}\n${user}`
    expect(sent).not.toMatch(/Candidate:/)
    expect(sent).toContain('Backend Engineer')
    expect(sent).toContain('migration vers Postgres')
  })

  /** Never removed to shorten the prompt. See CLAUDE.md § AI and hiring. */
  it('carries the anti-discrimination clause', () => {
    const { system } = reportPrompt(input)
    expect(system).toContain(antiDiscriminationClause())
  })
})
