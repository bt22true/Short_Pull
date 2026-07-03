#!/usr/bin/env node
// Stage the built board for Netlify: site/index.html is what gets deployed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

if (!existsSync('dist/board.html')) {
  console.error('dist/board.html missing — run build-board.mjs first');
  process.exit(1);
}
if (!existsSync('site')) mkdirSync('site', { recursive: true });
writeFileSync('site/index.html', readFileSync('dist/board.html'));
console.log('site/index.html staged for deploy');
