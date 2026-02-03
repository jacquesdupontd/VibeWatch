# VibeCoder Viral Video Script

## Concept Principal
**"2016 meets 2026"** — Une Pebble Time (peak 2016) qui affiche Claude Code en temps réel.

---

## Structure de la vidéo (30-45 secondes)

### INTRO (0-5s)
- Écran noir
- Texte blanc qui s'écrit : **"2016"**
- Cut sur une Pebble Time éteinte ou avec watchface classique
- Ambiance nostalgique

### TRANSITION (5-8s)
- Texte qui s'écrit : **"meets 2026"**
- La Pebble s'allume avec VibeFace
- L'heure commence à s'écrire

### LE BUILD (8-20s)
- Montrer VibeCoder (l'app qui stream Claude)
- Claude code quelque chose en temps réel
- On voit les `[E]` Edit, `[$]` Bash, `[OK]` défiler
- Alterner entre l'écran Mac et la montre au poignet

### LE CLIMAX (20-30s)
- "ready to" s'écrit sur la montre
- "vibecode" s'écrit
- **LE GLITCH EXPLOSE**
- Le curseur grossit, se balade partout
- Morphing de formes
- Full screen color flash
- CUT au moment du peak

### OUTRO (30-35s)
- Retour au calme
- L'heure s'affiche normalement
- Texte overlay : **"VibeCoder"** + lien/handle

---

## Musique suggérée
- Synthwave/retrowave 2016 vibes
- Build-up pendant le coding
- DROP au moment du glitch
- Ou : silence complet → chaos sonore → silence

---

## Hashtags
```
#2016meets2026 #vibecoding #pebble #claudeai #coding #tech #nostalgia #smartwatch #ai #developer
```

---

## Platforms
1. **TikTok** — Format vertical, 30s max, hook dans les 3 premières secondes
2. **Twitter/X** — Même vidéo, tag @AnthropicAI @alexalbert__ **@ericmigi**
3. **LinkedIn** — Version plus "pro", focus sur le côté dev tool
4. **Reddit** — r/ClaudeAI, r/pebble, r/ProgrammerHumor

---

## 🔥 CONTEXTE PEBBLE 2025-2026

### Le Reboot Pebble
- **Janvier 2025**: Google open-source PebbleOS
- **Eric Migicovsky** (créateur original) revient avec **Core Devices**
- Site officiel: [repebble.com](https://repebble.com)

### Les nouvelles montres
| Modèle | Prix | Écran | Batterie | Dispo |
|--------|------|-------|----------|-------|
| Core 2 Duo | $149 | N&B e-paper | 30 jours | Mai 2026 |
| **Core Time 2** | $225 | **64 couleurs + TACTILE** | - | Mars 2026 |

### Pourquoi c'est le moment parfait
1. VibeCoder/VibeFace = une des **premières apps virales** du reboot
2. Tag **@ericmigi** = visibilité garantie dans la communauté
3. Core Time 2 a un écran couleur plus grand = VibeFace sera encore plus ouf
4. Communauté Pebble affamée de contenu après 8 ans d'attente

### Personnes à taguer
- **@ericmigi** — Créateur de Pebble, CEO Core Devices
- **@anthropic** / **@alexalbert__** — Claude AI
- **r/pebble** — Communauté Reddit (très active depuis l'annonce)

---

# VibeFace — Le Système de Chaos Progressif

## Concept : 60 niveaux de dégradation

Chaque minute = un niveau de chaos différent.
- Minute 0-9 : Calme, watchface classique
- Minute 10-19 : Légers glitches
- Minute 20-29 : Glitches modérés
- Minute 30-39 : Chaos grandissant
- Minute 40-49 : Full chaos
- Minute 50-59 : Apocalypse visuelle
- Retour à 0 : Reset, calme à nouveau

**L'heure reste toujours lisible** (même si glitchée), mais TOUT le reste dégénère.

---

## Les 60 états (basés sur la minute)

### Minutes 0-9 : "CLEAN"
- Typing normal
- Pas de glitch sur l'heure/date
- Glitch "vibecode" standard (celui qu'on a maintenant)
- Curseur carré uniquement

### Minutes 10-19 : "UNSTABLE"
- Typing speed variable (plus erratique)
- Légère vibration du texte (±1px)
- Glitch "vibecode" plus long
- Curseur commence à morphe

### Minutes 20-29 : "CORRUPTED"
- L'heure glitch légèrement (couleur flash rapide)
- La date peut avoir des caractères random
- Messages alternatifs apparaissent
- Curseur va plus loin

### Minutes 30-39 : "DEGRADED"
- L'heure tremble
- Background parfois flash même hors glitch
- Typing peut "rater" des lettres puis les corriger
- Formes de curseur plus extrêmes

### Minutes 40-49 : "CHAOS"
- L'heure change de font aléatoirement
- Couleurs de fond instables
- Glitch peut commencer avant "vibecode"
- Multi-curseurs possibles ?

### Minutes 50-59 : "MELTDOWN"
- Tout tremble en permanence
- Couleurs saturées
- L'heure reste lisible mais tout autour est chaos
- Le glitch "vibecode" est apocalyptique
- Scanlines, artefacts

### Minute 0 : "REBOOT"
- Effet de "redémarrage"
- Tout se calme
- Clean slate
- Le cycle recommence

---

## Implémentation technique

```c
// Dans tick_handler ou au début de chaque cycle
int chaos_level = current_minute / 10;  // 0-5
int chaos_intensity = current_minute % 10;  // 0-9 dans chaque niveau

// Paramètres basés sur le chaos
int text_shake = chaos_level;  // 0-5 pixels de tremblement
int glitch_duration = 80 + (chaos_level * 20);  // 80-180 cycles
int color_instability = chaos_level * 2;  // Fréquence des flash
bool multi_cursor = (chaos_level >= 4);
bool permanent_shake = (chaos_level >= 5);
float typing_error_chance = chaos_level * 0.05;  // 0-25% chance de "typo"
```

---

## Easter Eggs cachés

### Basés sur l'heure exacte
- **00:00** — "happy new loop" au lieu de "vibecode"
- **04:20** — Couleurs vertes uniquement
- **11:11** — Make a wish (pause plus longue)
- **13:37** — "1337 mode" — tout en style hacker
- **23:59** — Countdown visuel vers le reset

### Basés sur le hasard (1% chance)
- "hello world" au lieu de "vibecode"
- Curseur qui dessine un cœur
- Inversion des couleurs pendant tout un cycle
- "built by claude" qui apparaît

---

## Pourquoi c'est viral

1. **Rewatchability** — Tu ne verras jamais exactement la même chose
2. **FOMO** — "T'as vu le mode à 4:20 ?" → Les gens veulent découvrir
3. **Partage naturel** — "Regarde ce que ma montre fait à 55 minutes"
4. **Discussion** — "C'est quoi le niveau max de chaos ?"
5. **Nostalgie + Innovation** — Le combo parfait

---

## Call to action
"Quelle minute est la plus chaotique ? Dis-moi en commentaire 👇"

Ça incite à regarder la vidéo plusieurs fois pour voir les différents états.

---

## 🎬 SETUP TECHNIQUE POUR LE ONE-SHOT

### Prérequis
1. Mac avec Claude Code + hooks configurés
2. `hooks-bridge.js` qui tourne (`node bridge/hooks-bridge.js`)
3. Pebble avec WatchApp installée (PAS encore mergée!)
4. Session tmux prête avec le contexte du projet

### Commandes du bridge
```bash
# Lister les sessions tmux
curl http://localhost:8081/tmux/list

# Créer une nouvelle session Claude
curl -X POST "http://localhost:8081/tmux/create?name=vibe"

# Envoyer du texte à une session
curl -X POST "http://localhost:8081/tmux/send?name=vibe" -d "ton texte ici"
```

### Flow automatique - DEPUIS LA MONTRE
```
Watch affiche: "VibeCoder - No active session"
    ↓ Bouton UP sur la montre
"Create new session" envoyé au bridge
    ↓ Bridge exécute: tmux new -s vibe claude
Claude démarre + hooks fire
    ↓ WebSocket
Watch passe en mode ACTIVE
    ↓ Voice mode: "Claude, fais le merge..."
Claude code le merge EN DIRECT
    ↓ pebble install
Nouvelle app installée
    ↓ Claude exit
App mergée démarre, pas de session
    ↓ Mode VibeFace s'active
"ready to vibecode" → MEGA GLITCH
```

### Ce qu'on voit dans la vidéo (CORRIGÉ)
1. **Pebble** affiche WatchApp: "VibeCoder" / "No active session"
2. **Bouton UP** sur la montre → "Create session"
3. **Watch** montre: "Session created, Claude starting..."
4. **Watch** affiche l'activité Claude: "[R] Reading..." "[E] Editing..."
5. **Voice** (optionnel): "Claude, fusionne VibeFace avec cette app..."
6. **Écran Mac** en split: on voit Claude coder le merge
7. **Watch** montre: "[OK] pebble install succeeded"
8. **Watch reload** → nouvelle app (mergée) démarre
9. **Pas de session active** → mode VibeFace s'active
10. "ready to" → "vibecode" → **GLITCH APOCALYPTIQUE**
11. Retour au calme: nouvelle heure s'affiche
12. 😎 **FIN**

### Pourquoi c'est mieux
- **PAS BESOIN DE TÉLÉPHONE** - tout depuis la montre
- **Plus magique** - un bouton et l'IA code
- **Authentique** - on voit vraiment le code se construire
- **Le payoff** - la transition vers VibeFace est la preuve que ça marche
