require('dotenv').config();

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const X_API_BASE = 'https://api.x.com';
const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';

const REQUIRED_ENV = [
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
  'X_REDIRECT_URI',
  'SESSION_SECRET'
];

const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    name: 'x_ai_auto_delete_sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.use(express.static('public'));

function base64url(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomString(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function createCodeChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function requireAuth(req, res, next) {
  if (!req.session.x) {
    return res.status(401).json({ error: 'Not authenticated with X.' });
  }
  next();
}

function xErrorMessage(body, fallback) {
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (Array.isArray(body?.errors) && body.errors[0]?.detail) {
    return body.errors[0].detail;
  }
  return fallback;
}

async function xFetch(path, options = {}) {
  const token = options.token;
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');

  const response = await fetch(`${X_API_BASE}${path}`, {
    ...options,
    headers
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(xErrorMessage(body, `X API request failed (${response.status})`));
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function refreshAccessToken(req) {
  const refreshToken = req.session.x?.refresh_token;
  if (!refreshToken) return false;

  const basic = Buffer.from(
    `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_id: process.env.X_CLIENT_ID
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) return false;

  req.session.x.access_token = body.access_token;
  if (body.refresh_token) req.session.x.refresh_token = body.refresh_token;
  if (body.expires_in) req.session.x.expires_at = Date.now() + body.expires_in * 1000;
  return true;
}

async function xFetchWithRefresh(req, path, options = {}) {
  try {
    return await xFetch(path, { ...options, token: req.session.x.access_token });
  } catch (error) {
    if (error.status !== 401) throw error;
    const refreshed = await refreshAccessToken(req);
    if (!refreshed) throw error;
    return await xFetch(path, { ...options, token: req.session.x.access_token });
  }
}

app.get('/auth/x', (req, res) => {
  const state = randomString(32);
  const codeVerifier = randomString(48);
  const codeChallenge = createCodeChallenge(codeVerifier);

  req.session.oauth = {
    state,
    codeVerifier,
    createdAt: Date.now()
  };

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.X_CLIENT_ID,
    redirect_uri: process.env.X_REDIRECT_URI,
    scope: 'users.read tweet.read tweet.write offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  res.redirect(`${X_AUTHORIZE_URL}?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    const oauth = req.session.oauth;

    if (error) {
      delete req.session.oauth;
      return res.status(400).send(`X authorization failed: ${error_description || error}`);
    }

    if (!code || !state || !oauth || state !== oauth.state) {
      return res.status(400).send('Invalid OAuth state or callback parameters.');
    }

    if (Date.now() - oauth.createdAt > 10 * 60 * 1000) {
      delete req.session.oauth;
      return res.status(400).send('OAuth session expired. Please try again.');
    }

    const basic = Buffer.from(
      `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch(X_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.X_REDIRECT_URI,
        client_id: process.env.X_CLIENT_ID,
        code_verifier: oauth.codeVerifier
      })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      console.error('X token exchange failed:', response.status, body);
      return res.status(400).send(
        `X token exchange failed: ${xErrorMessage(body, `HTTP ${response.status}`)}`
      );
    }

    req.session.x = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : null
    };
    delete req.session.oauth;

    res.redirect('/?authenticated=1');
  } catch (error) {
    console.error(error);
    res.status(500).send('Authentication callback failed. Check the server log.');
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const data = await xFetchWithRefresh(
      req,
      '/2/users/me?user.fields=id,name,username,profile_image_url,description,created_at,public_metrics'
    );
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(error.status || 502).json({ error: error.message });
  }
});

app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    // User ID is obtained from X, not accepted from the browser.
    const me = await xFetchWithRefresh(req, '/2/users/me?user.fields=id,name,username');
    const userId = me.data?.id;
    if (!userId) throw new Error('X did not return the authenticated user ID.');

    const params = new URLSearchParams({
      max_results: '100',
      'tweet.fields': 'id,text,created_at,conversation_id,lang,public_metrics,possibly_sensitive,referenced_tweets'
    });
    if (req.query.pagination_token) {
      params.set('pagination_token', req.query.pagination_token);
    }

    const data = await xFetchWithRefresh(
      req,
      `/2/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`
    );

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(error.status || 502).json({ error: error.message, details: error.body });
  }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid X post ID.' });
    }

    const data = await xFetchWithRefresh(req, `/2/tweets/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(error.status || 502).json({ error: error.message, details: error.body });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Could not end the session.' });
    res.clearCookie('x_ai_auto_delete_sid');
    res.json({ ok: true });
  });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(req.session.x) });
});

app.listen(PORT, () => {
  console.log(`X AI Auto Delete running at http://localhost:${PORT}`);
});
