import pg from 'pg';
export function pool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set - run ./scripts/db-up.sh');
  return new pg.Pool({ connectionString, max: 4 });
}
