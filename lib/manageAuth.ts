/**
 * Server-side identification of a /manage user (#21 §3).
 *
 * The dashboard is a browser app that keeps its Supabase session in local storage, not in
 * a cookie, so a route handler cannot read it from the request on its own. The two routes
 * that must run server-side — the repo picker and the link save, because both have to ask
 * GitHub what the installation actually contains — therefore take the session's access
 * token in an `Authorization: Bearer` header and verify it here with Supabase Auth.
 *
 * This returns an identity and nothing more. Authorization is a separate step, decided in
 * the database by `is_entity_admin_profile`, so a valid token for some other workspace's
 * user buys nothing.
 */

import { createClient } from '@supabase/supabase-js';

/**
 * The profile id behind a request's bearer token, or null when there is no usable token.
 * `profiles.id` is `auth.users.id`, so the verified user id is the profile id.
 */
export async function getProfileIdFromRequest(req: Request): Promise<string | null> {
  const header = req.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  const accessToken = header.slice(7).trim();
  if (!accessToken) {
    return null;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    console.error('Supabase URL / publishable key are not set; cannot verify a /manage session.');
    return null;
  }

  // The publishable key resolves to the `anon` role and is enforced by RLS; the token is
  // what identifies the user. No service-role key is involved, here or anywhere else.
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) {
    return null;
  }

  return data.user.id;
}
