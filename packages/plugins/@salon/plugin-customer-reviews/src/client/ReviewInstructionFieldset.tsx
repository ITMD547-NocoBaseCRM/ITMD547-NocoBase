import React from 'react';

/** Settings drawer of the review node: nothing to configure, so it explains what the node does. */
export default function ReviewInstructionFieldset() {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      <p style={{ marginTop: 0 }}>This node has no settings. Use it after a collection event on <strong>Appointments</strong>: after update, changed field <strong>Status</strong>, condition Status = Completed.</p>
      <p>For the appointment in the trigger it checks that the appointment is completed, the customer has opted in to transactional email and has no active suppression, then creates one single-use link per technician (valid 7 days) and sends one email through the salon&apos;s Email channel.</p>
      <p style={{ marginBottom: 0 }}>Running it again for the same completion never sends a second email. Results (sent, skipped and why, failed) are visible on the appointment and in the execution history; review links are never stored there.</p>
    </div>
  );
}
