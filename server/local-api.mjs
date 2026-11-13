import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

const mode = process.env.WB_ENV === 'master' ? 'master' : 'test';
const port = Number(process.env.PORT || (mode === 'master' ? 8787 : 8788));
const database = process.env.PGDATABASE || (mode === 'master' ? 'workbench_master' : 'workbench_test');
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database,
  max: 5,
});

const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const id = () => crypto.randomUUID();
const token = () => crypto.randomBytes(32).toString('base64url');
const normalizePhone = (value) => String(value || '').replace(/[\s\-()]/g, '');
const isPhone = (value) => /^\+?\d{7,15}$/.test(normalizePhone(value));
const asEmail = (value) => String(value || '').trim().toLowerCase();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, expected] = String(encoded || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

async function init() {
  await pool.query(`
    create table if not exists public.local_users (
      id uuid primary key,
      email text unique,
      phone text unique,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists public.local_sessions (
      access_token text primary key,
      refresh_token text not null unique,
      user_id uuid not null references public.local_users(id) on delete cascade,
      expires_at timestamptz not null
    );
    create table if not exists public.wb_user_data (
      user_id uuid primary key references public.local_users(id) on delete cascade,
      payload jsonb not null,
      revision bigint not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
}

async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function authUser(req) {
  const header = String(req.headers.authorization || '');
  const accessToken = header.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return null;
  const result = await pool.query(`
    select u.id, u.email, u.phone
    from public.local_sessions s
    join public.local_users u on u.id = s.user_id
    where s.access_token = $1 and s.expires_at > now()
  `, [accessToken]);
  return result.rows[0] || null;
}

function userJson(user) {
  return { id: user.id, email: user.email || '', phone: user.phone || '', aud: 'authenticated', role: 'authenticated' };
}

async function issueSession(user) {
  const accessToken = token();
  const refreshToken = token();
  await pool.query('delete from public.local_sessions where user_id = $1', [user.id]);
  await pool.query(`
    insert into public.local_sessions(access_token, refresh_token, user_id, expires_at)
    values ($1, $2, $3, now() + interval '30 days')
  `, [accessToken, refreshToken, user.id]);
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: 60 * 60 * 24 * 30, token_type: 'bearer', user: userJson(user) };
}

async function authSignup(req, res) {
  const input = await body(req);
  const password = String(input.password || '');
  const phone = input.phone ? normalizePhone(input.phone) : null;
  const email = input.email ? asEmail(input.email) : null;
  if (!password || password.length < 8) return json(res, 400, { code: 'weak_password', message: 'Password should be at least 8 characters' });
  if (!phone && !email) return json(res, 400, { code: 'invalid_credentials', message: 'email or phone is required' });
  const exists = await pool.query('select 1 from public.local_users where (email = $1 and $1 is not null) or (phone = $2 and $2 is not null)', [email, phone]);
  if (exists.rowCount) return json(res, 422, { code: 'user_already_exists', message: 'User already registered' });
  const user = { id: id(), email, phone };
  await pool.query('insert into public.local_users(id,email,phone,password_hash) values($1,$2,$3,$4)', [user.id, email, phone, hashPassword(password)]);
  return json(res, 200, await issueSession(user));
}

async function authToken(req, res, url) {
  const input = await body(req);
  const grant = url.searchParams.get('grant_type');
  if (grant === 'refresh_token') {
    const result = await pool.query(`select u.id,u.email,u.phone from public.local_sessions s join public.local_users u on u.id=s.user_id where s.refresh_token=$1`, [input.refresh_token]);
    if (!result.rowCount) return json(res, 401, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
    return json(res, 200, await issueSession(result.rows[0]));
  }
  const identifier = input.phone ? normalizePhone(input.phone) : asEmail(input.email);
  const result = await pool.query(`select id,email,phone,password_hash from public.local_users where (phone=$1 and $1 <> '') or (email=$2 and $2 <> '')`, [identifier, identifier]);
  if (!result.rowCount || !verifyPassword(input.password, result.rows[0].password_hash)) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
  return json(res, 200, await issueSession(result.rows[0]));
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, environment: mode, database });
  if (req.method === 'POST' && url.pathname === '/auth/v1/signup') return authSignup(req, res);
  if (req.method === 'POST' && url.pathname === '/auth/v1/token') return authToken(req, res, url);
  const user = await authUser(req);
  if (req.method === 'GET' && url.pathname === '/auth/v1/user') {
    return user ? json(res, 200, userJson(user)) : json(res, 401, { message: 'Invalid JWT' });
  }
  if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
    await pool.query('delete from public.local_sessions where access_token = $1', [String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')]);
    return json(res, 204, {});
  }
  if (!user) return json(res, 401, { message: 'Authentication required', code: 'AUTH_REQUIRED' });
  if (req.method === 'GET' && url.pathname === '/rest/v1/wb_user_data') {
    const result = await pool.query('select payload,revision,updated_at from public.wb_user_data where user_id=$1', [user.id]);
    return json(res, 200, result.rows);
  }
  if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/wb_save_user_data') {
    const input = await body(req);
    if (!input.p_payload || typeof input.p_payload !== 'object' || Array.isArray(input.p_payload)) return json(res, 400, { message: 'Payload must be a JSON object' });
    const expected = Number(input.p_expected_revision) || 0;
    const client = await pool.connect();
    try {
      await client.query('begin');
      const current = await client.query('select revision,payload from public.wb_user_data where user_id=$1 for update', [user.id]);
      if (current.rowCount && current.rows[0].revision !== expected) {
        await client.query('rollback');
        return json(res, 409, { message: 'WB_DATA_REVISION_CONFLICT', code: 'WB_DATA_REVISION_CONFLICT' });
      }
      const result = await client.query(`
        insert into public.wb_user_data(user_id,payload,revision) values($1,$2,1)
        on conflict(user_id) do update set payload=excluded.payload, revision=public.wb_user_data.revision+1, updated_at=now()
        returning payload,revision,updated_at
      `, [user.id, JSON.stringify(input.p_payload)]);
      await client.query('commit');
      return json(res, 200, result.rows);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return json(res, 404, { message: 'Not found' });
}

init().then(() => {
  http.createServer((req, res) => handle(req, res).catch((error) => {
    console.error(error);
    json(res, 500, { message: 'Local API error' });
  })).listen(port, '127.0.0.1', () => console.log(`workbench ${mode} API listening on http://127.0.0.1:${port} -> ${database}`));
}).catch((error) => { console.error('Unable to initialize local API', error); process.exitCode = 1; });
