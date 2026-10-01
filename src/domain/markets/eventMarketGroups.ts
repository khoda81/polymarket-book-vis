import {
  inferAgeRowOrientation,
  type AgeRowOrientation,
} from "../../chart/age/ageStripOrientation";
import type { EventDetails } from "./eventDetails";
import { thresholdMarketGroups } from "./thresholdChartGroups";
import type { ThresholdFamilyDirection } from "../../rendering/colors/thresholdColors";
import type { Market, MarketId } from "@polymarket/client";

export type EventMarketGroupKey = string;

export interface EventMarketGroup {
  readonly key: EventMarketGroupKey;
  readonly label: string | null;
  readonly bundle: EventDetails;
  readonly defaultAgeRowOrientation: AgeRowOrientation;
}

/** Every event card is rendered as one or more independently controlled groups. */
export function eventMarketGroups(
  bundle: EventDetails,
): readonly EventMarketGroup[] {
  const thresholdGroups = thresholdMarketGroups(bundle);
  if (thresholdGroups)
    return thresholdGroups.map((group) => ({
      key: group.key,
      label: group.label,
      bundle: group.bundle,
      defaultAgeRowOrientation: thresholdGroupOrientation(group.direction),
    }));

  const participantGroups = peaceTalkParticipantGroups(bundle);
  if (participantGroups) return participantGroups;

  return [
    {
      key: "all",
      label: null,
      bundle,
      defaultAgeRowOrientation: inferAgeRowOrientation({
        sortBy: bundle.event.display.sortBy,
        title: bundle.event.title,
      }),
    },
  ];
}

const PEACE_TALK_ATTENDEES_SLUG =
  "who-will-attend-a-round-of-us-iran-peace-talks-by-december-31-20260812153824803";

interface OrderedParticipantGroup {
  readonly key: string;
  readonly label: string;
  readonly includesThreshold: (threshold: number) => boolean;
}

const PEACE_TALK_PARTICIPANT_GROUPS: readonly OrderedParticipantGroup[] = [
  {
    key: "us-officials",
    label: "U.S. officials",
    includesThreshold: (threshold) => threshold >= 0 && threshold <= 5,
  },
  {
    key: "iranian-officials",
    label: "Iranian officials",
    includesThreshold: (threshold) => threshold >= 6 && threshold <= 13,
  },
  {
    key: "other-participants",
    label: "Other participants",
    includesThreshold: (threshold) => threshold >= 14,
  },
];

/**
 * Gamma does not publish semantic group names for this event, but its curated
 * threshold ordering contains three stable participant blocks. Keep this rule
 * scoped to the exact event instead of guessing nationalities from names.
 */
function peaceTalkParticipantGroups(
  bundle: EventDetails,
): readonly EventMarketGroup[] | null {
  if (bundle.event.slug !== PEACE_TALK_ATTENDEES_SLUG) return null;

  const marketsByGroup = new Map<string, Market[]>(
    PEACE_TALK_PARTICIPANT_GROUPS.map((group) => [group.key, []]),
  );
  for (const market of bundle.event.markets) {
    const threshold = bundle.thresholdByMarketId.get(market.id);
    if (threshold === undefined || !Number.isInteger(threshold)) return null;
    const matching = PEACE_TALK_PARTICIPANT_GROUPS.filter((group) =>
      group.includesThreshold(threshold),
    );
    if (matching.length !== 1) return null;
    marketsByGroup.get(matching[0]!.key)!.push(market);
  }

  if ([...marketsByGroup.values()].some((markets) => markets.length < 2))
    return null;

  const defaultAgeRowOrientation = inferAgeRowOrientation({
    sortBy: bundle.event.display.sortBy,
    title: bundle.event.title,
  });
  return PEACE_TALK_PARTICIPANT_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    bundle: subsetBundle(bundle, marketsByGroup.get(group.key)!),
    defaultAgeRowOrientation,
  }));
}

function subsetBundle(
  bundle: EventDetails,
  markets: readonly Market[],
): EventDetails {
  const marketIds = new Set<MarketId>(markets.map((market) => market.id));
  return {
    ...bundle,
    event: { ...bundle.event, markets: [...markets] },
    presentation: {
      ...bundle.presentation,
      marketRules: bundle.presentation.marketRules.filter((rule) =>
        marketIds.has(rule.marketId),
      ),
    },
  };
}

/** Put the most inclusive edge first in the group's hidden-market strip. */
function thresholdGroupOrientation(
  direction: ThresholdFamilyDirection,
): AgeRowOrientation {
  return direction === "prefix" ? "negative-above" : "positive-above";
}
