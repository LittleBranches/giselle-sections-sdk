import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

// A throwaway copy of the database for the tests: PGlite is Postgres running in memory. Only what Supabase provides is
// stood in for (the `anon` and `authenticated` roles, `auth.users`, `auth.uid()` and `auth.jwt()` read from request
// settings the way Supabase does, and the `storage` schema); every real migration file is applied, in order, as it is.

export const MIGRATIONS = join(__dirname, "..", "migrations");

export const OWNER = "00000000-0000-4000-8000-000000000001";
export const EDITOR = "00000000-0000-4000-8000-000000000002";
export const MEMBER = "00000000-0000-4000-8000-000000000003";
export const STRANGER = "00000000-0000-4000-8000-000000000004"; // signed in, but not in the members table

export type Who = { role: "anon" | "authenticated"; uid?: string };
export const visitor: Who = { role: "anon" };
export const as = (uid: string): Who => ({ role: "authenticated", uid });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Outcome = { rows: Row[]; error?: string; code?: string; detail?: string };

export const migrationFiles = () => readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort();
export const readMigration = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");

// What Supabase has already made before any migration of ours runs.
export const SUPABASE_STANDIN_SQL = `
  create role anon nologin;
  create role authenticated nologin;

  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable
    as $$ select jsonb_build_object('email', nullif(current_setting('request.jwt.claim.email', true), '')) $$;

  -- What Supabase grants by default: both roles may touch what is made in public, and our files then take rights away.
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;

  insert into auth.users (id) values ('${OWNER}'), ('${EDITOR}'), ('${MEMBER}'), ('${STRANGER}');

  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id bigint generated always as identity primary key,
    bucket_id text references storage.buckets (id),
    name text not null,
    owner uuid,
    created_at timestamptz not null default now()
  );
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated;
`;

export const MEMBERS_SQL = `
  insert into site_members (user_id, role) values ('${OWNER}', 'owner'), ('${EDITOR}', 'editor'), ('${MEMBER}', 'member');
`;

export function createDatabase(db = new PGlite()) {
  // Runs one statement as someone. `keep` commits it so a later statement sees it; otherwise it is rolled back.
  async function run(who: Who, sql: string, keep = false): Promise<Outcome> {
    await db.exec("begin");
    try {
      await db.exec(`set local role ${who.role}`);
      await db.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.email', $2, true)`, [
        who.uid ?? "",
        who.uid ? `${who.uid}@example.test` : "",
      ]);
      const result = await db.query<Row>(sql);
      await db.exec(keep ? "commit" : "rollback");
      return { rows: result.rows };
    } catch (error) {
      await db.exec("rollback");
      const e = error as Error & { code?: string; detail?: string };
      return { rows: [], error: e.message, code: e.code, detail: e.detail };
    }
  }

  // Runs one statement as the database owner (to look inside, or to try what the API roles cannot).
  async function admin(sql: string): Promise<Outcome> {
    try {
      const result = await db.query<Row>(sql);
      return { rows: result.rows };
    } catch (error) {
      const e = error as Error & { code?: string; detail?: string };
      return { rows: [], error: e.message, code: e.code, detail: e.detail };
    }
  }

  // The whole database as production would have it after every migration, with the members filled in.
  async function setup(options: { upTo?: string } = {}) {
    await db.exec(SUPABASE_STANDIN_SQL);
    for (const file of migrationFiles()) {
      if (options.upTo && file > options.upTo) break;
      await db.exec(readMigration(file));
    }
    if (!options.upTo || options.upTo >= "20261115000100") await db.exec(MEMBERS_SQL);
  }

  // Tiny builders, so a test reads as what it does.
  const lit = (value: unknown) => (value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`);
  const json = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  const uuids = (ids: string[]) => (ids.length ? `array[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]` : "'{}'::uuid[]");
  const int = (value: number | null) => (value === null ? "null" : String(value));

  const sql = {
    createItem: (type: string, title: string, reusable: boolean, translatable: boolean) =>
      `select * from cms_create_item(${lit(type)}, ${lit(title)}, ${reusable}, ${translatable})`,
    save: (item: string, language: string, base: number | null, content: object, refs: string[] = []) =>
      `select cms_save_item_draft('${item}', ${lit(language)}, ${int(base)}, ${json(content)}, ${uuids(refs)}) as v`,
    publish: (item: string, language: string, version: number) => `select cms_publish_item('${item}', ${lit(language)}, ${version})`,
    restore: (item: string, language: string, version: number, base: number | null) =>
      `select cms_restore_item('${item}', ${lit(language)}, ${version}, ${int(base)}) as v`,
    saveLayout: (page: string, base: number | null, content: object, refs: string[] = []) =>
      `select cms_save_layout_draft(${lit(page)}, ${int(base)}, ${json(content)}, ${uuids(refs)}) as v`,
    publishLayout: (page: string, version: number) => `select cms_publish_layout(${lit(page)}, ${version})`,
    restoreLayout: (page: string, version: number, base: number | null) => `select cms_restore_layout(${lit(page)}, ${version}, ${int(base)}) as v`,
  };

  // Setup helpers that act as the editor and commit; they fail loudly, since a setup that fails hides the test.
  async function must(who: Who, statement: string): Promise<Row[]> {
    const outcome = await run(who, statement, true);
    if (outcome.error) throw new Error(`${statement}\n-> ${outcome.error} ${outcome.detail ?? ""}`);
    return outcome.rows;
  }
  async function makeItem(type: string, title: string, options: { reusable?: boolean; translatable?: boolean; by?: Who } = {}): Promise<string> {
    const rows = await must(options.by ?? as(EDITOR), sql.createItem(type, title, options.reusable ?? false, options.translatable ?? true));
    return rows[0]!.id as string;
  }
  async function saveAndPublish(item: string, language: string, content: object, refs: string[] = [], by: Who = as(EDITOR)): Promise<number> {
    const newest = await admin(
      `select coalesce(max(v.version), 0) as v from cms_item_versions v join cms_item_entries e on e.id = v.entry_id where e.item_id = '${item}' and e.language = ${lit(language)}`,
    );
    const base = Number(newest.rows[0]!.v) || null;
    const saved = await must(by, sql.save(item, language, base, content, refs));
    const version = saved[0]!.v as number;
    await must(by, sql.publish(item, language, version));
    return version;
  }

  return { db, run, admin, setup, must, makeItem, saveAndPublish, sql, lit, json, uuids };
}

export const parse = (text: string | undefined) => (text ? JSON.parse(text) : undefined);
