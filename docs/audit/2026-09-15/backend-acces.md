# Audit backend Convex — Interw

Périmètre : modèle de données, contrôle d'accès, isolation multi-tenant,
surfaces à jeton (candidat / partage), passage à l'échelle, conformité aux
`convex/_generated/ai/guidelines.md`, et le script `scripts/audit-convex-access.mjs`.
Toutes les fonctions publiques listées par le script (101) ont été lues une par
une, ainsi que les 16 fichiers de test du domaine.

---

## Résumé

Le socle d'autorisation est **structurellement sain** : pas un seul cas de
*confused deputy* sur l'organisation — chaque fonction qui reçoit un id
d'entité (`sessionId`, `questionId`, `criterionId`, `shareId`, `itemId`) remonte
à la ligne propriétaire **avant** d'appeler la garde, et vérifie l'appartenance
de l'org de cette ligne, jamais d'un `orgId` fourni par l'appelant. Le
projecteur `toCandidateSessionView` est exhaustif et testé. Les clés d'objet
sont dérivées côté serveur et re-dérivées à l'attache. C'est nettement au-dessus
de la moyenne.

Trois choses comptent vraiment, et elles sont toutes du même genre : **une
garantie affichée que le code n'honore pas.**

1. **L'expiration d'un lien de partage est contournable par le client.**
   `shares.view` et `shares.sharedMediaUrls` prennent `now` en argument et le
   comparent à `expiresAt`. Passer `now: 0` ressuscite un lien expiré et fait
   signer des URL de lecture d'une heure sur la vidéo du candidat. Le même
   motif désarme la fermeture des liens candidat (`interview.questions`,
   `promptMediaUrls`). La porte du lot 7 — « un lien partagé cesse après
   révocation/expiration » — n'est tenue que pour la révocation.
2. **La purge de rétention ne purge rien, et la moitié des sessions n'ont
   jamais d'horloge de rétention.** `q.lt('purgeAfter', before)` embarque tous
   les documents où `purgeAfter` est `undefined` (ils trient en premier dans un
   index Convex) ; le `take(25)` est saturé par eux et le `.filter()` JS les
   jette tous. Par ailleurs `purgeAfter` n'est écrit que par `interview.finish` :
   un entretien abandonné en cours garde ses vidéos indéfiniment.
3. **L'effacement n'efface pas tout** : `emailLog` conserve l'adresse du
   candidat en clair après `deleteMyData`, alors même que `purgeLog` prend soin
   de ne stocker qu'un hash.

S'y ajoutent deux dettes d'échelle qui casseront à volume réel (`sessions.invite`
qui `.collect()` toutes les sessions d'un poste, le tableau de bord en N+1 sur
400 sessions) et un script d'audit qui, par construction, ne peut pas détecter
la classe de faille qu'il est censé prévenir.

---

## Constats

### CRITIQUE

---

#### C1 — L'expiration d'un lien de partage est décidée par une horloge fournie par l'appelant

`convex/shares.ts:38-57`, `convex/shares.ts:144-147`, `convex/shares.ts:231-235`,
`convex/shares.ts:256-262`

```ts
// shares.ts:38
async function resolveShare(ctx, token, now) {
  ...
  if (share.expiresAt !== undefined && share.expiresAt < now) {
    return { state: 'expired', share: null }
  }
```

```ts
// shares.ts:144
export const view = query({
  args: { token: v.string(), now: v.number() },   // ← now vient du client
```

Côté navigateur, la valeur est bien `Date.now()` du poste client
(`src/routes/r/$shareToken.tsx:41` et `:57`), donc entièrement sous le contrôle
de qui détient le lien.

**Scénario.** Un manager reçoit un lien de partage à 7 jours. Passé le délai, il
appelle directement le déploiement Convex :
`shares:view {token, now: 0}` → `state: 'active'`, rapport complet.
Puis `shares:sharedMediaUrls {token, now: 0}` → l'action délègue à
`resolveSharedMedia` avec le **même `now` client** (`shares.ts:262`) et signe des
URL S3 d'une heure sur toutes les vidéos d'entretien. L'expiration n'est plus une
frontière : c'est une suggestion. `revokedAt` reste, lui, correctement vérifié —
c'est la seule raison pour laquelle ce n'est pas total.

Même motif, même cause, sur la surface candidat (`convex/interview.ts:77-106`,
`:134-176`) : `requireOpenSession(ctx, token, now)` avec `now` client. Un poste
archivé ou expiré continue de servir le contenu des questions et de signer les
médias enregistrés par le recruteur, pour quiconque détient un ancien lien
candidat. En revanche les écritures (`start`, `reserveSegment`,
`markSegmentUploaded`) prennent `Date.now()` côté serveur — la fuite est en
lecture, pas en écriture.

Le commentaire de `candidate.ts:85-88` justifie le `now` client par la
réactivité, et la ligne 331 de `guidelines.md` le recommande effectivement pour
une *query*. Le défaut n'est pas le paramètre : c'est de l'avoir laissé décider
d'une autorisation, et de l'avoir propagé dans des **actions**, qui elles ont
accès à l'horloge serveur.

**Correction.**
- Dans les actions (`shares.sharedMediaUrls`, `interview.promptMediaUrls`) :
  ignorer `args.now` et passer `Date.now()` à l'internalQuery. Une ligne chacune.
- Dans les queries : garder `now` pour l'affichage, mais borner la décision,
  p. ex. `const effective = Math.min(now, share._creationTime + MAX_SKEW + ttl)` —
  ou, façon guidelines l. 331, matérialiser l'état : un cron qui pose
  `revokedAt`/`expiredAt` sur les partages échus, et la query ne lit plus qu'un
  drapeau.
- Ajouter le test manquant : `view({token, now: 0})` sur un partage expiré doit
  répondre `expired`.

Confiance : **Confirmé** (chemin lu de bout en bout, appelant client inclus).

---

### ÉLEVÉ

---

#### E1 — La purge de rétention ne purge jamais rien

`convex/purge.ts:184-192`, `convex/retention.ts:360-386`, `convex/crons.ts:12-17`

```ts
// purge.ts:184
const due = await ctx.db
  .query('sessions')
  .withIndex('by_purge_after', (q) => q.lt('purgeAfter', before))
  .take(limit)
return due
  .filter((session) => session.purgeAfter !== undefined)
  .map((session) => session._id)
```

Dans un index Convex, un champ absent trie **avant toutes les valeurs** :
`makeComparable(undefined)` renvoie le tag de type `0`, le plus bas
(`node_modules/convex/dist/.../compare.js:104`). La plage `lt(before)` commence
donc au début de l'index et balaie d'abord **toutes** les sessions sans
`purgeAfter` — c'est-à-dire toutes les sessions `pending`, `in_progress` et
`cancelled`. Le `take(25)` est intégralement consommé par elles, puis le
`.filter()` les élimine : la fonction renvoie `[]`.

**Scénario.** Dès qu'un déploiement compte 25 sessions non terminées — soit
quasi immédiatement —, le cron des 6 heures tourne, ne trouve rien, et
n'écrit aucun `purgeLog`. Les enregistrements vidéo restent au-delà des 12 mois
annoncés, indéfiniment, sans qu'aucune alarme ne se déclenche : l'échec est
silencieux par construction, puisque « 0 purgé » est aussi la réponse normale.
C'est le point 6 de la définition du terminé (« une purge de rétention
s'exécute et se journalise ») qui tombe.

**Correction.** Borner la plage par le bas :
`q.gt('purgeAfter', 0).lt('purgeAfter', before)`. Et ajouter un test
`convex-test` qui sème 30 sessions sans `purgeAfter` + 1 échue et vérifie que
`sessionsDueForPurge` la retourne — c'est exactement le test qui manque.

Confiance : **Confirmé** (sémantique d'ordre vérifiée dans le code de `convex`
installé, pas seulement en mémoire).

---

#### E2 — Une session abandonnée ne reçoit jamais d'horloge de rétention ; le statut `expired` n'est jamais écrit

`convex/interview.ts:451-459` (seule écriture de `purgeAfter`),
`convex/schema.ts:54` et `convex/sessions.ts:246-256`

`grep purgeAfter convex/*.ts` donne une seule écriture non nulle : dans
`interview.finish`. Or un segment est téléversé **dès la fin de chaque
question** (`reserveSegment` / `markSegmentUploaded`), bien avant `finish`.

**Scénario.** Un candidat répond à 4 questions sur 7 puis abandonne. Quatre
vidéos sont dans le bucket, la session reste `in_progress` pour toujours
(`sessions.cancel` la passe au mieux à `cancelled`, ce qui ne pose pas non plus
de `purgeAfter`). Aucune horloge, donc aucune purge — même une fois E1 corrigé.
La rétention ne couvre que les entretiens menés à terme, c'est-à-dire la
minorité des cas dans un produit de recrutement.

Symétriquement, `sessionStatusValidator` déclare `'expired'`
(`schema.ts:54`) mais **aucune mutation ne l'écrit** : la machine à états a un
état mort. `evaluateSessionGate` renvoie bien `'expired'`, mais c'est un état
*calculé* du gate, jamais persisté — donc rien ne distingue en base une session
close par l'expiration du poste d'une session simplement en attente.

**Correction.** Poser `purgeAfter` dès `start` (avec une fenêtre plus courte
pour un abandon, p. ex. 90 jours) et le repousser à `finish`. Et soit écrire
réellement `status: 'expired'` depuis un cron, soit retirer le littéral du
validateur — un état qu'aucun code n'écrit est un piège pour le prochain
développeur.

Confiance : **Confirmé**.

---

#### E3 — L'effacement laisse l'adresse du candidat en clair dans `emailLog`

`convex/purge.ts:209-272`, `convex/sessions.ts:201-209`, `convex/schema.ts:415-433`

`deleteSessionRecords` supprime `reports`, `reportShares`, `transcripts`,
`segments`, `sessionEvents`, `jobLog`, puis la `sessions` elle-même. Il ne
touche **pas** `emailLog`, qui porte pourtant `sessionId` et
`recipient: session.candidateEmail` en clair (écrit à `sessions.ts:201-209`
pour chaque invitation envoyée).

```ts
// schema.ts — emailLog
recipient: v.string(),          // l'adresse du candidat
sessionId: v.optional(v.id('sessions')),
```

**Scénario.** Un candidat exerce son droit à l'effacement via
`candidate.deleteMyData`. `purgeLog` enregistre scrupuleusement un *hash* de son
adresse — le commentaire de `schema.ts:409-414` explique très bien pourquoi.
Et à trois tables de là, la même adresse reste lisible en clair, associée à un
`sessionId` qui pointe vers un registre d'effacement. L'intention est exacte,
l'exécution est incomplète, et c'est le genre d'écart qu'un contrôle repère
tout de suite.

**Correction.** Ajouter un index `by_session` sur `emailLog` (il n'existe pas :
seulement `by_org_and_created`, `by_recipient`, `by_provider_id`) et, dans
`deleteSessionRecords`, soit supprimer les lignes, soit remplacer `recipient`
par son hash en conservant le statut de délivrabilité. Le même index règle E7.

Confiance : **Confirmé**.

---

#### E4 — `sessions.invite` lit toutes les sessions d'un poste et écrit sur un compteur chaud

`convex/sessions.ts:115-123`, `convex/sessions.ts:156-160`

```ts
const existing = await ctx.db
  .query('sessions')
  .withIndex('by_project', (q) => q.eq('projectId', projectId))
  .collect()                                    // ← sans borne
```

Deux problèmes dans la même mutation.

**Volume.** `.collect()` sans borne sur la table qui, de l'aveu du schéma
(`schema.ts:257-260`), est celle qui « atteint réellement les milliers ». À 8 000
candidats sur un poste, la mutation dépasse les limites de lecture d'une
transaction Convex et **toute nouvelle invitation sur ce poste devient
impossible** — y compris l'invitation unitaire, qui passe par le même chemin.
La règle des guidelines (l. 333) est explicite : jamais `.collect()` non borné.

**Contention.** `ctx.db.patch('projects', projectId, { sessionCount: ... })`
place une écriture sur la ligne `projects` dans chaque invitation. Deux
recruteurs important chacun un lot de 100 sur le même poste entrent en conflit
OCC sur cette ligne, et chaque retry re-lit l'intégralité des sessions du poste.
C'est précisément le motif « hot row » que `CLAUDE.md` interdit pour `users`,
reproduit ici sur `projects`.

**Correction.** La déduplication par e-mail veut un index
`by_project_and_email` sur `sessions` et une lecture par candidat
(≤ 100 `.unique()`, borné par `MAX_BULK_INVITES`) au lieu d'un scan complet.
Pour le compteur : soit `@convex-dev/aggregate` (recommandé par les guidelines
l. 335), soit accepter la contention mais sortir le scan.

Confiance : **Confirmé**.

---

#### E5 — Modifier les questions d'un poste actif désaligne les réponses déjà enregistrées

`convex/questions.ts:115-134` (`remove`), `convex/questions.ts:137-167`
(`reorder`), `convex/lib/projectAccess.ts:72-85`

`requireProjectEditable` ne refuse que le statut `archived`. Un poste `active`
avec 50 candidats en cours reste donc entièrement éditable, et `remove`
re-numérote explicitement les `orderIndex` restants « pour que le moteur
candidat ne s'arrête pas tôt » (commentaire l. 121-122).

Or les réponses déjà stockées portent **à la fois** `questionId` et
`questionIndex` (`schema.ts:346-350`), et tout le reste du système fait la
jointure **par index** :

```ts
// pipeline.ts:313  (construction du rapport)
const question = questions.find((q) => q.orderIndex === segment.questionIndex)
// reports.ts:108, shares.ts:208 : idem
```

**Scénario.** 30 candidats ont répondu. Le recruteur supprime la question 2.
Les questions 3..7 glissent en 2..6. Les segments enregistrés gardent leurs
index d'origine. Résultat : dans chaque rapport déjà produit **et** dans la fiche
candidat, chaque réponse est affichée sous l'énoncé de la question suivante. Le
rapport n'est pas en erreur — il est faux, et il a l'air vrai. C'est exactement
le risque que la règle « un critère sauté fait échouer le rapport plutôt que de
décaler la moyenne » cherche à éviter, mais sur l'axe des questions.

**Correction.** Interdire `remove`/`reorder` dès que `project.sessionCount > 0`
(le compteur est déjà là), ou faire la jointure par `segment.questionId` partout
— le champ existe et il est stable. La seconde option est meilleure mais plus
large ; la première est une ligne et ferme le trou tout de suite.

Confiance : **Confirmé**.

---

### MOYEN

---

#### M1 — `attachDocument` n'applique aucun gate : un détenteur du lien peut détruire le CV d'un candidat déjà évalué

`convex/candidate.ts:260-302`

`resolveDocumentUpload` vérifie bien le gate (l. 187-190). `swapDocumentKey`,
lui, n'appelle que `requireSession` — pas `evaluateSessionGate` — et l'action
`attachDocument` supprime l'ancien objet :

```ts
// candidate.ts:288
const { previous } = await ctx.runMutation(internal.candidate.swapDocumentKey, args)
if (previous) await deleteObjects([previous])
```

**Scénario.** L'entretien est terminé, le rapport produit, le recruteur consulte
le CV. Quiconque détient encore le lien candidat (le candidat, ou n'importe qui à
qui l'e-mail a été transféré) appelle
`candidate:attachDocument {token, kind:'cv', key:'orgs/O/sessions/S/cv.x'}`.
La clé passe le contrôle de préfixe (elle est bien dans le dossier de la
session), `cvKey` est réécrit vers un objet inexistant, et **le vrai CV est
supprimé du bucket**. Aucun gate, aucune limite de statut. La vérification
`candidateFields[kind].enabled` n'est pas non plus rejouée ici.

**Correction.** Appeler `evaluateSessionGate` dans `swapDocumentKey` comme
partout ailleurs sur cette surface, et y rejouer le contrôle `enabled`.

Confiance : **Confirmé**.

---

#### M2 — `deleteSessionRecords` est une transaction non bornée, et le candidat contrôle sa taille

`convex/purge.ts:237-248`, `convex/interview.ts:405-426`

```ts
for (const table of ['transcripts', 'segments', 'sessionEvents'] as const) {
  const rows = await ctx.db.query(table).withIndex('by_session', ...).collect()
  for (const row of rows) await ctx.db.delete(table, row._id)
}
```

`sessionEvents` n'a **aucun plafond** : `interview.logEvent` est publique,
n'exige que la résolution du jeton, et le limiteur `candidateWrite` autorise 120
écritures/minute. Environ deux heures et demie suffisent à dépasser la limite de
documents d'une transaction Convex.

**Scénario.** Une session gonflée à ~20 000 `sessionEvents` rend
`deleteSessionRecords` impossible à committer : l'effacement échoue à chaque
tentative, pour le candidat comme pour le recruteur, et — pire — les objets S3
ont déjà été supprimés par l'appelant avant l'appel (`candidate.ts:367`,
`sessions.ts:323`), de sorte que la session reste en base, orpheline de ses
médias, avec un effacement qui ne peut plus aboutir. Les guidelines (l. 337)
décrivent exactement le remède : traiter par lots et relancer avec
`ctx.scheduler.runAfter`.

**Correction.** Supprimer par lots de `take(n)` avec continuation planifiée, et
plafonner `sessionEvents` par session (un compteur, ou un `take(200)` avec écrasement
circulaire — c'est une piste de support, pas un journal d'audit).

Confiance : **Confirmé** pour le chemin non borné ; **Probable** sur le seuil
exact de la transaction.

---

#### M3 — Le tableau de bord est en N+1 sur 400 sessions, et ses chiffres sont faux au-delà

`convex/dashboard.ts:335-420`

```ts
const sessions = (await ctx.db.query('sessions').withIndex('by_org', ...)
  .order('desc').take(RECENT_CAP))        // 400
...
for (const session of sessions) {
  if (session.status !== 'completed') continue
  const report = await ctx.db.query('reports')
    .withIndex('by_session', ...).unique()   // ← une requête par session
```

C'est une **query réactive** : elle est ré-exécutée à chaque écriture sur
`sessions` de l'organisation — donc à chaque `markSegmentUploaded` de chaque
candidat en cours. Jusqu'à 400 lectures indexées supplémentaires à chaque fois,
pour tous les onglets ouverts.

Second problème, de justesse celui-là : `invitedInWindow`, `completedInWindow`,
`decisions.*` sont calculés sur une fenêtre de 400 sessions, pas sur 30 jours.
Une organisation qui dépasse 400 sessions voit des chiffres qui **baissent** en
grossissant, sans aucun signal. Même motif dans `sessions.countsForOrg`
(`sessions.ts:269-285`, `.take(500)` renvoyé comme `total`).

**Correction.** Dénormaliser (les compteurs `sessionCount` /
`completedSessionCount` existent déjà sur `projects` — les agréger suffirait pour
la moitié des cartes) ou passer par `@convex-dev/aggregate`. À défaut, nommer les
champs pour ce qu'ils sont (`completedAmongLast400`) : un chiffre faux non
signalé est pire qu'un chiffre approximatif assumé.

Confiance : **Confirmé**.

---

#### M4 — L'unicité des slugs de poste n'est garantie que jusqu'à 200 postes, et une collision rend les deux postes inaccessibles

`convex/projects.ts:184-188`, `convex/projects.ts:109-124`

```ts
const existing = await ctx.db.query('projects')
  .withIndex('by_org', (q) => q.eq('orgId', orgId))
  .take(LIST_CAP)                                   // 200
const slug = uniqueSlug(cleanTitle, new Set(existing.map((p) => p.slug)))
```

Convex n'a pas de contrainte d'unicité : `uniqueSlug` est la seule protection,
et elle ne voit que 200 lignes. Au-delà, un doublon est insérable. Et
`getBySlug` résout par `.unique()` (l. 116), qui **lève une exception** en
présence de deux lignes.

**Scénario.** Une organisation dépasse 200 postes (cumulés, `draft` et
`archived` compris — l'index `by_org` ne filtre pas le statut). Deux postes
« Product Manager » finissent avec le même slug. Dès lors, la page de *chacun des
deux* jette une erreur non rattrapée, définitivement, et il n'existe aucune
fonction pour renommer un slug. La concurrence, elle, est bien gérée : l'OCC
Convex sérialise deux `create` simultanés.

**Correction.** Interroger l'index `by_org_and_slug` sur la valeur candidate
plutôt que de matérialiser 200 slugs, en boucle sur les suffixes. Et remplacer
le `.unique()` de `getBySlug` par `.first()` pour que le mode dégradé soit une
page qui s'affiche plutôt qu'une erreur.

Confiance : **Confirmé**.

---

#### M5 — Archiver un poste — qui ferme tous les liens candidat en cours — ne demande aucun rôle

`convex/projects.ts:301-327` vs `convex/projects.ts:335-357` et `:363-407`

`remove` et `setShares` passent par `requireProjectOwnerOrAdmin`. `archive` et
`restore` se contentent de `requireProjectAccess`, c'est-à-dire n'importe quel
membre qui voit le poste. Or `evaluateSessionGate` (`sessionState.ts:78`)
renvoie `closed` pour tout poste non `active` : archiver, c'est couper
instantanément le lien de tous les candidats en cours d'entretien.

C'est la plus destructrice des actions non privilégiées du module, et elle est
moins protégée qu'une suppression de poste vide. Même remarque, plus faible, pour
`sessions.deleteCandidateData` (`sessions.ts:315-332`) : l'effacement définitif
d'un candidat n'exige que `requireProjectAccess`.

**Correction.** Aligner `archive` sur `requireProjectOwnerOrAdmin`, ou expliciter
dans le module pourquoi la symétrie est volontaire.

Confiance : **Confirmé** sur le code ; **Probable** sur l'intention.

---

#### M6 — Le script d'audit ne peut pas voir la classe de faille qu'il est censé prévenir

`scripts/audit-convex-access.mjs:116-118`, `:104-105`, `:36-48`

```js
function namesAGuard(text) {
  return GUARDS.filter((guard) => text.includes(guard))
}
```

C'est une recherche de **sous-chaîne dans le texte du corps**. Quatre trous, par
ordre de gravité :

1. **Aucun lien entre l'argument et la garde.** `requireOrgMember(ctx, args.orgId)`
   alors que la fonction lit une ligne d'une *autre* org passe l'audit sans
   réserve. C'est exactement le *confused deputy* que la section 3.7 du brief
   demande de vérifier « fonction par fonction ». Le script donne ici une
   assurance qu'il ne peut pas fournir.
2. **Aucune notion de « première instruction ».** Une garde appelée après
   l'écriture, dans une branche morte, ou dont le résultat est ignoré, compte
   autant qu'une garde correcte. `CLAUDE.md` exige « en première instruction » ;
   le script vérifie « quelque part ».
3. **Mention en commentaire = garde.** `// requireOrgMember n'est pas nécessaire
   ici` suffit à faire passer la fonction.
4. **Faux positif observé en production du script.** La sortie actuelle affiche
   `shares.ts sharedMediaUrls → resolveShare (direct)`. Or `sharedMediaUrls` est
   une *action* : elle n'a pas de `ctx.db` et n'appelle jamais `resolveShare` —
   le script a matché la sous-chaîne à l'intérieur de `resolveSharedMedia`. Le
   verdict est juste par accident.

Enfin, `http.ts` est dans `SKIP` (l. 43) et `httpAction` n'est pas dans la regex
de déclaration (l. 90) : **aucune route HTTP publique n'est auditée**, y compris
`/api/chat`, qui n'applique d'ailleurs pas le limiteur `chatSend`
(`chat.ts:271-300`).

Bon point à l'inverse : l'échappatoire `// access:` n'est **pas** abusée — trois
usages seulement (`organizations.checkSlug`, `invitations.preview`,
`invitations.accept`), tous légitimes et correctement motivés.

**Correction.** Dépouiller les commentaires avant `namesAGuard` ; exiger que la
garde apparaisse dans les N premières instructions ; ne matcher que sur des
limites de mot (`\bresolveShare\(`). Le point 1 n'est pas atteignable en
expression régulière : il faut un parcours AST, ou l'accepter explicitement dans
l'en-tête du script plutôt que de promettre « verified function by function ».

Confiance : **Confirmé** (script exécuté, sortie observée).

---

#### M7 — Aucun `returns` validator dans tout le backend

`grep -c "returns:" convex/*.ts` → **0**.

La garantie « une fonction candidat ne renvoie jamais `recruiterNote`,
`recruiterDecision*`, ni le rapport » repose entièrement sur la discipline des
projecteurs de `lib/candidateView.ts` et sur trois tests de sérialisation
(`candidate.test.ts:140`, `shares.test.ts:116`). C'est bien fait — mais rien ne
l'*impose*. Un `returns:` sur `candidate.landing`, `interview.questions` et
`shares.view` transformerait cette garantie en contrat vérifié par Convex à
l'exécution, et ferait échouer au déploiement toute fuite introduite plus tard.
C'est l'ajout le moins cher du rapport au regard de ce qu'il protège.

Confiance : **Confirmé**.

---

#### M8 — Deux écarts aux guidelines dans le pipeline

`convex/pipeline.ts:85-91` — `ctx.runMutation(internal.pipeline.recordJob, …)`
**depuis une mutation** (`onSessionCompleted` est un `internalMutation`). Les
guidelines n'interdisent pas la sous-transaction, mais ici `recordJob` fait un
`ctx.db.insert` trivial : l'appel imbriqué n'apporte qu'un coût et un point de
rollback indépendant. Un `ctx.db.insert('jobLog', …)` direct suffit.

`convex/pipeline.ts:347-373` — `saveReport` déclare `report: v.any()` et
`paraverbal: v.any()`, puis fait `...report` dans l'insert. Le schéma prend
pourtant soin de typer `fitMatrix` en toutes lettres avec ce commentaire
(`schema.ts:392-393`) : « Typé plutôt que `v.any()` : un blob non typé ici est
la façon dont une sortie malformée de modèle atteint l'UI. » Le validateur de
table rattrape la plupart des cas, mais la barre de qualité du brief (« aucun
`any` ») est explicitement franchie à l'endroit précis que le schéma désigne
comme dangereux. `schema.doc('reports')` ou un validateur dérivé
(`.omit('orgId','sessionId','model','generatedAt')`, cf. guidelines l. 46-47)
règle le problème sans dupliquer la forme.

Confiance : **Confirmé**.

---

#### M9 — L'idempotence de la notification repose sur une fenêtre de 200 e-mails

`convex/notifications.ts:77-89`

```ts
const alreadySent = await ctx.db.query('emailLog')
  .withIndex('by_org_and_created', (q) => q.eq('orgId', session.orgId))
  .order('desc').take(200)
if (alreadySent.some((e) => e.sessionId === sessionId && e.template === 'report-ready'))
```

Une campagne d'invitation de 100 candidats écrit 100 lignes `emailLog` d'un
coup. Deux campagnes, et le rejeu d'un job `notify` (que le workpool relance
avec `retry: true`, `pipeline.ts:486`) ne trouve plus la trace de l'envoi
précédent : le recruteur reçoit deux fois le même rapport. L'index
`by_session` manquant de E3 résout aussi celui-ci, en une requête exacte.

Confiance : **Confirmé**.

---

### FAIBLE

---

**F1 — Un ré-enregistrement dans un conteneur différent orpheline l'objet
précédent.** `convex/interview.ts:265-287` : `reserveSegment` écrase `audioKey`
et `videoKey` sur la ligne existante. Si le candidat reprend la question depuis
un autre navigateur (Safari `audio/mp4` → `.m4a` après Chrome `audio/webm` →
`.weba`), l'ancienne clé disparaît de la base. `collectSessionObjects`
(`purge.ts:184-192`) ne la nomme plus : l'objet survit à l'effacement. C'est le
seul trou dans une stratégie d'erasure par ailleurs exacte. Correctif : accumuler
les clés remplacées dans un champ `staleKeys`, ou supprimer l'ancien objet au
moment de la ré-réservation. **Confirmé.**

**F2 — `setDecision` et `setNote` ne vérifient aucun rôle.**
`convex/reports.ts:151-182` : tout membre voyant le poste peut poser une décision
d'embauche. `recruiterDecisionBy` est bien enregistré, donc la traçabilité tient ;
mais au regard de la règle « la personne responsable doit être celle qui a
décidé », un `requireOrgRole(..., 'member')` explicite — ou un commentaire disant
que l'org est une équipe plate — vaudrait mieux que le silence. **Confirmé.**

**F3 — `searchCandidates` ré-implémente la visibilité projet au lieu de
réutiliser `canSeeProject`.** `convex/reports.ts:288-302` recopie la logique
(`restricted && role === 'member' && createdBy !== user`) que
`lib/projectAccess.ts:27-43` détient déjà. Les deux sont aujourd'hui d'accord ;
la prochaine évolution des règles de visibilité les fera diverger, et c'est la
copie — dans la barre de recherche — qui sera oubliée. **Confirmé.**

**F4 — `sessions.countsForOrg` ignore les restrictions de projet.**
`convex/sessions.ts:269-285` : `requireOrgMember` seul, puis un comptage
`by_org`. Un membre non autorisé sur un poste confidentiel en voit les sessions
dans les agrégats. Fuite d'ordre de grandeur seulement, mais c'est le seul
endroit du backend où `projectShares` n'est pas rejoué. **Confirmé.**

**F5 — Nommage d'index non conforme aux guidelines.** La ligne 187 de
`guidelines.md` demande que le nom porte tous les champs. `questions.by_project`
et `criteria.by_project` couvrent `['projectId','orderIndex']`,
`segments.by_session` couvre `['sessionId','questionIndex']`,
`sessionEvents.by_session` couvre `['sessionId','at']`. Cosmétique, mais c'est
précisément ce genre de nom qui fait écrire un jour une requête ordonnée sur ce
qu'on croit être une clé simple. **Confirmé.**

**F6 — Configuration morte.** `rateLimiters.ts:47` définit `candidateRead`, que
personne n'appelle (choix assumé et documenté dans `candidate.ts:17-21`, mais
alors la définition devrait partir). `purge.ts:195` exporte `assertSessionId`,
jamais importé. `candidate.privacySummary` (`candidate.ts:311-313`) déclare
`now: v.number()` et ne s'en sert pas. **Confirmé.**

**F7 — `setShares` accepte une liste d'ids non bornée.**
`convex/projects.ts:363-378` : une requête indexée par `userId` fourni, sans
plafond sur `userIds`. Appelable seulement par un admin de l'org, donc l'impact
est un membre qui se saborde sa propre transaction. Un `if (userIds.length > 100)`
suffit. **Confirmé.**

**F8 — Les écrans super-admin lisent des tables entières.**
`convex/admin.ts:89-149` : quatre `.collect()` sur `users`, `organizations`,
`organizationMembers`, `invitations`, plus un N+1 par organisation et par
utilisateur. Le tableau super-admin cessera de charger bien avant que le produit
ne soit gros. **Confirmé.**

**F9 — `cascadeDelete` laisse des références pendantes et avale une erreur.**
`convex/users.ts:320-355` : supprime l'utilisateur et ses appartenances, mais pas
ses lignes `projectShares` (un poste restreint garde alors une part vers un
utilisateur inexistant) ni ses références dans `sessions.invitedBy` /
`recruiterDecisionBy`. Et `catch {}` l. 348-350, que `CLAUDE.md` interdit
sans réserve — un `console.warn` nommé suffirait. Fichier du template.
**Confirmé.**

---

## Ce qui est solide

À ne pas re-vérifier, c'est fait et c'est juste :

- **Aucun confused deputy sur l'organisation.** Toutes les fonctions prenant un
  id d'entité (`sessionId`, `questionId`, `criterionId`, `shareId`, `memberId`,
  `itemId`) chargent la ligne, puis gardent sur l'org **de la ligne**, jamais sur
  un `orgId` d'argument. Les rares fonctions qui acceptent les deux
  (`recruiterTools.readReportInternal:123`, `agentTools.updateItemInternal:84`,
  `organizations.updateMemberRole:181`) comparent explicitement
  `entity.orgId !== orgId`. Vérifié sur les 101 fonctions publiques.
- **Ids croisés entre projets rejetés.** `questions.setCriteriaWeights:192-194`
  vérifie `criterion.projectId !== question.projectId` avant d'écrire une clé
  dans `criteriaWeights` — le cas nommé dans le brief est traité.
  `questions.reorder:157-160` refuse tout id inconnu, et refuse aussi une liste
  partielle.
- **`projectShares` est rejoué partout où il compte** : `projects.list`,
  `getBySlug`, `dashboard.overview`, `reports.searchCandidates`,
  `recruiterTools.*`, `notifications.sendReportReady`. `filterVisibleProjects`
  fait une seule requête pour toute la liste, et c'est testé
  (`projectAccess.test.ts:151`), y compris le cas « une part sur un projet ne
  fuit pas sur un autre » (l. 135) et « jamais à travers les organisations »
  (l. 177).
- **Le projecteur candidat.** `toCandidateSessionView` n'utilise aucun spread,
  ne renvoie ni `accessToken`, ni `orgId`, ni `recruiterNote`, ni
  `recruiterDecision*`, ni les clés d'objet (booléens `hasCv`/`hasCoverLetter`) —
  et `candidateView.test.ts` le vérifie champ par champ à partir d'un document
  complet, pas d'un fixture appauvri. `shares.test.ts:116` fait le même contrôle
  par sérialisation sur la surface de partage.
- **Résolution de jeton uniforme.** `candidate.requireSession:66-79` et
  `interview.resolveSessionByToken:45-56` lèvent le même `not_found` pour un
  jeton malformé, inconnu, ou pointant vers un projet supprimé. Testé
  (`candidate.test.ts:170` compare l'ensemble des messages d'erreur et vérifie
  qu'il n'en contient qu'un). L'expiration est bien traitée comme un **état
  d'une session résolue**, jamais comme un échec de résolution, et le
  raisonnement est écrit dans `sessionState.ts:8-13`.
- **Entropie des jetons.** 32 octets de `crypto.getRandomValues`, base64url,
  43 caractères, testé sur 1 000 tirages (`tokens.test.ts`). Rien à redire.
- **Clés d'objet.** Dérivées exclusivement dans `lib/objectStore.ts`,
  re-dérivées et comparées par préfixe à l'attache (`media.swapIntroKey:176`,
  `media.swapQuestionKey:194`, `candidate.swapDocumentKey:271`). Aucun appelant
  ne nomme sa propre clé. La signature couvre méthode, clé, `content-type` **et**
  `content-length` (`objectStore.ts:109-140`) — le dernier point est rare et il
  est bien vu. Aucune URL n'est stockée nulle part.
- **`markSegmentUploaded`/`markSegmentFailed`** vérifient
  `segment.sessionId !== session._id` (`interview.ts:362`, `:389`) : un jeton ne
  peut pas marquer la réponse d'un autre candidat. `reserveSegment` est
  idempotent par `(sessionId, questionIndex)` et `finish` retourne tôt si déjà
  `completed`.
- **Le pipeline est réellement idempotent**, et c'est testé
  (`pipeline.test.ts:110,128,151`) : rejouer la chaîne n'écrit ni second
  transcript, ni second rapport. Chaque `catch` journalise puis relance — pas un
  seul `catch {}` dans `pipeline.ts`.
- **L'index de recherche est scopé par `filterFields: ['orgId']`**
  (`schema.ts:339-342`), pas par un post-filtre. C'est la bonne façon.
- **Un seul `.filter()` de base dans tout le backend**
  (`invitations.ts:46`), assumé par un `eslint-disable` motivé sur un scan
  d'une ligne au maximum. Le reste passe par `withIndex`.

---

## Ce que j'aurais fait autrement

**1. Ne jamais faire dépendre une autorisation d'un argument, y compris `now`.**
Le compromis « query réactive vs horloge serveur » est réel, mais il a été
résolu du mauvais côté. J'aurais matérialisé le temps : un cron qui pose
`closedAt` sur les `reportShares` échus et sur les sessions dont le poste a
expiré, et des queries qui ne lisent qu'un drapeau. Les queries redeviennent
purement fonctionnelles, la réactivité est gratuite (le cron écrit, la query
se ré-exécute), et il n'y a plus de paramètre d'autorisation à auditer. Coût :
une latence de fermeture égale à la période du cron — acceptable pour une
expiration à l'échelle du jour.

**2. Des `returns` validators plutôt que des projecteurs seuls.** Les
projecteurs de `candidateView.ts` sont la bonne idée, et ils sont bien écrits.
Mais ils sont contournables par oubli : rien n'empêche une nouvelle fonction
candidat de renvoyer un document brut. Un `returns:` sur chaque fonction
publique candidat/partage déplace la garantie de la revue de code vers le
runtime, et l'auteur de la prochaine fuite l'apprend au déploiement plutôt qu'en
production. C'est le seul endroit où j'aurais accepté de la verbosité.

**3. Les compteurs dénormalisés sur `projects` sont le mauvais outil.**
`sessionCount` incrémenté dans chaque invitation crée une ligne chaude sur le
poste, exactement ce que `CLAUDE.md` interdit sur `users` et pour la même raison.
`@convex-dev/aggregate` est recommandé par les guidelines précisément pour ce
cas, coûte O(log n) et évite la contention. Le raisonnement du schéma
(`schema.ts:257-260`, « Convex n'a pas d'opérateur count ») est juste ; la
conclusion saute une option.

**4. Joindre les réponses aux questions par `questionId`, pas par index.**
Le schéma porte les deux, et quatre endroits différents
(`pipeline.ts:313`, `reports.ts:108`, `shares.ts:208`, `interview.ts:89`)
choisissent l'index. L'index est un ordre d'affichage ; l'id est une identité.
Faire porter l'identité à l'ordre, c'est accepter qu'une réorganisation de la
trame réécrive l'histoire. Le coût de l'alternative est nul.

**5. Un contrôle d'accès déclaratif plutôt qu'un script de grep.** L'ambition de
`audit-convex-access.mjs` est la bonne — « vérifié fonction par fonction, pas
supposé » ne reste vrai que si quelque chose continue de vérifier. Mais une
regex ne peut pas contrôler le lien argument↔garde, qui est *toute* la question.
J'aurais enveloppé les constructeurs : un `orgQuery({ args, orgFrom: 'projectId',
handler })` qui résout la ligne, applique la garde et passe `{ project, user,
member }` au handler. La garantie devient structurelle, le script d'audit se
réduit à « toute fonction publique utilise un constructeur enveloppé » — ce
qu'une regex *peut* vérifier honnêtement — et les 101 vérifications manuelles
n'ont plus à être refaites à chaque revue.

---

## Couverture des tests de ce domaine

**Ce qui est testé, et bien.**
`convex/candidate.test.ts` (7 cas) couvre le cœur du modèle de menace : jeton
valide → bon candidat et lui seul, isolation entre deux organisations, échec
identique pour tout jeton non résolu (vérifié par `new Set(failures).size === 1`,
pas à l'œil), non-fuite du `recruiterNote`, de la décision, du jeton d'accès et
du titre interne. `convex/shares.test.ts` (6 cas) couvre révocation, expiration,
instant exact d'expiration, et non-fuite du CV/e-mail/téléphone/LinkedIn par
inspection de la sérialisation complète. `convex/lib/projectAccess.test.ts`
(9 cas) couvre toute la matrice de visibilité, y compris les deux cas de fuite
croisée. `convex/pipeline.test.ts` (8 cas) prouve l'idempotence du rejeu et
l'exhaustivité de `collectSessionObjects`, upload échoué compris.
`sessionState`, `weights`, `tokens`, `slug`, `objectStore`, `sigv4` ont des tests
unitaires purs sérieux. Ce n'est pas de la couverture de façade.

**Garanties critiques sans aucun test.**

1. **L'horloge d'autorisation.** Aucun test ne passe un `now` hostile. Tous
   passent `NOW` honnêtement (`shares.test.ts:139`, `candidate.test.ts:196`).
   Un seul cas — `view({ token, now: 0 })` sur un partage expiré — aurait
   attrapé C1 le jour où il a été écrit. C'est le test manquant le plus rentable
   du dépôt.
2. **La purge de rétention.** `sessionsDueForPurge` et `retention.purgeDueSessions`
   n'ont aucun test. E1 est une erreur de sémantique d'index qu'un test
   d'intégration de six lignes (30 sessions sans `purgeAfter`, une échue) rend
   impossible à commettre. Le cron est branché, le code compile, et il ne fait
   rien.
3. **Tout le moteur d'entretien côté serveur.** Ni `reserveSegment`, ni
   `markSegmentUploaded`, ni `finish` ne sont testés — donc ni l'unicité
   `(session, questionIndex)`, ni le refus de marquer le segment d'autrui, ni
   l'idempotence du double-tap sur « terminer », ni la non-double-incrémentation
   de `completedSessionCount`. C'est le lot que le brief désigne comme « le plus
   risqué : soigne-le » (§ 5, lot 4), et c'est celui sans couverture serveur.
4. **Toute la surface recruteur.** `sessions.ts`, `projects.ts`, `questions.ts`,
   `criteria.ts`, `reports.ts` n'ont aucun test d'intégration. Rien ne vérifie
   qu'un membre d'une org ne peut pas inviter sur le poste d'une autre, ni que
   `setCriteriaWeights` rejette un critère d'un autre projet (le contrôle
   existe, `questions.ts:193` — il n'est pas verrouillé par un test).
5. **Les compteurs dénormalisés.** Rien ne vérifie que `sessionCount` et
   `completedSessionCount` restent exacts à travers invite / finish / purge.
   `projects.remove` s'appuie pourtant sur `sessionCount > 0` pour refuser de
   détruire un poste ayant des candidats : un compteur faux y devient une perte
   de données.
