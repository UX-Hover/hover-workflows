import { parse } from 'yaml'

const SUPPORTED_ACTIONS = new Set(['navigate', 'click', 'check_element', 'assert_text', 'assert_visible'])
const VIEWPORTS = new Set(['desktop', 'mobile', 'both'])
// [produit-opt-in], {staging}, {handle-...}
const URL_PLACEHOLDER_RE = /\[[\w-]+\]|\{[\w-]+\}/
// [section-id], {x}, descriptive pseudo-selectors like [Add to cart button],
// or any bracket containing an unquoted space (real CSS attribute selectors quote their values)
const SELECTOR_PLACEHOLDER_RE = /\[(section-id|block-id)\]|\{[\w-]+\}|\[[A-Z][^\]]*\]|\[[^\]"']*\s[^\]"']*\]/
const CONDITIONAL_RE = /\bsi\b|\bsinon\b|\bselon\b/i

export function lintQaYaml(markdown, { allowedHandles = [] } = {}) {
  const allowed = new Set(allowedHandles)
  const fence = markdown.match(/```ya?ml\n([\s\S]*?)```/)
  if (!fence) return { errors: ['no fenced YAML block found in the output'] }

  let doc
  try {
    doc = parse(fence[1])
  } catch (err) {
    return { errors: [`YAML parse error: ${err.message}`] }
  }
  if (!doc || !Array.isArray(doc.steps) || doc.steps.length === 0) {
    return { errors: ['YAML has no `steps` list'] }
  }

  const errors = []
  doc.steps.forEach((step, i) => {
    const at = `steps[${i}] (${step.action ?? 'no action'})`
    if (!SUPPORTED_ACTIONS.has(step.action)) {
      errors.push(`${at}: unsupported action — allowed: ${[...SUPPORTED_ACTIONS].join(', ')}`)
    }
    if (!VIEWPORTS.has(step.viewport)) {
      errors.push(`${at}: viewport must be desktop, mobile or both (got "${step.viewport}")`)
    }
    if (step.action === 'navigate') {
      if (!step.url) {
        errors.push(`${at}: navigate step without url`)
      } else if (URL_PLACEHOLDER_RE.test(step.url)) {
        errors.push(
          `${at}: placeholder in url "${step.url}" — use a real handle from the qa block of project-specs.md, or move the check to regression`
        )
      } else if (allowed.size) {
        const m = step.url.match(/\/products\/([\w.-]+)/)
        if (m && !allowed.has(m[1])) {
          errors.push(
            `${at}: product handle "${m[1]}" is not in the qa block of project-specs.md — allowed handles: ${[...allowed].join(', ')}`
          )
        }
      }
    } else {
      if (!step.selector) {
        errors.push(`${at}: ${step.action} step without selector`)
      } else if (SELECTOR_PLACEHOLDER_RE.test(step.selector)) {
        errors.push(
          `${at}: placeholder selector "${step.selector}" — resolve a real selector from the branch code, or move the check to regression`
        )
      }
    }
    const freeText = `${step.assertion ?? ''} ${step.expected ?? ''}`
    if (CONDITIONAL_RE.test(freeText)) {
      errors.push(
        `${at}: conditional assertion "${(step.assertion || step.expected || '').slice(0, 80)}" — split into two steps on two distinct products from the qa block`
      )
    }
  })

  return { errors }
}
