// Pace API Worker — Cloudflare Worker proxy for Geoapify API.
// Keeps the shared API key server-side. Chrome extension calls this
// when the user hasn't provided their own key.

const GEOAPIFY_BASE = 'https://api.geoapify.com/v1';

/** Uninstall tracking — submits install ID to a Google Form server-side. */
const UNINSTALL_TRACKING = {
  formId: '1FAIpQLSfxXP91_OA_luig-XeFdufWWDw7RjU_pMvkAQOsQkOlx-0_JA',
  entryId: 'entry.1524631095',
};

/** Allowed query parameters per route (apiKey is NEVER accepted from clients). */
const ROUTE_CONFIG = {
  '/geocode': {
    target: `${GEOAPIFY_BASE}/geocode/search`,
    allowedParams: ['text', 'limit', 'filter', 'bias', 'lang', 'type'],
  },
  '/route': {
    target: `${GEOAPIFY_BASE}/routing`,
    allowedParams: ['waypoints', 'mode'],
  },
  '/autocomplete': {
    target: `${GEOAPIFY_BASE}/geocode/autocomplete`,
    allowedParams: ['text', 'limit', 'filter', 'bias', 'lang', 'type'],
  },
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    if (request.method !== 'GET') {
      return corsResponse(jsonError(405, 'Method not allowed'));
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check — no origin validation needed
    if (path === '/health') {
      return corsResponse(Response.json({ status: 'ok' }));
    }

    // Uninstall tracking — direct browser navigation, no origin validation
    if (path === '/uninstall') {
      return handleUninstall(url);
    }

    // Validate origin — only allow Chrome extensions + explicit allowlist
    const origin = request.headers.get('Origin');
    if (!isAllowedOrigin(origin, env)) {
      return corsResponse(jsonError(403, 'Forbidden'));
    }

    const config = ROUTE_CONFIG[path];
    if (!config) {
      return corsResponse(jsonError(404, 'Not found'));
    }

    // Build whitelisted params and inject server-side API key
    const params = new URLSearchParams();
    for (const key of config.allowedParams) {
      const value = url.searchParams.get(key);
      if (value !== null) {
        params.set(key, value);
      }
    }
    params.set('apiKey', env.GEOAPIFY_API_KEY);

    // Proxy to Geoapify
    const targetUrl = `${config.target}?${params}`;
    let response;
    try {
      response = await fetch(targetUrl);
    } catch {
      return corsResponse(jsonError(502, 'Upstream request failed'));
    }

    // Surface rate-limit errors with a user-friendly message
    if (response.status === 429) {
      return corsResponse(
        Response.json(
          {
            error: 'rate_limit',
            message:
              'Daily API limit reached. You can add your own free Geoapify API key in Pace advanced settings to continue.',
          },
          { status: 429 },
        ),
      );
    }

    // Forward the upstream response (strip any server headers we don't need)
    const body = await response.arrayBuffer();
    return corsResponse(
      new Response(body, {
        status: response.status,
        headers: {
          'Content-Type':
            response.headers.get('Content-Type') || 'application/json',
        },
      }),
    );
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllowedOrigin(origin, env) {
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status, message) {
  return Response.json({ error: message }, { status });
}

async function handleUninstall(url) {
  const id = url.searchParams.get('id');

  // Fire-and-forget POST to Google Form (best-effort)
  if (id) {
    const formUrl = `https://docs.google.com/forms/d/e/${UNINSTALL_TRACKING.formId}/formResponse`;
    const body = new URLSearchParams();
    body.append(UNINSTALL_TRACKING.entryId, id);
    try {
      await fetch(formUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      // Best-effort — don't block the thank-you page
    }
  }

  return new Response(UNINSTALL_HTML, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

const UNINSTALL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pace — Uninstalled</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f9fafb; color: #1f2937; }
    .card { text-align: center; max-width: 420px; padding: 48px 32px; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    p { color: #6b7280; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Thanks for trying Pace!</h1>
    <p>We're sorry to see you go. If you have feedback, feel free to open an issue on my GitHub.</p>
  </div>
</body>
</html>`;
