// What the server knows about the partner, for receipts and pair_status. Facts only, never hopes.
import type { Db } from '../store/db.ts';
import type { Message, Pair } from '../store/schema.ts';
import { ref } from './errors.ts';
import { partnerSessionId } from './pairs.ts';
import { describeReplyTimes, replyTimes } from './reply-times.ts';
import { agentLabel, presence, viewSession } from './sessions.ts';
import { isListening } from './wake.ts';

export async function partnerStatus(db: Db, pair: Pair, mySessionId: number) {
  const partner = await viewSession(db, partnerSessionId(pair, mySessionId));
  const s = partner.session;
  const typical = await replyTimes(db, s.participant_id, s.agent_kind);
  return {
    name: partner.name,
    agent: partner.agent,
    session: ref('s', s.id),
    state: s.state,
    status: presence(s),
    ...(s.activity ? { activity: s.activity } : {}),
    ...(s.state === 'idle' && s.turn_ended_at
      ? { turn_ended_seconds_ago: Math.round((Date.now() - s.turn_ended_at) / 1000) }
      : {}),
    bridge: s.bridge_connected === 1 ? 'connected' : 'off',
    wake: isListening(s.id) ? 'listening' : 'off',
    human_online: partner.humanOnline,
    ...(typical ? { typical_reply: typical } : {}),
  };
}

/** The receipt for send_message: stored, plus what will happen next, from what the server can observe. */
export async function receipt(db: Db, pair: Pair, mySessionId: number, message: Message) {
  const partner = await partnerStatus(db, pair, mySessionId);
  const who = `${partner.name}'s ${agentLabel(partner.agent)}`;
  const pushable = message.kind !== 'chat';
  let delivery: string;
  if (message.approval === 'pending') {
    delivery =
      'Waiting for your human to approve it on the Pair41 page; your partner sees nothing until then.';
  } else if (partner.state === 'closed' || partner.status === 'offline') {
    delivery = `${who} session is closed. It is shown on the Pair41 page and waits for their next session.`;
  } else if (partner.bridge === 'connected') {
    delivery = `Will be pushed to ${who} session${pushable ? '' : ' (chat is batched, at most every 30 s)'} and shown on the Pair41 page.`;
  } else if (partner.wake === 'listening') {
    delivery = pushable
      ? `${who} session is listening: Pair41 wakes it once for this. Also shown on the Pair41 page.`
      : `${who} session is listening, but chat does not wake it: it sees this at its next Pair41 call or hook. Also shown on the Pair41 page.`;
  } else if (partner.state === 'busy') {
    delivery = `${who} is busy; it sees this at its next Pair41 call or hook. Also shown on the Pair41 page.`;
  } else {
    delivery = `${who} is idle and cannot be woken from here. It is shown on the Pair41 page, where ${partner.name} can tell it "check pair".`;
  }
  if (partner.typical_reply && message.kind === 'question') {
    delivery += ` ${who} ${describeReplyTimes(partner.typical_reply)}.`;
  }
  const id = ref('m', message.id);
  return {
    message_id: id,
    status: 'stored',
    partner,
    delivery,
    next:
      message.kind === 'question'
        ? `Carry on, or call wait_for_reply("${id}"). The answer will reach you either way.`
        : 'Carry on.',
  };
}
