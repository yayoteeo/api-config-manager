// 无浏览器、无依赖、无联网；验证生产连接代码的凭据隔离与异步行为。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createStatusMock = require('./status-mock.cjs');

const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const start = source.indexOf('// 连接只走酒馆原生');
const end = source.indexOf('// 删除配置', start);
assert.ok(start >= 0 && end > start, 'production connection code must be present');
const connectionSource = source.slice(start, end);
const custom = (index = 0, overrides = {}) => ({
    name: `Fixture ${index}`, source: 'custom', customUrl: `https://endpoint-${index}.invalid/v1`,
    key: `TEST-ONLY-KEY-${index}`, model: 'never-send-this-model', ...overrides,
});
const google = overrides => custom(0, { source: 'makersuite', ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(configs) {
    const mock = createStatusMock();
    const settings = { configs, collapsedGroups: {}, theme: 'light' };
    const writes = [];
    const chain = { attr() { return this; }, prop() { return this; }, text() { return this; }, find() { return this; }, each() { return this; } };
    const context = vm.createContext({
        MODULE_NAME: 'api-config-manager', extension_settings: { 'api-config-manager': settings },
        CHAT_COMPLETION_SOURCES: { CUSTOM: 'custom', MAKERSUITE: 'makersuite' },
        SOURCE_SECRET_KEYS: { custom: 'api_key_custom', makersuite: 'api_key_makersuite' },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'FIXTURE-ONLY' }),
        $: () => chain, fetch: mock.fetch, URL, AbortController, performance,
        setTimeout: (callback, delay) => setTimeout(callback, mock.fastTimeout && delay === 12000 ? 15 : delay),
        clearTimeout,
        saveSettingsDebounced: () => writes.push('save'),
        writeSecret: () => writes.push('write'), rotateSecret: () => writes.push('rotate'),
        ensureSecretActive: () => writes.push('ensure'), setSourceSecretIfProvided: () => writes.push('source'),
        oai_settings: new Proxy({}, { set: (_, key) => { writes.push(key); return true; } }),
        console: { error: (...args) => writes.push(args), warn: (...args) => writes.push(args), log: (...args) => writes.push(args) },
    });
    vm.runInContext(connectionSource + `
        globalThis.api = {
            buildConnectionRequest, connectConfig, connectAllConfigs, stopAllConnections, discardConfigConnection,
            state: config => connectionStates.get(config), pending: () => connectionTasks.size,
            running: () => activeConnections, queued: () => connectionQueue.length, batch: () => allConnectionsRun,
        };
    `, context);
    return { api: context.api, mock, settings, writes };
}

test('extension-owned update UI, requests and automatic checks are removed', () => {
    assert.doesNotMatch(source, /api-config-update|checkForUpdates|checkExtensionStatus|checkAndPromptUpdate|updateExtension|compareVersions|\/api\/extensions\//);
    assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, '../style.css'), 'utf8'), /api-config-update|update-available/);
    assert.equal(harness([custom()]).mock.calls.length, 0, 'no connection on load');
});

test('custom status uses its own key, no generation fields and no settings or secret writes', async () => {
    const config = custom(1, { key: 'TEST-ONLY: "quoted" key', secretId: 'outdated-secret' });
    const { api, mock, settings, writes } = harness([config]);
    const before = JSON.stringify(settings);
    assert.equal((await api.connectConfig(config)).phase, 'connected');
    const call = mock.calls[0];
    assert.deepEqual(call.body, { chat_completion_source: 'custom', custom_url: config.customUrl, custom_include_headers: JSON.stringify({ Authorization: `Bearer ${config.key}` }) });
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.cache, 'no-cache');
    assert.equal(call.options.headers['X-CSRF-Token'], 'FIXTURE-ONLY');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.doesNotMatch(JSON.stringify(call.body), /messages|prompt|never-send-this-model|generate|stream/);
    assert.equal(JSON.stringify(settings), before);
    assert.deepEqual(writes, []);
    assert.deepEqual(mock.unexpected, []);
});

test('custom without a key suppresses active credentials; saved secret IDs stay read-only', () => {
    const { api } = harness([]);
    assert.deepEqual(JSON.parse(api.buildConnectionRequest(custom(0, { key: '' })).custom_include_headers), { Authorization: '' });
    for (const overrides of [{ key: '', secretId: 'legacy' }, { key: '', secretIds: { api_key_custom: 'selected' } }]) {
        const request = api.buildConnectionRequest(custom(0, overrides));
        assert.equal(request.secret_id, overrides.secretId || 'selected');
        assert.equal(request.custom_include_headers, undefined);
    }
    assert.equal(api.buildConnectionRequest({ name: 'legacy', url: 'http://localhost:5000/v1', key: '' }).custom_url, 'http://localhost:5000/v1');
});

test('Google direct, proxy and secret-ID configurations do not borrow active secrets', async () => {
    const configs = [google({ key: 'GOOGLE-TEST-ONLY' }), google({ reverseProxy: 'https://proxy.invalid', proxyPassword: 'PROXY-TEST-ONLY' }), google({ reverseProxy: 'http://localhost:9000', proxyPassword: '' }), google({ key: '', secretIds: { api_key_makersuite: 'google-saved-id' } })];
    const { api, mock, writes } = harness(configs);
    await api.connectAllConfigs();
    assert.deepEqual(mock.calls.map(call => call.body), [
        { chat_completion_source: 'makersuite', reverse_proxy: 'https://generativelanguage.googleapis.com', proxy_password: 'GOOGLE-TEST-ONLY' },
        { chat_completion_source: 'makersuite', reverse_proxy: 'https://proxy.invalid', proxy_password: 'PROXY-TEST-ONLY' },
        { chat_completion_source: 'makersuite', reverse_proxy: 'http://localhost:9000', proxy_password: '' },
        { chat_completion_source: 'makersuite', secret_id: 'google-saved-id' },
    ]);
    assert.ok(configs.every(config => api.state(config).phase === 'connected'));
    assert.deepEqual(writes, []);
});

test('invalid URLs and unsupported status sources fail locally without making requests', async () => {
    const configs = [custom(0, { customUrl: '' }), custom(1, { customUrl: '/relative' }), custom(2, { customUrl: 'file:///C:/fixture' }), custom(3, { customUrl: 'https://user:password@fixture.invalid' }), custom(4, { source: 'azure_openai' }), google({ key: '' }), google({ reverseProxy: 'not-a-url' })];
    const { api, mock } = harness(configs);
    await api.connectAllConfigs();
    assert.ok(configs.every(config => api.state(config).phase === 'failed'));
    assert.equal(mock.calls.length, 0);
    assert.equal(api.pending(), 0);
});

test('double-clicks and overlapping bulk runs reuse requests and obey the shared concurrency limit', async () => {
    const configs = Array.from({ length: 8 }, (_, index) => custom(index));
    const { api, mock, settings, writes } = harness(configs);
    const before = JSON.stringify(settings);
    mock.hold = true;
    const single = api.connectConfig(configs[4]);
    assert.equal(api.connectConfig(configs[4]), single);
    const all = api.connectAllConfigs();
    assert.equal(api.connectAllConfigs(), all);
    await tick();
    assert.equal(mock.calls.length, 5);
    assert.equal(api.running(), 5);
    assert.equal(api.queued(), 3);
    mock.hold = false;
    mock.releaseAll();
    await all;
    await single;
    assert.equal(mock.calls.length, 8);
    assert.equal(new Set(mock.calls.map(call => call.body.custom_url)).size, 8);
    assert.equal(mock.maxActive, 5);
    assert.equal(api.pending(), 0);
    assert.equal(api.batch(), null);
    assert.equal(JSON.stringify(settings), before);
    assert.deepEqual(writes, []);
});

test('HTTP, bypass, malformed and upstream errors never produce false positives or expose secrets', async () => {
    const configs = Array.from({ length: 8 }, (_, index) => custom(index));
    const { api, mock, writes } = harness(configs);
    mock.replies.push(
        { status: 401, body: { message: 'DO-NOT-DISPLAY-SECRET' } },
        { body: { error: { message: 'DO-NOT-DISPLAY-SECRET' }, data: [] } },
        { body: { bypass: true, data: [] } },
        { raw: '<html>DO-NOT-DISPLAY-SECRET</html>' },
        { body: null }, { body: {} },
        { networkError: 'DO-NOT-DISPLAY-SECRET' },
        { body: { data: [] } },
    );
    await api.connectAllConfigs();
    assert.ok(configs.slice(0, 7).every(config => api.state(config).phase === 'failed'));
    assert.match(api.state(configs[0]).detail, /401/);
    assert.equal(api.state(configs[7]).phase, 'connected', 'valid empty model lists still confirm endpoint access');
    assert.match(api.state(configs[7]).detail, /0 个模型/);
    assert.doesNotMatch(JSON.stringify(configs.map(config => api.state(config))), /DO-NOT-DISPLAY|TEST-ONLY-KEY/);
    assert.deepEqual(writes, [], 'upstream responses and credentials are not logged');
});

test('timeout aborts the status fetch, frees the slot and permits an explicit retry', async () => {
    const config = custom();
    const { api, mock } = harness([config]);
    mock.hold = true;
    mock.fastTimeout = true;
    assert.equal((await api.connectConfig(config)).label, '连接超时');
    assert.equal(mock.calls[0].aborted, true);
    assert.equal(api.running(), 0);
    mock.hold = false;
    assert.equal((await api.connectConfig(config)).phase, 'connected');
    assert.equal(mock.calls.length, 2, 'no automatic retries');
});

test('stop all cancels active and queued work without starting extra requests and supports restarting', async () => {
    const configs = Array.from({ length: 9 }, (_, index) => custom(index));
    const { api, mock } = harness(configs);
    mock.hold = true;
    const all = api.connectAllConfigs();
    await tick();
    api.stopAllConnections();
    api.stopAllConnections();
    await all;
    assert.equal(mock.calls.length, 5);
    assert.ok(mock.calls.every(call => call.aborted));
    assert.ok(configs.every(config => api.state(config).phase === 'cancelled'));
    assert.equal(api.pending(), 0);
    assert.equal(api.queued(), 0);
    mock.hold = false;
    await api.connectAllConfigs();
    assert.equal(mock.calls.length, 14);
    assert.ok(configs.every(config => api.state(config).phase === 'connected'));
});

test('stopping before microtasks start sends no requests at all', async () => {
    const configs = Array.from({ length: 5 }, (_, index) => custom(index));
    const { api, mock } = harness(configs);
    const all = api.connectAllConfigs();
    api.stopAllConnections();
    await all;
    assert.equal(mock.calls.length, 0);
    assert.ok(configs.every(config => api.state(config).phase === 'cancelled'));
});

test('deleting queued configurations cancels their requests without shifting other results', async () => {
    const configs = Array.from({ length: 6 }, (_, index) => custom(index));
    const removed = configs[4];
    const { api, mock } = harness(configs);
    mock.hold = true;
    const all = api.connectAllConfigs();
    await tick();
    api.discardConfigConnection(removed);
    configs.splice(4, 1);
    mock.hold = false;
    mock.releaseAll();
    await all;
    assert.equal(mock.calls.length, 6);
    const removedCall = mock.calls.find(call => call.body.custom_url === removed.customUrl);
    assert.equal(removedCall?.aborted, true);
    assert.equal(api.state(removed), undefined);
    assert.ok(configs.every(config => api.state(config).phase === 'connected'));
});

test('editing in flight discards old results and uses the replacement credentials', async () => {
    const original = custom();
    const configs = [original];
    const { api, mock } = harness(configs);
    mock.hold = true;
    const oldRequest = api.connectConfig(original);
    await tick();
    api.discardConfigConnection(original);
    const replacement = custom(99, { name: original.name });
    configs[0] = replacement;
    const newRequest = api.connectConfig(replacement);
    await tick();
    mock.hold = false;
    mock.releaseAll();
    assert.equal((await oldRequest).phase, 'cancelled');
    assert.equal((await newRequest).phase, 'connected');
    assert.equal(api.state(original), undefined);
    assert.equal(api.state(replacement).phase, 'connected');
    assert.deepEqual(JSON.parse(mock.calls[1].body.custom_include_headers), { Authorization: `Bearer ${replacement.key}` });
});

test('deleting an earlier item cannot attach an in-flight result to the wrong row', async () => {
    const configs = [custom(0), custom(1), custom(2)];
    const retained = configs[1];
    const { api, mock } = harness(configs);
    mock.hold = true;
    const pending = api.connectConfig(retained);
    await tick();
    api.discardConfigConnection(configs[0]);
    configs.splice(0, 1);
    mock.releaseAll();
    await pending;
    assert.equal(configs[0], retained);
    assert.equal(api.state(configs[0]).phase, 'connected');
    assert.equal(api.state(configs[1]), undefined);
    assert.equal(mock.calls[0].body.custom_url, retained.customUrl);
});
