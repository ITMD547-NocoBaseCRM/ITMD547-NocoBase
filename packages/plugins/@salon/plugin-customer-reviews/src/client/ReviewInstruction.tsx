import { Instruction } from '@nocobase/plugin-workflow/client';
import { INSTRUCTION_TYPE } from '../constants';

/**
 * Workflow editor entry for the "Send review invitations" node. It has no settings: the server reads the
 * appointment from the trigger and applies the review eligibility and email policy (see docs/customer-reviews.md).
 */
export class ReviewInvitationInstruction extends Instruction {
  title = 'Send review invitations';
  type = INSTRUCTION_TYPE;
  group = 'extended';
  description =
    'Emails the customer secure, single-use review links for the technicians of the completed appointment from the trigger. ' +
    'Skips customers without transactional email consent. Tokens never appear in the execution history.';
  fieldset = {};
  FieldsetLoader = () => import('./ReviewInstructionFieldset');
}

export default ReviewInvitationInstruction;
