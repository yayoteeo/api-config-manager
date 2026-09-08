// 获取模型回归：只运行生产函数与模拟状态接口，不读真实凭据、不请求真实 API。
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
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function response(body = { data: [{ id: 'model-a' }] }) {
    return { ok: true, status: 200, json: async () => body };
}
function fixture(configs = []) {
    const nodes = new Map();
    const calls = { requests: [], messages: [], forbidden: 0, logs: [] };
    const timers = new Map();
    let sequence = 0;
    let requestHandler = async () => response();
    function node() {
        return {
            value: '', content: '', attrs: {}, props: {}, options: [], visible: false,
            val(value) { if (!arguments.length) return this.value; this.value = value; return this; },
            text(value) { if (!arguments.length) return this.content; this.content = value; return this; },
            attr(name, value) { if (typeof name === 'object') Object.assign(this.attrs, name); else if (arguments.length === 1) return this.attrs[name]; else this.attrs[name] = value; return this; },
            prop(name, value) { if (arguments.length === 1) return this.props[name]; this.props[name] = value; return this; },
            empty() { this.options = []; this.value = ''; return this; },
            append(option) { this.options.push(typeof option === 'string' ? { value: '', content: '选择模型...' } : option); return this; },
            hide() { this.visible = false; return this; },
            show() { this.visible = true; return this; },
        };
    }
    const $ = selector => {
        if (selector.startsWith('<')) return node();
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
    };
    const forbidden = () => { calls.forbidden++; throw new Error('Must not mutate or enumerate host secrets/settings'); };
    const context = vm.createContext({
        $, MODULE_NAME: 'api-config-manager', extension_settings: { 'api-config-manager': { configs } },
        editingIndex: -1, modelFetchTask: null, MODEL_FETCH_TIMEOUT_MS: 20000,
        CHAT_COMPLETION_SOURCES: { CUSTOM: 'custom', MAKERSUITE: 'makersuite' },
        SOURCE_SECRET_KEYS: { custom: 'custom', makersuite: 'makersuite' },
        normalizeSource: value => value === 'makersuite' ? 'makersuite' : 'custom',
        URL, AbortController,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'TEST-ONLY-CSRF' }),
        fetch: (url, options) => {
            assert.equal(url, '/api/backends/chat-completions/status');
            const call = { url, options, body: JSON.parse(options.body) };
            calls.requests.push(call);
            return requestHandler(call);
        },
        setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        toastr: Object.fromEntries(['success', 'error', 'warning', 'info'].map(type => [type, (...args) => calls.messages.push({ type, args })])),
        console: { error: (...args) => calls.logs.push(args) },
        ensureSecretActive: forbidden, findSecret: forbidden, readSecretState: forbidden,
        writeSecret: forbidden, rotateSecret: forbidden, saveSettingsDebounced: forbidden, applyConfig: forbidden,
    });
    vm.runInContext([
        extract('function normalizePreferredModels(', 'function initSettings('),
        extract('function updateModelFetchButton(', '// 模型编辑器只修改草稿'),
        extract('class ConfigConnectionError extends Error', 'function updateConnectionItem('),
    ].join('\n'), context);
    const fields = { source: 'custom', url: 'https://models.invalid/v1', key: 'TEST-ONLY-KEY', 'reverse-proxy': '', 'proxy-password': '', model: 'unsaved-model' };
    function fill(values = {}) { for (const [field, value] of Object.entries(values)) $('#api-config-' + field).val(value); }
    fill(fields);
    function timeout() {
        assert.equal(timers.size, 1);
        const { callback, delay } = [...timers.values()][0];
        assert.equal(delay, 20000);
        callback();
    }
    function assertIdle() {
        assert.equal(context.modelFetchTask, null);
        assert.equal($('#api-config-fetch-models').text(), '获取模型');
        assert.equal($('#api-config-fetch-models').prop('disabled'), false);
        assert.equal($('#api-config-fetch-models').attr('aria-busy'), 'false');
        assert.equal(timers.size, 0);
        assert.equal(calls.forbidden, 0);
    }
    return { context, calls, $, fill, timers, timeout, assertIdle, respond: handler => { requestHandler = handler; } };
}

test('fetch uses draft credentials directly and returns sorted, deduplicated, literal model IDs without changing settings', async () => {
    const saved = { source: 'custom', key: 'TEST-OLD', secretId: 'TEST-OLD-ID', models: ['kept'], model: 'kept' };
    const before = JSON.stringify(saved);
    const f = fixture([saved]);
    f.context.editingIndex = 0;
    f.respond(async () => response({ data: [{ id: ' z ' }, { id: 'a' }, { id: 'a' }, { id: 'quoted"[0]' }, { id: '<img src=x>' }, null, { id: 12 }] }));
    await f.context.fetchAvailableModels();
    const request = f.calls.requests[0];
    assert.deepEqual(request.body, { chat_completion_source: 'custom', custom_url: 'https://models.invalid/v1', custom_include_headers: '{"Authorization":"Bearer TEST-ONLY-KEY"}' });
    assert.equal(request.options.method, 'POST');
    assert.ok(request.options.signal);
    assert.equal(f.$('#api-config-model-select').visible, true);
    assert.deepEqual(f.$('#api-config-model-select').options.map(option => option.value), ['', '<img src=x>', 'a', 'quoted"[0]', 'z']);
    assert.equal(f.$('#api-config-model').val(), 'unsaved-model');
    assert.equal(JSON.stringify(saved), before);
    assert.equal(f.calls.messages[0].type, 'success');
    f.assertIdle();
});

test('a blank key reuses only this config’s matching saved credential; clearing an explicit key sends empty authorization', async () => {
    for (const saved of [
        { secretId: 'TEST-OWN' },
        { source: 'custom', secretIds: { custom: 'TEST-OWN' } },
        { source: 'custom', key: 'TEST-REMOVED', secretId: 'TEST-OLD' },
        { source: 'makersuite', secretIds: { custom: 'TEST-OTHER', makersuite: 'TEST-GOOGLE' } },
    ]) {
        const f = fixture([saved]); f.context.editingIndex = 0; f.fill({ key: '' });
        await f.context.fetchAvailableModels();
        const own = !saved.key && saved.source !== 'makersuite';
        assert.equal(f.calls.requests[0].body.secret_id, own ? 'TEST-OWN' : undefined);
        assert.equal(f.calls.requests[0].body.custom_include_headers, own ? undefined : '{"Authorization":""}');
        f.assertIdle();
    }
});

test('Google direct keys, saved secret IDs and proxy tokens stay isolated without rotating host secrets', async () => {
    const f = fixture([{ source: 'makersuite', secretIds: { makersuite: 'TEST-GOOGLE-ID' } }]);
    f.fill({ source: 'makersuite' });
    await f.context.fetchAvailableModels();
    assert.deepEqual(f.calls.requests.at(-1).body, { chat_completion_source: 'makersuite', reverse_proxy: 'https://generativelanguage.googleapis.com', proxy_password: 'TEST-ONLY-KEY' });
    f.context.editingIndex = 0; f.fill({ key: '' });
    await f.context.fetchAvailableModels();
    assert.deepEqual(f.calls.requests.at(-1).body, { chat_completion_source: 'makersuite', secret_id: 'TEST-GOOGLE-ID' });
    f.fill({ 'reverse-proxy': 'https://proxy.invalid', 'proxy-password': 'TEST-PROXY' });
    await f.context.fetchAvailableModels();
    assert.deepEqual(f.calls.requests.at(-1).body, { chat_completion_source: 'makersuite', reverse_proxy: 'https://proxy.invalid', proxy_password: 'TEST-PROXY' });
    f.assertIdle();
});

test('invalid or missing URLs and missing Google credentials fail locally without entering a busy state', async () => {
    for (const fields of [{ url: '' }, { url: 'file:///tmp/key' }, { url: 'https://name:secret@models.invalid' }, { source: 'makersuite', key: '' }, { source: 'makersuite', 'reverse-proxy': 'not-a-url' }]) {
        const f = fixture(); f.fill(fields);
        await f.context.fetchAvailableModels();
        assert.equal(f.calls.requests.length, 0);
        assert.equal(f.context.modelFetchTask, null);
        assert.equal(f.$('#api-config-model-select').visible, false);
        assert.equal(f.calls.messages[0].type, 'error');
        assert.equal(f.timers.size, 0);
        assert.ok(!JSON.stringify(f.calls.messages).includes('name:secret'));
    }
});

test('HTTP errors, malformed JSON, bypass and network errors clear busy state without exposing upstream messages', async () => {
    const leak = 'TEST-SECRET-MUST-NOT-BE-ECHOED';
    const handlers = [
        async () => ({ ok: false, status: 401, statusText: leak, json: async () => ({ message: leak }) }),
        async () => ({ ok: true, json: async () => { throw new Error(leak); } }),
        async () => response({ error: { message: leak }, data: [{ id: leak }] }),
        async () => response({ bypass: true, data: [] }),
        async () => response(null),
        async () => response({ data: 'invalid' }),
        async () => { throw new Error(leak); },
    ];
    for (const handler of handlers) {
        const f = fixture(); f.respond(handler);
        await f.context.fetchAvailableModels();
        assert.equal(f.calls.messages[0].type, 'error');
        assert.ok(!JSON.stringify(f.calls.messages).includes(leak));
        assert.deepEqual(f.calls.logs, []);
        assert.equal(f.$('#api-config-model-select').visible, false);
        f.assertIdle();
        f.respond(async () => response()); await f.context.fetchAvailableModels();
        assert.equal(f.calls.messages.at(-1).type, 'success');
        f.assertIdle();
    }
});

test('an empty or unusable model list offers manual entry instead of an empty dropdown', async () => {
    for (const data of [[], [null, { id: '' }, { id: 12 }]]) {
        const f = fixture(); f.respond(async () => response({ data }));
        await f.context.fetchAvailableModels();
        assert.equal(f.calls.messages[0].type, 'warning');
        assert.match(f.calls.messages[0].args[0], /手动输入/);
        assert.equal(f.$('#api-config-model-select').visible, false);
        f.assertIdle();
    }
});

test('a fetch that ignores abort still times out after 20 seconds and cannot publish its late result', async () => {
    const f = fixture(); const old = deferred(); f.respond(() => old.promise);
    const pending = f.context.fetchAvailableModels();
    assert.equal(f.$('#api-config-fetch-models').attr('aria-busy'), 'true');
    assert.equal(f.$('#api-config-fetch-models').prop('disabled'), false);
    assert.equal(f.$('#api-config-fetch-models').attr('aria-label'), '取消获取模型列表');
    f.timeout(); await pending;
    assert.equal(f.calls.requests[0].options.signal.aborted, true);
    assert.match(f.calls.messages[0].args[0], /超时（20 秒）/);
    f.assertIdle();
    old.resolve(response({ data: [{ id: 'stale' }] })); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.$('#api-config-model-select').visible, false);
    assert.equal(f.calls.messages.length, 1);
    f.respond(async () => response()); await f.context.fetchAvailableModels(); f.assertIdle();
});

test('the timeout also bounds a response body that never finishes reading', async () => {
    const f = fixture(); const body = deferred(); const reading = deferred();
    f.respond(async () => ({ ok: true, json: () => { reading.resolve(); return body.promise; } }));
    const pending = f.context.fetchAvailableModels(); await reading.promise;
    f.timeout(); await pending; f.assertIdle();
    assert.match(f.calls.messages[0].args[0], /超时/);
    body.resolve({ data: [{ id: 'too-late' }] }); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.$('#api-config-model-select').visible, false);
});

test('clicking the fetching button cancels immediately and allows a retry without a stale reset', async () => {
    const f = fixture(); f.respond(() => new Promise(() => {}));
    const first = f.context.fetchAvailableModels();
    await f.context.fetchAvailableModels(); await first;
    f.assertIdle();
    assert.equal(f.calls.requests.length, 1);
    assert.equal(f.calls.requests[0].options.signal.aborted, true);
    assert.equal(f.calls.messages[0].type, 'info');
    assert.match(f.calls.messages[0].args[0], /已取消/);
    f.respond(async () => response()); await f.context.fetchAvailableModels(); f.assertIdle();
});

test('invalidating an old editor request cannot clear a newer request’s busy state or replace its models', async () => {
    const f = fixture(); const old = deferred(); const next = deferred();
    f.respond(() => old.promise); const first = f.context.fetchAvailableModels();
    f.context.invalidateModelFetch();
    f.fill({ url: 'https://new.invalid/v1', key: 'TEST-NEW' });
    f.respond(() => next.promise); const second = f.context.fetchAvailableModels();
    await first;
    assert.equal(f.$('#api-config-fetch-models').attr('aria-busy'), 'true');
    assert.equal(f.timers.size, 1);
    old.resolve(response({ data: [{ id: 'stale' }] })); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.$('#api-config-model-select').visible, false);
    assert.equal(f.calls.messages.length, 0);
    next.resolve(response({ data: [{ id: 'fresh' }] })); await second;
    assert.deepEqual(f.$('#api-config-model-select').options.map(option => option.value), ['', 'fresh']);
    assert.equal(f.calls.messages.length, 1);
    f.assertIdle();
});