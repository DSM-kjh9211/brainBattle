/**
 * Database schema (PostgreSQL dialect; also runs unchanged on PGlite for dev/test).
 *
 * Conventions
 *  - text primary keys with a type prefix (q_, qs_, ses_, sq_, p_, sub_, rev_) — opaque to clients
 *  - protocol-critical instants are stored as bigint epoch milliseconds (*_ms) of the server clock,
 *    audit timestamps as timestamptz
 *  - flexible, versionable documents (content blocks, settings, snapshots) are jsonb
 *
 * Index strategy (hot real-time paths are served from the in-memory session actor; these indexes
 * make hydration after restart/failover and REST analytics O(rows of that session)):
 *  - participants of a session ............ sp_session_idx (session_id, joined_at_ms)
 *  - current ranking of a session .......... scores_ranking_idx (session_id, total_score DESC, …)
 *  - submissions of one student ............ submissions_session_p_idx (session_id, participant_id)
 *  - submissions of one question ........... submissions_session_q_idx (session_id, session_question_id)
 *  - per-session realtime statistics ....... same two indexes + in-memory aggregates
 *  - duplicate submit protection ........... submission_revisions (participant_id, idempotency_key) UNIQUE
 *  - one live answer per (student, question) submissions (participant_id, session_question_id) UNIQUE
 *  - join-code lookup of live sessions ..... sessions_join_code_live_uq partial UNIQUE
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE users (
  id             text PRIMARY KEY,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  display_name   text NOT NULL,
  role           text NOT NULL CHECK (role IN ('TEACHER','STUDENT','ADMIN')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE classrooms (
  id          text PRIMARY KEY,
  teacher_id  text NOT NULL REFERENCES users(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classrooms_teacher_idx ON classrooms (teacher_id);

CREATE TABLE classroom_members (
  classroom_id  text NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (classroom_id, user_id)
);
CREATE INDEX classroom_members_user_idx ON classroom_members (user_id);

CREATE TABLE questions (
  id                text PRIMARY KEY,
  owner_id          text NOT NULL REFERENCES users(id),
  display_number    text,
  type              text NOT NULL CHECK (type IN ('MULTIPLE_CHOICE','TRUE_FALSE','SHORT_ANSWER','NUMERIC','LATEX','ESSAY')),
  title             text,
  description       jsonb,
  choices           jsonb,
  correct_answer    jsonb,
  accepted_answers  jsonb NOT NULL DEFAULT '[]',
  grading           jsonb NOT NULL,
  score             numeric(10,2) NOT NULL DEFAULT 10,
  time_limit_sec    integer,
  explanation       jsonb,
  attachments       jsonb NOT NULL DEFAULT '[]',
  delivery_mode     text NOT NULL CHECK (delivery_mode IN ('DIGITAL','PAPER')),
  tags              jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX questions_owner_idx ON questions (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE question_sets (
  id             text PRIMARY KEY,
  owner_id       text NOT NULL REFERENCES users(id),
  title          text NOT NULL,
  description    text,
  delivery_mode  text NOT NULL,
  progress_mode  text NOT NULL,
  scoring_mode   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX question_sets_owner_idx ON question_sets (owner_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE question_set_questions (
  id              text PRIMARY KEY,
  set_id          text NOT NULL REFERENCES question_sets(id) ON DELETE CASCADE,
  question_id     text NOT NULL REFERENCES questions(id),
  position        integer NOT NULL,
  display_number  text,
  score_override  numeric(10,2),
  CONSTRAINT qsq_position_uq UNIQUE (set_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX qsq_question_idx ON question_set_questions (question_id);

CREATE TABLE sessions (
  id                text PRIMARY KEY,
  teacher_id        text NOT NULL REFERENCES users(id),
  question_set_id   text REFERENCES question_sets(id),
  title             text NOT NULL,
  join_code         text NOT NULL,
  preset            text NOT NULL,
  state             text NOT NULL CHECK (state IN ('CREATED','LOBBY','READY','ACTIVE','PAUSED','FINISHED')),
  settings          jsonb NOT NULL,
  current_sq_id     text,
  presentation      jsonb NOT NULL DEFAULT '{"view":"WAITING","sessionQuestionId":null}',
  started_at_ms     bigint,
  deadline_at_ms    bigint,
  pauses            jsonb NOT NULL DEFAULT '[]',
  locked_at_ms      bigint,
  finished_at_ms    bigint,
  results_released  boolean NOT NULL DEFAULT false,
  event_seq         bigint NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- a join code is unique among sessions that can still be joined; finished sessions release it
CREATE UNIQUE INDEX sessions_join_code_live_uq ON sessions (join_code) WHERE state <> 'FINISHED';
CREATE INDEX sessions_teacher_idx ON sessions (teacher_id, created_at DESC);

CREATE TABLE session_questions (
  id              text PRIMARY KEY,
  session_id      text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id     text NOT NULL,
  position        integer NOT NULL,
  display_number  text NOT NULL,
  snapshot        jsonb NOT NULL,
  max_score       numeric(10,2) NOT NULL,
  time_limit_sec  integer,
  phase           text NOT NULL DEFAULT 'PENDING' CHECK (phase IN ('PENDING','PREPARE','ACTIVE','LOCKED','RESULT')),
  opens_at_ms     bigint,
  started_at_ms   bigint,
  deadline_at_ms  bigint,
  locked_at_ms    bigint,
  pauses          jsonb NOT NULL DEFAULT '[]',
  UNIQUE (session_id, position)
);

CREATE TABLE session_participants (
  id                  text PRIMARY KEY,
  session_id          text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id             text REFERENCES users(id),
  nickname            text NOT NULL,
  nickname_key        text NOT NULL,
  is_guest            boolean NOT NULL,
  status              text NOT NULL CHECK (status IN ('CONNECTED','DISCONNECTED','RECONNECTING','LEFT','KICKED')),
  resume_token_hash   text NOT NULL,
  joined_at_ms        bigint NOT NULL,
  last_seen_at_ms     bigint,
  disconnected_at_ms  bigint,
  current_sq_id       text,
  -- FREE progress bookkeeping, e.g. {"finalized":["sq_…"]} for the UNTIL_QUESTION_END edit policy
  progress            jsonb NOT NULL DEFAULT '{}',
  clock_sync          jsonb NOT NULL DEFAULT '{}',
  join_ip             text
);
CREATE INDEX sp_session_idx ON session_participants (session_id, joined_at_ms);
CREATE UNIQUE INDEX sp_session_user_uq ON session_participants (session_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX sp_resume_token_uq ON session_participants (resume_token_hash);
CREATE INDEX sp_session_nickname_idx ON session_participants (session_id, nickname_key);

CREATE TABLE submissions (
  id                         text PRIMARY KEY,
  session_id                 text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id             text NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  session_question_id        text NOT NULL REFERENCES session_questions(id) ON DELETE CASCADE,
  answer                     jsonb NOT NULL,
  normalized                 text,
  revision                   integer NOT NULL,
  client_sent_at_ms          bigint,
  server_received_at_ms      bigint NOT NULL,
  effective_submitted_at_ms  bigint NOT NULL,
  timestamp_source           text NOT NULL CHECK (timestamp_source IN ('CLIENT_TRUSTED','SERVER_FALLBACK')),
  timestamp_reason           text NOT NULL,
  response_ms                bigint,
  is_correct                 boolean,
  auto_score                 numeric(10,2),
  manual_score               numeric(10,2),
  final_score                numeric(10,2) NOT NULL DEFAULT 0,
  grading_status             text NOT NULL CHECK (grading_status IN ('AUTO_GRADED','PENDING_MANUAL','MANUALLY_GRADED')),
  feedback                   text,
  graded_by                  text,
  graded_at_ms               bigint,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submissions_one_per_question UNIQUE (participant_id, session_question_id)
);
CREATE INDEX submissions_session_q_idx ON submissions (session_id, session_question_id);
CREATE INDEX submissions_session_p_idx ON submissions (session_id, participant_id);

CREATE TABLE submission_revisions (
  id                         text PRIMARY KEY,
  submission_id              text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  session_id                 text NOT NULL,
  participant_id             text NOT NULL,
  session_question_id        text NOT NULL,
  revision                   integer NOT NULL,
  answer                     jsonb NOT NULL,
  normalized                 text,
  client_sent_at_ms          bigint,
  client_mono_at             double precision,
  clock_epoch_id             text,
  server_received_at_ms      bigint NOT NULL,
  effective_submitted_at_ms  bigint NOT NULL,
  timestamp_source           text NOT NULL,
  timestamp_reason           text NOT NULL,
  idempotency_key            text NOT NULL,
  is_replay                  boolean NOT NULL DEFAULT false,
  is_correct                 boolean,
  auto_score                 numeric(10,2),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, revision),
  UNIQUE (participant_id, idempotency_key)
);

CREATE TABLE scores (
  session_id           text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id       text NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  total_score          numeric(12,2) NOT NULL DEFAULT 0,
  correct_count        integer NOT NULL DEFAULT 0,
  answered_count       integer NOT NULL DEFAULT 0,
  last_scored_at_ms    bigint,
  last_correct_at_ms   bigint,
  total_response_ms    bigint NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, participant_id)
);
CREATE INDEX scores_ranking_idx ON scores (session_id, total_score DESC, correct_count DESC, last_scored_at_ms ASC);

CREATE TABLE leaderboard_snapshots (
  id           bigserial PRIMARY KEY,
  session_id   text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version      bigint NOT NULL,
  reason       text NOT NULL,
  entries      jsonb NOT NULL,
  taken_at_ms  bigint NOT NULL
);
CREATE INDEX lbs_session_idx ON leaderboard_snapshots (session_id, taken_at_ms DESC);

CREATE TABLE session_events (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  type        text NOT NULL,
  actor_type  text NOT NULL,
  actor_id    text,
  payload     jsonb NOT NULL DEFAULT '{}',
  at_ms       bigint NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  actor_id     text,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  ip           text,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);

-- Session ownership for horizontal scaling: exactly one battle node owns a live session.
CREATE TABLE session_leases (
  session_id     text PRIMARY KEY,
  node_id        text NOT NULL,
  node_url       text,
  expires_at_ms  bigint NOT NULL
);
`,
  },
];
