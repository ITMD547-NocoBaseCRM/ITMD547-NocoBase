import { Instruction, JOB_STATUS } from '@nocobase/plugin-workflow';
import { COMPLETED_STATUS, sanitizeError } from './core/policy';
import type { ReviewService } from './service';

/**
 * Workflow node "Send review invitations".
 *
 * Use it after a collection-event trigger on `appointments` (after update, changed field `status`, condition
 * status = completed). It reads the appointment from the trigger, and the plugin's ReviewService checks
 * eligibility and consent, creates the invitations and sends the email.
 *
 * Token safety: tokens are generated and emailed inside the service. The node's job result, which NocoBase
 * stores in the execution history, contains only safe metadata (status, delivery id, counts, skip reason).
 *
 * Idempotency: the key is the execution and node. Re-running or retrying this job never sends a second
 * email for the same completion; an interrupted send is finished instead.
 */
export class ReviewInvitationInstruction extends Instruction {
  private readonly reviews: () => ReviewService;

  constructor(workflow: any, reviews: () => ReviewService) {
    super(workflow);
    this.reviews = reviews;
  }

  async run(node: any, _input: any, processor: any) {
    const data = processor.execution?.context?.data || {};
    const appointmentId = data.id;
    if (appointmentId === undefined || appointmentId === null) {
      return { status: JOB_STATUS.RESOLVED, result: { status: 'skipped', reason: 'no_appointment', message: 'The trigger did not provide an appointment.' } };
    }
    if (data.status !== undefined && data.status !== COMPLETED_STATUS) {
      return { status: JOB_STATUS.RESOLVED, result: { status: 'skipped', reason: 'appointment_ineligible', message: 'The appointment is not completed.' } };
    }
    try {
      const outcome = await this.reviews().sendForAppointment({
        appointmentId,
        trigger: 'workflow',
        idempotencyKey: `workflow:${processor.execution.id}:${node.id}`,
      });
      processor.logger?.info?.(`review invitations (#${node.id}): ${outcome.status}`);
      return { status: outcome.status === 'failed' ? JOB_STATUS.FAILED : JOB_STATUS.RESOLVED, result: outcome };
    } catch (error) {
      const message = sanitizeError(error);
      processor.logger?.warn?.(`review invitations (#${node.id}) error: ${message}`);
      return { status: JOB_STATUS.ERROR, result: { status: 'error', message } };
    }
  }
}
