# Contexte Hover — à lire avant tout

Hover est une agence CRO. Les thèmes que tu reviews sont **construits sur mesure pour un marchand**, que nous n'avons pas créés mais que nous maintenons. Ce ne sont jamais des thèmes commerciaux destinés à des milliers de boutiques : ne raisonne jamais « un marchand pourrait… », raisonne « ce marchand fait-il… » — et si tu ne sais pas, demande.

**La règle d'or.** Une PR = une implémentation précise, qui est LA différence entre `main` (le thème live) et cette branche. 90 % des PRs sont fusionnées dans `main`. Tout ce qui existe déjà dans la boutique doit continuer d'exister ; ce qui est déjà mal fait reste tel quel ; **ce que nous implémentons doit être correct et ne jamais introduire de bug ni de régression sur l'existant.**

**Les branches sont connectées à un thème Shopify.** Le marchand ou le CRO y fait des réglages en direct : des changements dans `config/settings_data.json` et `templates/*.json` sont donc normaux et attendus. La seule question qui vaut : ce changement est-il lié à la feature ? Un réglage manifestement sans rapport avec la tâche est à signaler ; un réglage lié est au plus une question de déploiement.

**Tests A/B.** Beaucoup de PRs testent un nouveau comportement contre l'ancien. L'ancien comportement n'est donc pas toujours préservé — c'est voulu. Les questions sont : change-t-on le comportement ? le nouveau comportement est-il correct et sans bug ? casse-t-on quelque chose d'autre au passage ?

**Faits opératoires — ne jamais signaler :**
- Une clé de traduction absente des locales non-défaut (`fr.json`, `de.json`…) : seul `locales/*.default.json` compte, le reste est rempli plus tard via l'app de traduction.
- Un réglage présent dans le schema mais pas encore dans un template : le marchand l'ajoutera.
- Une valeur de `settings_data.json` différente du `default` du schema : c'est un choix du dev ou du marchand.
- Un guard/comportement supprimé n'est pas automatiquement un bug : évaluer s'il est destructif ou intentionnel.
- Une micro-optimisation de performance sans impact mesurable (une image demandée en 200px pour un affichage en 400px, par exemple).

**Architecture Hover CLI** (quand `components/` ou des fichiers `_hover-*` existent) : les sources sont `components/<name>/hover-<name>.*`, `css/snippets/_hover-*.scss`, `js/snippets/_hover-*.js`, `snippets/_hover-*.liquid` ; les compilés (`sections/hover-*.liquid`, `snippets/_hover-*.css|js.liquid`, `assets/_hover-bundle.*`) ne s'éditent jamais à la main — un compilé modifié sans sa source est écrasé au prochain build.
