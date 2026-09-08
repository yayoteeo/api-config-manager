// Node 22+ / 本地 Chromium；只读宿主静态资源，配置、保存及联网操作均为模拟。
// 可通过 SILLYTAVERN_PUBLIC 和 BROWSER_PATH 指定静态资源目录及浏览器。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const createStatusMock = require('./status-mock.cjs');
const checkModelControls = require('./model-ui.cjs');
const checkCredentialControls = require('./credentials-ui.cjs');

const root = path.resolve(__dirname, '..');
const host = process.env.SILLYTAVERN_PUBLIC || path.resolve(root, '../SillyTavern/public');
const browserPath = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const jquery = fs.readFileSync(path.join(host, 'lib/jquery-3.5.1.min.js'), 'utf8');
const hostCss = fs.readFileSync(path.join(host, 'style.css'), 'utf8');
const popupCss = fs.readFileSync(path.join(host, 'css/popup.css'), 'utf8');
const toggleCss = fs.readFileSync(path.join(host, 'css/toggle-dependent.css'), 'utf8');
const toastCss = fs.readFileSync(path.join(host, 'css/toastr.min.css'), 'utf8');
const icons = fs.readFileSync(path.join(host, 'css/fontawesome.min.css'), 'utf8');
const popupSource = fs.readFileSync(path.join(host, 'scripts/popup.js'), 'utf8');
const toastHelper = popupSource.match(/^export function fixToastrForDialogs\(\) \{[\s\S]*?^\}/m)?.[0].replace(/^export /, '');
if (!toastHelper) throw new Error('Host toast helper not found');
const font = fs.readFileSync(path.join(host, 'webfonts/fa-solid-900.woff2')).toString('base64');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'api-config-modal-'));
const cases = [];
let browser;
let socket;
let sessionId;
let sequence = 0;
const pending = new Map();
const errors = [];

function send(method, params = {}, session = sessionId) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
}

async function evaluate(expression, returnByValue = false) {
    // 操作型表达式可能返回 window / jQuery，不能让 CDP 深度序列化整棵页面对象。
    const result = await send('Runtime.evaluate', { expression, returnByValue, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
}

async function check(name, expression) {
    const result = await evaluate(`(async () => { ${expression} })()`, true);
    if (result !== true) {
        const state = await evaluate(`({ hidden: $('#api-config-modal').prop('hidden'), locked: document.documentElement.classList.contains('api-config-modal-open'), scrollY, originalScroll: window.originalScroll, active: document.activeElement.id, metrics: ['#api-config-manager', '#api-config-list-scroll', '#api-config-dialog-title', '.api-config-header-actions', '.api-config-item', '.api-config-item button'].map(selector => { const el = document.querySelector(selector); return el ? { selector, rect: el.getBoundingClientRect().toJSON(), client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight] } : null; }) })`, true);
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(artifacts, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
        console.error(`Failure screenshot: ${artifacts}`);
        throw new Error(`${name}: ${JSON.stringify({ result, state })}`);
    }
    cases.push(name);
}

async function settleLayout() {
    // 宿主的尺寸过渡是 250ms，固定等待 220ms 会偶发量到 29.98px。
    // 等本扩展内有限、正在运行的动画真正结束；不改 CSS，也不跳过尺寸断言。
    await evaluate(`(async () => {
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await frame();
        const animations = document.getElementById('api-config-modal')?.getAnimations({ subtree: true }) || [];
        await Promise.all(animations.filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
        await frame();
    })()`);
}

async function setViewport(width, height, mobile = false) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    await settleLayout();
}

async function checkHeaderControlSizing(label) {
    await settleLayout();
    await check(label + ': header buttons are equal squares, aligned and evenly spaced', `
        const buttons = [...document.querySelectorAll('.api-config-header-actions > button')];
        const rects = buttons.map(button => button.getBoundingClientRect());
        const size = matchMedia('(pointer: coarse)').matches ? 40 : 34;
        const near = (actual, expected) => Math.abs(actual - expected) < 0.1;
        return rects.length === 3 && rects.every(rect =>
            near(rect.width, size) && near(rect.height, size) && near(rect.top, rects[0].top)
        ) && near(rects[1].left - rects[0].right, 6) && near(rects[2].left - rects[1].right, 6);
    `);
}

async function checkConnectionControls() {
    await check('all-connect is disabled for an empty library', `return $('#api-config-connect-all').prop('disabled') && !fixture.statusMock.calls.length;`);
    await evaluate(`
        fixture.settings.configs = Array.from({ length: 6 }, (_, index) => ({ name: 'Connection ' + index, group: '连接配置', source: 'custom', customUrl: 'https://probe-' + index + '.invalid/v1', key: 'NO-REAL-KEY-' + index, model: 'fixture-model' }));
        fixture.settings.collapsedGroups = { '连接配置': true }; fixture.initSettings();
        $('#api-config-search').val('Connection 3').trigger('input');
        window.connectionBefore = { settings: JSON.stringify(fixture.settings), native: JSON.stringify(fixture.nativeSettings), saves: fixture.saveCount(), applied: fixture.applied.length };
    `);
    await check('filtered connect uses the correct saved endpoint and shows a busy state', `
        fixture.statusMock.hold = true; window.connectionCard = $('.api-config-item')[0];
        $('.api-config-connect').trigger('click'); await Promise.resolve();
        const call = fixture.statusMock.calls[0];
        return fixture.statusMock.calls.length === 1 && call.body.custom_url === 'https://probe-3.invalid/v1' && JSON.parse(call.body.custom_include_headers).Authorization === 'Bearer NO-REAL-KEY-3' && $('.api-config-connect').data('index') === 3 && $('.api-config-connect').prop('disabled') && $('.api-config-connection-state').text() === '连接中';
    `);
    await check('single connection updates only the status; settings, active API and card DOM are untouched', `
        const pending = fixture.waitForConnections(); fixture.statusMock.releaseAll(); await pending;
        return $('.api-config-item')[0] === connectionCard && $('.api-config-connection-state').text() === '已连通' && $('.api-config-connection-state').attr('title').includes('1 个模型') && !$('.api-config-connect').prop('disabled') && JSON.stringify(fixture.settings) === connectionBefore.settings && JSON.stringify(fixture.nativeSettings) === connectionBefore.native && fixture.saveCount() === connectionBefore.saves && fixture.applied.length === connectionBefore.applied && fixture.secretMutations() === 0;
    `);
    await check('reopening keeps connection results without connecting automatically', `
        const calls = fixture.statusMock.calls.length; $('#api-config-close').trigger('click'); $('.api-config-open').trigger('click');
        return $('.api-config-connection-state').text() === '已连通' && fixture.statusMock.calls.length === calls;
    `);
    await check('failed status responses are not accepted or echoed into the page', `
        fixture.statusMock.hold = false; fixture.statusMock.replies.push({ body: { error: true, message: 'NO-REAL-KEY-3', data: [] } });
        await fixture.connectConfig(fixture.settings.configs[3]);
        return $('.api-config-connection-state').text() === '未连通' && !$('#api-config-list').html().includes('NO-REAL-KEY') && !$('.api-config-connect').prop('disabled');
    `);
    await check('all-connect includes hidden configs, limits concurrency and preserves an editor draft', `
        fixture.statusMock.calls.length = 0; fixture.statusMock.maxActive = 0; fixture.statusMock.hold = true;
        $('#api-config-editor-tab').trigger('click'); $('#api-config-name').val('连接时保留的草稿');
        $('#api-config-connect-all').trigger('click'); await Promise.resolve();
        return fixture.statusMock.calls.length === 3 && $('.api-config-connect-all-label').text() === '停止连接' && $('#api-config-connection-summary').text().includes('0/6') && !$('#api-config-list-panel').prop('hidden') && $('#api-config-name').val() === '连接时保留的草稿' && $('#api-config-search').val() === 'Connection 3';
    `);
    await checkHeaderControlSizing('connecting (stop icon)');
    await check('all-connect finishes every saved config without switching API, saving credentials or rebuilding the visible card', `
        const card = $('.api-config-item')[0]; const pending = fixture.waitForConnections();
        fixture.statusMock.hold = false; fixture.statusMock.releaseAll(); await pending;
        const urls = fixture.statusMock.calls.map(call => call.body.custom_url);
        return urls.length === 6 && new Set(urls).size === 6 && fixture.statusMock.maxActive === 3 && fixture.settings.configs.every(config => fixture.connectionState(config)?.phase === 'connected') && $('#api-config-connection-summary').text().includes('6/6') && $('.api-config-connect-all-label').text() === '全部连接' && $('.api-config-item')[0] === card && JSON.stringify(fixture.settings) === connectionBefore.settings && JSON.stringify(fixture.nativeSettings) === connectionBefore.native && fixture.saveCount() === connectionBefore.saves && fixture.applied.length === connectionBefore.applied && fixture.secretMutations() === 0 && fixture.statusMock.unexpected.length === 0 && fixture.statusMock.calls.every(call => !('messages' in call.body) && !('model' in call.body));
    `);
    await check('search and collapsed groups keep the correct per-config results', `
        $('#api-config-search').val('').trigger('input');
        return $('.api-config-connection-state').filter((i, el) => el.textContent === '已连通').length === 6 && $('.api-config-group-header').attr('aria-expanded') === 'false' && fixture.settings.collapsedGroups['连接配置'] === true;
    `);
    await check('the top stop control cancels both running and queued connections', `
        fixture.statusMock.calls.length = 0; fixture.statusMock.hold = true;
        $('#api-config-connect-all').trigger('click'); await Promise.resolve();
        const pending = fixture.waitForConnections(); $('#api-config-connect-all').trigger('click'); await pending;
        return fixture.statusMock.calls.length === 3 && fixture.statusMock.calls.every(call => call.aborted) && fixture.settings.configs.every(config => fixture.connectionState(config)?.phase === 'cancelled') && $('#api-config-connection-summary').text().includes('已停止') && $('.api-config-connect-all-label').text() === '全部连接' && !$('#api-config-connect-all').prop('disabled');
    `);
    await check('editing a connecting config aborts its old request and resets only that result', `
        $('#api-config-editor-tab').trigger('click'); $('#api-config-cancel').trigger('click');
        $('#api-config-search').val('Connection 3').trigger('input');
        const old = fixture.settings.configs[3]; $('.api-config-connect').trigger('click'); await Promise.resolve();
        const request = fixture.statusMock.calls.at(-1); const pending = fixture.waitForConnections();
        $('.api-config-edit').trigger('click'); $('#api-config-url').val('https://changed.invalid/v1'); $('#api-config-save').trigger('click'); await pending;
        const item = $('.api-config-connect[data-index="3"]').closest('.api-config-item'); fixture.statusMock.hold = false;
        return request.aborted && fixture.settings.configs[3] !== old && fixture.settings.configs[3].customUrl === 'https://changed.invalid/v1' && item.find('.api-config-connection-state').text() === '未连接' && fixture.connectionState(old) === undefined && fixture.secretMutations() === 0;
    `);
}

async function checkPinControls() {
    await evaluate(`
        fixture.settings.configs = [
            { name: 'Pin Alpha', group: 'A' }, { name: 'Pin Beta', group: 'Z' },
            { name: 'Pin Gamma', group: 'A' }, { name: 'Pin Named Group', group: '置顶' },
            { name: 'Pin Ungrouped' }, { name: 'Pin <img src=x onerror=alert(1)>', group: '__proto__' },
        ].map((config, index) => ({ ...config, source: 'custom', customUrl: 'https://pin-' + index + '.invalid/v1', key: 'TEST-ONLY-PIN-' + index }));
        fixture.settings.collapsedGroups = { A: true, '置顶': true }; fixture.initSettings();
        fixture.statusMock.calls.length = 0; fixture.statusMock.hold = false;
        $('#api-config-editor-tab').trigger('click'); $('#api-config-name').val('置顶时保留的草稿'); $('#api-config-list-tab').trigger('click');
        $('#api-config-search').val('').trigger('input');
        window.pinReferences = fixture.settings.configs.slice();
        window.pinBefore = { native: JSON.stringify(fixture.nativeSettings), applied: fixture.applied.length, saves: fixture.saveCount(), scrollY };
    `);
    await check('legacy configs are unpinned and get one accessible pin control each', `
        return $('.api-config-pin').length === 6 && $('.api-config-pin[aria-pressed="false"]').length === 6 && !$('.api-config-pinned-header').length && $('.api-config-pin').toArray().every(button => button.type === 'button' && button.title === '置顶' && button.getAttribute('aria-label').startsWith('置顶：'));
    `);
    await check('filtered pin saves once and moves the correct config without switching APIs or clearing drafts', `
        $('#api-config-search').val('Pin Beta').trigger('input'); $('.api-config-pin').trigger('click');
        return fixture.settings.configs[1].pinned === true && fixture.settings.configs[1].group === 'Z' && fixture.settings.configs.every((config, index) => config === pinReferences[index]) && fixture.saveCount() === pinBefore.saves + 1 && $('#api-config-list').children().first().hasClass('api-config-pinned-header') && $('.api-config-pin').attr('aria-pressed') === 'true' && $('.api-config-pin').attr('title') === '取消置顶' && $(document.activeElement).hasClass('api-config-pin') && $('#api-config-search').val() === 'Pin Beta' && $('#api-config-name').val() === '置顶时保留的草稿' && JSON.stringify(fixture.nativeSettings) === pinBefore.native && fixture.applied.length === pinBefore.applied && !fixture.secretMutations() && !fixture.statusMock.calls.length && scrollY === pinBefore.scrollY;
    `);
    await check('multiple pins cross group boundaries without duplicate cards or index reordering', `
        for (const name of ['Pin Gamma', 'Pin Alpha']) { $('#api-config-search').val(name).trigger('input'); $('.api-config-pin').trigger('click'); }
        $('#api-config-search').val('').trigger('input');
        return JSON.stringify($('.api-config-pinned-content .api-config-pin').toArray().map(button => $(button).data('index'))) === '[0,1,2]' && $('.api-config-item').length === 6 && $('.api-config-pinned-header .api-config-group-count').text() === '(3)' && fixture.settings.configs.every((config, index) => config === pinReferences[index]) && $('.api-config-pinned-content .api-config-source-tag').eq(1).text().startsWith('Z · ') && $('#api-config-result-count').text() === '共 6 个配置';
    `);
    await check('a real group called 置顶 cannot collapse the independent pinned section', `
        const group = $('.api-config-group-header').filter(function () { return $(this).data('group') === '置顶'; });
        return group.length === 1 && group.attr('aria-expanded') === 'false' && !group.next().is(':visible') && $('.api-config-pinned-content').is(':visible') && $('.api-config-pinned-content .api-config-item:visible').length === 3;
    `);
    await check('pinning does not bypass search or expose keys; empty matches hide the pinned heading', `
        $('#api-config-search').val('Pin Beta').trigger('input');
        const match = $('.api-config-item').length === 1 && $('.api-config-pin').data('index') === 1 && $('#api-config-result-count').text().includes('1 / 6');
        $('#api-config-search').val('TEST-ONLY-PIN-1').trigger('input');
        const empty = !$('.api-config-item').length && !$('.api-config-pinned-header').length;
        $('#api-config-search').val('').trigger('input');
        return match && empty && $('.api-config-pinned-content .api-config-item').length === 3 && fixture.settings.collapsedGroups.A === true;
    `);
    await check('pin flags survive reopening and serialized settings reload without extra saves', `
        const saved = JSON.stringify(fixture.settings); const saves = fixture.saveCount();
        $('#api-config-close').trigger('click'); $('.api-config-open').trigger('click');
        const reopened = $('.api-config-pinned-content .api-config-item').length === 3;
        fixture.settings.configs = JSON.parse(saved).configs; fixture.initSettings(); fixture.renderConfigList();
        return reopened && JSON.stringify(fixture.settings) === saved && fixture.saveCount() === saves && $('.api-config-pinned-content .api-config-item').length === 3 && !fixture.statusMock.calls.length;
    `);
    await check('editing a pinned config keeps its pin and changes the original group safely', `
        $('.api-config-edit[data-index="1"]').trigger('click');
        const correct = fixture.editingIndex() === 1 && $('#api-config-name').val() === 'Pin Beta';
        $('#api-config-name').val('Pin Beta edited'); $('#api-config-group').val('Renamed'); $('#api-config-save').trigger('click');
        return correct && fixture.settings.configs[1].pinned === true && fixture.settings.configs[1].group === 'Renamed' && $('.api-config-pin[data-index="1"]').attr('aria-pressed') === 'true' && $('.api-config-pinned-content .api-config-item').length === 3;
    `);
    await check('same-name overwrite retains the pin instead of silently dropping it', `
        $('#api-config-editor-tab').trigger('click'); $('#api-config-name').val('Pin Beta edited'); $('#api-config-group').val('Renamed');
        $('#api-config-url').val('https://pin-replacement.invalid/v1'); $('#api-config-key').val('TEST-ONLY-REPLACEMENT'); $('#api-config-save').trigger('click');
        return fixture.settings.configs.length === 6 && fixture.settings.configs[1].pinned === true && fixture.settings.configs[1].customUrl === 'https://pin-replacement.invalid/v1' && $('.api-config-pinned-content .api-config-item').length === 3;
    `);
    await check('unpin restores the collapsed original group and focuses its header without scrolling the host', `
        $('.api-config-pin[data-index="2"]').trigger('click');
        const card = $('.api-config-pin[data-index="2"]').closest('.api-config-item');
        return fixture.settings.configs[2].pinned === false && fixture.settings.configs[2].group === 'A' && !card.is(':visible') && !card.parent().hasClass('api-config-pinned-content') && fixture.settings.collapsedGroups.A === true && $(document.activeElement).hasClass('api-config-group-header') && $(document.activeElement).data('group') === 'A' && $('.api-config-pinned-content .api-config-item').length === 2 && scrollY === pinBefore.scrollY;
    `);
    await check('removing the last pin removes the pinned section with no duplicates or phantom counts', `
        for (const index of [0, 1]) $('.api-config-pin[data-index="' + index + '"]').trigger('click');
        return !$('.api-config-pinned-header').length && !$('.api-config-pinned-content').length && $('.api-config-item').length === 6 && $('.api-config-pin[aria-pressed="false"]').length === 6 && $('#api-config-result-count').text() === '共 6 个配置';
    `);
    await check('pinning another config preserves the edit index and escapes names and prototype group names', `
        $('.api-config-edit[data-index="4"]').trigger('click'); $('#api-config-name').val('正在编辑的草稿'); $('#api-config-list-tab').trigger('click');
        $('.api-config-pin[data-index="5"]').trigger('click');
        const kept = fixture.editingIndex() === 4 && $('#api-config-name').val() === '正在编辑的草稿' && fixture.settings.configs[4].name === 'Pin Ungrouped';
        const safe = !$('#api-config-list img').length && $('.api-config-pin[data-index="5"]').attr('aria-label').includes('<img src=x') && $('.api-config-pinned-content .api-config-source-tag').text().startsWith('__proto__ · ');
        $('#api-config-editor-tab').trigger('click'); $('#api-config-cancel').trigger('click');
        return kept && safe && fixture.applied.length === pinBefore.applied;
    `);
    await check('pin and unpin keep an in-flight connection and its result attached to the same config', `
        const config = fixture.settings.configs[5]; fixture.statusMock.hold = true;
        $('.api-config-connect[data-index="5"]').trigger('click'); await Promise.resolve();
        const call = fixture.statusMock.calls[0]; $('.api-config-pin[data-index="5"]').trigger('click');
        const running = !call.options.signal.aborted && $('.api-config-connect[data-index="5"]').prop('disabled') && fixture.settings.configs[5] === config;
        const pending = fixture.waitForConnections(); fixture.statusMock.releaseAll(); await pending; fixture.statusMock.hold = false;
        $('.api-config-pin[data-index="5"]').trigger('click');
        return running && fixture.statusMock.calls.length === 1 && fixture.connectionState(config).phase === 'connected' && $('.api-config-pinned-content .api-config-connection-state').text() === '已连通' && !$('.api-config-connect[data-index="5"]').prop('disabled') && JSON.stringify(fixture.nativeSettings) === pinBefore.native && !fixture.secretMutations();
    `);
    await check('apply on a pinned card still selects its original config', `
        const config = fixture.settings.configs[5]; $('.api-config-apply[data-index="5"]').trigger('click'); await Promise.resolve();
        return fixture.applied.at(-1) === config && fixture.applied.length === pinBefore.applied + 1;
    `);
    await check('deleting a pinned card honors confirmation and removes its section and connection state', `
        const config = fixture.settings.configs[5]; window.confirm = () => false; $('.api-config-delete[data-index="5"]').trigger('click');
        const cancelled = fixture.settings.configs[5] === config; window.confirm = () => true; $('.api-config-delete[data-index="5"]').trigger('click');
        return cancelled && fixture.settings.configs.length === 5 && !fixture.connectionState(config) && !$('.api-config-pinned-header').length && $('.api-config-item').length === 5;
    `);
    await check('new configs are unpinned by default and an all-pinned library has no empty normal groups', `
        $('#api-config-editor-tab').trigger('click'); $('#api-config-name').val('Pin New'); $('#api-config-url').val('https://pin-new.invalid/v1'); $('#api-config-save').trigger('click');
        const unpinned = fixture.settings.configs.length === 6 && fixture.settings.configs[5].pinned !== true;
        for (const config of fixture.settings.configs) { $('#api-config-search').val(config.name).trigger('input'); $('.api-config-pin').trigger('click'); }
        $('#api-config-search').val('').trigger('input');
        return unpinned && fixture.settings.configs.every(config => config.pinned === true) && $('.api-config-pinned-content .api-config-item').length === 6 && !$('.api-config-group-header').length && $('.api-config-pinned-header').length === 1;
    `);
}

const fixtures = Array.from({ length: 48 }, (_, index) => ({
    name: index === 0 ? 'link' : index === 7 ? '工作用 Alpha' : `备用配置 ${String(index).padStart(2, '0')}`,
    group: index < 6 ? '常用' : index < 24 ? '工作用' : '备用',
    source: index % 3 ? 'custom' : 'makersuite',
    url: 'https://example.invalid/v1',
    key: `TEST-ONLY-DO-NOT-USE-${index}`,
    model: index === 0 ? 'gemini-3-pro-preview' : `example-model-${index}`,
    secretId: `test-secret-${index}`,
}));
fixtures[7].source = 'makersuite';
fixtures.push({ name: '<b>很长的配置名称 & "引号"</b>'.repeat(8), group: '<img src=x onerror=alert(1)>', model: 'model-with-a-very-long-name-'.repeat(10), key: 'TEST-ONLY', source: 'custom' });
fixtures.push({ name: '特殊分组', group: '__proto__', source: 'custom', url: 'https://example.invalid' });

const themes = {
    light: {
        SmartThemeBodyColor: '#292c35', SmartThemeEmColor: '#576c94', SmartThemeQuoteColor: '#737b8b',
        SmartThemeBlurTintColor: '#fafbfe', SmartThemeBorderColor: '#dce0e9',
        SmartThemeUserMesBlurTintColor: '#f1f3f8', SmartThemeBotMesBlurTintColor: '#e9edf5', SmartThemeShadowColor: 'transparent',
    },
    dark: {
        SmartThemeBodyColor: '#e4e6ed', SmartThemeEmColor: '#a9bce6', SmartThemeQuoteColor: '#939caf',
        SmartThemeBlurTintColor: '#232630', SmartThemeBorderColor: '#3e4352',
        SmartThemeUserMesBlurTintColor: '#2b2f3b', SmartThemeBotMesBlurTintColor: '#33394a', SmartThemeShadowColor: 'transparent',
    },
};

async function main() {
    browser = spawn(browserPath, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0',
        `--user-data-dir=${path.join(artifacts, 'profile')}`, 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 12000);
        let output = '';
        browser.on('error', error => { clearTimeout(timer); reject(error); });
        browser.on('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited: ${code}`)); });
        browser.stderr.on('data', data => {
            output += data;
            const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
    });
    socket = new WebSocket(endpoint);
    await once(socket, 'open');
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    });
    const target = await send('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    sessionId = attached.sessionId;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*'] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1298, height: 860, deviceScaleFactor: 1, mobile: false });
    const frame = (await send('Page.getFrameTree')).frameTree.frame.id;
    await send('Page.setDocumentContent', { frameId: frame, html: `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${hostCss}\n${popupCss}\n${toggleCss}\n${toastCss}\n${icons}
        .fa-solid { font-family: 'Font Awesome 6 Free'; font-weight: 900; }
        * { box-sizing: border-box; }
        html { overflow-y: auto; }
        body { margin: 0; height: auto; min-height: 100vh; overflow-y: auto; font: 14px/1.5 'Segoe UI', 'Microsoft YaHei', sans-serif; background: #838a99; }
        #fixture-background { width: min(920px, 100%); margin: auto; padding: 24px; }
        #openai_api { display: block; padding: 16px; background: var(--SmartThemeBlurTintColor); border-radius: 12px; }
        #custom_form { padding: 30px 0; }
        </style><style>${css}</style></head><body><main id="fixture-background"><h2>API 连接设置 · 本地模拟预览</h2><div id="openai_api"><div id="custom_form">API 连接表单（模拟，不连接服务）</div></div><div style="height: 1600px"></div></main></body></html>` });
    await evaluate(jquery);
    // 字体从内存加载，不为图标放开任何页面网络请求。
    await evaluate(`(async () => { const face = new FontFace('Font Awesome 6 Free', Uint8Array.from(atob('${font}'), c => c.charCodeAt(0)), { weight: '900' }); await face.load(); document.fonts.add(face); })()`);
    const uiSource = source.slice(source.indexOf('// 扩展名称'), source.indexOf('// SillyTavern扩展初始化'));
    await evaluate(`(async () => {
        const extension_settings = { 'api-config-manager': { configs: ${JSON.stringify(fixtures)}, collapsedGroups: {} } };
        const SECRET_KEYS = { CUSTOM: 'custom', MAKERSUITE: 'makersuite' };
        let saveCount = 0;
        let secretMutations = 0;
        const statusMock = (${createStatusMock.toString()})();
        const fetch = statusMock.fetch;
        const getRequestHeaders = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'FIXTURE-ONLY' });
        const nativeSettings = { chat_completion_source: 'custom', custom_url: 'https://active.invalid/v1', custom_model: 'active-model', reverse_proxy: '', proxy_password: 'ACTIVE-DO-NOT-USE' };
        const oai_settings = new Proxy(nativeSettings, { set: (target, key, value) => { secretMutations++; target[key] = value; return true; } });
        const secret_state = { custom: [], makersuite: [] };
        const readSecretState = async () => { secretMutations++; };
        const writeSecret = async () => { secretMutations++; return 'fixture-write'; };
        const rotateSecret = async () => { secretMutations++; };
        const findSecret = async () => { secretMutations++; return 'fixture-secret'; };
        const messages = [];
        const saveSettingsDebounced = () => saveCount++;
        const toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(type => [type, (...args) => messages.push({ type, args })]));
        toastr.options = { positionClass: 'toast-top-center' };
        const toastPositionClasses = ['toast-top-center'];
        ${toastHelper}
        ${uiSource}
        const applied = [];
        const appliedModels = [];
        const fetchModelsForTest = fetchAvailableModels;
        let fetched = 0;
        applyConfig = async (config, model = getConfigDefaultModel(config)) => { applied.push(config); appliedModels.push({ config, model }); };
        fetchAvailableModels = async () => { fetched++; $('#api-config-model-select').html('<option value="fixture-model">fixture-model</option>').show(); };
        window.confirm = () => true;
        window.fixture = {
            settings: extension_settings[MODULE_NAME], applied, appliedModels, messages, fetchModelsForTest, setPreferredModel,
            saveCount: () => saveCount, fetched: () => fetched, editingIndex: () => editingIndex,
            createUI, bindEvents, renderConfigList, showManagerView, initSettings, setManagerTheme,
            statusMock, nativeSettings, connectConfig, secretMutations: () => secretMutations,
            connectionState: config => connectionStates.get(config),
            waitForConnections: () => allConnectionsRun?.promise || Promise.all([...connectionTasks.values()].map(task => task.promise)),
        };
        initSettings();
        await createUI();
        bindEvents();
        updateFormBySource($('#api-config-source').val());
        renderConfigList();
    })()`);

    await check('closed by default; compact launcher is first', `return $('#api-config-modal').prop('hidden') && $('#openai_api').children().first().hasClass('api-config-launcher') && $('.api-config-launcher').outerHeight() < 80;`);
    await check('idempotent UI and delegated handlers', `await fixture.createUI(); fixture.bindEvents(); return $('#api-config-modal').length === 1 && $('.api-config-open').length === 1;`);
    await check('update is replaced by all-connect at the top and one connect control per card', `return !$('#api-config-update').length && $('.api-config-dialog-header #api-config-connect-all').length === 1 && $('.api-config-connect').length === 50 && !fixture.statusMock.calls.length;`);
    await check('launcher has only an accessible icon and the whole bar opens by pointer or keyboard', `
        const button = $('.api-config-open');
        const iconOnly = !button.text().trim() && !!button.attr('aria-label') && button.find('i').length === 1;
        $('.api-config-launcher-info').trigger('click'); const clicked = !$('#api-config-modal').prop('hidden');
        $('#api-config-close').trigger('click');
        $('.api-config-launcher').trigger($.Event('keydown', { key: 'Enter' })); const keyboard = !$('#api-config-modal').prop('hidden');
        $('#api-config-close').trigger('click');
        return iconOnly && clicked && keyboard;
    `);
    await check('open, focus, scroll lock', `window.scrollTo(0, 200); window.originalScroll = window.scrollY; $('.api-config-open').trigger('click'); return !$('#api-config-modal').prop('hidden') && $('#api-config-editor-panel').prop('hidden') && document.activeElement.id === 'api-config-search' && getComputedStyle(document.body).overflowY === 'hidden' && window.scrollY === window.originalScroll;`);
    await check('host toasts follow native modal and return on close', `$('#toast-container').append('<div class="toast">模拟通知</div>'); const opened = $('#toast-container').parent().attr('id') === 'api-config-modal'; $('#api-config-close').trigger('click'); const closed = $('#toast-container').parent()[0] === document.body; $('.api-config-open').trigger('click'); const reopened = $('#toast-container').parent().attr('id') === 'api-config-modal'; $('#toast-container').empty(); return opened && closed && reopened;`);
    await check('text is escaped; special groups render', `return !$('#api-config-list b, #api-config-list img').length && $('.api-config-name-text').filter((i, el) => el.textContent.includes('<b>')).length === 1 && $('.api-config-group-name').filter((i, el) => el.textContent === '__proto__').length === 1;`);
    await check('search retains original action index', `$('#api-config-search').val('alpha GOOGLE').trigger('input'); $('.api-config-apply').trigger('click'); return $('.api-config-item').length === 1 && $('.api-config-apply').data('index') === 7 && fixture.applied[0] === fixture.settings.configs[7];`);
    await check('search never includes keys', `$('#api-config-search').val('TEST-ONLY-DO-NOT-USE').trigger('input'); return $('.api-config-item').length === 0 && $('.api-config-empty').text().includes('没有匹配');`);
    await check('edit from filtered list switches panel, not page', `$('#api-config-search').val('Alpha').trigger('input'); $('.api-config-edit').trigger('click'); return fixture.editingIndex() === 7 && $('#api-config-name').val() === '工作用 Alpha' && $('#api-config-list-panel').prop('hidden') && !$('#api-config-editor-panel').prop('hidden') && $('#api-config-url').closest('.api-config-field').prop('hidden') && !$('#api-config-reverse-proxy').closest('.api-config-field').prop('hidden') && window.scrollY === window.originalScroll;`);
    await check('draft survives close and reopen; focus restored', `$('#api-config-name').val('未保存的草稿'); $('#api-config-close').trigger('click'); const closed = $('#api-config-modal').prop('hidden') && document.activeElement.classList.contains('api-config-open') && !document.body.classList.contains('api-config-modal-open'); $('.api-config-open').trigger('click'); return closed && $('#api-config-name').val() === '未保存的草稿' && document.activeElement.id === 'api-config-name';`);
    await check('cancel does not modify saved config', `$('#api-config-cancel').trigger('click'); return fixture.editingIndex() === -1 && fixture.settings.configs[7].name === '工作用 Alpha' && $('#api-config-name').val() === '' && !$('#api-config-list-panel').prop('hidden');`);
    await check('collapse state preserved across search', `$('#api-config-search-clear').trigger('click'); const header = $('.api-config-group-header').filter((i, el) => $(el).data('group') === '工作用'); header.trigger('click'); const before = fixture.saveCount(); $('#api-config-search').val('Alpha').trigger('input'); const expanded = $('.api-config-group-header').attr('aria-expanded') === 'true'; $('.api-config-group-header').trigger('click'); $('#api-config-search-clear').trigger('click'); return expanded && fixture.saveCount() === before && fixture.settings.collapsedGroups['工作用'] === true && $('.api-config-group-header').filter((i, el) => $(el).data('group') === '工作用').attr('aria-expanded') === 'false';`);
    await check('prototype-like group names persist safely', `$('.api-config-group-header').filter((i, el) => $(el).data('group') === '__proto__').trigger('click'); return Object.hasOwn(fixture.settings.collapsedGroups, '__proto__') && JSON.parse(JSON.stringify(fixture.settings.collapsedGroups)).__proto__ === true;`);
    await check('empty name validation stays in editor', `$('#api-config-editor-tab').trigger('click'); const before = fixture.saveCount(); $('#api-config-save').trigger('click'); return fixture.saveCount() === before && !$('#api-config-editor-panel').prop('hidden') && fixture.messages.at(-1).type === 'error';`);
    await check('save creates one config and returns to list', `$('#api-config-name').val('新增测试'); $('#api-config-source').val('custom').trigger('change'); $('#api-config-url').val('https://example.invalid/v1'); const before = fixture.saveCount(); $('#api-config-save').trigger('click'); return fixture.settings.configs.length === 51 && fixture.saveCount() === before + 1 && !$('#api-config-list-panel').prop('hidden') && $('#api-config-search').val() === '' && $('#api-config-launcher-count').text() === '51 个配置';`);
    await check('edit and save preserve secret metadata', `$('#api-config-search').val('备用配置 01').trigger('input'); $('.api-config-edit').trigger('click'); const secret = fixture.settings.configs[1].secretId; $('#api-config-model').val('changed-model'); $('#api-config-add-model').trigger('click'); $('.api-config-editor-model-default').last().trigger('click'); $('#api-config-save').trigger('click'); return fixture.settings.configs[1].model === 'changed-model' && fixture.settings.configs[1].secretId === secret && fixture.settings.configs.length === 51;`);
    await check('model fetch and select controls remain wired', `$('#api-config-editor-tab').trigger('click'); $('#api-config-fetch-models').trigger('click'); $('#api-config-model-select').trigger('change'); return fixture.fetched() === 1 && $('#api-config-model').val() === '' && $('#api-config-preferred-models .api-config-saved-model-name').text().includes('fixture-model');`);
    await check('IME Enter does not save', `$('#api-config-name').val('输入法草稿'); const before = fixture.saveCount(); document.getElementById('api-config-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); return fixture.saveCount() === before;`);
    await check('source labels and fields switch together', `$('#api-config-source').val('makersuite').trigger('change'); const google = $('#api-config-url').closest('.api-config-field').prop('hidden') && !$('#api-config-proxy-password').closest('.api-config-field').prop('hidden'); $('#api-config-source').val('custom').trigger('change'); return google && !$('#api-config-url').closest('.api-config-field').prop('hidden') && $('#api-config-proxy-password').closest('.api-config-field').prop('hidden');`);
    await check('Tab cycles within modal', `const items = $('#api-config-manager').find('button, input, select, textarea, a[href], [tabindex]').filter(':visible:not(:disabled):not([tabindex="-1"])').toArray(); items.at(-1).focus(); $(document).trigger($.Event('keydown', { key: 'Tab' })); const forward = document.activeElement === items[0]; $(document).trigger($.Event('keydown', { key: 'Tab', shiftKey: true })); return forward && document.activeElement === items.at(-1);`);
    await check('tab arrow navigation is accessible', `$('#api-config-editor-tab').focus().trigger($.Event('keydown', { key: 'ArrowLeft' })); return $('#api-config-list-tab').attr('aria-selected') === 'true' && document.activeElement.id === 'api-config-list-tab';`);
    await check('inside click and text drag do not close', `$('#api-config-manager').trigger('pointerdown').trigger('click'); const inside = !$('#api-config-modal').prop('hidden'); $('#api-config-search').trigger('pointerdown'); $('#api-config-modal').trigger('click'); return inside && !$('#api-config-modal').prop('hidden');`);
    await check('backdrop click closes and unlocks', `$('#api-config-modal').trigger('pointerdown').trigger('click'); return $('#api-config-modal').prop('hidden') && !document.documentElement.classList.contains('api-config-modal-open') && window.scrollY === window.originalScroll;`);
    await check('Escape respects IME and host native dialogs', `$('.api-config-open').trigger('click'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })); const composing = !$('#api-config-modal').prop('hidden'); const dialog = document.createElement('dialog'); document.body.append(dialog); dialog.showModal(); $(document).trigger($.Event('keydown', { key: 'Escape' })); const nested = !$('#api-config-modal').prop('hidden'); dialog.close(); dialog.remove(); $(document).trigger($.Event('keydown', { key: 'Escape' })); return composing && nested && $('#api-config-modal').prop('hidden');`);
    await evaluate(`$('.api-config-open').trigger('click');`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await check('real browser Escape closes native layer', `return !document.getElementById('api-config-modal').open && $('#api-config-modal').prop('hidden') && !document.body.classList.contains('api-config-modal-open');`);
    await check('filtered delete honors confirmation and index', `$('.api-config-open').trigger('click'); $('#api-config-search').val('Alpha').trigger('input'); window.confirm = () => false; $('.api-config-delete').trigger('click'); const cancelled = fixture.settings.configs.length === 51; window.confirm = () => true; $('.api-config-delete').trigger('click'); return cancelled && fixture.settings.configs.length === 50 && !fixture.settings.configs.some(config => config.name === '工作用 Alpha');`);
    await check('deleting before an edited item adjusts editing index', `$('#api-config-search').val('新增测试').trigger('input'); $('.api-config-edit').trigger('click'); const index = fixture.editingIndex(); $('#api-config-list-tab').trigger('click'); $('#api-config-search').val('link').trigger('input'); $('.api-config-delete').trigger('click'); return fixture.editingIndex() === index - 1 && $('#api-config-name').val() === '新增测试';`);
    await check('empty-state and counts update', `$('#api-config-editor-tab').trigger('click'); $('#api-config-cancel').trigger('click'); fixture.settings.configs = []; $('#api-config-search').val('').trigger('input'); return $('.api-config-item').length === 0 && $('.api-config-empty').text().includes('新增配置') && $('#api-config-launcher-count').text() === '0 个配置';`);

    await checkConnectionControls();
    await checkPinControls();
    await checkModelControls({ check, evaluate, setViewport, settleLayout, send, fs, path, artifacts });
    await checkCredentialControls({ check, evaluate, setViewport, settleLayout, send, fs, path, artifacts });
    await evaluate(`(async () => {
        fixture.settings.configs = ${JSON.stringify(fixtures)};
        for (const index of [0, 7, 48]) fixture.settings.configs[index].pinned = true;
        fixture.settings.collapsedGroups = {}; fixture.initSettings(); $('#api-config-search').val(''); fixture.renderConfigList();
        await Promise.all(fixture.settings.configs.slice(0, 4).map(fixture.connectConfig));
    })()`);
    await check('pinning from a long list reveals the moved card without moving the host page', `
        const scroll = $('#api-config-list-scroll')[0]; scroll.scrollTop = 1000; const y = scrollY;
        $('.api-config-pin[data-index="47"]').trigger('click');
        const button = $('.api-config-pin[data-index="47"]')[0]; const row = button.closest('.api-config-item').getBoundingClientRect(); const bounds = scroll.getBoundingClientRect();
        return fixture.settings.configs[47].pinned === true && document.activeElement === button && row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1 && scrollY === y;
    `);
    await check('one borderless theme button cycles all three persisted modes', `
        const button = $('#api-config-theme-toggle');
        if (button.length !== 1 || $('.api-config-theme-control').length !== 1 || $('.api-config-theme-option, #api-config-theme, .api-config-theme-note').length || button.attr('data-theme') !== 'light') return false;
        const saves = fixture.saveCount(); const calls = fixture.statusMock.calls.length;
        const configs = JSON.stringify(fixture.settings.configs);
        for (const [theme, icon, next] of [['dark', 'fa-moon', '跟随酒馆 CSS'], ['tavern', 'fa-palette', '白色美化'], ['light', 'fa-sun', '黑色美化']]) {
            button.trigger('click');
            const style = getComputedStyle(button[0]);
            if (fixture.settings.theme !== theme || button.attr('data-theme') !== theme || !button.find('i').hasClass(icon) || !button.attr('aria-label').includes('点击切换为' + next) || style.borderTopWidth !== '0px' || style.boxShadow !== 'none') return false;
        }
        return fixture.saveCount() === saves + 3 && fixture.statusMock.calls.length === calls && JSON.stringify(fixture.settings.configs) === configs;
    `);
    await check('theme selection persists without modifying configs or draft', `
        fixture.showManagerView('editor'); $('#api-config-name').val('换美化也保留的草稿');
        const configs = JSON.stringify(fixture.settings.configs); const saves = fixture.saveCount();
        $('#api-config-theme-toggle').trigger('click'); fixture.setManagerTheme('dark', true);
        $('#api-config-close').trigger('click'); $('.api-config-open').trigger('click'); fixture.initSettings();
        return fixture.settings.theme === 'dark' && $('#api-config-theme-toggle').attr('data-theme') === 'dark' && $('.api-config-launcher').attr('data-api-config-theme') === 'dark' && $('#api-config-modal').attr('data-api-config-theme') === 'dark' && $('#api-config-name').val() === '换美化也保留的草稿' && JSON.stringify(fixture.settings.configs) === configs && fixture.saveCount() === saves + 1;
    `);
    await check('unknown saved theme falls back without discarding configs', `const configs = fixture.settings.configs; fixture.settings.theme = 'unknown'; fixture.initSettings(); fixture.setManagerTheme(fixture.settings.theme); return fixture.settings.theme === 'light' && fixture.settings.configs === configs;`);
    await evaluate(`$('#api-config-cancel').trigger('click');`);

    for (const [theme, selection, variables] of [
        ['light', 'light', themes.dark], ['dark', 'dark', themes.light],
        ['tavern-light', 'tavern', themes.light], ['tavern-dark', 'tavern', themes.dark],
    ]) {
        await evaluate(`Object.entries(${JSON.stringify(variables)}).forEach(([name, value]) => document.documentElement.style.setProperty('--' + name, value)); fixture.setManagerTheme('${selection}', true);`);
        for (const [width, height, mobile] of [[1298, 860, false], [1024, 768, false], [768, 1024, true], [600, 800, true], [480, 800, true], [390, 844, true], [320, 640, true], [280, 580, true], [844, 390, true], [640, 320, true], [390, 320, true]]) {
            await setViewport(width, height, mobile);
            await evaluate(`fixture.showManagerView('list'); $('#api-config-list-scroll').scrollTop(0);`);
            await checkHeaderControlSizing(`${theme} ${width}x${height}`);
            await check(`${theme} ${width}x${height}: list fits, no overlap`, `
                const dialog = document.getElementById('api-config-manager'); const rect = dialog.getBoundingClientRect();
                const scroll = document.getElementById('api-config-list-scroll');
                const title = document.getElementById('api-config-dialog-title').getBoundingClientRect();
                const actions = document.querySelector('.api-config-header-actions').getBoundingClientRect();
                const tabs = document.querySelector('.api-config-tabs').getBoundingClientRect();
                const theme = document.querySelector('.api-config-theme-control').getBoundingClientRect();
                const card = document.querySelector('.api-config-item'); const cardRect = card.getBoundingClientRect();
                const connectIcon = document.querySelector('#api-config-connect-all > i');
                if (!connectIcon.getBoundingClientRect().width || getComputedStyle(connectIcon).display === 'none') return false;
                const minimum = matchMedia('(pointer: coarse)').matches ? 30 : 24;
                const buttonsFit = [...document.querySelectorAll('.api-config-item')].every(item => {
                    const r = item.getBoundingClientRect(); const info = item.querySelector('.api-config-info').getBoundingClientRect();
                    const pin = item.querySelector('.api-config-pin').getBoundingClientRect(); const actions = item.querySelector('.api-config-actions').getBoundingClientRect();
                    const controls = [...item.querySelectorAll('button')];
                    return r.height < 105 && controls.length === 5 && item.querySelectorAll('.api-config-actions button').length === 4 && info.right <= pin.left + 1 && (pin.right <= actions.left + 1 || Math.max(pin.bottom, info.bottom) <= actions.top + 1) && controls.every(button => { const b = button.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right + 1 && b.top >= r.top && b.bottom <= r.bottom + 1 && b.height >= minimum && b.height <= minimum + 2; });
                });
                return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && Math.abs(rect.left - (innerWidth - rect.width) / 2) < 2 && Math.abs(rect.top - (innerHeight - rect.height) / 2) < 2 && dialog.scrollWidth <= dialog.clientWidth + 1 && scroll.scrollWidth <= scroll.clientWidth + 1 && scroll.clientHeight > 60 && scroll.scrollHeight > scroll.clientHeight && title.right < actions.left && (theme.left >= actions.left && theme.right <= actions.right && theme.bottom <= tabs.top + 1) && theme.right <= rect.right && cardRect.height < 105 && buttonsFit;
            `);
            await check(`${theme} ${width}x${height}: local scrolling`, `const before = $('.api-config-dialog-header')[0].getBoundingClientRect().top; const y = window.scrollY; $('#api-config-list-scroll').scrollTop(1000); return $('#api-config-list-scroll').scrollTop() > 0 && $('.api-config-dialog-header')[0].getBoundingClientRect().top === before && window.scrollY === y;`);
            await evaluate(`$('#api-config-list-scroll').scrollTop(0);`);
            if (((theme === 'light' || theme === 'tavern-light') && width === 1298) || (theme === 'dark' && width === 390 && height === 844)) {
                await new Promise(resolve => setTimeout(resolve, 200));
                const screenshot = await send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(path.join(artifacts, `${theme}-${width}-list.png`), Buffer.from(screenshot.data, 'base64'));
            }
            await evaluate(`fixture.showManagerView('editor'); $('#api-config-source').val('makersuite').trigger('change');`);
            await check(`${theme} ${width}x${height}: editor footer always visible`, `const dialog = $('#api-config-manager')[0].getBoundingClientRect(); const save = $('#api-config-save')[0].getBoundingClientRect(); const scroll = $('#api-config-editor-scroll')[0]; return save.top >= dialog.top && save.bottom <= dialog.bottom && scroll.clientHeight > 50 && scroll.scrollWidth <= scroll.clientWidth + 1 && $('#api-config-manager')[0].scrollHeight <= $('#api-config-manager')[0].clientHeight + 1;`);
            if (((theme === 'light' || theme === 'tavern-light') && width === 1298) || (theme === 'dark' && width === 390 && height === 844)) {
                const screenshot = await send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(path.join(artifacts, `${theme}-${width}-editor.png`), Buffer.from(screenshot.data, 'base64'));
            }
        }
    }
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await setViewport(1298, 860);
    await evaluate(`fixture.showManagerView('list'); fixture.setManagerTheme('tavern', true);`);
    await check('Tavern mode follows theme variables live while open', `
        const root = document.documentElement; window.savedHostStyle = root.getAttribute('style');
        root.style.setProperty('--SmartThemeBlurTintColor', 'rgb(27, 43, 39)');
        root.style.setProperty('--SmartThemeBodyColor', 'rgb(224, 241, 228)');
        root.style.setProperty('--SmartThemeEmColor', 'rgb(115, 190, 150)');
        root.style.setProperty('--SmartThemeBorderColor', 'rgb(64, 102, 87)');
        root.style.setProperty('--blurStrength', '4');
        const dialog = getComputedStyle($('#api-config-manager')[0]);
        const card = getComputedStyle($('.api-config-item')[0]);
        return dialog.backgroundColor === 'rgb(27, 43, 39)' && dialog.color === 'rgb(224, 241, 228)' && card.borderLeftColor === 'rgb(115, 190, 150)' && dialog.borderTopColor === 'rgb(64, 102, 87)' && dialog.backdropFilter === 'blur(4px)';
    `);
    await check('host blur setting and no-blur mode apply', `
        document.body.classList.add('no-blur'); const off = getComputedStyle($('#api-config-modal')[0]).backdropFilter === 'none' && getComputedStyle($('#api-config-manager')[0]).backdropFilter === 'none';
        document.body.classList.remove('no-blur'); return off && getComputedStyle($('#api-config-manager')[0]).backdropFilter === 'blur(4px)';
    `);
    await check('custom CSS wins without !important, even loaded before extension CSS', `
        const style = document.createElement('style'); style.id = 'fixture-user-css';
        style.textContent = '.popup { background: rgb(25, 45, 39); border-color: rgb(78, 124, 104); border-radius: 22px; font-family: monospace; } .menu_button { background: rgb(54, 88, 73); color: rgb(232, 252, 238); border-radius: 12px; box-shadow: inset 0 0 0 1px rgb(96, 154, 126); font-family: monospace; } .text_pole { background: rgb(33, 57, 48); color: rgb(226, 247, 235); border-color: rgb(66, 106, 88); border-radius: 11px; font-family: monospace; }';
        document.head.insertBefore(style, document.head.lastElementChild);
        const dialog = getComputedStyle($('#api-config-manager')[0]);
        const button = getComputedStyle($('.api-config-apply')[0]);
        const input = getComputedStyle($('#api-config-search')[0]);
        return dialog.backgroundColor === 'rgb(25, 45, 39)' && dialog.borderTopLeftRadius === '22px' && dialog.fontFamily === 'monospace' && button.backgroundColor === 'rgb(54, 88, 73)' && button.borderTopLeftRadius === '12px' && button.color === 'rgb(232, 252, 238)' && input.backgroundColor === 'rgb(33, 57, 48)' && input.borderTopLeftRadius === '11px' && input.fontFamily === 'monospace';
    `);
    await check('theme toggle stays borderless even with custom button borders and shadows', `
        const style = getComputedStyle($('#api-config-theme-toggle')[0]);
        return style.borderTopWidth === '0px' && style.boxShadow === 'none';
    `);
    await check('fixed black and white modes do not pick up Tavern custom colors', `
        const configs = JSON.stringify(fixture.settings.configs); const hostStyle = document.documentElement.getAttribute('style');
        fixture.setManagerTheme('light', true);
        const light = getComputedStyle($('#api-config-manager')[0]).backgroundColor === 'rgb(250, 251, 254)' && getComputedStyle($('.api-config-apply')[0]).backgroundColor === 'rgb(241, 243, 248)' && getComputedStyle($('#api-config-search')[0]).borderTopLeftRadius === '6px';
        fixture.setManagerTheme('dark', true);
        const dark = getComputedStyle($('#api-config-manager')[0]).backgroundColor === 'rgb(35, 38, 48)' && getComputedStyle($('.api-config-apply')[0]).backgroundColor === 'rgb(43, 47, 59)';
        fixture.setManagerTheme('tavern', true);
        return light && dark && document.documentElement.getAttribute('style') === hostStyle && JSON.stringify(fixture.settings.configs) === configs && getComputedStyle($('#api-config-manager')[0]).backgroundColor === 'rgb(25, 45, 39)';
    `);
    await check('editing the custom stylesheet updates the open modal immediately', `
        const style = document.getElementById('fixture-user-css'); style.textContent += '.popup { border-radius: 18px; } .menu_button { border-radius: 9px; }';
        return getComputedStyle($('#api-config-manager')[0]).borderTopLeftRadius === '18px' && getComputedStyle($('.api-config-apply')[0]).borderTopLeftRadius === '9px' && document.getElementById('api-config-modal').open;
    `);
    await check('theme font size changes are not frozen to a fixed pixel size', `
        document.documentElement.style.setProperty('--mainFontSize', '20px');
        const expanded = parseFloat(getComputedStyle($('#api-config-manager')[0]).fontSize) === 17.5 && parseFloat(getComputedStyle($('.api-config-name')[0]).fontSize) === 17.5;
        document.documentElement.style.removeProperty('--mainFontSize'); return expanded;
    `);
    for (const [width, height, mobile] of [[1298, 860, false], [390, 844, true]]) {
        await setViewport(width, height, mobile);
        await evaluate(`fixture.showManagerView('list'); $('#api-config-list-scroll').scrollTop(0);`);
        await checkHeaderControlSizing(`custom CSS ${width}`);
        await check(`custom CSS ${width}: stays centered and bounded`, `
            const panel = $('#api-config-manager')[0]; const rect = panel.getBoundingClientRect();
            return Math.abs(rect.left - (innerWidth - rect.width) / 2) < 2 && Math.abs(rect.top - (innerHeight - rect.height) / 2) < 2 && panel.scrollWidth <= panel.clientWidth + 1 && rect.bottom <= innerHeight;
        `);
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(artifacts, `tavern-custom-${width}-list.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await check('touch opening and tab switching do not autofocus the keyboard', `
        $('#api-config-close').trigger('click'); $('.api-config-open').trigger('click');
        const opened = document.activeElement.id === 'api-config-manager' && $('.api-config-apply').first().outerHeight() >= 30 && $('.api-config-apply').first().outerHeight() < 36;
        $('#api-config-editor-tab').trigger('click');
        return matchMedia('(pointer: coarse)').matches && opened && document.activeElement.id === 'api-config-manager' && parseFloat(getComputedStyle($('#api-config-name')[0]).fontSize) >= 16 && $('#api-config-save').outerHeight() >= 44;
    `);
    await evaluate(`document.getElementById('fixture-user-css').remove(); document.documentElement.setAttribute('style', window.savedHostStyle);`);

    // 真实软键盘不能在无头浏览器中打开；用带 resize / scroll 事件的可见视口模拟。
    await check('keyboard viewport listeners are attached only once', `
        $('#api-config-close').trigger('click');
        window.originalViewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
        window.testViewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 });
        const events = new Set(); window.viewportSubscriptions = events;
        testViewport.addEventListener = function(type, callback, options) { events.add(type); EventTarget.prototype.addEventListener.call(this, type, callback, options); };
        testViewport.removeEventListener = function(type, callback) { events.delete(type); EventTarget.prototype.removeEventListener.call(this, type, callback); };
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: testViewport });
        $('.api-config-open').trigger('click'); $('.api-config-open').trigger('click');
        return events.size === 2;
    `);
    await evaluate(`$('#api-config-source').val('makersuite').trigger('change'); $('#api-config-model')[0].focus({ preventScroll: true }); testViewport.height = 340; testViewport.offsetTop = 36; testViewport.dispatchEvent(new Event('resize'));`);
    await settleLayout();
    await check('keyboard: editor centered in visible area; input and save remain visible', `
        const rect = $('#api-config-manager')[0].getBoundingClientRect();
        const save = $('#api-config-save')[0].getBoundingClientRect();
        const input = $('#api-config-model')[0].getBoundingClientRect();
        const scroll = $('#api-config-editor-scroll')[0].getBoundingClientRect();
        return Math.abs(rect.top - (36 + (340 - rect.height) / 2)) < 2 && Math.abs(rect.left - (390 - rect.width) / 2) < 2 && save.bottom <= 376 && input.top >= scroll.top && input.bottom <= scroll.bottom && $('#api-config-modal').hasClass('api-config-compact-height');
    `);
    await evaluate(`testViewport.width = 344; testViewport.offsetLeft = 20; testViewport.offsetTop = 60; testViewport.dispatchEvent(new Event('scroll'));`);
    await settleLayout();
    await check('visual viewport panning keeps both axes centered', `
        const rect = $('#api-config-manager')[0].getBoundingClientRect();
        return Math.abs(rect.left - (20 + (344 - rect.width) / 2)) < 2 && Math.abs(rect.top - (60 + (340 - rect.height) / 2)) < 2;
    `);
    await check('close removes viewport listeners and temporary inline geometry', `
        $('#api-config-close').trigger('click'); testViewport.dispatchEvent(new Event('resize'));
        await new Promise(resolve => requestAnimationFrame(resolve));
        const modal = $('#api-config-modal')[0];
        return viewportSubscriptions.size === 0 && !modal.style.getPropertyValue('--acm-viewport-height') && !modal.style.getPropertyValue('--acm-viewport-left') && !modal.classList.contains('api-config-compact-height');
    `);
    await check('reopening after keyboard closes recalculates the viewport', `
        testViewport.width = 390; testViewport.height = 844; testViewport.offsetLeft = 0; testViewport.offsetTop = 0;
        $('.api-config-open').trigger('click'); const rect = $('#api-config-manager')[0].getBoundingClientRect();
        return Math.abs(rect.top - (844 - rect.height) / 2) < 2 && !$('#api-config-modal').hasClass('api-config-compact-height') && viewportSubscriptions.size === 2;
    `);
    await evaluate(`$('#api-config-close').trigger('click'); Object.defineProperty(window, 'visualViewport', originalViewportDescriptor);`);

    if (errors.length) throw new Error(`Browser exceptions: ${JSON.stringify(errors)}`);
    console.log(`PASS: ${cases.length} checks (mock data only; all page network requests blocked)`);
    console.log(`Screenshots: ${artifacts}`);
}

const deadline = setTimeout(() => { console.error('Overall test timeout'); browser?.kill(); process.exit(1); }, 60000);
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    clearTimeout(deadline);
    if (socket?.readyState === WebSocket.OPEN) {
        await send('Browser.close', {}, null).catch(() => {});
        socket.close();
    }
    for (const request of pending.values()) clearTimeout(request.timer);
    browser?.kill();
});
