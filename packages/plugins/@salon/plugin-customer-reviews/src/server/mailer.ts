import PluginNotificationManagerServer from '@nocobase/plugin-notification-manager';
import type { Application } from '@nocobase/server';

/**
 * Sends review emails through the salon's configured NocoBase Email notification channel (the same SMTP
 * account and sender identity the CRM already uses), but without going through NotificationManager.send():
 * that path stores the full message in `notificationSendLogs` and queues it on the event queue, which would
 * persist the plaintext review tokens. Here the channel's own pooled nodemailer transport is used directly,
 * and nothing about the message body is logged or stored.
 *
 * Channel selection: REVIEW_EMAIL_CHANNEL (channel name or title) if set, otherwise the first channel whose
 * type is `email`.
 */
export class ReviewMailer {
  private readonly app: Application;

  constructor(app: Application) {
    this.app = app;
  }

  private get notification(): any {
    return this.app.pm.get(PluginNotificationManagerServer as any) as any;
  }

  async findChannel(): Promise<{ name: string; title: string; options: Record<string, any>; notificationType: string } | null> {
    const wanted = (process.env.REVIEW_EMAIL_CHANNEL || '').trim();
    const repo = this.app.db.getRepository('notificationChannels');
    if (!repo) return null;
    const rows = await repo.find({ filter: { notificationType: 'email' }, sort: ['createdAt'] });
    const row = wanted ? rows.find((r: any) => r.get('name') === wanted || r.get('title') === wanted) : rows[0];
    if (!row) return null;
    const channel = this.notification?.getChannel ? await this.notification.getChannel(row.get('name')) : null;
    const value = channel || row.toJSON();
    return { name: value.name, title: value.title, options: value.options || {}, notificationType: value.notificationType };
  }

  /** Throws a short, token-free error when no usable channel is configured. */
  async send(message: { to: string; subject: string; text: string; html: string; messageId: string; entityRef: string }) {
    const channel = await this.findChannel();
    if (!channel) throw new Error('No Email notification channel is configured (Settings > Notification manager > Channels).');
    const { host, account, password, from } = channel.options;
    if (!host || !account || !password) throw new Error(`Email channel "${channel.title || channel.name}" is missing SMTP host, account or password.`);
    const type = this.notification?.channelTypes?.get?.('email');
    const Channel = type && type.Channel;
    if (!Channel) throw new Error('The Email notification channel plugin (@nocobase/plugin-notification-email) is not enabled.');
    const instance: any = new Channel(this.app);
    if (typeof instance.getTransporter !== 'function') throw new Error('The installed Email channel does not expose its mail transport.');
    const transporter = instance.getTransporter(channel);
    const info: any = await withTimeout(
      transporter.sendMail({
        from: from || account,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        // Stable per delivery attempt; lets mail servers and clients recognise a resubmitted copy.
        messageId: message.messageId,
        // SMTP has no provider-side idempotency key; X-Entity-Ref-ID stops Gmail threading unrelated sends.
        headers: { 'X-Entity-Ref-ID': message.entityRef, 'Auto-Submitted': 'auto-generated' },
      }),
      60000,
      'The SMTP server did not answer within 60 seconds.',
    );
    return { messageId: (info && info.messageId) || message.messageId, channelName: channel.name };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: any;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
