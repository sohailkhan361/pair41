// Table types for Kysely. Times are epoch milliseconds; booleans are 0/1.
import type { Generated, Insertable, Selectable } from 'kysely';

export interface ParticipantTable {
  id: Generated<number>;
  name: string;
  password_hash: string;
  token_hash: string;
  share_conversation: Generated<number>;
  approve_before_send: Generated<number>;
  last_web_at: number | null;
  created_at: number;
}

export interface WebSessionTable {
  id: Generated<number>;
  participant_id: number;
  token_hash: string;
  expires_at: number;
  created_at: number;
}

export interface ProjectTable {
  id: Generated<number>;
  name: string;
  created_at: number;
}

export type SessionState = 'busy' | 'idle' | 'closed';

export interface SessionTable {
  id: Generated<number>;
  participant_id: number;
  project: string;
  agent_kind: string;
  agent_session_id: string | null;
  /** The model the session runs, from its hooks (e.g. claude-sonnet-5-5, gpt-6.2-sol), when they say. */
  model: string | null;
  cwd: string | null;
  state: SessionState;
  bridge_connected: Generated<number>;
  activity: string | null;
  started_at: number;
  ended_at: number | null;
  last_seen_at: number;
  turn_ended_at: number | null;
  msg_cursor: Generated<number>;
  notified_upto: Generated<number>;
  request_notified_upto: Generated<number>;
  feed_seen_upto: Generated<number>;
  edits_since_progress: Generated<number>;
  /** The newest message this session was woken for (docs/specs/protocol.md, "Wake"). */
  woken_upto: Generated<number>;
  /** Wakes since this session's human last sent a prompt: the loop guard. */
  wakes_since_prompt: Generated<number>;
}

/** requested → active (both people agreed) → ended; or declined. */
export type PairStatus = 'requested' | 'active' | 'declined' | 'ended';

/**
 * A pair is between two people (the same person twice for a solo pair). Each attaches their own agent session to
 * their side; the agents can talk once both sides have one.
 */
export interface PairTable {
  id: Generated<number>;
  /** What each person tells their agent to join their side ("join Pair41 pair amber-otter-42"). Unique. */
  code: string;
  feature: string;
  /** Who asked (side a) and who was asked (side b). */
  requester_id: number;
  partner_id: number;
  /** The agent session attached on each side, or null until its person attaches one. */
  session_a_id: number | null;
  session_b_id: number | null;
  /** The project of the first agent attached. */
  project: string | null;
  status: PairStatus;
  created_at: number;
  accepted_at: number | null;
  ended_at: number | null;
  /** Who ended (or declined, or withdrew) the pair: a participant id. */
  ended_by: number | null;
  summary: string | null;
}

export type MessageKind = 'chat' | 'question' | 'answer' | 'system';
export type SenderKind = 'agent' | 'human' | 'system';
/** closed: a person closed it on the Pair41 page because the pair moved past it (docs/specs/web.md). */
export type QuestionState = 'open' | 'answered' | 'deferred' | 'closed';
export type Approval = 'none' | 'pending' | 'approved' | 'rejected';

export interface MessageTable {
  id: Generated<number>;
  pair_id: number;
  sender_kind: SenderKind;
  sender_session_id: number | null;
  sender_participant_id: number | null;
  recipient_session_id: number | null;
  kind: MessageKind;
  /** For system messages: what it is about (contract, board, ack, defer, same-file). */
  topic: string | null;
  body: string;
  reply_to: number | null;
  state: QuestionState | null;
  state_reason: string | null;
  stop_raised_at: number | null;
  approval: Generated<Approval>;
  created_at: number;
  answered_at: number | null;
}

export type Route = 'tool' | 'hook' | 'socket' | 'wake';
export type AttemptResult = 'returned' | 'shown' | 'written' | 'error';

export interface DeliveryAttemptTable {
  id: Generated<number>;
  message_id: number;
  session_id: number;
  route: Route;
  result: AttemptResult;
  detail: string | null;
  created_at: number;
}

export type ActionKind = 'acknowledge' | 'answer' | 'defer';

export interface MessageActionTable {
  id: Generated<number>;
  message_id: number;
  session_id: number;
  action: ActionKind;
  eta_minutes: number | null;
  note: string | null;
  created_at: number;
}

export type BoardKind = 'contract' | 'decision' | 'progress' | 'todo';

export interface BoardItemTable {
  id: Generated<number>;
  pair_id: number;
  author_session_id: number;
  kind: BoardKind;
  key: string;
  title: string;
  body: string;
  files: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export type ActivityKind = 'prompt' | 'reply' | 'commit' | 'file' | 'board' | 'activity';

export interface ActivityTable {
  id: Generated<number>;
  pair_id: number;
  session_id: number;
  kind: ActivityKind;
  detail: string;
  created_at: number;
}

export interface PairFeedbackTable {
  id: Generated<number>;
  pair_id: number;
  participant_id: number;
  helpful: number;
  note: string | null;
  created_at: number;
}

export interface FileWarningTable {
  id: Generated<number>;
  pair_id: number;
  path: string;
  created_at: number;
}

/** When a person last opened a pair's room: Needs you items older than this count as seen. */
export interface PairViewTable {
  id: Generated<number>;
  pair_id: number;
  participant_id: number;
  seen_at: number;
}

/** One person nudging the other in a pair (docs/specs/web.md, "Nudge"). */
export interface NudgeTable {
  id: Generated<number>;
  pair_id: number;
  from_participant_id: number;
  to_participant_id: number;
  created_at: number;
}

export interface Database {
  participants: ParticipantTable;
  web_sessions: WebSessionTable;
  projects: ProjectTable;
  sessions: SessionTable;
  pairs: PairTable;
  messages: MessageTable;
  delivery_attempts: DeliveryAttemptTable;
  message_actions: MessageActionTable;
  board_items: BoardItemTable;
  activity: ActivityTable;
  pair_feedback: PairFeedbackTable;
  file_warnings: FileWarningTable;
  pair_views: PairViewTable;
  nudges: NudgeTable;
}

export type Participant = Selectable<ParticipantTable>;
export type Session = Selectable<SessionTable>;
export type Pair = Selectable<PairTable>;
export type Message = Selectable<MessageTable>;
export type BoardItem = Selectable<BoardItemTable>;
export type Activity = Selectable<ActivityTable>;
export type NewMessage = Insertable<MessageTable>;
