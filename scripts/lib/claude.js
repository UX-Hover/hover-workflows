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

// Agentic variant: same model, but the model can call local tools (repo
// exploration) in a manual request/execute loop before writing its final
// answer. Thinking stays ADAPTIVE here (the Opus 5 default): with thinking
// disabled a tool call can be written into visible text instead of a
// tool_use block — fatal in a loop. Thinking blocks are replayed by
// appending the full response.content each turn, as the API requires.
export async function askWithTools(systemPrompt, userPrompt, { tools, execute }, { maxTokens = 16000, maxIterations = 60 } = {}) {
  const messages = [{ role: 'user', content: userPrompt }]

  for (let i = 0; i < maxIterations; i++) {
    const message = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      messages,
    })

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unknown'
      throw new Error(`Claude declined the request (stop_reason: refusal, category: ${category})`)
    }

    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content })
      continue
    }

    const toolUses = message.content.filter((b) => b.type === 'tool_use')
    if (message.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (message.stop_reason === 'max_tokens') {
        console.error(`askWithTools: response truncated at max_tokens=${maxTokens}`)
      }
      return stripInternalTags(text)
    }

    // Replay the WHOLE assistant content (thinking blocks included), then
    // answer every tool_use in a single user message.
    messages.push({ role: 'assistant', content: message.content })
    const results = []
    for (const tu of toolUses) {
      let content
      let isError = false
      try {
        content = String(execute(tu.name, tu.input) ?? '')
      } catch (err) {
        content = `Erreur: ${err.message}`
        isError = true
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: isError })
    }
    messages.push({ role: 'user', content: results })

    // Nearing the cap: tell the model to wrap up with what it has.
    if (i === maxIterations - 2) {
      messages.push({
        role: 'user',
        content: 'Tu approches la limite d\'outils — termine maintenant et écris la review finale avec ce que tu as vérifié.',
      })
    }
  }

  throw new Error(`askWithTools: no final answer after ${maxIterations} iterations`)
}
