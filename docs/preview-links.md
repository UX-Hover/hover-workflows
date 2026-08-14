# Comment prévisualiser une page produit (staging / thème de test)

Ce guide explique comment construire un lien pour prévisualiser une page produit sur un thème de test, sans rien casser sur la boutique en ligne (les clients ne voient jamais ces liens).

## Les 4 ingrédients d'un lien de prévisualisation

| Élément | C'est quoi | Exemple |
|---|---|---|
| **URL de la boutique** | L'adresse du site | `https://shop.pimpant.com` |
| **Handle du produit** | L'identifiant du produit dans l'URL (ce qui suit `/products/`) | `pack-decouverte-pimpant-1` |
| **`preview_theme_id`** | L'identifiant du thème de test à prévisualiser (fourni par l'équipe pour chaque PR/branche) | `197348524367` |
| **`?view=`** | Le code d'une version spécifique de la page produit (utile quand plusieurs "templates" existent pour différents types de produits) | `?view=nettoyant-wc` |

Ces éléments se combinent dans une seule URL. Pas besoin de tout utiliser à chaque fois — voir les cas ci-dessous.

---

## Cas 1 — Voir un produit sur le thème de test (le plus courant)

**Format :**
```
https://[boutique]/products/[handle-du-produit]?preview_theme_id=[ID_DU_THEME]
```

**Exemples avec nos produits :**
```
https://shop.pimpant.com/products/pack-decouverte-pimpant-1?preview_theme_id=197348524367
https://shop.pimpant.com/products/pack-quotidien-lessive?preview_theme_id=197348524367
```

> Remplacez `197348524367` par l'ID du thème de test fourni pour la branche/PR que vous testez — il change à chaque fois.

Ce lien montre le produit **avec le thème de test**, exactement comme si le thème de test était déjà en ligne — sans que les vrais visiteurs du site ne le voient.

---

## Cas 2 — Voir une version spécifique d'une page produit (`?view=`)

Certains produits utilisent un affichage différent (« template ») de la page produit standard — par exemple une mise en page différente pour les produits en kit, en abonnement, ou pour une catégorie précise. Le paramètre `?view=` permet de forcer l'affichage d'une version précise, **sans avoir besoin de changer un réglage dans l'administration**.

**Format :**
```
https://[boutique]/products/[handle-du-produit]?view=[code-de-la-version]?preview_theme_id=[ID_DU_THEME]
```

**Exemple :**
Si l'équipe indique que la version à tester s'appelle `nettoyant-wc` :
```
https://shop.pimpant.com/products/pack-decouverte-pimpant-1?view=nettoyant-wc&preview_theme_id=197348524367
```

> ⚠️ Notez le `&` (et non `?`) avant `preview_theme_id` quand on combine les deux paramètres — un seul `?` au tout début de la liste de paramètres, ensuite des `&` pour chaque paramètre supplémentaire.

**Exemple correct avec les deux paramètres combinés :**
```
https://shop.pimpant.com/products/pack-quotidien-lessive?view=kit-lessive-universelle&preview_theme_id=197348524367
```

Le code après `?view=` (ici `kit-lessive-universelle`, `nettoyant-wc`, etc.) est toujours indiqué par l'équipe dans les instructions de test — vous n'avez jamais à le deviner.

---

## Cas 3 — Voir un produit tel qu'il est actuellement en ligne (sans thème de test)

Si vous voulez juste comparer avec la version actuelle du site, retirez simplement `preview_theme_id` :
```
https://shop.pimpant.com/products/pack-decouverte-pimpant-1
```

---

## Comment trouver quel "template" (quelle version de page) un produit utilise déjà

Si vous voulez savoir **quelle version de page produit un produit utilise actuellement** (sans passer par `?view=`), c'est visible directement dans l'administration Shopify :

1. Aller dans l'**administration Shopify** (back-office).
2. Cliquer sur **Produits**, puis ouvrir le produit qui vous intéresse.
3. Faire défiler la page jusqu'à la section **Modèle de page** (ou *"Template"*, selon la langue de l'interface), généralement dans la colonne de droite.
4. Le nom affiché là (par exemple `product.nettoyant-wc` ou `product.kit-lessive-universelle`) correspond au code à utiliser après `?view=` — il suffit de retirer le préfixe `product.` pour obtenir le code (`nettoyant-wc`, `kit-lessive-universelle`).

**Exemple concret :**
- Dans l'administration, le champ "Modèle de page" du produit affiche `product.nettoyant-wc`.
- Le lien de prévisualisation correspondant est donc :
  ```
  https://shop.pimpant.com/products/[handle-du-produit]?view=nettoyant-wc&preview_theme_id=[ID_DU_THEME]
  ```

---

## Résumé rapide (pense-bête)

| Je veux... | J'utilise... |
|---|---|
| Voir un produit sur le thème de test | `?preview_theme_id=...` |
| Voir une version précise de la page produit | `?view=...` |
| Voir une version précise **sur le thème de test** | `?view=...&preview_theme_id=...` |
| Voir la version actuelle en ligne (sans thème de test) | Aucun paramètre, juste l'URL du produit |
| Savoir quelle version un produit utilise déjà | Admin → Produits → [produit] → champ "Modèle de page" |
