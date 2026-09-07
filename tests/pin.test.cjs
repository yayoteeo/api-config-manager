// 不依赖浏览器的置顶回归：执行实际排序、置顶和保存函数，DOM/保存/联网均为模拟。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function extract(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `Production code boundary not found: ${start}`);
    return source.slice(from, to);
}
const toggleSource = extract('function toggleConfigPin(', '// 渲染配置列表');
const saveSource = extract('function saveNewConfig()', 'function updateFormBySource(');
const groupingSource = extract('    // 置顶区跨分组', '    sections.forEach(');
const plain = value => JSON.parse(JSON.stringify(value));
const itemsFor = configs => configs.map((config, index) => ({ config, index }));

function fixture(configs = []) {
    const calls = { saves: 0, renders: 0, discarded: [], views: [], messages: [] };
    const values = new Map();
    const settings = { configs, collapsedGroups: {}, theme: 'tavern' };
    function $(selector) {
        return {
            val(value) { if (!arguments.length) return values.get(selector) ?? ''; values.set(selector, value); return this; },
            text() { return this; }, hide() { return this; }, filter() { return this; }, get() { return undefined; },
        };
    }
    const forbidden = () => { throw new Error('Pinning must not connect, apply or mutate active credentials'); };
    const context = vm.createContext({
        $, MODULE_NAME: 'api-config-manager', extension_settings: { 'api-config-manager': settings },
        CHAT_COMPLETION_SOURCES: { CUSTOM: 'custom', MAKERSUITE: 'makersuite' },
        SOURCE_SECRET_KEYS: { custom: 'custom', makersuite: 'makersuite' },
        normalizeSource: source => source === 'makersuite' ? 'makersuite' : 'custom',
        editingIndex: -1, lastConnectionSummary: 'Previous connection results',
        document: { querySelector: () => null, getElementById: () => null },
        saveSettingsDebounced: () => calls.saves++, renderConfigList: () => calls.renders++,
        discardConfigConnection: config => calls.discarded.push(config),
        updateFormBySource: () => {}, showManagerView: view => calls.views.push(view),
        toastr: Object.fromEntries(['success', 'error', 'info'].map(type => [type, (...args) => calls.messages.push({ type, args })])),
        fetch: forbidden, connectConfig: forbidden, applyConfig: forbidden, writeSecret: forbidden, rotateSecret: forbidden,
    });
    vm.runInContext(`${toggleSource}\n${saveSource}\nfunction groupItems(matches) {\n${groupingSource}\nreturn sections;\n}`, context);
    function fillForm(fields = {}) {
        const defaults = { name: 'Pin Draft', group: '', source: 'custom', url: 'https://new.invalid/v1', key: '', 'reverse-proxy': '', 'proxy-password': '', model: '' };
        for (const [field, value] of Object.entries({ ...defaults, ...fields })) values.set('#api-config-' + field, value);
    }
    fillForm();
    return { settings, calls, values, context, fillForm, toggle: context.toggleConfigPin, save: context.saveNewConfig, group: context.groupItems };
}

test('legacy and empty libraries retain alphabetical groups with no pinned section', () => {
    const configs = [{ name: 'B', group: 'Z' }, { name: 'A', group: 'A' }, { name: 'No group' }];
    const f = fixture(configs);
    assert.deepEqual(plain(f.group([])), []);
    const sections = f.group(itemsFor(configs));
    assert.deepEqual(plain(sections.map(section => section.groupName)), ['A', 'Z', '未分组']);
    assert.ok(sections.every(section => !section.pinned));
    assert.ok(configs.every(config => !Object.hasOwn(config, 'pinned')));
});

test('multiple pins come first across groups, remain stable and never duplicate or mutate configs', () => {
    const configs = [{ name: 'Normal', group: 'A' }, { name: 'Pinned Z', group: 'Z', pinned: true }, { name: 'Pinned A', group: 'A', pinned: true }, { name: 'Normal B', group: 'B' }];
    const before = JSON.stringify(configs);
    const sections = fixture(configs).group(itemsFor(configs));
    assert.equal(sections[0].pinned, true);
    assert.deepEqual(plain(sections[0].groupItems.map(item => item.index)), [1, 2]);
    assert.deepEqual(plain(sections.map(section => section.groupName)), ['置顶', 'A', 'B']);
    const allItems = sections.flatMap(section => section.groupItems);
    assert.equal(allItems.length, configs.length);
    assert.equal(new Set(allItems.map(item => item.config)).size, configs.length);
    assert.equal(JSON.stringify(configs), before);
});

test('pinned section cannot collide with named or prototype groups and only boolean true pins', () => {
    const configs = [{ group: '置顶', pinned: true }, { group: '置顶' }, { group: '__proto__', pinned: 'false' }, { group: 'constructor', pinned: false }];
    const sections = fixture(configs).group(itemsFor(configs));
    assert.equal(sections.length, 4);
    assert.equal(sections[0].groupItems.length, 1);
    assert.equal(sections.filter(section => section.groupName === '置顶').length, 2);
    assert.ok(sections.some(section => section.groupName === '__proto__' && !section.pinned));
    assert.ok(sections.some(section => section.groupName === 'constructor' && !section.pinned));
});

test('filtered and all-pinned lists retain original action indices without empty groups', () => {
    const f = fixture();
    const sections = f.group([{ config: { name: 'Normal', group: 'A' }, index: 3 }, { config: { name: 'Pinned', pinned: true }, index: 17 }]);
    assert.deepEqual(plain(sections.flatMap(section => section.groupItems.map(item => item.index))), [17, 3]);
    const pinnedOnly = f.group([{ config: { pinned: true }, index: 6 }, { config: { group: 'A', pinned: true }, index: 20 }]);
    assert.equal(pinnedOnly.length, 1);
    assert.deepEqual(plain(pinnedOnly[0].groupItems.map(item => item.index)), [6, 20]);
});

test('pin and unpin save once each without changing array identity, editing or connection state', () => {
    const configs = [{ name: 'First', group: 'A' }, { name: 'Target', group: 'Z', key: 'TEST-ONLY' }];
    const target = configs[1];
    const f = fixture(configs);
    f.context.editingIndex = 0;
    f.settings.collapsedGroups.Z = true;
    f.fillForm({ name: 'Unsaved draft' });
    f.toggle(1);
    assert.equal(target.pinned, true);
    assert.equal(f.calls.saves, 1);
    assert.equal(f.group(itemsFor(configs))[0].groupItems[0].config, target);
    f.toggle(1);
    assert.equal(target.pinned, false);
    assert.equal(target.group, 'Z');
    assert.equal(f.settings.configs, configs);
    assert.equal(f.settings.configs[1], target);
    assert.equal(f.settings.collapsedGroups.Z, true);
    assert.equal(f.context.editingIndex, 0);
    assert.equal(f.values.get('#api-config-name'), 'Unsaved draft');
    assert.equal(f.context.lastConnectionSummary, 'Previous connection results');
    assert.equal(f.calls.saves, 2);
    assert.equal(f.calls.renders, 2);
    assert.deepEqual(f.calls.discarded, []);
});

test('invalid pin indices make no changes or saves', () => {
    const configs = [{ name: 'Untouched' }];
    const f = fixture(configs);
    for (const index of [-1, 1, 99, 0.5, NaN, Infinity, undefined, null, '0']) f.toggle(index);
    assert.deepEqual(configs, [{ name: 'Untouched' }]);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.calls.renders, 0);
});

test('persisted pins survive JSON settings reload and preserve original groups', () => {
    const f = fixture([{ name: 'Saved', group: 'Z' }, { name: 'Other', group: 'A' }]);
    f.toggle(0);
    const restored = fixture(plain(f.settings).configs);
    const sections = restored.group(itemsFor(restored.settings.configs));
    assert.equal(sections[0].pinned, true);
    assert.equal(sections[0].groupItems[0].config.name, 'Saved');
    assert.equal(sections[0].groupItems[0].config.group, 'Z');
    assert.equal(restored.calls.saves, 0);
});

test('editing a pinned config preserves pin state while updating only the selected config', () => {
    const original = { name: 'Old', group: 'Original', pinned: true, source: 'custom', key: 'TEST-ONLY-OLD' };
    const other = { name: 'Other', group: 'A' };
    const f = fixture([other, original]);
    f.context.editingIndex = 1;
    f.fillForm({ name: 'Edited', group: 'Changed', key: 'TEST-ONLY-NEW', url: 'https://edited.invalid/v1' });
    f.save();
    assert.equal(f.settings.configs.length, 2);
    assert.equal(f.settings.configs[0], other);
    assert.equal(f.settings.configs[1].pinned, true);
    assert.equal(f.settings.configs[1].group, 'Changed');
    assert.equal(f.settings.configs[1].name, 'Edited');
    assert.equal(f.settings.configs[1].customUrl, 'https://edited.invalid/v1');
    assert.equal(f.context.editingIndex, -1);
    assert.deepEqual(f.calls.discarded, [original]);
    assert.equal(f.calls.saves, 1);
    assert.deepEqual(f.calls.views, ['list']);
});

test('same-name overwrite preserves both pinned and explicitly unpinned configs', () => {
    for (const pinned of [true, false]) {
        const previous = { name: 'Existing', pinned, source: 'custom', key: 'TEST-ONLY-OLD' };
        const f = fixture([previous]);
        f.fillForm({ name: 'Existing', key: 'TEST-ONLY-REPLACEMENT' });
        f.save();
        assert.equal(f.settings.configs.length, 1);
        assert.equal(f.settings.configs[0].pinned, pinned);
        assert.equal(f.settings.configs[0].key, 'TEST-ONLY-REPLACEMENT');
        assert.deepEqual(f.calls.discarded, [previous]);
        assert.equal(f.calls.saves, 1);
    }
});

test('switching sources retains pins; invalid saves and new configs never inherit an unrelated pin', () => {
    const f = fixture([{ name: 'Pinned', pinned: true, source: 'custom' }]);
    f.context.editingIndex = 0;
    f.fillForm({ name: '' }); f.save();
    assert.equal(f.calls.saves, 0);
    assert.equal(f.settings.configs[0].pinned, true);
    f.fillForm({ name: 'Google', source: 'makersuite', key: 'TEST-ONLY-GOOGLE' }); f.save();
    assert.equal(f.settings.configs[0].source, 'makersuite');
    assert.equal(f.settings.configs[0].pinned, true);
    f.fillForm({ name: 'New' }); f.save();
    assert.equal(f.settings.configs.length, 2);
    assert.notEqual(f.settings.configs[1].pinned, true);
    assert.equal(f.settings.configs[0].pinned, true);
});
