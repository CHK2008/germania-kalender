// Baut aus der öffentlichen Kalenderseite von FC Germania Mallorca eine
// abonnierbare Kalenderdatei (docs/germania.ics).
// Vergangene Termine bleiben erhalten (docs/events.json), auch wenn die
// Vereinsseite sie nicht mehr zeigt.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const QUELLE = 'https://www.germaniamallorca.com/kalender';
const AUSGABE = new URL('./docs/', import.meta.url);
const TZ = 'Europe/Madrid';

async function holeTermine() {
  const res = await fetch(QUELLE, { headers: { 'User-Agent': 'germania-kalender (Fan-Abo)' } });
  if (!res.ok) throw new Error(`Kalenderseite antwortet mit ${res.status}`);
  const html = await res.text();

  // Next.js liefert die Daten als JSON-Strings in self.__next_f.push([1,"..."])
  let rsc = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    rsc += JSON.parse(m[1]);
  }
  const start = rsc.indexOf('"events":[');
  if (start < 0) throw new Error('Keine Termine in der Seite gefunden – wurde die Seite umgebaut?');

  // Array ab der öffnenden Klammer bis zur passenden schließenden Klammer lesen
  const ab = start + '"events":'.length;
  let tiefe = 0, inString = false, esc = false, ende = -1;
  for (let i = ab; i < rsc.length; i++) {
    const ch = rsc[i];
    if (inString) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') tiefe++;
    else if (ch === ']' && --tiefe === 0) { ende = i + 1; break; }
  }
  const events = JSON.parse(rsc.slice(ab, ende));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Terminliste ist leer');
  return events.map((e) => {
    const sauber = {};
    for (const [k, v] of Object.entries(e)) sauber[k] = v === '$undefined' ? null : v;
    return sauber;
  });
}

function esc(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Zeilen nach RFC 5545 auf 75 Byte falten
function falte(zeile) {
  const teile = [];
  let rest = Buffer.from(zeile, 'utf8');
  let erste = true;
  while (rest.length > (erste ? 75 : 74)) {
    let n = erste ? 75 : 74;
    while ((rest[n] & 0xc0) === 0x80) n--; // kein UTF-8-Zeichen zerschneiden
    teile.push((erste ? '' : ' ') + rest.subarray(0, n).toString('utf8'));
    rest = rest.subarray(n);
    erste = false;
  }
  teile.push((erste ? '' : ' ') + rest.toString('utf8'));
  return teile.join('\r\n');
}

const SYMBOL = { match: '⚽', event: '🎉', party: '🥳' };

function vevent(e, stempel) {
  const datum = e.eventDate.replace(/-/g, '');
  const z = ['BEGIN:VEVENT', `UID:${e.id}@germania-kalender`, `DTSTAMP:${stempel}`];
  if (e.time && /^\d{1,2}:\d{2}$/.test(e.time)) {
    const [h, m] = e.time.split(':').map(Number);
    const beginn = `${datum}T${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
    const endH = h + 2; // Spiele/Events mit 2 Stunden ansetzen
    const ende = endH < 24
      ? `${datum}T${String(endH).padStart(2, '0')}${String(m).padStart(2, '0')}00`
      : `${datum}T235900`;
    z.push(`DTSTART;TZID=${TZ}:${beginn}`, `DTEND;TZID=${TZ}:${ende}`);
  } else {
    // Ohne Uhrzeit: ganztägig, damit keine falsche Uhrzeit im Kalender steht
    const folgetag = new Date(`${e.eventDate}T12:00:00Z`);
    folgetag.setUTCDate(folgetag.getUTCDate() + 1);
    z.push(`DTSTART;VALUE=DATE:${datum}`, `DTEND;VALUE=DATE:${folgetag.toISOString().slice(0, 10).replace(/-/g, '')}`);
  }

  let titel = `${SYMBOL[e.type] ?? '📅'} ${e.title}`;
  if (e.homeScore != null && e.awayScore != null) titel += ` (${e.homeScore}:${e.awayScore})`;
  if (e.status === 'cancelled') titel = `ABGESAGT: ${titel}`;
  z.push(`SUMMARY:${esc(titel)}`);

  if (e.location) z.push(`LOCATION:${esc(e.location)}`);
  const info = [];
  if (e.type === 'match') info.push(e.isHome ? 'Heimspiel' : 'Auswärtsspiel');
  if (!e.time) info.push('Uhrzeit steht noch nicht fest');
  if (e.location) info.push(`Route: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}`);
  if (e.description) info.push(e.description);
  if (e.ticketLink) info.push(`Tickets: ${e.ticketLink}`);
  info.push(`Alle Termine: ${QUELLE}`);
  z.push(`DESCRIPTION:${esc(info.join('\n'))}`);
  z.push(`URL:${e.ticketLink || QUELLE}`);
  if (e.status === 'cancelled') z.push('STATUS:CANCELLED');
  z.push('END:VEVENT');
  return z.map(falte).join('\r\n');
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', `TZID:${TZ}`,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

async function main() {
  await mkdir(AUSGABE, { recursive: true });
  const speicherDatei = new URL('events.json', AUSGABE);

  let alt = {};
  try { alt = JSON.parse(await readFile(speicherDatei, 'utf8')); } catch { /* erster Lauf */ }

  const neu = await holeTermine();
  const heute = new Date().toISOString().slice(0, 10);
  const alle = {};
  // Vergangene Termine behalten, künftige nur, wenn die Seite sie noch zeigt
  for (const [id, e] of Object.entries(alt)) if (e.eventDate < heute) alle[id] = e;
  for (const e of neu) alle[e.id] = e;

  const liste = Object.values(alle).sort((a, b) =>
    (a.eventDate + (a.time ?? '')).localeCompare(b.eventDate + (b.time ?? '')));
  const stempel = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//germania-kalender//Fan-Abo//DE', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:FC Germania Mallorca', `X-WR-TIMEZONE:${TZ}`,
    'X-WR-CALDESC:Spiele\\, Events und Partys von FC Germania Mallorca',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H',
    VTIMEZONE,
    ...liste.map((e) => vevent(e, stempel)),
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';

  // Nur schreiben, wenn sich inhaltlich etwas geändert hat (der Zeitstempel allein zählt nicht)
  const ohneStempel = (t) => t.replace(/^DTSTAMP:.*$/gm, '');
  let altIcs = '';
  try { altIcs = await readFile(new URL('kalender.ics', AUSGABE), 'utf8'); } catch { /* erster Lauf */ }
  if (ohneStempel(altIcs) !== ohneStempel(ics)) {
    await writeFile(new URL('germania.ics', AUSGABE), ics, 'utf8');
    await writeFile(new URL('kalender.ics', AUSGABE), ics, 'utf8'); // kurzer Link vamosgermania.de/kalender.ics
  }
  await writeFile(speicherDatei, JSON.stringify(alle, null, 2) + '\n', 'utf8');
  console.log(`${liste.length} Termine geschrieben (${neu.length} von der Vereinsseite).`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
