import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function ask(systemPrompt, userPrompt, maxTokens = 8000) {
  const message = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  // Safety classifiers can decline a request: HTTP 200 with an empty/partial
  // content array. Check before reading content.
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? 'unknown'
    throw new Error(`Claude declined the request (stop_reason: refusal, category: ${category})`)
  }

  // Opus 5 thinks by default, so content[0] is a `thinking` block whose .text is
  // undefined — reading it blindly yields "empty response". Take the text blocks.
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  if (message.stop_reason === 'max_tokens') {
    // max_tokens now caps thinking + response text together, so a budget that
    // was fine before thinking was on can be spent before any text is emitted.
    console.error(
      `Claude response was truncated at max_tokens=${maxTokens} — output is incomplete (thinking and text share this budget). Raise max_tokens.`
    )
  }

  return text
}
