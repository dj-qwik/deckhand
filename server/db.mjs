// Durable storage. Postgres when DATABASE_URL is set; otherwise an in-memory
// store (local dev and tests only; mainnet refuses to run cash without Postgres).
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

export async function openDb(url, log = console.log) {
  if (!url) return memoryDb();
  const pg = (await import('pg')).default;
  const ssl = /localhost|127\.0\.0\.1|\.internal|dpg-[a-z0-9]+-a(?![.\w])/.test(url) || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
  pool.on('error', (e) => log('pg pool error', e.message));
  await pool.query(`
    create table if not exists kv (key text primary key, value jsonb not null, updated timestamptz not null default now());
    create table if not exists consents (wallet text primary key, record jsonb not null, created timestamptz not null default now());
    create table if not exists matches (id text primary key, status text not null, data jsonb not null, created timestamptz not null default now(), updated timestamptz not null default now());
    create index if not exists matches_status on matches(status);
    create table if not exists evidence (id text primary key, data jsonb not null, created timestamptz not null default now());
  `);
  return {
    kind: 'postgres',
    async ping() { await pool.query('select 1'); return true; },
    async kvGet(k) { const r = await pool.query('select value from kv where key=$1', [k]); return r.rows[0]?.value ?? null; },
    async kvSet(k, v) { await pool.query('insert into kv(key,value) values($1,$2) on conflict(key) do update set value=$2, updated=now()', [k, json(v)]); },
    async saveConsent(w, rec) { await pool.query('insert into consents(wallet,record) values($1,$2) on conflict(wallet) do update set record=$2', [w.toLowerCase(), json(rec)]); },
    async getConsent(w) { const r = await pool.query('select record from consents where wallet=$1', [w.toLowerCase()]); return r.rows[0]?.record ?? null; },
    async saveMatch(m) { await pool.query('insert into matches(id,status,data) values($1,$2,$3) on conflict(id) do update set status=$2, data=$3, updated=now()', [m.id, m.status, json(m)]); },
    async getMatch(id) { const r = await pool.query('select data from matches where id=$1', [id]); return r.rows[0]?.data ?? null; },
    async listMatches(statuses) { const r = await pool.query('select data from matches where status = any($1) order by created', [statuses]); return r.rows.map((x) => x.data); },
    async recentMatches(n = 20) { const r = await pool.query("select data from matches where status in ('settled','refunded') order by updated desc limit $1", [n]); return r.rows.map((x) => x.data); },
    async saveEvidence(id, ev) { await pool.query('insert into evidence(id,data) values($1,$2) on conflict(id) do update set data=$2', [id, json(ev)]); },
    async getEvidence(id) { const r = await pool.query('select data from evidence where id=$1', [id]); return r.rows[0]?.data ?? null; },
    async close() { await pool.end(); },
  };
}

function memoryDb() {
  const kv = new Map(), consents = new Map(), matches = new Map(), evidence = new Map();
  const clone = (v) => (v == null ? null : JSON.parse(json(v)));
  return {
    kind: 'memory',
    async ping() { return true; },
    async kvGet(k) { return clone(kv.get(k)); },
    async kvSet(k, v) { kv.set(k, clone(v)); },
    async saveConsent(w, rec) { consents.set(w.toLowerCase(), clone(rec)); },
    async getConsent(w) { return clone(consents.get(w.toLowerCase())); },
    async saveMatch(m) { matches.set(m.id, { ...clone(m), _t: Date.now() }); },
    async getMatch(id) { return clone(matches.get(id)); },
    async listMatches(statuses) { return [...matches.values()].filter((m) => statuses.includes(m.status)).map(clone); },
    async recentMatches(n = 20) { return [...matches.values()].filter((m) => ['settled', 'refunded'].includes(m.status)).sort((a, b) => b._t - a._t).slice(0, n).map(clone); },
    async saveEvidence(id, ev) { evidence.set(id, clone(ev)); },
    async getEvidence(id) { return clone(evidence.get(id)); },
    async close() {},
  };
}
