# Interw — kanban ATS : spec (lot K0)

Répond point par point au §5 de `2026-09-26-plan-spectrum-ui.md`. Aucun code
applicatif ici : cette spec découpe K1 et K2 et liste ce que Benjamin doit
trancher (§9).

**Sources** : code de `main` au 26/09 (`82db83b`), Spectrum UI au commit
`acdc998`, `@dnd-kit` mesuré le 26/09 (versions au §5.1).

## 0. Deux corrections au plan

1. **Il n'y a pas de rôle `viewer`.** Les rôles d'org sont `owner | admin |
   member` (`convex/schema.ts:4-8`, `convex/lib/auth.ts:13-23`). La règle « le
   `viewer` ne déplace rien » ne s'applique à personne. Ce qui en tient lieu est
   au §4.
2. **Décider se fait au niveau de l'équipe, et c'est voulu.** `reports.setDecision`
   exige `requireProjectAccess` : l'équipe du rôle, plus les owners et admins de
   l'org (`convex/reports.ts:201-208`). `KNOWN_ISSUES.md` § « Decisions and
   report links are team-level » interdit de durcir ce droit sans décision
   produit. Le kanban reprend ce droit tel quel.

## 1. Colonnes v1, sans migration (D2 : confirmée)

La décision vit sur la ligne `sessions` : `recruiterDecision`,
`recruiterDecisionBy` et `recruiterDecisionAt` (`convex/schema.ts:444-446`).
Chaque changement ajoute une ligne à `decisionEvents` (`schema.ts:730-741`).
`setDecision(sessionId, decision | null)` couvre déjà tout ce qu'un déplacement
demande :

- il écrit la décision et l'historique ;
- `null` retire la décision, et l'historique affiche `decision.cleared` ;
- renvoyer la décision courante ne fait rien et n'écrit aucun événement
  (`reports.ts:210`).

**Aucune table ni aucun champ nouveau.**

| # | Colonne | Contenu | Déposer ici appelle |
|---|---|---|---|
| 1 | **À évaluer** | `status = completed`, sans décision | `setDecision(id, null)` |
| 2 | **À creuser** | `recruiterDecision = maybe` | `setDecision(id, 'maybe')` |
| 3 | **Retenu** | `shortlisted` | `setDecision(id, 'shortlisted')` |
| 4 | **Recruté** | `hired` | `setDecision(id, 'hired')` |
| 5 | **Écarté** | `rejected` | `setDecision(id, 'rejected')` |

- **Qui entre sur le board** : les entretiens `completed`, et eux seuls.
  - Un entretien `pending` ou `in_progress` n'a rien à évaluer, il reste dans la
    table.
  - Un entretien `expired` ou `cancelled` n'arrive jamais à un rapport.
  - Cas limite : la page candidat permet aujourd'hui de décider sur un entretien
    non terminé, car `setDecision` ne vérifie pas le statut. Ces lignes restent
    visibles dans la table, mais pas sur le board. On ne change pas
    `setDecision` pour autant.
- **Rapport pas encore prêt** (`completed`, `overallScore` absent) : la carte
  apparaît dans « À évaluer » avec un badge « Analyse en cours », et **ne se
  déplace pas** tant que le rapport n'est pas là (Q3).
  - Le tableau de bord suit la même définition : `awaitingReview` =
    `completed` + score + sans décision (`convex/dashboard.ts:101`).
- **Ordre dans une colonne** : il n'est pas manuel, puisqu'il n'y a pas de champ
  de rang, donc pas de migration.
  - « À évaluer » : par `completedAt` croissant, le plus ancien en attente en
    haut (Q4).
  - Les colonnes décidées : par `recruiterDecisionAt` décroissant.
  - Déposer une carte dans sa propre colonne ne fait rien.
- **Ordre des colonnes** : le flux d'abord, « Écarté » en dernier.
- **Étapes personnalisables par rôle** (entretien RH, cas pratique…) : v2
  seulement, si la v1 ne suffit pas. Il faudrait une table `pipelineStages` et
  un champ sur `sessions`, donc une migration. La nouvelle table devra être
  atteignable par l'effacement (CLAUDE.md « Erasure »).

## 2. Portée : par rôle d'abord, toutes offres ensuite

**Aujourd'hui**, les candidats ne sont listés que par rôle, dans l'onglet
« Candidats » de `projects.$projectSlug.index.tsx:265`. Il n'existe **aucune
route** qui liste les candidats de toute l'org. Le fil d'Ariane
`nav:appShell.breadcrumb.candidates` existe pourtant déjà, sans page derrière.

- **K1 — par rôle.**
  - Un sélecteur Table | Board dans l'onglet Candidats.
  - L'onglet et la vue passent dans l'URL : `?tab=candidates&view=board`, validés
    par zod avec `.catch`, comme `?tab=` de `me.tsx:63-74`. Aujourd'hui l'onglet
    n'est pas dans l'URL, et un rechargement retombe sur « overview ».
  - C'est la portée naturelle : on décide des candidats d'un poste entre eux.
- **K2 — toutes offres.**
  - Une route `/app/$orgSlug/candidates`, qui donne enfin une page au fil
    d'Ariane.
  - Une entrée « Candidats » dans `components/app-shell/nav.ts`.
  - Un filtre par rôle dans l'URL, et le titre du rôle sur chaque carte.
  - Le KPI « En attente de décision » du tableau de bord y mène.
  - Utile au recruteur qui gère plusieurs postes : c'est sa boîte de réception.

## 3. Contenu de la carte

| Élément | Source | Note |
|---|---|---|
| Nom du candidat | `candidateName` | Lien vers `/app/$orgSlug/candidates/$sessionId` |
| Score IA | `overallScore` → `ScoreBadge` | Absent : badge « Analyse en cours » |
| Rapport partiel | `reports.partial` | Petit indicateur, si le projecteur peut le lire à bas coût (voir §6.1) |
| Terminé il y a | `completedAt` | Date relative dans la locale de l'app |
| Décidé par | `recruiterDecisionBy` → `memberName` | Colonnes décidées seulement ; « Ancien membre » si le compte est supprimé |
| Rôle | `project.title` | K2 seulement |
| Poignée de glisser | — | Bouton distinct du lien (§5.2) |
| Menu « Déplacer vers… » | — | Obligatoire (§5.2) |

**Volontairement absents** :
- **L'e-mail.** Il ne sert pas à décider, et moins la carte porte de données
  personnelles, mieux c'est.
- **La recommandation IA.** En français, elle partage son libellé avec la
  décision (« À creuser » : `candidates.json:48` et `:124`). Une carte « IA : À
  creuser » dans la colonne « À creuser » se lit comme une décision déjà prise
  (Q2).
- **Le détail des critères.** Il est sur la page du candidat.

**Mention IA** : le board affiche des scores produits par l'IA et permet de
décider en un geste. Il porte donc l'`AiDisclaimer` court, comme
`CandidatesTable.tsx:295`, en permanence et sans bouton de fermeture
(CLAUDE.md « AI and hiring »).

## 4. Règles

1. **Un déplacement est une décision humaine.**
   - Aucun outil de l'assistant ne déplace une carte : `convex/recruiterTools.ts`
     reste en lecture seule, et aucun outil « move » ne s'ajoute.
   - Aucune règle automatique non plus : ni « écarter sous 40 », ni
     « présélectionner le top 3 », ni suggestion pré-cochée.
   - Toute idée de ce genre est une décision produit hors v1, pas un réglage.
2. **Qui déplace** : quiconque voit le rôle, c'est-à-dire son équipe
   (`projectShares`), plus les owners et admins. Le droit de voir le board et
   celui de déplacer une carte sont le même droit. Il n'existe donc pas de carte
   visible mais figée à gérer.
   - Un membre hors de l'équipe du rôle ne voit ni le board de ce rôle, ni ses
     cartes sur le board de l'org (`canSeeProject`).
   - Un observateur en lecture seule demanderait un nouveau rôle ou un drapeau
     sur `projectShares`, donc une migration : question produit v2 (Q1).
3. **Rôle archivé** : `setDecision` l'autorise, car il n'appelle pas
   `requireProjectEditable`. Le board suit la même règle : on finit souvent
   d'embaucher après avoir fermé l'annonce (Q6).
4. **Pas de confirmation, une annulation à la place.** Une décision n'a
   aujourd'hui aucun effet externe : ni e-mail ni tâche planifiée
   (`reports.ts:195-226`). Un toast « Annuler » suffit (§6.3).
   - **Garde-fou pour la suite** : le jour où une décision déclenche quelque
     chose vers le candidat (e-mail de refus, par exemple), le déplacement vers
     cette colonne demande une confirmation explicite. Cette règle est à
     reporter dans CLAUDE.md dans la PR qui ajoutera un tel effet.

## 5. Interface

### 5.1 Bibliothèque : `@dnd-kit/core` seul, épinglé

Mesures du 26/09 : esbuild `--minify`, React en externe, puis gzip -9.

| Option | Version | min | min+gz | État |
|---|---|---|---|---|
| **`@dnd-kit/core`** (DndContext, DragOverlay, draggable, droppable, capteurs) | 6.3.1 | 41,4 Ko | **14,2 Ko** | Stable, figé depuis déc. 2024 |
| `core` + `sortable` + `utilities` | 6.3.1 / 10.0.0 / 3.2.2 | 48,1 Ko | 16,5 Ko | Stable, figé |
| `@dnd-kit/react` + `helpers` | 0.5.0 | 119,4 Ko | 38,7 Ko | 0.x, l'API peut encore bouger avant 1.0 |

**Recommandation : `@dnd-kit/core` seul, en version exacte.**
- Il n'y a pas de réordonnancement dans une colonne (§1), donc `sortable` ne sert
  à rien. Le besoin se réduit à des cartes déplaçables et cinq zones de dépôt.
- Le paquet est figé : zéro changement d'API à suivre. La peer dependency
  `react >=16.8` couvre React 19.
- `@dnd-kit/react` est là où le mainteneur investit. Mais il pèse 2,7 fois plus,
  n'est pas en 1.0, et son principal atout (le clavier entre listes triables
  sans code maison) vise un besoin qu'on n'a pas.
- Le glisser n'est qu'une amélioration : le menu « Déplacer vers… » (§5.2) fait
  tout sans lui. Changer de bibliothèque plus tard ne toucherait donc qu'un
  composant.

**Chargement** :
- Le board est chargé à la demande (`lazy` sur la vue), pour que la vue Table ne
  paie pas `@dnd-kit`.
- Ajouter `@dnd-kit/*` au groupe « recruiter-app-only » d'`eslint.config.mjs`,
  comme S0 le fait pour `motion`. Le budget candidat doit rester identique.

### 5.2 Clavier et alternative au glisser

- **Le menu « Déplacer vers… » est obligatoire sur chaque carte.**
  - WCAG 2.2 SC 2.5.7 (AA) exige une alternative à un seul pointeur pour tout
    glisser.
  - C'est aussi la vue mobile (§5.5) et le chemin le plus sûr au lecteur
    d'écran.
  - Un `DropdownMenu` shadcn (Radix), avec les cinq colonnes, la colonne
    courante désactivée.
- **Glisser au clavier** : `KeyboardSensor`.
  - Espace ou Entrée prend la carte, Échap annule, Espace, Entrée ou Tab la
    dépose.
  - Il faut un `coordinateGetter` maison d'une vingtaine de lignes :
    - ← et → sautent au centre de la colonne voisine ;
    - ↑ et ↓ ne font rien, puisqu'il n'y a pas d'ordre manuel.
  - Pas besoin du getter à 114 lignes de l'exemple multi-conteneurs, qui sert au
    tri.
- **La poignée est séparée du lien.**
  - Le nom est un `Link` : Entrée navigue.
  - La poignée (`GripVertical`, un `<button>` avec `aria-label` traduit) est
    l'activateur (`setActivatorNodeRef`). Sans cette séparation, Entrée sur la
    carte hésiterait entre ouvrir et prendre.
- **Pointeur** : `PointerSensor` avec `activationConstraint: { distance: 8 }`.
  Un clic reste un clic, et dnd-kit bloque le clic qui suit un vrai glisser.

### 5.3 Annonces `aria-live`

`<DndContext accessibility={{ announcements, screenReaderInstructions }}>`.
dnd-kit fournit la région vivante (`role="status"`, `aria-live="assertive"`)
et relie les instructions par `aria-describedby`.

- Tout passe par `t()`, sous `candidates:board.a11y.*`, en `en` et `fr`.
  - Le texte par défaut est anglais et nomme les identifiants bruts
    (« Draggable item k57… »).
  - Les fonctions sont relues à chaque rendu, donc un changement de langue est
    pris en compte.
- Les annonces nomment **le candidat et la colonne**, jamais un id : « Marie
  Dupont prise. Colonne actuelle : À évaluer. » → « … au-dessus de Retenu. » →
  « Marie Dupont déplacée vers Retenu. » / « Déplacement annulé, Marie Dupont
  reste dans À évaluer. »
- Un échec serveur (§6) est annoncé aussi, pas seulement affiché en toast.
- `aria-roledescription` est traduit, sinon il vaut « draggable ».

### 5.4 `motion`

- **Pas de `layout` ni de `layoutId` sur une carte déplaçable.** motion et
  dnd-kit écriraient tous deux `transform` sur le même nœud.
- La carte en mouvement est rendue dans un `DragOverlay`, et la carte d'origine
  passe à une opacité de 0,45.
- motion sert à ce qui est hors du glisser :
  - l'apparition d'une carte arrivée en temps réel (`initial`/`animate` sur
    l'opacité) ;
  - l'état vide d'une colonne ;
  - le compteur de colonne.
- Mouvement réduit : hérité du `MotionConfig` de S0. Si K1 part avant S0, il
  livre sans motion et S4 ajoute l'animation.

### 5.5 Mobile : une liste par colonne

- Sous `md` (`useIsMobile`, `src/hooks/use-mobile.ts`), pas de glisser.
- À la place, cinq sections repliables, chacune avec son titre et son compteur.
  Ce sont les mêmes cartes, avec le menu « Déplacer vers… ».
- Pas de défilement horizontal de colonnes sur téléphone.

### 5.6 Ce qu'on garde de Spectrum (le visuel, pas le code)

**`kanbanboard`** (261 lignes) :
- glisser HTML5 sans clavier ni `aria` ;
- 4 couleurs hexadécimales en `style` inline ;
- « Jan 15 » en dur quelle que soit la date ;
- données de démo.

**`board-empty`** (282 lignes) s'appuie sur les 2 046 lignes
d'`empty-state-kit.tsx`, a ses textes anglais en dur et ses couleurs en
`neutral-*` et `black/[…]`.

On n'installe ni l'un ni l'autre. On reprend, en tokens de `brand.css` :

- **Colonne** : en-tête avec le nom à gauche et le compteur à droite
  (`tabular-nums`) ; une pastille de couleur par colonne, prise des tokens de
  `DecisionBadge` (`destructive`, `warning`, `info`, `success`), neutre pour « À
  évaluer ».
- **Zone de dépôt** : bordure pointillée arrondie, qui s'accentue (bordure plus
  marquée, fond `muted`) quand une carte la survole. Hauteur minimale pour
  qu'une colonne vide reste une cible visible.
- **Carte** : bordure fine, `rounded-lg`, nom en medium, méta en muted. Pied
  séparé par un filet (date, puis « décidé par »). Curseur `grab` sur la poignée
  seulement.
- **Colonne vide** : petit médaillon d'icône et une ligne « Déposez un candidat
  ici » (« Aucun candidat » au clavier ou sur mobile). C'est la variante
  `compact` d'`EmptyState` de S1 ; si S1 n'est pas mergé,
  `components/projects/EmptyState.tsx`.
- **Board vide** (aucun entretien terminé) : un `EmptyState` plein, avec « Inviter
  des candidats » quand `canInvite`.

La recette de portage du plan (§1, ou `KNOWN_ISSUES.md` après S0) s'applique :
en-tête Apache, pas de données de démo, textes par `t()` sous
`candidates.board.*`.

## 6. Données et temps réel

### 6.1 Requêtes

- **K1 — `sessions.board({ projectId })`.**
  - Garde : `requireProjectAccess`.
  - Index : `by_project_and_status` sur `completed`, `order('desc')`,
    `take(BOARD_CAP)` avec `BOARD_CAP = 500`. Renvoie un drapeau `capped`, comme
    `dashboard.overview` (`SCAN_CAP`, `dashboard.ts:23-26`).
  - Si `capped`, un bandeau renvoie à la table. 500 entretiens terminés sur un
    seul poste, ce serait déjà hors norme.
- **K2 — `sessions.orgBoard({ orgId, projectId? })`.**
  - Garde : `requireOrgMember`, puis `canSeeProject` sur chaque ligne, comme
    `dashboard.overview` et `reports.searchCandidates`.
  - Index : `by_org_and_status` sur `completed`, même plafond et même drapeau.
  - Avec `projectId`, `by_project_and_status` et `requireProjectAccess`, comme
    en K1.
  - **Limite connue** : pour un membre, le filtre `canSeeProject` passe après le
    plafond, donc il peut voir moins de 500 cartes alors qu'il en existe plus. Le
    tableau de bord a la même limite. Si c'est gênant, une boucle sur les
    `projectShares` du membre (`by_user`) avec une requête par rôle corrige ça
    (Q5).
- **Projecteur** : `toBoardCard`, écrit à part et plus léger que `toRecruiterRow`.
  - Il ne lit pas `emailLog`, dont `deliveryIssue` coûte une lecture par ligne.
  - Il renvoie `_id, projectId, candidateName, completedAt, overallScore,
    recruiterDecision, recruiterDecisionAt`, plus le nom de qui a décidé, résolu
    une fois par utilisateur.
  - Pas d'e-mail, et un validateur `returns` explicite
    (`convex/returnsContract.test.ts`).
  - `reports.partial` coûterait une lecture de `reports` par carte : ne l'ajouter
    que dénormalisé sur `sessions` par le pipeline, comme `overallScore`
    (`convex/pipeline.ts:573-580`). Sinon, on s'en passe en v1.
- **Pas de pagination** : un board paginé casse les compteurs de colonne, d'où
  le plafond et le drapeau.

### 6.2 Mise à jour optimiste

- `useConvexMutation` est le `useMutation` de `convex/react`
  (`@convex-dev/react-query` le réexporte). `.withOptimisticUpdate` est donc
  disponible sans intermédiaire.
- La mise à jour lit `localStore.getQuery(api.sessions.board, { projectId })`,
  change la `recruiterDecision` de la carte, et remet `recruiterDecisionAt` à
  `Date.now()` pour qu'elle monte en tête de sa colonne.
- Convex rejoue la mise à jour sur chaque résultat serveur tant que la mutation
  n'a pas répondu, puis la retire. En cas d'erreur, la carte revient seule :
  toast d'erreur, par `errorMessageKey`, plus une annonce `aria-live`.
- Les autres vues (page candidat, table, tableau de bord) se mettent à jour par
  la réactivité normale, sans optimisme.

### 6.3 Plusieurs recruteurs, et l'annulation

- **Temps réel** : la requête du board est réactive. Une carte déplacée par un
  collègue change de colonne chez tout le monde, et une nouvelle apparaît dès
  qu'un entretien se termine.
- **Conflit** : A glisse une carte que B vient de déplacer. Aujourd'hui, le
  dernier qui écrit gagne, et l'historique garde les deux. Pour un geste aussi
  rapide qu'un glisser, c'est trop silencieux.
- **Recommandation (K1)** : un argument optionnel `expected: decision | null`
  sur `setDecision`.
  - Si la valeur courante diffère, la mutation lève `ConvexError('decision_changed')`
    sans rien écrire.
  - La carte revient là où B l'a mise, avec le toast « {nom} vient d'être
    déplacé par un collègue ».
  - L'argument est optionnel : aucun appelant existant ne change, et il n'y a
    pas de migration.
- **Annuler** : un toast sonner avec l'action « Annuler », qui appelle
  `setDecision({ sessionId, decision: previous, expected: next })`.
  - Grâce à `expected`, on n'annule pas par-dessus le geste d'un collègue.
  - L'annulation écrit un événement de plus, et l'historique reste vrai.
  - S4 prévoit un `undo-pill` sur `setDecision` : il remplacera ce toast sans
    toucher au backend. Voir §8, contention.
- **Carte qui disparaît pendant un glisser** (effacée, ou son rôle retiré de
  l'équipe) : `onDragEnd` sur un id absent des données ne fait rien.

## 7. Sécurité, effacement, tests

- **Accès** : aucune surface nouvelle hors recruteur. Les deux requêtes
  commencent par leur garde, et `pnpm audit:access:check` doit rester vert. Pas
  de jeton, pas de lien de partage.
- **Limite de débit** : `setDecision` n'en a pas (`convex/rateLimiters.ts`).
  C'est acceptable : l'appelant est un membre authentifié de l'équipe, chaque
  écriture est attribuée, et le no-op sur une valeur identique évite d'empiler
  des événements vides. À revoir seulement si un effet externe s'ajoute (§4.4).
- **Effacement** : rien de nouveau en v1. La v1 ne stocke rien : la décision est
  sur `sessions`, et `decisionEvents` est déjà effacé par `purge.ts`
  (`deleteChildRows`, `convex/erasure.test.ts:186-207`). Si les étapes v2
  arrivent, leur table suit « Erasure » dans CLAUDE.md.
- **Tests K1** (`convex-test`) :
  - `board` : isolation entre orgs, membre hors équipe refusé, projecteur sans
    e-mail, plafond et `capped`.
  - `setDecision` avec `expected` : accepté, refusé, rien écrit en cas de refus.
  - Combler un trou relevé en K0 : aucun test ne vérifie qu'un membre hors
    équipe est refusé par `setDecision` (`teamAccess.test.ts` ne le couvre pas).
  - Front : tests unitaires de la fonction pure sessions → colonnes et des
    annonces.
- **Tests K2** : `orgBoard` avec un membre qui voit 1 rôle sur 3, isolation, et
  le filtre `projectId`.
- **TESTING.md** : K1 ajoute des lignes pour :
  - un déplacement à la souris, au clavier et par le menu ;
  - le lecteur d'écran ;
  - deux navigateurs avec deux membres (conflit, annulation) ;
  - le mobile.

## 8. Découpage

### K1 — Board par rôle (1 PR, backend et front)

**Backend** :
- `sessions.board`, `toBoardCard`, `expected` sur `setDecision`, et leurs tests ;
- `pnpm codegen:api` et `pnpm audit:access:check`.

**Front** :
- `?tab=` et `?view=` dans l'URL de la page rôle.
- `components/candidates/board/` : colonnes, carte, menu « Déplacer vers… »,
  `DndContext` avec capteur clavier et annonces, mise à jour optimiste, toast
  d'annulation, liste sur mobile, `AiDisclaimer`.
- Le lien retour de la page candidat ramène à `?tab=candidates`, avec la vue
  d'origine si la carte l'a passée en paramètre.

**Dépendances** :
- `pnpm add -E @dnd-kit/core`, ajouté aux interdits de la surface candidat ;
- `motion` seulement si S0 est mergé.

**Avant la PR** :
- `pnpm build:app && pnpm bundle:budget`, avec le budget candidat inchangé ;
- captures claires et sombres ;
- une entrée de changelog (visible des utilisateurs).

**Fini quand** :
- une carte passe d'« À évaluer » à « Retenu » à la souris, au clavier seul et
  par le menu, et chaque fois une ligne apparaît dans l'historique de la page
  candidat ;
- un second navigateur voit le déplacement sans recharger ;
- un glisser concurrent reçoit `decision_changed` et la carte se replace ;
- VoiceOver ou NVDA annonce le nom et la colonne ;
- la vue Table ne charge pas `@dnd-kit` (onglet Réseau).

**Contention** :
- `CandidatesTable.tsx` et `candidates.$sessionId.tsx` : S1, S3b PR 2 et S4
  phase 2 y passent aussi (plan §4). K1 touche seulement l'onglet de la page rôle
  et le lien retour de la page candidat.
- `convex/` : K1 écrit du backend. Pas en même temps que S3a sur le même
  déploiement dev (plan §2).

### K2 — Board toutes offres (1 PR, après K1)

**Backend** : `sessions.orgBoard` et ses tests.

**Front** :
- la route `/app/$orgSlug/candidates`, avec `head()`, `errorComponent` et
  `notFoundComponent` ;
- l'entrée de navigation « Candidats » ;
- le filtre par rôle dans l'URL ;
- le titre du rôle sur la carte ;
- le lien depuis le KPI « En attente de décision ».

Les composants du board viennent de K1 sans changement, sauf une prop
`showRole`.

**Fini quand** :
- un membre de l'équipe de 1 rôle sur 3 ne voit que les cartes de ce rôle ;
- un admin voit tout ;
- le fil d'Ariane « Candidats » mène à une vraie page.

### v2 (pas planifiée)

Étapes personnalisables par rôle, observateur en lecture seule : seulement si
les questions Q1 et Q7 le demandent.

## 9. Questions produit à trancher

Chaque question a une recommandation, que la spec applique par défaut.

| # | Question | Recommandation |
|---|---|---|
| Q1 | Faut-il un **observateur en lecture seule** (qui voit le board sans décider) ? Il n'existe pas aujourd'hui | Non en v1 : c'est une migration. Tout membre de l'équipe décide, comme aujourd'hui (`KNOWN_ISSUES.md` § « Decisions and report links are team-level ») |
| Q2 | En français, la décision `maybe` et la recommandation IA `maybe` sont toutes deux « À creuser ». Renommer l'une ? | Oui, avant K1. Par exemple, recommandation IA → « Mitigé » ; la colonne garde « À creuser » |
| Q3 | Peut-on décider d'un candidat dont **le rapport n'est pas prêt** ? La page candidat le permet | Pas depuis le board : la carte est visible mais pas déplaçable. La page candidat reste inchangée |
| Q4 | Ordre dans « À évaluer » : **par ancienneté** ou **par score** ? | Par ancienneté (le plus ancien en haut). Trier par score pousse à décider sur le chiffre de l'IA sans ouvrir le rapport. Un tri par score reste possible en option, désactivé par défaut |
| Q5 | Le board toutes offres peut-il afficher moins de cartes qu'il n'en existe, pour un membre, au-delà de 500 entretiens terminés dans l'org ? | Oui en K2, avec le drapeau `capped`. La requête par rôle ne se fait que si un client s'en plaint |
| Q6 | Les **rôles archivés** : sur le board de l'org ? Déplaçables ? | Exclus par défaut du board de l'org (filtre « Afficher les postes archivés »), mais déplaçables : on finit d'embaucher après avoir fermé l'annonce |
| Q7 | Les 4 décisions suffisent-elles, ou faut-il des **étapes intermédiaires** (entretien RH, cas pratique, offre envoyée) ? | Commencer par les 4. La v2 ne se justifie que si les recruteurs le demandent après usage |
| Q8 | « Recruté » et « Écarté » doivent-ils **prévenir le candidat** (e-mail) un jour ? | Hors v1. Si oui, déplacer vers ces colonnes demande une confirmation (§4.4) |
| Q9 | Le board devient-il la **vue par défaut** de l'onglet Candidats ? | Non : la table reste par défaut en K1. Revoir après usage |
