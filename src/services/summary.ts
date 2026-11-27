// The pair summary: contracts, decisions and Q&A as markdown, ready for a PR description.
import type { Db } from '../store/db.ts';
import { sanitize } from './sanitize.ts';
import { agentLabel } from './sessions.ts';

export async function pairSummaryMarkdown(db: Db, pairId: number): Promise<string> {
  const pair = await db.selectFrom('pairs').selectAll().where('id', '=', pairId).executeTakeFirstOrThrow();
  // Every session of the two people, so items and questions from an agent that was later replaced keep their name.
  const sessions = await db
    .selectFrom('sessions')
    .innerJoin('participants', 'participants.id', 'sessions.participant_id')
    .select(['sessions.id', 'sessions.agent_kind', 'participants.name', 'participants.id as person'])
    .where('participants.id', 'in', [pair.requester_id, pair.partner_id])
    .execute();
  const names = new Map(sessions.map((s) => [s.id, s.name]));
  const side = (person: number, sessionId: number | null) => {
    const name = sessions.find((s) => s.person === person)?.name ?? '?';
    const agent = sessions.find((s) => s.id === sessionId)?.agent_kind;
    return agent ? `${name} (${agentLabel(agent)})` : name;
  };

  const items = await db
    .selectFrom('board_items')
    .selectAll()
    .where('pair_id', '=', pairId)
    .orderBy('kind')
    .orderBy('key')
    .execute();
  const questions = await db
    .selectFrom('messages')
    .selectAll()
    .where('pair_id', '=', pairId)
    .where('kind', '=', 'question')
    .where('approval', 'in', ['none', 'approved'])
    .orderBy('id')
    .execute();
  const answers = await db
    .selectFrom('messages')
    .selectAll()
    .where('pair_id', '=', pairId)
    .where('kind', '=', 'answer')
    .where('approval', 'in', ['none', 'approved'])
    .execute();

  const text = (s: string) => sanitize(s, 4000);
  const minutes =
    pair.accepted_at && pair.ended_at
      ? `, ${Math.max(1, Math.round((pair.ended_at - pair.accepted_at) / 60_000))} min`
      : '';
  const lines = [
    `## Pair summary: ${text(pair.feature)}${pair.project ? ` (${pair.project})` : ''}`,
    '',
    `Paired with Pair41: ${side(pair.requester_id, pair.session_a_id)} and ${side(pair.partner_id, pair.session_b_id)}, ${new Date(pair.created_at).toISOString().slice(0, 10)}${minutes}.`,
  ];
  if (pair.summary) lines.push('', text(pair.summary));

  const section = (title: string, kind: string) => {
    const list = items.filter((i) => i.kind === kind);
    if (!list.length) return;
    lines.push('', `### ${title}`);
    for (const item of list) {
      lines.push(
        '',
        `**${text(item.key)}** (version ${item.version}, ${names.get(item.author_session_id) ?? '?'}): ${text(item.title)}`,
      );
      if (item.body.trim()) lines.push('', text(item.body));
    }
  };
  section('Contracts', 'contract');
  section('Decisions', 'decision');

  if (questions.length) {
    lines.push('', '### Questions and answers');
    for (const q of questions) {
      const answer = answers.find((x) => x.reply_to === q.id);
      lines.push('', `- **${names.get(q.sender_session_id!) ?? '?'} asked:** ${text(q.body)}`);
      if (answer)
        lines.push(`  **${names.get(answer.sender_session_id!) ?? '?'} answered:** ${text(answer.body)}`);
      else if (q.state === 'deferred') lines.push(`  _Deferred: ${text(q.state_reason ?? '')}_`);
      else lines.push('  _Not answered._');
    }
  }
  return lines.join('\n');
}
