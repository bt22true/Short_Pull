// Decisions store: the board saves triage decisions + "do the work" check-offs
// here (Netlify Blobs), so they survive daily redeploys and work across
// devices. The daily audit run GETs this, merges it into committed state, and
// PUTs back the not-yet-consumed remainder. Access control is the site-wide
// basic-auth edge function; this endpoint holds no extra secrets.
import { getStore } from '@netlify/blobs';

const KEY = 'decisions';

export default async (req) => {
  const store = getStore({ name: 'short-pull-audit', consistency: 'strong' });
  if (req.method === 'GET') {
    const data = await store.get(KEY, { type: 'json' });
    return Response.json(data || { decisions: [], completed: {} });
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (_) { body = null; }
    if (!body || !Array.isArray(body.decisions)) return new Response('bad payload', { status: 400 });
    await store.setJSON(KEY, {
      decisions: body.decisions,
      completed: body.completed || {},
      run_id: body.run_id || null,
      updated_at: new Date().toISOString(),
    });
    return Response.json({ ok: true, saved: body.decisions.length });
  }
  return new Response('method not allowed', { status: 405 });
};

export const config = { path: '/api/decisions' };
