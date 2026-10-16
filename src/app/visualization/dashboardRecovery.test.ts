import { expect, test } from "bun:test";
import type { TokenId } from "@polymarket/client";
import { WallClock } from "../../shared/wallClock";
import { withFakeTimers } from "../../shared/testing/fakeTimers";
import { startDashboardRecovery } from "./dashboardRecovery";

test("wake, visibility and online signals recover once and all subscriptions are cleaned up", () =>
  withFakeTimers((time) => {
    const wallClock = new WallClock(time.nowMs);
    const browserWindow = new EventTarget();
    const browserDocument = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });
    let metadataChecks = 0;
    let reconnects = 0;
    let targeted: readonly TokenId[] = [];
    let signal: ((tokens: readonly TokenId[]) => void) | undefined;
    const stop = startDashboardRecovery(
      wallClock,
      {
        refreshAll: () => {
          metadataChecks++;
        },
        refreshTokens: (tokens) => {
          targeted = tokens;
        },
      },
      {
        recover: () => {
          reconnects++;
        },
        subscribeRecovery: (listener) => {
          signal = listener;
          return () => {
            signal = undefined;
          };
        },
      },
      browserWindow,
      browserDocument,
    );

    browserDocument.visibilityState = "hidden";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    expect(metadataChecks).toBe(0);
    browserDocument.visibilityState = "visible";
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    browserWindow.dispatchEvent(new Event("focus"));
    browserWindow.dispatchEvent(new Event("online"));
    expect(metadataChecks).toBe(1);
    expect(reconnects).toBe(1);

    time.nowMs += 12 * 3_600_000; // Sleep without a visibility change.
    wallClock.tick(time.nowMs);
    browserWindow.dispatchEvent(new Event("online"));
    expect(metadataChecks).toBe(2);
    expect(reconnects).toBe(2);
    signal!(["yes-1" as TokenId]);
    expect(targeted).toEqual(["yes-1" as TokenId]);

    stop();
    time.nowMs += 12 * 3_600_000;
    wallClock.tick(time.nowMs);
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    browserWindow.dispatchEvent(new Event("online"));
    expect(metadataChecks).toBe(2);
    expect(reconnects).toBe(2);
    expect(signal).toBeUndefined();
  }));
