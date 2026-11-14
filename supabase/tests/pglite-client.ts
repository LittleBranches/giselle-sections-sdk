import type { PGlite } from "@electric-sql/pglite";

import type { CmsRpcResult, CmsSupabaseClient, CmsTableQuery } from "../../src/cms/supabase-store";
import type { Row, Who } from "./harness";

// A stand-in for the Supabase client over the PGlite database, so the TypeScript store runs against the real SQL
// functions and grants. Each call runs in its own transaction as `who` (the role and the JWT claims set the way
// Supabase sets them) and is committed; a failure comes back as `{ code, message, details }`, as the client gives it.

const NAME = /^[a-z_][a-z0-9_]*$/;

async function asCaller<T>(db: PGlite, caller: Who, body: () => Promise<T>): Promise<{ value?: T; error?: CmsRpcResult["error"] }> {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${caller.role}`);
    await db.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.email', $2, true)`, [
      caller.uid ?? "",
      caller.uid ? `${caller.uid}@example.test` : "",
    ]);
    const value = await body();
    await db.exec("commit");
    return { value };
  } catch (error) {
    await db.exec("rollback");
    const e = error as Error & { code?: string; detail?: string; hint?: string };
    return { error: { code: e.code ?? null, message: e.message, details: e.detail ?? null, hint: e.hint ?? null } };
  }
}

const toParam = (value: unknown) => (value !== null && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : value);

/** `who` is read on every call, so a test can switch the caller between calls. */
export function pgliteClient(db: PGlite, who: () => Who): CmsSupabaseClient {
  return {
    async rpc(fn, args = {}) {
      if (!NAME.test(fn)) throw new Error(`not a function name: ${fn}`);
      const names = Object.keys(args);
      for (const name of names) if (!NAME.test(name)) throw new Error(`not an argument name: ${name}`);
      const call = `select * from public.${fn}(${names.map((name, index) => `${name} => $${index + 1}`).join(", ")})`;
      const outcome = await asCaller(db, who(), () => db.query<Row>(call, names.map((name) => toParam(args[name]))));
      if (outcome.error) return { data: null, error: outcome.error };
      const result = outcome.value!;
      // A function that returns one value (not a table) comes back from the client as that value.
      if (result.fields.length === 1 && result.fields[0]!.name === fn) return { data: result.rows[0]?.[fn] ?? null, error: null };
      return { data: result.rows, error: null };
    },
    from(table) {
      if (!NAME.test(table)) throw new Error(`not a table name: ${table}`);
      return {
        select(columns: string) {
          const filters: [string, unknown][] = [];
          const run = async (single: boolean): Promise<CmsRpcResult> => {
            const where = filters.length ? ` where ${filters.map(([column], index) => `${column} = $${index + 1}`).join(" and ")}` : "";
            const outcome = await asCaller(db, who(), () => db.query<Row>(`select ${columns} from public.${table}${where}`, filters.map(([, value]) => value)));
            if (outcome.error) return { data: null, error: outcome.error };
            return { data: single ? (outcome.value!.rows[0] ?? null) : outcome.value!.rows, error: null };
          };
          const query: CmsTableQuery = {
            eq(column, value) {
              if (!NAME.test(column)) throw new Error(`not a column name: ${column}`);
              filters.push([column, value]);
              return query;
            },
            maybeSingle: () => run(true),
            then: (onfulfilled, onrejected) => run(false).then(onfulfilled, onrejected),
          };
          return query;
        },
      };
    },
  };
}
