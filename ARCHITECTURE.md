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
