import { anthropic } from '@ai-sdk/anthropic'
import { Agent, stepCountIs } from '@convex-dev/agent'

import { components } from './_generated/api'
import { recruiterTools } from './recruiterTools'
import { BASE_INSTRUCTIONS } from './lib/instructions'

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5'

export function getModel() {
  return anthropic.chat(ANTHROPIC_MODEL)
}

export const chatAgent = new Agent(components.agent, {
  name: 'interw',
  languageModel: getModel(),
  // Per-message system prompt (route/org context) is layered on top at
  // stream time via `buildInstructions` in convex/chat.ts.
  instructions: BASE_INSTRUCTIONS,
  tools: recruiterTools,
  // Room for a multi-step loop: resolve the role, list its candidates, read a
  // report, then answer.
  stopWhen: stepCountIs(10),
})
