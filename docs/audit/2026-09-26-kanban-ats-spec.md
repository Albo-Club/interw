# Interw — kanban ATS : spec (lot K0)

Répond point par point au §5 de `2026-09-26-plan-spectrum-ui.md`. Aucun code
applicatif ici : cette spec découpe K1 et K2 (§8) et liste ce que Benjamin doit
trancher (§9). Chaque question du §9 a une recommandation, que la spec applique
en attendant.

**Sources** : code de `main` au 26/09 (`82db83b`), Spectrum UI au commit
`acdc998`, `@dnd-kit` mesuré le 26/09 (§5.1).

## 0. Une correction au plan

**Il n'y a pas de rôle `viewer`.** Les rôles d'org sont `owner | admin | member`
(`convex/schema.ts:4-8`, `convex/lib/auth.ts:13-23`). La règle « le `viewer` ne
déplace rien » ne visait personne. Ce qui en tient lieu est au §4. Le plan est
corrigé dans la même PR.

## 1. Colonnes v1, sans migration (D2 : confirmée)

La décision vit sur la ligne `sessions` : `recruiterDecision`,
`recruiterDecisionBy` et `recruiterDecisionAt` (`convex/schema.ts:444-446`).
Chaque changement ajoute une ligne à `decisionEvents` (`schema.ts:730-741`).
`reports.setDecision({ sessionId, decision })` couvre déjà tout ce qu'un
déplacement demande :

- `decision: null` retire la décision ;
- renvoyer la décision courante ne fait rien et n'écrit aucun événement
  (`convex/reports.ts:210`).

**Aucune table, aucun champ, aucun index nouveau.**

| Colonne | Libellé (clé existante) | Contenu | Déposer ici envoie |
|---|---|---|---|
| À évaluer | `dashboard:interw.awaitingReview` | Aucune décision | `decision: null` |
| À creuser | `candidates:decision.maybe` | `maybe` | `'maybe'` |
| Retenu | `candidates:decision.shortlisted` | `shortlisted` | `'shortlisted'` |
| Recruté | `candidates:decision.hired` | `hired` | `'hired'` |
| Écarté | `candidates:decision.rejected` | `rejected` | `'rejected'` |

- **Qui entre sur le board** : les entretiens `completed`, et eux seuls.
  - Les autres statuts n'ont rien à évaluer ; ils restent dans la table.
  - Une décision prise sur un entretien non terminé (la page candidat le permet,
    car `setDecision` ne vérifie pas le statut) n'apparaît donc que dans la
    table.
- **Pas de score encore** : la carte affiche `candidates:recommendation.none`
  (« Pas encore analysé »), comme la table. Elle se déplace comme les autres :
  le board applique la règle de `setDecision`, sans règle à lui.
- **Ordre dans une colonne** : il n'est pas manuel (pas de champ de rang).
  - « À évaluer » : par `completedAt` croissant, l'attente la plus longue en haut
    (Q3).
  - Les colonnes décidées : par `recruiterDecisionAt` décroissant.
  - Déposer une carte dans sa propre colonne ne fait rien.
- **Ordre des colonnes** : celui du tableau ci-dessus, dans une seule constante.
  Elle vit à côté de la fonction pure sessions → colonnes, dans
  `src/components/candidates/candidate-rows.ts`, qui porte déjà les règles de
  liste et leurs tests.

## 2. Portée : par rôle d'abord, toutes offres ensuite

**Aujourd'hui**, les candidats ne sont listés que par rôle, dans l'onglet
« Candidats » de `projects.$projectSlug.index.tsx:265`. Il n'existe **aucune
route** qui liste les candidats de toute l'org. Le fil d'Ariane
`nav:appShell.breadcrumb.candidates` existe pourtant déjà, sans page derrière.

- **K1 — par rôle.**
  - Un sélecteur Table | Board dans l'onglet Candidats.
  - L'onglet et la vue passent dans l'URL : `?tab=candidates&view=board`, validés
    par zod avec `.catch`, comme `?tab=` de `me.tsx:63-74`. Cela corrige au
    passage l'onglet qui retombe sur « overview » à chaque rechargement.
  - C'est la portée naturelle : on compare les candidats d'un même poste.
- **K2 — toutes offres.**
  - Une route `/app/$orgSlug/candidates`, dans le fichier
    **`candidates.index.tsx`**. Un fichier `candidates.tsx` deviendrait le
    parent de `candidates.$sessionId.tsx`, et la page candidat s'afficherait à
    l'intérieur du board.
  - Une entrée « Candidats » dans `components/app-shell/nav.ts`.
  - Un filtre par rôle dans l'URL, et le titre du rôle sur chaque carte.
  - Le KPI `awaitingReview` du tableau de bord y mène.
  - C'est la boîte de réception du recruteur qui gère plusieurs postes.

## 3. Contenu de la carte

| Élément | Source |
|---|---|
| Nom, avec lien vers la page du candidat | `candidateName` |
| Score IA | `overallScore` → `ScoreBadge`, sinon « Pas encore analysé » |
| Date de fin d'entretien | `completedAt`, en `toLocaleDateString(locale)` comme la table (`columns.tsx:134`) |
| Rôle (K2 seulement) | titre du projet |
| Menu « Déplacer vers… » | §5.2 |
| Poignée de glisser (écran `md` et plus) | §5.2 |

**Volontairement absents** :
- **L'e-mail** : il ne sert pas à décider, et une carte réduite au minimum limite
  les données personnelles affichées.
- **La recommandation IA** : sur une carte qu'on déplace d'un geste, elle ancre
  la décision sur l'avis de la machine. Le score suffit, et le rapport est à un
  clic.
- **« Décidé par »** : l'historique de la page candidat le montre déjà
  (`candidates.$sessionId.tsx:622-657`).

**Mention IA** : le board porte l'`AiDisclaimer` court, comme
`CandidatesTable.tsx:295`, en permanence et sans bouton de fermeture. La règle
est la même partout : toute surface qui montre un score IA porte la mention.

## 4. Règles

1. **Un déplacement est une décision humaine.**
   - Aucun outil de l'assistant ne déplace une carte : `convex/recruiterTools.ts`
     reste en lecture seule.
   - Aucune règle automatique : ni « écarter sous 40 », ni « présélectionner le
     top 3 », ni suggestion pré-cochée. Ce serait une décision produit, pas un
     réglage.
2. **Qui déplace** : quiconque voit le rôle, c'est-à-dire son équipe
   (`projectShares`), plus les owners et admins. C'est le droit actuel de
   `setDecision`, voulu au niveau de l'équipe : `KNOWN_ISSUES.md` § « Decisions
   and report links are team-level ».
   - Pour le kanban, voir et déplacer sont donc le même droit. Il n'y a pas de
     carte « visible mais figée » à concevoir.
   - Un membre hors de l'équipe d'un rôle ne voit aucune de ses cartes.
   - Un observateur en lecture seule demanderait une migration (Q1).
3. **Rôle archivé** : ses cartes restent sur le board et restent déplaçables,
   comme `setDecision` le permet (il n'appelle pas `requireProjectEditable`). On
   finit souvent d'embaucher après avoir fermé l'annonce.
4. **Pas de confirmation, une annulation à la place.** Une décision n'a aucun
   effet externe aujourd'hui : ni e-mail, ni tâche planifiée
   (`reports.ts:195-226`).
   - **Garde-fou** : le jour où une décision déclenche quelque chose vers le
     candidat, un déplacement vers cette colonne demande une confirmation. La
     PR qui ajoute cet effet reporte la règle dans CLAUDE.md, et revoit
     l'absence de limite de débit sur `setDecision`.

## 5. Interface

### 5.1 Bibliothèque : `@dnd-kit/core` seul, en version exacte

Mesures du 26/09 : esbuild `--minify`, React en externe, gzip -9.

| Option | Version | min | min+gz | État |
|---|---|---|---|---|
| **`@dnd-kit/core`** (contexte, overlay, draggable, droppable, capteurs) | 6.3.1 | 41,4 Ko | **14,2 Ko** | Stable, figé depuis déc. 2024 |
| `core` + `sortable` + `utilities` | 6.3.1 / 10.0.0 / 3.2.2 | 48,1 Ko | 16,5 Ko | Stable, figé |
| `@dnd-kit/react` + `helpers` | 0.5.0 | 119,4 Ko | 38,7 Ko | 0.x, l'API peut changer avant 1.0 |

**Pourquoi `core` seul** :
- Il n'y a pas de tri dans une colonne, donc `sortable` est inutile. Le besoin se
  réduit à des cartes déplaçables et cinq zones de dépôt.
- Le paquet est figé, donc aucune API à suivre. Sa peer dependency
  `react >=16.8` couvre React 19.
- `@dnd-kit/react` est là où le mainteneur investit, mais il pèse 2,7 fois plus,
  n'est pas en 1.0, et son atout (le clavier entre listes triées) vise un besoin
  qu'on n'a pas.
- Le glisser n'est qu'une couche en plus du menu (§5.2). Changer de bibliothèque
  plus tard ne toucherait donc qu'un composant.

**Chargement** :
- Seule la couche glisser importe `@dnd-kit` : le `DndContext`, les zones de
  dépôt et l'overlay.
- Elle est chargée à la demande, comme `AiPanelHost.tsx:17`, et seulement quand
  `matchMedia('(min-width: 768px)')` est vrai.
- Les colonnes, les cartes et le menu n'en dépendent pas. La vue Table et les
  téléphones ne le téléchargent donc jamais.
- `useIsMobile` ne convient pas ici : il vaut `false` au premier rendu.
- Ajouter `@dnd-kit/*` au groupe « recruiter-app-only » d'`eslint.config.mjs`,
  comme S0 le fait pour `motion`.

### 5.2 Clavier et lecteur d'écran : le menu, pas le glisser au clavier

**Écart assumé avec le plan**, qui citait le capteur clavier (Q8).

- **Chaque carte a un menu « Déplacer vers… »**, un `DropdownMenu` shadcn
  (Radix) avec les cinq colonnes, la colonne courante désactivée.
  - C'est l'alternative au glisser qu'exige WCAG 2.2 SC 2.5.7 (AA).
  - Au clavier, Tab puis Entrée, puis les flèches dans le menu : c'est le motif
    que les lecteurs d'écran connaissent. Le glisser au clavier de dnd-kit
    (prendre, flèches, déposer), à l'inverse, se comprend mal sans la vue.
  - C'est aussi le seul geste sur téléphone (§5.5).
- **Le glisser est pour la souris et le tactile large** :
  - `PointerSensor` avec `activationConstraint: { distance: 8 }` : un clic reste
    un clic.
  - L'activateur est la poignée (`GripVertical`), sortie de l'ordre de
    tabulation (`tabIndex={-1}`, `aria-hidden`). Le nom reste un `Link`.
  - Sans `KeyboardSensor`, il n'y a ni `coordinateGetter` ni texte
    `screenReaderInstructions` à écrire. Les ajouter plus tard reste possible,
    dans le même composant.
- **Annonces** : un seul message, quel que soit le chemin (menu ou glisser).
  - Le toast sonner du résultat : « {nom} déplacé vers {colonne} » avec
    « Annuler », ou le message d'erreur via `errorMessageKey`.
  - La zone de notifications de sonner est `aria-live`. K1 vérifie au lecteur
    d'écran que le message est bien lu.
  - Les nouvelles clés vont sous `candidates:board.*`. Les noms de colonnes
    reprennent les clés du §1.

### 5.3 `motion`

- K1 livre **sans** `motion`. Si S4 anime ensuite l'apparition d'une carte ou
  les compteurs, il ajoute cette animation lui-même.
- **Piège à garder pour S4** : pas de `layout` ni de `layoutId` sur une carte
  déplaçable. motion et dnd-kit écriraient tous deux `transform` sur le même
  nœud.
- La carte en mouvement est rendue dans un `DragOverlay`, et l'original passe à
  une opacité de 0,45.

### 5.4 Ce qu'on garde de Spectrum : le visuel

On n'installe ni `kanbanboard` ni `board-empty`, pour les raisons que donne le
plan au §5. Deux défauts s'ajoutent : `kanbanboard` affiche « Jan 15 » en dur
quelle que soit la date, et `board-empty` dépend des 2 046 lignes
d'`empty-state-kit.tsx`. On reprend, en tokens de `brand.css` :

- **Colonne** :
  - un en-tête avec le nom à gauche et le compteur à droite (`tabular-nums`) ;
  - une pastille aux tokens de `DecisionBadge` (`destructive`, `warning`,
    `info`, `success`), neutre pour « À évaluer ».
- **Zone de dépôt** : une bordure pointillée arrondie, plus marquée sur fond
  `muted` quand une carte la survole. Une hauteur minimale garde une colonne vide
  visible comme cible.
- **Carte** : une bordure fine en `rounded-lg`, le nom en medium, les méta en
  muted. Le curseur `grab` n'apparaît que sur la poignée.
- **Colonne vide** : la variante `compact` d'`EmptyState` de S1, ou
  `components/projects/EmptyState.tsx` si S1 n'est pas mergé.
- **Board vide** (aucun entretien terminé) : un `EmptyState` plein, avec
  « Inviter des candidats » quand `canInvite`.

### 5.5 Mobile

Sous `md`, les mêmes colonnes s'empilent en CSS (`flex-col md:flex-row`) :

- pas de glisser, et la poignée est cachée ;
- le menu « Déplacer vers… » est le seul geste ;
- pas de branche JavaScript, pas d'état replié.

## 6. Données et temps réel

### 6.1 Une requête : `sessions.board`

**K1 : `sessions.board({ projectId })`**
- Garde : `requireProjectAccess`.
- Index : `by_project_and_status` sur `completed`, avec `take(BOARD_CAP)`.
- `BOARD_CAP` vaut 400, la valeur de `SCAN_CAP` dans `dashboard.ts:25`. La
  réponse porte un drapeau `capped`.
  - Quand il est levé, les compteurs s'affichent en « N+ »
    (`dashboard:interw.atLeast`, comme `index.tsx:60-61`), et un bandeau le
    signale avec une clé nouvelle, `candidates:board.capped`.
  - **L'ordre de l'index est celui de l'invitation** (`_creationTime`). Au-delà
    du plafond, `desc` écarte donc les plus anciens invités, qui sont aussi ceux
    qui attendent le plus en « À évaluer ».
  - Un poste qui dépasse 400 entretiens terminés est hors norme. Si ça arrive,
    le remède est un index `['projectId', 'status', 'recruiterDecision']`, qui
    ne demande aucune migration de données, pour lire « À évaluer » à part.

**Projecteur `toBoardCard`**
- Il renvoie `_id, projectId, candidateName, completedAt, overallScore,
  recruiterDecision, recruiterDecisionAt`.
- Il est distinct de `toRecruiterRow` (`convex/sessions.ts:59`) : celui-ci
  renvoie l'e-mail et lit `emailLog` pour chaque ligne.
- Il reprend les noms de champs de la ligne « Récent » de `dashboard.overview`
  (`dashboard.ts:110-117`), ou l'inverse : pas deux formes pour la même carte.

**Pas de pagination** : un board paginé fausse les compteurs, d'où le plafond et
son drapeau.

**Coût de réactivité, connu et accepté**
- Après `completed`, le pipeline écrit environ N+3 fois sur la ligne `sessions`
  d'un entretien à N réponses (`pipeline.ts:171, 382, 440, 577`).
- Chaque écriture relance le board ouvert sur ce rôle.
- Sortir ces compteurs de `sessions` soulagerait aussi `dashboard.overview`,
  mais c'est hors kanban.

**K2 : le même `sessions.board`, qui accepte `{ orgId }` à la place de
`{ projectId }`**
- Un seul endpoint, une seule mise à jour optimiste.
- La visibilité passe par un helper dans `convex/lib/projectAccess.ts`, « les
  entretiens terminés que l'appelant peut voir » :
  - owners et admins (`seesEverything`) : `by_org_and_status` ;
  - membres : leurs `projectShares` (une lecture), puis `by_project_and_status`
    par rôle, fusionnés sous le même plafond.
  - **Piège** : `sharedProjectIds` lit `by_user` seul et renvoie les rôles de
    **toutes** les orgs de l'utilisateur. Le helper ne garde que les lignes où
    `share.orgId === orgId` (le champ existe, `schema.ts:598-607`). Sinon, un
    membre de deux orgs verrait les cartes de B sur le board de A.
  - L'`orgId` interrogé est celui que `requireOrgMember` vient de vérifier.
- On ne lit ni ne vérifie ligne par ligne. Un membre qui n'a qu'un rôle sur 30 ne
  lit que ce rôle, et `capped` compte ses cartes à lui, pas le volume de l'org.
- `dashboard.overview` filtre aujourd'hui après son `take` et sous-compte donc
  pour un membre. Il pourra adopter ce helper, mais dans une PR à part.

### 6.2 Mise à jour optimiste

- `useConvexMutation` est le `useMutation` de `convex/react` : on appelle
  `.withOptimisticUpdate`.
- La mise à jour parcourt `localStore.getAllQueries(api.sessions.board)` et, dans
  chaque résultat chargé, change la carte par son `_id` : `recruiterDecision`,
  et `recruiterDecisionAt = Date.now()`. K1 et K2 partagent cette même mise à
  jour.
- En cas d'erreur, Convex retire la mise à jour et la carte revient seule. Le
  toast d'erreur s'affiche (§5.2).

### 6.3 Plusieurs recruteurs, et l'annulation

- **Temps réel** : la requête est réactive. Le déplacement d'un collègue et
  l'arrivée d'un entretien terminé s'affichent sans recharger.
- **Conflit** : le dernier qui écrit gagne, comme sur la page candidat
  aujourd'hui, et l'historique garde les deux gestes. C'est une limite connue.
  - Si elle gêne, le correctif est général : un argument `expected` requis sur
    `setDecision`, pour tous les appelants, page candidat comprise. Il se fait
    dans une PR à part, pas pour le board seul.
- **Annuler** : l'action du toast rappelle `setDecision` avec la décision
  précédente. L'annulation écrit un événement de plus, et l'historique reste
  vrai.
  - L'`undo-pill` de S4 pourra remplacer ce toast sans toucher au backend.
- **Lien retour de la page candidat** :
  - si `useCanGoBack()`, il appelle `router.history.back()` ;
  - sinon, il mène au rôle avec `?tab=candidates`.
  - On revient ainsi au board, à la table, à la recherche ou au tableau de bord,
    sans paramètre propre au board.

## 7. Sécurité, effacement, tests

- **Accès** : aucune surface nouvelle hors recruteur, ni jeton ni lien de
  partage.
  - `sessions.board` commence par sa garde : `requireProjectAccess`, ou en K2
    `requireOrgMember` plus le helper de visibilité.
  - `pnpm audit:access:check` reste vert.
- **Effacement** : rien de nouveau.
  - La décision est sur `sessions`.
  - `decisionEvents` est déjà effacé par `purge.ts` (`deleteChildRows`,
    `convex/erasure.test.ts:186-207`).
- **Tests K1** :
  - `convex-test` sur `board` : isolation entre orgs, membre hors équipe refusé,
    pas d'e-mail dans la réponse, plafond et `capped`.
  - Combler un trou relevé en K0 : aucun test ne vérifie qu'un membre hors
    équipe est refusé par `setDecision` (`teamAccess.test.ts` ne le couvre pas).
  - Front : la fonction pure sessions → colonnes, dans `candidate-rows.test.ts`.
- **Tests K2** :
  - le helper de visibilité avec un membre qui voit 1 rôle sur 3, puis un admin ;
  - l'isolation entre orgs, y compris pour un membre qui a des rôles dans deux
    orgs : le board de A ne montre aucune carte de B.
- **TESTING.md** : K1 ajoute des lignes pour :
  - un déplacement à la souris et par le menu ;
  - le lecteur d'écran ;
  - deux navigateurs avec deux membres ;
  - l'annulation ;
  - le mobile.

## 8. Découpage

Les fichiers que d'autres lots touchent aussi sont listés dans le §4 du plan,
qui fait foi.

### K1 — Board par rôle (1 PR, backend et front)

**Backend** :
- `sessions.board({ projectId })`, `toBoardCard` et leurs tests ;
- le test de refus hors équipe de `setDecision` ;
- `pnpm codegen:api` et `pnpm audit:access:check`.

**Front** :
- `?tab=` et `?view=` sur la page rôle ;
- `components/candidates/board/` : colonnes, carte, menu, couche glisser chargée
  à la demande, mise à jour optimiste, toast avec annulation, `AiDisclaimer` ;
- la constante des colonnes et la fonction pure dans `candidate-rows.ts` ;
- le lien retour de la page candidat (§6.3).

**Dépendance** : `pnpm add -E @dnd-kit/core`, ajouté aux interdits de la surface
candidat.

**Avant la PR** :
- `pnpm build:app && pnpm bundle:budget`, avec le budget candidat inchangé ;
- captures claires et sombres ;
- une entrée de changelog.

**Fini quand** :
- une carte passe d'« À évaluer » à « Retenu » à la souris, et par le menu au
  clavier seul ;
- chaque déplacement ajoute une ligne à l'historique de la page candidat ;
- un second navigateur voit le déplacement sans recharger ;
- « Annuler » ramène la carte ;
- un lecteur d'écran lit le résultat ;
- ni la vue Table ni un téléphone ne chargent `@dnd-kit` (onglet Réseau).

### K2 — Board toutes offres (1 PR, après K1)

**Backend** : `sessions.board({ orgId })`, le helper de visibilité dans
`projectAccess.ts`, et leurs tests.

**Front** :
- `candidates.index.tsx`, avec `head()`, `errorComponent` et
  `notFoundComponent` ;
- l'entrée de navigation ;
- le filtre par rôle dans l'URL ;
- le titre du rôle sur la carte ;
- le lien depuis le KPI `awaitingReview`.

**Fini quand** :
- un membre de l'équipe de 1 rôle sur 3 ne voit que les cartes de ce rôle, et
  `capped` ne compte que les siennes ;
- un admin voit tout ;
- le fil d'Ariane « Candidats » mène à une vraie page.

### Plus tard, si l'usage le demande

- Étapes personnalisables par rôle (Q5). Il faudrait une table `pipelineStages`
  et un champ sur `sessions`, donc une migration, et la nouvelle table devra être
  atteignable par l'effacement (CLAUDE.md « Erasure »).
- Observateur en lecture seule (Q1).
- `expected` sur `setDecision` (§6.3).

## 9. Questions produit à trancher

| # | Question | Recommandation (appliquée par la spec) |
|---|---|---|
| Q1 | Faut-il un observateur en lecture seule, qui voit le board sans décider ? | Non en v1 (§4.2) |
| Q2 | La décision `maybe` et la recommandation IA `maybe` sont toutes deux « À creuser » (`fr/candidates.json:48` et `:124`, `fr/report.json:13`). Renommer la recommandation ? | Oui, avant K1, dans les deux fichiers. Par exemple « Mitigé ». La colonne garde « À creuser » |
| Q3 | Ordre dans « À évaluer » : par ancienneté, ou par score ? | Par ancienneté. Trier par score pousse à décider sur le chiffre de l'IA (§1) |
| Q4 | Les rôles archivés figurent-ils sur le board de l'org ? | Oui, sans filtre (§4.3) |
| Q5 | Les 4 décisions suffisent-elles, ou faut-il des étapes (entretien RH, cas pratique, offre envoyée) ? | Commencer par les 4 (§8, « Plus tard ») |
| Q6 | « Recruté » ou « Écarté » préviendront-ils un jour le candidat par e-mail ? | Hors v1. Si oui, avec confirmation (§4.4) |
| Q7 | Le board devient-il la vue par défaut de l'onglet Candidats ? | Non : la table reste par défaut en K1. À revoir après usage |
| Q8 | Le menu « Déplacer vers… » suffit-il comme chemin clavier, à la place du glisser au clavier que citait le plan ? | Oui (§5.2). Le glisser au clavier reste ajoutable plus tard |
