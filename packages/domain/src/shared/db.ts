// Minimal query interface so domain code does not depend on a specific driver.
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export class DomainError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'FORBIDDEN',
    message: string,
    public readonly field?: string,
  ) {
    super(message);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TxClient extends Queryable { release(): void }
export interface TxPool extends Queryable { connect(): Promise<TxClient> }

export async function inTransaction<T>(pool: TxPool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Text that PostgreSQL cannot store (and that has no place in user input).
export const hasNul = (s: string) => s.includes('\u0000');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// NUL and unpaired surrogates: PostgreSQL rejects them in jsonb and replaces them in text.
export const storable = (s: string) => !hasNul(s) && !LONE_SURROGATE.test(s);
