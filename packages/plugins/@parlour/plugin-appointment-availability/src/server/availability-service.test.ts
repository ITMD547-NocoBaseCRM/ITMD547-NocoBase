import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvailabilityError, AvailabilityService } from './availability-service';

function serviceWithAssignments(assignedServiceIds: Array<number | string>) {
  const queries: any[] = [];
  const service = new AvailabilityService({
    getRepository(name: string) {
      assert.equal(name, 'staffServices');
      return {
        async find(query: any) {
          queries.push(query);
          const requested = query.filter.$and[1].serviceId.$in.map(String);
          return assignedServiceIds
            .filter((id) => requested.includes(String(id)))
            .map((serviceId) => ({ serviceId }));
        },
      };
    },
  });
  return { service, queries };
}

test('does not require a service assignment when no services are selected', async () => {
  const service = new AvailabilityService({
    getRepository() {
      throw new Error('staffServices should not be queried for an empty selection');
    },
  });

  await service.assertStaffProvidesServices(10, []);
});

test('accepts staff linked to every selected service and deduplicates IDs', async () => {
  const { service, queries } = serviceWithAssignments([11, 12]);

  await service.assertStaffProvidesServices(10, [{ id: '11' }, 11, '12']);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].filter.$and[0], { staffId: 10 });
  assert.equal(queries[0].filter.$and[1].serviceId.$in.length, 2);
});

test('rejects staff missing any one of multiple selected services', async () => {
  const { service } = serviceWithAssignments([11]);

  await assert.rejects(
    service.assertStaffProvidesServices(10, [11, 12]),
    (error: unknown) => error instanceof AvailabilityError && /every selected service/.test(error.message),
  );
});

test('rejects malformed selected service IDs', async () => {
  const { service } = serviceWithAssignments([]);

  await assert.rejects(
    service.assertStaffProvidesServices(10, ['not-a-service-id']),
    (error: unknown) => error instanceof AvailabilityError && /invalid ID/.test(error.message),
  );
});
