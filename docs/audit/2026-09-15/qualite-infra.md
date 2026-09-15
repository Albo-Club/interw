# Audit — Infrastructure qualité (tests, CI, scripts, dépendances, build/deploy, docs)

Périmètre : `/home/user/interw`, audit en lecture seule, HEAD `b4bc755`
(branche `claude/dreamy-hamilton-5m3v1f`).

---

## Résumé

La ligne de base est verte de bout en bout : `pnpm typecheck` (exit 0),
`pnpm lint` (exit 0, 0 warning), `pnpm test` (**22 fichiers, 256 tests, 3,7 s**),
`pnpm build` (exit 0), `pnpm codegen:api:check` et `pnpm audit:access:check`
(exit 0). Le code applicatif est d'une propreté rare : zéro `any` hors fichiers
générés, zéro `@ts-ignore`, cinq `eslint-disable` tous motivés, un seul `catch {}`
résiduel, un historique git signé en 12 commits « par lot ».

La qualité des tests unitaires est réellement bonne — SigV4 validé contre le
vecteur officiel AWS, parité de locales testée clé par clé, projections candidat
testées par la négative, idempotence du pipeline testée par rejeu. Mais la
couverture s'arrête à la logique pure : **aucun test n'appelle une fonction Convex
authentifiée** (`withIdentity` : 0 occurrence), et **le test e2e du parcours
candidat exigé par le §6 n'existe pas** — `scripts/e2e-smoke.mjs` est resté
intégralement celui du template (`albo-ouvre-boite`, « items CRUD »), ne touche
ni `/s/**` ni `/r/**`, et ne tourne pas en CI.

Un défaut bloquant : `src/start.ts:12-15` pose
`Permissions-Policy: camera=(), microphone=()` sur **toutes** les réponses, ce qui
neutralise `getUserMedia` — donc l'entretien lui-même — dès la mise en production ;
et le smoke test *assert* ce header, verrouillant le bug.

CI : les bonnes choses tournent (lint, test, build, codegen, audit d'accès,
skills) mais il manque l'e2e, un budget de bundle, un seuil de couverture, et
`pnpm audit` (21 avis, dont 9 « high »). Docs : `TESTING.md` couvre bien les cinq
surfaces Interw (A→E) ; le reliquat de staleness est concentré sur le template
(items, `PROJECT_BRIEF.md`, `convex/README.md`, `CHANGELOG.md`).

---

## Constats par sévérité

### Critique

#### C1 — `Permissions-Policy: camera=(), microphone=()` tue l'entretien en production

`src/start.ts:12-15`

```ts
setResponseHeader(
  'Permissions-Policy',
  'camera=(), microphone=(), geolocation=()',
)
```

Le middleware est global (`createStart({ requestMiddleware: [securityHeaders] })`,
`src/start.ts:36-38`) : aucune exception de chemin. Or une allowlist vide `()`
signifie « aucune origine, `self` compris ». Les trois appels à
`navigator.mediaDevices.getUserMedia` du produit tomberont donc en
`NotAllowedError` :

- `src/routes/s/$token/interview.tsx:114` (enregistrement des réponses)
- `src/routes/s/$token/check.tsx:79` (test caméra/micro)
- `src/components/projects/MediaRecorderField.tsx:74` (enregistrement des
  questions par le recruteur)

Aggravant : `scripts/e2e-smoke.mjs:105` **exige** ce header
(`'permissions-policy': /camera=\(\)/`). Le seul filet automatisé qui touche les
en-têtes valide donc le défaut au lieu de le détecter. Rien dans la suite vitest
ne peut le voir : les tests ne montent jamais le serveur.

- **Conséquence** : produit inutilisable en production. Le header vient du
  template (`98e38b3`, jamais revisité après le lot 4) — c'est exactement le type
  de configuration héritée que le §7 (« dupliquer la configuration ») met en garde.
- **Correctif** : `camera=(self), microphone=(self), geolocation=()`, et corriger
  l'assertion du smoke test en `/camera=\(self\)/`. Ajouter une ligne
  `KNOWN_ISSUES.md` (le piège coûte bien plus de 30 min au prochain).
- **Confiance** : Confirmé pour le header et les appels ; Confirmé par
  spécification pour le blocage navigateur.

---

### Élevé

#### E1 — Pas de test e2e du parcours candidat ; `e2e-smoke.mjs` est resté celui du template

`scripts/e2e-smoke.mjs:1-259`

Le §6 impose : « Le parcours candidat du lot 4 livre en plus un test de bout en
bout. » Il n'existe pas. Aucune dépendance Playwright/Puppeteer (le `.gitignore`
en garde pourtant les répertoires, lignes 24-27 — vestige du template).

`e2e-smoke.mjs` est intégralement template-era :

| Ligne | Contenu |
|---|---|
| `:2` | `// Automated smoke tests for albo-ouvre-boite.` |
| `:229` | `console.log('albo-ouvre-boite smoke tests')` |
| `:133-144` | routes publiques testées : `/`, `/login`, `/register`, `/accept-invite/<garbage>` |
| `:255` | `Manual tests next: auth flow, invitations, items CRUD, AI chat, …` |

Aucune vérification de `/s/$token`, `/s/$token/check`, `/s/$token/interview`,
`/s/$token/privacy`, `/r/$shareToken`, `/app/{org}/projects`,
`/app/{org}/candidates/…`. Le cas `/s/<jeton inconnu>` — la garantie « un jeton
invalide ne révèle rien », porte du lot 3 — n'y figure pas, alors qu'il est
trivial à automatiser en HTTP pur.

- **Conséquence** : `TESTING.md` B4 annonce « All scenarios pass » pour un script
  qui ne valide aucune surface Interw. Le §8-2/3 (parcours candidat sur trois
  navigateurs, coupure réseau) reste 100 % manuel, sans même un garde-fou HTTP.
- **Correctif** : réécrire `e2e-smoke.mjs` autour des surfaces Interw (jetons
  invalides indistinguables, `noindex` sur `/s/**` et `/r/**`, en-têtes,
  `/r/<révoqué>`), puis ajouter un job CI qui lance `pnpm build && pnpm start`
  et l'exécute contre `http://localhost:3000` — cela ne demande pas de déploiement
  Convex pour la moitié des scénarios.
- **Confiance** : Confirmé.

#### E2 — Aucun test n'exerce une fonction Convex authentifiée

`convex/lib/auth.ts:107-137`, `convex/lib/projectAccess.ts:50-100`

`grep -rn "withIdentity" --include=*.test.ts` → **0 résultat**. Les seuls appels
par l'API publique dans les tests sont les deux surfaces à jeton
(`convex/candidate.test.ts:129-210`, `convex/shares.test.ts:108-153`).

`convex/lib/projectAccess.test.ts` teste `canSeeProject` / `filterVisibleProjects`
en direct — jamais `requireProjectAccess`, ni la composition
`requireProjectAccess → requireOrgMember → requireAppUser`. Donc `requireOrgMember`,
`requireOrgRole`, `requireSuperAdmin`, `requireProjectEditable`,
`requireProjectOwnerOrAdmin` n'ont **aucun test**.

- **Conséquence** : le §8-4 (« Aucune fonction Convex publique ne renvoie une
  donnée d'une autre organisation — vérifié fonction par fonction ») repose
  entièrement sur `scripts/audit-convex-access.mjs`, qui prouve qu'un garde est
  *nommé*, pas qu'il *fonctionne*. Une régression dans `requireOrgRole`
  (comparaison de rangs, `roleRank[member.role] < roleRank[minRole]`,
  `convex/lib/auth.ts:128`) passerait lint, typecheck, audit et tests.
- **Correctif** : un fichier `convex/access.test.ts` qui, pour chaque famille
  (`projects`, `sessions`, `reports`, `shares`, `organizations`, `admin`), appelle
  la fonction sous `t.withIdentity({ subject: <betterAuthId de l'org B> })` et
  attend `not_found` / `not_a_member`. Une dizaine de cas couvre 80 % du risque.
- **Confiance** : Confirmé.

#### E3 — L'audit d'accès est textuel : faux négatifs structurels

`scripts/audit-convex-access.mjs`

Le script est une bonne idée (et il attrape le cas majoritaire), mais ses limites
ne sont écrites nulle part et il est présenté dans `TESTING.md` B9 et dans
`CLAUDE.md` comme *la* garantie.

| Ligne | Faiblesse | Effet |
|---|---|---|
| `:119-121` | `namesAGuard` = `body.includes('requireOrgMember')` sur le corps entier | Un garde appelé **après** un `ctx.db.query(...)`, un garde appliqué au **mauvais `orgId`**, ou un garde cité dans un commentaire comptent tous comme protégés |
| `:62-63` | `readMembership` et `parseScope` sont dans `GUARDS` | Ces deux-là **retournent** une valeur (cf. `convex/lib/agentScope.ts:30`) ; ignorer le retour passe l'audit |
| `:37-49` | `SKIP` retire 11 modules en bloc, dont `http.ts` | `/api/chat` et `/resend-webhook` (`convex/http.ts:17-30`) sont des surfaces publiques réelles, jamais listées ni auditées |
| `:88-90` | La regex ne reconnaît que `export const X = query({` | Une fonction construite par un wrapper (`customQuery`, futur `orgQuery`) devient **invisible** — pas « non gardée », invisible |
| `:96-107` | `// access:` en commentaire suffit à exempter | Correct par design, mais rien ne limite l'usage (3 exemptions aujourd'hui, toutes légitimes et bien rédigées) |
| `:103` | Corps extrait jusqu'au premier `\n})` | Dépend de la sortie prettier ; un jour où un handler contient `\n})` en colonne 0, l'analyse est tronquée |

- **Conséquence** : l'audit donne une assurance plus forte que ce qu'il mesure.
  Combiné à E2, la propriété la plus importante du produit n'est vérifiée par
  aucun exécutable.
- **Correctif** : (a) documenter ces limites en tête du script et dans `TESTING.md`
  B9 ; (b) exiger que le garde soit **la première instruction** du handler
  (position du match < position du premier `ctx.db`) ; (c) sortir `http.ts` de
  `SKIP` et l'auditer par un mécanisme dédié ; (d) retirer `readMembership` et
  `parseScope` de `GUARDS` ou les faire lever ; (e) faire échouer le script sur
  un `export const` dont le `kind` n'est pas reconnu, plutôt que l'ignorer.
- **Confiance** : Confirmé (les faux négatifs sont démontrables par lecture ;
  aucun n'est actuellement exploité dans le code).

#### E4 — Aucun budget de bundle, alors que le §6 en impose la vérification à chaque lot

Aucune vérification de taille nulle part (`vite.config.ts` 19 lignes, pas de
`rollup-plugin-visualizer`, pas de `size-limit`, pas de job CI).

Mesure faite pour cet audit sur `.output/public/assets` (graphe d'imports statiques
depuis `interview-*`, `_token-*`, `CandidateShell-*`) :

```
candidate graph: 45 fichiers, 808 kB brut, 255 kB gzip
   579 kB  index-B5Ts4VrF.js     ← chunk partagé : client Convex, client Better Auth, sonner
    73 kB  schemas-BI2nBjLO.js   ← zod
    41 kB  i18next-C6sQAsBe.js
    10 kB  interview-cKKbaxJ0.js ← le code du parcours candidat lui-même
```

C'est un excellent résultat face aux 2,96 Mo de l'ancienne version, et la règle
ESLint `no-restricted-imports` (`eslint.config.mjs:24-70`) est le bon outil. Mais
elle ne filtre que des *groupes de composants* et cinq bibliothèques nommées :
`~/lib/*` est explicitement autorisé, et c'est par là que passent le client
Better Auth et `@sentry/react` (`src/components/candidate/InterviewCrash.tsx:7`).
Un candidat n'a aucun compte : le client Better Auth est du poids mort sur son
téléphone.

- **Conséquence** : la règle attrape la régression grossière, pas la dérive lente
  — précisément le mode de défaillance de la version précédente.
- **Correctif** : un job CI qui, après `pnpm build`, calcule le graphe candidat et
  échoue au-delà d'un seuil (p. ex. 300 kB gzip). ~30 lignes de Node, aucune
  dépendance ; le script de mesure utilisé ici peut servir de base.
- **Confiance** : Confirmé.

#### E5 — Ce que la CI ne fait pas

`.github/workflows/ci.yml`

Ce qui tourne (job `check`) : `codegen:api:check`, `audit:access:check`, `lint`,
`test`, `build` ; plus deux jobs `skills-verify` / `skills-drift`. Déclencheurs
`push: [main]` + `pull_request`. `permissions: contents: read`. Le pin pnpm est
correctement géré (pas de `version:`, lecture de `packageManager`) et bien commenté.

Absents :

| Manque | Conséquence |
|---|---|
| `pnpm audit` | 21 avis aujourd'hui, 9 « high », dont `ws` via `convex` (runtime) — invisibles |
| Budget de bundle | cf. E4 |
| Seuil de couverture (aucune config `coverage` dans `vitest.config.ts`) | On sait que 256 tests passent, pas ce qu'ils couvrent |
| E2E / smoke | cf. E1 |
| Déploiement Convex de prévisualisation | Un schéma cassé n'est vu qu'en production |
| `concurrency: cancel-in-progress` | Runs redondants sur push rapides |
| `timeout-minutes` | Un job bloqué consomme 6 h de runner |
| Actions épinglées par SHA | `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` suivent un tag mutable |
| CODEOWNERS / template de PR / preuve de branch protection | Rien dans `.github/` hors les deux workflows |

Doublon mesuré : `pnpm lint` = `tsc && eslint …` et `pnpm build` = `vite build && tsc --noEmit`.
`tsc` tourne donc **deux fois** par run (~22 s pièce ici ; eslint ~32 s, vitest ~5 s).
Durée totale estimée du job `check` : **2 min 30 – 3 min 30**. Le cache `setup-node`
porte sur le store pnpm, pas sur `node_modules/.cache/tsc` — l'incrémental
`tsBuildInfoFile` (`tsconfig.json:20-21`) ne sert donc jamais en CI.

- **Correctif** : retirer `tsc` de `build` (il est déjà dans `lint`), ajouter
  `concurrency`, `timeout-minutes: 20`, un `pnpm audit --prod --audit-level=high`,
  et mettre en cache `node_modules/.cache/tsc`.
- **Confiance** : Confirmé.

---

### Moyen

#### M1 — 21 avis de sécurité en dépendances de production

`pnpm audit --prod` : **9 high / 8 moderate / 4 low**.

| Sévérité | Paquet | Chemin | Atteignable au runtime ? |
|---|---|---|---|
| high | `ws` (<8.21.0) | `.>convex>ws` | **Oui** — client Convex côté serveur Node |
| moderate/low | `dompurify` (<3.4.13) | `.>streamdown>mermaid>dompurify` | **Oui** — `streamdown` rend la sortie du modèle dans le navigateur recruteur |
| moderate | `mermaid` (<11.16.1) ×4 | idem | Oui, même chemin |
| high | `postcss`, `nanoid`, `js-yaml` ×3, `browserslist` ×2 | `.>@tanstack/react-start>…` | Non — chaîne de build uniquement |
| low | `esbuild` | `.>@tanstack/react-start>vite>esbuild` | Non (serveur de dev) |
| low | `@ai-sdk/provider-utils` (<4.0.33) | `.>@ai-sdk/anthropic>…` | Oui |

- **Correctif** : ajouter `pnpm.overrides` pour `ws >=8.21.0` et
  `dompurify >=3.4.13` (les deux seuls chemins réellement exposés), et brancher
  `pnpm audit` en CI. Le reste se résorbera par Renovate.
- **Confiance** : Confirmé (sortie `pnpm audit --prod` reproductible).

#### M2 — Sentry est configuré mais ne collecte presque rien

`src/lib/sentry.ts:12-19`

```ts
Sentry.init({
  dsn, environment: …,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
})
```

Aucune intégration n'est enregistrée : ni `Sentry.browserTracingIntegration()`
(donc `tracesSampleRate` est inerte), ni `Sentry.replayIntegration()` (donc
`replaysOnErrorSampleRate: 1.0` ne produit jamais de replay). Par ailleurs
`pnpm build` n'émet **aucune source map** (`find .output -name '*.map'` → vide) et
il n'y a pas d'étape d'upload (`@sentry/vite-plugin` absent de `package.json`).

- **Conséquence** : les seules traces réellement remontées — dont
  `src/components/candidate/InterviewCrash.tsx:27`, le crash en plein entretien,
  c'est-à-dire l'événement le plus coûteux du produit — arriveront minifiées et
  illisibles.
- **Correctif** : soit retirer les deux options mortes (honnête), soit ajouter les
  intégrations + `build.sourcemap: 'hidden'` dans `vite.config.ts` +
  `@sentry/vite-plugin` avec `SENTRY_AUTH_TOKEN`. Ne pas activer le replay sur
  `/s/**` sans décision explicite : cela filmerait l'interface d'un entretien.
- **Confiance** : Confirmé.

#### M3 — Le seul `catch {}` restant, et il casse la règle d'effacement

`convex/users.ts:178-186`

```ts
if (appUser.avatarStorageId) {
  try {
    await ctx.storage.delete(appUser.avatarStorageId)
  } catch {
    // ignore — storage may already be gone
  }
}
await ctx.db.delete("users", appUser._id)
```

Deux règles violées : « Un `catch` journalise avec un événement nommé, ou remonte »
(§6, `CLAUDE.md`), et « Les objets sont supprimés **avant** les lignes, toujours ;
une défaillance laisse la ligne intacte » (règles domaine). Ici l'échec est avalé
**et** la ligne est supprimée ensuite — l'avatar devient orphelin sans rien pour le
retrouver. Hérité du template (`98e38b3`), non revisité au lot 8.

- **Correctif** : `catch (err) { console.warn('avatar delete failed', …); throw err }`
  ou, a minima, un `fireAndForget` avec événement nommé (le helper existe :
  `src/lib/fire-and-forget.ts`).
- **Confiance** : Confirmé.

#### M4 — Une re-réservation de segment peut orpheliner un objet

`convex/interview.ts:238-285`

`reserveSegment` recalcule `audioKey` / `videoKey` à partir de l'extension issue du
`mimeType` reçu, puis, si un segment existe déjà pour cet index, le `patch` en place
avec les nouvelles clés — sans supprimer les anciennes. Tant que le candidat reste
sur le même navigateur, l'extension est identique et l'objet est écrasé. Mais un
candidat qui reprend son entretien sur un autre appareil (Chrome `webm` →
Safari `mp4`, branche explicitement prévue dans `src/lib/media/recorder.ts`) laisse
un `q0.weba` que **plus aucune ligne ne nomme**.

- **Conséquence** : contredit l'invariant central de l'effacement (« la ligne est
  écrite avant l'envoi, en portant les clés — c'est ce qui rend l'effacement
  exact »). Un objet contenant la voix d'un candidat survit à sa demande de
  suppression. `TESTING.md` IA4 couvre le cas équivalent côté recruteur, pas
  celui-ci.
- **Correctif** : à la re-réservation, si `existing.audioKey !== audioKey`,
  planifier la suppression de l'ancienne clé (`internal.media.deleteKeys` existe
  déjà) ; et ajouter un scénario IB à `TESTING.md`.
- **Confiance** : Probable (logique confirmée par lecture ; dépend d'un changement
  de navigateur en cours d'entretien).

#### M5 — `codegen-api-types.mjs` : quatre dérives face au vrai générateur Convex

`scripts/codegen-api-types.mjs`

Bonne nouvelle d'abord : j'ai vérifié que le fichier produit est **identique**
à sa propre normalisation par prettier aux options par défaut — or
`node_modules/convex/dist/cjs/cli/lib/codegen.js:623-626` formate avec
`prettier.format(contents, { parser })` **sans** résolution de config. La forme du
fichier est donc correcte aujourd'hui, et `codegen:api:check` est vert.

Les dérives sont latentes, chacune produisant une CI rouge après le prochain
`convex dev` :

| # | Script | Convex réel | Déclencheur |
|---|---|---|---|
| 1 | `:171` trie les chemins **sans** extension | `component_api.js:306` trie **avec** (`.sort()` sur `lib/ai.ts`) | Deux modules `lib/ai.ts` et `lib/ai-gateway.ts` : `-`(45) < `.`(46) inverse l'ordre |
| 2 | `:66` `identifierFor` = `replace(/[/-]/g,'_')` | `api.js:32-36` ajoute `_` pour les mots réservés et pour `api`/`internal`/`components`/`fullApi` | Un module `convex/internal.ts` ou `convex/class.ts` |
| 3 | `:37-45` `isExcluded` | `bundler/index.js:368-395` exclut aussi tout nom à **plus d'un point**, les fichiers avec espace, les dotfiles, et les modules **sans import ni export** | Un `convex/emailTemplates.fr.ts` |
| 4 | `:55` ne prend que `.ts`/`.tsx` | `ENTRY_POINT_EXTENSIONS` inclut `.js`/`.jsx` | Un module JS |

L'existence même du script est justifiée (`npx convex codegen` exige un
déploiement joignable ; `KNOWN_ISSUES.md:1362`) et **committer `_generated` est le
bon choix** ici : sans cela `tsc` en CI est impossible. Le commentaire d'en-tête
affirme toutefois « `npx convex dev` overwrites this file with identical content on
its next run » — c'est vrai aujourd'hui, faux dès qu'un des quatre cas apparaît.

- **Correctif** : aligner les quatre points (≈15 lignes) et nuancer le commentaire.
- **Confiance** : Confirmé (comparaison ligne à ligne avec `node_modules/convex`).

#### M6 — La démo `items` du template est toujours livrée, avec des outils IA **en écriture**

Reliquat complet et vivant :

- `convex/items.ts` — 4 fonctions publiques (`list`, `create`, `update`, `remove`)
- `src/routes/app/$orgSlug/items.tsx` — route réelle
- `src/components/items/`, `src/locales/{en,fr}/items.json`
- entrée de navigation : `src/components/app-shell/AppHeader.tsx:26`
- table `items` au schéma Convex
- **`convex/agent.ts:21` : `tools: { ...itemTools, ...recruiterTools }`** —
  `itemTools` expose `create`/`update`/`delete` au copilote

Le dernier point est le plus gênant : la règle domaine dit « Les outils de
l'assistant sur des données de recrutement sont **en lecture seule** ». `items`
n'est pas une donnée de recrutement, mais le copilote dispose bel et bien d'outils
d'écriture en production, et le chunk `items-CuST9esM.js` (11 kB) est livré.

- **Correctif** : supprimer le module, la route, les composants, le namespace i18n,
  la table et `itemTools` ; retirer les sections « Data table items » et
  « Items CRUD » de `TESTING.md` et le groupe `~/components/items/*` de
  `eslint.config.mjs:39`.
- **Confiance** : Confirmé.

#### M7 — CSP trop permissive pour la valeur qu'elle prétend apporter

`src/start.ts:19-31`

`script-src 'self' 'unsafe-inline'` annule l'essentiel du bénéfice anti-XSS d'une
CSP ; `connect-src 'self' https: wss:` autorise l'exfiltration vers n'importe quel
hôte HTTPS. Sur `/s/**`, la page manipule de la vidéo et de l'audio de candidat.

`Referrer-Policy: strict-origin-when-cross-origin` (`:7`) est en revanche
**correct** pour le jeton en URL : en cross-origin, seul l'origine part. `no-referrer`
sur `/s/**` et `/r/**` serait plus strict encore (le jeton reste dans le `Referer`
same-origin).

- **Correctif** : remplacer `'unsafe-inline'` par un nonce (TanStack Start le
  supporte), restreindre `connect-src` à `'self'` + l'URL Convex + `*.sentry.io`,
  et poser `no-referrer` sur les surfaces à jeton.
- **Confiance** : Confirmé.

#### M8 — Vercel installe un jeu de dépendances que la CI n'a jamais vérifié

`vercel.json:5` : `"installCommand": "pnpm install --frozen-lockfile=false"`.

C'est **documenté et argumenté** (`KNOWN_ISSUES.md:800-815`, avec le plan de
fermeture via `ENABLE_EXPERIMENTAL_COREPACK=1`), donc à traiter comme un risque
accepté, pas comme une découverte. Il reste que la production peut résoudre des
versions différentes de celles validées par `pnpm install --frozen-lockfile` en CI.

Deux incohérences mineures autour :

- `vercel.json:4` dit `"buildCommand": "pnpm build:vercel"`, mais
  `KNOWN_ISSUES.md:791` documente encore `"buildCommand": "pnpm build"`.
- `package.json:17` : `build:vercel` conditionne le déploiement Convex à
  `$VERCEL` + `$CONVEX_DEPLOY_KEY`, jamais à `VERCEL_ENV=production` — alors que
  son propre message dit « not Vercel prod build ». Avec une clé de production dans
  l'environnement des previews, une preview déploierait Convex en production. (Le
  garde-fou réel est le type de clé Convex, hors du dépôt.)

- **Confiance** : Confirmé pour les incohérences ; Probable pour l'impact du
  second point (dépend de la configuration Vercel).

---

### Faible

#### F1 — Dépendances déclarées et jamais importées
`convex-helpers@^0.1.118` : **0 occurrence** dans tout le dépôt hors `package.json`.
`tsx@^4.22.4` (dev) : 0 occurrence. `@radix-ui/react-label` : jamais importé
directement (couvert par le parapluie `radix-ui`, lui-même dédupliqué correctement).
Aucune dépendance manquante : le contrôle « import sans entrée dans `package.json` »
revient vide.

#### F2 — Trous dans `renovate.json`
`@tanstack/react-router-with-query@1.130.17` (≈40 mineures de retard) n'est **pas**
dans la règle qui gèle `@tanstack/react-router` / `react-start` / `router-core` —
Renovate le fera donc avancer seul, hors de la famille épinglée.
`nitro@3.0.260603-beta` et `recharts@3.8.1` sont des pins exacts sans règle, et
`rangeStrategy: "bump"` tentera de les déplacer. Le reste de la configuration est
au contraire exemplaire : chaque exclusion porte sa raison en `description`.

À noter : l'arbre est sain, une seule version de `@tanstack/react-router` (1.170.11),
de `@tanstack/router-core` (1.171.9), de `ai` (6.0.197) et de
`@ai-sdk/provider-utils` (4.0.27). L'écart de mineures entre `react-router` 1.170.11,
`react-start` 1.168.20 et `router-core` 1.171.9 est **intentionnel et cohérent** —
`pnpm.overrides` force une résolution unique.

#### F3 — Trois variables d'environnement absentes de `.env.example`
`ANTHROPIC_MODEL` (`convex/agent.ts:9`), `APP_ENV` (`convex/auth.ts:23,35`),
`RESEND_TEST_MODE` (`convex/email.ts:15`). `APP_ENV` conditionne le comportement
de production dans `createAuth` : son absence du fichier d'exemple est la plus
gênante des trois. Tout le reste (`OBJECT_STORE_*`, `MISTRAL_API_KEY`,
`OPENROUTER_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SITE_URL`, …) est bien documenté,
y compris en prose pour les variables qui vivent côté Convex.

#### F4 — Configuration vitest
`vitest.config.ts:11` impose `environment: 'edge-runtime'` à **tous** les fichiers.
C'est le bon choix pour `convex-test`, et les tests média passent car ce sont des
fonctions pures à dépendances injectées (`upload.test.ts` n'utilise que `Blob`,
`Response`, `AbortController`). Mais : zéro test de composant React, et en ajouter un
imposera une directive `@vitest-environment jsdom` par fichier. Aucun reporter de
couverture n'est configuré.

#### F5 — Divers
- `convex/candidate.ts:312` : `privacySummary` déclare `now: v.number()` et ne
  l'utilise pas (argument obligatoire mort).
- `tsconfig.json` n'active pas `noUncheckedIndexedAccess`, d'où les trois
  `eslint-disable @typescript-eslint/no-unnecessary-condition`.
- `package.json:4` : `"sideEffects": false` au niveau de l'application. Sans effet
  néfaste constaté ici (le CSS passe par `?url`), mais c'est un réglage à surveiller.
- Aucun `CODEOWNERS`, aucun template de PR. La reconstruction entière (8 lots) est
  arrivée en **une** PR (`#1`, `b4bc755`) — merge réel préservant les 12 commits,
  signé GPG, historique propre ; mais aucune revue incrémentale possible.
- Historique git sain : 16 commits, aucun secret (le seul `AKIA…` est la clé
  d'exemple publique d'AWS dans `convex/lib/sigv4.test.ts`), aucun `.env` jamais
  committé, plus gros blob = `pnpm-lock.yaml` (345 kB).
- `README.md` annonce « Node 20+ » ; `package.json` exige `node >=22` et la CI
  utilise Node 22.

---

## Tableau de couverture des tests

Garantie → testée ? → écart. Les quatre premières lignes sont les exigences
nommément citées au §6.

| Garantie | Testée ? | Fichier | Écart |
|---|---|---|---|
| **Normalisation des pondérations** | ✅ Oui, très bien | `convex/lib/weights.test.ts` | Aucun. Somme = 100 sur 6 jeux, 34/33/33, poids nuls, poids négatif |
| **Calcul de score** | ✅ Oui | `convex/lib/weights.test.ts`, `convex/lib/reportBuilder.test.ts:115-131` | Re-normalisation sur les seuls critères notés couverte |
| **Machine à états de session** | ✅ Oui, exhaustive | `convex/lib/sessionState.test.ts` | Bornes d'expiration, priorité de l'état terminal, index de reprise négatif |
| **Résolution de jeton** | ✅ Oui | `convex/lib/tokens.test.ts`, `convex/candidate.test.ts:168-186` | Les 5 formes d'échec renvoient un message **identique** — bien vu |
| **E2E parcours candidat (lot 4)** | ❌ **Non** | — | Aucun. `e2e-smoke.mjs` est celui du template (E1) |
| Isolation inter-organisations (jeton) | ✅ Oui | `convex/candidate.test.ts:161-167`, `convex/shares.test.ts` | — |
| Isolation inter-organisations (recruteur authentifié) | ❌ **Non** | — | Aucun `withIdentity` (E2) |
| `requireOrgMember` / `requireOrgRole` / `requireSuperAdmin` | ❌ **Non** | — | Jamais exécutés par un test |
| Visibilité des rôles restreints | ✅ Oui (unitaire) | `convex/lib/projectAccess.test.ts` | Teste `canSeeProject`, pas `requireProjectAccess` |
| Projections candidat (non-fuite) | ✅ Excellente | `convex/lib/candidateView.test.ts` | Testée par la négative : ni jeton, ni note, ni titre interne, ni clé d'objet |
| Idempotence du pipeline (rejeu) | ✅ Oui | `convex/pipeline.test.ts:107-190` | Transcript et rapport écrits une seule fois ; `jobLog` tracé |
| Purge — énumération des objets | ✅ Oui | `convex/pipeline.test.ts:195-225` | Inclut l'envoi échoué |
| Purge — suppression des lignes + hash | ✅ Oui | `convex/pipeline.test.ts:227-270` | Vérifie l'absence de l'adresse en clair |
| Purge — **ordre objets-avant-lignes** | ❌ Non | — | Les deux moitiés sont testées séparément ; l'orchestration jamais |
| `retention.purgeDueSessions` (cron) | ❌ Non | — | Manuel uniquement (`TESTING.md` IE3) |
| Validation Zod des sorties modèle | ✅ Excellente | `convex/lib/ai.test.ts` | Refus de défaut, de valeur hors bornes, d'enum inconnu |
| Rapport : critère sauté / doublé / inventé | ✅ Oui | `convex/lib/reportBuilder.test.ts:147-183` | Exactement la règle domaine |
| Ré-ancrage des citations | ✅ Oui | `convex/lib/evidence.test.ts` | Retour `null` plutôt qu'une approximation |
| Para-verbal déterministe | ✅ Oui | `convex/lib/paraverbal.test.ts:149` | — |
| SigV4 | ✅ Excellente | `convex/lib/sigv4.test.ts` | Vecteur officiel AWS, requête canonique **et** signature |
| Conventions de clés d'objet | ✅ Oui | `convex/lib/objectStore.test.ts` | Préfixe de session ; média de poste hors du préfixe |
| Envoi média : reprise, 403, abandon | ✅ Oui | `src/lib/media/upload.test.ts` | `fetch` injecté — le `Content-Type` signé est réellement asserté |
| Détection MediaRecorder / devices | ✅ Oui | `src/lib/media/recorder.test.ts`, `devices.test.ts` | Branche Safari MP4 couverte |
| Parité i18n en/fr (clés, vides, placeholders) | ✅ Excellente | `src/lib/i18n.test.ts` | — |
| `interview.reserveSegment` (dérivation serveur des clés) | ❌ Non | — | La règle « le client ne nomme jamais la clé » n'est vérifiée par aucun test |
| Invitation en masse (transaction, doublons) | ❌ Non | — | `src/lib/candidate-list.test.ts` teste le parsing, pas la mutation |
| Limitation de débit candidat (`consumeWriteLimit`) | ❌ Non | — | — |
| En-têtes de sécurité | ⚠️ Faussement | `scripts/e2e-smoke.mjs:100-107` | Assert `camera=()` — verrouille C1 |
| Composants React | ❌ Aucun | — | Aucun test de rendu ; `edge-runtime` global le rendrait laborieux |

**Qualité du mocking** : bonne. Il n'y a pas de `vi.mock` de module — les seuls
doubles sont des **dépendances injectées** (`fetchImpl`, `sleepImpl`,
`supports(...)`), et `upload.test.ts:33-39` vérifie la *forme* réelle de la requête
(`method: 'PUT'`, en-tête `Content-Type`), pas seulement le nombre d'appels. C'est
exactement ce qu'il faut pour ne pas masquer un bug de forme de requête. Réserve :
les appels aux modèles (`convex/lib/ai.ts:109` Mistral, `:189` OpenRouter) ne sont
jamais mockés du tout — seul `parseModelJson` est testé, la construction et le
décodage des réponses HTTP ne le sont pas.

---

## Dépendances — points d'attention

| Paquet | Version | Constat | Action |
|---|---|---|---|
| `ws` (via `convex`) | <8.21.0 | Avis **high**, chemin runtime | `pnpm.overrides` `ws: '>=8.21.0'` |
| `dompurify` / `mermaid` (via `streamdown`) | <3.4.13 / <11.16.1 | 7 avis, rendu de sortie de modèle côté recruteur | Override, ou évaluer le retrait de `streamdown` |
| `@tanstack/react-router-with-query` | 1.130.17 | ~40 mineures de retard ; **non gelé** dans `renovate.json` alors qu'il appartient à la famille épinglée | L'ajouter à la règle `enabled: false`, ou l'aligner |
| `@tanstack/react-router` / `react-start` / `router-core` | 1.170.11 / 1.168.20 / 1.171.9 | Écart de mineures **volontaire**, résolu par `pnpm.overrides` ; une seule version de chacun dans l'arbre | Rien — mécanisme sain et documenté |
| `nitro` | `3.0.260603-beta` | Bêta figée en exact, sans règle Renovate ; nécessaire au preset Vercel (`KNOWN_ISSUES.md:777`) | Ajouter une règle `enabled: false` explicite |
| `recharts` | `3.8.1` | Pin exact sans raison écrite | Documenter, ou repasser en `^` |
| `convex-helpers` | `^0.1.118` | **Zéro import** dans le dépôt | Supprimer |
| `tsx` | `^4.22.4` (dev) | **Zéro usage** | Supprimer |
| `@radix-ui/react-label` | `^2.1.8` | Jamais importé directement ; `radix-ui` le fournit | Supprimer |
| `next-themes` | `^0.4.6` | Utilisé (`ThemeProvider`, `ThemeToggle`) mais `CLAUDE.md` liste « bascule clair/sombre non demandée » en anti-pattern | Trancher : produit ou reliquat template |
| `@ai-sdk/anthropic` + `ai` v6 | 3.0.81 / 6.0.197 | Utilisés (copilote via `@convex-dev/agent`) ; versions cohérentes, `@ai-sdk/provider-utils` dédupliqué en 4.0.27 | Bumper pour l'avis low |
| `@typescript/native-preview` | `7.0.0-dev.20260605.1` | Build daté, exposé par `typecheck:native` ; hors CI donc sans risque | Rien |
| `typescript` 6 / `vite` 8 / `vitest` 5 / `eslint` 10 / `zod` 4 | — | Toolchain moderne, tout passe au vert | Rien |
| `pnpm` | 10.34.5 pinné par `packageManager` | Correctement propagé (CI sans `version:`, Corepack, Vercel) | Rien |

---

## Docs — affirmations périmées

| Doc | Affirmation | Réalité |
|---|---|---|
| `CLAUDE.md` § Stack | « `@assistant-ui/react` front » | Absent de `package.json` ; `KNOWN_ISSUES.md:826` explique qu'il a été écarté au profit de `useUIMessages` |
| `CLAUDE.md` § Stack | « Observabilité : Sentry (front + Convex actions) » | Aucun Sentry dans `convex/` ; `KNOWN_ISSUES.md:837` **et** `TESTING.md` P6 disent l'inverse |
| `CLAUDE.md` § Stack | « File storage : Convex native, 20 Mo » | Vrai pour les avatars seulement ; les enregistrements vont sur S3 (`KNOWN_ISSUES.md:1446`), non mentionné dans le § Stack |
| `CLAUDE.md` § Stack | « outils agissant en base scopés à l'org : list/create/update/delete `items` » | Exact — mais décrit la démo du template comme une fonctionnalité du produit |
| `KNOWN_ISSUES.md:815` | « Trade-offs vs `PROJECT_BRIEF.md` » | `PROJECT_BRIEF.md` **n'existe pas** dans le dépôt |
| `KNOWN_ISSUES.md:818` | `/Users/benjaminbouquet/.claude/plans/glistening-puzzling-kay.md` | Chemin local d'un poste de développement, committé dans un doc partagé |
| `KNOWN_ISSUES.md:791` | `"buildCommand": "pnpm build"` | `vercel.json:4` dit `pnpm build:vercel` |
| `TESTING.md:3` | « valider une copie fraîche du **template** avant de le forker » | Interw *est* le fork |
| `TESTING.md` L2/L3 | « Data table items », « Items CRUD » | Décrit fidèlement du code qui ne devrait plus exister (M6) |
| `TESTING.md` B4 | « `pnpm test:smoke` → All scenarios pass » | Le script ne teste aucune surface Interw (E1) |
| `TESTING.md` IC1 | « After C16 » | Devrait être IB16 — aucun « C16 » |
| `TESTING.md` IE5 | « After G1 » | Aucun « G1 » dans le document |
| `TESTING.md` § Quick dev seed | « `seedDev` dans `convex/admin.ts` », « 3 items » | `seedDev` n'existe pas ; formulé au conditionnel, donc prescriptif — mais « items » est du template |
| `README.md` § Prerequisites | « Node 20+ » | `engines.node: '>=22'`, CI sur Node 22 |
| `README.md:94` | pointe vers `albo-ouvre-boite` | Correct et voulu (canal de mise à jour) |
| `convex/README.md` | documente `convex/myFunctions.ts`, `api.myFunctions.*` | Boilerplate Convex jamais adapté ; ce fichier n'existe pas |
| `CHANGELOG.md` | « Template releases », s'arrête à v0.3.0 | Rien sur la reconstruction Interw ; `release-tag.yml` publierait un tag `v0.3.0` sur le dépôt Interw si `CHANGELOG.md` est touché |
| `AGENTS.md` | « Convex agent skills … `npx convex ai-files install` » | Contredit `KNOWN_ISSUES.md:473` « Convex skills were pruned — do not re-vendor them » |
| `scripts/codegen-api-types.mjs:22` | « `npx convex dev` overwrites this file with identical content » | Vrai aujourd'hui, faux dans les quatre cas de M5 |

**À l'inverse — ce que la doc couvre bien** : `TESTING.md` §§ « Interw A → E »
(35 scénarios) couvre réellement les rôles, le parcours candidat par navigateur,
la coupure réseau (IB12), le pipeline et son rejeu, le partage et sa révocation,
l'auto-suppression candidat et la purge de rétention — y compris la vérification
en soute (« l'objet existe sous `orgs/{orgId}/sessions/{sessionId}/` »). Le §8-8
est donc **satisfait**. Tous les chemins de fichiers cités dans les docs existent,
aux exceptions listées ci-dessus (vérifié : 77 chemins extraits, 3 réellement morts).

---

## Ce qui est solide

- **La ligne de base est verte et rapide.** 256 tests en 3,7 s ; lint, typecheck,
  build, codegen et audit d'accès tous à 0.
- **Discipline TypeScript exemplaire.** Zéro `any` hors `routeTree.gen.ts`, zéro
  `@ts-ignore`, cinq `eslint-disable` ciblés portant chacun leur justification en
  commentaire. `noUnusedLocals` + `noUnusedParameters` activés.
- **`convex/lib/sigv4.test.ts`** valide la requête canonique **et** la signature
  contre le vecteur documenté par AWS. C'est le bon niveau d'exigence sur du code
  cryptographique réécrit à la main.
- **`convex/lib/candidateView.test.ts`** teste par la négative : le sérialisé ne
  contient ni jeton, ni note recruteur, ni titre interne, ni clé d'objet. C'est
  ce qui rend la règle « une nouvelle colonne ne peut pas fuiter par défaut »
  exécutable plutôt que déclarative.
- **`convex/candidate.test.ts:168-186`** : les cinq formes de jeton invalide doivent
  produire un message **identique** (`new Set(failures).size === 1`). La garantie
  d'indistinguabilité est testée, pas supposée.
- **`convex/pipeline.test.ts`** attaque directement l'affirmation centrale du lot 5
  (rejouable sans changer le résultat) et vérifie que `purgeLog` ne contient pas
  l'adresse en clair.
- **`src/lib/i18n.test.ts`** : parité de clés, valeurs vides, placeholders — la
  dérive i18n de l'ancienne version devient une CI rouge.
- **Mocking par injection de dépendances**, pas par `vi.mock`, et assertions sur la
  forme réelle de la requête.
- **`eslint.config.mjs:24-70`** : la frontière du bundle candidat est une règle
  exécutable, avec le *pourquoi* (2,96 Mo) écrit dans le commentaire. Résultat
  mesurable : 255 kB gzip.
- **`renovate.json`** : chaque exclusion porte sa raison, avec l'avis GHSA ou le
  ticket amont. C'est la meilleure config Renovate que j'aie lue récemment.
- **`KNOWN_ISSUES.md`** (48 sections) documente les vrais pièges du domaine :
  presigned PUT signant `content-type` **et** `content-length`, adressage
  path-style, deux `MediaRecorder` sur un flux, `seek` avant `loadedmetadata`.
- **Le pin pnpm** est propre de bout en bout : `packageManager` seul, pas de
  `version:` en CI, raison écrite dans le workflow.
- **Hygiène git** : merge réel signé, 12 commits par lot, aucun secret, aucun
  binaire, `.gitignore` correct.
- **L'audit d'accès existe.** Même imparfait (E3), 101 fonctions publiques listées
  avec leur garde et 3 exemptions explicitement motivées, c'est bien au-dessus de
  la pratique courante.

---

## Ce que j'aurais fait autrement

1. **Le header `Permissions-Policy` aurait dû être écrit au lot 4, pas hérité du
   lot 0.** Le template posait `camera=()` pour une application sans caméra. Le
   premier lot qui demande la caméra doit relire les en-têtes hérités — et le
   smoke test qui *assert* la valeur héritée est le signe que personne ne l'a fait.
   Règle générale : toute configuration du template qui nie une capacité du produit
   doit être revue au lot qui introduit cette capacité.

2. **J'aurais réécrit `e2e-smoke.mjs` au lot 3, pas jamais.** La moitié des
   scénarios Interw sont testables en HTTP pur, sans navigateur : jeton inconnu vs
   malformé indistinguables, `noindex` sur `/s/**` et `/r/**`, lien révoqué,
   en-têtes. Ça tient en 80 lignes et ça tourne en CI derrière `pnpm start`.
   Le §6 demandait un e2e ; un script qui teste l'ancien produit est pire que pas
   de script, parce qu'il affiche vert.

3. **J'aurais écrit `convex/access.test.ts` avant `scripts/audit-convex-access.mjs`.**
   L'audit est un excellent *complément* — il garantit qu'on n'oublie pas d'appeler
   un garde. Mais il ne remplace pas dix tests `withIdentity` qui prouvent que le
   garde *refuse*. Dans l'ordre actuel, la propriété la plus importante du produit
   (§8-4) n'est vérifiée par rien d'exécutable.

4. **Le budget de bundle aurait dû être un job CI, pas une règle ESLint.**
   La règle d'imports attrape la faute grossière ; elle n'attrape pas la dérive
   lente, qui est le mode de défaillance observé sur la version précédente. Trente
   lignes de Node après `pnpm build` auraient donné le chiffre à chaque PR — et
   auraient rendu visible que le client Better Auth voyage sur le téléphone du
   candidat.

5. **J'aurais supprimé `items` au lot 1.** Le laisser a coûté : une table, quatre
   fonctions publiques, une route, un namespace i18n, une entrée de navigation, deux
   sections de `TESTING.md`, un groupe dans la règle ESLint — et quatre outils
   copilote **en écriture** dans un produit dont la règle domaine dit que les outils
   de l'assistant sont en lecture seule. Supprimer une démo prend dix minutes ; la
   faire cohabiter coûte à chaque relecture.

6. **J'aurais retiré `tsc` de `build`.** `lint` le fait déjà ; le doublon coûte
   ~22 s par run pour zéro information nouvelle, et `tsBuildInfoFile` pointe sous
   `node_modules/` que la CI ne met pas en cache.

7. **Sentry : choisir.** Soit on l'instrumente pour de bon (intégrations, source
   maps, upload) et il devient utile au moment qui compte — un crash en plein
   entretien, quand le candidat n'a qu'une tentative — soit on assume le Dashboard
   Convex et on retire les trois options mortes. L'état intermédiaire actuel donne
   l'illusion d'une observabilité qu'on n'a pas.

8. **Je n'aurais pas gardé le `catch {}` de `convex/users.ts:182`.** Un seul reste
   sur les 47 de l'ancienne version, c'est une belle performance — mais c'est
   justement celui qui casse aussi la règle d'ordre d'effacement, et il était
   listable par le même `grep` qui a nettoyé les 46 autres.
