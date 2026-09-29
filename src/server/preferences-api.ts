import type { DatabaseSync } from "node:sqlite";
import type { Router } from "./router.ts";
import { json } from "./router.ts";
import { authenticate, checkCsrf } from "./auth.ts";
import { readJson } from "./body.ts";
import { getPreferences, isPreferenceKey, isPreferenceValue, setPreference, PREFERENCES } from "../core/preferences.ts";

export interface PreferencesApiDeps {
  db: DatabaseSync;
  origin: string;
}

/**
 * GET /api/preferences            -> { preferences: {key: value, ...} }
 * PUT /api/preferences {key,value} -> the same, after the write.
 *
 * Session or bearer, like every read; the write needs CSRF like every
 * other mutating route. An unknown key or a value outside the key's
 * allowed set is refused with 400 -- a typo that silently persists is a
 * preference the owner sets and never sees applied.
 */
export function registerPreferenceRoutes(router: Router, deps: PreferencesApiDeps): void {
  router.add("GET", "/api/preferences", (c) => {
    if (!authenticate(deps.db, c.req)) return void json(c.res, 401, { error: "unauthorized" });
    json(c.res, 200, { preferences: getPreferences(deps.db) });
  });

  router.add("PUT", "/api/preferences", async (c) => {
    if (!authenticate(deps.db, c.req)) return void json(c.res, 401, { error: "unauthorized" });
    if (!checkCsrf(c.req, deps.origin)) return void json(c.res, 403, { error: "forbidden" });
    let body: Record<string, unknown> | null;
    try {
      body = (await readJson(c.req)) as Record<string, unknown> | null;
    } catch {
      return void json(c.res, 400, { error: "invalid json" });
    }
    const key = typeof body?.["key"] === "string" ? (body["key"] as string) : "";
    const value = typeof body?.["value"] === "string" ? (body["value"] as string) : "";
    if (!isPreferenceKey(key)) return void json(c.res, 400, { error: `unknown preference "${key}"` });
    if (!isPreferenceValue(key, value)) {
      return void json(c.res, 400, { error: `${key} must be one of ${PREFERENCES[key].values.join(", ")}` });
    }
    setPreference(deps.db, key, value);
    json(c.res, 200, { preferences: getPreferences(deps.db) });
  });
}
