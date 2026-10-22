# Architecture principles

## Validate at trust boundaries

Inputs from Polymarket/Gamma, websocket payloads, persisted recorder state, local storage, and browser APIs are external data. Parse and validate them before converting them into internal state.

Boundary code may be defensive because the producer is outside our control.

## Make invalid internal states unrepresentable

Inside the codebase, prefer data structures and APIs whose construction enforces the invariant once.

Examples:

- a sorted book owns its stored order values instead of exposing mutable references that can invalidate ordering;
- a restored interval field is validated atomically before publication instead of carrying partially repaired overlaps;
- async chart work has one explicit owner/generation instead of scattered stale-result checks;
- clocks and pressure rendering are independent subsystems rather than sharing a redraw path merely because both appear in the same chart.

Do not add defensive branches for internal states that the type/model can forbid. If an impossible state becomes representable, fix the representation or ownership boundary rather than teaching every downstream caller how to survive it.

Correctness by construction is preferred because it removes bug classes, makes invariants local, and reduces the amount of code future changes must reason about.

## Keep independent work independent

A subsystem should invalidate only the state it owns.

Examples:

- time labels schedule their next semantic text boundary and update their DOM directly;
- live pressure redraws only when book geometry, scale, size, or theme changes;
- hover UI is a floating DOM portal and does not participate in canvas layout or clipping;
- future historical/resin rendering should run as an independent layer and cadence rather than making the live Canvas2D path pay its cost.

This separation is both a correctness rule and a performance rule.

## Code layout

The browser entry point is `src/main.ts`; `src/app/App.svelte` composes the dashboard. Imports point directly to the owning module, without barrel files or compatibility re-exports. Dependencies flow from app and chart code toward domain code; domain modules do not import chart, rendering, or app policy.

| Directory                                                   | Responsibility                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/app/dashboard`                                         | Dashboard identity, ordering, persisted preferences, masonry and reorder interactions |
| `src/app/events`, `series`, `charts`, `discovery`, `shared` | UI components grouped by feature                                                      |
| `src/domain/books`                                          | Exact prices, order books, ingestion and fee schedules                                |
| `src/domain/markets`                                        | Presentation-independent market metadata, lifecycle, ordering and visibility          |
| `src/domain/pressure`                                       | Pressure history, snapshots and observation time                                      |
| `src/domain/discovery`, `series`                            | Discovery queries and cursor-based series event paging                                |
| `src/chart/configuration`                                   | Chart definitions, palette selection and event grouping policy                        |
| `src/chart/age`, `volume`                                   | Chart views and their layout/interaction code                                         |
| `src/chart/live`                                            | Shared canonical live books, token stream state and REST/WebSocket reconciliation     |
| `src/rendering`                                             | Canvas rendering, transforms, tooltips, colors and ticks                              |
| `src/recorder`                                              | Recorder HTTP hydration and protobuf decoding                                         |
| `src/shared`                                                | General mathematical utilities                                                        |
| `src/gen`                                                   | Generated protobuf bindings; regenerate with `bun run proto:generate`                 |

Tests live beside their modules. The recorder service lives in the separate `polymarket-book-recorder` repository; this repository owns only its client and the protobuf schema it decodes.

## State ownership in the current modules

- Treat persisted browser values, protobuf messages, exchange responses and DOM measurements as external boundaries. Validate them before use. Recorder decoding produces validated pressure snapshots; hydration merges those snapshots without reparsing them.
- Dashboard discovery owns its filters, request generation and status. The reorder controller owns the complete pointer session, global listeners and animation frame lifecycle; `App.svelte` only receives order and active-key updates.
- A live token is `idle`, `awaiting-snapshot`, or `live`. Cached geometry may remain visible during reconnect, but only the `live` state exposes a book for stream mutation. REST refresh evidence cannot cross a replacement stream's snapshot barrier.
- `EventContent` owns the common event header, rules and chart groups, whether rendered in a dashboard card or a paginated series section. Series preserve actual parent events and their canonical market order; recurrence metadata does not imply market relationships or deadline spacing.
- Both views consume the existing event palette and grouping policy. Viewport slicing happens after the full group definition is built, so scrolling and visibility controls do not redefine its colors.
- `AgeStripView` owns the drawn row geometry. GPU buffers derive from that layout; hover and recording clocks read it through getters and cannot replace or clear their own copy. Pausing clears transient tooltip state while retaining the layout.
- The visualization context owns market lifecycle facts and stored visibility choices by market ID. Chart-group models own initialized token histories, recording coverage and live feeds until the group is removed. Each token hydrates once when first initialized; scrolling neither clears its data nor requests it again. Initialized live feeds keep accumulating pressure while offscreen, preserving the observed history. `ChartHost` owns display work: ordinary cards retain renderer buffers and pause offscreen drawing/clocks; series sections limit their surfaces to the viewport while retaining initialized model data. Actual group removal cancels hydration and releases its history, feeds and renderer.
- `EventMetadataCoordinator` reconciles missed lifecycle events from fresh SDK event metadata, with bounded concurrency and one periodic check per watched parent event. Cards and series share checks; standalone market filtering happens after recovery. Failed requests retain the last successful UI state. Recovery signals from browser wake/visibility/online events, subscription replacement and unavailable books request an earlier check without bypassing retry backoff. Recovered outcomes flow through the same market lifecycle and manual visibility rules as stream outcomes; metadata does not invent a resolution timestamp or bridge pressure-history gaps.
- The display wall clock samples `Date.now()` once per animation frame and runs only annotations whose absolute deadlines are due. `ObservationClock` remains a separate causal clock driven by market observations. Network retry/poll timers do not depend on visible frames; the resumed display clock only supplies an additional wake signal. A recovered live subscription must establish a fresh book snapshot before applying deltas to cached geometry.
- A valid empty order-book snapshot, an omitted token in a successful `/books` response, and a failed request are different evidence. The book watchdog delivers only actual snapshots, paces unavailable tokens with per-token backoff, and uses separate failure/rate-limit backoff for failed requests. An unavailable token can trigger metadata reconciliation but cannot clear a cached book or imply resolution.
- Derive secondary information where possible: stable sorting preserves insertion order; chart readiness follows group readiness; recorder network reporting reads the same pending-token list as the request loop.
- Keep policy constants with their owner. Discovery limits drive both queries and UI bounds/help text. Dashboard storage owns persisted keys and viewport defaults. Protocol versions come from the snapshot schema module.
- Dashboard column preferences form a nondecreasing step function of viewport width. A manual count constrains its current width and clips incompatible steps on either side; resizing only evaluates the function. Legacy counts migrate as a constraint at the width where they were restored.
- The visualization scope owns the dashboard-wide two-finger scale gesture. Single-finger panning stays with the browser; horizontal pinching changes ghost time and vertical pinching changes shares per CSS pixel. Touch and wheel changes share one coalesced tuning update per frame. Pressure tick marks and text labels have separate density policies so narrow legends retain a signed scale.
- Preserve compatibility at boundaries: storage keys, protobuf field numbers, recorder schema versions, exact price/pressure semantics and live REST/WebSocket ordering must not change during organizational refactors.

## Validation

Run `bun run format:check`, `bun run proto:check`, `bun test`, `bun run check`, and `bun run build`. `check` runs svelte-check over component scripts and templates, which the build's TypeScript step does not cover.
