const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  APPOINTMENT_CATEGORIES,
  APPOINTMENT_STATUSES,
  DEFAULT_CATEGORY,
  DEFAULT_STATUS,
} = require('./appointments-schema');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// Compare enum option lists regardless of JSON key order (jsonb normalises key order).
function sameOptions(actual, expected) {
  const normalise = (list) =>
    JSON.stringify((list || []).map((item) => ({ value: item.value, label: item.label, color: item.color })));
  return normalise(actual) === normalise(expected);
}

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const client = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_DATABASE,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: { rejectUnauthorized: env.DB_DIALECT_OPTIONS_SSL_REJECT_UNAUTHORIZED !== 'false' },
  });
  await client.connect();
  try {
    const columns = await client.query(
      `select column_name, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'appointments'`,
    );
    const byName = Object.fromEntries(columns.rows.map((row) => [row.column_name, row]));
    expect(byName.category, 'appointments.category column is missing');
    expect(byName.category.is_nullable === 'NO', 'appointments.category must be NOT NULL');
    expect(
      (byName.category.column_default || '').startsWith(`'${DEFAULT_CATEGORY}'`),
      'appointments.category default must be session',
    );
    expect(
      (byName.status.column_default || '').startsWith(`'${DEFAULT_STATUS}'`),
      'appointments.status default must be scheduled',
    );
    for (const column of ['customerId', 'appointmentDate', 'startTime', 'status']) {
      expect(byName[column].is_nullable === 'NO', `appointments.${column} must be NOT NULL`);
    }
    for (const column of ['staffId', 'endTime', 'notes']) {
      expect(byName[column].is_nullable === 'YES', `appointments.${column} must stay nullable`);
    }

    const constraints = await client.query(
      `select conname from pg_constraint where conrelid = '"appointments"'::regclass and contype = 'c'`,
    );
    const constraintNames = constraints.rows.map((row) => row.conname);
    for (const name of ['appointments_category_check', 'appointments_status_check', 'appointments_end_after_start']) {
      expect(constraintNames.includes(name), `constraint ${name} is missing`);
    }

    const indexes = await client.query(`select indexname from pg_indexes where tablename = 'appointments'`);
    const indexNames = indexes.rows.map((row) => row.indexname);
    for (const name of [
      'appointments_customer_id',
      'appointments_staff_id',
      'appointments_date_start',
      'appointments_staff_date',
      'appointments_category_date',
      'appointments_status_date',
    ]) {
      expect(indexNames.includes(name), `index ${name} is missing`);
    }

    const fields = await client.query(
      `select name, type, interface, options from "fields" where "collectionName" = 'appointments'`,
    );
    const field = Object.fromEntries(fields.rows.map((row) => [row.name, row]));
    expect(field.category, 'fields metadata for appointments.category is missing');
    expect(
      field.category.type === 'string' && field.category.interface === 'select',
      'appointments.category must be a select field',
    );
    expect(
      sameOptions(field.category.options.enum, APPOINTMENT_CATEGORIES),
      'appointments.category enum differs from appointments-schema.js',
    );
    expect(
      sameOptions(field.status.options.enum, APPOINTMENT_STATUSES),
      'appointments.status enum differs from appointments-schema.js',
    );
    for (const name of ['customer', 'appointmentDate', 'startTime', 'status', 'category']) {
      expect(field[name].options.uiSchema.required === true, `appointments.${name} must be marked required`);
    }
    for (const [name, target, fk] of [
      ['customer', 'customers', 'customerId'],
      ['staff', 'staff', 'staffId'],
    ]) {
      expect(
        field[name].type === 'belongsTo' &&
          field[name].options.target === target &&
          field[name].options.foreignKey === fk,
        `appointments.${name} relationship is misconfigured`,
      );
    }
    expect(
      field.appointmentServices.type === 'hasMany' &&
        field.appointmentServices.options.target === 'appointmentServices',
      'appointments.appointmentServices relationship is misconfigured',
    );
    const duplicateCustomerData = fields.rows.filter((row) => /skin|phone|email|firstName|lastName/i.test(row.name));
    expect(duplicateCustomerData.length === 0, 'appointments must not duplicate customer data');

    const acl = await client.query(
      `select r."roleName", a.name, a.fields from "dataSourcesRolesResources" r
       join "dataSourcesRolesResourcesActions" a on a."rolesResourceId" = r.id
       where r."dataSourceKey" = 'main' and r.name = 'appointments' and r."roleName" in ('r_staff', 'r_receptionist')
         and a.name in ('view', 'create', 'update')`,
    );
    expect(acl.rows.length === 6, `expected 6 appointments role actions, found ${acl.rows.length}`);
    for (const row of acl.rows) {
      expect(row.fields.includes('category'), `${row.roleName} ${row.name} grant is missing category`);
    }

    const data = await client.query(
      `select count(*)::int as total,
              count(*) filter (where category not in ('session', 'event'))::int as bad_category,
              count(*) filter (where "endTime" is not null and "endTime" <= "startTime")::int as bad_time
       from "appointments"`,
    );
    expect(data.rows[0].bad_category === 0 && data.rows[0].bad_time === 0, 'appointments rows violate the new rules');

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          appointments: data.rows[0].total,
          checks: {
            columns: true,
            constraints: constraintNames,
            indexes: indexNames.length,
            fieldMetadata: true,
            roleGrants: acl.rows.length,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Appointments collection validation failed: ${error.message}`);
  process.exitCode = 1;
});
