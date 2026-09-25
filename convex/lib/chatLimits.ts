/**
 * The longest message a recruiter may send the assistant. A user message is
 * stored and sent to a paid model on every later turn of the thread, and the
 * rate limiter counts messages, not their size.
 *
 * Shared by the mutation that enforces it (`convex/chat.ts`) and the composer
 * that counts it (`src/components/ai/AiPanel.tsx`), so the two cannot drift.
 */
export const PROMPT_MAX = 8_000
