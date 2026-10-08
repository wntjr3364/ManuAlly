import { DomainError, type Queryable } from '@pw/domain/shared/db.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

export interface Owner { id: string; username: string }

export async function ownerCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM owners');
  return rows[0]!.n;
}

export async function createOwner(db: Queryable, { username, password }: { username?: unknown; password?: unknown }): Promise<Owner> {
  if (typeof username !== 'string' || !/^[a-z0-9_.-]{3,64}$/.test(username)) throw new DomainError('INVALID', 'username: 3–64 characters a-z 0-9 _ . -', 'username');
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new DomainError('INVALID', 'password: at least 12 characters', 'password');
  const { rows } = await db.query<Owner>('INSERT INTO owners (username, password_hash) VALUES ($1, $2) RETURNING id, username', [username, await hashPassword(password)]);
  return rows[0]!;
}

// Same work whether or not the user exists, so timing does not reveal valid usernames.
const DUMMY_HASH = 'scrypt$16384$8$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);
export async function authenticate(db: Queryable, username: unknown, password: unknown): Promise<Owner | null> {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const { rows } = await db.query<Owner & { password_hash: string }>('SELECT id, username, password_hash FROM owners WHERE username = $1', [username]);
  const row = rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok ? { id: row.id, username: row.username } : null;
}
