# MVP launch checklist

- [ ] Create the separate Supabase project and apply the migration.
- [ ] Run Supabase database advisors after migration; resolve security/performance findings.
- [ ] Configure production Auth URLs, Google OAuth, SMTP, and email templates.
- [ ] Add Composio auth configs and verify all 13 curated connection flows and exact tool slugs.
- [ ] Add OpenAI keys and run one real text and image workflow.
- [ ] Create four Stripe prices, configure the webhook, and test checkout, upgrade, cancellation, and portal flows in test mode.
- [ ] Set a 32+ character `CRON_SECRET`; choose Vercel cron or the VM worker, not both.
- [ ] Set Resend sender-domain authentication and test approval/failure delivery.
- [ ] Exercise Free, Pro, and Team limits; confirm log retention cleanup jobs.
- [ ] Rotate webhook keys after any exposure and verify tenant isolation with two accounts.
- [ ] Add monitoring for failed runs, cron silence, webhook 5xx rates, and Stripe webhook failures.
- [ ] Replace draft legal copy with reviewed company details before public signup.
