// Definitions for T-05 customer reviews, shared by scripts/apply-customer-reviews.js and its tests.
// Pure: no network, no NocoBase. The server side lives in packages/plugins/@salon/plugin-customer-reviews.

const fs = require('fs');
const path = require('path');

const PLUGIN_PACKAGE = '@salon/plugin-customer-reviews';
const REVIEW_WORKFLOW_TITLE = 'Customer reviews: invite after completed appointment';
const REVIEW_NODE_TYPE = 'customerReviewInvitations';
const REVIEW_NODE_TITLE = 'Send review invitations';
const REVIEWS_PAGE_TITLE = 'Customer Reviews';
const MENU_GROUP_TITLE = 'Beauty Within Portal';
const PANEL_TITLE = 'Review invitations';
const PANEL_MARKER = 'BW-REVIEWS appointment-panel';
const ADMIN_MARKER = 'BW-REVIEWS admin-page';

const UI_DIR = path.join(__dirname, 'ui');
const readUi = (file) => fs.readFileSync(path.join(UI_DIR, file), 'utf8');

/**
 * Collection event on appointments: after update, only when `status` changed, only when the new status is
 * `completed`. Editing an already-completed appointment (status unchanged) does not trigger it; creating an
 * appointment directly as completed (imports) does not either. Asynchronous, so saving the appointment never
 * waits for SMTP.
 */
function reviewWorkflowDefinition() {
  return {
    title: REVIEW_WORKFLOW_TITLE,
    type: 'collection',
    sync: false,
    description:
      'T-05. When an appointment changes to Completed, emails the customer single-use review links for its technicians ' +
      '(if they opted in to transactional email). Created by yarn apply:customer-reviews.',
    config: {
      collection: 'appointments',
      mode: 2,
      changed: ['status'],
      condition: { $and: [{ status: { $eq: 'completed' } }] },
      appends: [],
    },
  };
}

function reviewWorkflowNode() {
  return { type: REVIEW_NODE_TYPE, title: REVIEW_NODE_TITLE, config: {} };
}

// ------------------------------------------------------------------ Statistics → Staff Performance patch

const SECTION_BEGIN = '/* BW-REVIEWS:BEGIN';
const SECTION_END = '/* BW-REVIEWS:END */';
const STAFF_VIEW_MARKER = /const BW_VIEW = 'staff';/;
const DEFINITION_ANCHOR = 'function StaffPerformance(';
const CALL_ANCHOR = 'h(Card, null, selector), body,';
const SECTION_CALL =
  'h(Card, null, selector), body, h(BwReviewScores, { inst, who, staff: ref ? ref.staff : [], ' +
  'techs: (calc && calc.techs) || (ref ? bwTechnicians(ref.staff, []) : []), rangeText, oneCol, reload }),';

const count = (haystack, needle) => haystack.split(needle).length - 1;

function stripSection(code) {
  const start = code.indexOf(SECTION_BEGIN);
  if (start < 0) return code;
  const end = code.indexOf(SECTION_END, start);
  if (end < 0) throw new Error('Found the start of the review section but not its end marker; refusing to edit the block.');
  let after = end + SECTION_END.length;
  if (code[after] === '\n') after += 1;
  return code.slice(0, start) + code.slice(after);
}

/**
 * Adds the Client Review Scores section to the Staff Performance block's code. Idempotent: an existing section is
 * replaced by the current one and the render call is added only once. Nothing else in the block changes.
 */
function patchStatisticsCode(code, section = readUi('staff-review-scores.js')) {
  if (typeof code !== 'string' || !STAFF_VIEW_MARKER.test(code)) throw new Error("Not the Staff Performance statistics block (const BW_VIEW = 'staff' not found).");
  if (!section.startsWith(SECTION_BEGIN) || !section.trimEnd().endsWith(SECTION_END)) throw new Error('Section script must start and end with the BW-REVIEWS markers.');
  let next = stripSection(code);
  if (count(next, DEFINITION_ANCHOR) !== 1) throw new Error(`Expected exactly one "${DEFINITION_ANCHOR}" in the block.`);
  next = next.replace(DEFINITION_ANCHOR, `${section.trimEnd()}\n${DEFINITION_ANCHOR}`);
  if (!next.includes(SECTION_CALL)) {
    if (count(next, CALL_ANCHOR) !== 1) throw new Error(`Expected exactly one "${CALL_ANCHOR}" in StaffPerformance.`);
    next = next.replace(CALL_ANCHOR, SECTION_CALL);
  }
  return { code: next, changed: next !== code };
}

/** Removes the section and its render call: restores the block's original behaviour. */
function unpatchStatisticsCode(code) {
  const next = stripSection(code).replace(SECTION_CALL, CALL_ANCHOR);
  return { code: next, changed: next !== code };
}

module.exports = {
  ADMIN_MARKER,
  CALL_ANCHOR,
  MENU_GROUP_TITLE,
  PANEL_MARKER,
  PANEL_TITLE,
  PLUGIN_PACKAGE,
  REVIEWS_PAGE_TITLE,
  REVIEW_NODE_TITLE,
  REVIEW_NODE_TYPE,
  REVIEW_WORKFLOW_TITLE,
  SECTION_BEGIN,
  SECTION_CALL,
  SECTION_END,
  patchStatisticsCode,
  readUi,
  reviewWorkflowDefinition,
  reviewWorkflowNode,
  unpatchStatisticsCode,
};
