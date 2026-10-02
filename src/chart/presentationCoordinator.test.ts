import { expect, test } from "bun:test";
import {
  PresentationCoordinator,
  type PresentationTarget,
} from "./presentationCoordinator";

function withFakeAnimationFrames(
  run: (callbacks: Map<number, FrameRequestCallback>) => void,
): void {
  const originalRequest = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  const originalCancel = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame",
  );

  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => {
      callbacks.delete(id);
    },
  });

  try {
    run(callbacks);
  } finally {
    if (originalRequest)
      Object.defineProperty(globalThis, "requestAnimationFrame", originalRequest);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");

    if (originalCancel)
      Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
}

function runNextFrame(
  callbacks: Map<number, FrameRequestCallback>,
  timeMs: number,
): void {
  const next = [...callbacks.entries()][0]!;
  callbacks.delete(next[0]);
  next[1](timeMs);
}

test("one frame renders each dirty target once with its latest state", () => {
  withFakeAnimationFrames((callbacks) => {
    const coordinator = new PresentationCoordinator();
    const frames: string[] = [];
    let aGeneration = 0;

    const a: PresentationTarget = {
      renderFrame() {
        frames.push(`a:${aGeneration}`);
      },
    };
    const b: PresentationTarget = {
      renderFrame() {
        frames.push("b");
      },
    };

    aGeneration = 1;
    coordinator.invalidate(a);
    aGeneration = 2;
    coordinator.invalidate(a);
    coordinator.invalidate(b);

    expect(callbacks.size).toBe(1);
    runNextFrame(callbacks, 10);

    expect(frames).toEqual(["a:2", "b"]);
    expect(callbacks.size).toBe(0);
    coordinator.destroy();
  });
});

test("reinvalidating while a frame is consumed schedules the next frame", () => {
  withFakeAnimationFrames((callbacks) => {
    const coordinator = new PresentationCoordinator();
    let renders = 0;
    const target: PresentationTarget = {
      renderFrame() {
        renders++;
        if (renders === 1) coordinator.invalidate(target);
      },
    };

    coordinator.invalidate(target);
    runNextFrame(callbacks, 10);

    expect(renders).toBe(1);
    expect(callbacks.size).toBe(1);

    runNextFrame(callbacks, 20);

    expect(renders).toBe(2);
    expect(callbacks.size).toBe(0);
    coordinator.destroy();
  });
});

test("one failing target does not block the rest of the frame", () => {
  withFakeAnimationFrames((callbacks) => {
    const originalReportError = Object.getOwnPropertyDescriptor(
      globalThis,
      "reportError",
    );
    const reported: unknown[] = [];
    Object.defineProperty(globalThis, "reportError", {
      configurable: true,
      value: (error: unknown) => reported.push(error),
    });

    try {
      const coordinator = new PresentationCoordinator();
      const rendered: string[] = [];
      const failure = new Error("boom");

      const failing: PresentationTarget = {
        renderFrame() {
          throw failure;
        },
      };
      const healthy: PresentationTarget = {
        renderFrame() {
          rendered.push("healthy");
        },
      };

      coordinator.invalidate(failing);
      coordinator.invalidate(healthy);
      runNextFrame(callbacks, 10);

      expect(reported).toEqual([failure]);
      expect(rendered).toEqual(["healthy"]);
      expect(callbacks.size).toBe(0);
      coordinator.destroy();
    } finally {
      if (originalReportError)
        Object.defineProperty(globalThis, "reportError", originalReportError);
      else Reflect.deleteProperty(globalThis, "reportError");
    }
  });
});
