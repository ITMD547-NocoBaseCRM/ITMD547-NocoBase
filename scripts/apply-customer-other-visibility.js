// Shows the two customer "Other" detail inputs only while their related select contains "other".
const { createClient, formatErrors } = require('./nocobase-api');

const COLLECTION = 'customers';
const RULES = [
  {
    key: 'hide-skin-profile-other-unless-selected',
    when: { logic: '$and', items: [{ path: 'formValues.skinProfile', operator: '$ne', value: 'other' }] },
    then: [{ type: 'setFieldState', fieldPaths: ['skinProfileOther'], state: 'hidden' }],
  },
  {
    key: 'hide-skin-sensitivities-other-unless-selected',
    when: { logic: '$and', items: [{ path: 'formValues.skinSensitivities', operator: '$noneOf', value: ['other'] }] },
    then: [{ type: 'setFieldState', fieldPaths: ['skinSensitivitiesOther'], state: 'hidden' }],
  },
];

const fail = (what, result) => new Error(`${what} failed (${result.status}):\n${formatErrors(result.json)}`);

async function main() {
  const check = process.argv.includes('--check');
  const client = await createClient();
  const models = await client.request('flowModels:list?pageSize=1000');
  if (!models.ok) throw fail('flowModels:list', models);
  const forms = (models.json?.data || []).filter(
    (model) => /^(Create|Edit)FormModel$/.test(model.use) && model.stepParams?.resourceSettings?.init?.collectionName === COLLECTION,
  );
  if (!forms.length) throw new Error('No customer create/edit forms found');

  const results = [];
  for (const form of forms) {
    const meta = await client.request('flowSurfaces:getReactionMeta', { method: 'POST', body: { target: { uid: form.uid } } });
    if (!meta.ok) throw fail(`getReactionMeta ${form.uid}`, meta);
    const linkage = (meta.json?.data?.capabilities || []).find((capability) => capability.kind === 'fieldLinkage');
    if (!linkage) throw new Error(`Form ${form.uid} does not expose fieldLinkage`);
    const managedKeys = new Set(RULES.map((rule) => rule.key));
    const rules = [...(linkage.normalizedRules || []).filter((rule) => !managedKeys.has(rule.key)), ...RULES];
    if (!check) {
      const updated = await client.request('flowSurfaces:setFieldLinkageRules', {
        method: 'POST',
        body: { target: { uid: form.uid }, expectedFingerprint: linkage.fingerprint, rules },
      });
      if (!updated.ok) throw fail(`setFieldLinkageRules ${form.uid}`, updated);
    }
    results.push({ uid: form.uid, use: form.use, rules: RULES.map((rule) => rule.key), dryRun: check || undefined });
  }
  console.log(JSON.stringify({ status: 'ok', target: client.baseUrl, forms: results }, null, 2));
}

main().catch((error) => {
  console.error(`Customer conditional visibility failed: ${error.message}`);
  process.exitCode = 1;
});
