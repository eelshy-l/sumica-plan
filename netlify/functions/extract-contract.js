const OPENAI_API_URL = 'https://api.openai.com/v1/responses';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'POST only' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(501, {
      ok: false,
      error: 'OPENAI_API_KEY is not set in Netlify environment variables.'
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (error) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const fileName = String(payload.fileName || 'contract.pdf');
  const mediaType = String(payload.mediaType || 'application/pdf');
  const base64 = String(payload.data || '');
  const type = payload.type === 'construction' ? 'construction' : 'design';

  if (!base64) {
    return json(400, { ok: false, error: 'Missing file data' });
  }

  const dataUrl = `data:${mediaType};base64,${base64}`;
  const filePart = mediaType.startsWith('image/')
    ? { type: 'input_image', image_url: dataUrl }
    : { type: 'input_file', filename: fileName, file_data: dataUrl };

  const schemaGuide = type === 'design' ? designPrompt() : constructionPrompt();

  const requestBody = {
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [
      {
        role: 'user',
        content: [
          filePart,
          {
            type: 'input_text',
            text: schemaGuide
          }
        ]
      }
    ],
    temperature: 0
  };

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const result = await response.json();
    if (!response.ok) {
      return json(response.status, {
        ok: false,
        error: (result.error && result.error.message) || 'OpenAI request failed'
      });
    }

    const text = extractText(result);
    const parsed = parseJson(text);
    if (!parsed) {
      return json(502, { ok: false, error: 'AI response was not valid JSON', raw: text });
    }

    return json(200, { ok: true, data: normalize(parsed, type) });
  } catch (error) {
    return json(500, { ok: false, error: error.message || 'Server error' });
  }
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function extractText(result) {
  if (result.output_text) return result.output_text;
  const parts = [];
  (result.output || []).forEach(item => {
    (item.content || []).forEach(content => {
      if (content.text) parts.push(content.text);
    });
  });
  return parts.join('\n').trim();
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (error) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (error) { return null; }
}

function normalizeDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  const eight = text.match(/(\d{4})\D?(\d{2})\D?(\d{2})/);
  if (eight) return `${eight[1]}/${eight[2]}/${eight[3]}`;
  return text;
}

function money(value) {
  if (value === null || value === undefined) return 0;
  return parseInt(String(value).replace(/[^\d-]/g, ''), 10) || 0;
}

function normalize(data, type) {
  if (type === 'construction') {
    return {
      items: Array.isArray(data.items) ? data.items.map(item => ({
        item: String(item.item || item.label || '').trim(),
        date: normalizeDate(item.date || item.dueDate || item.paymentDate),
        contract: money(item.contract || item.amount || 0),
        direct: money(item.direct || 0),
        note: String(item.note || '').trim(),
        done: false
      })).filter(item => item.item) : []
    };
  }

  return {
    contractDate: normalizeDate(data.contractDate),
    endDate: normalizeDate(data.endDate),
    py: Number(data.py || data.areaPy || 0) || 0,
    totalFee: money(data.totalFee),
    items: Array.isArray(data.items) ? data.items.map(item => ({
      label: String(item.label || item.item || '').trim(),
      dueDate: normalizeDate(item.dueDate || item.date || item.paymentDate),
      amount: money(item.amount),
      vat: money(item.vat),
      note: String(item.note || '').trim(),
      done: false
    })).filter(item => item.label) : []
  };
}

function designPrompt() {
  return [
    'You are extracting payment data from a Korean architecture/design contract.',
    'Return ONLY valid JSON. No markdown.',
    'Schema:',
    '{',
    '  "contractDate": "YYYY/MM/DD or empty string",',
    '  "endDate": "YYYY/MM/DD or empty string",',
    '  "py": number,',
    '  "totalFee": number,',
    '  "items": [',
    '    {"label": "계약금/중도금/잔금 etc", "dueDate": "YYYY/MM/DD or condition text", "amount": number, "vat": number, "note": "short Korean note"}',
    '  ]',
    '}',
    'Rules:',
    '- totalFee means total design fee including VAT if available.',
    '- amount is supply amount excluding VAT when the contract separates VAT.',
    '- vat is VAT amount. If no VAT is stated, use 0.',
    '- Preserve condition-based dates such as "디자인 완료 시" in dueDate or note.'
  ].join('\n');
}

function constructionPrompt() {
  return [
    'You are extracting payment schedule data from a Korean construction contract or payment notice.',
    'Return ONLY valid JSON. No markdown.',
    'Schema:',
    '{',
    '  "items": [',
    '    {"item": "계약금/착수금/중도금/잔금 etc", "date": "YYYY/MM/DD or condition text", "contract": number, "direct": number, "note": "short Korean note"}',
    '  ]',
    '}',
    'Rules:',
    '- contract is contract construction amount.',
    '- direct is direct-managed construction amount.',
    '- If only one amount is shown, put it in contract and direct as 0.'
  ].join('\n');
}
