import { Plugin } from '@nocobase/server';
import { AvailabilityError, AvailabilityService } from './availability-service';

export class PluginAppointmentAvailabilityServer extends Plugin {
  private get availability() {
    // Plugin fields are initialized before NocoBase assigns the database handle.
    // Resolve it at request/lifecycle time instead of retaining an undefined handle.
    return new AvailabilityService(this.db);
  }

  async beforeLoad() {
    this.db.on('appointments.beforeCreate', async (model: any, options: any) => this.validateAppointment(model, options));
    this.db.on('appointments.beforeUpdate', async (model: any, options: any) => this.validateAppointment(model, options));
    // The calendar paints a newly created/updated event from the mutation response before it
    // performs another list request. Populate its title before persistence so that first paint
    // contains the staff name instead of the calendar renderer's "N/A" fallback.
    this.db.on('employeeShifts.beforeSave', async (model: any, options: any) => {
      const staffId = model.get?.('staffId');
      if (!staffId) return;
      const staff = await this.db.getRepository('staff').findOne({
        filterByTk: staffId,
        fields: ['firstName', 'lastName'],
        transaction: options?.transaction,
      });
      const staffName = [staff?.get('firstName'), staff?.get('lastName')].filter(Boolean).join(' ').trim();
      if (!staffName) return;
      model.set('calendarTitle', model.get?.('status') === 'onLeave' ? `On leave — ${staffName}` : staffName);
    });
    this.db.on('employeeShifts.beforeUpdate', async (model: any, options: any) => {
      const values = model.get ? model.get() : model;
      const changed = ['staffId', 'startTime', 'endTime', 'status'].some((field) => model.changed?.(field));
      if (!changed) return;
      const previous = { ...values };
      for (const field of ['staffId', 'startTime', 'endTime', 'status']) if (model.changed?.(field)) previous[field] = model.previous(field);
      const service = new AvailabilityService(this.db, options?.transaction);
      await service.lockStaff([previous.staffId, values.staffId]);
      await service.assertShiftChange(values, previous);
    });
    this.db.on('employeeShifts.beforeDestroy', async (model: any, options: any) => {
      const values = model.get ? model.get() : model;
      const service = new AvailabilityService(this.db, options?.transaction);
      await service.lockStaff([values.staffId]);
      await service.assertShiftChange(null, values, true);
    });
    this.db.on('employeeShifts.beforeBulkDestroy', async (options: any) => {
      const rows = await this.db.getModel('employeeShifts').findAll({ where: options.where, transaction: options.transaction });
      const removedIds = rows.map((row: any) => row.get('id'));
      const service = new AvailabilityService(this.db, options.transaction);
      await service.lockStaff(rows.map((row: any) => row.get('staffId')));
      for (const row of rows) await service.assertShiftChange(null, row.get({ plain: true }), true, removedIds);
    });
    this.db.on('staff.beforeUpdate', async (model: any, options: any) => {
      if (model.changed?.('active')) {
        const values = model.get ? model.get() : model;
        const service = new AvailabilityService(this.db, options?.transaction);
        await service.lockStaff([values.id]);
        await service.assertStaffChange(values);
      }
    });
    this.db.on('staffAvailabilityLeaves.beforeCreate', async (model: any, options: any) => this.validateLeave(model, options));
    this.db.on('staffAvailabilityLeaves.beforeUpdate', async (model: any, options: any) => this.validateLeave(model, options));
    this.db.on('staffAvailabilityLeaves.afterCreate', async (model: any, options: any) => new AvailabilityService(this.db, options?.transaction).applyLeaveToEmployeeShifts(model));
    this.db.on('staffAvailabilityLeaves.afterUpdate', async (model: any, options: any) => {
      const service = new AvailabilityService(this.db, options?.transaction);
      await service.clearLeaveProjection(model);
      await service.applyLeaveToEmployeeShifts(model);
    });
    this.db.on('staffAvailabilityLeaves.afterDestroy', async (model: any, options: any) => new AvailabilityService(this.db, options?.transaction).clearLeaveProjection(model));
    this.db.on('staffAvailabilityOverrides.beforeCreate', async (model: any, options: any) => this.validateOverride(model, options));
    this.db.on('staffAvailabilityOverrides.beforeUpdate', async (model: any, options: any) => this.validateOverride(model, options));
    this.db.on('staffAvailabilityOverrides.beforeDestroy', async (model: any, options: any) => {
      const values = model.get ? model.get() : model;
      const service = new AvailabilityService(this.db, options?.transaction);
      await service.lockStaff([values.staffId]);
      await service.assertOverrideChange(null, values, true);
    });
    this.db.on('staffAvailabilityOverrides.beforeBulkDestroy', async (options: any) => {
      const rows = await this.db.getModel('staffAvailabilityOverrides').findAll({ where: options.where, transaction: options.transaction });
      const removedIds = rows.map((row: any) => row.get('id'));
      const service = new AvailabilityService(this.db, options.transaction);
      await service.lockStaff(rows.map((row: any) => row.get('staffId')));
      for (const row of rows) await service.assertOverrideChange(null, row.get({ plain: true }), true, removedIds);
    });
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
    this.db.on('staffAvailabilitySchedules.afterUpdate', async (model: any, options: any) => {
      const service = new AvailabilityService(this.db, options?.transaction);
      const values = model.get ? model.get() : model;
      await service.lockStaff([values.staffId, model.previous?.('staffId')]);
      await service.reconcileScheduleProjection(model);
    });
    this.db.on('staffAvailabilitySchedules.afterDestroy', async (model: any, options: any) => new AvailabilityService(this.db, options?.transaction).clearScheduleProjection(model));
  }

  async load() {
    // Native request-interception workflows run after parseVariables. Check saved
    // leave first, after ACL, so their generic "another shift" toast cannot mask it.
    this.app.resourceManager.use(async (ctx: any, next: any) => {
      const action = ctx.action;
      if (action?.resourceName === 'employeeShifts'
        && ['create', 'update'].includes(action.actionName)
        && (!ctx.dataSource || ctx.dataSource.name === 'main')) {
        try {
          const conflicts = await this.validateShiftRequest(action, ctx.get?.('x-availability-leave-override') === 'true');
          if (conflicts.length) {
            const values = action.params.values || (action.params.values = {});
            const notes = String(values.notes || '').trim();
            const markers = [...new Set(conflicts.flatMap((conflict) => conflict.leaveIds))]
              .map((id) => `[Leave override ${id}]`)
              .filter((marker) => !notes.includes(marker));
            if (markers.length) values.notes = [notes, ...markers].filter(Boolean).join(' ');
          }
        } catch (error) {
          this.respondAvailabilityError(ctx, error);
        }
      }
      await next();
    }, { tag: 'appointmentAvailabilityShiftLeave', after: 'acl', before: 'parseVariables' });
    this.app.resourceManager.define({
      name: 'appointmentAvailability',
      actions: {
        availableStaff: async (ctx: any, next: any) => {
          try {
            ctx.body = await this.availability.availableStaff(ctx.action.params.values || ctx.action.params);
          } catch (error) {
            this.respondAvailabilityError(ctx, error);
          }
          await next();
        },
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
        shiftLeaveConflict: async (ctx: any, next: any) => {
          try {
            const values = ctx.action.params.values || ctx.action.params;
            const conflict = await this.availability.shiftLeaveConflict(this.normalizedShift(values));
            ctx.body = { conflict };
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
    this.app.acl.allow('appointmentAvailability', ['slots', 'check', 'leaveConflicts', 'shiftLeaveConflict', 'availableStaff'], 'loggedIn');
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

  private async validateAppointment(model: any, options?: any) {
    const values = model.get ? model.get() : model;
    const isExisting = values.id != null;
    const reactivated = model.changed?.('status') && ['cancelled', 'noShow'].includes(model.previous?.('status')) && !['cancelled', 'noShow'].includes(values.status);
    const schedulingChanged = !isExisting || reactivated || ['staffId', 'startTime', 'endTime'].some((field) => model.changed?.(field));
    if (!schedulingChanged) return;
    if (!values.staffId || ['cancelled', 'noShow'].includes(values.status)) return;
    try {
      const service = new AvailabilityService(this.db, options?.transaction);
      await service.lockStaff([values.staffId, model.previous?.('staffId')]);
      await service.assertAvailable({
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

  private normalizedShift(values: any, previous: any = {}) {
    const shift = { ...previous, ...values };
    if (Object.prototype.hasOwnProperty.call(values, 'staff')) {
      shift.staffId = values.staff && typeof values.staff === 'object' ? values.staff.id : values.staff;
    }
    return shift;
  }

  private async validateShiftRequest(action: any, allowLeaveOverride = false) {
    const { values = {}, filterByTk, filter } = action.params || {};
    const fields = ['staffId', 'staff', 'startTime', 'endTime', 'status'];
    if (action.actionName === 'update' && !fields.some((field) => Object.prototype.hasOwnProperty.call(values, field))) return [];
    const previous = action.actionName === 'create' ? [{}] : await this.db.getRepository('employeeShifts').find({
      ...(filterByTk != null ? { filterByTk } : {}), ...(filter ? { filter } : {}),
    });
    const conflicts = [];
    for (const row of previous) {
      const shift = this.normalizedShift(values, row.get ? row.get({ plain: true }) : row);
      const conflict = await this.availability.shiftLeaveConflict(shift);
      if (conflict) {
        if (!allowLeaveOverride) throw new AvailabilityError(conflict.message);
        conflicts.push(conflict);
      }
    }
    return conflicts;
  }

  private async validateLeave(model: any, options?: any) {
    const values = model.get ? model.get() : model;
    const start = new Date(values.startTime);
    const end = new Date(values.endTime);
    if (!values.staffId || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new AvailabilityError('Leave must have a valid start and end time.');
    const service = new AvailabilityService(this.db, options?.transaction);
    await service.lockStaff([values.staffId, model.previous?.('staffId')]);
    await service.assertNoAppointmentsWouldBeInvalidated(values.staffId, start, end);
  }

  private async validateOverride(model: any, options?: any) {
    const values = model.get ? model.get() : model;
    if (!values.staffId || !values.date) throw new AvailabilityError('Choose staff and a valid date for the override.');
    const previous = { ...values };
    for (const field of ['staffId', 'date', 'isWorking', 'periods']) if (model.changed?.(field)) previous[field] = model.previous(field);
    const service = new AvailabilityService(this.db, options?.transaction);
    await service.lockStaff([values.staffId, previous.staffId]);
    await service.assertOverrideChange(values, previous);
  }

  private respondAvailabilityError(ctx: any, error: unknown) {
    if (error instanceof AvailabilityError) ctx.throw(409, error.message);
    this.app.logger.error('Availability request failed', { error: error instanceof Error ? error.message : 'unknown error' });
    ctx.throw(503, 'Availability is temporarily unavailable. Please retry.');
  }
}

export default PluginAppointmentAvailabilityServer;
