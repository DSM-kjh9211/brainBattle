import { AppError, type UserDTO, type UserRole } from '@brainbattle/shared';
import type { Db, Queryable } from '../db/db.js';
import { isUniqueViolation } from '../db/db.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { newId } from '../lib/util.js';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
}

let dummyHash: Promise<string> | undefined;

const toDTO = (r: UserRow): UserDTO => ({ id: r.id, email: r.email, displayName: r.display_name, role: r.role });

export class UserRepository {
  constructor(private readonly db: Db) {}

  async create(input: { email: string; password: string; displayName: string; role: UserRole }): Promise<UserDTO> {
    const hash = await hashPassword(input.password);
    try {
      const { rows } = await this.db.query<UserRow>(
        `INSERT INTO users (id, email, password_hash, display_name, role) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [newId('usr', 6), input.email.trim(), hash, input.displayName.trim(), input.role],
      );
      return toDTO(rows[0]!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('CONFLICT', 'email already registered');
      throw e;
    }
  }

  async authenticate(email: string, password: string): Promise<UserDTO> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email.trim()]);
    const row = rows[0];
    // same bcrypt work for unknown emails (avoid user enumeration by timing)
    dummyHash ??= hashPassword('brainbattle-dummy-password');
    const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash));
    if (!row || !ok) throw new AppError('UNAUTHENTICATED', 'invalid email or password');
    return toDTO(row);
  }

  async get(id: string, q: Queryable = this.db): Promise<UserDTO | null> {
    const { rows } = await q.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toDTO(rows[0]) : null;
  }

  async findByEmail(email: string): Promise<UserDTO | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    return rows[0] ? toDTO(rows[0]) : null;
  }
}

export class ClassroomRepository {
  constructor(private readonly db: Db) {}

  async list(teacherId: string) {
    const { rows } = await this.db.query<{ id: string; name: string; member_count: number }>(
      `SELECT c.id, c.name, (SELECT count(*) FROM classroom_members m WHERE m.classroom_id = c.id)::int AS member_count
         FROM classrooms c WHERE c.teacher_id = $1 ORDER BY c.created_at DESC`,
      [teacherId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, memberCount: Number(r.member_count) }));
  }

  async create(teacherId: string, name: string) {
    const id = newId('cls', 6);
    await this.db.query('INSERT INTO classrooms (id, teacher_id, name) VALUES ($1,$2,$3)', [id, teacherId, name]);
    return { id, name, memberCount: 0 };
  }

  async assertOwner(classroomId: string, teacherId: string): Promise<void> {
    const { rows } = await this.db.query<{ teacher_id: string }>('SELECT teacher_id FROM classrooms WHERE id = $1', [
      classroomId,
    ]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'classroom not found');
    if (rows[0].teacher_id !== teacherId) throw new AppError('FORBIDDEN', 'not your classroom');
  }

  async members(classroomId: string) {
    const { rows } = await this.db.query<UserRow>(
      `SELECT u.* FROM classroom_members m JOIN users u ON u.id = m.user_id WHERE m.classroom_id = $1 ORDER BY u.display_name`,
      [classroomId],
    );
    return rows.map(toDTO);
  }

  async addMember(classroomId: string, userId: string): Promise<void> {
    await this.db.query('INSERT INTO classroom_members (classroom_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      classroomId,
      userId,
    ]);
  }

  async removeMember(classroomId: string, userId: string): Promise<void> {
    await this.db.query('DELETE FROM classroom_members WHERE classroom_id = $1 AND user_id = $2', [classroomId, userId]);
  }

  async isMember(classroomId: string, userId: string, q: Queryable = this.db): Promise<boolean> {
    const { rows } = await q.query('SELECT 1 FROM classroom_members WHERE classroom_id = $1 AND user_id = $2', [
      classroomId,
      userId,
    ]);
    return rows.length > 0;
  }
}

export class AuditLog {
  constructor(private readonly db: Db) {}

  async record(entry: {
    actorId: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    ip?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.db.query(
        'INSERT INTO audit_logs (actor_id, action, target_type, target_id, ip, details) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          entry.actorId,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.ip ?? null,
          entry.details ? JSON.stringify(entry.details) : null,
        ],
      );
    } catch {
      // audit logging must never break the request path
    }
  }
}
