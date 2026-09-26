# Interw — intégrer Spectrum UI : plan découpé en sessions

## Contexte

[Spectrum UI](https://github.com/arihantcodes/spectrum-ui) est un registre shadcn
(Apache-2.0, 315 éléments). Il **étend** shadcn : ses composants s'appuient sur
`button`, `card`, `input`… et s'installent hors de `src/components/ui/`. Le MCP
`spectrum-ui` est dans `.mcp.json` depuis #76.

Il ne s'installe pas tel quel ici :
- couleurs en dur dans 228 fichiers sur 332 ;
- textes anglais sans i18n ;
- directives et imports Next.js ;
- `framer-motion` et `motion`, qu'on n'a pas ;
- keyframes injectées par `dangerouslySetInnerHTML`.

C'est un **catalogue à porter** : chaque lot porte ce qu'il utilise, et S0 pose
les garde-fous qui rendent un mauvais portage rouge en CI.

**Source figée** : commit `acdc998c64829f8ae037be48e3c273ccc8d71f60`. Chaque
session clone ce commit depuis GitHub. `spectrumhq.in`, donc le MCP, est bloqué
dans les sessions cloud : `KNOWN_ISSUES.md` § « Spectrum UI MCP ».

### Priorités fixées par Benjamin (26/09)

| Famille | Décision |
|---|---|
| Blocs IA, états vides | Maintenant |
| Graphiques et stats (tableau de bord, page candidats recruteur) | Maintenant |
| Boutons animés, effets de texte, 3D | Oui : « donnent énormément de qualité » |
| Formulaires | Plus élégants, pas prioritaire |
| Kanban | Chantier à part : kanban type ATS pour les candidats |
| Pieds de page, grilles tarifaires, blocs marketing | Non |

## 1. Recette de portage

S0 transfère cette recette dans `KNOWN_ISSUES.md` § « Spectrum UI MCP ». Une
fois S0 mergé, **c'est cette section qui fait foi**, et le §1 d'ici se réduit à
un lien. Les points marqués 🔒 sont vérifiés par ESLint ou `design-pass.test.ts`
après S0 ; les autres demandent du jugement.

1. **Emplacement.**
   - `src/components/spectrum/` pour ce qui reste proche de l'original (comme
     `ai-elements/`).
   - Les compositions métier vont là où elles servent : `components/dashboard/`,
     `components/ai/`…
   - Jamais dans `src/components/ui/`, qui reste à shadcn.
2. 🔒 **Licence.** En tête de fichier :
   `// Adapted from Spectrum UI (<chemin source>@acdc998), Apache-2.0. Modified: <résumé>.`
3. 🔒 **Couleurs → tokens de `src/styles/brand.css`.** S0 écrit la table de
   correspondance dans `KNOWN_ISSUES.md`. Tester les deux thèmes.
4. **Textes → `t()`, en `en` et `fr`**, `aria-label` compris. Pas de texte par
   défaut en prop. Dates dans la locale de l'app.
5. 🔒 **Next.js.**
   - `"use client"` retiré ;
   - `next/image` → `<img>` avec dimensions ;
   - `next/link` → `Link` de TanStack ;
   - `next-themes` → thème de l'app.
6. 🔒 **Animation.**
   - `motion/react` uniquement, jamais `framer-motion`.
   - Le mouvement réduit est hérité du `MotionConfig` posé par S0 : n'en sortir
     que volontairement, pour une boucle qui porte du sens (voir `KNOWN_ISSUES.md`
     § « Reduced motion collapses durations, and spares the spinner »).
   - Les keyframes vont dans `src/styles/spectrum.css`, pas dans le composant.
7. 🔒 **Pas de données de démo** (`sampleData`, `Math.random`, mocks).
8. **Accessibilité** : relire avec le skill `web-design-guidelines`. Spectrum
   est inégal sur le clavier et les `aria-*`.
9. 🔒 **Surface candidat** (CLAUDE.md § « The candidate surface »).
   - Rien de `~/components/spectrum/`, ni `motion`, `recharts` ou `three`.
   - Un effet voulu côté candidat se réécrit en CSS dans `components/candidate/`,
     sous le budget de `KNOWN_ISSUES.md` § « The candidate bundle budget reads
     the start manifest ».
10. **i18n sans conflit.**
    - Chaque lot ajoute ses clés sous une sous-clé à son nom (`dashboard.charts.*`,
      `common.empty.*`).
    - Il ne crée un namespace que s'il est seul à le toucher.
11. **Avant PR** : CLAUDE.md § 6, selon ce que le lot touche.
    - **Lot front** : `pnpm build:app && pnpm bundle:budget`, avec captures clair
      et sombre dans la PR.
    - **Lot backend** : `pnpm codegen:api` et `pnpm audit:access:check`.

## 2. Carte des lots

```
S0 Fondations ──┬── S1 États vides ─────────────┐
                ├── S2 IA (2 PR)                │
                ├── S3b Graphiques (2 PR) ◄─ S3a│
                ├── S4 Micro-interactions ◄─────┘ (branchement après S1 et S3b)
                ├── S5 Texte animé + 3D (spike d'abord)
                └── S6 Formulaires (plus tard)

S3a Données stats (backend)     ← démarre tout de suite, sans S0
F   Petits correctifs           ← démarre tout de suite
K0 Spec kanban ATS → K1/K2      ← chantier séparé, démarre tout de suite
```

- **Tout de suite, en parallèle** : S0, S3a, F et K0.
- **Après S0** : S1, S2, S4 (première phase) et le spike S5.
- **Convex dev partagé** : S3a et K1 écrivent du backend. Ils ne tournent pas en
  même temps sur le même déploiement dev.

## 3. Les lots

### S0 — Fondations (bloquant pour les lots front)

**Faire** :
- `pnpm add motion`.
- `<MotionConfig reducedMotion="user">` autour de l'app recruteur. Une assertion
  design-pass vérifie qu'il est présent.
- **ESLint** :
  - ajouter `~/components/spectrum/*`, `motion` et `motion/*` aux interdits de la
    surface candidat (`eslint.config.mjs`, groupe des dossiers recruteur) ;
  - interdire `framer-motion`, `next/*` et `next-themes` partout.
- **design-pass.test.ts**, sur `src/components/spectrum/**` :
  - refuser les hexadécimaux, `white`/`black` nus et les couleurs arbitraires
    `[#…]` (M9 ne voit aujourd'hui que les teintes numérotées) ;
  - refuser `dangerouslySetInnerHTML`, `"use client"`, `sampleData` et
    `Math.random` ;
  - exiger l'en-tête Apache.
- `src/components/spectrum/NOTICE` (texte Apache-2.0), et `src/styles/spectrum.css`
  importé et vide.
- **Doc** : transférer le §1 et la table couleurs → tokens dans `KNOWN_ISSUES.md`
  § « Spectrum UI MCP ». Le point Next.js y est déjà à moitié : le compléter, ne
  pas le recopier.
- **Portage témoin** : `number-ticker` dans `KpiCard.tsx`, en gardant
  `tabular-nums`.

**Fini quand** :
- un import de `motion` dans `src/components/candidate/` fait échouer le lint ;
- un `bg-[#000]` dans `spectrum/` fait échouer design-pass ;
- le budget candidat est inchangé ;
- le chiffre de `KpiCard` s'anime, sauf en mouvement réduit.

### F — Petits correctifs (indépendant, 1 petite PR)

- `AnswerPlayer.tsx:184` coupe son spinner en mouvement réduit, contre la règle
  du spinner.
- `ui/spinner.tsx:13` a `aria-label="Loading"` en dur.
  - Réutiliser `common:loadingEllipsis`, ou une clé sœur sans points de suspension.
  - TESTING.md I18N-9 exempte le chrome de `components/ui/*` : lever l'exemption
    pour ce libellé et le dire dans la PR, ou laisser tel quel.

### S1 — États vides

**Point de départ** : `src/components/projects/EmptyState.tsx` a déjà l'API
voulue (`icon`, `title`, `body`, `action`, tokens seulement).
- Le déplacer en `src/components/EmptyState.tsx`.
- Lui ajouter `variant` (aucune donnée, recherche, filtre, erreur, accès refusé)
  et `compact`.
- Reprendre de Spectrum le **visuel** (`table-empty`, `search-empty`,
  `filter-empty`, `error-empty`, `access-empty`, `invite-empty`), pas les
  2 046 lignes d'`empty-state-kit.tsx`.

**Remplacer les `<p class="text-muted-foreground">` nus** :

| Fichier | Lignes | Note |
|---|---|---|
| `projects.$projectSlug.index.tsx` | 284-287, 332-335 | |
| `settings/members.tsx` | 121-123 | |
| `settings/invitations.tsx` | 295-297 | |
| `app/admin.tsx` | 201, 246, 286 | |
| `auth/active-sessions.tsx` | 112-114 | |
| `r/$shareToken.tsx` | 268, 282 | variante `compact` |
| `candidates.$sessionId.tsx` | 432, 450 | variante `compact` |
| `$orgSlug/index.tsx` | 139-142 | liste « Récent » |

Chargements en texte brut → `Skeleton` : `settings/general.tsx:104-109`,
`members.tsx:117-119`, `invitations.tsx:291-293`.

**Hors lot** :
- `AiPanel.tsx` (S2) ;
- la carte « Décisions » de `$orgSlug/index.tsx:188-191`, que S3b remplace par un
  graphique.

**Fini quand** : plus aucun état vide en `<p>` nu dans l'app recruteur (grep).

### S2 — IA (1 session, 2 PR successives sur `src/components/ai/`)

**PR 1 — accueil, erreurs, réflexion** :
- **Accueil** : remplacer `AiPanel.tsx:521-540` en s'appuyant sur `EmptyState`
  (S1) ou `ConversationEmptyState` (déjà vendorisé), avec le visuel de
  `chat-empty-state`.
- **Erreurs** : aujourd'hui un simple `toast.error` (`AiPanel.tsx:331, 357, 380,
  392, 404`). À la place :
  - un message d'erreur dans le fil, qui garde le prompt, avec « Réessayer » ;
  - la gestion du statut `failed` renvoyé par `useUIMessages`.
- **Réflexion** : `thinking-dots` remplace « Thinking… » (594-600) et le « … »
  du streaming (564).

**PR 2 — outils et sources** :
- **Appels d'outils** : aujourd'hui du JSON brut (`ai-elements/tool.tsx:26,
  168-173`). Une frise inspirée d'`agent-steps` et `tool-chips`, avec un rendu
  lisible par outil ; le JSON reste disponible, replié.
  - `listRoles` : des rôles ;
  - `listCandidates` : des noms avec leur statut ;
  - `readReport` : candidat, score, lien.
- **Sources** : `readReport` renvoie `sessionId`. Des puces vers
  `/app/$orgSlug/candidates/$sessionId`, en liens internes seulement (règle
  Streamdown de `KNOWN_ISSUES.md`).
  - À corriger au portage de `citation-sources` : `new URL()` lève sur une URL
    invalide, et le tooltip n'a pas d'`aria-describedby`.

**Garde-fous** :
- `AiPanel` reste chargé à la demande (`AiPanelHost.lazy.test.ts`).
- Pas d'`approval-card` pour une action métier : les outils restent en lecture
  seule (CLAUDE.md « AI and hiring »).

**Fini quand** : « résume le rapport de X » affiche l'étape `readReport`
lisible et une source cliquable.

### S3a — Données des stats (backend, démarre tout de suite)

Ce lot reprend et **remplace** l'item « Tableau de bord (Back M3) » de
`2026-09-24-reste-a-faire.md` (T11). Le signaler dans la PR.

**Faire** :
- Des requêtes Convex filtrées par org (`requireOrgMember`, visibilité par rôle
  comme dans `convex/dashboard.ts`, `now` passé par `effectiveNow`).
- Un scan borné ou des agrégats (`@convex-dev/aggregate`, ou des compteurs
  maintenus en mutation), à justifier dans la PR.
- Des tests `convex-test` par requête, isolation entre organisations comprise.

**Indicateurs** (D1, à valider par Benjamin **avant** de lancer le lot) :

| Page | Indicateur |
|---|---|
| Tableau de bord | Entretiens terminés par jour, 30 j |
| Tableau de bord | Entonnoir : invités → commencés → terminés → décidés |
| Tableau de bord | Décisions par type (écartés, peut-être, présélectionnés, recrutés) |
| Tableau de bord | Délai médian invitation → entretien terminé |
| Page candidats (par rôle) | Distribution des scores |
| Page candidats (par rôle) | Entonnoir et taux de complétion du rôle |
| Page candidats (par rôle) | Candidats en attente de décision |

### S3b — Graphiques (après S0 et S3a, 1 session, 2 PR)

**Choix technique** :
- Réinstaller le `chart` shadcn (`pnpm dlx shadcn@latest add chart` : `recharts`
  plus les tokens `--chart-1..5`), chargé à la demande sur la route.
- Reprendre le rendu de `sparkline-chart`, `bar-chart`, `area-chart`,
  `radial-chart` et des cartes de `stat-cards`, sans `chart-engine.tsx`
  (orienté finance, avec générateurs).
- Lire le skill `dataviz` avant le premier graphique.

**PR 1** : les primitives de graphique dans `components/dashboard/charts/`, puis
le tableau de bord.
- Remplacer la carte « Décisions » (`$orgSlug/index.tsx:188-191`).
- Fusionner `KpiCard` avec le `Stat` de `admin.tsx:336` : les deux gèrent la
  valeur plafonnée.

**PR 2** : le bandeau de stats du rôle au-dessus de `CandidatesTable`, avec les
primitives de la PR 1. Le tableau TanStack reste.

**Piège** : design-pass refuse les noms `ActivityChart` et `RoleBreakdownChart`,
restes des démos avec mocks supprimées en T14. Choisir d'autres noms ; ne pas
assouplir le test.

### S4 — Micro-interactions

- **Phase 1**, après S0 : les primitives dans `spectrum/`, sans les brancher.
- **Phase 2**, après S1 et S3b : le branchement, car ces lots touchent les mêmes
  écrans.

| Élément | Où |
|---|---|
| `morph-button` / `loading-button` | Envois : inviter, publier un rôle, partager un rapport |
| `hold-to-confirm` | Suppressions : candidat, rôle, organisation |
| `undo-pill` | Décision sur un candidat (`reports.setDecision`) |
| `animated-switch` | Réglages |
| `tilt-card`, `beam-card` | Une ou deux cartes vitrines (onboarding, WhatsNew) |

- `hold-to-confirm` doit marcher au clavier : maintenir Espace ou Entrée. Sinon,
  garder l'`AlertDialog`.
- `beam-card` : réécrire l'effet en CSS plutôt qu'ajouter le paquet `border-beam`.
- **Exclus** : `metal-button` (`metal-fx`), `like-button`, `reaction-bar`,
  `star-rating`.

### S5 — Effets de texte et 3D (spike d'abord, après S0)

**Spike** : rien n'est mergé.
- Lire les skills `frontend-design` et `web-design-guidelines`.
- Proposer 2 à 3 emplacements « signature », avec captures et taille estimée des
  dépendances. Candidats :
  - le titre de connexion et d'onboarding : `text-states`, `use-typewriter`,
    `orbital-letters` ;
  - le premier lancement du tableau de bord vide ;
  - l'annonce WhatsNew.
- Benjamin choisit.

**Implémentation** : on ne mesure le coût réel que pour l'option retenue.
- **3D** (`event-badge-3d` : `three`, `@react-three/fiber`, `drei`, `rapier`,
  plus d'un mégaoctet) :
  - un seul emplacement, chargé par `import()` ;
  - une image fixe de repli en mouvement réduit ou sur petit écran.
- **Côté candidat** : un effet de texte se réécrit en CSS dans
  `components/candidate/` (recette point 9).

### S6 — Formulaires (plus tard)

| Élément | Où |
|---|---|
| `multiple-selector` | `TeamPicker`, critères |
| `autosize-textarea` | Questions |
| `datetime-picker` | Dates d'expiration |
| `inline-edit` | Renommer un rôle |
| `floating-label-input` | Un écran d'essai avant de généraliser |

L'auth ne migre pas (CLAUDE.md, « Better Auth UI »). Un formulaire migré garde
TanStack Form, Zod et le namespace `validation`.

## 4. Points de contention entre sessions parallèles

| Fichier | Règle |
|---|---|
| `package.json`, `eslint.config.mjs`, `design-pass.test.ts` | S0 d'abord ; ensuite, un ajout d'une ligne dans le lot qui en a besoin, puis rebase |
| `src/styles/spectrum.css` | Chaque lot ajoute un bloc commenté à son nom |
| `src/locales/{en,fr}/*.json` | Sous-clé par lot (recette point 10) |
| `$orgSlug/index.tsx` | S1 : la liste « Récent » ; S3b : la carte « Décisions » et les KPI ; K2 : le lien du KPI `awaitingReview` |
| `CandidatesTable.tsx`, `candidates.$sessionId.tsx` | S1 (import, états vides) → S3b PR 2 → S4 phase 2 ; K1 : le lien retour de la page candidat |
| `projects.$projectSlug.index.tsx` | S1 : états vides ; K1 : onglets et vue dans l'URL |
| `candidate-rows.ts`, `nav.ts` | K1 : colonnes du board ; K2 : l'entrée « Candidats » |
| `KNOWN_ISSUES.md` § « Spectrum UI MCP » | S0 l'écrit ; les autres n'ajoutent qu'un piège nouveau |

## 5. Chantier kanban ATS

Le `kanbanboard` Spectrum est une démo : données en dur, glisser-déposer HTML5
sans clavier, couleurs en hexadécimal. On garde son visuel (avec `board-empty`),
pas son code.

**K0 — Spec** (sans code) : `docs/audit/<date>-kanban-ats-spec.md`. Elle tranche :

- **Colonnes v1 sans migration.**
  - Le schéma a déjà `recruiterDecisionValidator` (`rejected`, `maybe`,
    `shortlisted`, `hired`) et l'historique `decisionEvents`. Déplacer une carte,
    c'est appeler `reports.setDecision` (`convex/reports.ts:195`).
  - Une colonne « à évaluer » s'ajoute : entretien terminé, sans décision.
  - Des étapes personnalisables par rôle ne viennent qu'en v2, si la v1 ne suffit pas.
- **Portée** : par rôle, et/ou toutes offres confondues.
- **Contenu de la carte.**
- **Règles** :
  - un déplacement est une décision humaine, jamais une action de l'IA ;
  - qui voit le rôle peut déplacer : il n'existe pas de rôle `viewer` (spec K0 §0).
- **Interface** : `@dnd-kit` (capteur clavier, annonces `aria-live`) et `motion` ;
  vue liste sur mobile.
- **Temps réel** à plusieurs recruteurs, avec mise à jour optimiste.
- **Questions produit** encore ouvertes.

**K1 / K2** : découpés par la spec K0, [`2026-09-26-kanban-ats-spec.md`](2026-09-26-kanban-ats-spec.md) §8.

## 6. Lancer une session

**En-tête commun** (à coller tel quel) :

> Lis `CLAUDE.md` puis `docs/audit/2026-09-26-plan-spectrum-ui.md` en entier.
> Réalise **uniquement** le lot indiqué ci-dessous, selon la recette (§1, ou
> `KNOWN_ISSUES.md` § « Spectrum UI MCP » si S0 est mergé) et les points de
> contention du §4. Clone Spectrum au commit indiqué dans le Contexte. Vérifie
> chaque critère « Fini quand » et montre-le dans la PR.

**Puis une ligne par lot** :

| Lot | Ligne à ajouter |
|---|---|
| S0 | `Lot : S0.` |
| F | `Lot : F.` |
| S1 | `Lot : S1. Prérequis mergé : S0.` |
| S2 | `Lot : S2, PR 1 puis PR 2. Prérequis : S0 (et S1 si EmptyState sert à l'accueil).` |
| S3a | `Lot : S3a. Indicateurs validés : <coller la table validée>.` |
| S3b | `Lot : S3b, PR 1 puis PR 2. Prérequis : S0, S3a.` |
| S4 | `Lot : S4, phase <1 ou 2>. Prérequis : S0 (phase 2 : S1 et S3b).` |
| S5 | `Lot : S5, spike seulement.` |
| K0 | `Lot : K0.` |

## 7. Décisions ouvertes

- **D1 — Indicateurs de S3a** : table du lot S3a, à valider avant de lancer S3a.
- **D2 — Kanban v1 sur les décisions existantes, sans migration** : confirmée en
  K0 (spec §1) ; les questions produit restantes sont au §9 de la spec.
- **D3 — Emplacement du 3D et des effets de texte** : choisi sur le spike S5.
