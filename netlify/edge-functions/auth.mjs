// Simple shared-password gate for the whole site (HTTP Basic Auth).
// The password lives in the BOARD_PASSWORD env var on Netlify — never in code.
// Username is ignored; anything works. The browser prompts once and then
// attaches credentials to every same-origin request, including the board's
// fetches to /api/decisions. The daily audit runner authenticates the same
// way (curl -u audit:<password>).
export default async (req, context) => {
  const pass = Netlify.env.get('BOARD_PASSWORD');
  if (!pass) return context.next(); // no password configured → open
  const auth = req.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const idx = atob(auth.slice(6)).indexOf(':');
      const given = idx >= 0 ? atob(auth.slice(6)).slice(idx + 1) : '';
      if (given === pass) return context.next();
    } catch (_) { /* fall through to 401 */ }
  }
  return new Response('Password required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Short Pull Audit"' },
  });
};

export const config = { path: '/*' };
