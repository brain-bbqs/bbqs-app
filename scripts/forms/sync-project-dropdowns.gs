/**
 * BBQS — sync the "Grants" checkbox of the data-questionnaire Google Forms from the live KG.
 *
 * Replaces updateFormWithGrants(), which read a hand-exported Google Sheet (tab 'bbqs_projects').
 * This reads the grant list straight from the KG over PostgREST on a 6-hour trigger, so a newly
 * awarded grant becomes selectable on the next run with no manual export (Principle III: the forms
 * follow live state, not a hand-kept copy). The Sheet is no longer in the loop.
 *
 * Source: public RPC public.questionnaire_grant_options() (migration 20261019120000), returning
 * {grant_number, activity_code, title, pis} per grant. It is SECURITY DEFINER so PI surnames — which
 * anon cannot read from investigators directly (RLS) but which are already public on the site and
 * RePORTER — can be aggregated. The anon key below is the same public key the site ships; no secret.
 * This runs as whatever Google account owns this Apps Script project; that account must be able to
 * edit every form in FORM_IDS (today: admin@brain-bbqs.org).
 *
 * Label produced (matches the old format): "U01: <title> (PI(s): Suthana*)"  — '*' = Lead/Contact PI.
 * The old script appended a single trailing '*'; here the RPC marks the contact PI itself, so a
 * multi-PI grant marks the right name. Single-PI output is identical to before.
 *
 * ONE-TIME: run setup() (seeds Script Properties + installs the 6h trigger), then run
 * syncProjectDropdowns() once and read the Execution log. Edit values in
 * Project Settings → Script Properties, never in code. Set DRY_RUN=true for a no-write preview.
 */

var DEFAULTS = {
  SUPABASE_URL: 'https://vpexxhfpvghlejljwpvt.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwZXh4aGZwdmdobGVqbGp3cHZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3MDg2NDUsImV4cCI6MjA4NTI4NDY0NX0.M107rJ9Ji17zAyd8Jolt5GQFZmu9vvAG1UiIq0GQh8U',
  // Stored as JSON so adding a form is a settings edit, not a code change.
  FORM_IDS: JSON.stringify([
    '1McEq7k4oMB4oet7Up93TpaW5lmxzvZz9RpZ_iNSIJ18',
    '12gSNKdRwsNo1FnEr_SxdZLyu8kthko6GQlKZrF5jB4k',
    '1oQ9R8uEt8IbgY3h5-mSZ821F2dbUQ7efXkeLN8tl-u4',
    '1idTi5-X0zIYkZ8rkLoBDHad18ubfZc8B2ijkQlgTKJI',
    '1FS49c05n5OXKhOGoHlwt4vymXSsHSYem3FJCxFJxD2Y',
    '1SuDYTs3TVzq_QBdPjESKhuIReBshcLMGKemnNFT9LGs',
    '1HU-UtFeHTgQ1ACztw_LJRdKFydBui2Ibe47Yx8ajXos'
  ]),
  // The exact CHECKBOX question title the grant list populates. Matched exactly first, then on a
  // whitespace/case-normalized basis as a fallback.
  TARGET_QUESTION_TITLE: 'Grants (Please select all BBQS grants you are working on. Grants are organized by type and PIs are listed against each grant. *Lead/Contact PI)',
  // 'true' logs intended changes without writing. Flip to 'false' after eyeballing one run.
  DRY_RUN: 'false'
};

var TRIGGER_HANDLER = 'syncProjectDropdowns';
var TRIGGER_EVERY_HOURS = 6;

function cfg_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? DEFAULTS[key] : v;
}

/** One-time: seed any unset Script Properties with the defaults, then install the 6h trigger. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(DEFAULTS).forEach(function (k) {
    if (props.getProperty(k) === null) props.setProperty(k, DEFAULTS[k]);
  });
  installTrigger();
  Logger.log('setup complete. Properties seeded; %sh trigger installed. Run syncProjectDropdowns() once to verify.', TRIGGER_EVERY_HOURS);
}

/** Install (idempotently) the time-driven trigger for syncProjectDropdowns. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_HANDLER) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyHours(TRIGGER_EVERY_HOURS).create();
  Logger.log('trigger installed: %s every %s hours', TRIGGER_HANDLER, TRIGGER_EVERY_HOURS);
}

/** Log the project's triggers — run this to confirm the schedule from the execution log rather than
 *  hunting in the Triggers panel (the clock icon in the editor's left sidebar). */
function listTriggers() {
  var ts = ScriptApp.getProjectTriggers();
  if (!ts.length) { Logger.log('no triggers installed — run installTrigger()'); return; }
  ts.forEach(function (t) {
    Logger.log('trigger: handler=%s source=%s eventType=%s', t.getHandlerFunction(), t.getTriggerSource(), t.getEventType());
  });
}

/** Pull the project list from the KG (SECURITY DEFINER RPC) as the anon role. */
function fetchGrantOptions_() {
  var base = cfg_('SUPABASE_URL').replace(/\/+$/, '');
  var key = cfg_('SUPABASE_ANON_KEY');
  var res = UrlFetchApp.fetch(base + '/rest/v1/rpc/questionnaire_grant_options', {
    method: 'post',
    contentType: 'application/json',
    payload: '{}',
    muteHttpExceptions: true,
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' }
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('KG read failed (HTTP ' + code + '): ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/** Build the ordered, de-duplicated checkbox labels. "U01: <title> (PI(s): Suthana*)". */
function buildChoices_(rows) {
  var seen = {};
  var out = [];
  rows.forEach(function (r) {
    var code = (r.activity_code || '').toString().trim();
    var title = (r.title || '').toString().replace(/\s+/g, ' ').trim();
    if (!code || !title) return;
    var pis = (r.pis || '').toString().replace(/\s+/g, ' ').trim();
    var label = code + ': ' + title + (pis ? ' (PI(s): ' + pis + ')' : '');
    if (seen[label]) return;
    seen[label] = true;
    out.push(label);
  });
  return out;
}

function normTitle_(s) { return (s || '').toString().replace(/\s+/g, ' ').trim().toLowerCase(); }

/** Find the target CHECKBOX item: exact title match first, then whitespace/case-normalized. */
function findCheckbox_(form, targetTitle) {
  var items = form.getItems(FormApp.ItemType.CHECKBOX);
  var exact = items.filter(function (it) { return it.getTitle() === targetTitle; });
  if (exact.length) return exact[0].asCheckboxItem();
  var want = normTitle_(targetTitle);
  var loose = items.filter(function (it) { return normTitle_(it.getTitle()) === want; });
  return loose.length ? loose[0].asCheckboxItem() : null;
}

function sameList_(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Update one form's grants checkbox. Returns a per-form result object (never throws). */
function updateForm_(formId, choices, targetTitle, dryRun) {
  try {
    var form = FormApp.openById(formId);
    var item = findCheckbox_(form, targetTitle);
    if (!item) return { formId: formId, status: 'skipped', reason: 'checkbox question not found' };

    if (sameList_(item.getChoices().map(function (c) { return c.getValue(); }), choices)) {
      return { formId: formId, status: 'unchanged', count: choices.length };
    }
    if (dryRun) return { formId: formId, status: 'would-update', count: choices.length };

    item.setChoiceValues(choices);
    item.showOtherOption(true);   // setChoiceValues clears these, so re-assert (as the old script did)
    item.setRequired(true);
    return { formId: formId, status: 'updated', count: choices.length };
  } catch (e) {
    return { formId: formId, status: 'error', reason: String(e && e.message || e) };
  }
}

/** Main entry point — run by the 6h trigger and for manual verification. */
function syncProjectDropdowns() {
  var dryRun = String(cfg_('DRY_RUN')).toLowerCase() === 'true';
  var targetTitle = cfg_('TARGET_QUESTION_TITLE');
  var formIds = JSON.parse(cfg_('FORM_IDS'));

  var rows = fetchGrantOptions_();
  var choices = buildChoices_(rows);
  if (choices.length === 0) {
    throw new Error('Refusing to write: 0 grants returned — this would blank every checkbox.');
  }
  Logger.log('sample labels: %s', choices.slice(0, 3).join('  |  '));

  var results = formIds.map(function (id) { return updateForm_(id, choices, targetTitle, dryRun); });

  var tally = {};
  results.forEach(function (r) { tally[r.status] = (tally[r.status] || 0) + 1; });
  Logger.log('%s%s grants -> %s choices. Forms: %s',
    dryRun ? '[DRY RUN] ' : '', rows.length, choices.length, JSON.stringify(tally));
  results.forEach(function (r) {
    Logger.log('  %s  %s%s', r.status, r.formId, r.reason ? '  ' + r.reason : '  (' + r.count + ' choices)');
  });
  return results;
}
