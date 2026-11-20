import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './test-browser.mjs';
import { createStudentApiHandler } from '../supabase/functions/student-api/handler.mjs';

installBrowser({ href: 'http://localhost/' });
const { handle } = await import('../js/localapi.js');

async function localCall(method, path, body) {
  const response = await handle(method, path, {}, body);
  assert.equal(response.ok, true, response.error);
  return response.data;
}

test('selfstudy visibility hides both local student feeds and preserves publication and other modules', async () => {
  const link = await localCall('POST', '/links', { title: 'Visibility fixture' });
  const path = '/public/link/' + link.code;
  const task = await localCall('POST', '/selfstudy_tasks', { title: 'Published task', status: 'published' });
  const settings = '/links/' + link.id;
  const ids = (tasks) => tasks.map(({ id }) => id);
  assert.deepEqual(ids((await localCall('GET', path)).selfstudyTasks), [task.id]);

  await localCall('PATCH', settings, { modules: { material: 0 } });
  await localCall('PATCH', settings, { modules: { selfstudy: 0 } });
  const hidden = await localCall('GET', path);
  assert.equal(hidden.link.modules.selfstudy, 0);
  assert.equal(hidden.link.modules.material, 0);
  assert.deepEqual(hidden.selfstudyTasks, []);
  assert.deepEqual((await localCall('GET', path + '/selfstudy')).tasks, []);

  await localCall('PATCH', settings, { modules: { roll: 0 } });
  assert.equal((await localCall('GET', path)).link.modules.selfstudy, 0);
  await localCall('PATCH', settings, { modules: { selfstudy: 1 } });
  assert.deepEqual(ids((await localCall('GET', path + '/selfstudy')).tasks), [task.id]);
});

test('cloud student feed sends published live tasks only for links with selfstudy enabled', async () => {
  const payload = {
    links: [
      { code: 'legacy-link', enabled: 1, modules: '{"material":0}' },
      { code: 'disabled-link', enabled: 1, modules: '{"selfstudy":0}' },
      { code: 'enabled-link', enabled: 1, modules: { selfstudy: 1 } },
    ],
    selfstudy_tasks: [
      { id: 1, status: 'published' },
      { id: 2, status: 'draft' },
      { id: 3, status: 'published', deleted_at: '2026-11-20' },
    ],
  };
  const api = createStudentApiHandler({
    backendUrl: 'https://fixture.example',
    serviceKey: 'fixture',
    fetchImpl: async () => Response.json([{ payload }]),
  });
  for (const [code, expected] of [['legacy-link', 1], ['disabled-link', 0], ['enabled-link', 1]]) {
    const result = await api(new Request('https://fixture.example/public/link/' + code));
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.link.modules.selfstudy, expected);
    assert.deepEqual(data.selfstudyTasks.map(({ id }) => id), expected ? [1] : []);
  }
});
