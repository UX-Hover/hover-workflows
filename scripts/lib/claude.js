import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function ask(systemPrompt, userPrompt, maxTokens = 2000) {
  const message = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })
  if (message.stop_reason === 'max_tokens') {
    console.error(
      `Claude response was truncated at max_tokens=${maxTokens} — output is incomplete. Raise max_tokens.`
    )
  }
  return message.content[0].text
}
