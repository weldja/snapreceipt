/**
 * SnapReceipt — Email Worker (no external dependencies)
 * Processes incoming emails to receipts@snapreceipt.co.uk
 *
 * Environment variables required:
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

export default {
  async email(message, env, ctx) {

    const fromEmail = message.from?.toLowerCase();
    if (!fromEmail) { console.log('No from address'); return; }

    // Read raw email bytes — rawSize may be undefined on some CF versions
    const rawBytes = await streamToUint8Array(message.raw);
    const rawText  = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes);

    // Look up Supabase user by from-email
    const userId = await getUserId(fromEmail, env);
    if (!userId) {
      console.log('No Supabase user found for:', fromEmail);
      return;
    }
    console.log('Processing email for user:', userId);

    // Parse email recursively — handles nested multipart/related, multipart/alternative etc.
    const images = extractImagesRecursive(rawText);
    console.log(`Found ${images.length} image(s) in email`);

    if (!images.length) {
      // No images — save a stub receipt from the subject line
      const subject = message.headers?.get('subject') || 'Email receipt';
      await saveReceipt({ userId, merchant: subject, fromEmail, env });
      return;
    }

    for (const img of images.slice(0, 3)) {
      const extracted = await runOCR(img.base64, img.mimeType, env);
      await saveReceipt({ userId, extracted, img, fromEmail, env });
    }
  }
};

// ── MIME PARSING ────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/heic', 'image/heif',
]);

/**
 * Recursively walk MIME parts, collecting all image attachments/inlines.
 * Handles:
 *   - multipart/mixed, multipart/related, multipart/alternative (recursion)
 *   - base64 and quoted-printable transfer encodings
 *   - Content-Disposition: attachment AND inline
 *   - HEIC/HEIF from iPhones (sent as image/heic — we re-label to image/jpeg for Claude)
 */
function extractImagesRecursive(mimeText) {
  const images = [];

  // Extract the top-level Content-Type to find boundary
  const topCT = getHeader(mimeText, 'Content-Type') || '';
  const boundary = extractBoundary(topCT);

  if (boundary) {
    // Split into parts and recurse
    const parts = splitParts(mimeText, boundary);
    for (const part of parts) {
      const sub = extractImagesRecursive(part);
      images.push(...sub);
    }
    return images;
  }

  // Leaf part — check if it's an image
  const ct = (getHeader(mimeText, 'Content-Type') || '').toLowerCase().split(';')[0].trim();
  if (!SUPPORTED_IMAGE_TYPES.has(ct)) return images;

  const enc = (getHeader(mimeText, 'Content-Transfer-Encoding') || '').trim().toLowerCase();

  // Find the body (after the blank line separating headers from body)
  const bodyStart = findBodyStart(mimeText);
  if (bodyStart === -1) return images;
  const bodyRaw = mimeText.slice(bodyStart);

  let base64 = null;

  if (enc === 'base64') {
    base64 = bodyRaw.replace(/[\r\n\s]/g, '');
  } else if (enc === 'quoted-printable') {
    const decoded = decodeQP(bodyRaw);
    base64 = uint8ToBase64(decoded);
  } else if (enc === '7bit' || enc === '8bit' || enc === 'binary' || enc === '') {
    // Attempt raw → base64
    base64 = uint8ToBase64(new TextEncoder().encode(bodyRaw));
  }

  if (base64 && base64.length > 200) {
    // Normalise HEIC → send as jpeg to Claude (Claude accepts the data, just needs a valid type)
    const mimeType = (ct === 'image/heic' || ct === 'image/heif') ? 'image/jpeg' : ct;
    images.push({ base64, mimeType });
    console.log(`Extracted image: ${ct} (${enc}), ${base64.length} chars`);
  }

  return images;
}

/** Extract boundary value from a Content-Type header string */
function extractBoundary(ct) {
  const m = ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
  return m ? m[1].trim() : null;
}

/** Get a named header value from a MIME part string */
function getHeader(text, name) {
  // Headers end at the first blank line — only search there
  const headerBlock = text.split(/\r?\n\r?\n/)[0] || '';
  // Headers can be folded (continuation lines start with whitespace)
  const unfolded = headerBlock.replace(/\r?\n([ \t])/g, ' ');
  const re = new RegExp('^' + name + '\\s*:\\s*(.+)', 'im');
  const m = unfolded.match(re);
  return m ? m[1].trim() : null;
}

/** Find the byte offset of the body (after the blank line) */
function findBodyStart(text) {
  const crlf = text.indexOf('\r\n\r\n');
  if (crlf !== -1) return crlf + 4;
  const lf = text.indexOf('\n\n');
  if (lf !== -1) return lf + 2;
  return -1;
}

/** Split a multipart body into its constituent parts */
function splitParts(text, boundary) {
  const delim = '--' + boundary;
  const parts = [];
  let start = text.indexOf(delim);
  while (start !== -1) {
    const lineEnd = text.indexOf('\n', start);
    if (lineEnd === -1) break;
    const next = text.indexOf('\n' + delim, lineEnd);
    if (next === -1) break;
    // The part content sits between the boundary line end and the next boundary
    parts.push(text.slice(lineEnd + 1, next));
    start = next + 1;
  }
  return parts;
}

/** Decode a quoted-printable string to Uint8Array */
function decodeQP(text) {
  const bytes = [];
  let i = 0;
  // Unfold soft line breaks
  const unfolded = text.replace(/=\r?\n/g, '');
  while (i < unfolded.length) {
    if (unfolded[i] === '=' && i + 2 < unfolded.length) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    bytes.push(unfolded.charCodeAt(i));
    i++;
  }
  return new Uint8Array(bytes);
}

/** Convert Uint8Array to base64 string */
function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── OCR ─────────────────────────────────────────────────────────────────────

async function runOCR(base64, mimeType, env) {
  // Claude's image limit is ~5MB decoded (~6.8M base64 chars). Log and skip if too large.
  const MAX_B64_CHARS = 6_800_000;
  if (base64.length > MAX_B64_CHARS) {
    console.warn(`Image too large for OCR: ${base64.length} chars — truncating to first ${MAX_B64_CHARS}`);
    // Truncate to a valid base64 boundary (multiple of 4)
    base64 = base64.slice(0, MAX_B64_CHARS - (MAX_B64_CHARS % 4));
  }
  const prompt = `You are a receipt scanner. Extract these fields from the receipt image:
1. merchant — business name
2. amount — total paid, numeric only (e.g. 12.50)
3. date — YYYY-MM-DD format
4. currency — ISO code, default GBP
5. confidence — "high", "medium", or "low"

Return ONLY valid JSON, no markdown. Example:
{"merchant":"Tesco","amount":"8.43","date":"2025-03-15","currency":"GBP","confidence":"high"}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });
    if (!res.ok) {
      console.error('Anthropic API error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const raw  = data.content?.[0]?.text || '';
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('OCR failed:', e.message);
    return null;
  }
}

// ── SUPABASE ─────────────────────────────────────────────────────────────────

async function getUserId(email, env) {
  try {
    let page = 1;
    while (true) {
      const res = await fetch(
        `${env.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=50`,
        {
          headers: {
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          }
        }
      );
      if (!res.ok) {
        console.error('Supabase users fetch failed:', res.status);
        return null;
      }
      const data = await res.json();
      const users = data.users || [];
      if (!users.length) return null;
      const match = users.find(u => u.email?.toLowerCase() === email);
      if (match) return match.id;
      if (users.length < 50) return null;
      page++;
    }
  } catch(e) {
    console.error('getUserId error:', e.message);
    return null;
  }
}

async function saveReceipt({ userId, extracted, img, merchant, fromEmail, env }) {
  // Deduplication — check if same merchant+amount+date already exists in last 5 minutes
  if (extracted?.merchant && extracted?.amount) {
    try {
      const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const dupCheck = await fetch(
        `${env.SUPABASE_URL}/rest/v1/receipts?user_id=eq.${userId}&merchant=eq.${encodeURIComponent(extracted.merchant)}&amount=eq.${extracted.amount}&created_at=gte.${encodeURIComponent(fiveMinsAgo)}&select=id&limit=1`,
        {
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey': env.SUPABASE_SERVICE_KEY,
          }
        }
      );
      if (dupCheck.ok) {
        const existing = await dupCheck.json();
        if (existing.length > 0) {
          console.log('Duplicate receipt detected, skipping:', extracted.merchant, extracted.amount);
          return;
        }
      }
    } catch(e) { console.error('Dedup check failed:', e.message); }
  }

  let imageUrl = null;
  if (img) {
    try {
      const filename = `${userId}/${Date.now()}.jpg`;
      const binaryStr = atob(img.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const upRes = await fetch(
        `${env.SUPABASE_URL}/storage/v1/object/receipt-images/${filename}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'apikey': env.SUPABASE_SERVICE_KEY,
            'Content-Type': img.mimeType,
          },
          body: bytes,
        }
      );
      if (upRes.ok) {
        imageUrl = `${env.SUPABASE_URL}/storage/v1/object/public/receipt-images/${filename}`;
        console.log('Image uploaded:', filename);
      } else {
        console.error('Image upload failed:', upRes.status, await upRes.text());
      }
    } catch(e) { console.error('Image upload exception:', e.message); }
  }

  const receipt = {
    user_id:   userId,
    merchant:  (extracted?.merchant && extracted.merchant !== 'unknown') ? extracted.merchant : (merchant || 'Email receipt'),
    // Fall back to 0 — DB has not-null constraint; user can edit the amount manually
    amount:    (extracted?.amount && extracted.amount !== 'unknown') ? (parseFloat(extracted.amount) || 0) : 0,
    currency:  (extracted?.currency && extracted.currency !== 'unknown') ? extracted.currency : 'GBP',
    date:      (extracted?.date && extracted.date !== 'unknown' && /^\d{4}-\d{2}-\d{2}$/.test(extracted.date)) ? extracted.date : new Date().toISOString().slice(0, 10),
    notes:     `Received via email from ${fromEmail || 'unknown'}`,
    image_url: imageUrl,
    ocr_raw:   null,
  };

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(receipt),
  });

  if (res.ok) {
    console.log('Receipt saved:', receipt.merchant, receipt.amount);
  } else {
    console.error('Save failed:', res.status, await res.text());
  }
}

// ── UTILITIES ────────────────────────────────────────────────────────────────

/**
 * Read a ReadableStream into a Uint8Array.
 * Does NOT depend on rawSize (which can be undefined in some CF runtime versions).
 */
async function streamToUint8Array(stream) {
  const chunks = [];
  let totalLength = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}