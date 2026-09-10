/**
 * Standing is always derived from points, never read from the Sheet.
 *
 * The Sheet has a Standing column that a human types. If we trusted it, it
 * would drift out of sync the first time someone edited Points and forgot the
 * other cell. The E-Board can keep that column for their own reference; this
 * is the value members actually see.
 */

export const STANDING = {
  GOOD: "good",
  OKAY: "okay",
  AT_RISK: "at_risk",
};

export const STANDING_COPY = {
  [STANDING.GOOD]: {
    label: "Good Standing",
    message: "You are currently meeting RSVP's active-member expectations.",
  },
  [STANDING.OKAY]: {
    label: "Okay Standing",
    message:
      "You are participating, but a little below where RSVP expects active members to be.",
  },
  [STANDING.AT_RISK]: {
    label: "At Risk",
    message:
      "You are below RSVP's participation expectations. Reach out to the E-Board about ways to get involved.",
  },
};

export function standingFor(points, thresholds) {
  if (points >= thresholds.good) return STANDING.GOOD;
  if (points >= thresholds.okay) return STANDING.OKAY;
  return STANDING.AT_RISK;
}

export function describeStanding(points, thresholds) {
  const standing = standingFor(points, thresholds);
  return { standing, ...STANDING_COPY[standing] };
}
