// Board data store: the page is a static shell that fetches its data from
// here, so the daily refresh is ONE authenticated PUT of fresh JSON — no
// Netlify build, no redeploy. Redeploys only happen when the board code
// itself changes. Access control is the site-wide basic-auth edge function.
import { getStore } from '@netlify/blobs';

const KEY = 'board';

export default async (req) => {
  const store = getStore({ name: 'short-pull-audit', consistency: 'strong' });
  if (req.method === 'GET') {
    const data = await store.get(KEY, { type: 'json' });
    if (!data) return new Response('no board data published yet', { status: 404 });
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (_) { body = null; }
    if (!body || !body.run_id || !Array.isArray(body.lics)) return new Response('bad payload', { status: 400 });
    await store.setJSON(KEY, body);
    return Response.json({ ok: true, run_id: body.run_id, lics: body.lics.length });
  }
  return new Response('method not allowed', { status: 405 });
};

export const config = { path: '/api/board' };
