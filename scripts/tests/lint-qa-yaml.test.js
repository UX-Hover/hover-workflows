import test from 'node:test'
import assert from 'node:assert/strict'
import { stringify } from 'yaml'
import { lintQaYaml } from '../lib/lint-qa-yaml.js'

const qa = { preview_theme_id: '123', urls: ['/products/test'] }

function lintFeature(feature, codeCorpus = '') {
  const doc = {
    qa,
    features: [{ name: 'Parcours produit', priority: 1, device: 'both', steps: ['Ouvrir la fiche produit'], ...feature }],
  }
  return lintQaYaml('```yaml\n' + stringify(doc) + '```', { qaBlock: qa, codeCorpus }).errors
}

for (const key of ['needs', 'needs_absent']) {
  for (const selector of ['rtp-frame-{{ section.id }}', '#rtp-frame-{{- section.id -}}', '[id="rtp-{% echo section.id %}"]']) {
    test(`${key} rejects unrendered Liquid even when present verbatim in source: ${selector}`, () => {
      const errors = lintFeature({ [key]: selector }, selector)
      assert.ok(errors.some(e => e.includes('unrendered Liquid')), errors.join('\n'))
    })
  }

  test(`${key} accepts a stable component selector beside a dynamic id`, () => {
    assert.deepEqual(lintFeature({ [key]: '.rtp-frame' }, '<div id="rtp-frame-{{ section.id }}" class="rtp-frame">'), [])
  })
}

test('preserves natural-language observations and exact cart comparisons', () => {
  assert.deepEqual(lintFeature({
    needs: 'hover-product-bundles',
    steps: [
      'Relever le titre du produit, la variante sélectionnée, la quantité et le prix affiché',
      'Cliquer sur « Ajouter au panier »',
      'Vérifier que la ligne ajoutée correspond au produit et à la variante relevés',
      'Vérifier que la quantité ajoutée et le prix unitaire correspondent aux valeurs relevées',
    ],
  }, '<hover-product-bundles>'), [])
})

test('still rejects invented routing selectors', () => {
  assert.ok(lintFeature({ needs: '.invented-component' }, '<div class="real-component">').some(e => e.includes('does not appear')))
})

test('autorise un doute visuel sur une classe appliquee', () => {
  const errors = lintFeature({
    regression: ['La classe appliquee a l image de contact ne semble pas stylee correctement — verifier son habillage.'],
  })
  assert.deepEqual(errors, [])
})

test('still rejects structured actions in the natural-language contract', () => {
  assert.ok(lintFeature({ steps: [{ action: 'click', selector: '.buy' }] }).some(e => e.includes('plain French sentence')))
})

test('still rejects generated Shopify section instance ids', () => {
  assert.ok(lintFeature({ needs: '#shopify-section-123' }).some(e => e.includes('instance id')))
})
