import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import commonFoods from '../src/data/common-foods.json' with { type: 'json' };
import { buildFoodUrl, normalizeProduct, rankByLanguage } from '../api/_lib/foodSearch.js';
import { basisFromValues, entryToForm, joinPortion, splitPortion } from '../src/services/foodFormUtils.js';
import { scaleFoodPortion } from '../src/services/foodSearchUtils.js';
import { COMMON_FOOD_COUNT, hasArabic, mergeFoodResults, normalizeSearchText, searchLocalFoods } from '../src/services/localFoodSearch.js';
import {
  DRAWER_MAX_WIDTH, NAV_SEEN_KEY, RAIL_MAX_WIDTH, SIDEBAR_COLLAPSED_KEY, markPageSeen, readCollapsed, readSeenPages, tooltipPosition, writeCollapsed,
} from '../src/services/sidebarState.js';
import { NEW_PAGE_IDS, PAGES, navigationFor } from '../src/routes.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const names = (results) => results.map((item) => item.name);

// ------------------------------------------------------------------------------------------ local foods

test('the built-in food list has 1000+ foods with both names and believable numbers', () => {
  const { foods } = commonFoods;
  assert.ok(foods.length >= 1000, `only ${foods.length} foods`);
  assert.equal(COMMON_FOOD_COUNT, foods.length);
  assert.equal(new Set(foods.map((food) => food.id)).size, foods.length);
  for (const food of foods) {
    assert.ok(food.name.en && food.name.ar, food.id);
    assert.ok(hasArabic(food.name.ar), food.id);
    const { calories, protein_g: protein, carbs_g: carbs, fat_g: fat } = food.per100g;
    for (const value of [calories, protein, carbs, fat]) assert.ok(Number.isFinite(value) && value >= 0, food.id);
    assert.ok(calories <= 900 && protein + carbs + fat <= 100.5, food.id);
    const energy = protein * 4 + carbs * 4 + fat * 9;
    assert.ok(Math.abs(energy - calories) <= Math.max(25, calories * 0.18), `${food.id}: ${calories} kcal vs ${Math.round(energy)} from macros`);
  }
});

test('the everyday Arabic and Egyptian foods are all found by their Arabic names', () => {
  const wanted = ['شوفان', 'بيض', 'صدور دجاج', 'أوراك دجاج', 'أرز أبيض', 'أرز بسمتي', 'مكرونة', 'بطاطس', 'بطاطا', 'فول مدمس', 'جبنة قريش', 'تونة', 'لحم مفروم',
    'سمك بلطي', 'سلمون', 'عيش بلدي', 'توست', 'موز', 'تفاح', 'تمر', 'لبن', 'زبادي', 'لوز', 'سوداني', 'زيت زيتون', 'عسل', 'كشري', 'طعمية', 'ملوخية', 'جبنة رومي'];
  for (const word of wanted) {
    const results = searchLocalFoods(word, { locale: 'ar' });
    assert.ok(results.length > 0, word);
    assert.ok(results.every((item) => hasArabic(item.name)), `${word}: ${names(results)}`);
    assert.equal(results[0].source, 'local');
  }
});

test('local search answers in the language the person uses and forgives spelling variants', () => {
  assert.equal(names(searchLocalFoods('شوفان', { locale: 'en' }))[0], 'شوفان');
  assert.match(names(searchLocalFoods('oats', { locale: 'en' }))[0], /^Oats/);
  assert.equal(names(searchLocalFoods('oats', { locale: 'ar' }))[0], 'شوفان');
  assert.ok(names(searchLocalFoods('chicken breast')).every((name) => /chicken/i.test(name)));
  assert.equal(names(searchLocalFoods('الشوفان'))[0], 'شوفان');
  assert.equal(names(searchLocalFoods('ارز بسمتي'))[0], 'أرز بسمتي مطبوخ');
  assert.equal(names(searchLocalFoods('رز ابيض'))[0], 'أرز أبيض مطبوخ');
  assert.ok(names(searchLocalFoods('فراخ')).some((name) => name.includes('دجاج')));
  assert.deepEqual(searchLocalFoods('x'), []);
  assert.deepEqual(searchLocalFoods('   '), []);
  assert.deepEqual(searchLocalFoods('zzzzqqq'), []);
  assert.equal(normalizeSearchText('  أَرُزٌ  ١٢٣ '), 'ارز 123');
  assert.equal(normalizeSearchText('مَوْز'), 'موز');
});

test('a local result carries per 100 g values that scale like any other food', () => {
  const [oats] = searchLocalFoods('شوفان');
  assert.equal(oats.serving_g, 40);
  assert.deepEqual(scaleFoodPortion(oats.per100g, 40), { calories: 155.6, protein_g: 6.8, carbs_g: 26.5, fat_g: 2.8 });
  assert.deepEqual(scaleFoodPortion(oats.per100g, 100), oats.per100g);
});

test('local results come first and the same food from the database is not shown twice', () => {
  const local = searchLocalFoods('شوفان');
  const remote = [{ code: '1', name: 'شوفان', per100g: {} }, { code: '2', name: 'شوفان كويكر', per100g: {} }];
  const merged = mergeFoodResults(local, remote);
  assert.equal(names(merged).filter((name) => name === 'شوفان').length, 1);
  assert.equal(merged[0].source, 'local');
  const quaker = merged.find((item) => item.name === 'شوفان كويكر');
  assert.equal(quaker.source, 'openfoodfacts');
  assert.ok(merged.indexOf(quaker) > merged.findIndex((item) => item.source === 'local'));
});

// ----------------------------------------------------------------------------------- Open Food Facts

test('Arabic users ask Open Food Facts for Arabic and see Arabic-named products first', () => {
  assert.match(buildFoodUrl({ type: 'name', value: 'شوفان', lang: 'ar' }), /[?&]langs=ar%2Cen&/);
  assert.match(buildFoodUrl({ type: 'barcode', value: '3017620422003', lang: 'ar' }), /product\/3017620422003\.json\?lc=ar&/);
  assert.match(buildFoodUrl({ type: 'name', value: 'oats', lang: 'en' }), /langs=en&/);

  const nutriments = { 'energy-kcal_100g': 100 };
  const english = normalizeProduct({ code: '1', product_name: 'Oat flakes', nutriments }, 'ar');
  const arabic = normalizeProduct({ code: '2', product_name: 'Oat flakes', product_name_ar: 'رقائق الشوفان', nutriments }, 'ar');
  const arabicGeneral = normalizeProduct({ code: '3', product_name: 'شوفان سريع', nutriments }, 'ar');
  assert.equal(arabic.name, 'رقائق الشوفان');
  assert.equal(arabicGeneral.name, 'شوفان سريع');
  assert.deepEqual(rankByLanguage([english, arabic, arabicGeneral], 'ar').map((item) => item.code), ['2', '3', '1']);
  assert.deepEqual(rankByLanguage([english, arabic], 'en').map((item) => item.code), ['1', '2']);
  assert.equal(normalizeProduct({ code: '2', product_name: 'Oat flakes', product_name_ar: 'رقائق الشوفان', nutriments }, 'en').name, 'Oat flakes');
});

// ------------------------------------------------------------------------------------------ the form

test('the amount is kept in front of the notes and found again when a meal is edited', () => {
  assert.deepEqual(splitPortion('150 g · Acme'), { grams: '150', notes: 'Acme' });
  assert.deepEqual(splitPortion('40 جم · بدون سكر'), { grams: '40', notes: 'بدون سكر' });
  assert.deepEqual(splitPortion('12,5 g'), { grams: '12.5', notes: '' });
  assert.deepEqual(splitPortion('with lemon'), { grams: '', notes: 'with lemon' });
  assert.deepEqual(splitPortion('150 grapes'), { grams: '', notes: '150 grapes' });
  assert.equal(joinPortion({ grams: '150', unit: 'جم', notes: 'بدون سكر' }), '150 جم · بدون سكر');
  assert.equal(joinPortion({ grams: '', notes: ' note ' }), 'note');
  assert.equal(joinPortion({ grams: '0', notes: '' }), '');
  const round = joinPortion({ grams: '85.5', unit: 'g', notes: 'x' });
  assert.deepEqual(splitPortion(round), { grams: '85.5', notes: 'x' });
});

test('the person\'s own numbers become the base, so a new amount scales them', () => {
  const basis = basisFromValues({ calories: '200', protein_g: '10', carbs_g: '30', fat_g: '' }, '50');
  assert.deepEqual(basis, { calories: 400, protein_g: 20, carbs_g: 60, fat_g: 0 });
  assert.deepEqual(scaleFoodPortion(basis, 75), { calories: 300, protein_g: 15, carbs_g: 45, fat_g: 0 });
  assert.equal(basisFromValues({ calories: '', protein_g: '' }, '50'), null);
  assert.equal(basisFromValues({ calories: '100' }, ''), null);
  assert.equal(basisFromValues({ calories: '100' }, '0'), null);

  const form = entryToForm({ meal_type: 'lunch', food_name: 'Rice', ingredients: '150 g · plain', calories: 195, protein_g: 4, carbs_g: null, fat_g: 0.5 });
  assert.deepEqual(form.entry, { meal_type: 'lunch', food_name: 'Rice', ingredients: 'plain', calories: '195', protein_g: '4', carbs_g: '', fat_g: '0.5' });
  assert.equal(form.grams, '150');
});

test('the Food Logger offers quick add, full edit and the local list', () => {
  const component = read('src/components/ClientFoodLogger.jsx');
  for (const piece of ['searchLocalFoods', 'foodQuickAdd', 'quickAdd', 'startEdit', 'updateFoodLog', 'foodNotes', 'chooseFood']) assert.ok(component.includes(piece), piece);
  assert.match(read('src/services/clientFoodService.js'), /export async function updateFoodLog/);
  // Choosing a result must fill the form, not save it.
  const chooseBody = component.slice(component.indexOf('function chooseFood'), component.indexOf('function quickAdd'));
  assert.doesNotMatch(chooseBody, /addFoodLog|updateFoodLog/);
  const css = read('src/styles/app.css');
  assert.match(css, /\.food-totals dd \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.client-feature-grid\.food-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

// ------------------------------------------------------------------------------------------ the sidebar

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, values };
}

test('the open or closed state of the sidebar is remembered and storage problems never break it', () => {
  const storage = memoryStorage();
  assert.equal(readCollapsed(storage), false);
  writeCollapsed(storage, true);
  assert.equal(storage.values.get(SIDEBAR_COLLAPSED_KEY), '1');
  assert.equal(readCollapsed(storage), true);
  writeCollapsed(storage, false);
  assert.equal(readCollapsed(storage), false);

  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readCollapsed(broken), false);
  assert.doesNotThrow(() => writeCollapsed(broken, true));
  assert.equal(readCollapsed(null), false);
  assert.deepEqual(readSeenPages(broken), []);
  assert.ok(DRAWER_MAX_WIDTH < RAIL_MAX_WIDTH);
  const sheet = read('src/styles/app.css');
  assert.match(sheet, new RegExp(`@media \\(max-width: ${RAIL_MAX_WIDTH}px\\)`));
  assert.match(sheet, new RegExp(`@media \\(min-width: ${DRAWER_MAX_WIDTH + 1}px\\) and \\(max-width: ${RAIL_MAX_WIDTH}px\\)`));
  assert.match(sheet, new RegExp(`@media \\(max-width: ${DRAWER_MAX_WIDTH}px\\)`));
});

test('a "New" badge is shown until the page has been opened', () => {
  const storage = memoryStorage({ [NAV_SEEN_KEY]: 'not json' });
  assert.deepEqual(readSeenPages(storage), []);
  assert.deepEqual(markPageSeen(storage, 'campaigns'), ['campaigns']);
  assert.deepEqual(markPageSeen(storage, 'campaigns'), ['campaigns']);
  assert.deepEqual(readSeenPages(storage), ['campaigns']);
  for (const id of NEW_PAGE_IDS) assert.ok(PAGES[id], id);
});

test('the label of a collapsed item floats on the side the page is not on', () => {
  const rect = { top: 100, height: 40, left: 10, right: 62 };
  assert.deepEqual(tooltipPosition(rect, { rtl: false, viewportWidth: 1200 }), { top: 120, left: 72 });
  assert.deepEqual(tooltipPosition({ ...rect, left: 1138, right: 1190 }, { rtl: true, viewportWidth: 1200 }), { top: 120, right: 72 });
});

test('every role\'s menu is split into named sections, each page appears once and every heading is translated', () => {
  for (const role of ['coach', 'client', 'trainer']) {
    const sections = navigationFor(role);
    assert.ok(sections.length >= 2, role);
    const ids = sections.flatMap((section) => section.items);
    assert.equal(new Set(ids).size, ids.length, `${role} lists a page twice`);
    for (const section of sections) {
      assert.ok(section.items.length > 0, `${role}/${section.group}`);
      for (const locale of supportedLocales) assert.ok(translations[locale][section.group], `${locale}.${section.group}`);
    }
  }
  assert.deepEqual(navigationFor('coach').map((section) => section.group), ['navGrpTraining', 'navGrpClients', 'navGrpBusiness', 'navGrpAccount']);
  assert.deepEqual(navigationFor('client').map((section) => section.group), ['navGrpTrainNutrition', 'navGrpTracking', 'navGrpSocial', 'navGrpAccount']);
  assert.equal(translations.ar.navGrpTraining, 'التدريب والخطط');
  assert.equal(translations.ar.navGrpTracking, 'المتابعة والتطور');
});

test('the shell has the toggle, the saved state, the tooltip and a drawer that closes on Escape', () => {
  const shell = read('src/components/AppShell.jsx');
  for (const piece of ['sidebar-toggle', 'readCollapsed', 'writeCollapsed', 'nav-tooltip', "event.key === 'Escape'", 'nav-badge-new', 'aria-expanded']) assert.ok(shell.includes(piece), piece);
  const css = read('src/styles/app.css');
  assert.match(css, /\.app-shell:is\(\.is-collapsed, \.is-rail\) \{ --sidebar-width: 72px; \}/);
  assert.match(css, /:is\(\.is-collapsed, \.is-rail\) \.nav-link\.is-active/);
  assert.match(css, /inset-inline-end/);
  assert.match(css, /\[dir='rtl'\] \.sidebar-toggle-icon/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.sidebar, \.main-area/);
});

test('every language has the new sidebar and food texts', () => {
  const keys = ['sidebarCollapse', 'sidebarExpand', 'sidebarNew', 'closeNavigation', 'foodQuickAdd', 'foodSourceLocal', 'foodSourceOff', 'foodDetailsTitle', 'foodNotes',
    'foodPortionManualHint', 'foodEdit', 'foodEditTitle', 'foodEditing', 'foodSave', 'foodSaving', 'foodCancelEdit', 'foodClearForm', 'foodUpdated', 'foodUpdateError'];
  for (const locale of supportedLocales) {
    for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
    assert.ok(translations[locale].foodQuickAdd.includes('{name}'), `${locale} quick add keeps its placeholder`);
  }
  assert.match(translations.ar.foodQuickAdd, /^إضافة "\{name\}" كوجبة جديدة$/);
});
