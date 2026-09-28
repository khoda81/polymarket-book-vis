import { PRICE_SCALE, priceFromTicks, type Price } from "./price";
import {
  fetchMarketInfo,
  resolveConditionByToken,
} from "@polymarket/client/actions";
import type {
  PublicClient,
  TokenId,
} from "@polymarket/client";

export interface FeeSchedule {
  readonly rateNumerator: bigint;
  readonly rateDenominator: bigint;
  readonly exponent: number;
}

export const NO_FEE_SCHEDULE: FeeSchedule = Object.freeze({
  rateNumerator: 0n,
  rateDenominator: 1n,
  exponent: 0,
});

export interface FeeScheduleResolver {
  prepareTokens(tokenIds: readonly TokenId[]): Promise<void>;
  scheduleForToken(tokenId: TokenId): FeeSchedule;
}

interface CachedMarketFee {
  readonly conditionId: string;
  readonly schedule: FeeSchedule;
  readonly tokenIds: readonly TokenId[];
}

/**
 * Resolve Polymarket's authoritative market fee schedule and cache it for every
 * token in that condition. Fee metadata is immutable for normal market
 * operation; a future explicit refresh can replace one market and reproject
 * the retained raw books.
 */
export class ClobFeeScheduleResolver implements FeeScheduleResolver {
  private readonly marketByToken = new Map<TokenId, CachedMarketFee>();
  private readonly markets = new Map<string, CachedMarketFee>();

  constructor(private readonly client: PublicClient) {}

  async prepareTokens(tokenIds: readonly TokenId[]): Promise<void> {
    for (const tokenId of tokenIds) {
      if (this.marketByToken.has(tokenId)) continue;

      const conditionId = await resolveConditionByToken(this.client, {
        assetId: tokenId,
      });
      let market = this.markets.get(conditionId);
      if (!market) {
        const info = await fetchMarketInfo(this.client, { conditionId });
        market = {
          conditionId,
          schedule: feeSchedule(info.feeInfo.rate, info.feeInfo.exponent),
          tokenIds: info.tokens.map((token) => token.assetId as TokenId),
        };
        this.markets.set(conditionId, market);
        for (const assetId of market.tokenIds)
          this.marketByToken.set(assetId, market);
      }

      if (!this.marketByToken.has(tokenId))
        throw new Error(
          `Polymarket market ${conditionId} does not contain token ${tokenId}`,
        );
    }
  }

  scheduleForToken(tokenId: TokenId): FeeSchedule {
    const schedule = this.marketByToken.get(tokenId)?.schedule;
    if (!schedule)
      throw new Error(`fee schedule was not prepared for token ${tokenId}`);
    return schedule;
  }
}

export function feeSchedule(rate: number, exponent: number): FeeSchedule {
  if (!Number.isFinite(rate) || rate < 0)
    throw new RangeError("fee rate must be finite and non-negative");
  if (!Number.isSafeInteger(exponent) || exponent < 0)
    throw new RangeError("fee exponent must be a non-negative integer");

  const [rateNumerator, rateDenominator] = decimalRatio(String(rate));
  const schedule = { rateNumerator, rateDenominator, exponent };
  validateMonotone(schedule);
  return schedule;
}

/** Effective taker BUY cost, quantized to the containing upper-edge bucket. */
export function effectiveAskPrice(
  rawPrice: Price,
  schedule: FeeSchedule,
): Price {
  const feeTicks = feeTicksCeil(rawPrice, schedule);
  const effective = BigInt(rawPrice) + feeTicks;
  if (effective > BigInt(PRICE_SCALE))
    throw new RangeError("effective taker BUY price exceeds 1.0");
  return priceFromTicks(Number(effective));
}

/** Effective taker SELL proceeds, conservatively quantized downward. */
export function effectiveBidPrice(
  rawPrice: Price,
  schedule: FeeSchedule,
): Price {
  const feeTicks = feeTicksCeil(rawPrice, schedule);
  const effective = BigInt(rawPrice) - feeTicks;
  if (effective < 0n)
    throw new RangeError("effective taker SELL price is below 0");
  return priceFromTicks(Number(effective));
}

function feeTicksCeil(rawPrice: Price, schedule: FeeSchedule): bigint {
  if (rawPrice === 0 || rawPrice === PRICE_SCALE || schedule.rateNumerator === 0n)
    return 0n;

  const scale = BigInt(PRICE_SCALE);
  const raw = BigInt(rawPrice);
  const baseNumerator = raw * (scale - raw);
  const baseDenominator = scale * scale;

  let numerator = schedule.rateNumerator * scale;
  let denominator = schedule.rateDenominator;
  for (let index = 0; index < schedule.exponent; index++) {
    numerator *= baseNumerator;
    denominator *= baseDenominator;
  }
  return ceilDiv(numerator, denominator);
}

function validateMonotone(schedule: FeeSchedule): void {
  let previousAsk = 0;
  let previousBid = 0;
  for (let ticks = 0; ticks <= PRICE_SCALE; ticks++) {
    const raw = priceFromTicks(ticks);
    const ask = effectiveAskPrice(raw, schedule);
    const bid = effectiveBidPrice(raw, schedule);
    if (ask < previousAsk || bid < previousBid)
      throw new RangeError("fee-adjusted price mapping is not monotone");
    previousAsk = ask;
    previousBid = bid;
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n)
    throw new RangeError("invalid non-negative rational");
  return (numerator + denominator - 1n) / denominator;
}

function decimalRatio(value: string): readonly [bigint, bigint] {
  const match =
    /^([+]?)((?:\d+))(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new RangeError(`invalid decimal fee rate: ${value}`);

  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent))
    throw new RangeError(`invalid decimal exponent: ${value}`);

  let numerator = BigInt(integer + fraction);
  let scale = fraction.length - exponent;
  let denominator = 1n;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else if (scale < 0) numerator *= 10n ** BigInt(-scale);

  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}
