import { Plugin } from '@nocobase/server';
import { AvailabilityError, AvailabilityService } from './availability-service';

export class PluginAppointmentAvailabilityServer extends Plugin {
  private get availability() {
    // Plugin fields are initialized before NocoBase assigns the database handle.
    // Resolve it at request/lifecycle time instead of retaining an undefined handle.
    return new AvailabilityService(this.db);
  }

  async beforeLoad() {
    this.db.on('appointments.beforeCreate', async (model: any) => this.validateAppointment(model));
    this.db.on('appointments.beforeUpdate', async (model: any) => this.validateAppointment(model));
    this.db.on('staffAvailabilityLeaves.beforeCreate', async (model: any) => this.validateLeave(model));
    this.db.on('staffAvailabilityLeaves.beforeUpdate', async (model: any) => this.validateLeave(model));
    this.db.on('staffAvailabilityLeaves.afterCreate', async (model: any) => this.availability.applyLeaveToEmployeeShifts(model));
    this.db.on('staffAvailabilityLeaves.afterUpdate', async (model: any) => {
      await this.availability.clearLeaveProjection(model);
      await this.availability.applyLeaveToEmployeeShifts(model);
    });
    this.db.on('staffAvailabilityLeaves.afterDestroy', async (model: any) => this.availability.clearLeaveProjection(model));
    this.db.on('staffAvailabilityOverrides.beforeCreate', async (model: any) => this.validateOverride(model));
    this.db.on('staffAvailabilityOverrides.beforeUpdate', async (model: any) => this.validateOverride(model));
    this.db.on('staffAvailabilitySchedules.afterCreate', async (model: any, options: any) => {
      // Run after the insert commits: querying on a second pooled connection
      // while the create transaction still holds one exhausts the pool.
      const values = model.get ? model.get() : model;
      const project = async () => {
        try {
          await this.availability.projectScheduleToEmployeeShifts(model);
          await this.availability.applyExistingLeaves(values.staffId);
        } catch (error) {
          this.app.logger.error(error);
        }
      };
      if (options?.transaction?.afterCommit) options.transaction.afterCommit(project);
      else await project();
    });
    this.db.on('staffAvailabilitySchedules.afterUpdate', async (model: any) => {
      await this.availability.clearScheduleProjection(model);
      await this.availability.projectScheduleToEmployeeShifts(model);
    });
    this.db.on('staffAvailabilitySchedules.afterDestroy', async (model: any) => this.availability.clearScheduleProjection(model));
  }

  async load() {
    this.app.resourceManager.define({
      name: 'appointmentAvailability',
      actions: {
        slots: async (ctx: any, next: any) => {
          try {
            const values = ctx.action.params.values || ctx.action.params;
            if (!values.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(values.date || '')) ctx.throw(400, 'Staff and date are required.');
            ctx.body = await this.availability.slots(values);
          } catch (error) {
            this.respondAvailabilityError(ctx, error);
          }
          await next();
        },
        leaveConflicts: async (ctx: any, next: any) => {
          try {
            const values = ctx.action.params.values || ctx.action.params;
            if (!values.staffId || !values.startTime || !values.endTime) ctx.throw(400, 'Staff and leave period are required.');
            ctx.body = { appointments: await this.availability.leaveConflicts(values) };
          } catch (error) {
            this.respondAvailabilityError(ctx, error);
          }
          await next();
        },
        check: async (ctx: any, next: any) => {
          try {
            await this.availability.assertAvailable(ctx.action.params.values || ctx.action.params);
            ctx.body = { available: true };
          } catch (error) {
            this.respondAvailabilityError(ctx, error);
          }
          await next();
        },
      },
    });
    this.app.acl.allow('appointmentAvailability', ['slots', 'check', 'leaveConflicts'], 'loggedIn');
    for (const collection of ['staffAvailabilitySchedules', 'staffAvailabilityOverrides', 'staffAvailabilityLeaves', 'appointmentAvailabilitySettings']) {
      this.app.acl.allow(collection, '*', 'loggedIn');
    }
  }

  async install() {
    const repo = this.db.getRepository('appointmentAvailabilitySettings');
    if (!await repo.findOne({})) await repo.create({ values: { timeZone: 'America/Chicago', slotIntervalMinutes: 15, defaultDurationMinutes: 60 } });
  }

  async afterEnable() {
    await this.availability.projectExistingSchedules();
    await this.availability.applyExistingLeaves();
  }

  private async validateAppointment(model: any) {
    const values = model.get ? model.get() : model;
    if (!values.staffId || ['cancelled', 'noShow'].includes(values.status)) return;
    try {
      await this.availability.assertAvailable({
        staffId: values.staffId,
        startTime: values.startTime,
        endTime: values.endTime,
        excludeAppointmentId: values.id,
      });
    } catch (error) {
      if (error instanceof AvailabilityError) throw error;
      this.app.logger.error('Appointment availability validation failed', { error: error instanceof Error ? error.message : 'unknown error' });
      throw new AvailabilityError('Availability could not be verified. Please try again.');
    }
  }

  private async validateLeave(model: any) {
    const values = model.get ? model.get() : model;
    const start = new Date(values.startTime);
    const end = new Date(values.endTime);
    if (!values.staffId || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new AvailabilityError('Leave must have a valid start and end time.');
    await this.availability.assertNoAppointmentsWouldBeInvalidated(values.staffId, start, end, values.id);
  }

  private async validateOverride(model: any) {
    const values = model.get ? model.get() : model;
    if (!values.staffId || !values.date || values.isWorking) return;
    const { start, end } = await this.availability.businessDayRange(values.date);
    // A non-working override is an all-day leave. Reject it if it would strand an existing booking.
    await this.availability.assertNoAppointmentsWouldBeInvalidated(values.staffId, start, end, values.id);
  }

  private respondAvailabilityError(ctx: any, error: unknown) {
    if (error instanceof AvailabilityError) ctx.throw(409, error.message);
    this.app.logger.error('Availability request failed', { error: error instanceof Error ? error.message : 'unknown error' });
    ctx.throw(503, 'Availability is temporarily unavailable. Please retry.');
  }
}

export default PluginAppointmentAvailabilityServer;
