import { expect, test } from "bun:test";
import { priceFromTicks } from "../domain/books/price";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { RecorderStateResponseSchema } from "../gen/polymarket_book_recorder/pressure/v8/recorder_state_pb";
import { decodeRecorderStateResponse } from "./recorderCodec";
import { PRESSURE_FRONTIER_SNAPSHOT_VERSION } from "../domain/pressure/pressureFrontierSnapshot";

function decode(value: MessageInitShape<typeof RecorderStateResponseSchema>) {
  return decodeRecorderStateResponse(
    toBinary(
      RecorderStateResponseSchema,
      create(RecorderStateResponseSchema, value),
    ),
  );
}

test("recorder boundary decodes all pressure variants and preserves pending/empty states", () => {
  const result = decode({
    recordingSinceMsByToken: { observed: 1000n },
    pendingTokenIds: ["pending"],
    states: {
      empty: {},
      unobserved: { pressure: { state: { case: "unobserved", value: {} } } },
      resolved: {
        pressure: { state: { case: "resolvedUnbounded", value: {} } },
      },
      observed: {
        pressure: {
          state: {
            case: "observed",
            value: {
              validThroughMs: 2000n,
              runs: [
                {
                  price: 5000,
                  shares: 2,
                  frozenSteps: [{ hiVolume: 3, validThroughMs: 1000n }],
                },
              ],
            },
          },
        },
      },
    },
  });
  expect(result.pendingTokenIds).toEqual(["pending"]);
  expect(result.recordingSinceMsByToken).toEqual({ observed: 1000 });
  expect(result.states.empty).toEqual({});
  expect(result.states.unobserved.pressure?.state).toEqual({
    kind: "unobserved",
  });
  expect(result.states.resolved.pressure?.state).toEqual({
    kind: "resolvedUnbounded",
  });
  expect(result.states.observed.pressure).toEqual({
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    state: {
      kind: "observed",
      validThroughMs: 2000,
      runs: [
        {
          price: priceFromTicks(5000),
          shares: 2,
          frozenSteps: [{ hiVolume: 3, validThroughMs: 1000 }],
        },
      ],
    },
  });
});

test("recorder boundary rejects unsafe timestamps and missing pressure state", () => {
  expect(() =>
    decode({ recordingSinceMsByToken: { token: 9007199254740992n } }),
  ).toThrow("safe integer");
  expect(() => decode({ states: { token: { pressure: {} } } })).toThrow(
    "state is missing",
  );
  expect(() =>
    decode({
      states: {
        token: { pressure: { state: { case: "observed", value: {} } } },
      },
    }),
  ).toThrow("timestamp is missing");
});

test("recorder boundary validates pressure runs before hydration sees them", () => {
  expect(() =>
    decode({
      states: {
        token: {
          pressure: {
            state: {
              case: "observed",
              value: {
                validThroughMs: 2000n,
                runs: [{ price: 5000, shares: -1 }],
              },
            },
          },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    decode({
      states: {
        token: {
          pressure: {
            state: {
              case: "observed",
              value: {
                validThroughMs: 2000n,
                runs: [
                  { price: 5000, shares: 2, frozenSteps: [{ hiVolume: 3 }] },
                ],
              },
            },
          },
        },
      },
    }),
  ).toThrow("timestamp is missing");
});
