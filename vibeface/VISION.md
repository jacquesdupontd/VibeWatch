# VibeFace Vision Document

## Concept
Une watchface qui ne se répète jamais. Chaque regard sur ta montre = une expérience unique, comme le Jeu de la Vie.

---

## Éléments randomisés

### Déjà implémenté
- [x] Vitesse de typing (80-150ms par caractère)
- [x] Couleurs du glitch (7 couleurs)
- [x] Fonts du glitch (6 fonts)
- [x] Position du curseur pendant glitch (offset ±50px)
- [x] Visibilité du curseur (66% visible pendant glitch)

### À implémenter

#### Niveau 1 — Quick wins
- [ ] `srand(time(NULL))` au démarrage pour vrai random
- [ ] Curseur qui va PARTOUT sur l'écran (pas juste offset depuis sa position)
- [ ] Durée des pauses randomisée (1.5s à 3s)
- [ ] Intensité du glitch variable (parfois 50 cycles, parfois 150)

#### Niveau 2 — Plus de variété
- [ ] Messages alternatifs pour le tagline :
  - "ready to vibe"
  - "let's code"
  - "hack mode"
  - "building..."
  - "creating..."
  - "shipping"
- [ ] Ordre des phases parfois différent (1 chance sur 5 : date avant heure)
- [ ] Parfois skip une phase (juste heure → vibecode)

#### Niveau 3 — Morphing & Animation avancée
- [ ] Curseur qui change de forme pendant le glitch :
  - Carré (défaut)
  - Rectangle horizontal (wide)
  - Rectangle vertical (tall)
  - Cercle
  - Ligne qui tourne
- [ ] Animation 60fps pendant le glitch peak (delay 16ms)
- [ ] Effet "scanline" pendant le full-screen flash
- [ ] Texte qui tremble légèrement pendant le glitch (offset ±2px)

#### Niveau 4 — Easter eggs
- [ ] 1 chance sur 100 : message secret ("hello world", "42", "🤖")
- [ ] À minuit pile : animation spéciale
- [ ] Après 10 glitches consécutifs sans regarder : glitch "endormi" plus calme

---

## Specs techniques

### Animations
- **Typing** : 80-150ms par caractère (variable)
- **Pause normale** : 2-3s
- **Glitch phase 1** : 50-80ms, curseur grandit lentement, bouge ±30px
- **Glitch phase 2** : 30-60ms, curseur grandit vite, va partout
- **Glitch phase 3** : 16-40ms (60fps), full screen, couleurs explosent
- **Total glitch** : 50-150 cycles (randomisé)

### Formes du curseur
```c
// Carré
graphics_fill_rect(ctx, GRect(x, y, size, size), 0, GCornerNone);

// Rectangle horizontal
graphics_fill_rect(ctx, GRect(x, y, size * 2, size / 2), 0, GCornerNone);

// Rectangle vertical
graphics_fill_rect(ctx, GRect(x, y, size / 2, size * 2), 0, GCornerNone);

// Cercle
graphics_fill_circle(ctx, GPoint(x + size/2, y + size/2), size / 2);
```

### Couleurs disponibles (Pebble Time)
- GColorWhite
- GColorCyan
- GColorMagenta
- GColorYellow
- GColorMalachite (vert vif)
- GColorVividCerulean (bleu vif)
- GColorOrange
- GColorRed
- GColorShockingPink
- GColorSpringBud (vert-jaune)

---

## Structure des phases

```
NORMAL FLOW:
1. Heure (typing) → pause 2s
2. Date (typing) → pause 2s
3. "ready to" (typing) → pause 1s
4. "vibecode" (typing) → GLITCH → loop

RANDOM VARIATIONS:
- 20% chance: Date avant Heure
- 10% chance: Skip la date
- 5% chance: Tagline alternatif
- 1% chance: Easter egg
```

---

## Notes pour la vidéo virale

### Hook "2016 meets 2026"
- Pebble Time = peak 2016
- Claude qui code = 2026
- Le contraste parfait pour la trend

### Moments clés à capturer
1. L'heure qui s'écrit doucement
2. "ready to" → "vibecode" transition
3. Le GLITCH qui explose
4. Retour au calme avec la nouvelle heure

### Musique suggérée
- Synth rétro 2016 vibes
- Drop au moment du glitch
- Ou silence → chaos → silence

---

## TODO immédiat
1. Ajouter `srand(time(NULL))`
2. Curseur position full random pendant glitch
3. Morphing basique (carré → cercle)
4. Tester sur vraie Pebble
