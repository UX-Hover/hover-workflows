import Anthropic from '@anthropic-ai/sdk'
import { appendFileSync } from 'node:fs'
import path from 'node:path'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Usage accounting ────────────────────────────────────────────────────────
// Every request is tagged (console "user_id" column) and its usage is logged;
// on exit the run prints a cost line (::notice) and a table in the Actions
// Summary tab. Prices are list, USD per million tokens, keyed by the model
// the API reports back — a run may mix models.
const PRICES = {
  'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
}
// Everything runs on Sonnet 5 (decision 2026-09-09, cost: the review loop
// measured $1.82 cached on Opus vs ~$0.80 projected on Sonnet). The two
// constants stay separate so the review loop can be flipped back alone if the
// eval harness shows Sonnet losing known findings. Reference Opus review of
// mademoiselleculotte#18 (cached) kept in the session scratchpad for comparison.
const MODEL_ONESHOT = 'claude-sonnet-5'
const MODEL_AGENTIC = 'claude-sonnet-5'
const TASK = path.basename(process.argv[1] ?? '', '.js').replace(/^generate-/, '') || 'unknown'
export const REQUEST_TAG = `${process.env.REPO ?? 'local'}${process.env.PR_NUMBER ? `#${process.env.PR_NUMBER}` : ''}:${TASK}`

const totals = { requests: 0, input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0, models: new Set() }

function record(message) {
  const u = message.usage ?? {}
  const row = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
  }
  const price = PRICES[message.model] ?? PRICES[MODEL_AGENTIC]
  const cost =
    (row.input * price.input + row.output * price.output + row.cache_write * price.cache_write + row.cache_read * price.cache_read) / 1e6
  totals.requests++
  totals.cost += cost
  totals.models.add(message.model)
  for (const k of Object.keys(row)) totals[k] += row[k]
  console.log(
    `[claude] req ${totals.requests} (${message.model}): in=${row.input} out=${row.output} cache_write=${row.cache_write} cache_read=${row.cache_read} stop=${message.stop_reason} $${cost.toFixed(4)}`
  )
}

export function usageSummary() {
  const cost = totals.cost
  const models = [...totals.models].join(', ') || '-'
  const line = `${models} · ${totals.requests} req · in ${totals.input.toLocaleString('en-US')} · out ${totals.output.toLocaleString('en-US')} · cache w/r ${totals.cache_write.toLocaleString('en-US')}/${totals.cache_read.toLocaleString('en-US')} · $${cost.toFixed(4)}`
  const markdown = [
    `### Claude usage — \`${REQUEST_TAG}\``,
    '',
    '| Model | Requests | Input | Output | Cache write | Cache read | **Cost (USD)** |',
    '|---|---|---|---|---|---|---|',
    `| ${models} | ${totals.requests} | ${totals.input.toLocaleString('en-US')} | ${totals.output.toLocaleString('en-US')} | ${totals.cache_write.toLocaleString('en-US')} | ${totals.cache_read.toLocaleString('en-US')} | **$${cost.toFixed(4)}** |`,
    '',
  ].join('\n')
  return { cost, line, markdown }
}

process.on('exit', () => {
  if (!totals.requests) return
  const { line, markdown } = usageSummary()
  console.log(`::notice title=Claude usage ${REQUEST_TAG}::${line}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown) } catch {}
  }
})

// Opus 5 thinks by default. Disabling it is only accepted at effort `high` or
// below (400 at xhigh/max) — we leave effort at its default `high`.
// Trade-off: with thinking off, Opus 5 can leak `<thinking>` tags into the
// visible response. Our output goes straight into PR bodies and comments, so
// the prompts carry a no-internal-XML rule and stripInternalTags() below is the
// belt-and-braces backstop.
export async function ask(systemPrompt, userPrompt, maxTokens = 8000) {
  const message = await client.messages.create({
    model: MODEL_ONESHOT,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    metadata: { user_id: REQUEST_TAG },
  })
  record(message)

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
  // Prompt caching for the loop. The prefix (tools → system → the context dump
  // in messages[0]) is identical on every iteration and is ~95% of each
  // request; explicit breakpoints make it a guaranteed cache read at 0.1×.
  // Top-level cache_control then auto-marks the last block of each request so
  // the growing tail (tool calls + results) is read back next turn too.
  // Verified in the logs by cache_read growing turn over turn.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: userPrompt, cache_control: { type: 'ephemeral' } }] },
  ]
  const system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]

  for (let i = 0; i < maxIterations; i++) {
    const message = await client.messages.create({
      model: MODEL_AGENTIC,
      max_tokens: maxTokens,
      system,
      tools,
      messages,
      cache_control: { type: 'ephemeral' },
      metadata: { user_id: REQUEST_TAG },
    })
    record(message)

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
