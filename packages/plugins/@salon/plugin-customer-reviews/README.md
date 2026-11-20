# @salon/plugin-customer-reviews

T-05 for the BeautyWithin CRM: secure, single-use customer review invitations after completed appointments, a public
review page (`/review#t=<token>`), review moderation, and the data behind Statistics → Staff Performance →
Client Review Scores.

Full documentation (data model, delivery policy, workflow, security, how-to): [`docs/customer-reviews.md`](../../../../docs/customer-reviews.md).

```bash
yarn install
yarn pm enable @salon/plugin-customer-reviews
yarn dev                      # or yarn start
yarn apply:customer-reviews   # workflow, appointment panel, Customer Reviews page, Staff Performance section
yarn test:customer-reviews    # unit + UI script tests (no database needed)
```

Environment (optional): `REVIEW_PUBLIC_BASE_URL` (https in production; default `http://localhost:$APP_PORT`),
`REVIEW_EMAIL_CHANNEL` (Email channel name or title when there are several). Token hashes are keyed with `APP_KEY`.

| Path | Purpose |
| --- | --- |
| `src/server/collections/` | `customer_reviews`, `customer_review_invitations`, `customer_review_deliveries`, `customer_review_moderation_events` |
| `src/server/core/` | Pure logic: tokens, eligibility and email policy, email rendering, score aggregation, rate limiting (unit-tested) |
| `src/server/service.ts` | Invitation creation, outbox delivery, resend/revoke/regenerate/manual link, public inspect/submit, moderation, scores |
| `src/server/mailer.ts` | Sends through the configured NocoBase Email channel's transport without logging the message |
| `src/server/instruction.ts` | Workflow node "Send review invitations" |
| `src/server/plugin.ts` | Resources, ACL guard and snippet `pm.customer-reviews`, model hooks, table creation on start |
| `src/client`, `src/client-v2` | Public `/review` route, workflow node registration |
