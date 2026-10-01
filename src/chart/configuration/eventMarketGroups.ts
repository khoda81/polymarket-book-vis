import {
  inferAgeRowOrientation,
  type AgeRowOrientation,
} from "../age/ageStripOrientation";
import type { EventDetails } from "../../domain/markets/eventDetails";
import { thresholdMarketGroups } from "./thresholdChartGroups";
import type { ThresholdFamilyDirection } from "../../rendering/colors/thresholdColors";
import { peaceTalkAttendeeGroups } from "./grouping/peaceTalkAttendees";

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

  const participantGroups = peaceTalkAttendeeGroups(bundle);
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

/** Put the most inclusive edge first in the group's hidden-market strip. */
function thresholdGroupOrientation(
  direction: ThresholdFamilyDirection,
): AgeRowOrientation {
  return direction === "prefix" ? "negative-above" : "positive-above";
}
