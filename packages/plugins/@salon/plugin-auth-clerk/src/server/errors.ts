/**
 * `status`, `code` and `message` are safe to show the user. `reason` is for the server log only and
 * must never contain a token.
 */
export class ClerkAuthError extends Error {
  constructor(public status: number, public code: string, message: string, public reason?: string) {
    super(message);
    this.name = 'ClerkAuthError';
  }
}
