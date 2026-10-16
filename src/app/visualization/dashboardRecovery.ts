import type { EventMetadataCoordinator } from "@/domain/markets/eventMetadataCoordinator";
import type { LiveBookCoordinator } from "@/chart/live/liveBookCoordinator";
import type { WallClock } from "@/shared/wallClock";

const RESUME_GAP_MS = 5_000;
const CHECK_GAP_MS = 1_000;

/** Browser wake signals complement (but do not drive) the network retry loops. */
export function startDashboardRecovery(
  clock: WallClock,
  metadata: Pick<EventMetadataCoordinator, "refreshAll" | "refreshTokens">,
  books: Pick<LiveBookCoordinator, "recover" | "subscribeRecovery">,
  browserWindow: Pick<
    Window,
    "addEventListener" | "removeEventListener"
  > = window,
  browserDocument: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  > = document,
): () => void {
  let lastRecoveryMs = -Infinity;
  const recover = () => {
    const nowMs = Date.now();
    if (nowMs >= lastRecoveryMs && nowMs - lastRecoveryMs < RESUME_GAP_MS)
      return;
    lastRecoveryMs = nowMs;
    metadata.refreshAll();
    books.recover();
  };
  const becameVisible = () => {
    if (browserDocument.visibilityState === "visible") recover();
  };
  const restoredPage = (event: PageTransitionEvent) => {
    if (event.persisted) recover();
  };
  // OS sleep need not change tab visibility. The wall clock catches that gap
  // on the first resumed frame even if an old relative timeout has time left.
  let previousCheckMs = clock.nowMs;
  const watch = clock.watch((nowMs) => {
    if (nowMs - previousCheckMs >= RESUME_GAP_MS) recover();
    previousCheckMs = nowMs;
    return nowMs + CHECK_GAP_MS;
  });
  const unsubscribe = books.subscribeRecovery((tokens) =>
    metadata.refreshTokens(tokens),
  );
  browserWindow.addEventListener("online", recover);
  browserWindow.addEventListener("focus", becameVisible);
  browserWindow.addEventListener("pageshow", restoredPage);
  browserDocument.addEventListener("visibilitychange", becameVisible);
  return () => {
    watch.destroy();
    unsubscribe();
    browserWindow.removeEventListener("online", recover);
    browserWindow.removeEventListener("focus", becameVisible);
    browserWindow.removeEventListener("pageshow", restoredPage);
    browserDocument.removeEventListener("visibilitychange", becameVisible);
  };
}
