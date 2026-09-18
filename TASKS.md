# Task list

## Current / completed baseline

- [x] Fast Canvas2D live pressure view.
- [x] Exact spread semantics and direct live-book hover queries.
- [x] Recorder durability and async ownership cleanup.
- [x] Canvas annotation layer for age mode:
  - market labels, recorder age, and resolution countdowns are rendered outside DOM layout;
  - recorder age updates only when its rendered text can change;
  - clock deadlines redraw only the annotation canvas and never redraw the pressure canvas;
  - sub-frame deadlines coalesce to the next animation frame;
  - hidden markets do not schedule clock work;
  - known market resolution times render as per-market countdowns.
- [x] Floating tooltip portal outside the clipped canvas wrapper.
- [x] Event pinning via persisted slugs; pinned events restore at the top on reload and closing a card unpins it.
- [x] Independent startup card loads (no batch-of-four gating).

## Next

1. [x] **Event search / add UX**
   - One dashboard-level searchable event picker; per-card event replacement/search UI removed.
   - Results show title, slug, and volume.
   - Click or Enter adds the selected result.
   - Exact slug entry remains a fast path.
   - Separate **Add event** button removed.
   - Per-card visualization mode moved beside pin/close controls.

2. [ ] **Resin historical visualization**
   - Keep the current live book sharp and authoritative.
   - Integrate the *entire* live pressure field through time, so stationary liquidity continuously contributes and develops a historical halo too.
   - Treat the historical field approximately as ∂H/∂t = D∇²H + αB(t), with history rendered separately beneath the sharp live book.
   - Preserve raw book deltas/snapshots so history can be reconstructed correctly after scale changes instead of warping an already-blurred image.
   - Keep historical rendering off the live Canvas2D hot path and benchmark its independent update cadence before increasing visual fidelity.
