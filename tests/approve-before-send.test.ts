// PLAN.md §8.4 P1, approve before send: an unapproved message is not visible to the partner.
import { afterAll, expect, it } from 'vitest';
import { pairedAgents, startServer, webLogin } from './helpers.ts';

const server = await startServer();
afterAll(() => server.close());

it('keeps a message from the partner until its sender approves it on the web page', async () => {
  const { amish, sam, pairId } = await pairedAgents(server);
  const amishWeb = await webLogin(server, 'amish');
  expect((await amishWeb.post('/settings/approval', { approve: 'on' })).status).toBe(303);

  const sent = await amish.call('send_message', {
    kind: 'question',
    text: 'NEEDS-APPROVAL: cents or decimals?',
  });
  expect(sent.data.delivery).toMatch(/approve/);

  const samWeb = await webLogin(server, 'sam');
  const roomPath = `/pairs/${pairId.replace('p_', '')}/live`;
  const hiddenFromSam = async () => {
    const checked = JSON.stringify((await sam.call('check_messages', { cursor: 0 })).data);
    const status = JSON.stringify((await sam.call('pair_status')).data);
    const room = (await samWeb.get(roomPath)).text;
    const direct = await sam.call('get_message', { message_id: sent.data.message_id });
    return (
      !checked.includes('NEEDS-APPROVAL') &&
      !status.includes('NEEDS-APPROVAL') &&
      !room.includes('NEEDS-APPROVAL') &&
      direct.isError
    );
  };
  expect(await hiddenFromSam()).toBe(true);
  expect((await amishWeb.get(roomPath)).text).toContain('NEEDS-APPROVAL');

  const id = sent.data.message_id.replace('m_', '');
  expect((await amishWeb.post(`/messages/${id}/approve`, { decision: 'approve' })).status).toBe(303);
  expect(await hiddenFromSam()).toBe(false);
  expect(JSON.stringify((await sam.call('check_messages', { cursor: 0 })).data)).toContain('NEEDS-APPROVAL');
});
