import { Plugin } from '@nocobase/server';
import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';

const appointmentCalendarColor = (status: string, staffId: unknown) => {
  if (status === 'cancelled') return 'cancelled';
  if (!staffId) return 'unassigned';
  return ['scheduled', 'confirmed', 'inProgress', 'completed', 'cancelled', 'noShow'].includes(status)
    ? status
    : 'scheduled';
};

const strikeThrough = (value: string) => [...value].map((character) => character.trim() ? `${character}\u0336` : character).join('');

export class PluginCrmServer extends Plugin {
  async afterAdd() {}

  async beforeLoad() {
    // Keep a month/day sort key (MMDD) so the customer list can be ordered by
    // upcoming birthday regardless of birth year.
    this.db.on('customers.beforeSave', (model: any) => {
      const dob = model.get('dateOfBirth');
      const match = typeof dob === 'string' ? dob.match(/^\d{4}-(\d{2})-(\d{2})/) : null;
      model.set('birthMonthDay', match ? Number(match[1] + match[2]) : null);
    });

    // A booked service starts from the service's own price and duration. Staff can still change
    // them per booking; they are only filled in when left blank.
    this.db.on('appointmentServices.beforeSave', async (model: any, options: any) => {
      const serviceId = model.get('serviceId');
      if (!serviceId) return;
      const missingPrice = model.get('priceAtBooking') == null;
      const missingDuration = model.get('durationAtBooking') == null;
      if (!missingPrice && !missingDuration) return;
      const service = await this.db.getRepository('services').findOne({ filterByTk: serviceId, transaction: options?.transaction });
      if (!service) return;
      if (missingPrice) model.set('priceAtBooking', service.get('price'));
      if (missingDuration) model.set('durationAtBooking', service.get('durationMinutes'));
    });

    // Build the calendar label before the appointment is persisted. A collection workflow also
    // maintains this field, but that runs after the create response; the calendar would briefly
    // render the new event as "N/A" until a manual refresh. Setting it here makes the first
    // response complete while keeping the label correct for later staff/customer changes.
    this.db.on('appointments.beforeSave', async (model: any, options: any) => {
      const customerId = model.get('customerId');
      const staffId = model.get('staffId');
      const transaction = options?.transaction;
      const [customer, staff] = await Promise.all([
        customerId
          ? this.db.getRepository('customers').findOne({ filterByTk: customerId, fields: ['firstName'], transaction })
          : null,
        staffId
          ? this.db.getRepository('staff').findOne({ filterByTk: staffId, fields: ['firstName'], transaction })
          : null,
      ]);
      const customerName = customer?.get('firstName')?.trim() || 'Customer';
      const staffName = staff?.get('firstName')?.trim() || 'Unassigned';
      const title = `${customerName} – ${staffName}`;
      model.set('calendarTitle', model.get('status') === 'cancelled' ? strikeThrough(title) : title);
      model.set('calendarColor', appointmentCalendarColor(model.get('status'), staffId));
    });

    // Visits = completed appointments. Recount after the appointment commits so
    // we never query on a second pooled connection inside its transaction.
    const recount = (customerId: any, options: any) => {
      if (!customerId) return;
      const run = async () => {
        try {
          const count = await this.db.getRepository('appointments').count({ filter: { customerId, status: 'completed' } });
          await this.db.getRepository('customers').update({ filterByTk: customerId, values: { visitCount: count }, hooks: false });
        } catch (error) {
          this.app.logger.error(error);
        }
      };
      if (options?.transaction?.afterCommit) options.transaction.afterCommit(run);
      else run();
    };
    this.db.on('appointments.afterSave', (model: any, options: any) => {
      recount(model.get('customerId'), options);
      const previous = model.previous?.('customerId');
      if (previous && String(previous) !== String(model.get('customerId'))) recount(previous, options);
    });
    this.db.on('appointments.afterDestroy', (model: any, options: any) => recount(model.get('customerId'), options));

    // ─── Appointment reminders ─────────────────────────────────────────────────
    // Manages the appointmentReminders rows that the scheduled "Process appointment
    // reminders" workflow picks up every 15 minutes. When an appointment is created
    // or rescheduled, one reminder row is created per enabled interval (1h, 2h, 12h,
    // 24h, 48h). When an appointment is cancelled, noShow, or deleted, all pending
    // reminders for it are cancelled. All work runs after the transaction commits so
    // it never blocks the save and gracefully no-ops when the collection doesn't exist
    // yet (apply-appointment-reminders not run).

    const INTERVAL_HOURS: Record<string, number> = { '1h': 1, '2h': 2, '12h': 12, '24h': 24, '48h': 48 };

    const remindersReady = () => {
      try { return !!this.db.getRepository('appointmentReminders') && !!this.db.getRepository('appointmentReminderSettings'); }
      catch { return false; }
    };

    const cancelReminders = (appointmentId: any, options: any) => {
      if (!appointmentId) return;
      const run = async () => {
        try {
          if (!remindersReady()) return;
          await this.db.getRepository('appointmentReminders').update({
            filter: { appointmentId, status: 'pending' },
            values: { status: 'cancelled' },
            hooks: false,
          });
        } catch (error: any) {
          if (!String(error?.message).includes('does not exist') && !String(error?.message).includes('no such table')) {
            this.app.logger.error('[appointment-reminders] cancel failed', error);
          }
        }
      };
      if (options?.transaction?.afterCommit) options.transaction.afterCommit(run);
      else run();
    };

    const ensureReminders = (model: any, options: any) => {
      const status = model.get('status');
      const appointmentId = model.get('id');
      const customerId = model.get('customerId');
      const startTime = model.get('startTime');

      // Cancel path: cancelled / noShow
      if (status === 'cancelled' || status === 'noShow') {
        cancelReminders(appointmentId, options);
        return;
      }

      // Create path: only for scheduled / confirmed with a startTime
      if (!['scheduled', 'confirmed'].includes(status) || !startTime || !appointmentId || !customerId) return;

      const run = async () => {
        try {
          if (!remindersReady()) return;
          const settingsRepo = this.db.getRepository('appointmentReminderSettings');
          const settings = await settingsRepo.findOne({ sort: ['id'] });
          if (!settings?.get('enabled')) return;
          const intervals: string[] = settings.get('enabledIntervals') || [];
          if (!intervals.length) return;

          const repo = this.db.getRepository('appointmentReminders');
          const start = new Date(startTime).getTime();
          const now = Date.now();

          for (const key of intervals) {
            const hours = INTERVAL_HOURS[key];
            if (!hours) continue;
            const scheduledFor = new Date(start - hours * 60 * 60 * 1000);
            if (scheduledFor.getTime() <= now) continue; // already past

            const existing = await repo.findOne({ filter: { appointmentId, intervalKey: key } });
            if (existing) {
              // Update scheduledFor if appointment time changed and reminder is still pending.
              if (existing.get('status') === 'pending' && new Date(existing.get('scheduledFor')).getTime() !== scheduledFor.getTime()) {
                await repo.update({ filterByTk: existing.get('id'), values: { scheduledFor }, hooks: false });
              }
            } else {
              await repo.create({ values: { appointmentId, customerId, intervalKey: key, scheduledFor, status: 'pending' }, hooks: false });
            }
          }

          // Cancel reminders for intervals that were disabled since the appointment was created.
          const enabledSet = new Set(intervals);
          const allReminders = await repo.find({ filter: { appointmentId, status: 'pending' } });
          for (const r of allReminders) {
            if (!enabledSet.has(r.get('intervalKey'))) {
              await repo.update({ filterByTk: r.get('id'), values: { status: 'cancelled' }, hooks: false });
            }
          }
        } catch (error: any) {
          if (!String(error?.message).includes('does not exist') && !String(error?.message).includes('no such table')) {
            this.app.logger.error('[appointment-reminders] ensure failed', error);
          }
        }
      };
      if (options?.transaction?.afterCommit) options.transaction.afterCommit(run);
      else run();
    };

    // ─── Instant confirmation email on new appointment ────────────────────────
    // When a new appointment is created (not updated), immediately queue a
    // confirmation email through the customerMessages pipeline. Uses the
    // confirmation template from appointmentReminderSettings, with the same
    // {{firstName}}, {{staffName}}, {{appointmentDate}}, {{appointmentTime}}
    // variables as reminders.

    const DEFAULT_CONFIRMATION_SUBJECT = 'Your appointment has been scheduled!';
    const DEFAULT_CONFIRMATION_BODY = [
      '<p>Hi {{firstName}},</p>',
      '<p>Your appointment with <strong>{{staffName}}</strong> has been scheduled for <strong>{{appointmentTime}}</strong> on <strong>{{appointmentDate}}</strong>.</p>',
      '<p>If you need to make any changes, please don\'t hesitate to contact us.</p>',
      '<p>We look forward to seeing you!</p>',
    ].join('\n');
    const EMAIL_ENVELOPE = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:640px">';

    const replaceTemplateVars = (template: string, vars: Record<string, string>) =>
      Object.entries(vars).reduce((t, [k, v]) => t.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v), template);

    const sendConfirmationEmail = (model: any, options: any) => {
      const status = model.get('status');
      if (!['scheduled', 'confirmed'].includes(status)) return;
      const customerId = model.get('customerId');
      const staffId = model.get('staffId');
      const startTime = model.get('startTime');
      if (!customerId || !startTime) return;

      const run = async () => {
        try {
          // Check that the messaging collection exists.
          let msgRepo: any;
          try { msgRepo = this.db.getRepository('customerMessages'); } catch { return; }
          if (!msgRepo) return;

          // Read settings (confirmation may be disabled).
          let confirmationEnabled = true;
          let subjectTpl = DEFAULT_CONFIRMATION_SUBJECT;
          let bodyTpl = DEFAULT_CONFIRMATION_BODY;
          try {
            const settingsRepo = this.db.getRepository('appointmentReminderSettings');
            if (settingsRepo) {
              const settings = await settingsRepo.findOne({ sort: ['id'] });
              if (settings) {
                if (settings.get('confirmationEnabled') === false) return;
                subjectTpl = settings.get('confirmationSubject') || subjectTpl;
                bodyTpl = settings.get('confirmationBody') || bodyTpl;
              }
            }
          } catch { /* settings collection may not exist yet; use defaults */ }

          // Look up customer email and staff name.
          const [customer, staff] = await Promise.all([
            this.db.getRepository('customers').findOne({ filterByTk: customerId, fields: ['firstName', 'lastName', 'email'] }),
            staffId
              ? this.db.getRepository('staff').findOne({ filterByTk: staffId, fields: ['firstName'] })
              : null,
          ]);
          const email = customer?.get('email');
          if (!email) return; // no email on file — skip silently

          const apptDate = new Date(startTime);
          const vars: Record<string, string> = {
            firstName: customer?.get('firstName')?.trim() || '',
            lastName: customer?.get('lastName')?.trim() || '',
            staffName: staff?.get('firstName')?.trim() || 'your stylist',
            appointmentDate: apptDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
            appointmentTime: apptDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          };

          const subject = replaceTemplateVars(subjectTpl, vars);
          const body = replaceTemplateVars(bodyTpl, vars);

          const htmlBody = `${EMAIL_ENVELOPE}${body}</div>`;

          // Send immediately via the notification manager.
          let sendStatus = 'queued';
          let sendError: string | null = null;
          try {
            const notifPlugin: any = this.app.pm.get('notification-manager');
            const manager = notifPlugin?.manager;
            const channelRec = await this.db.getRepository('notificationChannels').findOne({ filter: { notificationType: 'email' } });
            const channelName = channelRec?.get('name');
            if (manager && channelName) {
              await manager.send({
                channelName,
                message: { subject, html: htmlBody, contentType: 'html', to: [email] },
                triggerFrom: 'appointmentConfirmation',
              });
              sendStatus = 'sent';
              this.app.logger.info('[appointment-confirmation] sent to %s for customer %s', email, customerId);
            }
          } catch (sendErr: any) {
            sendError = sendErr?.reason || sendErr?.message || 'send failed';
            sendStatus = 'failed';
            this.app.logger.error('[appointment-confirmation] send failed for customer %s: %s', customerId, sendError);
          }

          // Record in customerMessages for audit trail.
          await msgRepo.create({
            values: {
              channel: 'email',
              recipient: email,
              subject,
              body,
              bodyHtml: htmlBody,
              status: sendStatus,
              sentAt: sendStatus === 'sent' ? new Date() : null,
              error: sendError,
              customerId,
            },
            hooks: false,
          });
        } catch (error: any) {
          if (!String(error?.message).includes('does not exist') && !String(error?.message).includes('no such table')) {
            this.app.logger.error('[appointment-confirmation] failed', error);
          }
        }
      };
      if (options?.transaction?.afterCommit) options.transaction.afterCommit(run);
      else run();
    };

    this.db.on('appointments.afterSave', (model: any, options: any) => {
      ensureReminders(model, options);
    });
    this.db.on('appointments.afterCreate', (model: any, options: any) => {
      sendConfirmationEmail(model, options);
    });
    this.db.on('appointments.afterDestroy', (model: any, options: any) => {
      cancelReminders(model.get('id'), options);
    });
  }

  async load() {
    // ─── Periodic email sender ──────────────────────────────────────────────────
    // Processes queued customerMessages (channel='email') every 2 minutes.
    // The scheduled reminder workflow inserts rows via raw SQL which bypasses
    // collection events, so the "Deliver customer messages" workflow never fires
    // for those. This timer acts as the delivery fallback for all queued emails.
    const processQueuedEmails = async () => {
      try {
        const msgRepo = this.db.getRepository('customerMessages');
        if (!msgRepo) return;
        const queued = await msgRepo.find({
          filter: { status: 'queued', channel: 'email' },
          limit: 20,
          sort: ['createdAt'],
        });
        if (!queued.length) return;

        const notifPlugin: any = this.app.pm.get('notification-manager');
        const manager = notifPlugin?.manager;
        if (!manager) {
          this.app.logger.warn('[email-sender] notification-manager plugin not available');
          return;
        }

        for (const msg of queued) {
          const id = msg.get('id');
          const recipient = msg.get('recipient');
          const subject = msg.get('subject');
          const bodyHtml = msg.get('bodyHtml') || msg.get('body');
          if (!recipient) {
            await msgRepo.update({ filterByTk: id, values: { status: 'failed', error: 'No recipient' }, hooks: false });
            continue;
          }
          try {
            const channelName = (await this.db.getRepository('notificationChannels').findOne({
              filter: { notificationType: 'email' },
            }))?.get('name');
            if (!channelName) {
              this.app.logger.warn('[email-sender] no email notification channel configured');
              return;
            }
            await manager.send({
              channelName,
              message: { subject, html: bodyHtml, contentType: 'html', to: [recipient] },
              triggerFrom: 'crmEmailSender',
            });
            await msgRepo.update({ filterByTk: id, values: { status: 'sent', sentAt: new Date(), error: null }, hooks: false });
            this.app.logger.info('[email-sender] sent to %s (msg %s)', recipient, id);
          } catch (err: any) {
            const reason = err?.reason || err?.message || 'unknown';
            await msgRepo.update({ filterByTk: id, values: { status: 'failed', error: reason }, hooks: false });
            this.app.logger.error('[email-sender] failed for msg %s: %s', id, reason);
          }
        }
      } catch (err: any) {
        if (!String(err?.message).includes('does not exist')) {
          this.app.logger.error('[email-sender] processing error', err);
        }
      }
    };
    // Run once shortly after startup, then every 2 minutes
    setTimeout(() => processQueuedEmails(), 15_000);
    setInterval(() => processQueuedEmails(), 2 * 60 * 1000);

    this.app.resourceManager.define({
      name: 'salonMobileDashboard',
      actions: {
        get: async (ctx: any) => {
          const dashboardPath = path.resolve(process.cwd(), 'scripts', 'ui', 'salon-mobile-dashboard.html');
          ctx.withoutDataWrapping = true;
          ctx.type = 'text/html; charset=utf-8';
          ctx.set('Cache-Control', 'no-store');
          ctx.body = fs.readFileSync(dashboardPath, 'utf8');
        },
      },
    });
    // The endpoint only serves the static dashboard shell. Its business-data requests still use
    // the signed-in user's bearer token and normal collection ACL.
    this.app.acl.allow('salonMobileDashboard', 'get', 'public');

    const server = process.env.AZURE_SQL_SERVER;
    const database = process.env.AZURE_SQL_DATABASE;
    const user = process.env.AZURE_SQL_USER;
    const password = process.env.AZURE_SQL_PASSWORD;
    if (!server || !database || !user || !password) {
      this.app.logger.info('CRM Azure SQL connector is not configured; skipping connection.');
      return;
    }
    try {
      const pool = await sql.connect({
        server,
        database,
        user,
        password,
        port: Number(process.env.AZURE_SQL_PORT || 1433),
        options: {
          encrypt: true,
          trustServerCertificate: false,
        },
      });

      const result = await pool.request().query('SELECT 1 AS connected');

      this.app.logger.info('CRM Azure SQL connection verified.', { rows: result.recordset.length });
    } catch (error) {
      this.app.logger.warn('CRM Azure SQL connection failed.', { error: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  async install() {}

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginCrmServer;
