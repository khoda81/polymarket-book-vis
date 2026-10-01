import { expect, test } from "bun:test";
import { emptyTokenBook } from "@/domain/books/orderBook";
import { LiveTokenState } from "./liveTokenState";

test("a token becomes synchronized only after the stream snapshot", () => {
  const token = new LiveTokenState();
  token.beginStream(1_000);

  expect(token.awaitingSnapshot).toBe(true);
  expect(token.streamBook()).toBeNull();

  const book = emptyTokenBook();
  expect(token.acceptSnapshot(book, 900)).toEqual({
    book,
    firstOnStream: true,
    validThroughMs: 1_000,
  });
  expect(token.synchronized).toBe(true);
  expect(token.streamBook()).toBe(book);
});

test("disconnect preserves a cached book without allowing stream mutation", () => {
  const token = new LiveTokenState();
  const book = emptyTokenBook();
  token.beginStream(1_000);
  token.acceptSnapshot(book, 1_100);
  token.disconnect();

  expect(token.book).toBe(book);
  expect(token.awaitingSnapshot).toBe(true);
  expect(token.streamBook()).toBeNull();
});

test("a replacement snapshot keeps the strongest causal watermark", () => {
  const token = new LiveTokenState();
  token.beginStream(1_000);
  token.acceptSnapshot(emptyTokenBook(), 1_100);
  token.confirmThrough(1_200);

  const replacement = emptyTokenBook();
  expect(token.acceptSnapshot(replacement, 1_150)).toEqual({
    book: replacement,
    firstOnStream: false,
    validThroughMs: 1_200,
  });
});
