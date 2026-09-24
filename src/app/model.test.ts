import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import {
  eventSlug,
  normalizePinnedSlugs,
  pinState,
  toEventSlug,
  type EventDashboardItem,
  type EventSlug,
} from "./model";

function fakeEvent(id: string, slug: string | null): Event {
  return {
    id,
    slug,
    title: id,
  } as unknown as Event;
}

test("event slugs are non-empty by construction", () => {
  expect(toEventSlug("")).toBeNull();
  expect(toEventSlug("   ")).toBeNull();
  expect(toEventSlug(null)).toBeNull();
  expect(String(toEventSlug("  abc-def  "))).toBe("abc-def");
});

test("pin state cannot represent a pinned event without a slug", () => {
  const noSlug = fakeEvent("no-slug", null);
  expect(pinState(noSlug, [])).toEqual({ kind: "unavailable" });

  const withSlug = fakeEvent("with-slug", "abc-def");
  const slug = eventSlug(withSlug)!;
  expect(pinState(withSlug, [])).toEqual({
    kind: "unpinned",
    slug,
  });
  expect(pinState(withSlug, [slug])).toEqual({
    kind: "pinned",
    slug,
  });
});

test("stored pin order is unique and preserves first occurrence", () => {
  expect(
    normalizePinnedSlugs([
      "alpha-event",
      "",
      "alpha-event",
      " beta-event ",
      null,
    ]).map(String),
  ).toEqual(["alpha-event", "beta-event"]);
});
