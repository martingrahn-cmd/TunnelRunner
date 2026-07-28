# Tunnel Runner — Fair & Fun Plan

Mål: spelet ska kännas **svårt men rättvist** (döden beror på spelaren) och **roligt** (flow, juice, risk/reward).

Tumregel:
> **Roligt** = spelet lär dig, belönar risk, och känns snyggt när du lyckas.
> **Rättvist** = givet samma input går det alltid att överleva om man reagerar i tid.
> **Båda** = difficulty ökar läs- och execution-krav, inte slump och fuskiga frames.

---

## P0 — Rättvisa (först)

Gör att varje hinder är *överlevbart* givet spelarens roll-hastighet och aktuell fart.

### P0.1 Fair-spawn constraint
När hinder `N+1` spawnas, jämför gap-vinkel mot föregående hinder:

```
requiredTurn  = angularDistance(prevGapAngle, thisGapAngle)
availableTurn = rollSpeed × (spacing / forwardSpeed) × skillMargin
fair          = requiredTurn ≤ availableTurn
```

- Om orättvist → rotera gap närmare föregående **eller** öka spacing.
- `skillMargin` ≈ 0.75 (rum för misstag / icke-perfekt input).

### P0.2 Min reaction time
- Hinder måste vara synliga ≥ ~0.60 s innan collision-fönstret.
- `minSpacing` styrs av `forwardSpeed × minReactTime`, inte bara en hård `minGap`-konstant.

### P0.3 Boost-skydd nära hinder
Coin-boost (`×1.3`) får inte göra en tidigare fair line omöjlig:

- Alternativ A: ingen coin-boost inom X meter / Y sekunder före hinder.
- Alternativ B (vald): vid spawn, räkna med **max möjlig fart** (levelSpeed × boost), så layouten är fair även under boost.
- Boost-zones under level-transition förblir OK (inga hinder).

### P0.4 Hitbox ≤ visual + near-miss
- `HIT_HALF_WIDTH` får inte vara större än skeppets upplevda bredd.
- Near-miss-zon (mellan hit och “safe”) ger tydlig feedback + befintlig streak-bonus.
- Behåll `spawnSafe` / invuln efter hit (1.5 s) och under level-transition.

### P0.5 Små balansjusteringar i samma svep
- Mildare level-speed: `0.05` per level (istället för `0.08`).
- Fair-check använder faktisk `rollSpeed` och curve-längd.

**Klar när:** man kan i teorin no-hit:a varje level om man reagerar i tid; inga “omöjliga gap-flips”.

---

## P1 — Roligt (efter P0) ✅

5. ✅ Tydligare gap-läsbarhet (emissive + vit/färgad gap-torus, pulse).
6. ✅ Starkare near-miss (+75×mult, CLOSE! float) + perfect-level (score+crystals+missions).
7. ✅ Difficulty-vågor: `safe → build → peak → breather → peak → outro` (pattern buckets + spacing).
8. ✅ Hinder pop-in (smoothstep scale 0.15→1).
9. ✅ Juice: hit-stop, cam shake, near-miss edge flash, float text.

**Klar när:** en misslyckad runda känns som “en till”, inte “orättvist”.

---

## P2 — Djup & meta ✅

10. ✅ Seedad run / practice-mode (Mulberry32 + shareable seed, PRACTICE toggle).
11. ✅ Ghost / best-run line (sparad best path, visas i practice med samma seed).
12. ✅ Ljud (WebAudio SFX) + screen-shake-polish (dämpad multi-phase shake).
13. ✅ Accessibility: optional mild aim-assist (default OFF, meny-toggle).
14. Meta förblir kosmetik / mild QoL — aldrig pay-to-win hitbox.

---

## Balansparametrar (startvärden)

| Parameter        | Värde        | Kommentar                                      |
|------------------|--------------|------------------------------------------------|
| `rollSpeed`      | 4.0 rad/s    | bas-kontroll                                   |
| `skillMargin`    | 0.75         | marginal i fair-spawn                          |
| `minReactTime`   | 0.60 s       | tid gapet syns innan hit                       |
| `HIT_HALF_WIDTH` | ≤ visual     | hellre generös än snål                         |
| `NEAR_MISS`      | > hit zone   | streak “CLOSE” feedback                        |
| `invuln/spawnSafe` | 1.5 s      | efter hit / restart                            |
| `lives`          | 3            | classic                                        |
| level speed step | 0.05         | `1 + (L-1)*0.05`                               |
| coin boost       | ×1.3 / 0.5s  | layout fair även under boost                   |

### Spawn-buckets (variation utan orättvisa)
- 60% standard (1 gap, rimlig offset)
- 25% twist (större vridning men mer spacing)
- 10% pressure (tätt men liknande gap-vinkel)
- 5% show-off (coin line genom tight gap)

---

## Implementation notes (kod)

Primär fil: `main.js`

- Fair-logik i `spawnObstacles()` / gap-rotation.
- Speed i game loop: `levelSpeed`, `coinBoostTimer`.
- Collision i loop nära `HIT_HALF_WIDTH` + `dodgedObstacle(wasClose)`.
- Constants samlade nära obstacle-sektionen för enkel tuning.

### Fair-spawn pseudokod

```
prevGapAngle = 0
for each obstacle def:
  pick pattern + base rotation
  spacing = tDist from previous
  avail = rollSpeed * timeFor(spacing, maxSpeed) * skillMargin
  delta = angleDiff(rotation, prevGapAngle)
  if delta > avail:
    rotation = prevGapAngle + sign(delta) * avail
  // optional: if still tight on reaction time, push t forward
  prevGapAngle = rotation + primaryGapCenter
```

---

## Ordning

1. ✅ Skriv denna plan (`PLAN.md`)
2. ✅ Implementera **P0**
3. ✅ Implementera **P1**
4. ✅ Implementera **P2**
5. ✅ Implementera **P3** (level-end open + end-of-level bugfix)
6. 🔄 Spela / tuna

---

## Definition of done (P0)

- [x] Inget hinder kräver snabbare rotation än `rollSpeed * skillMargin` tillåter
- [x] Minsta spacing ≥ reaction-time vid max relevant fart
- [x] Coin-boost kan inte skapa omöjliga lines (spawn räknar med ×1.3)
- [x] Hitbox generösare än visual edge (`FAIR_HIT_PAD`); near-miss band
- [x] Level-speed mildare (`FAIR_LEVEL_SPEED_STEP = 0.05`)
- [x] Constants samlade i `main.js` (P0 fair-play block)

### Implementerat i `main.js` (P0)

| Constant | Värde | Roll |
|----------|-------|------|
| `FAIR_SKILL_MARGIN` | 0.75 | marginal i fair-spawn |
| `FAIR_MIN_REACT_TIME` | 0.60 s | min tid mellan hinder vid maxfart |
| `FAIR_MAX_LEVEL_FOR_SPAWN` | 12 | layout fair t.o.m. denna level |
| `FAIR_LEVEL_SPEED_STEP` | 0.05 | runtime + spawn |
| `FAIR_COIN_BOOST_MUL` | 1.3 | spawn antar boost alltid på |
| `FAIR_HIT_PAD` | 0.06 rad | extra safe-cone |
| `FAIR_NEAR_MISS_OUTER/INNER` | 0.14 / 0.10 | near-miss-band |
| `FAIR_SPIN_CHANCE` | 0.10 | färre spinners |
| `FAIR_SPIN_MAX` | 0.55 rad/s | cap |
| `FAIR_ROLL_SPEED` | 4.0 | synkad med `rollSpeed` |

**Logik:** `generateObstacles()` clampar gap-rotation mot `availableTurn` och håller `minSpacingT` från reaction-time. Collision sparar bästa gap-dot; dodge använder near-miss-band.

### Implementerat i `main.js` (P1)

| Feature | Detalj |
|---------|--------|
| Gap read | **Grön safe-lane** band i gap (väggar aldrig gröna); pulse |
| Material | Högre emissive (0.35), metalness 0.15 |
| Pop-in | `obs.popIn` smoothstep scale 0.15→1 |
| Waves | `safe/build/peak/breather/outro` pattern + spacing |
| Near-miss | +75×mult, `CLOSE!` float, edge flash, cam shake |
| Perfect | +500+100×L score, +15 crystals, missions `perfect_*` |
| Hit juice | hit-stop 70ms (progress slow, roll full), cam shake |
| HUD | `#hud-float`, `#hud-nm-flash` |

### Implementerat i `main.js` (P2)

| Del | Detalj |
|-----|--------|
| Seed | Mulberry32 + 4-tecken share-kod; `applyRunSeed` / menyfält |
| Practice | Toggle; samma seed varje restart; `rng` reset i `generateObstacles` |
| Ghost | 256 samples roll vs progress; sparas best (ej practice); cyan line i practice+samma seed |
| SFX | WebAudio: nearMiss, hit, coin, levelUp, start |
| Shake | Multi-phase damped noise + lätt Z-rotate |
| Aim assist | Mild pull till närmaste gap när ingen input (default OFF) |
| Meny | SEED / RAND / PRACTICE / AIM ASSIST / SFX |

---

## P3 — Level finish / open end ✅

**Bug (level ~3 slut):** samma hinderlayout varje level + portal dolde bara 0.08 band → wrap-around-hinder / ghost-hits nära exit.

**Fix:**
1. Layout seed = `runSeed ⊕ level` → ny bana per level, practice fortfarande deterministisk.
2. `generateObstacles()` vid varje level-start (efter boost).
3. Exit-portal rensar hinder på/efter portal; collision ignorerar `pastExit`.
4. Tunnel **öppnar sig** mot exit: vertex-flare + fragment-mouth (`uPortalU` / `uOpen`).
5. Portal placeras tidigare (~5 s) och längre fram så munnen syns.
