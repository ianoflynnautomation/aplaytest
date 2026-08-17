import { expect, test } from './api-fixtures.js';

test('API: gyms endpoint filters by county server-side', async ({ request }) => {
  const res = await request.get('/api/gyms?county=Dublin');
  expect(res.ok()).toBe(true);
  expect((await res.json()).items).toHaveLength(2);
});
