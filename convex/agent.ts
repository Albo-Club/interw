import { mistral } from '@ai-sdk/mistral'
import { Agent, stepCountIs } from '@convex-dev/agent'

import { components } from './_generated/api'
import { recruiterTools } from './recruiterTools'
import { COMPLETION_MODEL } from './lib/ai'
import { BASE_INSTRUCTIONS } from './lib/instructions'

/**
 * The AI SDK reads `MISTRAL_API_KEY` and Mistral's base URL on its own, so the
 * assistant shares the interview pipeline's provider, model and key with
 * nothing here to configure. Why it is not its own provider any more:
 * `KNOWN_ISSUES.md` § "The chat agent had its own provider, and its own key".
 */
export const chatModel = mistral.chat(COMPLETION_MODEL)

export const chatAgent = new Agent(components.agent, {
  name: 'interw',
  languageModel: chatModel,
  // Per-message system prompt (route/org context) is layered on top at
  // stream time via `buildInstructions` in convex/chat.ts.
  instructions: BASE_INSTRUCTIONS,
  tools: recruiterTools,
  // Room for a multi-step loop: resolve the role, list its candidates, read a
  // report, then answer.
  stopWhen: stepCountIs(10),
})
