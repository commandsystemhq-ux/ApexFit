import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// An in-process Postgres loaded with the real supabase/manual-setup.sql (only the Supabase-provided
// schemas are stubbed), plus a small supabase-js lookalike that runs every call as a given user
// through the "authenticated" role, so row-level security and function permissions are really enforced.

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  create schema storage;
  grant usage on schema auth, storage to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable security definer as $$ select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, jsonb_build_object('email', (select email from auth.users where id = auth.uid()))) $$;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  create schema realtime;
  grant usage on schema realtime to anon, authenticated, service_role;
  create table realtime.messages (id bigserial primary key, topic text not null, extension text not null, payload jsonb);
  alter table realtime.messages enable row level security;
  grant select, insert on realtime.messages to authenticated;
  grant usage on sequence realtime.messages_id_seq to authenticated;
  create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
  grant execute on function realtime.topic() to anon, authenticated, service_role;
`;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export async function createTestDatabase() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(readFileSync(new URL('../../supabase/manual-setup.sql', import.meta.url), 'utf8'));
  return db;
}

export async function addUser(db, { id, email, role, fullName = null, brandName = null, locale = 'en' }) {
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  const trial = role === 'coach';
  await db.query(
    `insert into public.profiles (id, role, locale, full_name, brand_name, trial_started_at, trial_ends_at)
     values ($1, $2, $3, $4, $5, ${trial ? 'now()' : 'null'}, ${trial ? "now() + interval '72 hours'" : 'null'})`,
    [id, role, locale, fullName, brandName],
  );
}

class Query {
  constructor(runner, table) {
    this.runner = runner;
    this.table = table;
    this.filters = [];
    this.params = [];
    this.orderBy = '';
    this.max = null;
    this.mode = 'select';
    this.columns = '*';
    this.single = null;
  }

  select(columns = '*') {
    if (columns !== '*' && !columns.split(',').every((column) => IDENTIFIER.test(column.trim()))) throw new Error(`Unsupported columns: ${columns}`);
    this.columns = columns;
    return this;
  }

  addFilter(column, operator, value) {
    if (!IDENTIFIER.test(column)) throw new Error(`Bad column ${column}`);
    this.params.push(value);
    this.filters.push(`${column} ${operator} $${this.params.length}`);
    return this;
  }

  eq(column, value) { return this.addFilter(column, '=', value); }
  ilike(column, value) { return this.addFilter(column, 'ilike', value); }
  order(column, { ascending = true } = {}) { this.orderBy = ` order by ${column} ${ascending ? 'asc' : 'desc'}`; return this; }
  limit(count) { this.max = count; return this; }
  maybeSingle() { this.single = 'maybe'; return this; }

  upsert(row, { onConflict } = {}) {
    this.mode = 'upsert';
    this.row = row;
    this.onConflict = onConflict;
    return this;
  }

  async execute() {
    if (this.mode === 'upsert') {
      const keys = Object.keys(this.row);
      keys.forEach((key) => { if (!IDENTIFIER.test(key)) throw new Error(`Bad column ${key}`); });
      const conflict = this.onConflict.split(',').map((column) => column.trim());
      const updates = keys.filter((key) => !conflict.includes(key)).map((key) => `${key} = excluded.${key}`).join(', ');
      return this.runner(
        `insert into public.${this.table} (${keys.join(', ')}) values (${keys.map((_, index) => `$${index + 1}`).join(', ')})
         on conflict (${conflict.join(', ')}) do update set ${updates}`,
        keys.map((key) => this.row[key]),
        'write',
      );
    }
    const where = this.filters.length ? ` where ${this.filters.join(' and ')}` : '';
    const limit = this.max ? ` limit ${Number(this.max)}` : '';
    const result = await this.runner(`select ${this.columns} from public.${this.table}${where}${this.orderBy}${limit}`, this.params, 'read');
    if (this.single === 'maybe' && !result.error) return { data: result.data[0] ?? null, error: null };
    return result;
  }

  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

// Returns an object with the subset of the supabase-js API the Jack tools use.
export function createUserClient(db, userId, { headers = null } = {}) {
  let queue = Promise.resolve();

  function runner(sql, params, kind) {
    const task = queue.then(async () => {
      await db.query("select set_config('test.uid', $1, false)", [userId]);
      await db.query("select set_config('request.headers', $1, false)", [headers ? JSON.stringify(headers) : '']);
      await db.exec('set role authenticated');
      try {
        const result = await db.query(sql, params);
        return { data: kind === 'write' ? null : result.rows, error: null, rows: result.rows };
      } catch (error) {
        return { data: null, error: { message: error.message }, rows: [] };
      } finally {
        await db.exec('reset role');
        await db.query("select set_config('test.uid', '', false)");
      }
    });
    queue = task.catch(() => {});
    return task;
  }

  return {
    from(table) {
      if (!IDENTIFIER.test(table)) throw new Error(`Bad table ${table}`);
      return new Query(runner, table);
    },
    async rpc(name, args = {}) {
      if (!IDENTIFIER.test(name)) throw new Error(`Bad function ${name}`);
      const keys = Object.keys(args);
      const params = keys.map((key) => {
        const value = args[key];
        // Arrays of plain strings are Postgres arrays (uuid[]); every other object or array is JSON.
        if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) return value;
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      });
      const call = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
      const result = await runner(`select public.${name}(${call}) as result`, params, 'read');
      if (result.error) return { data: null, error: result.error };
      return { data: result.rows[0]?.result ?? null, error: null };
    },
  };
}
