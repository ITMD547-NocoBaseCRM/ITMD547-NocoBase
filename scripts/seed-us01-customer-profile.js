const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

const customers = [
  {
    key: 'complete', firstName: 'US01 Demo', lastName: 'Complete', email: 'us01.complete@example.test', phone: '555-1101',
    address: 'US-01 demo profile: complete', notes: 'US-01 seeded. Prefers morning visits and fragrance-free products. Complete profile with service history.', status: 'active',
    skinProfile: 'normal', skinSensitivities: ['fragrancesPerfumes', 'essentialOils'], skinSensitivitiesOther: null, history: 3,
  },
  {
    key: 'minimal', firstName: 'US01 Demo', lastName: 'Minimal', email: 'us01.minimal@example.test', phone: null,
    address: 'US-01 demo profile: minimal', notes: 'US-01 seeded. Minimal profile for incomplete-information rendering.', status: 'active',
    skinProfile: null, skinSensitivities: null, skinSensitivitiesOther: null, history: 0,
  },
  {
    key: 'dry', firstName: 'US01 Demo', lastName: 'Dry', email: 'us01.dry@example.test', phone: '555-1103',
    address: 'US-01 demo profile: dry skin', notes: 'US-01 seeded. Dry skin profile with one recorded sensitivity.', status: 'active',
    skinProfile: 'dry', skinSensitivities: ['latex'], skinSensitivitiesOther: null, history: 1,
  },
  {
    key: 'oily', firstName: 'US01 Demo', lastName: 'Oily', email: 'us01.oily@example.test', phone: '555-1104',
    address: 'US-01 demo profile: oily skin', notes: `US-01 seeded. Oily skin profile with many sensitivities. ${'Long note for overflow testing. '.repeat(80)}`, status: 'active',
    skinProfile: 'oily', skinSensitivities: ['fragrancesPerfumes', 'essentialOils', 'alphaHydroxyAcids', 'betaHydroxyAcidsSalicylicAcid', 'retinoidsRetinol', 'nutsSeedOils', 'sunExposureSunburn'], skinSensitivitiesOther: null, history: 4,
  },
  {
    key: 'combination', firstName: 'US01 Demo', lastName: 'Combination', email: null, phone: null,
    address: 'US-01 demo profile: combination skin', notes: 'US-01 seeded. Combination skin with no recorded sensitivities and no service history.', status: 'active',
    skinProfile: 'combination', skinSensitivities: null, skinSensitivitiesOther: null, history: 0,
  },
  {
    key: 'sensitive', firstName: 'US01 Demo', lastName: 'Sensitive', email: 'us01.sensitive@example.test', phone: '555-1106',
    address: 'US-01 demo profile: sensitive skin', notes: 'US-01 seeded. Sensitive skin profile; sensitivity data intentionally unrecorded.', status: 'active',
    skinProfile: 'sensitive', skinSensitivities: null, skinSensitivitiesOther: null, history: 0,
  },
  {
    key: 'other', firstName: 'US01 Demo', lastName: 'Other', email: 'us01.other@example.test', phone: '555-1107',
    address: 'US-01 demo profile: other skin', notes: 'US-01 seeded. Uses the Other skin profile and Other sensitivity value.', status: 'active',
    skinProfile: 'other', skinProfileOther: 'Reactive during seasonal changes', skinSensitivities: ['other'], skinSensitivitiesOther: 'Botanical extract not listed', history: 2,
  },
  {
    key: 'large-history', firstName: 'US01 Demo', lastName: 'Large History', email: 'us01.large-history@example.test', phone: '555-1108',
    address: 'US-01 demo profile: large history', notes: 'US-01 seeded. Large service history for table scrolling and newest-first ordering.', status: 'active',
    skinProfile: 'normal', skinSensitivities: ['latex'], skinSensitivitiesOther: null, history: 25,
  },
];

const idState = { next: BigInt(Date.now()) * 100000n };
function nextId() {
  idState.next += 1n;
  return idState.next.toString();
}

async function upsertCustomer(client, customer, userId) {
  const existing = await client.query('select id from "customers" where email = $1 or ("firstName" = $2 and "lastName" = $3) limit 1', [customer.email, customer.firstName, customer.lastName]);
  const values = [
    customer.firstName, customer.lastName, customer.email, customer.phone, customer.address, customer.notes, customer.status,
    customer.skinProfile ?? null, customer.skinProfileOther ?? null, customer.skinSensitivities ?? null, customer.skinSensitivitiesOther ?? null, userId,
  ];
  if (existing.rows[0]) {
    const result = await client.query(`update "customers"
      set "firstName"=$1,"lastName"=$2,"email"=$3,"phone"=$4,"address"=$5,"notes"=$6,"status"=$7,
          "skinProfile"=$8,"skinProfileOther"=$9,"skinSensitivities"=$10,"skinSensitivitiesOther"=$11,"updatedById"=$12,"updatedAt"=now()
      where id=$13 returning id`, [...values, existing.rows[0].id]);
    return result.rows[0].id;
  }
  const id = nextId();
  const result = await client.query(`insert into "customers"
    (id,"firstName","lastName","email","phone","address","notes","status","skinProfile","skinProfileOther","skinSensitivities","skinSensitivitiesOther","createdById","updatedById","createdAt","updatedAt")
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,now(),now()) returning id`, [id, ...values]);
  return result.rows[0].id;
}

async function seedHistory(client, customerId, count, services, staff, userId, key) {
  await client.query('delete from "appointmentServices" where "appointmentId" in (select id from "appointments" where "customerId"=$1 and notes like $2)', [customerId, `[US-01 seed:${key}]%`]);
  await client.query('delete from "appointments" where "customerId"=$1 and notes like $2', [customerId, `[US-01 seed:${key}]%`]);
  for (let index = 0; index < count; index += 1) {
    const id = nextId();
    const serviceId = services[index % services.length].id;
    const staffId = staff[index % staff.length].id;
    const date = new Date(Date.UTC(2026, 8, 25 - index));
    const dateValue = date.toISOString().slice(0, 10);
    const start = new Date(date.getTime() + (10 + (index % 6)) * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 45 * 60 * 1000);
    await client.query(`insert into "appointments"
      (id,"appointmentDate","startTime","endTime","status","notes","createdById","updatedById","customerId","staffId","createdAt","updatedAt")
      values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,now(),now())`, [id, dateValue, start.toISOString(), end.toISOString(), index === 0 ? 'completed' : 'completed', `[US-01 seed:${key}] Service history ${index + 1}`, userId, customerId, staffId]);
    const appointmentServiceId = nextId();
    await client.query(`insert into "appointmentServices"
      (id,"priceAtBooking","durationAtBooking","notes","createdById","updatedById","appointmentId","serviceId","createdAt","updatedAt")
      values ($1,$2,$3,$4,$5,$5,$6,$7,now(),now())`, [appointmentServiceId, 75 + (index % 4) * 25, 45, index === 0 ? 'Staff noted good progress.' : null, userId, id, serviceId]);
  }
}

async function updateProfileFieldAccess(client) {
  const profileFields = ['skinProfile', 'skinProfileOther', 'skinSensitivities', 'skinSensitivitiesOther'];
  const roles = await client.query('select "roleName", name, id from "dataSourcesRolesResources" r where "roleName" in (\'r_staff\', \'r_receptionist\') and name=\'customers\'');
  for (const role of roles.rows) {
    const actions = await client.query('select id, fields from "dataSourcesRolesResourcesActions" where "rolesResourceId"=$1 and name in (\'view\',\'create\',\'update\')', [role.id]);
    for (const action of actions.rows) {
      const fields = [...new Set([...(action.fields || []), ...profileFields])].sort();
      await client.query('update "dataSourcesRolesResourcesActions" set fields=$1::jsonb where id=$2', [JSON.stringify(fields), action.id]);
    }
  }
  return [...new Set(roles.rows.map((row) => row.roleName))];
}

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const client = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_DATABASE, user: env.DB_USER, password: env.DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('begin');
    const user = await client.query('select id from "users" order by id limit 1');
    if (!user.rows[0]) throw new Error('Cannot seed customer profiles because no application user exists');
    const userId = user.rows[0].id;
    const services = (await client.query('select id from "services" where active is not false order by id')).rows;
    const staff = (await client.query('select id from "staff" where active is distinct from \'inactive\' order by id')).rows;
    if (!services.length || !staff.length) throw new Error('Cannot seed service history because services or staff are missing');
    const seeded = [];
    for (const customer of customers) {
      const customerId = await upsertCustomer(client, customer, userId);
      await seedHistory(client, customerId, customer.history, services, staff, userId, customer.key);
      seeded.push({ key: customer.key, customerId, serviceHistoryRecords: customer.history });
    }
    const roles = await updateProfileFieldAccess(client);
    await client.query('commit');
    console.log(JSON.stringify({ status: 'ok', seededCustomers: seeded, profileFieldsVisibleToRoles: roles }, null, 2));
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(`US-01 seed failed: ${error.message}`); process.exitCode = 1; });
