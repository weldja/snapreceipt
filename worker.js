/**
 * SnapReceipt — Cloudflare Worker
 * Receives a base64 receipt image, calls Claude Vision API,
 * returns extracted merchant, amount, date, currency, confidence.
 *
 * Environment variables required (set in Cloudflare Worker settings):
 *   ANTHROPIC_API_KEY  — your Anthropic API key
 *   SUPABASE_URL       — your Supabase project URL
 *   SUPABASE_SERVICE_KEY — your Supabase service role key (for auth verification)
 */

const ALLOWED_ORIGIN = 'https://snapreceipt.co.uk';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {

    // ── CORS preflight ────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Only allow POST ───────────────────────────────────
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // ── Verify Supabase JWT ───────────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return jsonResponse({ error: 'Unauthorised' }, 401);
    }

    // Verify the token against Supabase
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_SERVICE_KEY,
      }
    });
    if (!userRes.ok) {
      return jsonResponse({ error: 'Unauthorised' }, 401);
    }

    // ── Parse request body ────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch(e) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { imageBase64, mediaType } = body;
    if (!imageBase64) {
      return jsonResponse({ error: 'No image provided' }, 400);
    }

    const mtype = ['image/jpeg','image/png','image/gif','image/webp'].includes(mediaType)
      ? mediaType
      : 'image/jpeg';

    // ── Call Claude Vision API ────────────────────────────
    const prompt = `You are a receipt scanner. Extract the following fields from this receipt image:

1. merchant — the shop, restaurant, or business name
2. amount — the total amount paid (numeric only, no currency symbol)
3. date — the date of the receipt in YYYY-MM-DD format
4. currency — ISO 4217 code (GBP, USD, EUR etc). Default to GBP if unclear.
5. confidence — your confidence in the extraction: "high", "medium", or "low"

Rules:
- amount must be a number like 12.50, not "£12.50"
- If you cannot find a field, omit it or return null
- date must be YYYY-MM-DD format only
- Return ONLY valid JSON, no other text, no markdown, no backticks

Example output:
{"merchant":"Tesco Express","amount":"8.43","date":"2025-03-15","currency":"GBP","confidence":"high"}`;

    let claudeRes;
    try {
      claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mtype,
                  data: imageBase64,
                }
              },
              {
                type: 'text',
                text: prompt,
              }
            ]
          }]
        })
      });
    } catch(e) {
      return jsonResponse({ error: 'Failed to reach Claude API' }, 502);
    }

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errText);
      return jsonResponse({ error: 'Claude API error', status: claudeRes.status }, 502);
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.[0]?.text || '';

    // ── Parse Claude's JSON response ──────────────────────
    let extracted;
    try {
      // Strip any accidental markdown fences
      const clean = rawText.replace(/```json|```/g, '').trim();
      extracted = JSON.parse(clean);
    } catch(e) {
      console.error('Failed to parse Claude response:', rawText);
      return jsonResponse({ error: 'Could not parse receipt', raw: rawText }, 422);
    }

    // ── Return extracted fields ───────────────────────────
    return jsonResponse({
      merchant:   extracted.merchant   || null,
      amount:     extracted.amount     || null,
      date:       extracted.date       || null,
      currency:   extracted.currency   || 'GBP',
      confidence: extracted.confidence || 'medium',
    }, 200);
  }
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    }
  });
}
