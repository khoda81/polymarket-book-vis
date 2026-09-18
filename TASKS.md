# Task list

## Current / completed baseline

- [x] Fast Canvas2D live pressure view.
- [x] Exact spread semantics and direct live-book hover queries.
- [x] Recorder durability and async ownership cleanup.
- [x] Adaptive visible market clocks:
  - recorder age redraws only when its rendered text can change;
  - sub-frame deadlines coalesce to the next animation frame;
  - hidden markets do not schedule clock work;
  - known market resolution times render as per-market countdowns.

## Next

1. [ ] **Event search / add UX**
   - Replace the slug-only input with a searchable event picker, matching the useful dropdown behavior of the per-card event search.
   - Show enough result metadata to disambiguate events without clutter (title plus compact secondary metadata such as slug, volume, and timing when available).
   - Add the selected result on click.
   - Add the best/current selection on Enter.
   - Remove the separate **Add event** button.
   - Preserve direct slug entry as a fast path when the typed value is an exact slug.

2. [ ] **Resin historical visualization**
   - Keep the current live book sharp and authoritative.
   - Deposit only displaced/outgoing pressure into historical residue; never repeatedly deposit unchanged snapshots.
   - Diffuse historical residue separately from live pressure.
   - Prefer showing historical residue only where current information is absent.
   - Preserve enough raw recorder history to allow future historical rendering experiments and reconstruction.
