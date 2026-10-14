// Customer activity filters: the one definition of what "inactive for 3 months", "most active", "at risk" etc. mean.
//
// This file runs in two places, so it must stay plain JavaScript with no imports:
//   * in Node, for the unit tests and the apply script (the export line at the bottom, dropped for the browser), and
//   * in the browser, where its source is injected into scripts/ui/customers-toolbar.js in place of the
//     CUSTOMER_ACTIVITY_RULES placeholder comment (see scripts/customer-activity-page.js).
//
// Every rule is a NocoBase filter or sort on real columns of the `customers` collection: visitCount, firstVisitAt,
// lastVisitAt, totalSpent and visitsLast1m .. visitsLast6m. Those columns are a cache of the database view
// customerActivity, refreshed by triggers on every appointment or payment change and nightly by the workflow
// "Refresh customer activity" (scripts/migrations/20261013_customer_activity_columns.sql). Real columns are needed
// because NocoBase 2.2 cannot sort through a relation. The server evaluates filter and sort together with the
// signed-in role's scope; nothing is filtered in the browser.
//
// Time periods are rolling: "last 3 months" means on or after today minus three months. A customer is "inactive for
// at least N months" when they have visited before but not since that cutoff; "last visited N to N+1 months ago" is
// the one-month band between two cutoffs. Both are offered because salon owners ask for both.

const CUSTOMER_ACTIVITY = (function () {
  // Column names on customers.
  const F = { visits: 'visitCount', first: 'firstVisitAt', last: 'lastVisitAt', spent: 'totalSpent', window: (m) => 'visitsLast' + m + 'm' };

  // Each period needs a matching visitsLast<N>m column on customers (and in the view) for "most active".
  const PERIODS = [1, 2, 3, 4, 5, 6, 12].map((n) => ({ value: n, label: n === 1 ? 'Last month' : n === 12 ? 'Last 12 months' : 'Last ' + n + ' months' }));

  const SORTS = [
    { value: 'active', label: 'Most active first', sort: (m) => ['-' + F.window(m), '-' + F.last, 'firstName'] },
    { value: 'recent', label: 'Most recent visit first', sort: () => ['-' + F.last, 'firstName'] },
    { value: 'longest', label: 'Longest since last visit', sort: () => [F.last, 'firstName'] },
    { value: 'spent', label: 'Highest spending first', sort: () => ['-' + F.spent, '-' + F.last, 'firstName'] },
    { value: 'newest', label: 'Newest customers first', sort: () => ['-createdAt'] },
  ];

  // Regular customer: at least this many completed visits (used by "at risk").
  const REGULAR_VISITS = 3;
  // "At risk" looks back this far: a regular who has not been back for the period but did visit within this window.
  const AT_RISK_WINDOW_MONTHS = 12;

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const monthsAgo = (n) => (n === 1 ? 'a month ago' : n + ' months ago');

  // Same calendar day N months earlier, clamped to the end of a shorter month (31 Mar - 1 month = 28/29 Feb).
  // Computed in UTC so the cutoff does not shift by an hour across daylight-saving changes and is the same
  // whichever browser time zone asks; the server compares it with UTC timestamps.
  function cutoffDate(now, months) {
    const day = now.getUTCDate();
    const target = new Date(now.getTime());
    target.setUTCDate(1);
    target.setUTCMonth(target.getUTCMonth() - months);
    const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, daysInTarget));
    return target;
  }
  const cutoffISO = (now, months) => cutoffDate(now, months).toISOString();

  const visited = { [F.visits]: { $gte: 1 } };
  const notSince = (now, months) => ({ [F.last]: { $lt: cutoffISO(now, months) } });
  const sinceOrAfter = (now, months) => ({ [F.last]: { $gte: cutoffISO(now, months) } });

  // key: stable id used in the UI state. label(months): what the dropdown shows. period: whether the time period
  // applies. sort: the sort selected automatically when the activity is chosen. filter/describe: the rule.
  const ACTIVITIES = [
    {
      key: 'all', period: false, sort: 'newest',
      label: () => 'All customers',
      filter: () => ({}),
      describe: () => 'All customers.',
    },
    {
      key: 'inactive', period: true, sort: 'longest',
      label: (m) => 'Inactive for ' + m + '+ months',
      filter: ({ now, months }) => ({ $and: [visited, notSince(now, months)] }),
      describe: ({ months, cutoff }) => 'Customers who have visited before but have no completed visit since ' + cutoff + ' (' + plural(months, 'month') + ' or longer). Customers who never visited are not included.',
    },
    {
      key: 'lastVisitedBetween', period: true, sort: 'longest',
      label: (m) => 'Last visited ' + m + '–' + (m + 1) + ' months ago',
      filter: ({ now, months }) => ({ $and: [notSince(now, months), sinceOrAfter(now, months + 1)] }),
      describe: ({ months, cutoff, cutoffNext }) => 'Customers whose most recent completed visit was between ' + cutoffNext + ' and ' + cutoff + ' (' + monthsAgo(months) + ' to ' + monthsAgo(months + 1) + ').',
    },
    {
      key: 'mostInactive', period: false, sort: 'longest',
      label: () => 'Most inactive customers',
      filter: () => visited,
      describe: () => 'Customers who have visited before, longest since their last completed visit first.',
    },
    {
      key: 'mostActive', period: true, sort: 'active',
      label: (m) => 'Most active in the last ' + plural(m, 'month'),
      filter: ({ months }) => ({ [F.window(months)]: { $gte: 1 } }),
      describe: ({ months, cutoff }) => 'Customers with at least one completed visit since ' + cutoff + ', most completed visits in the last ' + plural(months, 'month') + ' first.',
    },
    {
      key: 'new', period: true, sort: 'recent',
      label: (m) => 'New in the last ' + plural(m, 'month'),
      filter: ({ now, months }) => ({ [F.first]: { $gte: cutoffISO(now, months) } }),
      describe: ({ months, cutoff }) => 'Customers whose first completed visit was on or after ' + cutoff + ' (last ' + plural(months, 'month') + ').',
    },
    {
      key: 'oneTime', period: false, sort: 'recent',
      label: () => 'One-time customers',
      filter: () => ({ [F.visits]: { $eq: 1 } }),
      describe: () => 'Customers with exactly one completed visit.',
    },
    {
      key: 'repeat', period: false, sort: 'recent',
      label: () => 'Repeat customers',
      filter: () => ({ [F.visits]: { $gte: 2 } }),
      describe: () => 'Customers with two or more completed visits.',
    },
    {
      key: 'highValue', period: false, sort: 'spent',
      label: () => 'High-value customers',
      filter: () => ({ [F.spent]: { $gt: 0 } }),
      describe: () => 'Customers with paid payments, highest net spending first (refunds are deducted; pending and failed payments do not count).',
    },
    {
      key: 'atRisk', period: true, sort: 'longest',
      label: (m) => 'At risk (regulars away ' + m + '+ months)',
      filter: ({ now, months }) => ({
        $and: [{ [F.visits]: { $gte: REGULAR_VISITS } }, notSince(now, months), sinceOrAfter(now, AT_RISK_WINDOW_MONTHS)],
      }),
      describe: ({ months, cutoff }) => 'Regular customers (' + REGULAR_VISITS + ' or more completed visits) whose last visit was before ' + cutoff + ' but within the last ' + AT_RISK_WINDOW_MONTHS + ' months.',
    },
    {
      key: 'never', period: false, sort: 'newest',
      label: () => 'Never visited',
      filter: () => ({ $or: [{ [F.visits]: { $eq: 0 } }, { [F.visits]: { $empty: true } }] }),
      describe: () => 'Registered customers with no completed appointment.',
    },
  ];

  const byKey = (key) => ACTIVITIES.find((a) => a.key === key) || ACTIVITIES[0];
  const sortByKey = (key) => SORTS.find((s) => s.value === key) || SORTS[SORTS.length - 1];
  const normalizeMonths = (months) => {
    const n = Number(months);
    return PERIODS.some((p) => p.value === n) ? n : 3;
  };
  const defaultFormat = (date) => date.toISOString().slice(0, 10);

  function filter({ activity, months, now }) {
    return byKey(activity).filter({ now: now || new Date(), months: normalizeMonths(months) });
  }
  function sort({ sort, months }) {
    return sortByKey(sort).sort(normalizeMonths(months));
  }
  function describe({ activity, months, now, formatDate }) {
    const m = normalizeMonths(months);
    const at = now || new Date();
    const fmt = formatDate || defaultFormat;
    return byKey(activity).describe({ months: m, cutoff: fmt(cutoffDate(at, m)), cutoffNext: fmt(cutoffDate(at, m + 1)) });
  }
  const usesPeriod = (activity, sortKey) => !!byKey(activity).period || sortKey === 'active';
  const defaultSort = (activity) => byKey(activity).sort;
  const options = (months) => ACTIVITIES.map((a) => ({ value: a.key, label: a.label(normalizeMonths(months)) }));

  return {
    ACTIVITIES, FIELDS: F, PERIODS, SORTS, REGULAR_VISITS, AT_RISK_WINDOW_MONTHS,
    byKey, cutoffDate, cutoffISO, defaultSort, describe, filter, normalizeMonths, options, sort, usesPeriod,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CUSTOMER_ACTIVITY;
