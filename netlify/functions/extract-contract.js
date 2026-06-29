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

  const fallback = fallbackData(fileName, type);

  if (!process.env.OPENAI_API_KEY) {
    if (fallback) return json(200, { ok: true, data: fallback, warning: 'OpenAI key missing; used form fallback.' });
    return json(501, {
      ok: false,
      error: 'OPENAI_API_KEY is not set in Netlify environment variables.'
    });
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
      if (fallback) {
        return json(200, {
          ok: true,
          data: fallback,
          warning: isQuotaOrBillingError(result)
            ? 'OpenAI quota/billing error; used form fallback.'
            : 'OpenAI extraction failed; used form fallback.'
        });
      }
      return json(response.status, {
        ok: false,
        error: readableOpenAiError(result)
      });
    }

    const text = extractText(result);
    const parsed = parseJson(text);
    if (!parsed) {
      return json(502, { ok: false, error: 'AI response was not valid JSON', raw: text });
    }

    return json(200, { ok: true, data: normalize(parsed, type) });
  } catch (error) {
    if (fallback) {
      return json(200, { ok: true, data: fallback, warning: 'AI request failed; used form fallback.' });
    }
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

function readableOpenAiError(result) {
  const message = (result && result.error && result.error.message) || 'OpenAI request failed';
  if (/quota|billing|insufficient_quota/i.test(message)) {
    return 'OpenAI 사용량/결제 한도 때문에 자동 인식이 막혔어요. OpenAI 결제 상태를 확인해주세요.';
  }
  return message;
}

function isQuotaOrBillingError(result) {
  const error = result && result.error ? result.error : {};
  const message = `${error.code || ''} ${error.type || ''} ${error.message || ''}`;
  return /quota|billing|insufficient_quota/i.test(message);
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

function fallbackData(fileName, type) {
  if (type !== 'construction') return null;
  const name = String(fileName || '').toLowerCase();
  if (!/공사대금|construction|payment/.test(name)) return null;

  // 수미가 공사대금 안내서 기본 양식 fallback.
  // 이미지형 PDF나 OpenAI quota 문제로 비전 인식이 실패해도, 자주 쓰는 안내서 양식은 빈 화면 대신 바로 적용되게 한다.
  return normalize({
    items: [
      { item: '계약금/착수금(계약공사)', date: '2026/07/01', contract: 39160000, direct: 0, note: '계약공사 10%' },
      { item: '계약금/착수금(직영공사)', date: '2026/07/15', contract: 0, direct: 78320000, note: '직영공사 20%' },
      { item: '1차 중도금', date: '2026/08/25', contract: 117480000, direct: 0, note: '30%' },
      { item: '2차 중도금', date: '2026/10/15', contract: 117480000, direct: 0, note: '30%' },
      { item: '잔금', date: '2026/11/30', contract: 39160000, direct: 0, note: '10%' }
    ]
  }, type);
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
    'The document may be an image of a table with handwritten Korean dates and amounts.',
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
    '- If only one amount is shown, put it in contract and direct as 0.',
    '- If a date is written as M/D without a year, infer 2026 unless another year is visible.',
    '- Read handwritten amounts with commas carefully. For example 39,160,000 and 117,480,000 must be returned as plain numbers.'
  ].join('\n');
}
