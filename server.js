/**
 * razbory-service — принимает заявки с лендинга "Открытые разборы бизнеса"
 * и создаёт сделку + контакт + примечание с согласиями в amoCRM.
 *
 * Все секреты берутся ТОЛЬКО из переменных окружения (Railway → Variables).
 * Ничего секретного в этом файле нет и не должно быть.
 */

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- ENV ----------
const {
  AMO_BASE_DOMAIN,     // например: aleksandrkomiagin.amocrm.ru
  AMO_LONG_TOKEN,       // долгосрочный токен amoCRM (Bearer)
  PIPELINE_NAME,        // "Разборы"
  STAGE_NAME,           // "Первичный контакт" (первый этап воронки)
  ALLOWED_ORIGIN,       // опционально: домен сайта, для ограничения CORS (например https://username.github.io)
  PORT = 3000,
} = process.env;

if (!AMO_BASE_DOMAIN || !AMO_LONG_TOKEN) {
  console.error('ОШИБКА: не заданы AMO_BASE_DOMAIN / AMO_LONG_TOKEN в переменных окружения');
  process.exit(1);
}

const AMO_API = `https://${AMO_BASE_DOMAIN}/api/v4`;

// если задан ALLOWED_ORIGIN — ограничиваем CORS только им
if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    next();
  });
}

// ---------- helpers ----------
async function amoFetch(path, options = {}) {
  const res = await fetch(`${AMO_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${AMO_LONG_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`amoCRM ${path} -> ${res.status}: ${text}`);
  }
  // 204 No Content не парсим
  if (res.status === 204) return null;
  return res.json();
}

// кэшируем pipeline_id / status_id на процесс, чтобы не спрашивать каждый раз
let pipelineCache = null;

async function resolvePipelineAndStage() {
  if (pipelineCache) return pipelineCache;

  const data = await amoFetch('/leads/pipelines');
  const pipelines = data._embedded?.pipelines || [];

  const pipeline = pipelines.find(p => p.name.trim().toLowerCase() === (PIPELINE_NAME || '').trim().toLowerCase())
    || pipelines[0]; // fallback: первая воронка, если имя не нашлось

  if (!pipeline) throw new Error('Не найдено ни одной воронки в amoCRM');

  const statuses = pipeline._embedded?.statuses || [];
  const stage = statuses.find(s => s.name.trim().toLowerCase() === (STAGE_NAME || '').trim().toLowerCase())
    || statuses.sort((a, b) => a.sort - b.sort)[0]; // fallback: первый по порядку этап

  if (!stage) throw new Error(`В воронке "${pipeline.name}" нет ни одного этапа`);

  pipelineCache = { pipelineId: pipeline.id, statusId: stage.id, pipelineName: pipeline.name, stageName: stage.name };
  console.log('Резолв воронки:', pipelineCache);
  return pipelineCache;
}

// кэшируем ID кастомных полей сделки (согласия), чтобы не спрашивать каждый раз
let consentFieldsCache = null;

async function resolveConsentFields() {
  if (consentFieldsCache) return consentFieldsCache;

  const data = await amoFetch('/leads/custom_fields?limit=250');
  const fields = data._embedded?.custom_fields || [];

  const findByKeywords = (keywords) =>
    fields.find(f => {
      const name = (f.name || '').toLowerCase();
      return keywords.some(k => name.includes(k));
    });

  const media = findByKeywords(['фото', 'видео']);
  const mailing = findByKeywords(['рассылк', 'информацион']);
  const pd = findByKeywords(['персональных', 'перс. д', 'обработку перс']);

  consentFieldsCache = {
    mediaFieldId: media?.id || null,
    mailingFieldId: mailing?.id || null,
    pdFieldId: pd?.id || null,
  };
  console.log('Резолв полей согласий:', consentFieldsCache, {
    mediaField: media?.name, mailingField: mailing?.name, pdField: pd?.name,
  });
  return consentFieldsCache;
}

function buildConsentCustomFields({ mediaFieldId, mailingFieldId, pdFieldId }, payload) {
  const out = [];
  if (mediaFieldId) {
    out.push({ field_id: mediaFieldId, values: [{ value: payload.consent_media === 'Да' }] });
  }
  if (mailingFieldId) {
    out.push({ field_id: mailingFieldId, values: [{ value: payload.consent_mailing === 'Да' }] });
  }
  if (pdFieldId) {
    out.push({ field_id: pdFieldId, values: [{ value: payload.consent_pd === 'Да' }] });
  }
  return out;
}

function normalizePhone(raw) {
  return (raw || '').replace(/[^\d+]/g, '');
}

async function findContactByPhone(phone) {
  if (!phone) return null;
  const query = encodeURIComponent(phone);
  const data = await amoFetch(`/contacts?query=${query}&with=leads`);
  const contacts = data._embedded?.contacts || [];
  return contacts[0] || null;
}

async function createContact({ name, phone, telegram }) {
  const custom_fields_values = [];
  if (phone) {
    custom_fields_values.push({
      field_code: 'PHONE',
      values: [{ value: phone, enum_code: 'WORK' }],
    });
  }
  // telegram username пишем в отдельное текстовое поле, если оно есть в аккаунте;
  // если поля с кодом нет, amoCRM просто проигнорирует это значение при ошибке —
  // поэтому дублируем telegram и в примечание к сделке (см. buildNoteText).
  const body = [{
    name: name || 'Без имени',
    custom_fields_values: custom_fields_values.length ? custom_fields_values : undefined,
  }];
  const data = await amoFetch('/contacts', { method: 'POST', body: JSON.stringify(body) });
  return data._embedded.contacts[0];
}

async function createLead({ name, phone, contactId, pipelineId, statusId, customFields }) {
  const body = [{
    name: `Заявка: ${name || 'Без имени'}${phone ? ', ' + phone : ''}`,
    pipeline_id: pipelineId,
    status_id: statusId,
    _embedded: contactId ? { contacts: [{ id: contactId }] } : undefined,
    custom_fields_values: customFields && customFields.length ? customFields : undefined,
  }];
  const data = await amoFetch('/leads', { method: 'POST', body: JSON.stringify(body) });
  return data._embedded.leads[0];
}

function buildNoteText(payload) {
  const dt = new Date(payload.submitted_at || Date.now());
  const dtStr = dt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

  return [
    `Заявка с лендинга «Открытые разборы бизнеса» — ${dtStr} (МСК)`,
    ``,
    `Имя: ${payload.name || '—'}`,
    `Телефон: ${payload.phone || '—'}`,
    `Telegram: ${payload.telegram || '—'}`,
    `Роль участия: ${payload.role || '—'}`,
    ``,
    `Согласия:`,
    `— на сбор фото/видео (кейсы): ${payload.consent_media || 'Нет'}`,
    `— на информационные рассылки: ${payload.consent_mailing || 'Нет'}`,
    `— на обработку персональных данных: ${payload.consent_pd || 'Нет'}`,
    ``,
    `Источник: ${payload.page || '—'}`,
  ].join('\n');
}

async function addNoteToLead(leadId, text) {
  const body = [{
    entity_id: leadId,
    note_type: 'common',
    params: { text },
  }];
  await amoFetch(`/leads/${leadId}/notes`, { method: 'POST', body: JSON.stringify(body) });
}

// ---------- main endpoint ----------
app.post('/webhook/razbory', async (req, res) => {
  try {
    const payload = req.body || {};
    const phone = normalizePhone(payload.phone);

    const { pipelineId, statusId } = await resolvePipelineAndStage();
    const consentFields = await resolveConsentFields();

    // ищем существующий контакт по телефону, иначе создаём новый
    let contact = await findContactByPhone(phone);
    if (!contact) {
      contact = await createContact({ name: payload.name, phone, telegram: payload.telegram });
    }

    const lead = await createLead({
      name: payload.name,
      phone,
      contactId: contact?.id,
      pipelineId,
      statusId,
      customFields: buildConsentCustomFields(consentFields, payload),
    });

    await addNoteToLead(lead.id, buildNoteText({ ...payload, phone }));

    console.log(`OK: сделка #${lead.id} создана для ${payload.name} (${phone})`);
    res.json({ ok: true, lead_id: lead.id });
  } catch (err) {
    console.error('Ошибка обработки заявки:', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// health-check для Railway
app.get('/', (req, res) => res.send('razbory-service is running'));

app.listen(PORT, () => {
  console.log(`razbory-service запущен на порту ${PORT}`);
});
