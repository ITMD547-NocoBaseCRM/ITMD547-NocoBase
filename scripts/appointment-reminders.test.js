const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  INTERVALS,
  REMINDER_STATUSES,
  REMINDERS_COLLECTION,
  SETTINGS_COLLECTION,
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_EMAIL_BODY,
  settingsCollectionDefinition,
  remindersCollectionDefinition,
  processWorkflowDefinition,
  processWorkflowNodes,
  queueDueRemindersSql,
  markDueRemindersSentSql,
  settingsPageBlueprint,
} = require('./appointment-reminders');

describe('appointment-reminders definitions', () => {
  it('exports expected interval values', () => {
    const values = INTERVALS.map((i) => i.value);
    assert.deepStrictEqual(values, ['1h', '2h', '12h', '24h', '48h']);
  });

  it('intervals have hours field', () => {
    for (const i of INTERVALS) {
      assert.ok(typeof i.hours === 'number' && i.hours > 0, `${i.value} should have a positive hours value`);
    }
  });

  it('reminder statuses include all expected values', () => {
    const values = REMINDER_STATUSES.map((s) => s.value);
    assert.ok(values.includes('pending'));
    assert.ok(values.includes('sent'));
    assert.ok(values.includes('failed'));
    assert.ok(values.includes('cancelled'));
  });

  describe('settingsCollectionDefinition', () => {
    const def = settingsCollectionDefinition();

    it('has the correct collection name', () => {
      assert.strictEqual(def.name, SETTINGS_COLLECTION);
    });

    it('includes enabledIntervals field with checkboxGroup interface', () => {
      const field = def.fields.find((f) => f.name === 'enabledIntervals');
      assert.ok(field, 'enabledIntervals field should exist');
      assert.strictEqual(field.interface, 'checkboxGroup');
      assert.strictEqual(field.type, 'json');
      assert.deepStrictEqual(field.defaultValue, ['24h', '48h']);
    });

    it('includes enabled boolean field', () => {
      const field = def.fields.find((f) => f.name === 'enabled');
      assert.ok(field, 'enabled field should exist');
      assert.strictEqual(field.type, 'boolean');
      assert.strictEqual(field.defaultValue, true);
    });

    it('includes email template fields', () => {
      assert.ok(def.fields.find((f) => f.name === 'emailSubject'), 'emailSubject should exist');
      assert.ok(def.fields.find((f) => f.name === 'emailBody'), 'emailBody should exist');
    });

    it('enabledIntervals enum matches INTERVALS', () => {
      const field = def.fields.find((f) => f.name === 'enabledIntervals');
      const enumValues = field.uiSchema.enum.map((e) => e.value);
      assert.deepStrictEqual(enumValues, INTERVALS.map((i) => i.value));
    });
  });

  describe('remindersCollectionDefinition', () => {
    const def = remindersCollectionDefinition();

    it('has the correct collection name', () => {
      assert.strictEqual(def.name, REMINDERS_COLLECTION);
    });

    it('has appointment relation', () => {
      const field = def.fields.find((f) => f.name === 'appointment');
      assert.ok(field);
      assert.strictEqual(field.type, 'belongsTo');
      assert.strictEqual(field.target, 'appointments');
    });

    it('has customer relation', () => {
      const field = def.fields.find((f) => f.name === 'customer');
      assert.ok(field);
      assert.strictEqual(field.type, 'belongsTo');
      assert.strictEqual(field.target, 'customers');
    });

    it('has intervalKey field', () => {
      const field = def.fields.find((f) => f.name === 'intervalKey');
      assert.ok(field);
      assert.strictEqual(field.interface, 'select');
    });

    it('has status field with pending default', () => {
      const field = def.fields.find((f) => f.name === 'status');
      assert.ok(field);
      assert.strictEqual(field.defaultValue, 'pending');
    });

    it('has scheduledFor and sentAt datetime fields', () => {
      assert.ok(def.fields.find((f) => f.name === 'scheduledFor'));
      assert.ok(def.fields.find((f) => f.name === 'sentAt'));
    });
  });

  describe('processWorkflowDefinition', () => {
    const def = processWorkflowDefinition();

    it('is a schedule workflow', () => {
      assert.strictEqual(def.type, 'schedule');
    });

    it('runs every 15 minutes', () => {
      assert.strictEqual(def.config.repeat, '*/15 * * * *');
    });

    it('is enabled by default', () => {
      assert.strictEqual(def.enabled, true);
    });
  });

  describe('processWorkflowNodes', () => {
    const nodes = processWorkflowNodes();

    it('has 2 SQL nodes: queue + mark sent', () => {
      assert.strictEqual(nodes.length, 2);
      assert.strictEqual(nodes[0].type, 'sql');
      assert.strictEqual(nodes[1].type, 'sql');
    });

    it('queue node queries pending reminders and inserts into customerMessages', () => {
      const sql = nodes[0].config.sql;
      assert.ok(sql.includes("r.status = 'pending'"));
      assert.ok(sql.includes('r."scheduledFor" <= NOW()'));
      assert.ok(sql.includes('INSERT INTO'));
      assert.ok(sql.includes('customerMessages'));
    });

    it('mark-sent node updates reminders to sent', () => {
      const sql = nodes[1].config.sql;
      assert.ok(sql.includes("status    = 'sent'"));
      assert.ok(sql.includes('"sentAt"  = NOW()'));
    });

    it('mark-sent node is downstream of queue node', () => {
      assert.strictEqual(nodes[1].upstream, 'sql_queue_messages');
    });
  });

  describe('queueDueRemindersSql', () => {
    const sql = queueDueRemindersSql();

    it('uses a CTE to read settings template', () => {
      assert.ok(sql.includes('WITH settings AS'));
    });

    it('replaces template variables', () => {
      assert.ok(sql.includes("'{{firstName}}'"));
      assert.ok(sql.includes("'{{appointmentDate}}'"));
      assert.ok(sql.includes("'{{appointmentTime}}'"));
    });

    it('only picks pending reminders for scheduled/confirmed appointments', () => {
      assert.ok(sql.includes("r.status = 'pending'"));
      assert.ok(sql.includes("a.status IN ('scheduled', 'confirmed')"));
    });

    it('limits to 100 per run', () => {
      assert.ok(sql.includes('LIMIT 100'));
    });
  });

  describe('markDueRemindersSentSql', () => {
    const sql = markDueRemindersSentSql();

    it('updates status to sent', () => {
      assert.ok(sql.includes("status    = 'sent'"));
    });

    it('uses same filter criteria as the queue query', () => {
      assert.ok(sql.includes("status = 'pending'"));
      assert.ok(sql.includes('"scheduledFor" <= NOW()'));
    });
  });

  describe('settingsPageBlueprint', () => {
    const bp = settingsPageBlueprint({ pageSchemaUid: 'test123' });

    it('targets the provided page', () => {
      assert.strictEqual(bp.target.pageSchemaUid, 'test123');
    });

    it('has a settings form block and a reminders table block', () => {
      const blocks = bp.tabs[0].blocks;
      assert.strictEqual(blocks.length, 2);
      assert.strictEqual(blocks[0].type, 'editForm');
      assert.strictEqual(blocks[0].collection, SETTINGS_COLLECTION);
      assert.strictEqual(blocks[1].type, 'table');
      assert.strictEqual(blocks[1].collection, REMINDERS_COLLECTION);
    });

    it('form includes enabledIntervals field', () => {
      const form = bp.tabs[0].blocks[0];
      assert.ok(form.fields.includes('enabledIntervals'));
    });
  });

  describe('default email template', () => {
    it('subject is a non-empty string', () => {
      assert.ok(DEFAULT_EMAIL_SUBJECT.length > 0);
    });

    it('body contains template variables', () => {
      assert.ok(DEFAULT_EMAIL_BODY.includes('{{firstName}}'));
      assert.ok(DEFAULT_EMAIL_BODY.includes('{{appointmentDate}}'));
      assert.ok(DEFAULT_EMAIL_BODY.includes('{{appointmentTime}}'));
    });
  });
});
