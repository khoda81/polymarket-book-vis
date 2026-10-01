import {
  inferAgeRowOrientation,
  type AgeRowOrientation,
} from "../../age/ageStripOrientation";
import type { EventDetails } from "../../../domain/markets/eventDetails";
import { subsetEventDetails } from "../subsetEventDetails";
import type { Market } from "@polymarket/client";

const EVENT_SLUG =
  "who-will-attend-a-round-of-us-iran-peace-talks-by-december-31-20260812153824803";

interface ParticipantGroupRule {
  readonly key: string;
  readonly label: string;
  readonly firstThreshold: number;
  readonly lastThreshold: number | null;
}

export interface ParticipantMarketGroup {
  readonly key: string;
  readonly label: string;
  readonly bundle: EventDetails;
  readonly defaultAgeRowOrientation: AgeRowOrientation;
}

const GROUPS: readonly ParticipantGroupRule[] = [
  {
    key: "us-officials",
    label: "U.S. officials",
    firstThreshold: 0,
    lastThreshold: 5,
  },
  {
    key: "iranian-officials",
    label: "Iranian officials",
    firstThreshold: 6,
    lastThreshold: 13,
  },
  {
    key: "other-participants",
    label: "Other participants",
    firstThreshold: 14,
    lastThreshold: null,
  },
];

/** Gamma exposes stable threshold blocks for this event without group names. */
export function peaceTalkAttendeeGroups(
  details: EventDetails,
): readonly ParticipantMarketGroup[] | null {
  if (details.event.slug !== EVENT_SLUG) return null;

  const marketsByGroup = new Map<string, Market[]>(
    GROUPS.map((group) => [group.key, []]),
  );
  for (const market of details.event.markets) {
    const threshold = details.thresholdByMarketId.get(market.id);
    if (threshold === undefined || !Number.isInteger(threshold)) return null;
    const group = GROUPS.find(
      ({ firstThreshold, lastThreshold }) =>
        threshold >= firstThreshold &&
        (lastThreshold === null || threshold <= lastThreshold),
    );
    if (!group) return null;
    marketsByGroup.get(group.key)!.push(market);
  }

  if ([...marketsByGroup.values()].some((markets) => markets.length < 2))
    return null;

  const defaultAgeRowOrientation = inferAgeRowOrientation({
    sortBy: details.event.display.sortBy,
    title: details.event.title,
  });
  return GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    bundle: subsetEventDetails(details, marketsByGroup.get(group.key)!),
    defaultAgeRowOrientation,
  }));
}
