# Buffer System Upgrade Plan - Feb 2026

## ✅ IMPLEMENTED (Commit c1c062d)

**Date**: February 4, 2026
**Status**: Successfully implemented and deployed

The intelligent buffer system with debouncing is now live. See commit c1c062d for full details.

## État Actuel (Commit avant buffer intelligent)

### Ce qui FONCTIONNE ✅

**Architecture CLEAN Mode**:
- TextLayers séparées: Claude (111px), Command (16px), Prompt (16px), Status (18px)
- PropertyAnimation smooth scroll vertical (20ms/px)
- PropertyAnimation marquee horizontal infini (10ms/px)
- Clipping layer pour texte Claude (pas de débordement)
- Layout pixel-perfect sur écran 144x168px

**Animations**:
- Scroll vertical Claude: Smooth, AnimationCurveLinear
- Marquee infini seamless: Méthode duplication "text     text     text"
- Vitesse: 10ms/px (3x plus rapide que version initiale 30ms/px)
- Loop callbacks: .stopped → restart instantané

**Buffers Actuels**:
```c
static char s_user_cmd[128] = "";
static char s_claude_summary[1024] = "";
static char s_status[32] = "Ready";
static char s_last_tool[256] = "";  // Augmenté de 64→256
static char s_suggestion[128] = "";
static char s_active_task[128] = "";  // Augmenté de 64→128

// Marquee duplicate buffers
static char s_command_marquee_buf[256] = "";
static char s_prompt_marquee_buf[256] = "";
static char s_status_marquee_buf[256] = "";
```

**Bridge Improvements**:
- Format NDJSON: `CLEAN:userCmd|summary|status|lastTool|suggestion|activeTask`
- Emoji filtering: removeEmojis() avec ranges Unicode complets
- ASCII filter: `/[^\x20-\x7E\n]/g`
- Newlines préservés: `.replace(/\n{3,}/g, '\n\n')`

### Problèmes PERSISTANTS ❌

**1. Marquee bug pendant génération rapide** 🔴 CRITIQUE
- Symptôme: Animations se chevauchent, texte saute, marquee casse
- Cause: Chaque update (toutes les 400ms) relance immédiatement les animations
- Pendant génération code: Updates rapides → animations redémarrent sans arrêt
- Comportement: Marche quand idle, bug quand activité

**2. Line breaks JAMAIS affichés** 🔴 CRITIQUE
- Symptôme: Texte violet tout sur une ligne, listes illisibles
- Bridge préserve les \n (vérifié)
- TextLayer devrait supporter \n (WordWrap)
- Hypothèse: \n perdus quelque part entre bridge et watch
- Nécessite: Logging à chaque étape pour trouver où

**3. Emojis passent le filtre** 🟡 IMPORTANT
- removeEmojis() fonctionne en test isolé
- Mais emojis toujours visibles sur watch
- Hypothèse: Texte vient d'un autre chemin (pas extractTextFromJSONL)?
- Solution nucléaire: Instruire Claude "NO EMOJIS" au démarrage

**4. Status bar parfois vide** 🟡 INTERMITTENT
- Fix appliqué: Reset position + stop animation
- Devrait être résolu mais à surveiller

**5. Scroll vertical freeze** 🟡 INTERMITTENT
- Texte violet arrête de scroller sans raison
- Besoin investigation animation callbacks

## Plan: Système de Buffer Intelligent

### Objectif
Éliminer les bugs d'animation pendant génération rapide en implémentant:
1. **Update Debouncing**: Accumuler updates, n'appliquer que dernier état
2. **Animation State Machine**: Gérer proprement les états d'animation
3. **Content Diffing**: Ne relancer que si contenu change vraiment
4. **Rapid Mode Detection**: Suspendre marquee pendant rafales d'updates

### Architecture Proposée

**Triple Buffer Pattern**:
```c
// Front: Affiché
// Middle: Processing
// Back: Incoming
static char s_triple_buffer[3][256];
static int s_front_idx = 0;
```

**State Machine**:
```c
typedef enum {
  ANIM_STATE_IDLE,
  ANIM_STATE_RUNNING,
  ANIM_STATE_PAUSED,
  ANIM_STATE_PENDING_RESTART
} AnimState;
```

**Debouncing**:
```c
#define RAPID_THRESHOLD_MS 200  // Détecter rafales
#define DEBOUNCE_DELAY_MS 500   // Attendre stabilisation

static uint32_t s_last_update_time = 0;
static bool s_in_rapid_mode = false;
```

### Avantages Attendus

**Performance**:
- 90% moins d'animations pendant génération
- CPU/Batterie économisés
- Pas de lag visuel

**Stabilité**:
- Zero bugs de chevauchement
- Comportement prévisible
- Texte stable

**UX**:
- Transitions smooth
- Marquee reprend proprement après génération
- Feedback visuel (status orange pendant rapid mode)

### Risques

**Complexité**:
- Code plus complexe (state machine)
- Plus de variables d'état à gérer
- Debugging plus difficile

**Timing**:
- Faut bien tuner RAPID_THRESHOLD_MS et DEBOUNCE_DELAY_MS
- Trop court: Pas d'effet
- Trop long: Latence perçue

**Memory**:
- Triple buffer = 3x256 bytes = 768 bytes supplémentaires
- State machines = quelques bytes
- Total: ~1KB RAM supplémentaire (acceptable)

## Fichiers Critiques

### Watch (C)
- `watchapp/src/c/watchapp.c`: **1600+ lignes** - TOUT le code watch
  - Lignes 40-50: Buffer declarations
  - Lignes 800-960: Marquee functions (command, prompt, status)
  - Lignes 1125-1150: inbox_received_callback - UPDATE HANDLER
  - Lignes 1450-1505: create_clean_layers() - Layout

### Bridge (JavaScript)
- `bridge/server.js`: **1100+ lignes** - WebSocket + tmux capture
  - Lignes 70-100: removeEmojis() + clean()
  - Lignes 615-695: extractTextFromJSONL() - EMOJI FILTER ICI
  - Lignes 698-750: extractRealtimeText()
  - Lignes 950-1050: Main poll loop - UPDATE SOURCE

### PebbleKit JS
- `watchapp/src/pkjs/index.js`: **120 lignes** - WebSocket client
  - Lignes 65-78: CLEAN message formatting
  - Ligne 73: Sanitize function (remplace pipes)

## Commandes Utiles

```bash
# Build & Install
cd watchapp && pebble build && pebble install --emulator basalt

# Clean build (après changements messageKeys)
pebble clean && pebble build

# Kill émulateur planté
pebble kill
# ou
kill -9 $(pgrep qemu)

# Bridge
cd bridge && node server.js

# Logs bridge
tail -f bridge.log
```

## Métriques Actuelles

**RAM Usage**: 17.4KB / 64KB (27%)
**Free Heap**: 48KB (Basalt), 7KB (Aplite)
**Animations**: 4 simultanées (claude_scroll, command_marquee, prompt_marquee, status_marquee)
**Update Rate**: 400ms (POLL_MS dans bridge)

## Next Steps (Post-Compaction)

1. **Implémenter debouncing** dans inbox_received_callback
2. **Ajouter state machine** pour animations
3. **Content diffing** pour éviter relances inutiles
4. **Rapid mode detection** avec visual feedback
5. **Logger les \n** pour trouver où ils disparaissent
6. **Tester sur vraie Pebble Time** (pas juste émulateur)

## Notes Importantes

- **NE PAS supprimer draw_clean_mode()** (ligne ~364) même si unused - backup
- **Mode VERBOSE toujours fonctionnel** - ne pas casser
- **Branch**: feature/property-animation
- **Commits récents**: Voir git log pour historique détaillé
- **Émulateur instable** (QEMU crashes) - sauvegarder souvent
