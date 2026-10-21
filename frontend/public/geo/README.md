# Boundary data

## nigeria-states.json

Nigeria's 36 states and the Federal Capital Territory, used by the dashboard's Map tile
(`ENigeriaMap` in `src/components/echarts.tsx`).

- **Source:** geoBoundaries, open release, Nigeria ADM1 (`gbOpen/NGA/ADM1`),
  simplified edition — <https://www.geoboundaries.org>
- **Licence:** CC BY 4.0. Attribution: *Runfola, D. et al. (2020) geoBoundaries: A global
  database of political administrative boundaries. PLoS ONE 15(4): e0231866.*
- **Fetched:** 2026-10-21

### What was changed, and why

1. **`shapeName` → `name`**, and every other property dropped. The renderer reads one
   property; carrying `shapeISO`, `shapeID`, `shapeGroup` and `shapeType` was a third of
   the file for nothing.
2. **`Abuja Federal Capital Territory` → `FCT`.** This is the point of the whole file:
   `app.canon_state` (migration 376) folds every spelling the data carries onto 37
   canonical names, and `FCT` is the one it uses. A map whose names do not match the
   report's names is a map with silent holes in it, so the rename makes the two lists
   identical rather than nearly identical.
3. **Coordinates rounded to 3 decimals** (about 110 m) and **simplified with
   Douglas-Peucker at a tolerance of 0.005°** (about 550 m). 828 KB → 107 KB, 19,288
   points → 7,148. At the size a tile draws, 550 m is roughly a quarter of a pixel.

Each state was simplified independently, so a shared border can move by up to the
tolerance on each side. At this tolerance the drift is sub-pixel; pushing it further
opens visible slivers between neighbours, which is why it stops here. Fixing that
properly needs topology-aware simplification (mapshaper), which would mean a build-time
dependency for a difference nobody can see.

### Replacing it

Keep the two invariants: one property called `name`, and names drawn from exactly the 37
values in `app.lead_state_hub`. Migration 386 asserts that table still holds 37 rows and
that the capital territory is called `FCT`, so a change on either side fails loudly
instead of showing a state that will not colour.
