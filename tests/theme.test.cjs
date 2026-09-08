// 无浏览器、无依赖；验证生产美化切换代码和实际点击处理，不读取真实配置。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const start = source.indexOf('const MANAGER_THEMES =');
const end = source.indexOf('// 编辑状态', start);
assert.ok(start >= 0 && end > start, 'production theme code must be present');
const themeSource = source.slice(start, end);
const clickHandler = source.match(/\$\(document\)\.on\('click\.apiConfigManager', '#api-config-theme-toggle', (function \(\) \{[\s\S]*?\n    \})\);/)?.[1];
assert.ok(clickHandler, 'the single theme button must have a click handler');

function harness(theme = 'light') {
    const settings = { theme, configs: [{ name: 'Fixture', pinned: true }], collapsedGroups: { Fixture: true } };
    const attributes = new Map();
    const calls = { saves: 0, layouts: 0 };
    const modal = { open: false };
    const $ = selector => ({
        attr(name, value) {
            attributes.set(selector + '/' + name, value);
            return this;
        },
        find(child) { return $(selector + ' ' + child); },
    });
    const context = vm.createContext({
        $, MODULE_NAME: 'api-config-manager', extension_settings: { 'api-config-manager': settings },
        defaultSettings: { theme: 'light' },
        document: { getElementById: id => id === 'api-config-modal' ? modal : null },
        saveSettingsDebounced: () => calls.saves++, scheduleManagerViewport: () => calls.layouts++,
    });
    vm.runInContext(themeSource + '\nglobalThis.clickTheme = ' + clickHandler + ';', context);
    const attribute = (name, icon = false) => attributes.get('#api-config-theme-toggle' + (icon ? ' i' : '') + '/' + name);
    return { settings, calls, modal, attributes, attribute, set: context.setManagerTheme, click: context.clickTheme };
}

test('one icon-only theme control replaces the three buttons and hidden dropdown', () => {
    assert.equal((source.match(/<button[^>]*id="api-config-theme-toggle"/g) || []).length, 1);
    assert.doesNotMatch(source, /api-config-theme-option|api-config-theme-note|<select[^>]*id="api-config-theme"/);
    const launcher = source.match(/<button[^>]*class="menu_button api-config-open"[\s\S]*?<\/button>/)?.[0];
    assert.ok(launcher);
    assert.match(launcher, /aria-label="打开配置管理器"/);
    assert.equal(launcher.replace(/<[^>]*>/g, '').trim(), '');
});

test('clicks cycle light, dark, Tavern and back, synchronizing icons and accessible hints', () => {
    const f = harness();
    const before = JSON.stringify(f.settings);
    f.set('light');
    assert.equal(f.calls.saves, 0);
    for (const [theme, icon, label, next] of [
        ['dark', 'fa-moon', '黑色美化', '跟随酒馆 CSS'],
        ['tavern', 'fa-palette', '跟随酒馆 CSS', '白色美化'],
        ['light', 'fa-sun', '白色美化', '黑色美化'],
    ]) {
        f.click();
        assert.equal(f.settings.theme, theme);
        assert.equal(f.attribute('data-theme'), theme);
        assert.equal(f.attribute('class', true), 'fa-solid ' + icon);
        assert.equal(f.attribute('title'), '当前：' + label + '；点击切换为' + next);
        assert.equal(f.attribute('aria-label'), f.attribute('title'));
        assert.equal(f.attributes.get('.api-config-launcher, #api-config-modal/data-api-config-theme'), theme);
    }
    assert.equal(f.calls.saves, 3, 'one save per click, not one per handler registration');
    assert.equal(JSON.stringify(f.settings), before, 'configs and groups are untouched');
});

test('saved dark or Tavern modes render without saving and resume the correct cycle', () => {
    for (const [saved, icon, next] of [['dark', 'fa-moon', 'tavern'], ['tavern', 'fa-palette', 'light']]) {
        const f = harness(saved);
        f.set(saved);
        assert.equal(f.attribute('class', true), 'fa-solid ' + icon);
        assert.equal(f.calls.saves, 0);
        f.click();
        assert.equal(f.settings.theme, next);
        assert.equal(f.calls.saves, 1);
    }
});

test('reapplying the active theme does not save; layout updates only while the modal is open', () => {
    const f = harness();
    f.set('light', true);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.calls.layouts, 0);
    f.modal.open = true;
    f.click();
    assert.equal(f.calls.saves, 1);
    assert.equal(f.calls.layouts, 1);
    f.set('dark', true);
    assert.equal(f.calls.saves, 1);
    assert.equal(f.calls.layouts, 2);
});

test('unknown saved themes fall back without dropping configs or showing an undefined icon', () => {
    const f = harness('unknown');
    const configs = f.settings.configs;
    f.set(f.settings.theme);
    assert.equal(f.settings.theme, 'light');
    assert.equal(f.attribute('class', true), 'fa-solid fa-sun');
    assert.equal(f.settings.configs, configs);
    assert.equal(f.calls.saves, 0);
    f.click();
    assert.equal(f.settings.theme, 'dark');
});
