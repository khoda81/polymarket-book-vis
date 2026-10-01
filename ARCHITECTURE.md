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

The browser entry point is `src/main.ts`; `src/app/App.svelte` composes the dashboard. Imports point directly to the owning module, without barrel files or compatibility re-exports.

| Directory                                                   | Responsibility                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/app/dashboard`                                         | Dashboard identity, ordering, persisted preferences, masonry and reorder interactions |
| `src/app/events`, `series`, `charts`, `discovery`, `shared` | UI components grouped by feature                                                      |
| `src/domain/books`                                          | Exact prices, order books, ingestion and fee schedules                                |
| `src/domain/markets`                                        | Market metadata, lifecycle, visibility and chart definitions                          |
| `src/domain/pressure`                                       | Pressure history, snapshots and observation time                                      |
| `src/domain/discovery`, `series`                            | Discovery queries and series timeline models                                          |
| `src/chart/age`, `volume`, `series`                         | Chart views and their layout/interaction code                                         |
| `src/chart/live`                                            | Shared canonical live books and REST/WebSocket reconciliation                         |
| `src/rendering`                                             | Canvas rendering, transforms, tooltips, colors and ticks                              |
| `src/recorder`                                              | Recorder HTTP hydration and protobuf decoding                                         |
| `src/shared`                                                | General mathematical utilities                                                        |
| `src/gen`                                                   | Generated protobuf bindings; regenerate with `bun run proto:generate`                 |
| `backend/storage`, `live`                                   | Recorder persistence and subscriptions                                                |
| `backend/legacyPressureV5`                                  | Legacy pressure implementation used by the recorder store                             |

Tests live beside their modules. `backend/recorder.ts` remains the recorder entry point.

## State ownership in the current modules

- Treat persisted browser values, protobuf messages, exchange responses and DOM measurements as external boundaries. Validate them before use. Recorder decoding produces validated pressure snapshots; hydration merges those snapshots without reparsing them.
- A drag is either absent or a complete session with its key, original geometry and current pointer. Chart groups own their orientation, readiness and market status together, rather than keeping partially populated maps in sync.
- Derive secondary information where possible: stable sorting preserves insertion order; chart readiness follows group readiness; recorder network reporting reads the same pending-token list as the request loop.
- Keep policy constants with their owner. Discovery limits drive both queries and UI bounds/help text. Dashboard storage owns persisted keys and viewport defaults. Protocol versions come from the snapshot schema module.
- Preserve compatibility at boundaries: storage keys, protobuf field numbers, recorder schema versions, exact price/pressure semantics and live REST/WebSocket ordering must not change during organizational refactors.

## Validation

Run `bun run format:check`, `bun run proto:check`, `bun test`, and `bun run build`. Svelte component diagnostics can additionally be checked with `bunx svelte-check --tsconfig ./tsconfig.json`; the build's TypeScript step covers `.ts` files, not component scripts.
