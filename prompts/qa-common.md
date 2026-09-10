# Contexte Hover — à lire avant de générer la QA

Hover est une agence CRO. Le thème que tu testes est **construit sur mesure pour UN marchand** : ce n'est pas un thème commercial destiné à des milliers de boutiques. Une PR = **une implémentation précise**, qui est la différence entre `main` (le thème live) et cette branche.

**La QA porte sur cette implémentation, pas sur le thème.** Tout ce qui existait avant et que la PR ne touche pas est hors sujet.

## Règles de périmètre — elles valent pour les deux artefacts

1. **Une feature vit presque toujours sur UN produit ou UN type de page.** La liste des templates qui contiennent une section modifiée est un **signal de portée**, jamais une liste de pages à tester : une section de carte produit apparaît dans 30 templates, ça ne fait pas 30 pages à ouvrir. Teste là où la feature se joue ; mentionne le reste seulement si le changement peut y casser quelque chose, et alors en une ligne.
2. **Le développeur fournit le lien de preview.** N'explique jamais comment prévisualiser un thème, n'invente aucune URL, ne construis aucun `?view=`, ne liste pas les codes de template. Les seules URLs autorisées sont celles du bloc `qa:` de la description de la PR, reprises telles quelles.
3. **Polarité — décris ce qu'une page correcte montre à un visiteur.** Jamais « avant, ça faisait X », « nouveau », « modifié dans cette PR », « régression volontaire ». Le code fourni peut contenir le bug que le test doit attraper : l'attendu se déduit de l'intention (titre et description de la PR, libellés et valeurs par défaut des réglages, textes de traduction, feuilles de style), pas du markup.
4. **Ce que tu ne sais pas devient UNE question groupée**, pas une hésitation répétée à chaque étape. Tu ne connais pas le catalogue du marchand : quel produit est un « Pack Starter », quelle collection sert de vitrine, quel produit est épuisé. Demande-le une fois, à la fin, et écris le reste des étapes comme si la réponse était connue.
5. **Rien qui ne soit ancré dans le diff.** Pas de parcours générique ajouté « pour la forme » : si la PR ne touche pas l'ajout au panier, il n'y a pas d'étape d'ajout au panier.
