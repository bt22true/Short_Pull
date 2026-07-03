#!/usr/bin/env node
// Stage the board SHELL for Netlify: site/index.html is the raw template with
// NO data inlined — the live page fetches its data from /api/board. Only run
// this (and redeploy) when scripts/lib/template.html or netlify/* changed;
// a data-only refresh is a PUT of dist/board-data.json to /api/board.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tpl = readFileSync(join(here, 'lib', 'template.html'), 'utf8');
if (!tpl.includes('/*__DATA__*/null')) {
  console.error('template.html is missing the /*__DATA__*/null slot — the shell would ship stale inlined data');
  process.exit(1);
}
if (!existsSync('site')) mkdirSync('site', { recursive: true });
writeFileSync('site/index.html', tpl);
console.log('site/index.html staged (shell only — data comes from /api/board)');
