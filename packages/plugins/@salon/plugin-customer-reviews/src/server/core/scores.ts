// Client Review Scores aggregation. Pure, unit-tested.
//
// Average rating = sum of qualifying ratings / number of qualifying reviews.
// Qualifying = every submitted review, including negative ones and reviews flagged by a moderator:
// flagging marks a review for attention, it never removes it from the score. There is no moderation
// rule that excludes reviews from the average. Pending invitations are not reviews and never count.

export const COUNTED_STATUSES = ['submitted', 'flagged'];

/** Below this many reviews a technician's average is shown with a "few reviews" note and is not ranked. */
export const MIN_RANKABLE_REVIEWS = 5;

export type ReviewRow = { staffId: unknown; rating: unknown; status?: unknown };
export type StaffScore = {
  staffId: string;
  count: number;
  sum: number;
  average: number | null;
  distribution: [number, number, number, number, number];
  flagged: number;
  lowSample: boolean;
};

export function aggregateScores(rows: ReviewRow[]): Record<string, StaffScore> {
  const by: Record<string, StaffScore> = {};
  for (const row of rows || []) {
    const rating = Number(row.rating);
    const status = String(row.status ?? 'submitted');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) continue;
    if (!COUNTED_STATUSES.includes(status)) continue;
    if (row.staffId === null || row.staffId === undefined || row.staffId === '') continue;
    const key = String(row.staffId);
    const s = (by[key] ||= { staffId: key, count: 0, sum: 0, average: null, distribution: [0, 0, 0, 0, 0], flagged: 0, lowSample: true });
    s.count += 1;
    s.sum += rating;
    s.distribution[rating - 1] += 1;
    if (status === 'flagged') s.flagged += 1;
  }
  for (const s of Object.values(by)) {
    s.average = s.count ? s.sum / s.count : null;
    s.lowSample = s.count < MIN_RANKABLE_REVIEWS;
  }
  return by;
}

/** One decimal place, as displayed. Never returns 0.0 for "no reviews": that is null. */
export function formatAverage(average: number | null): string | null {
  if (average === null || !Number.isFinite(average)) return null;
  return (Math.round(average * 10) / 10).toFixed(1);
}
