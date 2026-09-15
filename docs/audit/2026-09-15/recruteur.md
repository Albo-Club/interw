# Audit — Application recruteur et rapport partagé (Interw)

Périmètre : `src/routes/__root.tsx`, `src/router.tsx`, `src/start.ts`,
`src/routes/app/**`, `src/routes/r/$shareToken.tsx`, `src/routes/index.tsx`,
`src/components/{app-shell,projects,candidates,report,dashboard,ai,ai-elements,items,data-table}/**`,
`src/lib/*`, `src/locales/**`, `src/styles/*`, `vercel.json`, plus les
fonctions Convex appelées par ces écrans. Le parcours candidat `/s/**` est
hors périmètre (autre agent). Lecture seule ; `pnpm build` exécuté pour
mesurer les bundles.

---

## Résumé

Le socle est bon : i18n en parité **exacte** `en`/`fr` sur les 16 namespaces,
tokens sémantiques `success/warning/info/destructive` complets en clair et en
sombre, `tabular-nums` presque partout, états vides conçus, squelettes de
chargement sur les écrans de données, découpage du bundle par route effectif,
gardes serveur systématiques (`requireProjectAccess` en première instruction),
projecteurs explicites sur le rapport partagé, disclaimer IA permanent. Le
travail de fond est réel, et la fiche candidat s'ouvre bien sur le verdict.

Mais trois choses empêchent de le livrer. **(1) L'expiration d'un lien de
rapport partagé est calculée à partir d'une horloge fournie par le client** :
un lien expiré reste lisible, vidéos signées comprises. **(2) La boîte de
dialogue de partage de poste remet la sélection à zéro à l'ouverture et écrase
la restriction** : ouvrir puis enregistrer rend public un poste confidentiel.
**(3) Le copilote embarque encore les outils d'écriture `items` du template**,
son prompt système annonce « create / update / delete items » et son état vide
propose « Crée un élément nommé "Roadmap" » — dans un produit dont la règle
est « les outils de l'assistant sont en lecture seule ».

Au-delà, le produit ressemble encore beaucoup au template : « Items » dans la
barre latérale avec sa route vivante, la page d'accueil qui annonce « B2B MVP
starter template », le titre d'onglet « interw — MVP starter », et un panneau
« Nouveautés » qui affiche `entries.report-sharing.title` en clair. Côté
métier, le tableau des candidats n'a **ni score ni recommandation ni tri ni
filtre** — on ne peut donc pas comparer, ce qui est pourtant la raison d'être
d'un tableau ; l'écran super admin ne montre aucun compteur d'échec de file
alors que le prompt l'exige ; et plusieurs fonctions Convex du périmètre v1
(média d'intro, pondération des critères par question, avatar de persona, lien
d'invitation, suppression de poste) existent côté serveur sans aucune UI.

---

## Constats par sévérité

### Critique

#### C1 — L'expiration d'un lien de rapport partagé est décidée par le client

`convex/shares.ts:37-57`, appelée par `convex/shares.ts:144` (`view`, query
publique) et `convex/shares.ts:256` (`sharedMediaUrls`, action publique).

```ts
async function resolveShare(ctx, token, now) {   // ← `now` vient de l'argument
  ...
  if (share.expiresAt !== undefined && share.expiresAt < now) {
    return { state: 'expired', share: null }
  }
```

```ts
export const view = query({ args: { token: v.string(), now: v.number() }, ... })
export const sharedMediaUrls = action({ args: { token: v.string(), now: v.number() }, ... })
```

Côté client, `src/routes/r/$shareToken.tsx:42` fige `now` au montage
(`useState(() => Date.now())`), mais rien n'oblige un appelant à être ce
client : toute fonction Convex publique est appelable par quiconque connaît
l'URL du déploiement (prompt §3.7). `view({ token, now: 0 })` renvoie le
rapport complet d'un lien expiré, et `sharedMediaUrls({ token, now: 0 })`
signe les URL des vidéos d'entretien. La révocation, elle, tient (c'est un
état serveur) ; l'expiration ne tient pas.

**Conséquence** : « le lien expire dans 30 jours » est faux. Un manager à qui
on a partagé un rapport, ou quiconque a récupéré l'URL dans un fil d'e-mail,
garde un accès permanent à l'évaluation nominative et aux vidéos d'un
candidat. C'est exactement la classe de faille que le prompt §7 interdit
(« filtrer un jeton côté client »), déplacée sur l'horloge.

**Correctif** : lire `Date.now()` dans `resolveShare` (une query Convex a une
horloge de transaction déterministe ; l'action encore plus) et retirer `now`
des arguments publics. Si la réactivité pose problème pour qu'un onglet ouvert
bascule sur « expiré », traiter ça côté UI avec un `setInterval` comme le fait
déjà `src/routes/app/$orgSlug/index.tsx:39-43` — mais l'autorisation, jamais.
Ajouter un test à `convex/shares.test.ts` qui appelle `view` avec un `now`
antérieur à `expiresAt` et attend `expired`.

*Confiance : Confirmé.*

---

#### C2 — La boîte « Partager le poste » dé-restreint un poste confidentiel au premier enregistrement

`src/components/projects/ShareProjectDialog.tsx:49-51` et `:61-73`.

```ts
  // `projects.getBySlug` already returns `sharedWith`, but this dialog is also
  // opened from the list, where that read has not happened. Start empty and
  // let the recruiter set the access explicitly rather than guessing.
  useEffect(() => {
    if (open) setSelected([])
  }, [open, projectId])
  ...
      await setShares({ projectId, userIds: selected ?? [] })
```

`convex/projects.ts:363-403` traite `userIds` comme l'ensemble complet : il
supprime toute ligne `projectShares` absente de la liste puis écrit
`restricted: userIds.length > 0`.

**Conséquence** : un poste restreint à trois collègues (recrutement d'un
remplaçant, poste auquel un membre de l'équipe a candidaté — les deux cas
nommés par le commentaire du composant lui-même) redevient visible de toute
l'organisation dès qu'un utilisateur ouvre la boîte et clique « Enregistrer »,
sans un mot d'avertissement. Pire, l'indicateur en haut de la boîte
(`:86-89`) lit la sélection locale, donc il affiche « Tout le monde » à
l'ouverture d'un poste restreint : l'interface affirme l'inverse de l'état
réel.

**Correctif** : passer `sharedWith` en prop depuis `projects.getBySlug` (il
est déjà renvoyé — `convex/projects.ts:168` — et actuellement **jamais
consommé**), et pour l'ouverture depuis la liste, ajouter `sharedWith` à
`ProjectRow` ou charger l'état dans la boîte avant de l'afficher. Tant que la
sélection initiale n'est pas connue, le bouton « Enregistrer » doit être
désactivé.

*Confiance : Confirmé.*

---

#### C3 — Le copilote conserve les outils d'écriture `items` du template

`convex/agent.ts:21` :

```ts
  tools: { ...itemTools, ...recruiterTools },
```

`convex/agentTools.ts:208-213` : `itemTools = { listItems, createItem, updateItem, deleteItem }`.
`convex/lib/instructions.ts:15-17` :

> 'You can act on the current organization through tools: list items, and
> create / update / delete items. Use the read tool to ground your answers
> before acting.'

`src/components/ai/AiPanel.tsx:226-232` :

```ts
// Empty-state suggestions... The example agent only acts on `items`, so the set is
// small; branch on the route to surface page-specific prompts as you add tools.
function suggestionKeys(_pathname: string): Array<string> {
  return ['listItems', 'createItem']
}
```

`src/locales/fr/chat.json:12-15` : « Liste mes éléments », « Crée un élément
nommé « Roadmap » ».

**Conséquence** : le panneau IA est ouvert par défaut
(`src/routes/app/$orgSlug/route.tsx:23`), donc la première chose qu'un
recruteur voit en arrivant dans l'application est une proposition de créer un
« élément » dans une table de démonstration. Et le modèle *peut* réellement
écrire : `createItem`/`updateItem`/`deleteItem` sont enregistrés. Le
`CLAUDE.md` du projet est explicite : « Assistant tools over recruiting data
are read-only ». Les outils `items` ne portent pas de donnée de recrutement,
mais leur présence contredit le message affiché à l'utilisateur, consomme des
étapes du `stepCountIs(10)` et laisse un chemin d'écriture non métier ouvert
au modèle.

**Correctif** : retirer `itemTools` de `convex/agent.ts`, supprimer le
paragraphe « items » de `BASE_INSTRUCTIONS`, et remplacer `suggestionKeys` par
des amorces métier dépendantes de la route (« Quels candidats attendent ma
décision ? », « Résume le rapport de … »), avec les clés `chat:suggestions.*`
correspondantes en `en` et `fr`. Supprimer `convex/agentTools.ts`,
`convex/items.ts` et le namespace `items` dans la foulée (cf. inventaire).

*Confiance : Confirmé.*

---

### Élevé

#### E1 — « Nouveautés » affiche des clés i18n brutes pour les deux entrées Interw

`src/components/app-shell/WhatsNew.tsx:81` et `:84`, et
`src/routes/app/$orgSlug/changelog.tsx:50` et `:53` lisent
`` t(`entries.${entry.id}.title`) ``. Or dans `src/locales/{en,fr}/changelog.json`,
`report-sharing` et `async-interviews` sont écrits **au premier niveau**, pas
sous `entries` :

```json
{
  "async-interviews": { "title": "Asynchronous video interviews", "body": "…" },
  "report-sharing":   { "title": "Share a report by link", "body": "…" },
  …
  "entries": { "signin-hardening": { … }, "ai-panel": { … }, … }
}
```

Vérification automatique : les 9 entrées du template résolvent (`entries.OK`),
les 2 entrées Interw sont `TOP-LEVEL (renders raw key!)` en `en` comme en `fr`.

**Conséquence** : `LATEST_CHANGELOG_ID = 'report-sharing'`
(`src/lib/changelog.ts:18`) fait apparaître la pastille « non lu » sur le
bouton de la barre latérale ; le recruteur clique, et les deux entrées les plus
récentes s'affichent littéralement `entries.report-sharing.title` /
`entries.async-interviews.title`, au-dessus de neuf entrées du template
correctement traduites. C'est la fonctionnalité que l'équipe a poussée pour
annoncer le produit qui est cassée.

**Correctif** : déplacer les deux objets sous `entries` dans les deux fichiers
de locale. Ajouter au test `src/lib/i18n.test.ts` une assertion qui parcourt
`CHANGELOG_ENTRIES` et vérifie que `entries.<id>.title` existe en `en` et en
`fr` — le contrat est structurel, il mérite un garde-fou.

*Confiance : Confirmé.*

---

#### E2 — Le produit se présente encore comme le template

- `src/locales/en/common.json:3` / `fr` : `"appTitle": "interw — MVP starter"`,
  utilisé par `src/routes/__root.tsx:34` comme **titre d'onglet par défaut de
  toute l'application**.
- `src/locales/en/landing.json` : `"metaTitle": "interw — MVP starter"`,
  `"metaDescription": "B2B MVP starter — TanStack Start + Convex."`,
  `"tagline": "B2B MVP starter template. Auth, multi-tenant orgs, and AI chat
  are wired and ready."` — c'est le texte de `src/routes/index.tsx:35`, la
  page d'accueil publique, et la cible du bouton « Retour à l'accueil » des
  écrans d'erreur (`src/components/RouterFallbacks.tsx:44`).
- `src/components/app-shell/nav.ts:41-45` : entrée « Items » (icône `Package`)
  dans le groupe principal de la barre latérale, entre « Postes » et les
  réglages.
- `src/routes/app/$orgSlug/items.tsx` : route vivante, enregistrée dans
  `routeTree.gen.ts`, rendant `ItemsDataTable` (339 lignes) avec CRUD complet
  sur `convex/items.ts`.
- `src/components/app-shell/AppHeader.tsx:26` : `'items'` dans
  `CRUMB_SEGMENTS`, donc un fil d'Ariane « Éléments » est prévu.

**Conséquence** : un client payant voit « Items / Éléments » dans sa
navigation, peut y créer des « éléments » sans rapport avec le recrutement, et
l'onglet de son navigateur dit « MVP starter ». Un prospect qui ouvre
`interw.ai` lit qu'il s'agit d'un modèle de démarrage B2B.

**Correctif** : voir l'inventaire en fin de rapport.

*Confiance : Confirmé.*

---

#### E3 — Les URL de lecture signées ne sont jamais rafraîchies, et sont re-signées à chaque écriture

`src/routes/app/$orgSlug/candidates.$sessionId.tsx:84-96` :

```ts
  useEffect(() => {
    if (!data) return
    let cancelled = false
    fireAndForget(
      mediaUrls({ sessionId: sessionId as never }).then((result) => {
        if (!cancelled) setMedia(result)
      }),
      'playback urls',
    )
    ...
  }, [data, mediaUrls, sessionId])
```

Deux défauts opposés dans le même effet.

**(a) Pas de rafraîchissement.** Les URL vivent une heure
(`convex/reports.ts:215`, commentaire : « these URLs expire in an hour »). Au
bout d'une heure sur un onglet ouvert — cas normal quand on dépouille une
campagne — cliquer sur « 2:14 » sous une citation ne déclenche plus rien de
visible : la balise `<video>` échoue en silence, il n'y a ni `onError`, ni
état d'erreur, ni re-signature. Le recruteur conclut que la preuve n'existe
pas. Or c'est précisément ce lien qui, selon le prompt §4.2, « distingue une
évaluation d'un avis ».

**(b) Re-signature à chaque mutation.** `data` est le résultat d'une query
Convex réactive : il change d'identité à **chaque** écriture sur la session.
Enregistrer une note (`:610`, `onBlur`), poser une décision (`:506`), ou une
simple ligne de `jobLog` suffit. L'effet repart, re-signe toutes les URL (une
signature SigV4 inclut `X-Amz-Date`, donc les chaînes diffèrent), `setMedia`
produit un nouvel objet, `AnswerPlayer` reçoit un nouveau `segments`, et
`src={current?.url}` change sur la balise `<video>`
(`src/components/report/AnswerPlayer.tsx:69`) → le navigateur recharge la
vidéo depuis le début.

**Conséquence** : le recruteur regarde une réponse à 3:40, tape sa note, sort
du champ — la vidéo repart à zéro. Et une heure plus tard, plus aucune preuve
n'est cliquable.

**Correctif** : dépendre de `data?.session._id` (ou d'une liste stable
d'identifiants de segments) plutôt que de `data` ; re-signer sur un
`setTimeout` à ~50 min et sur l'événement `error` de la balise ; mémoriser
`currentTime` avant un changement de `src` et le restaurer. Une bannière
« lien de lecture expiré — recharger » vaut mieux qu'un lecteur muet.

*Confiance : Confirmé.*

---

#### E4 — Le tableau des candidats ne permet pas de comparer

`src/components/candidates/CandidatesTable.tsx:104-117` — colonnes :
candidat, statut, décision, invité le, durée. Pas de score, pas de
recommandation IA, pas de tri, pas de filtre.

Côté serveur, `convex/sessions.ts:60-75` (`listByProject`) renvoie
`toRecruiterRow`, qui ne lit jamais la table `reports` : le score n'est même
pas disponible.

Indice que ce n'est pas un choix : `src/locales/{en,fr}/candidates.json`
définit déjà `list.columns.score` — clé présente, jamais utilisée.

**Conséquence** : le prompt §4.2 dit « les listes sont des tableaux, pas des
cartes : le recruteur compare, et comparer demande des colonnes alignées ». Ici
le tableau existe mais la colonne qui justifie le produit n'y est pas. Pour
classer trente candidats, il faut ouvrir trente fiches. Le tableau de bord, lui,
affiche bien le score (`src/routes/app/$orgSlug/index.tsx:165`) — l'écran le
moins utile pour comparer est le seul à le montrer.

**Correctif** : joindre `reports` dans `toRecruiterRow` (score + recommandation),
ajouter les deux colonnes avec `ScoreBadge`, et passer `CandidatesTable` sur
`useReactTable` comme `ProjectsTable` pour récupérer tri et filtre. Attention :
la pagination Convex est côté serveur (`useConvexPaginatedQuery`), donc le tri
doit soit être fait par index côté Convex, soit être assumé comme un tri de
la page courante.

*Confiance : Confirmé.*

---

#### E5 — L'écran super admin n'affiche aucun compteur d'échec de la file

Le prompt §3.6 est explicite : « Un compteur d'échecs par étape doit être
lisible depuis l'écran super admin. »

`src/routes/app/admin.tsx` est la page du template inchangée : utilisateurs,
organisations, adhésions, invitations en attente, liste des orgs, bascule
super admin. Aucune mention de la file.

Côté serveur, `convex/pipeline.ts:57` écrit bien chaque transition dans
`jobLog`, mais la seule lecture applicative est
`convex/reports.ts:55` — les 20 dernières lignes **d'une session donnée**.
`convex/admin.ts` n'exporte que `purgeExcept`, `overview`, `listOrgs`,
`listUsers`, `setSuperAdmin`.

**Conséquence** : si la transcription échoue sur 40 % des sessions un
mercredi, personne ne l'apprend avant qu'un recruteur ne s'étonne, session par
session. C'est précisément le trou que le prompt §7 (« la chaîne nominale
perdait des sessions ») demandait de fermer.

**Correctif** : une query `admin.pipelineHealth` agrégeant `jobLog` par
`step` × `outcome` sur 24 h / 7 j, et une carte sur `/app/admin` avec les
compteurs et les dernières erreurs. Le schéma est déjà là.

*Confiance : Confirmé.*

---

#### E6 — Des fonctionnalités du périmètre v1 existent côté serveur sans aucune interface

Vérifié par recherche sur `src/` (0 occurrence pour chacune) :

| Fonction Convex | Périmètre v1 (prompt §2) | Interface |
|---|---|---|
| `media.requestIntroUpload` / `attachIntroMedia` / `clearIntroMedia` | « message d'introduction (texte, audio ou vidéo) » | aucune |
| `questions.setCriteriaWeights` (`convex/questions.ts:173`) | « pondération des critères par question » | aucune |
| `projects.remove` (`convex/projects.ts:335`) | supprimer un poste créé par erreur | aucune |
| `sessions.invitationLink` (`convex/sessions.ts:218`) | envoyer le lien soi-même | aucune |
| `sessions.linkStatus`, `sessions.countsForOrg`, `media.playbackUrls` | — | aucune |
| `projects.personaAvatarKey` (schéma) | « persona de marque (nom + avatar) » | aucune |

Le cas le plus visible est l'intro : `src/components/projects/wizard/StepBasics.tsx:25`
propose `INTRO_MODES = ['none', 'text', 'audio', 'video']`, et le sélecteur
enregistre bien le mode (`:184`) — mais seul `'text'` ouvre un champ (`:200`).
Choisir « audio » ou « vidéo » met le poste dans un état où le candidat
attend un média qui ne pourra jamais être enregistré.

**Conséquence** : une impasse silencieuse dans l'assistant, et une porte
`getBySlug` qui renvoie `hasIntroMedia` que personne ne lit. Pour le reste,
c'est du code serveur testé, déployé, et mort.

**Correctif** : brancher `MediaRecorderField` sur l'intro (le composant est
générique à un `questionId` près — l'extraire), ajouter la pondération par
question dans `StepQuestions`, et le bouton « Supprimer le poste » (le serveur
refuse déjà si `sessionCount > 0` avec un code dédié). À défaut, retirer les
modes `audio`/`video` du sélecteur : une impasse est pire qu'une absence.

*Confiance : Confirmé.*

---

#### E7 — Le média enregistré d'une question ne peut pas être réécouté

`src/components/projects/MediaRecorderField.tsx:149-229`. Quand
`hasMedia === true`, la zone affiche l'icône `Video` et le libellé
`questions.media.ready` sur un fond gris. Les seules actions sont
« Réenregistrer » et « Supprimer ». Il n'existe aucun appel à
`media.playbackUrls` depuis `src/` (0 occurrence) et la balise `<video>`
(`:157`) ne reçoit jamais de `src`, seulement un `srcObject` de prévisualisation
en direct.

**Conséquence** : après avoir enregistré dix questions face caméra, le
recruteur ne peut plus vérifier aucune d'entre elles, ni à la relecture, ni le
lendemain. La seule façon de savoir ce qu'il a dit est de tout réenregistrer.
La porte du lot 2 du prompt (« un poste complet est créé, édité, archivé ; **les
médias se rejouent** ») n'est pas franchie.

**Correctif** : appeler `media.playbackUrls` quand `hasMedia`, poser l'URL
signée en `src` et laisser les contrôles natifs. Prévoir le même
rafraîchissement d'URL que E3.

*Confiance : Confirmé.*

---

#### E8 — Le panneau IA pèse sur toutes les pages recruteur, et couvre l'écran sur mobile

`src/routes/app/$orgSlug/route.tsx:10` importe `AiPanel` statiquement dans le
layout d'organisation, et `:23` le laisse ouvert par défaut
(`return match ? match[1] === 'true' : true`).

Mesure sur le build (`.output/public/assets`) :

- `route-DGdAROEm.js` (le layout `/app/$orgSlug`, identifié par
  `ai_panel_state`) : **184 KB bruts**, et il importe statiquement
  `chunk-BO2N2NFS-BJebdz9l.js`.
- `chunk-BO2N2NFS-BJebdz9l.js` : **131 KB gzip** — `streamdown`, `marked`,
  `micromark`/`mdast`, `shiki`, `katex`, `mermaid`.
- Fermeture transitive du layout : 463 KB gzip ; sans ce chunk : 95 KB gzip.

Autrement dit **80 % du coût du layout recruteur est un moteur Markdown avec
coloration syntaxique, KaTeX et Mermaid**, chargé avant le premier rendu du
tableau de bord, que le panneau soit ouvert ou non.

Second défaut, plus gênant encore :

```tsx
// src/routes/app/$orgSlug/route.tsx:119-127
'bg-background flex-col',
'lg:static lg:z-auto … lg:w-[400px] …',
// Mobile: full-screen overlay on the right.
'fixed inset-y-0 right-0 z-50 w-full max-w-md border-l shadow-xl',
aiOpen ? 'flex' : 'hidden',
```

Sous `lg`, l'aside est `fixed … z-50 w-full` — et il est ouvert par défaut.

**Conséquence** : sur téléphone, la première chose qu'un recruteur voit après
connexion est le panneau de chat en plein écran par-dessus son tableau de
bord, sans arrière-plan cliquable, sans `role="dialog"`, sans piège de focus,
sans fermeture par Échap — seulement une croix. Sur poste fixe, l'outil dense
promis par le prompt §4.2 cède 400 px de large à un chat avant qu'on ne lui
demande rien.

**Correctif** : `React.lazy` sur `AiPanel` (le panneau est déjà conditionné
par `org &&`), défaut **fermé** sous `lg`, et sur mobile le traiter comme une
`Sheet` shadcn (piège de focus, Échap, `aria-modal`) plutôt qu'un `aside`
positionné à la main.

*Confiance : Confirmé (mesures de bundle reproductibles via `pnpm build`).*

---

#### E9 — L'effacement RGPD d'un candidat est ouvert à tout membre, sans contrôle de rôle nulle part

Interface : `src/routes/app/$orgSlug/candidates.$sessionId.tsx:177-184` — le
bouton « Supprimer » est rendu inconditionnellement, sans lecture du rôle.

Serveur : `convex/sessions.ts:334-343` (`assertCanDelete`) appelle
`requireProjectAccess`, c'est-à-dire « membre de l'org et le poste est
visible ». Le fichier `convex/lib/projectAccess.ts:88-104` définit pourtant
`requireProjectOwnerOrAdmin` « for destructive actions (delete, …) », utilisé
par `projects.remove` et `projects.setShares` — mais **pas** par la
suppression d'un candidat.

**Conséquence** : l'action la plus destructrice du produit — effacement des
vidéos dans le bucket, du rapport, de la transcription et de la ligne, sans
retour possible (`convex/purge.ts`) — est plus permissive que la suppression
d'un poste vide. Un membre junior peut détruire l'entretien d'un finaliste.

À noter, la même remarque s'applique en plus faible à la décision recruteur
(`convex/reports.ts:151`) : tout membre peut poser ou retirer un
« Recruté » / « Rejeté ». C'est peut-être voulu (« an org is a team, not a
hierarchy », `projectAccess.ts:68`), mais ce n'est écrit nulle part et ce n'est
pas la même chose qu'un effacement irréversible.

**Correctif** : `requireProjectOwnerOrAdmin` dans `assertCanDelete`, et masquer
le bouton hors `admin`/`owner` (le rôle est déjà disponible via
`api.users.me`, cf. `src/routes/app/$orgSlug/settings/route.tsx:21-25`).
Traduire `insufficient_role` dans `candidates.errors` (cf. M3).

*Confiance : Confirmé.*

---

### Moyen

#### M1 — Aucune route ne définit `errorComponent` ni `notFoundComponent`

Recherche sur `src/routes` : les seules occurrences sont
`src/routes/__root.tsx:61` et les deux routes candidat
(`src/routes/s/$token/route.tsx:20-21`, `interview.tsx:30`). Aucune route
`/app/**` ni `/r/**` n'en a.

La règle littérale du `CLAUDE.md` (« Every route with a loader must define
errorComponent AND notFoundComponent ») n'est techniquement pas violée,
puisqu'il n'y a **aucun `loader` dans toute l'application** (0 occurrence) :
tout passe par `useConvexQuery`. Mais l'effet pratique est là : `useConvexQuery`
est le `useQuery` de `convex/react`, qui **lève** l'erreur pendant le rendu.
Un slug de poste inexistant fait remonter `ConvexError('not_found')`
(`convex/projects.ts:117`) jusqu'au `defaultErrorComponent` global
(`src/router.tsx:70`).

**Conséquence** : `/app/mon-org/projects/typo` affiche « Une erreur est
survenue » avec deux boutons : « Réessayer » (qui rejoue la même erreur) et
« Retour à l'accueil » qui renvoie sur la **landing marketing**, pas sur
l'application. Un lien mort de rapport candidat fait la même chose. Et
`Sentry.captureException` (`RouterFallbacks.tsx:23`) enregistre chaque faute de
frappe comme une exception applicative.

**Correctif** : sur les routes qui résolvent un slug ou un id
(`projects.$projectSlug.index`, `.edit`, `candidates.$sessionId`), ajouter un
`errorComponent` qui distingue `not_found` du reste et propose « Retour aux
postes » / « Retour au poste », dans le chrome de l'application.

*Confiance : Confirmé.*

---

#### M2 — L'invitation en masse n'a pas de gabarit d'e-mail éditable

Le lot 3 du prompt demande « Invitation par e-mail individuelle et en masse,
**avec gabarit éditable** ». `src/components/candidates/InviteCandidatesDialog.tsx`
propose deux onglets (unitaire, collé) et un bouton « Envoyer » ; aucun champ
d'objet, aucun corps, aucun aperçu. `convex/sessions.ts:178-190`
(`sendInvitation`) appelle `candidateInvitationEmail` avec des paramètres figés
— ni objet ni texte personnalisables, ni par organisation ni par poste.

Par ailleurs, `parseCandidateList` calcule `duplicates`
(`src/lib/candidate-list.ts:19-20`, `:80-83`) mais la boîte n'affiche jamais ce
tableau : une adresse répétée dans le collage est écartée en silence — ce que
le docstring du module dit justement vouloir éviter.

**Conséquence** : impossible d'adapter le message au poste, à la marque ou au
ton — un point que la spécification héritée (§2.3.3, `candidate_email_subject`
/ `candidate_email_body` avec `{firstName}`, `{jobTitle}`, `{orgName}`)
traitait déjà.

**Correctif** : deux champs (objet, corps) sur le poste, avec les variables
documentées et un aperçu ; et afficher `duplicates` à côté de `invalid`.

*Confiance : Confirmé.*

---

#### M3 — Plusieurs codes d'erreur métier n'ont pas de traduction et tombent sur le message générique

`src/lib/convex-errors.ts:34-43` résout `<namespace>:errors.<code>` avec repli
sur `common:errorBoundary.*`. Comparaison entre les codes réellement levés par
`convex/**` et les clés présentes :

| Code levé | Où | Clé i18n |
|---|---|---|
| `insufficient_role` | `projectAccess.ts:101` → `setShares`, `remove` | absente |
| `not_found` | partout | absente de `projects.errors` et `candidates.errors` |
| `no_report` | `shares.ts:104` | absente de `report.errors` |
| `not_a_member` | `projects.ts:379` | absente |
| `forbidden`, `expired` | `sessions`, `candidate` | absentes |

**Conséquence** : un membre (rôle `member`) qui ouvre « Partager » depuis le
menu de la liste — l'interface ne le lui interdit pas — coche deux collègues,
enregistre, et reçoit « Une erreur est survenue. Veuillez réessayer. » Il ne
saura jamais que l'action lui est réservée aux administrateurs. Même chose pour
un partage de rapport demandé avant que le rapport n'existe.

**Correctif** : ajouter les clés manquantes en `en` et `fr`, et masquer
l'entrée « Partager » du menu pour les non-admins (le rôle est connu côté
client).

*Confiance : Confirmé.*

---

#### M4 — Le tableau de bord fait une requête `reports` par session, plafonnée à 400

`convex/dashboard.ts:60-77` :

```ts
    for (const session of sessions) {
      if (session.status !== 'completed') continue
      const report = await ctx.db
        .query('reports')
        .withIndex('by_session', (q) => q.eq('sessionId', session._id))
        .unique()
      if (report && !session.recruiterDecision) awaitingReview += 1
```

`sessions` vient d'un `.take(RECENT_CAP)` avec `RECENT_CAP = 400`
(`:16`).

**Conséquence** : (a) jusqu'à 400 lectures indexées séquentielles par ouverture
du tableau de bord, dans une query **réactive** re-exécutée à chaque écriture
sur une session ou un rapport de l'organisation ; (b) au-delà de 400 sessions
historiques, « En attente de votre décision » — le chiffre que le commentaire
du code désigne lui-même comme « the number that should decide whether a
recruiter opens the app today » — devient silencieusement faux.

**Correctif** : dénormaliser `hasReport` / `overallScore` sur la ligne
`sessions` au moment où le rapport est écrit (une écriture par session, pas une
lecture par affichage), ou tenir un compteur `awaitingReview` par organisation.
Ne pas mettre ce champ sur `users` (cf. « Hot `users` row »).

*Confiance : Confirmé.*

---

#### M5 — Révoquer un lien de partage ne demande aucune confirmation

`src/components/report/ShareReportDialog.tsx:110-121` : le bouton « Révoquer »
appelle directement la mutation. `convex/shares.ts:127-142` pose `revokedAt` ;
aucune mutation ne le retire.

Le prompt §4.3 dit : « Toute action destructrice demande confirmation et nomme
ce qui sera détruit. » La révocation est irréversible et casse l'accès de la
personne à qui le lien a été envoyé. Trois boutons « Révoquer » alignés dans
une liste de liens tronqués sont une erreur de clic facile.

**Correctif** : `AlertDialog` nommant la date de création et le nombre de vues
du lien concerné, comme le font déjà `StepQuestions` et `CandidatesTable`.

*Confiance : Confirmé.*

---

#### M6 — Inter est déclarée mais jamais chargée

`src/styles/brand.css:49-51` :

```css
  --font-sans:
    'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, …
```

Aucun `@font-face`, aucun `<link>` vers `fonts.googleapis.com`, aucun fichier
de police dans `public/` (recherche sur `src/styles`, `src/routes/__root.tsx`,
`public/` : 0 occurrence).

**Conséquence** : la spécification §12 demande Inter en 300/400/500/600/700.
Sur toute machine qui n'a pas Inter installée — la majorité — l'application
s'affiche en `system-ui` : San Francisco sur macOS, Segoe UI sur Windows,
Roboto sur Android. Les rendus diffèrent d'un poste à l'autre et aucun ne
correspond au design.

**Correctif** : soit charger Inter (`@fontsource-variable/inter` en local,
préférable au CDN Google vu le RGPD et la CSP `font-src 'self' data:` de
`src/start.ts:24` qui **bloque déjà** `fonts.gstatic.com`), soit retirer
`'Inter'` de la pile et assumer la police système.

*Confiance : Confirmé.*

---

#### M7 — `prefers-reduced-motion` n'est honoré que dans le parcours candidat

Recherche sur tout `src/` : les deux seules occurrences de
`prefers-reduced-motion` / `motion-reduce` sont dans
`src/routes/s/$token/interview.tsx:439` et `check.tsx:319`. `src/styles/app.css`
(24 lignes) ne contient aucun bloc `@media (prefers-reduced-motion: reduce)`.

Or l'application recruteur anime : `Skeleton` (`animate-pulse`), les dialogues
et menus Radix via `tw-animate-css`, la barre latérale rétractable, les
`transition-colors` de l'assistant d'édition.

Le skill `web-design-guidelines` classe ce point en MUST.

**Correctif** : un bloc global dans `app.css` neutralisant `animation` et
`transition` sous `prefers-reduced-motion: reduce`, en conservant les
transitions d'état porteuses d'information.

*Confiance : Confirmé.*

---

#### M8 — La recherche globale n'a pas la sémantique d'une liste de complétion

`src/components/candidates/CandidateSearch.tsx` :

- `:55` le conteneur est `hidden w-64 md:block` → sur téléphone le champ
  n'existe visuellement pas, et le raccourci `⌘K` (`:42-45`) appelle
  `inputRef.current?.focus()` sur un élément masqué : **le raccourci ne fait
  rien**, sans message.
- Aucun `role="combobox"`, `aria-expanded`, `aria-controls`,
  `aria-activedescendant`. Les résultats sont des `<Link>` dans un `<ul>` à
  l'intérieur d'un `PopoverContent` dont l'auto-focus est désactivé (`:75`).
  Il n'y a pas de navigation aux flèches : après avoir tapé, on ne peut
  atteindre le premier résultat qu'en tabulant hors du champ.
- Échap ferme le popover mais ne vide pas la requête (`:46`).

**Conséquence** : le seul raccourci clavier « métier » revendiqué par le prompt
(« Dense, données, raccourcis clavier ») est inutilisable au clavier seul et
absent sur mobile. Aucun écran ne documente les raccourcis existants
(`⌘K`, `⌘J`, `⌘B`).

**Correctif** : utiliser `Command` / `CommandDialog` de shadcn (cmdk), qui
apporte la sémantique et la navigation aux flèches, et l'ouvrir en modale sur
toutes les tailles d'écran.

*Confiance : Confirmé.*

---

#### M9 — Couleurs Tailwind en dur sur des surfaces vivantes

L'anti-pattern « Hard-coded color in `className` » du `CLAUDE.md` est respecté
dans tout le code Interw (aucun `bg-red-*`/`text-green-*` dans
`projects/`, `candidates/`, `report/`, `dashboard/index`), mais subsiste dans
du code du template qui **est affiché** :

- `src/components/ai-elements/tool.tsx:68-74` : `text-yellow-600`,
  `text-blue-600`, `text-green-600`, `text-orange-600`, `text-red-600` — les
  icônes d'état de chaque appel d'outil dans le panneau IA, visible à chaque
  interaction, sans variante sombre.
- `src/components/dashboard/KpiCard.tsx:68-75` : `text-emerald-600` /
  `text-rose-600` (branche `delta`, actuellement morte — cf. F5).
- `src/components/auth/active-sessions.tsx:136`, `password-strength.tsx:27-29`,
  `src/routes/app/onboarding.tsx:204`, `src/routes/reset-password.tsx:206`.

Les tokens `--success-strong`, `--warning-strong`, `--info-strong`,
`--destructive-strong` existent et sont déclinés en sombre
(`src/styles/brand.css:87-102` et `:136-151`) : il n'y a rien à créer.

*Confiance : Confirmé.*

---

#### M10 — Une question sans énoncé peut être publiée

`src/components/projects/wizard/StepQuestions.tsx:92` et `:122` créent la
question avec `content: ''`. `StepReview` (`src/components/projects/wizard/StepReview.tsx:24-27`)
ne vérifie que des cardinalités :

```ts
  if (questions.length === 0) missing.push(t('projects:review.missing.questions'))
  if (criteria.length === 0) missing.push(t('projects:review.missing.criteria'))
```

et `projects.$projectSlug.edit.tsx:64` publie dès que
`questions.length > 0 && criteria.length > 0`.

**Conséquence** : un poste publié peut envoyer un candidat sur une question
vide — et l'évaluation notera une réponse à rien. De même, un critère créé
depuis `StepCriteria` porte par défaut le texte du placeholder
(`StepCriteria.tsx:50` : `label: t('projects:criteria.fields.labelPlaceholder')`),
donc un critère factice peut partir en production tel quel.

**Correctif** : compter dans `missing` les questions dont `content.trim()` est
vide et les critères restés au libellé par défaut, avec le numéro de la
question concernée — la règle que `StepReview` s'impose à elle-même dans son
propre docstring (« a "missing" item is a specific instruction »).

*Confiance : Confirmé.*

---

#### M11 — Les deux layouts affichent une ligne de texte au lieu d'un squelette

`src/routes/app/route.tsx:37-43` et `src/routes/app/$orgSlug/route.tsx:77-83`
rendent, pendant toute la résolution de la session et de l'organisation :

```tsx
    <main className="flex min-h-svh items-center justify-center">
      <p className="text-muted-foreground text-sm">{t('loading')}</p>
    </main>
```

Le prompt §4.3 : « Tout état de chargement est un squelette de la forme finale,
pas un rond qui tourne au centre de l'écran. » Les écrans internes respectent
la règle (`projects.index.tsx:94-98`, `candidates.$sessionId.tsx:115-122`,
`projects.$projectSlug.index.tsx:59-71`) — c'est le chemin d'entrée, celui que
tout le monde voit à chaque chargement à froid, qui ne la respecte pas.

Même remarque sur `src/routes/app/admin.tsx:126` et `:162` (« Chargement… »
dans les cartes).

*Confiance : Confirmé.*

---

#### M12 — Aucun moyen de relancer un rapport en échec

`src/routes/app/$orgSlug/candidates.$sessionId.tsx:216-241` affiche, quand la
session est `completed` sans rapport, une alerte et jusqu'à six lignes de
`jobLog`. Il n'y a aucun bouton.

`lastFailure` est calculé (`:143`) et sert uniquement à changer le titre.

**Conséquence** : l'interface dit au recruteur que le traitement a échoué et
lui montre à quelle étape, puis le laisse sans recours. La file reprend seule
(c'est le bon choix architectural, cf. prompt §3.6 « n'écris aucune fonction de
rattrapage »), mais rien ne le dit à l'écran : le texte devrait indiquer que la
reprise est automatique et quand, ou offrir une remise en file explicite.

*Confiance : Confirmé.*

---

#### M13 — Le bouton de téléchargement de la lettre de motivation est étiqueté « Documents »

`src/routes/app/$orgSlug/candidates.$sessionId.tsx:587-592` :

```tsx
                  <Button variant="outline" size="sm" asChild>
                    <a href={media.coverLetter} rel="noreferrer">
                      <FileText className="size-4" />
                      {t('report:sections.documents')}
                    </a>
```

`report:sections.documents` est le titre de la carte, réutilisé comme libellé
du second bouton. Les deux boutons affichent donc « CV » puis « Documents ».
Par ailleurs les deux `<a>` n'ont ni `target="_blank"` ni `download` : le clic
quitte l'application vers l'URL S3 signée, dans le même onglet.

*Confiance : Confirmé.*

---

### Faible

#### F1 — Composants et données de démonstration du template encore présents

- `src/lib/mocks/activity.ts` (37 lignes) : générateur de données factices,
  commentaire « demo data only — not connected to Convex », importé par
  `src/components/dashboard/ActivityChart.tsx:20`.
- `ActivityChart.tsx` (104 l.), `RoleBreakdownChart.tsx` (85 l.),
  `RecentItemsCard.tsx` (109 l.) : **aucune** référence dans le reste du code
  (vérifié). Ils sont correctement élagués du bundle client (aucune trace de
  `recharts` dans `.output/public/assets`), mais ils restent dans le dépôt et
  dans les recherches.
- `src/components/ai/toolRenderers.tsx` (38 lignes) : `getToolRenderer` renvoie
  toujours `null`, avec 28 lignes d'exemple en commentaire portant sur
  `listItems`. Toute la machinerie `Renderer` / `rich` de
  `AiPanel.tsx:142-148` et `:216` est par conséquent morte.
- `src/styles/app.css:21` : `.using-mouse * { outline: none !important; }` —
  aucune occurrence de `using-mouse` en TS/TSX, la classe n'est jamais posée.
- `src/routes/__root.tsx:56` : `color: '#fffff'` — cinq chiffres hexadécimaux,
  couleur invalide.
- `TEST-PLAN.md` : « Test plan — Hardened auth (Phases 0 + 1) », document du
  template, doublon partiel de `TESTING.md`.

#### F2 — Dates formatées sans locale

`src/routes/app/admin.tsx:146` et
`src/components/projects/wizard/StepReview.tsx:81` appellent
`toLocaleDateString()` sans argument : la date suit la locale du navigateur,
pas celle de l'application. Partout ailleurs le code passe bien `locale` /
`i18n.language`.

#### F3 — `as never` sur les identifiants de route

`src/routes/app/$orgSlug/candidates.$sessionId.tsx` : 6 occurrences
(`:64`, `:88`, `:135`, `:507`, `:621`, `:642`) ; `src/routes/app/admin.tsx:77`.
Le paramètre de route est une `string` forcée en `Id<'sessions'>`. Le prompt
§6 interdit `any` au motif que « c'est que le modèle de données est incomplet » ;
`as never` est le même aveu. Un `params: { parse }` sur la route, ou un helper
`asSessionId()`, rendrait aussi le cas « id malformé » traitable (cf. M1).

#### F4 — La barrière ESLint du parcours candidat a deux trous

`eslint.config.mjs:37-45` interdit `~/components/{app-shell,ai,ai-elements,dashboard,items,data-table,auth,report}/*`
mais **pas** `~/components/projects/*` ni `~/components/candidates/*`. Un
import de `~/components/candidates/StatusBadge` depuis `/s/**` passerait le
lint (la barrière de bibliothèques rattraperait `@tanstack/react-table`, mais
pas le reste).

#### F5 — Détails d'alignement et d'affordance

- `src/components/dashboard/KpiCard.tsx:61` : la valeur du KPI n'est pas en
  `tabular-nums` alors que les quatre cartes forment une rangée de chiffres
  alignés (prompt §4.2).
- `src/components/candidates/CandidatesTable.tsx:152-154` : le libellé
  `sr-only` du menu d'actions est `common:actions.edit` (« Modifier ») — un
  lecteur d'écran annonce « Modifier » pour un menu qui contient « Ouvrir »,
  « Relancer » et « Annuler ».
- `src/components/ai/AiPanel.tsx:591` : `MessageActions` est
  `opacity-0 group-hover:opacity-100` — le bouton « Copier » n'apparaît jamais
  au focus clavier (MUST du skill `web-design-guidelines`).
- `src/components/report/AnswerPlayer.tsx:66-73` : la balise `<video>` n'a ni
  `<track>` ni lien vers la transcription, alors que celle-ci est disponible
  (`candidates.$sessionId.tsx:457-466`).

#### F6 — Surface d'API et de types non consommée

- `sharedWith` renvoyé par `projects.getBySlug` (`convex/projects.ts:168`) :
  jamais lu (cf. C2).
- `ProjectRow.restricted` (`src/components/projects/columns.tsx:27`) : présent
  dans le type, jamais rendu — le badge « restreint » n'existe que sur la fiche
  du poste, pas dans la liste où il servirait à repérer les postes sensibles.
- `candidates.json > list.columns.score` : clé traduite, jamais utilisée
  (cf. E4).
- `dashboard.json` : les blocs `kpi.*` (dont `mrr`, `totalItems`), `activity.*`,
  `roles.*`, `recent.*` sont du template et ne sont plus lus ; seul `interw.*`
  l'est.

#### F7 — `DEFAULT_LOCALE = 'en'` et tous les namespaces embarqués partout

`src/lib/locale.ts:10` fait de l'anglais la langue par défaut, alors que la
spécification §12 décrit une interface « 100 % française ». Par ailleurs
`src/lib/i18n.ts:66-103` importe statiquement les 16 namespaces dans un seul
objet `resources` — le commentaire `:58-60` affirme que `interview` « is the
only namespace that ships in the candidate bundle », ce qui n'est pas le cas :
`items`, `chat`, `nav`, `settings` partent avec.

#### F8 — En-têtes de sécurité et `vercel.json`

`vercel.json` ne contient aucun bloc `headers`. Les en-têtes (CSP, HSTS,
`X-Frame-Options`, `Permissions-Policy`) sont posés uniquement par le
middleware SSR `src/start.ts:4-36`, donc sur les réponses de rendu. Les
réponses servies directement depuis `/assets/**` n'en portent aucun. La CSP
elle-même autorise `script-src 'unsafe-inline'` et `connect-src https:` (toute
origine) — acceptable comme point de départ, à resserrer sur l'URL du
déploiement Convex, comme le commentaire du fichier l'indique.

#### F9 — Import IA : N mutations séquentielles sans transaction

`src/components/projects/wizard/ImportFromUrlDialog.tsx:72-80` (et suite)
crée les questions puis les critères un par un dans une boucle `await`. Un
échec au cinquième laisse un poste à moitié importé, sans message indiquant
ce qui a été écrit.

---

## Revue écran par écran

| Écran | Ce qui marche | Ce qui manque vs prompt §4.2 / §4.3 | Verdict |
|---|---|---|---|
| `/` landing | `head()` avec titre + description i18n, redirection si connecté | Le texte est celui du template (« B2B MVP starter template ») ; pas de proposition de valeur, pas de CTA démo | **À refaire** |
| `/app` (garde) | Redirection propre sur `isSignedOut` uniquement, provisioning automatique | « Chargement… » centré au lieu d'un squelette de l'app (M11) | Passable |
| `/app/$orgSlug` (layout) | Garde d'appartenance, `setLastOrg` protégé contre le ping-pong inter-onglets, `⌘J` | 463 KB gzip dont 131 pour Markdown ; panneau IA ouvert par défaut, plein écran sur mobile (E8) ; « Items » dans la nav (E2) | **Problème** |
| Tableau de bord `/app/$orgSlug` | **Vraies données** (aucun mock), « En attente de votre décision » en premier, décisions et récents avec `ScoreBadge`, squelettes | Pas de `description` dans `head()` ; N+1 plafonné à 400 (M4) ; KPI non `tabular-nums` | Bon |
| Liste des postes `/projects` | Tableau (pas de cartes), tri + recherche + pagination, onglets de statut, action primaire visible, deux états vides distincts (global / filtré) | Pas de colonne « restreint » ; « Partager » offert aux membres qui n'y ont pas droit (M3) | Bon |
| Création `/projects/new` | Formulaire court, schéma Zod construit dans `useMemo(…, [t])`, mène droit à l'assistant | — | Bon |
| Assistant `/projects/$slug/edit` | Étapes navigables dans n'importe quel ordre, `aria-current="step"`, sauvegarde automatique au `blur` (donc rien n'est perdu au rafraîchissement), réordonnancement des questions au clavier | Aucun retour « enregistré » ; intro audio/vidéo en impasse (E6) ; pas de pondération par question (E6) ; pas de relecture du média enregistré (E7) ; publication possible avec des questions vides (M10) | **Problème** |
| Fiche poste `/projects/$slug` | Verdict de statut clair, bandeaux brouillon/archivé, 4 chiffres, critères avec poids normalisé et barre | Onglet « Candidats » derrière un clic alors que c'est l'écran de travail ; archivage sans confirmation ; pas de suppression (E6) | Passable |
| Tableau des candidats | Colonnes alignées, pastilles statut + décision, pagination serveur, annulation confirmée et nommée, état vide conçu | **Ni score ni recommandation ni tri ni filtre** (E4) ; pas d'invitation en masse avec gabarit (M2) ; pas de « copier le lien » (E6) | **À refaire** |
| Fiche candidat `/candidates/$sessionId` | Verdict au-dessus de la ligne de flottaison, disclaimer IA permanent et non masquable, critère → niveau → preuve citée → saut à la seconde exacte (le `nonce` de `SeekCue` est bien vu), transcription repliée, états « en cours »/« pas commencé »/« média purgé », suppression confirmée et nommée | URL signées jamais rafraîchies et re-signées à chaque écriture (E3) ; suppression sans contrôle de rôle (E9) ; pas de relance de rapport (M12) ; libellé « Documents » (M13) ; 665 lignes | **Problème** |
| Recherche globale | Index de recherche filtré par `orgId` côté serveur (pas de post-filtrage), résultats avec le poste | Pas de sémantique combobox, pas de flèches, invisible sous `md` donc `⌘K` inopérant (M8) | Passable |
| Copilote (AiPanel) | Historique des fils, renommage, suppression, approbation des écritures, arrêt du flux, outils recruteur en lecture seule, clause anti-discrimination dans le prompt | Outils + prompt + suggestions `items` du template (C3) ; `toolRenderers` mort ; couleurs en dur (M9) ; 701 lignes | **Problème** |
| Réglages `/settings/*` | Onglets, garde admin sur les invitations, redirection d'index propre | Aucun réglage métier : durée de rétention, destinataires du rapport, expéditeur des e-mails | Passable |
| Super admin `/app/admin` | Bascule super admin protégée (`last_super_admin`), chiffres globaux | **Aucun compteur de file** alors que le prompt l'exige (E5) ; page du template inchangée | **À refaire** |
| Nouveautés / changelog | Pastille non-lu en `localStorage`, page complète, dates localisées | Les deux entrées Interw s'affichent en clés brutes (E1) ; 9 entrées du template conservées | **À refaire** |
| Rapport partagé `/r/$shareToken` | `noindex, nofollow` + `referrer: no-referrer`, états expiré / révoqué / introuvable distincts, projecteur explicite (ni e-mail, ni téléphone, ni CV, ni note recruteur), disclaimer IA, preuve cliquable, sobre | Expiration contournable (C1) ; URL média non rafraîchies ; pas de `meta description` ; `'interw'` en dur dans l'en-tête | **Problème** (C1) |

---

## Ce qui est solide

1. **L'i18n.** Parité **exacte** sur les 16 namespaces (vérifiée par
   comparaison des ensembles de clés aplaties : zéro clé orpheline dans un
   sens ou dans l'autre). Aucune chaîne visible en dur dans le code Interw —
   la seule recherche fructueuse remonte `aria-label="interw"` et deux
   libellés du composant `ai-elements` vendu par le template. Les schémas Zod
   sont construits dans `useMemo(…, [t])`, les titres de page passent par
   `getI18n(getLocale()).getFixedT`. C'est exactement ce que le prompt §7
   demandait de ne pas rater, et c'est réussi.

2. **Le modèle d'accès.** Toutes les fonctions publiques commencent par une
   garde. `convex/lib/projectAccess.ts` est bien pensé : deux couches
   (organisation dure, visibilité souple), « invisible → `not_found` et non
   `forbidden` » pour ne pas révéler qu'un poste confidentiel existe,
   `filterVisibleProjects` qui fait une requête pour une liste au lieu d'une
   par ligne. `pnpm audit:access:check` passe.

3. **La frontière du rapport partagé.** Le docstring de `convex/shares.ts:1-15`
   énumère ce qui sort et ce qui ne sort pas, et le code tient la promesse :
   `view` construit un objet littéral, jamais une ligne de base. La révocation
   conserve la ligne pour pouvoir dire « révoqué » — bon réflexe.

4. **Les tokens sémantiques.** `--success / --warning / --info / --destructive`
   avec quatre rôles chacun (`solid`, `-foreground`, `-subtle`, `-strong`),
   déclinés en sombre, avec un commentaire qui explique pourquoi ils sont
   distincts de `--primary`. `StatusBadge`, `ProjectStatusBadge` et les
   niveaux de la matrice de fit s'en servent correctement. Les seuils de score
   (70 / 45) correspondent à la spécification.

5. **Le lien preuve → vidéo.** `SeekCue` avec `nonce`, attente de
   `loadedmetadata` avant le `seek` : deux pièges réels traités, et documentés
   dans le code. C'est le cœur du produit et il est correct (modulo E3).

6. **Le découpage du bundle.** Une route, un chunk. `recharts`, `zxcvbn` et le
   Markdown sont hors du chemin critique des écrans qui ne s'en servent pas.
   La règle ESLint qui interdit au parcours candidat d'importer le back-office
   transforme la régression de 2,96 Mo en échec de CI — c'est la bonne façon
   de graver une leçon.

7. **`fireAndForget`.** Donner un nom et une trace à l'exception de la règle
   « aucune erreur avalée » est plus honnête qu'un `.catch(() => undefined)`,
   et le docstring explique quand ne pas s'en servir. Zéro `catch {}` vide,
   zéro `{false && …}`, zéro `TODO` dans tout `src/` et `convex/`.

8. **`parseCandidateList`.** Tolérant sur l'entrée, strict sur le retour
   d'information, testé (`src/lib/candidate-list.test.ts`). Un nom manquant
   n'est pas un motif de rejet — c'est la bonne décision métier.

---

## Ce que j'aurais fait autrement

**1. La fiche candidat en deux composants, pas un.**
`candidates.$sessionId.tsx` fait 665 lignes et porte huit `useState`, deux
`useEffect`, la récupération des médias, l'état de la note, la décision, le
partage et la suppression. Ce n'est pas « trop long » dans l'absolu — c'est un
écran dense et la moitié est du balisage —, mais la *coordination* média +
verdict est ce qui a produit E3. Je séparerais `useSessionMedia(sessionId)`
(cycle de vie des URL signées, rafraîchissement, erreurs) du rendu. Le
compromis : un hook de plus à lire, contre un bug de fraîcheur qui disparaît
par construction. Même raisonnement pour `AiPanel` (701 lignes) : `MessageParts`
est déjà extrait, le reste est un gestionnaire de fils qui mériterait son hook.

**2. La table `sessions` porte le résultat du rapport.**
Trois symptômes ont la même cause : E4 (pas de score dans la liste), M4 (N+1 du
tableau de bord), et le fait que `recruiterTools.listCandidates` refait le même
travail. Écrire `overallScore` et `recommendation` sur la ligne `sessions` au
moment où le rapport est validé — une écriture par entretien, jamais réécrite —
supprime les trois. Le compromis est une dénormalisation à tenir cohérente ;
mais elle est écrite une fois, par la file, dans une étape déjà idempotente. Et
`sessions` n'est pas `users` : ce n'est pas une ligne chaude.

**3. Le panneau IA à la demande.**
Ouvert par défaut, importé statiquement, il coûte 131 KB gzip sur chaque page
et 400 px sur un outil dont le prompt dit qu'il doit être dense. Je le
mettrais en `lazy`, fermé par défaut, ouvert par `⌘J` ou par le bouton de
l'en-tête. Le compromis assumé : une découvrabilité moindre pour le copilote —
que je compenserais par une pastille sur le bouton à la première visite, pas
par 400 px volés en permanence.

**4. Un écran « Candidats » d'organisation.**
Aujourd'hui les candidats n'existent que sous un poste, plus une recherche par
nom. Le travail réel d'un recruteur est transversal : « qui attend ma décision,
tous postes confondus ». Le tableau de bord donne le *nombre* mais pas la
liste. `/app/$orgSlug/candidates` avec les mêmes colonnes que E4, filtrable par
poste et par statut, serait l'écran le plus utilisé du produit. Le compromis :
une requête paginée transversale à l'organisation, à indexer correctement
(`by_org_status` existe déjà dans le schéma).

**5. L'expiration comme état serveur, jamais comme argument.**
C1 vient d'une intuition juste (« une query réactive ne se réexécute pas avec
le temps ») appliquée au mauvais endroit. Je garderais la règle suivante :
*le client peut demander à quelle heure il croit être, le serveur ne le croit
jamais pour décider d'un droit*. Concrètement, l'horloge côté client sert à
rafraîchir l'affichage ; `Date.now()` côté serveur sert à autoriser. Cela
mérite une ligne dans `CLAUDE.md`, parce que le même motif se reproduira sur
`purgeAfter` et sur l'expiration des postes.

**6. L'assistant de création : un état de sauvegarde visible.**
La sauvegarde au `blur` est le bon choix (rien n'est perdu au rafraîchissement,
contrairement à ce qu'on pourrait craindre en voyant `useState(step)`). Mais
rien ne le dit à l'écran : le recruteur ne sait pas si son titre est
enregistré. Un discret « Enregistré » horodaté en haut de l'assistant coûte dix
lignes et supprime toute une classe d'anxiété. Le compromis serait un `aria-live`
trop bavard — d'où un `aria-live="polite"` sur un texte qui ne change qu'après
une écriture réussie.

**7. Supprimer plutôt que conserver.**
Les composants `items`, `ActivityChart`, `RoleBreakdownChart`,
`RecentItemsCard`, `mocks/activity.ts`, `toolRenderers` et les neuf entrées de
changelog du template ne coûtent presque rien en octets livrés (l'élagage
fonctionne) mais ils coûtent en lecture : ils apparaissent dans chaque
recherche, chaque revue, chaque tentative de comprendre ce que fait le produit.
Le prompt §7 range « masquer par `{false && …}` » parmi les interdits ; du code
mort conservé « au cas où » est la même dette sous une autre forme.

---

## Inventaire des reliquats du template à supprimer

Trié par visibilité client décroissante.

### Visible par un client payant — à traiter avant toute mise en production

| # | Élément | Emplacement | Action |
|---|---|---|---|
| 1 | Entrée « Items / Éléments » dans la barre latérale | `src/components/app-shell/nav.ts:41-45` | supprimer l'entrée |
| 2 | Route `/app/$orgSlug/items` | `src/routes/app/$orgSlug/items.tsx` (62 l.) | supprimer + régénérer `routeTree.gen.ts` |
| 3 | Suggestions du copilote « Liste mes éléments » / « Crée un élément nommé "Roadmap" » | `src/components/ai/AiPanel.tsx:230-232`, `src/locales/{en,fr}/chat.json:12-15` | remplacer par des amorces métier |
| 4 | Prompt système annonçant les outils `items` | `convex/lib/instructions.ts:15-17` | supprimer le paragraphe |
| 5 | Outils d'écriture `items` du copilote | `convex/agent.ts:21`, `convex/agentTools.ts` (232 l.) | retirer `itemTools`, supprimer le fichier |
| 6 | Titre d'onglet par défaut « interw — MVP starter » | `src/locales/{en,fr}/common.json:3` | remplacer |
| 7 | Landing « B2B MVP starter template… » + `metaTitle` / `metaDescription` | `src/locales/{en,fr}/landing.json` (5 clés), `src/routes/index.tsx` | réécrire la page d'accueil |
| 8 | 9 entrées de changelog du template (« A richer AI panel », « Smoother loading », « Clearer error screens »…) | `src/lib/changelog.ts:5-15`, `src/locales/{en,fr}/changelog.json > entries` | supprimer ; ne garder que les entrées Interw (et corriger E1) |
| 9 | Segment de fil d'Ariane `items` | `src/components/app-shell/AppHeader.tsx:26`, `nav.json > appShell.breadcrumb.items` | supprimer |

### Code mort — invisible à l'usage, coûteux en lecture

| # | Élément | Emplacement | Taille |
|---|---|---|---|
| 10 | `ActivityChart` (aucun import) | `src/components/dashboard/ActivityChart.tsx` | 104 l. |
| 11 | `RoleBreakdownChart` (aucun import) | `src/components/dashboard/RoleBreakdownChart.tsx` | 85 l. |
| 12 | `RecentItemsCard` (aucun import) | `src/components/dashboard/RecentItemsCard.tsx` | 109 l. |
| 13 | Générateur de données factices | `src/lib/mocks/activity.ts` (+ dossier `src/lib/mocks/`) | 37 l. |
| 14 | `ItemsDataTable`, `ItemFormDialog`, `items/columns` | `src/components/items/**` | 679 l. |
| 15 | Backend `items` | `convex/items.ts` + table `items` du schéma | — |
| 16 | Namespace i18n `items` | `src/locales/{en,fr}/items.json` (49 clés ×2), `src/lib/i18n.ts:15,32,50,73,92` | 98 clés |
| 17 | Clés `dashboard.json` du template (`kpi.*` dont `mrr`/`totalItems`, `activity.*`, `roles.*`, `recent.*`) | `src/locales/{en,fr}/dashboard.json` | ~25 clés ×2 |
| 18 | `getToolRenderer` toujours `null` + machinerie `rich` associée | `src/components/ai/toolRenderers.tsx`, `AiPanel.tsx:142-148,216` | 38 l. |
| 19 | Branche `delta` de `KpiCard` (jamais passée) avec couleurs en dur | `src/components/dashboard/KpiCard.tsx:48-49,63-81` | — |
| 20 | `.using-mouse * { outline: none !important }` (classe jamais posée) | `src/styles/app.css:21-23` | — |
| 21 | `color: '#fffff'` (hex invalide) sur le lien `manifest` | `src/routes/__root.tsx:56` | — |
| 22 | `TEST-PLAN.md` (plan du template, doublon de `TESTING.md`) | racine | 8,4 Ko |
| 23 | `src/lib/server/` vide | — | — |

### API serveur sans interface — à brancher ou à retirer (cf. E6)

`media.requestIntroUpload`, `media.attachIntroMedia`, `media.clearIntroMedia`,
`media.playbackUrls`, `questions.setCriteriaWeights`, `projects.remove`,
`sessions.invitationLink`, `sessions.linkStatus`, `sessions.countsForOrg`,
et le champ `projects.personaAvatarKey`.

Ce ne sont pas des reliquats du template mais du code Interw écrit, testé et
inatteignable. Chacun correspond à une ligne du périmètre v1 : je les
brancherais plutôt que de les supprimer, mais laisser le sélecteur d'intro
proposer « audio » et « vidéo » sans enregistreur est le pire des trois choix.
