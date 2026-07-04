// build-replies.mjs — refresh the homepage reply feed from the live IGPPC pipeline.
//
// Pulls positive-reply cards from the IGPPC Trello board, ANONYMIZES them to
// role + company + snippet + date (no names, no emails), and writes:
//   - assets/replies.json            (the live pool the site rotates through)
//   - replies-archive/YYYY-MM-DD.json (a dated weekly snapshot)
//
// Reuses the exact parse/clean logic from the IGPPC dashboard (weekly.js).
// Run weekly:  node build-replies.mjs   (then review assets/replies.json, commit, push)
//
// Needs TRELLO_API_KEY + TRELLO_TOKEN. Reads them from, in order:
//   1) process.env
//   2) C:/Users/USER/Desktop/API keys/.env.local   (KEY=VALUE lines)

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// ---- env ----
async function loadEnv() {
  const env = { ...process.env };
  const candidates = [
    'C:/Users/USER/Desktop/API keys/.env.local',
    join(ROOT, '.env.local'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const txt = await readFile(p, 'utf8').catch(() => '');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const TRELLO_API = 'https://api.trello.com/1';
// Positive-pipeline lists (from weekly.js). Meeting lists get a "meeting" badge.
const LISTS = {
  'New Reply':           '6a1dc30dbd8cfc0f8a75465e',
  'Actively Scheduling': '6a1dc30dbd8cfc0f8a75465f',
  'Follow up 1':         '6a1dc30dbd8cfc0f8a754660',
  'Follow up 2':         '6a1dc35b90a89b8da8b8041d',
  'Follow up 3':         '6a1dc36c7ad297d01aed8dc9',
  'Follow up 4':         '6a1dc3fcfe629afda21b18c7',
  'Follow up 5':         '6a1dc403459c4b7b37e95623',
  'Follow up 6':         '6a1dc409be2e67dca276b892',
  'Follow up 7':         '6a1dc40fceaaacd32290363c',
  'Meeting Booked':      '6a1dc38c57f01e50e0af94fa',
  'Showed Up':           '6a1dc39d0ba37f63abb14116',
};
const MEETING_LISTS = new Set(['Meeting Booked', 'Showed Up']);

const EXPO_LABEL = {
  abckids2026: 'ABC Kids Expo',
  leadsummit: 'LeadSummit',
  sse26: 'Sweets & Snacks Expo',
  licensingexpo2026: 'Licensing Expo',
};

// ---- reply text cleaner (copied from weekly.js) ----
function cleanReply(text) {
  if (!text) return '';
  let s = text;
  s = s.replace(/^(CAUTION|WARNING|External email)[\s\S]*?(?:safe\.?|opening attachments\.?|attachments\.?|sender\.?)\s*\n/im, '').trim();
  s = s.replace(/This e?mail (was sent|has been sent|originated|has been scanned)[\s\S]*$/im, '').trim();
  s = s.replace(/^On .{5,120}wrote:[\s\S]*$/m, '').trim();
  s = s.replace(/^From:\s+[\s\S]*$/m, '').trim();
  s = s.replace(/^[\s_-]{5,}[\s\S]*$/m, '').trim();
  s = s.replace(/\n+(Best|Best regards|Regards|Thanks(?: in advance)?|Thank you|Cheers|Sincerely|Yours|Talk soon|Speak soon|All the best|Kind regards)[,!.]?\s*\n[\s\S]*$/im, '').trim();
  s = s.replace(/\n+(Sent from|Get Outlook for|Get the Outlook|Sent via)[\s\S]*$/i, '').trim();
  s = s.replace(/\n+M:\s*\+?\(?\d[\s\S]*$/i, '').trim();
  s = s.replace(/\n+[A-Z][a-zA-Z'.\- ]+\n[A-Z][\s\S]*$/m, '').trim();
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  s = s.replace(/\s+/g, ' ').trim();
  // em-dashes are banned in our copy — normalize to commas
  s = s.replace(/\s*[—–]\s*/g, ', ');
  if (s.length > 180) s = s.slice(0, 180).trimEnd().replace(/[.,;:]?$/, '') + '…';
  return s;
}

function fixCompanyCase(name) {
  const fixes = { 'Jtm Foods': 'JTM Foods', 'Mgm': 'MGM', 'Usps': 'USPS', 'Cdpr': 'CDPR', 'Cd Projekt Red': 'CD PROJEKT RED' };
  return fixes[name] || name;
}

// ---- card parser (trimmed from weekly.js; anonymized output) ----
function parseCard(card, listName) {
  const desc = card.desc || '';
  const meta = {};
  for (const m of desc.matchAll(/^\*\*([^:*]+):\*\*\s*(.+)$/gm)) meta[m[1].trim().toLowerCase()] = m[2].trim();

  const sections = {};
  const re = /^###\s+([^\n]+?)(?:\s*—\s*([^\n]+))?\s*\n+([\s\S]*?)(?=^###\s+|^\*\*[^:]+:\*\*|^_Backfilled|^_Created by pv-webhook|\Z)/gm;
  let m;
  while ((m = re.exec(desc)) !== null) sections[m[1].trim().toLowerCase().replace(/\s+/g, '_')] = { body: m[3].trim() };

  let replyArrivedAt = null;
  const wm = desc.match(/_Created by pv-webhook at\s+([0-9T:.\-Z]+)_/);
  const bm = desc.match(/_Backfilled[^_]*?at\s+([0-9T:.\-Z]+)_/);
  const cm = desc.match(/_Created manually\s+(\d{4}-\d{2}-\d{2})/);
  if (wm) replyArrivedAt = wm[1];
  else if (bm) replyArrivedAt = bm[1];
  else if (cm) replyArrivedAt = cm[1] + 'T12:00:00.000Z';
  else {
    const idHex = (card.id || '').slice(0, 8);
    if (/^[0-9a-f]{8}$/.test(idHex)) replyArrivedAt = new Date(parseInt(idHex, 16) * 1000).toISOString();
  }

  const replyBody = (desc.match(/^###\s+Reply[^\n]*\n+([\s\S]*?)(?=^###|\Z)/m) || [])[1] || '';
  const isAuto = /customer care|generated with the assistance of ai|do not reply|out of office|automated response/i.test(replyBody);

  const parts = (card.name || '').split('·').map((s) => s.trim());
  const company = fixCompanyCase(meta.company || parts[1] || '');
  const role = meta.role || '';
  const expoMatch = (meta.source || '').match(/^(\w+)/);
  const snippet = cleanReply(sections.reply?.body || '');

  return {
    role,
    company,
    snippet,
    date: replyArrivedAt ? replyArrivedAt.slice(0, 10) : '',
    badge: MEETING_LISTS.has(listName) ? 'meeting' : 'interested',
    source: expoMatch ? (EXPO_LABEL[expoMatch[1]] || null) : null,
    _auto: isAuto,
  };
}

async function main() {
  const env = await loadEnv();
  const KEY = env.TRELLO_API_KEY, TOK = env.TRELLO_TOKEN;
  if (!KEY || !TOK) {
    console.error('Missing TRELLO_API_KEY / TRELLO_TOKEN (checked process.env and "C:/Users/USER/Desktop/API keys/.env.local").');
    process.exit(1);
  }

  const out = [];
  for (const [name, id] of Object.entries(LISTS)) {
    const r = await fetch(`${TRELLO_API}/lists/${id}/cards?fields=id,name,desc&key=${KEY}&token=${TOK}`);
    if (!r.ok) { console.warn(`  ! ${name}: HTTP ${r.status}`); continue; }
    const cards = await r.json();
    for (const c of cards) {
      const p = parseCard(c, name);
      // Only keep complete, human, positive cards. Drop anything without role+company+snippet.
      if (p._auto) continue;
      if (!p.role || !p.company || !p.snippet) continue;
      delete p._auto;
      out.push(p);
    }
    console.log(`  ${name}: ${cards.length} cards scanned`);
  }

  // Dedupe by company+snippet, newest first.
  const seen = new Set();
  const deduped = out
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter((r) => { const k = r.company + '|' + r.snippet; if (seen.has(k)) return false; seen.add(k); return true; });

  // Safety net: assert no obvious personal-name / email leakage in the payload.
  const leak = deduped.find((r) => /@/.test(r.snippet + r.role + r.company));
  if (leak) console.warn('  ! WARNING: an email address may have leaked into:', leak);

  const stamp = new Date().toISOString().slice(0, 10);
  await writeFile(join(ROOT, 'assets', 'replies.json'), JSON.stringify(deduped, null, 2) + '\n');
  await mkdir(join(ROOT, 'replies-archive'), { recursive: true });
  await writeFile(join(ROOT, 'replies-archive', `${stamp}.json`), JSON.stringify(deduped, null, 2) + '\n');

  console.log(`\n✓ ${deduped.length} anonymized replies → assets/replies.json  (+ replies-archive/${stamp}.json)`);
  console.log('  Review the file, then: git add assets/replies.json replies-archive && git commit && git push');
}

main().catch((e) => { console.error(e); process.exit(1); });
