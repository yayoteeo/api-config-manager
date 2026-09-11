// Mock credentials/requests only; reproduce the host rotateSecret -> MAIN_API_CHANGED side effect.
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

function fixture(sourceName = 'custom') {
    const key = sourceName === 'custom' ? 'api_key_custom' : 'api_key_makersuite';
    const calls = { requests: [], reads: 0, writes: [], events: [], triggers: [], messages: [], selected: [] };
    const state = { [key]: [{ id: 'old-id', value: 'TEST-OLD', active: true }, { id: 'saved-id', value: 'TEST-KEY', active: false }] };
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'TEST-CSRF' };
    const c = vm.createContext({
        secret_state: state,
        CHAT_COMPLETION_SOURCES: { CUSTOM: 'custom', MAKERSUITE: 'makersuite' },
        SOURCE_SECRET_KEYS: { custom: 'api_key_custom', makersuite: 'api_key_makersuite' },
        SECRET_KEYS: { CUSTOM: 'api_key_custom' },
        event_types: { SECRET_ROTATED: 'secret_rotated', MAIN_API_CHANGED: 'main_api_changed' },
        eventSource: { async emit(type, data) {
            calls.events.push({ type, data });
            if (type === 'main_api_changed') c.toastr.info('Reload the chat for regex to take effect', 'Preset contains enabled regex scripts');
        } },
        getRequestHeaders: () => headers,
        async fetch(url, options) { calls.requests.push({ url, options }); return { ok: true }; },
        async readSecretState() { calls.reads++; },
        async findSecret() { return ''; },
        async writeSecret(...args) { calls.writes.push(args); return 'new-id'; },
        async rotateSecret(key, id) {
            const response = await c.fetch('/api/secrets/rotate', { method: 'POST', headers, body: JSON.stringify({ key, id }) });
            if (!response.ok) return;
            await c.readSecretState();
            c.$('#main_api').trigger('change');
            await c.eventSource.emit(c.event_types.SECRET_ROTATED, key);
        },
        normalizeSource: value => value, getSourceLabel: value => value,
        setChatCompletionSource() {}, setReverseProxyFields() {},
        getConfigDefaultModel: config => config.model || '', getModelSelectSelector: value => '#model_' + value,
        setPreferredModel: (...args) => calls.selected.push(args),
        oai_settings: {}, configApplySequence: 0, modelSelectionTimer: null,
        saveSettingsDebounced() {}, setTimeout() { return 1; }, clearTimeout() {},
        $: selector => ({
            length: 1, val() { return this; }, find: () => ({ length: 0 }),
            trigger(event) {
                calls.triggers.push({ selector, event });
                if (selector === '#main_api' && event === 'change') c.eventSource.emit(c.event_types.MAIN_API_CHANGED, { apiId: 'openai' });
                return this;
            },
        }),
        toastr: Object.fromEntries(['success', 'info', 'warning', 'error'].map(type => [type, (...args) => calls.messages.push({ type, args })])),
        console: { error() {} },
    });
    vm.runInContext([
        extract('async function findExistingSecretIdByValue(', 'function normalizeSource('),
        extract('async function setSourceSecretIfProvided(', 'function normalizePreferredModels('),
        extract('async function applyConfig(', '// 设置首选模型'),
    ].join('\n'), c);
    const config = { name: 'Config', source: sourceName, key: 'TEST-KEY', model: 'test-model', secretIds: { [key]: 'saved-id' } };
    const connects = () => calls.triggers.filter(item => item.selector === '#api_button_openai' && item.event === 'click').length;
    return { c, calls, key, state, config, headers, connects };
}

for (const sourceName of ['custom', 'makersuite']) {
    for (const reference of ['saved', 'deduplicated']) {
        test(`${sourceName}: applying a ${reference} secret connects without a spurious regex reload notice`, async () => {
            const f = fixture(sourceName);
            if (reference === 'deduplicated') delete f.config.secretIds;
            await f.c.applyConfig(f.config);
            assert.equal(f.calls.messages.some(message => ['info', 'error'].includes(message.type)), false);
            assert.equal(f.calls.requests.length, 1);
            const request = f.calls.requests[0];
            assert.equal(request.url, '/api/secrets/rotate');
            assert.equal(request.options.method, 'POST');
            assert.equal(request.options.headers, f.headers);
            assert.deepEqual(JSON.parse(request.options.body), { key: f.key, id: 'saved-id' });
            assert.equal(request.options.body.includes('TEST-KEY'), false);
            assert.equal(f.calls.reads, 1);
            assert.deepEqual(f.calls.events, [{ type: 'secret_rotated', data: f.key }]);
            assert.equal(f.calls.writes.length, 0);
            assert.equal(f.config.secretIds[f.key], 'saved-id');
            assert.deepEqual(f.calls.selected, [['test-model', 'Config', sourceName]]);
            assert.equal(f.connects(), 1);
        });
    }
}

test('cached active flags do not skip server activation, and reapplying still avoids the reload notice', async () => {
    const f = fixture();
    f.state[f.key][0].active = false;
    f.state[f.key][1].active = true;
    await f.c.applyConfig(f.config);
    assert.equal(f.calls.requests.length, 1);
    assert.deepEqual(f.calls.events, [{ type: 'secret_rotated', data: f.key }]);
    assert.equal(f.calls.messages.some(message => message.type === 'info'), false);
    assert.equal(f.connects(), 1);
});

test('legacy Custom secretId references use the same quiet activation path', async () => {
    const f = fixture();
    delete f.config.secretIds;
    f.config.secretId = 'saved-id';
    await f.c.applyConfig(f.config);
    assert.deepEqual(f.calls.events, [{ type: 'secret_rotated', data: f.key }]);
    assert.equal(f.connects(), 1);
});

test('masked secrets can still be deduplicated without reselecting the main API', async () => {
    const f = fixture();
    delete f.config.secretIds;
    f.state[f.key].forEach(secret => { secret.value = '********'; });
    f.c.findSecret = async (_key, id) => id === 'saved-id' ? 'TEST-KEY' : 'TEST-OLD';
    await f.c.applyConfig(f.config);
    assert.equal(f.config.secretIds[f.key], 'saved-id');
    assert.equal(f.calls.writes.length, 0);
    assert.deepEqual(f.calls.events, [{ type: 'secret_rotated', data: f.key }]);
    assert.equal(f.connects(), 1);
});

test('empty credentials leave saved secrets alone, and new credentials still use the host writer', async () => {
    const f = fixture();
    f.config.key = '';
    await f.c.applyConfig(f.config);
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.calls.writes.length, 0);
    delete f.config.secretIds;
    f.config.key = 'TEST-NEW';
    await f.c.applyConfig(f.config);
    assert.deepEqual(f.calls.writes, [[f.key, 'TEST-NEW', 'ACM: Config']]);
    assert.equal(f.config.secretIds[f.key], 'new-id');
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.connects(), 2);
});

test('failed rotation keeps the error visible and does not connect with the old secret', async () => {
    const f = fixture();
    f.c.fetch = async () => ({ ok: false, text() { throw new Error('Do not read or display secret response bodies'); } });
    await f.c.applyConfig(f.config);
    assert.equal(f.calls.reads, 0);
    assert.equal(f.calls.events.length, 0);
    assert.equal(f.connects(), 0);
    assert.equal(f.calls.selected.length, 0);
    assert.deepEqual(f.calls.messages.map(message => message.type), ['error']);
    assert.equal(JSON.stringify(f.calls.messages).includes('TEST-KEY'), false);
});

test('network failures keep the error visible and do not reconnect', async () => {
    const f = fixture();
    f.c.fetch = async () => { throw new Error('Failed to fetch'); };
    await f.c.applyConfig(f.config);
    assert.equal(f.connects(), 0);
    assert.equal(f.calls.events.length, 0);
    assert.deepEqual(f.calls.messages.map(message => message.type), ['error']);
});

test('older hosts without secret rotation do not receive unsupported rotation requests', async () => {
    const f = fixture();
    f.c.rotateSecret = null;
    await f.c.applyConfig(f.config);
    assert.equal(f.calls.requests.length, 0);
    assert.equal(f.calls.events.length, 0);
    assert.equal(f.connects(), 1);
});

test('a real main API change still shows the host notice; no toast methods are replaced', async () => {
    const f = fixture();
    const info = f.c.toastr.info;
    await f.c.applyConfig(f.config);
    f.calls.messages.length = 0;
    f.c.$('#main_api').trigger('change');
    assert.equal(f.c.toastr.info, info);
    assert.deepEqual(f.calls.messages.map(message => message.type), ['info']);
});
