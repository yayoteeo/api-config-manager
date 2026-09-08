// 执行生产函数，模拟 DOM、保存和 API 应用；不读取真实配置或调用真实服务。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function extract(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Missing production boundary: ${start}`);
    return source.slice(from, to);
}
const helpers = extract('function normalizePreferredModels(', 'function initSettings(');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(configs = []) {
    const calls = { saves: 0, renders: 0, drafts: 0, updates: 0, discarded: [], applied: [], confirms: [], messages: [] };
    const values = new Map();
    const settings = { configs, collapsedGroups: {}, theme: 'dark' };
    const context = vm.createContext({
        MODULE_NAME: 'api-config-manager', extension_settings: { 'api-config-manager': settings },
        defaultSettings: { theme: 'light' }, MANAGER_THEMES: { light: '', dark: '', tavern: '' },
        SECRET_KEYS: { CUSTOM: 'custom', MAKERSUITE: 'makersuite' },
        CHAT_COMPLETION_SOURCES: { CUSTOM: 'custom', MAKERSUITE: 'makersuite' },
        SOURCE_SECRET_KEYS: { custom: 'custom', makersuite: 'makersuite' },
        normalizeSource: value => value === 'makersuite' ? 'makersuite' : 'custom',
        editingIndex: -1, editorModels: [], editorDefaultModel: '', expandedModelConfigs: new WeakSet(), lastConnectionSummary: 'unchanged',
        $: selector => ({
            val(value) { if (!arguments.length) return values.get(selector) ?? ''; values.set(selector, value); return this; },
            text() { return this; }, hide() { return this; }, trigger() { return this; }, scrollTop() { return this; },
            find() { return this; }, get() { return undefined; }, length: 0,
        }),
        document: { getElementById: () => null },
        saveSettingsDebounced: () => calls.saves++, renderConfigList: () => calls.renders++,
        discardConfigConnection: config => calls.discarded.push(config),
        updateFormBySource() {}, showManagerView() {},
        applyConfig: async (config, model) => calls.applied.push({ config, model }),
        confirm: message => { calls.confirms.push(message); return context.confirmResult; }, confirmResult: true,
        toastr: Object.fromEntries(['success', 'error', 'info'].map(type => [type, (...args) => calls.messages.push({ type, args })])),
        fetch: () => { throw new Error('Model actions must not send connection tests'); },
    });
    vm.runInContext([
        helpers,
        extract('function initSettings(', '// 获取当前API配置'),
        extract('function setEditorModels(', 'function updateFormBySource('),
        extract('function updateConfigModelsUI(', '// 置顶只改变展示位置'),
        extract('function editConfig(', '// 创建紧凑入口'),
        'renderEditorModels = () => recordDraftRender(); updateConfigModelsUI = () => recordCardUpdate();',
    ].join('\n'), context);
    context.recordDraftRender = () => calls.drafts++;
    context.recordCardUpdate = () => calls.updates++;
    function fillForm(fields = {}) {
        const defaults = { name: 'Models', source: 'custom', url: 'https://models.invalid/v1', key: 'TEST-ONLY', group: '', 'reverse-proxy': '', 'proxy-password': '', model: '' };
        for (const [key, value] of Object.entries({ ...defaults, ...fields })) values.set('#api-config-' + key, value);
    }
    fillForm();
    return { context, calls, values, settings, fillForm };
}

test('models trim and deduplicate while preserving order, case and literal special characters', () => {
    const { context: c } = fixture();
    assert.deepEqual(plain(c.normalizePreferredModels([' a ', '', null, 42, {}, 'a', 'A', 'x/y:beta', '<img src=x>', 'x,y'])), ['a', 'A', 'x/y:beta', '<img src=x>', 'x,y']);
});

test('legacy model is used only when an explicit preferred-model array does not exist', () => {
    const { context: c } = fixture();
    assert.deepEqual(plain(c.getConfigModels({ model: ' legacy ' })), ['legacy']);
    assert.deepEqual(plain(c.getConfigModels({ model: 'old', models: [] })), []);
    assert.deepEqual(plain(c.getConfigModels({ model: 'old', models: ['new', null, ' new '] })), ['new']);
    assert.deepEqual(plain(c.getConfigModels(undefined)), []);
    assert.deepEqual(plain(c.getConfigModels({ model: { id: 'bad' } })), []);
});

test('migration is idempotent and keeps config identity, groups, pins and saved secret references', () => {
    const config = { name: 'Legacy', model: 'old', url: 'https://legacy.invalid/v1', group: 'Z', pinned: true, secretId: 'TEST-SECRET-ID' };
    const f = fixture([config]);
    f.context.initSettings();
    assert.equal(f.settings.configs[0], config);
    assert.deepEqual(plain(config.models), ['old']);
    assert.equal(config.model, 'old');
    assert.equal(config.pinned, true);
    assert.equal(config.group, 'Z');
    assert.equal(config.secretIds.custom, 'TEST-SECRET-ID');
    const snapshot = JSON.stringify(f.settings);
    f.context.initSettings();
    assert.equal(JSON.stringify(f.settings), snapshot);
    assert.equal(f.calls.saves, 0);
});

test('default follows the saved selection, otherwise the first remaining model without reordering', () => {
    const { context: c } = fixture();
    const config = { models: ['one', 'two'], model: 'two' };
    assert.equal(c.getConfigDefaultModel(config), 'two');
    c.setConfigModels(config, ['one', 'two'], 'missing');
    assert.equal(config.model, 'one');
    assert.deepEqual(plain(config.models), ['one', 'two']);
    c.setConfigModels(config, []);
    assert.equal(config.model, undefined);
});

test('adding and removing editor models changes only the draft and does not duplicate entries', () => {
    const f = fixture(); const c = f.context;
    for (const model of ['first', ' second ', 'second', '', '   ']) c.addEditorModel(model);
    assert.deepEqual(plain(c.editorModels), ['first', 'second']);
    assert.equal(c.editorDefaultModel, 'first');
    c.setEditorModels(c.editorModels, 'second');
    c.removeEditorModel(0);
    assert.deepEqual(plain(c.editorModels), ['second']);
    assert.equal(c.editorDefaultModel, 'second');
    c.removeEditorModel(0);
    assert.equal(c.editorDefaultModel, '');
    assert.equal(f.calls.saves, 0);
    assert.equal(f.settings.configs.length, 0);
});

test('saving includes the unadded final input and persists the chosen default with all models', () => {
    const f = fixture(); const c = f.context;
    c.setEditorModels(['first', 'second'], 'second');
    f.fillForm({ model: ' third ' });
    c.saveNewConfig();
    assert.deepEqual(plain(f.settings.configs[0].models), ['first', 'second', 'third']);
    assert.equal(f.settings.configs[0].model, 'second');
    assert.equal(f.calls.saves, 1);
    assert.deepEqual(plain(c.editorModels), []);
    assert.equal(c.editorDefaultModel, '');
    assert.equal(f.values.get('#api-config-model'), '');
});

test('validation keeps the model draft; cancelling clears it without saving', () => {
    const f = fixture(); const c = f.context;
    c.setEditorModels(['draft']); f.fillForm({ name: '', model: 'pending' }); c.saveNewConfig();
    assert.deepEqual(plain(c.editorModels), ['draft']);
    assert.equal(f.values.get('#api-config-model'), 'pending');
    assert.equal(f.calls.saves, 0);
    c.cancelEditConfig();
    assert.deepEqual(plain(c.editorModels), []);
    assert.equal(f.values.get('#api-config-model'), '');
});

test('editing a legacy model retains it and a new model without dropping pin or unchanged credentials', () => {
    const config = { name: 'Legacy', source: 'custom', url: 'https://old.invalid/v1', key: 'TEST-ONLY', pinned: true, secretId: 'TEST-ID', model: 'old' };
    const f = fixture([config]); const c = f.context;
    c.editConfig(0);
    assert.deepEqual(plain(c.editorModels), ['old']);
    assert.equal(f.values.get('#api-config-model'), '');
    c.addEditorModel('new'); c.saveNewConfig();
    assert.deepEqual(plain(f.settings.configs[0].models), ['old', 'new']);
    assert.equal(f.settings.configs[0].model, 'old');
    assert.equal(f.settings.configs[0].pinned, true);
    assert.equal(f.settings.configs[0].secretId, 'TEST-ID');
});

test('a model is optional and deleting draft entries never restores the old model on save', () => {
    const f = fixture([{ name: 'Legacy', url: 'https://old.invalid', model: 'old' }]);
    f.context.editConfig(0); f.context.removeEditorModel(0); f.context.saveNewConfig();
    assert.deepEqual(plain(f.settings.configs[0].models), []);
    assert.equal(f.settings.configs[0].model, undefined);
});

test('applying an individual model saves the new default in place and preserves unrelated state', async () => {
    const config = { name: 'First', models: ['a', 'b'], model: 'a', pinned: true, key: 'TEST-ONLY', secretIds: { custom: 'TEST-ID' } };
    const other = { name: 'Other', model: 'c' }; const f = fixture([config, other]);
    const c = f.context;
    c.editConfig(0); c.addEditorModel('unsaved');
    await c.applyConfigModel(0, 'b');
    await c.applyConfigModel(0, 'b');
    assert.equal(f.settings.configs[0], config);
    assert.equal(config.model, 'b');
    assert.deepEqual(plain(config.models), ['a', 'b']);
    assert.deepEqual(plain(c.editorModels), ['a', 'b', 'unsaved']);
    assert.equal(c.editorDefaultModel, 'b');
    assert.equal(f.calls.saves, 1);
    assert.equal(f.calls.applied.length, 2);
    assert.equal(f.calls.applied[0].config, config);
    assert.equal(f.calls.applied[0].model, 'b');
    assert.equal(f.settings.configs[1], other);
    assert.equal(config.secretIds.custom, 'TEST-ID');
    assert.equal(c.lastConnectionSummary, 'unchanged');
    assert.deepEqual(f.calls.discarded, []);
});

test('unknown or stale model actions are ignored and deletion respects confirmation', async () => {
    const config = { name: 'Saved', models: ['a', 'b'], model: 'a' }; const f = fixture([config]);
    await f.context.applyConfigModel(10, 'a'); await f.context.applyConfigModel(0, 'missing');
    f.context.deleteConfigModel(0, 'missing'); f.context.deleteConfigModel(3, 'a');
    assert.equal(f.calls.confirms.length, 0);
    f.context.confirmResult = false; f.context.deleteConfigModel(0, 'a');
    assert.equal(f.calls.confirms.length, 1);
    assert.deepEqual(config.models, ['a', 'b']);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.calls.applied.length, 0);
});

test('deleting the default picks a remaining model; deleting the last never deletes the config or revives it on reload', () => {
    const config = { name: 'Saved', models: ['a', 'b'], model: 'b', key: 'TEST-ONLY', pinned: true };
    const f = fixture([config]); const c = f.context;
    c.deleteConfigModel(0, 'b');
    assert.equal(config.model, 'a');
    c.deleteConfigModel(0, 'a'); c.initSettings();
    assert.equal(f.settings.configs.length, 1);
    assert.equal(f.settings.configs[0], config);
    assert.deepEqual(plain(config.models), []);
    assert.equal(config.model, undefined);
    assert.equal(config.pinned, true);
    assert.equal(config.key, 'TEST-ONLY');
    assert.equal(f.calls.saves, 2);
    assert.deepEqual(f.calls.discarded, []);
    const reloaded = fixture(plain(f.settings.configs)); reloaded.context.initSettings();
    assert.deepEqual(plain(reloaded.context.getConfigModels(reloaded.settings.configs[0])), []);
});

test('deleting a saved model also removes it from an open draft without losing other unsaved edits', () => {
    const f = fixture([{ name: 'Saved', url: 'https://saved.invalid', models: ['a', 'b'], model: 'b' }]); const c = f.context;
    c.editConfig(0); c.addEditorModel('unsaved');
    f.values.set('#api-config-name', 'Unsaved title'); f.values.set('#api-config-model', 'b');
    c.deleteConfigModel(0, 'b');
    assert.deepEqual(plain(c.editorModels), ['a', 'unsaved']);
    assert.equal(c.editorDefaultModel, 'a');
    assert.equal(f.values.get('#api-config-name'), 'Unsaved title');
    assert.equal(f.values.get('#api-config-model'), '');
    c.saveNewConfig();
    assert.deepEqual(plain(f.settings.configs[0].models), ['a', 'unsaved']);
});

test('expansion follows config identity after index shifts and never saves or applies', () => {
    const config = { name: 'Multi', models: ['a', 'b'] }; const f = fixture([{ name: 'None' }, config]); const c = f.context;
    c.toggleConfigModels(0); assert.equal(c.expandedModelConfigs.has(f.settings.configs[0]), false);
    c.toggleConfigModels(1); assert.equal(c.expandedModelConfigs.has(config), true);
    f.settings.configs.shift();
    assert.equal(c.expandedModelConfigs.has(config), true);
    c.toggleConfigModels(0); assert.equal(c.expandedModelConfigs.has(config), false);
    assert.equal(f.calls.saves, 0); assert.equal(f.calls.applied.length, 0);
});

function applicationFixture() {
    const timers = new Map(); let timerId = 0;
    const calls = { selected: [], sources: [], connects: 0, errors: [] };
    const c = vm.createContext({
        configApplySequence: 0, modelSelectionTimer: null,
        CHAT_COMPLETION_SOURCES: { CUSTOM: 'custom', MAKERSUITE: 'makersuite' },
        normalizeSource: value => value, getSourceLabel: value => value,
        getModelSelectSelector: value => '#model_' + value,
        setChatCompletionSource: value => calls.sources.push(value), setReverseProxyFields() {},
        setSourceSecretIfProvided: async () => {}, saveSettingsDebounced() {},
        setPreferredModel: (model, name, source) => calls.selected.push({ model, name, source }),
        oai_settings: {},
        $: selector => ({ length: 1, val() { return this; }, trigger(event) { if (selector === '#api_button_openai' && event === 'click') calls.connects++; return this; }, find: () => ({ length: 0 }) }),
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        toastr: { success() {}, error: (...args) => calls.errors.push(args) }, console,
    });
    vm.runInContext(helpers + '\n' + extract('async function applyConfig(', '// 设置首选模型'), c);
    return { c, calls, timers };
}

test('normal apply chooses the stored default for both supported sources', async () => {
    for (const source of ['custom', 'makersuite']) {
        const f = applicationFixture();
        await f.c.applyConfig({ name: 'Config', source, models: ['a', 'b'], model: 'b' });
        assert.deepEqual(f.calls.selected, [{ model: 'b', name: 'Config', source }]);
        assert.equal(f.calls.connects, 1);
        assert.equal(f.calls.errors.length, 0);
    }
});

test('rapid model changes cancel the old retry so stale connection checks cannot overwrite the latest selection', async () => {
    const f = applicationFixture(); const config = { name: 'Config', models: ['a', 'b'], model: 'a' };
    await f.c.applyConfig(config, 'a');
    const oldCheck = [...f.timers.values()][0];
    await f.c.applyConfig(config, 'b');
    assert.equal(f.timers.size, 1);
    const currentTimer = f.c.modelSelectionTimer;
    oldCheck();
    assert.equal(f.c.modelSelectionTimer, currentTimer);
    assert.deepEqual(f.calls.selected.map(item => item.model), ['a', 'b']);
    await f.c.applyConfig({ name: 'No model', models: [] });
    assert.equal(f.timers.size, 0);
    oldCheck();
    assert.deepEqual(f.calls.selected.map(item => item.model), ['a', 'b']);
});

test('superseded async apply never starts its model selection or reconnect', async () => {
    const f = applicationFixture(); const releases = [];
    f.c.setSourceSecretIfProvided = () => new Promise(resolve => releases.push(resolve));
    const first = f.c.applyConfig({ name: 'First', model: 'a' });
    const last = f.c.applyConfig({ name: 'Last', model: 'b' });
    releases[0](); await first;
    assert.equal(f.calls.selected.length, 0); assert.equal(f.calls.connects, 0);
    releases[1](); await last;
    assert.deepEqual(f.calls.selected.map(item => item.model), ['b']);
    assert.equal(f.calls.connects, 1);
});