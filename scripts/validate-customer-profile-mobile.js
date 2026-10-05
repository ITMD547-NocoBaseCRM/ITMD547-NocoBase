const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

async function main() {
  const env = loadEnv(path.resolve(process.cwd(), '.env'));
  const client = new Client({ host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_DATABASE, user: env.DB_USER, password: env.DB_PASSWORD, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const result = await client.query('select "x-uid", "schema" from "uiSchemas" where "x-uid" in (\'frjjlv3hp1b\', \'rrg040q4ou0\', \'ou37uqsdwd3\', \'hva89pdwbsu\', \'vxff12u0p89\', \'27d5epa9abi\', \'t04backaction\')');
  const schemas = Object.fromEntries(result.rows.map((row) => [row['x-uid'], row.schema]));
  const expectedWrapFields = ['ou37uqsdwd3', 'hva89pdwbsu', 'vxff12u0p89', '27d5epa9abi'];
  for (const uid of expectedWrapFields) {
    const style = schemas[uid]?.['x-component-props']?.style;
    if (style?.overflowWrap !== 'anywhere' || style?.wordBreak !== 'break-word') throw new Error(`Wrapping style missing from ${uid}`);
  }
  for (const uid of ['frjjlv3hp1b', 'rrg040q4ou0']) {
    const props = schemas[uid]?.['x-component-props'];
    if (props?.rowGap !== 12 || props?.colGap !== 12) throw new Error(`Responsive grid spacing missing from ${uid}`);
  }
  const backStyle = schemas.t04backaction?.['x-component-props']?.style;
  if (backStyle?.minHeight !== 44) throw new Error('Back navigation touch target is too small');
  if (schemas['27d5epa9abi']?.['x-component-props']?.ellipsis?.expandable !== true) throw new Error('Notes are not expandable');
  await client.end();
  console.log(JSON.stringify({ status: 'ok', singleColumnNativeGrid: true, wrappedFields: expectedWrapFields.length, notesExpandable: true, backTargetMinHeight: 44, viewportStrategy: 'native Grid and CSS wrapping; no window-width JavaScript' }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
