import { expect, test } from "bun:test";
import { DirtyTokenTracker } from "./dirtyTokenTracker";

test("acknowledging a flushed generation keeps newer writes dirty", () => {
  const dirty = new DirtyTokenTracker();
  dirty.mark(["a", "b"]);

  const captured = dirty.capture(["a", "b"]);
  dirty.mark(["a"]);
  dirty.acknowledge(captured);

  expect(dirty.tokenIds()).toEqual(["a"]);

  dirty.acknowledge(dirty.capture(["a"]));
  expect(dirty.size).toBe(0);
});

test("capture ignores tokens that are no longer dirty", () => {
  const dirty = new DirtyTokenTracker();
  dirty.mark(["a"]);
  const version = dirty.capture(["a"]);
  dirty.acknowledge(version);

  expect(dirty.capture(["a"])).toEqual([]);
});
