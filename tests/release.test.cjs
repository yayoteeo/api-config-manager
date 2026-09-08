const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const source = read('index.js');
const readme = read('README.md');
const changelog = read('CHANGELOG.md');
const guide = read('publish.md');

test('manifest and rendered header use the same release version', () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    const runtimeVersion = source.match(/const EXTENSION_INFO = \{[\s\S]*?version:\s*'([^']+)'[\s\S]*?\};/)?.[1];
    assert.equal(runtimeVersion, manifest.version);
    assert.ok(source.includes('<span class="api-config-version">v${EXTENSION_INFO.version}</span>'));
});

test('current changelog entry and README agree on version and release date', () => {
    const entry = changelog.match(/^## v(\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/m);
    assert.ok(entry, 'A dated release entry must exist');
    assert.equal(entry[1], manifest.version);
    assert.equal(new Date(entry[2]).toISOString().slice(0, 10), entry[2]);
    assert.ok(readme.includes('**当前版本**: v' + manifest.version));
    assert.ok(readme.includes('**更新日期**: ' + entry[2]));
    assert.ok(readme.includes('[CHANGELOG.md](CHANGELOG.md)'));
    assert.match(changelog, /^## v1\.3\.1 \(2025-12-30\)$/m, 'Retain previous release history');
});

test('publish guide references the current tag and canonical release notes', () => {
    assert.ok(guide.includes('**Tag**：`v' + manifest.version + '`'));
    assert.ok(guide.includes('**Release 标题**：`API配置管理器 v' + manifest.version + '`'));
    assert.ok(guide.includes('[CHANGELOG.md](CHANGELOG.md)'));
    assert.ok(guide.includes('git commit -m "Release v' + manifest.version + '"'));
    assert.ok(guide.includes('git push origin v' + manifest.version));
});
