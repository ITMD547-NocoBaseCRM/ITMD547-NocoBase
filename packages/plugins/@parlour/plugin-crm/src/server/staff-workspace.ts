/**
 * "My Workspace" for technicians: `staffWorkspace:get`.
 *
 * The employee is resolved on the server from the signed-in user (staff.userId); nothing the browser sends can
 * choose another employee. The caller's current role must already be allowed to read appointments (Staff,
 * Receptionist, Manager, Admin) – a Member-only account gets 403 even if it is linked. All queries filter on the
 * resolved employee id and return only the fields the workspace shows.
 */

const TZ = 'America/Chicago';
const DAY = 24 * 60 * 60 * 1000;

/** Start of "today" in the salon time zone, as a UTC Date. */
function startOfBusinessDay(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offset = asUtc - now.getTime(); // local - utc
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset);
}

export function staffWorkspaceResource(app: any) {
  return {
    name: 'staffWorkspace',
    actions: {
      get: async (ctx: any, next: () => Promise<any>) => {
        const roles: string[] = ctx.state.currentRoles?.length ? ctx.state.currentRoles : [ctx.state.currentRole].filter(Boolean);
        const allowed = roles.some((role) => role === 'root' || !!app.acl.can({ role, resource: 'appointments', action: 'list' }));
        if (!allowed) ctx.throw(403, 'No permissions');
        const userId = ctx.state.currentUser?.id;
        const db = app.db;
        const staff = userId ? await db.getRepository('staff').findOne({ filter: { userId } }) : null;
        if (!staff) ctx.throw(403, 'Your account is not linked to an employee record yet. Ask an administrator.');
        const staffId = staff.get('id');

        const dayStart = startOfBusinessDay();
        const dayEnd = new Date(dayStart.getTime() + DAY);
        const horizon = new Date(dayStart.getTime() + 15 * DAY);
        const monthAgo = new Date(dayStart.getTime() - 30 * DAY);
        const ninety = new Date(dayStart.getTime() - 90 * DAY);

        const apptRepo = db.getRepository('appointments');
        const apptFields = ['id', 'startTime', 'endTime', 'status', 'notes', 'customerId'];
        const appends = ['customer', 'appointmentServices', 'appointmentServices.service'];
        const toAppt = (a: any) => ({
          id: String(a.get('id')),
          startTime: a.get('startTime'),
          endTime: a.get('endTime'),
          status: a.get('status'),
          notes: a.get('notes') || null,
          customer: a.get('customer') ? { id: String(a.get('customer').id), firstName: a.get('customer').firstName, lastName: a.get('customer').lastName, skinSensitivities: a.get('customer').skinSensitivities || null, skinSensitivitiesOther: a.get('customer').skinSensitivitiesOther || null } : null,
          services: (a.get('appointmentServices') || []).map((s: any) => s.service?.name).filter(Boolean),
        });

        const [today, upcoming, recent, shifts, monthShifts] = await Promise.all([
          apptRepo.find({ filter: { staffId, startTime: { $gte: dayStart, $lt: dayEnd } }, fields: apptFields, appends, sort: ['startTime'] }),
          apptRepo.find({ filter: { staffId, startTime: { $gte: dayEnd, $lt: horizon }, status: { $notIn: ['cancelled'] } }, fields: apptFields, appends, sort: ['startTime'], limit: 30 }),
          apptRepo.find({ filter: { staffId, startTime: { $gte: monthAgo, $lt: dayEnd } }, fields: ['id', 'status', 'customerId', 'startTime'] }),
          db.getRepository('employeeShifts').find({ filter: { staffId, endTime: { $gte: new Date() }, startTime: { $lt: horizon }, status: { $ne: 'cancelled' } }, fields: ['id', 'shiftDate', 'startTime', 'endTime', 'status', 'shiftType'], sort: ['startTime'], limit: 30 }),
          db.getRepository('employeeShifts').find({ filter: { staffId, startTime: { $gte: monthAgo, $lt: dayEnd } }, fields: ['id', 'status'] }),
        ]);

        // Customers of my appointments (last 90 days and upcoming), service-relevant fields only.
        const myAppts = await apptRepo.find({ filter: { staffId, startTime: { $gte: ninety, $lt: horizon } }, fields: ['customerId', 'startTime'], sort: ['-startTime'] });
        const lastSeen = new Map<string, Date>();
        for (const a of myAppts) {
          const id = a.get('customerId') == null ? null : String(a.get('customerId'));
          if (id && !lastSeen.has(id)) lastSeen.set(id, a.get('startTime'));
        }
        const customerIds = [...lastSeen.keys()];
        const customers = customerIds.length
          ? await db.getRepository('customers').find({ filter: { id: { $in: customerIds } }, fields: ['id', 'firstName', 'lastName', 'phone', 'skinProfile', 'skinSensitivities', 'skinSensitivitiesOther'] })
          : [];
        const notes = await db.getRepository('customerNotes').find({
          filter: {
            $or: [{ staffId }, ...(customerIds.length ? [{ $and: [{ staffId: { $empty: true } }, { customerId: { $in: customerIds } }] }] : [])],
          },
          fields: ['id', 'note', 'createdAt', 'customerId', 'staffId'],
          sort: ['-createdAt'],
          limit: 15,
        });
        const nameOf = new Map(customers.map((c: any) => [String(c.get('id')), `${c.get('firstName') || ''} ${c.get('lastName') || ''}`.trim()]));

        // Personal metrics, last 30 days.
        const recentIds = recent.map((a: any) => a.get('id'));
        const payments = recentIds.length
          ? await db.getRepository('payments').find({ filter: { appointmentId: { $in: recentIds }, status: 'paid', paymentType: { $ne: 'refund' } }, fields: ['amount'] })
          : [];
        const count = (status: string) => recent.filter((a: any) => a.get('status') === status).length;
        const past = recent.filter((a: any) => new Date(a.get('startTime')).getTime() < Date.now());
        const metrics = {
          periodDays: 30,
          appointments: recent.length,
          completed: count('completed'),
          cancelled: count('cancelled'),
          noShow: count('noShow'),
          completionRate: past.length ? Math.round((count('completed') / past.length) * 100) : null,
          revenue: Math.round(payments.reduce((sum: number, p: any) => sum + Number(p.get('amount') || 0), 0) * 100) / 100,
          shifts: monthShifts.length,
          shiftsCompleted: monthShifts.filter((s: any) => s.get('status') === 'completed').length,
          shiftsOnLeave: monthShifts.filter((s: any) => s.get('status') === 'onLeave').length,
        };

        ctx.body = {
          employee: { id: String(staffId), name: `${staff.get('firstName') || ''} ${staff.get('lastName') || ''}`.trim(), jobTitle: staff.get('role') || null },
          timeZone: TZ,
          today: today.map(toAppt),
          upcoming: upcoming.map(toAppt),
          shifts: shifts.map((s: any) => ({ id: String(s.get('id')), shiftDate: s.get('shiftDate'), startTime: s.get('startTime'), endTime: s.get('endTime'), status: s.get('status'), shiftType: s.get('shiftType') })),
          customers: customers
            .map((c: any) => ({ id: String(c.get('id')), name: nameOf.get(String(c.get('id'))), phone: c.get('phone') || null, skinProfile: c.get('skinProfile') || null, skinSensitivities: c.get('skinSensitivities') || null, skinSensitivitiesOther: c.get('skinSensitivitiesOther') || null, lastSeen: lastSeen.get(String(c.get('id'))) }))
            .sort((p: any, n: any) => new Date(n.lastSeen).getTime() - new Date(p.lastSeen).getTime()),
          notes: notes.map((n: any) => ({ id: String(n.get('id')), note: n.get('note'), createdAt: n.get('createdAt'), customer: nameOf.get(String(n.get('customerId'))) || null, mine: String(n.get('staffId')) === String(staffId) })),
          metrics,
        };
        await next();
      },
    },
  };
}
