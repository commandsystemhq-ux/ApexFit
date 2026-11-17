// Reading exported health files in the browser: MyFitnessPal "Nutrition Summary" CSV, Apple Health export.xml
// (or the export.zip that contains it), and simple CSV/JSON daily summaries. Nothing here touches the network:
// the files are parsed on the user's device and only the resulting daily numbers are saved.

export const IMPORT_LIMITS = {
  maxTextBytes: 5 * 1024 * 1024, // CSV / JSON files
  maxCsvRows: 30000,
  maxDays: 1100,
  maxAppleBytes: 8 * 1024 * 1024 * 1024,
  chunkDays: 400, // the database accepts at most 400 days per call
};

const OLDEST_DAYS = 3650;

// ------------------------------------------------------------------ dates

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(day, amount) {
  const [year, month, date] = day.split('-').map(Number);
  return isoDate(new Date(Date.UTC(year, month - 1, date + amount)));
}

function validParts(year, month, day) {
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Looks at every date in a file to decide whether 03/04/2026 means March 4th or April 3rd.
export function detectSlashOrder(values) {
  let first = false;
  let second = false;
  for (const value of values) {
    const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(String(value ?? '').trim());
    if (!match) continue;
    if (Number(match[1]) > 12) first = true; // the first number can only be a day
    if (Number(match[2]) > 12) second = true;
  }
  if (first && !second) return 'dmy';
  return 'mdy'; // MyFitnessPal exports use ISO dates; for slashes the US order is the safer default
}

export function parseDateValue(value, slashOrder = 'mdy') {
  const text = String(value ?? '').trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (iso) return validParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (slash) {
    let year = Number(slash[3]);
    if (slash[3].length === 2) year += 2000;
    const [a, b] = [Number(slash[1]), Number(slash[2])];
    return slashOrder === 'dmy' ? validParts(year, b, a) : validParts(year, a, b);
  }
  return null;
}

function dateInRange(day, today) {
  return day <= addDays(today, 1) && day >= addDays(today, -OLDEST_DAYS);
}

// ------------------------------------------------------------------ CSV

function detectDelimiter(headerLine) {
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t']) {
    let count = 0;
    let quoted = false;
    for (const character of headerLine) {
      if (character === '"') quoted = !quoted;
      else if (!quoted && character === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// A small CSV reader: quoted fields, doubled quotes, line breaks inside quotes, BOM, and , ; or tab separators.
export function parseCsv(input, { maxRows = IMPORT_LIMITS.maxCsvRows } = {}) {
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = detectDelimiter(firstLine);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let sawContent = false;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0].trim() !== '') rows.push(row);
    row = [];
    sawContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else quoted = false;
      } else field += character;
    } else if (character === '"' && field === '') {
      quoted = true;
      sawContent = true;
    } else if (character === delimiter) {
      endField();
      sawContent = true;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      endRow();
      if (rows.length > maxRows) return { rows, truncated: true, delimiter };
    } else {
      field += character;
      sawContent = true;
    }
  }
  if (sawContent || field !== '' || row.length > 0) endRow();
  return { rows, truncated: false, delimiter };
}

// "1,234" → 1234, "12,5" → 12.5, "" → null, "abc" → NaN
export function parseNumber(value) {
  const text = String(value ?? '').replace(/[\s\u00A0]/g, '').replace(/(?<=\d)[a-zA-Z%]+$/, '');
  if (text === '' || text === '-' || text === '--') return null;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return Number(text.replace(/,/g, ''));
  if (/^-?\d+,\d{1,2}$/.test(text)) return Number(text.replace(',', '.'));
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

const normalizeHeader = (header) => String(header ?? '').toLowerCase().replace(/[\u00A0\s]+/g, ' ').trim();

function findColumns(header, aliases) {
  const normalized = header.map(normalizeHeader);
  const found = {};
  for (const [key, names] of Object.entries(aliases)) {
    const index = normalized.findIndex((name) => names.includes(name));
    if (index !== -1) found[key] = index;
  }
  return found;
}

// ------------------------------------------------------- MyFitnessPal CSV

const MFP_COLUMNS = {
  date: ['date', 'day'],
  meal: ['meal'],
  calories: ['calories', 'calories (kcal)', 'energy (kcal)', 'energy', 'kcal'],
  protein: ['protein (g)', 'protein', 'proteins (g)'],
  carbs: ['carbohydrates (g)', 'carbs (g)', 'carbohydrates', 'carbs', 'carbohydrate (g)'],
  fats: ['fat (g)', 'fats (g)', 'total fat (g)', 'fat', 'fats'],
  water: ['water (ml)', 'water (milliliters)', 'water'],
};
const TOTAL_ROW = /^(daily\s+)?totals?$/i;

const MFP_LIMITS = {
  calories: [0, 20000], protein: [0, 2000], carbs: [0, 3000], fats: [0, 2000], water: [0, 20000],
};

// Turns a MyFitnessPal Nutrition Summary export into one entry per day. The export has one row per meal; the
// meals of a day are added up (or the day's own "Total" row is used when the file has one).
export function parseMyFitnessPalCsv(text, { today = isoDate(new Date()) } = {}) {
  if (String(text ?? '').length > IMPORT_LIMITS.maxTextBytes) return { ok: false, error: 'too_large', days: [], skipped: [] };
  const { rows, truncated } = parseCsv(text);
  if (truncated) return { ok: false, error: 'too_many_rows', days: [], skipped: [] };
  if (rows.length < 2) return { ok: false, error: 'empty', days: [], skipped: [] };

  const [header, ...body] = rows;
  const columns = findColumns(header, MFP_COLUMNS);
  if (columns.date === undefined || [columns.calories, columns.protein, columns.carbs, columns.fats].every((index) => index === undefined)) {
    return { ok: false, error: 'missing_columns', days: [], skipped: [], columns };
  }

  const slashOrder = detectSlashOrder(body.map((row) => row[columns.date]));
  const skipped = [];
  const byDay = new Map();

  body.forEach((row, offset) => {
    const line = offset + 2;
    const day = parseDateValue(row[columns.date], slashOrder);
    if (!day) {
      skipped.push({ line, reason: String(row[columns.date] ?? '').trim() ? 'bad_date' : 'missing_date' });
      return;
    }
    if (!dateInRange(day, today)) {
      skipped.push({ line, reason: 'date_out_of_range' });
      return;
    }

    const values = {};
    for (const key of ['calories', 'protein', 'carbs', 'fats', 'water']) {
      if (columns[key] === undefined) continue;
      const number = parseNumber(row[columns[key]]);
      if (Number.isNaN(number)) {
        skipped.push({ line, reason: 'bad_number' });
        return;
      }
      if (number !== null && (number < MFP_LIMITS[key][0] || number > MFP_LIMITS[key][1])) {
        skipped.push({ line, reason: 'value_out_of_range' });
        return;
      }
      values[key] = number;
    }

    const entry = byDay.get(day) || { meals: [], total: null };
    const meal = columns.meal === undefined ? '' : String(row[columns.meal] ?? '').trim();
    if (TOTAL_ROW.test(meal)) entry.total = values;
    else entry.meals.push(values);
    byDay.set(day, entry);
  });

  const sum = (list, key) => {
    const present = list.map((item) => item[key]).filter((value) => value !== null && value !== undefined);
    return present.length ? present.reduce((total, value) => total + value, 0) : null;
  };

  const days = [];
  for (const [logDate, entry] of byDay) {
    const source = entry.total ? [entry.total] : entry.meals;
    const day = {
      log_date: logDate,
      calories_consumed: sum(source, 'calories'),
      protein_g: sum(source, 'protein'),
      carbs_g: sum(source, 'carbs'),
      fats_g: sum(source, 'fats'),
      water_ml: sum(source, 'water'),
    };
    const nutrients = [day.calories_consumed, day.protein_g, day.carbs_g, day.fats_g];
    if (nutrients.every((value) => !value) && !day.water_ml) {
      skipped.push({ line: 0, date: logDate, reason: 'no_data' }); // MyFitnessPal lists days nothing was logged on
      continue;
    }
    for (const [key, value] of Object.entries(day)) {
      if (key !== 'log_date' && value !== null) day[key] = key === 'calories_consumed' || key === 'water_ml' ? Math.round(value) : Math.round(value * 100) / 100;
    }
    // A day's total can pass the limit even if no single meal did.
    if ((day.calories_consumed ?? 0) > 20000 || (day.protein_g ?? 0) > 2000 || (day.carbs_g ?? 0) > 3000 || (day.fats_g ?? 0) > 2000) {
      skipped.push({ line: 0, date: logDate, reason: 'value_out_of_range' });
      continue;
    }
    days.push(day);
  }

  days.sort((left, right) => left.log_date.localeCompare(right.log_date));
  if (days.length > IMPORT_LIMITS.maxDays) return { ok: false, error: 'too_many_days', days: [], skipped };
  if (days.length === 0) return { ok: false, error: 'no_days', days: [], skipped, columns };
  return {
    ok: true,
    days,
    skipped,
    columns,
    dateFormat: slashOrder,
    range: { from: days[0].log_date, to: days[days.length - 1].log_date },
    totalRows: body.length,
  };
}

// --------------------------------------------------- daily summaries (CSV/JSON)

const SUMMARY_FIELDS = {
  steps: { names: ['steps', 'step_count', 'stepcount', 'step count'], min: 0, max: 200000 },
  active_calories: { names: ['active_calories', 'activecalories', 'active_energy', 'active energy', 'active calories', 'calories_active', 'active_kcal'], min: 0, max: 20000 },
  sleep_minutes: { names: ['sleep_minutes', 'sleep_min', 'sleep minutes', 'sleepminutes', 'minutes_asleep'], min: 0, max: 1440 },
  sleep_hours: { names: ['sleep_hours', 'sleep hours', 'sleep', 'hours_asleep', 'sleep_h'], min: 0, max: 24 },
  resting_heart_rate: { names: ['resting_heart_rate', 'resting heart rate', 'resting_hr', 'resting hr', 'rhr', 'restingheartrate'], min: 20, max: 250 },
  hrv_ms: { names: ['hrv_ms', 'hrv', 'hrv_sdnn', 'hrv (ms)', 'heart_rate_variability'], min: 0, max: 500 },
  recovery_score: { names: ['recovery_score', 'recovery', 'readiness', 'readiness_score', 'recovery score'], min: 0, max: 100 },
};
const SUMMARY_DATE_NAMES = ['date', 'day', 'recorded_date', 'calendardate', 'datetime'];

const OUTPUT_FIELDS = ['steps', 'active_calories', 'sleep_minutes', 'resting_heart_rate', 'hrv_ms', 'recovery_score'];

function summaryRow(entries, slashOrder, today, warnings, label) {
  const lookup = new Map(entries.map(([key, value]) => [normalizeHeader(key), value]));
  const dateKey = SUMMARY_DATE_NAMES.find((name) => lookup.has(name));
  const day = dateKey ? parseDateValue(lookup.get(dateKey), slashOrder) : null;
  if (!day) {
    warnings.push({ row: label, reason: 'bad_date' });
    return null;
  }
  if (!dateInRange(day, today)) {
    warnings.push({ row: label, reason: 'date_out_of_range' });
    return null;
  }

  const out = { date: day };
  for (const [field, spec] of Object.entries(SUMMARY_FIELDS)) {
    const name = spec.names.find((candidate) => lookup.has(candidate) && String(lookup.get(candidate) ?? '').trim() !== '');
    if (!name) continue;
    const raw = lookup.get(name);
    const number = typeof raw === 'number' ? raw : parseNumber(raw);
    if (number === null || Number.isNaN(number) || number < spec.min || number > spec.max) {
      warnings.push({ row: label, reason: 'value_out_of_range', field });
      continue;
    }
    if (field === 'sleep_hours') {
      if (out.sleep_minutes === undefined) out.sleep_minutes = Math.round(number * 60);
    } else out[field] = field === 'hrv_ms' ? Math.round(number * 100) / 100 : Math.round(number);
  }
  if (!OUTPUT_FIELDS.some((field) => out[field] !== undefined)) {
    warnings.push({ row: label, reason: 'no_data' });
    return null;
  }
  return out;
}

// A CSV or JSON file with one row per day. JSON may be an array, or an object with a days/data/metrics array.
export function parseHealthSummary(text, { today = isoDate(new Date()) } = {}) {
  const source = String(text ?? '');
  if (source.length > IMPORT_LIMITS.maxTextBytes) return { ok: false, error: 'too_large', days: [], warnings: [] };
  const warnings = [];
  let entries = [];
  let slashOrder = 'mdy';

  if (/^\s*[[{]/.test(source)) {
    let data;
    try {
      data = JSON.parse(source);
    } catch {
      return { ok: false, error: 'bad_json', days: [], warnings };
    }
    const list = Array.isArray(data) ? data : ['days', 'data', 'metrics', 'records'].map((key) => data?.[key]).find(Array.isArray);
    if (!Array.isArray(list)) return { ok: false, error: 'bad_json', days: [], warnings };
    entries = list.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => Object.entries(item));
    slashOrder = detectSlashOrder(list.map((item) => item?.date ?? item?.day));
  } else {
    const { rows, truncated } = parseCsv(source);
    if (truncated) return { ok: false, error: 'too_many_rows', days: [], warnings };
    if (rows.length < 2) return { ok: false, error: 'empty', days: [], warnings };
    const [header, ...body] = rows;
    const dateColumn = header.findIndex((name) => SUMMARY_DATE_NAMES.includes(normalizeHeader(name)));
    if (dateColumn === -1) return { ok: false, error: 'missing_columns', days: [], warnings };
    slashOrder = detectSlashOrder(body.map((row) => row[dateColumn]));
    entries = body.map((row) => header.map((name, index) => [name, row[index]]));
  }

  const byDay = new Map();
  entries.forEach((item, index) => {
    const row = summaryRow(item, slashOrder, today, warnings, index + 1);
    if (row) byDay.set(row.date, { ...byDay.get(row.date), ...row });
  });
  const days = [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (days.length === 0) return { ok: false, error: 'no_days', days: [], warnings };
  if (days.length > IMPORT_LIMITS.maxDays) return { ok: false, error: 'too_many_days', days: [], warnings };
  return { ok: true, days, warnings, range: { from: days[0].date, to: days[days.length - 1].date } };
}

// ------------------------------------------------------------ Apple Health

const APPLE = {
  steps: 'HKQuantityTypeIdentifierStepCount',
  energy: 'HKQuantityTypeIdentifierActiveEnergyBurned',
  restingHeartRate: 'HKQuantityTypeIdentifierRestingHeartRate',
  hrv: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  sleep: 'HKCategoryTypeIdentifierSleepAnalysis',
};

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodeXml = (value) => value.replace(/&(amp|lt|gt|quot|apos);/g, (match) => XML_ENTITIES[match]);

// "2026-03-01 07:12:00 +0200" → milliseconds
export function parseAppleDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})?$/.exec(String(value ?? '').trim());
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4] || '00'}`);
}

// Sleep values that count as sleep (not "InBed" or "Awake"): Asleep, AsleepUnspecified, AsleepCore, AsleepDeep, AsleepREM.
const isAsleep = (value) => /Asleep/.test(value) && !/Awake|InBed/.test(value);

function mergedMinutes(intervals) {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let current = null;
  for (const [start, end] of sorted) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else current[1] = Math.max(current[1], end);
  }
  if (current) total += current[1] - current[0];
  return total / 60000;
}

const bump = (map, day, source, amount) => {
  const bySource = map.get(day) || new Map();
  bySource.set(source, (bySource.get(source) || 0) + amount);
  map.set(day, bySource);
};
const bestSource = (bySource) => Math.max(...bySource.values());

// Reads Apple Health's export.xml piece by piece, so a file of hundreds of megabytes never has to be held in memory.
// A person's steps often come from both the iPhone and the Watch, so each day uses the source with the highest
// total instead of adding the two together.
export class AppleHealthParser {
  constructor({ today = isoDate(new Date()), sinceDays = 90 } = {}) {
    this.buffer = '';
    this.firstDay = addDays(today, -sinceDays);
    this.lastDay = addDays(today, 1);
    this.steps = new Map();
    this.energy = new Map();
    this.sleep = new Map();
    this.restingHeartRate = new Map();
    this.hrv = new Map();
    this.recordsRead = 0;
    this.recordsUsed = 0;
  }

  push(chunk) {
    this.buffer += chunk;
    const tags = /<Record\s[^>]*>/g;
    let match = tags.exec(this.buffer);
    while (match) {
      this.record(match[0]);
      match = tags.exec(this.buffer);
    }
    // Keep only a tag that was cut off in the middle by the end of this piece.
    const open = this.buffer.lastIndexOf('<');
    this.buffer = open > this.buffer.lastIndexOf('>') ? this.buffer.slice(open) : '';
  }

  record(tag) {
    this.recordsRead += 1;
    const attributes = {};
    for (const [, name, value] of tag.matchAll(/(\w+)="([^"]*)"/g)) attributes[name] = value;
    const type = attributes.type;
    if (!Object.values(APPLE).includes(type)) return;

    const startDay = String(attributes.startDate || '').slice(0, 10);
    const endDay = String(attributes.endDate || '').slice(0, 10);
    const source = decodeXml(attributes.sourceName || 'unknown');
    const inRange = (day) => day >= this.firstDay && day <= this.lastDay;

    if (type === APPLE.sleep) {
      if (!isAsleep(attributes.value || '') || !inRange(endDay)) return;
      const start = parseAppleDate(attributes.startDate);
      const end = parseAppleDate(attributes.endDate);
      if (!(end > start)) return;
      const bySource = this.sleep.get(endDay) || new Map(); // sleep belongs to the day you wake up
      bySource.set(source, [...(bySource.get(source) || []), [start, end]]);
      this.sleep.set(endDay, bySource);
      this.recordsUsed += 1;
      return;
    }

    if (!inRange(startDay)) return;
    const value = Number(attributes.value);
    if (!Number.isFinite(value) || value < 0) return;
    this.recordsUsed += 1;

    if (type === APPLE.steps) bump(this.steps, startDay, source, value);
    else if (type === APPLE.energy) bump(this.energy, startDay, source, /kJ/i.test(attributes.unit || '') ? value / 4.184 : value);
    else {
      const target = type === APPLE.restingHeartRate ? this.restingHeartRate : this.hrv;
      const day = target.get(startDay) || { sum: 0, count: 0 };
      day.sum += value;
      day.count += 1;
      target.set(startDay, day);
    }
  }

  finish() {
    if (this.buffer.includes('<Record')) this.push(' '); // a final tag that was complete but not yet matched
    const days = new Map();
    const row = (day) => {
      if (!days.has(day)) days.set(day, { date: day });
      return days.get(day);
    };
    const keep = (value, min, max) => (Number.isFinite(value) && value >= min && value <= max ? value : undefined);

    for (const [day, bySource] of this.steps) {
      const value = keep(Math.round(bestSource(bySource)), 0, 200000);
      if (value !== undefined) row(day).steps = value;
    }
    for (const [day, bySource] of this.energy) {
      const value = keep(Math.round(bestSource(bySource)), 0, 20000);
      if (value !== undefined) row(day).active_calories = value;
    }
    for (const [day, bySource] of this.sleep) {
      const minutes = Math.max(...[...bySource.values()].map(mergedMinutes));
      const value = keep(Math.round(minutes), 1, 1440);
      if (value !== undefined) row(day).sleep_minutes = value;
    }
    for (const [day, { sum, count }] of this.restingHeartRate) {
      const value = keep(Math.round(sum / count), 20, 250);
      if (value !== undefined) row(day).resting_heart_rate = value;
    }
    for (const [day, { sum, count }] of this.hrv) {
      const value = keep(Math.round((sum / count) * 100) / 100, 0, 500);
      if (value !== undefined) row(day).hrv_ms = value;
    }
    return {
      days: [...days.values()].filter((item) => Object.keys(item).length > 1).sort((left, right) => left.date.localeCompare(right.date)),
      recordsRead: this.recordsRead,
      recordsUsed: this.recordsUsed,
    };
  }
}

// ------------------------------------------------------------------- zip

export class ZipError extends Error {
  constructor(reason) {
    super(`Zip error: ${reason}`);
    this.name = 'ZipError';
    this.reason = reason; // 'not_zip' | 'zip64' | 'no_export' | 'unsupported'
  }
}

const readU16 = (view, offset) => view.getUint16(offset, true);
const readU32 = (view, offset) => view.getUint32(offset, true);

// Finds export.xml inside the zip that the iPhone's Health app produces and returns it as a readable stream.
// Only stored and deflate entries are supported, which is all the Health app writes.
export async function openZipEntry(file, namePattern = /(^|\/)export\.xml$/i) {
  const tailSize = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let offset = tailSize - 22; offset >= 0; offset -= 1) {
    if (readU32(tail, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd === -1) throw new ZipError('not_zip');
  const entries = readU16(tail, eocd + 10);
  const directorySize = readU32(tail, eocd + 12);
  const directoryOffset = readU32(tail, eocd + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipError('zip64');

  const directory = await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer();
  const view = new DataView(directory);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 46 <= directory.byteLength && readU32(view, offset) === 0x02014b50) {
    const method = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const nameLength = readU16(view, offset + 28);
    const extraLength = readU16(view, offset + 30);
    const commentLength = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const name = decoder.decode(new Uint8Array(directory, offset + 46, nameLength));

    if (namePattern.test(name)) {
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('zip64');
      if (method !== 0 && method !== 8) throw new ZipError('unsupported');
      const local = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
      if (readU32(local, 0) !== 0x04034b50) throw new ZipError('not_zip');
      const start = localOffset + 30 + readU16(local, 26) + readU16(local, 28);
      const data = file.slice(start, start + compressedSize);
      return method === 0 ? data.stream() : data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new ZipError('no_export');
}

// Reads an Apple Health export (export.xml or the export.zip around it) and returns the daily numbers.
export async function parseAppleHealthFile(file, { today, sinceDays = 90, onProgress = () => {}, signal } = {}) {
  if (file.size > IMPORT_LIMITS.maxAppleBytes) return { ok: false, error: 'too_large', days: [] };
  const isZip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip';
  let stream;
  try {
    stream = isZip ? await openZipEntry(file) : file.stream();
  } catch (error) {
    if (error instanceof ZipError) return { ok: false, error: error.reason === 'no_export' ? 'no_export' : 'bad_zip', days: [] };
    throw error;
  }

  const parser = new AppleHealthParser({ today, sinceDays });
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let bytes = 0;
  let sawHealthData = false;
  try {
    for (;;) {
      if (signal?.aborted) return { ok: false, error: 'aborted', days: [] };
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      if (!sawHealthData && /<HealthData|<Record\s/.test(text)) sawHealthData = true;
      parser.push(text);
      onProgress(isZip ? Math.min(bytes / (file.size * 8), 0.99) : Math.min(bytes / file.size, 0.99));
    }
  } finally {
    reader.releaseLock();
  }
  parser.push(decoder.decode());
  const result = parser.finish();
  onProgress(1);
  if (!sawHealthData && result.recordsRead === 0) return { ok: false, error: 'not_health_export', days: [] };
  if (result.days.length === 0) return { ok: false, error: 'no_days', days: [], recordsRead: result.recordsRead };
  return {
    ok: true,
    days: result.days,
    recordsRead: result.recordsRead,
    recordsUsed: result.recordsUsed,
    range: { from: result.days[0].date, to: result.days[result.days.length - 1].date },
  };
}

// One call to the database accepts at most 400 days.
export function chunk(list, size = IMPORT_LIMITS.chunkDays) {
  const parts = [];
  for (let index = 0; index < list.length; index += size) parts.push(list.slice(index, index + size));
  return parts;
}

// Reads a text file chosen in the browser, refusing anything too large before it is read.
export async function readTextFile(file) {
  if (file.size > IMPORT_LIMITS.maxTextBytes) return { ok: false, error: 'too_large' };
  return { ok: true, text: await file.text() };
}
