# Project specs

Repo-level notes for this client's theme. The `## QA` block below is read by
Hover's automated QA bot on every labelled PR — keep it accurate.

## QA

The `qa` block tells the bot which products it is allowed to open and which
Shopify template each one is bound to. Two rules make this reliable:

- A product is **assigned to one template**, and that assignment is stable — it
  does not change. So the mapping below stays valid over time.
- What a template **contains** (its blocks/sections) changes often, so it is
  **not** declared here. The bot reads the actual blocks and selectors from the
  branch code at run time. Never hardcode features.

The bot only tests a changed section on a product whose template contains it
(the bot cross-references the templates that reference the changed section). If
no test product uses that template, the check is moved to `regression` instead
of guessing a handle.

Fields:

- `handle` — the product handle (the `/products/<handle>` slug). Must be a real,
  in-stock product on the store.
- `template` — the product's Shopify template suffix (Online Store → the product
  → *Theme template* dropdown). Use `default` for the base `product` template,
  or the suffix for a custom one (`templates/product.subscription.json` →
  `subscription`).
- `pages` — key non-product paths the bot may navigate to directly.

```yaml
qa:
  products:
    - handle: mon-produit-standard
      template: default
    - handle: mon-produit-abonnement
      template: subscription
  pages:
    home: /
    collection: /collections/all
```
