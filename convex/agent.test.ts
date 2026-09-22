import { describe, expect, it } from 'vitest'

import { chatModel } from './agent'
import { COMPLETION_MODEL } from './lib/ai'

/**
 * Nothing in the type system stops `mistral.chat` from becoming another
 * provider's import, which is how the assistant kept its own for a release —
 * see `KNOWN_ISSUES.md` § "The chat agent had its own provider, and its own
 * key". This is what makes that a failing build.
 */
describe('chat agent model', () => {
  it("runs on Mistral, on the pipeline's model", () => {
    expect(chatModel.provider).toBe('mistral.chat')
    expect(chatModel.modelId).toBe(COMPLETION_MODEL)
  })
})
