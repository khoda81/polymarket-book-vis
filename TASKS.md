# Task list

## Current / completed baseline

- [x] Fast Canvas2D live pressure view.
- [x] Exact spread semantics and direct live-book hover queries.
- [x] Recorder durability and async ownership cleanup.
- [x] Adaptive visible market clocks:
  - recorder age updates only when its rendered text can change;
  - clock deadlines update DOM directly and never redraw the pressure canvas;
  - sub-frame deadlines coalesce to the next animation frame;
  - hidden markets do not schedule clock work;
  - known market resolution times render as per-market countdowns.
- [x] Floating tooltip portal outside the clipped canvas wrapper.
- [x] Event pinning via persisted slugs; pinned events restore on reload.
- [x] Independent startup card loads (no batch-of-four gating).

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
   - Integrate the *entire* live pressure field through time, so stationary liquidity continuously contributes and develops a historical halo too.
   - Treat the historical field approximately as ∂H/∂t = D∇²H + αB(t), with history rendered separately beneath the sharp live book.
   - Preserve raw book deltas/snapshots so history can be reconstructed correctly after scale changes instead of warping an already-blurred image.
   - Keep historical rendering off the live Canvas2D hot path and benchmark its independent update cadence before increasing visual fidelity.
