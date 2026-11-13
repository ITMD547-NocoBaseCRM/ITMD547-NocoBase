const assert = require('node:assert/strict');
const { Client } = require('pg');
const { loadEnv } = require('./nocobase-api');

const normalize = (value) => String(value || '').replaceAll('"', '').toLowerCase().replace(/\s+/g, ' ');

async function main() {
  const env = loadEnv();
  const required = ['DB_HOST', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing database settings: ${missing.join(', ')}`);

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
    const table = await client.query(
      `SELECT column_name, udt_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'staffServices'`,
    );
    const columns = new Map(table.rows.map((row) => [row.column_name, row]));
    for (const [name, udtName] of Object.entries({
      id: 'int8',
      staffId: 'int8',
      serviceId: 'int8',
      createdAt: 'timestamptz',
      updatedAt: 'timestamptz',
      createdById: 'int8',
      updatedById: 'int8',
    })) {
      assert.equal(columns.get(name)?.udt_name, udtName, `staffServices.${name} must use ${udtName}`);
    }
    for (const name of ['id', 'staffId', 'serviceId']) {
      assert.equal(columns.get(name)?.is_nullable, 'NO', `staffServices.${name} must be NOT NULL`);
    }

    const constraints = await client.query(
      `SELECT conname, contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = to_regclass(format('%I.%I', current_schema(), 'staffServices'))`,
    );
    const byName = new Map(constraints.rows.map((row) => [row.conname, { ...row, normalized: normalize(row.definition) }]));
    assert.equal(byName.get('staff_services_pkey')?.contype, 'p', 'staffServices primary key is required');
    assert.ok(
      byName.get('staff_services_pair_unique')?.normalized.includes('unique (staffid, serviceid)'),
      'staff/service pair uniqueness is required',
    );
    for (const [name, key, target] of [
      ['staff_services_staff_fk', 'staffid', 'staff(id)'],
      ['staff_services_service_fk', 'serviceid', 'services(id)'],
    ]) {
      const definition = byName.get(name)?.normalized;
      assert.ok(definition?.includes(`foreign key (${key}) references ${target}`), `${name} must reference ${target}`);
      assert.ok(definition.includes('on delete cascade'), `${name} must cascade junction-row deletes`);
      assert.ok(definition.includes('on update cascade'), `${name} must cascade key updates`);
    }

    const indexes = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'staffServices'`,
    );
    const indexDefs = new Map(indexes.rows.map((row) => [row.indexname, normalize(row.indexdef)]));
    assert.ok(indexDefs.get('staff_services_service_id_idx')?.includes('(serviceid)'), 'serviceId lookup index is required');
    assert.ok(indexDefs.get('staff_services_created_by_id_idx')?.includes('(createdbyid)'), 'createdById index is required');
    assert.ok(indexDefs.get('staff_services_updated_by_id_idx')?.includes('(updatedbyid)'), 'updatedById index is required');

    const collection = await client.query('SELECT key, options FROM "collections" WHERE name = $1', ['staffServices']);
    assert.equal(collection.rowCount, 1, 'staffServices NocoBase collection metadata is required');
    assert.equal(collection.rows[0].key, 'staff_services');
    assert.equal(collection.rows[0].options?.template, 'general');
    assert.equal(collection.rows[0].options?.autoGenId, false);

    const fields = await client.query(
      `SELECT key, name, type, interface, "collectionName", "reverseKey", options
       FROM "fields"
       WHERE ("collectionName" = 'staffServices' AND name IN ('id', 'staffId', 'serviceId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'))
          OR ("collectionName" = 'staff' AND name = 'services')
          OR ("collectionName" = 'services' AND name = 'staff')`,
    );
    const fieldMap = new Map(fields.rows.map((field) => [`${field.collectionName}.${field.name}`, field]));
    for (const name of ['id', 'staffId', 'serviceId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']) {
      assert.ok(fieldMap.has(`staffServices.${name}`), `staffServices.${name} NocoBase field metadata is required`);
    }
    const staffServices = fieldMap.get('staff.services');
    const servicesStaff = fieldMap.get('services.staff');
    assert.equal(staffServices?.type, 'belongsToMany');
    assert.equal(staffServices?.interface, 'm2m');
    assert.equal(staffServices?.options?.target, 'services');
    assert.equal(staffServices?.options?.through, 'staffServices');
    assert.equal(staffServices?.options?.foreignKey, 'staffId');
    assert.equal(staffServices?.options?.otherKey, 'serviceId');
    assert.equal(staffServices?.reverseKey, servicesStaff?.key);
    assert.equal(servicesStaff?.type, 'belongsToMany');
    assert.equal(servicesStaff?.interface, 'm2m');
    assert.equal(servicesStaff?.options?.target, 'staff');
    assert.equal(servicesStaff?.options?.through, 'staffServices');
    assert.equal(servicesStaff?.options?.foreignKey, 'serviceId');
    assert.equal(servicesStaff?.options?.otherKey, 'staffId');
    assert.equal(servicesStaff?.reverseKey, staffServices?.key);

    const linkCount = await client.query('SELECT COUNT(*)::int AS count FROM "staffServices"');
    console.log(JSON.stringify({ status: 'ok', table: 'staffServices', staffServiceAssignments: linkCount.rows[0].count }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Staff-services validation failed: ${error.message}`);
  process.exitCode = 1;
});
