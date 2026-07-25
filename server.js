/**
 * razbory-service — принимает заявки с лендинга "Открытые разборы бизнеса":
 *  1) создаёт сделку + контакт + примечание + поля согласий/роли в amoCRM
 *  2) пишет ту же заявку строкой в Google Таблицу
 *  3) держит Telegram-бота: встречает человека после /start приветствием
 *  4) логирует в ту же таблицу каждое сообщение бота (кто, когда, что получил/написал)
 *
 * Все секреты берутся ТОЛЬКО из переменных окружения (Railway → Variables).
 * Ничего секретного в этом файле нет и не должно быть.
 */

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- ENV ----------
const {
  AMO_BASE_DOMAIN,          // например: aleksandrkomiagin.amocrm.ru
  AMO_LONG_TOKEN,            // долгосрочный токен amoCRM (Bearer)
  PIPELINE_NAME,             // "Разборы"
  STAGE_NAME,                // "Первичный контакт" (первый этап воронки)
  ALLOWED_ORIGIN,            // опционально: домен сайта, для ограничения CORS
  TELEGRAM_BOT_TOKEN,        // токен бота из BotFather (перевыпущенный!)
  GOOGLE_SERVICE_ACCOUNT_EMAIL, // email сервисного аккаунта Google
  GOOGLE_PRIVATE_KEY,        // приватный ключ сервисного аккаунта (с \n внутри)
  GOOGLE_SHEET_ID,           // ID таблицы (из её URL)
  GOOGLE_SHEET_TAB_LEADS = 'Заявки',
  GOOGLE_SHEET_TAB_BOTLOG = 'Bot-лог',
  PORT = 3000,
} = process.env;

if (!AMO_BASE_DOMAIN || !AMO_LONG_TOKEN) {
  console.error('ОШИБКА: не заданы AMO_BASE_DOMAIN / AMO_LONG_TOKEN в переменных окружения');
  process.exit(1);
}

const AMO_API = `https://${AMO_BASE_DOMAIN}/api/v4`;

if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    next();
  });
}

// ========================================================================
// amoCRM helpers
// ========================================================================

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
  if (res.status === 204) return null; // amoCRM отвечает 204 без тела, если ничего не найдено
  return res.json();
}

let pipelineCache = null;

async function resolvePipelineAndStage() {
  if (pipelineCache) return pipelineCache;

  const data = await amoFetch('/leads/pipelines');
  const pipelines = data._embedded?.pipelines || [];

  const pipeline = pipelines.find(p => p.name.trim().toLowerCase() === (PIPELINE_NAME || '').trim().toLowerCase())
    || pipelines[0];

  if (!pipeline) throw new Error('Не найдено ни одной воронки в amoCRM');

  const statuses = pipeline._embedded?.statuses || [];
  const stage = statuses.find(s => s.name.trim().toLowerCase() === (STAGE_NAME || '').trim().toLowerCase())
    || statuses.sort((a, b) => a.sort - b.sort)[0];

  if (!stage) throw new Error(`В воронке "${pipeline.name}" нет ни одного этапа`);

  pipelineCache = { pipelineId: pipeline.id, statusId: stage.id, pipelineName: pipeline.name, stageName: stage.name };
  console.log('Резолв воронки:', pipelineCache);
  return pipelineCache;
}

// кэшируем ID кастомных полей сделки (согласия + роль участия)
let leadFieldsCache = null;

async function getAllLeadCustomFields() {
  const data = await amoFetch('/leads/custom_fields?limit=250');
  return data?._embedded?.custom_fields || [];
}

function findFieldByKeywords(fields, keywords) {
  return fields.find(f => {
    const name = (f.name || '').toLowerCase();
    return keywords.some(k => name.includes(k));
  });
}

async function createCheckboxField(name) {
  const body = [{ type: 'checkbox', name }];
  const created = await amoFetch('/leads/custom_fields', { method: 'POST', body: JSON.stringify(body) });
  return created._embedded.custom_fields[0].id;
}

async function resolveLeadFields() {
  if (leadFieldsCache) return leadFieldsCache;

  const fields = await getAllLeadCustomFields();

  const media = findFieldByKeywords(fields, ['фото', 'видео']);
  const mailing = findFieldByKeywords(fields, ['рассылк', 'информацион']);
  const pd = findFieldByKeywords(fields, ['персональных', 'перс. д', 'обработку перс']);
  let wantsRazbor = findFieldByKeywords(fields, ['роль', 'участ', 'разбор']);

  const mediaFieldId = media?.id || null;
  const mailingFieldId = mailing?.id || null;
  const pdFieldId = pd?.id || null;

  // поля "хочет разбор" ещё нет в amoCRM — создаём один раз автоматически
  let wantsRazborFieldId = wantsRazbor?.id || null;
  if (!wantsRazborFieldId) {
    wantsRazborFieldId = await createCheckboxField('Хочет, чтобы разобрали бизнес (сайт)');
    console.log('Создано новое поле в amoCRM: "Хочет, чтобы разобрали бизнес (сайт)", id =', wantsRazborFieldId);
  }

  leadFieldsCache = { mediaFieldId, mailingFieldId, pdFieldId, wantsRazborFieldId };
  console.log('Резолв полей сделки:', leadFieldsCache, {
    mediaField: media?.name, mailingField: mailing?.name, pdField: pd?.name, wantsRazborField: wantsRazbor?.name,
  });
  return leadFieldsCache;
}

function buildLeadCustomFields({ mediaFieldId, mailingFieldId, pdFieldId, wantsRazborFieldId }, payload) {
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
  if (wantsRazborFieldId) {
    const wantsRazbor = (payload.role || '').includes('разобрали');
    out.push({ field_id: wantsRazborFieldId, values: [{ value: wantsRazbor }] });
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
  if (!data) return null;
  const contacts = data._embedded?.contacts || [];
  return contacts[0] || null;
}

async function createContact({ name, phone }) {
  const custom_fields_values = [];
  if (phone) {
    custom_fields_values.push({
      field_code: 'PHONE',
      values: [{ value: phone, enum_code: 'WORK' }],
    });
  }
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
  const body = [{ entity_id: leadId, note_type: 'common', params: { text } }];
  await amoFetch(`/leads/${leadId}/notes`, { method: 'POST', body: JSON.stringify(body) });
}

// ========================================================================
// Google Sheets helpers
// ========================================================================

const sheetsEnabled = Boolean(GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY && GOOGLE_SHEET_ID);
let sheetsClientPromise = null;

async function getSheetsClient() {
  if (!sheetsEnabled) return null;
  if (!sheetsClientPromise) {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    sheetsClientPromise = Promise.resolve(google.sheets({ version: 'v4', auth: authClient }));
  }
  return sheetsClientPromise;
}

async function appendSheetRow(tabName, values) {
  if (!sheetsEnabled) return;
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
  } catch (err) {
    // Google Sheets — вспомогательный канал; ошибка сюда не должна ронять основной процесс
    console.error(`Ошибка записи в Google Sheets (${tabName}):`, err.message || err);
  }
}

function nowMoscow() {
  return new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

async function logLeadToSheet(payload, leadId) {
  await appendSheetRow(GOOGLE_SHEET_TAB_LEADS, [
    nowMoscow(),
    payload.name || '',
    payload.phone || '',
    payload.telegram || '',
    payload.role || '',
    payload.consent_media || '',
    payload.consent_mailing || '',
    payload.consent_pd || '',
    payload.page || '',
    leadId || '',
  ]);
}

async function logBotEvent({ chatId, username, direction, text }) {
  await appendSheetRow(GOOGLE_SHEET_TAB_BOTLOG, [
    nowMoscow(),
    chatId || '',
    username ? '@' + username : '',
    direction, // 'in' (от человека) или 'out' (от бота)
    text || '',
  ]);
}

// ========================================================================
// Основной webhook: сайт -> amoCRM + Google Sheets
// ========================================================================

app.post('/webhook/razbory', async (req, res) => {
  try {
    const payload = req.body || {};
    const phone = normalizePhone(payload.phone);

    const { pipelineId, statusId } = await resolvePipelineAndStage();
    const leadFields = await resolveLeadFields();

    let contact = await findContactByPhone(phone);
    if (!contact) {
      contact = await createContact({ name: payload.name, phone });
    }

    const lead = await createLead({
      name: payload.name,
      phone,
      contactId: contact?.id,
      pipelineId,
      statusId,
      customFields: buildLeadCustomFields(leadFields, payload),
    });

    await addNoteToLead(lead.id, buildNoteText({ ...payload, phone }));
    await logLeadToSheet(payload, lead.id);

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

// ========================================================================
// Telegram-бот: приветствие после /start + полный лог сообщений
// ========================================================================

if (TELEGRAM_BOT_TOKEN) {
  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  async function sendAndLog(chatId, username, text, options) {
    await bot.sendMessage(chatId, text, options);
    await logBotEvent({ chatId, username, direction: 'out', text });
  }

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = msg.from?.username;
    const firstName = msg.from?.first_name || '';
    const payload = match?.[1] || '';

    await logBotEvent({ chatId, username, direction: 'in', text: `/start ${payload}`.trim() });

    if (payload === 'razbory') {
      const welcomeText = [
        `${firstName ? firstName + ', ' : ''}вы зарегистрированы на «Открытые разборы бизнеса» 🎉`,
        ``,
        `Скоро с вами свяжется менеджер и пришлёт адрес встречи.`,
        `Встреча пройдёт 30 июля в 19:00 в Санкт-Петербурге.`,
      ].join('\n');
      await sendAndLog(chatId, username, welcomeText);
    } else {
      await sendAndLog(chatId, username, 'Привет! 👋');
    }
  });

  // логируем вообще все входящие сообщения (не только /start) — чтобы было видно,
  // на каком этапе диалога находится человек и что он писал/получал
  bot.on('message', async (msg) => {
    // сообщения /start уже залогированы выше отдельно — не дублируем
    if (msg.text && msg.text.startsWith('/start')) return;
    await logBotEvent({
      chatId: msg.chat.id,
      username: msg.from?.username,
      direction: 'in',
      text: msg.text || '[не текстовое сообщение]',
    });
  });

  bot.on('polling_error', (err) => {
    console.error('Ошибка Telegram polling:', err.message || err);
  });

  console.log('Telegram-бот запущен (polling)');
} else {
  console.log('TELEGRAM_BOT_TOKEN не задан — бот отключён, работает только webhook для сайта');
}
