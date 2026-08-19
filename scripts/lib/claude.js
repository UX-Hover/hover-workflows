import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Opus 5 thinks by default. Disabling it is only accepted at effort `high` or
// below (400 at xhigh/max) — we leave effort at its default `high`.
// Trade-off: with thinking off, Opus 5 can leak `<thinking>` tags into the
// visible response. Our output goes straight into PR bodies and comments, so
// the prompts carry a no-internal-XML rule and stripInternalTags() below is the
// belt-and-braces backstop.
export async function ask(systemPrompt, userPrompt, maxTokens = 8000) {
  const message = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  // Safety classifiers can decline a request: HTTP 200 with an empty/partial
  // content array. Check before reading content.
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? 'unknown'
    throw new Error(`Claude declined the request (stop_reason: refusal, category: ${category})`)
  }

  // Read text blocks rather than content[0]: even with thinking disabled the
  // response is a block array, and a stray non-text block would yield undefined.
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  if (message.stop_reason === 'max_tokens') {
    console.error(
      `Claude response was truncated at max_tokens=${maxTokens} — output is incomplete. Raise max_tokens.`
    )
  }

  return stripInternalTags(text)
}

// With thinking disabled, Opus 5 occasionally emits internal reasoning tags into
// the visible response. This output is published to PRs verbatim, so drop any
// wrapped block and strip stray opening/closing tags before it ships.
function stripInternalTags(text) {
  const cleaned = text
    .replace(/<(thinking|antml:thinking|internal)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(thinking|antml:thinking|internal)\b[^>]*>/gi, '')
    .trim()

  if (cleaned !== text) {
    console.error('Stripped internal reasoning tags from the model output before publishing.')
  }
  return cleaned
}
