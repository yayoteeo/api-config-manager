// 密钥显隐及真实获取模型事件的隔离界面回归；所有数据和状态请求均为模拟。
module.exports = async function checkCredentialControls({ check, evaluate, setViewport, settleLayout, send, fs, path, artifacts }) {
    await evaluate(`
        $('#api-config-cancel').trigger('click');
        fixture.settings.configs = [
            { name: 'Custom credentials', source: 'custom', customUrl: 'https://credentials.invalid/v1', key: 'TEST-ONLY-CUSTOM-KEY', models: ['saved-a', 'saved-b'], model: 'saved-a' },
            { name: 'Google credentials', source: 'makersuite', key: 'TEST-ONLY-GOOGLE-KEY', reverseProxy: 'https://google-proxy.invalid', proxyPassword: 'TEST-ONLY-PROXY-TOKEN', models: ['google-a'], model: 'google-a' },
        ];
        fixture.settings.collapsedGroups = {}; fixture.initSettings(); $('#api-config-search').val(''); fixture.renderConfigList();
        window.credentialBaseline = { saves: fixture.saveCount(), secrets: fixture.secretMutations(), native: JSON.stringify(fixture.nativeSettings), applied: fixture.applied.length, calls: fixture.statusMock.calls.length };
        window.waitForModelFetch = async () => {
            for (let count = 0; count < 200; count++) {
                if ($('#api-config-fetch-models').attr('aria-busy') !== 'true') return;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            throw new Error('Model fetch button did not return to idle');
        };
        // 前面的旧控件接线检查使用简化 fetch；这里改回生产处理函数测试完整流程。
        $(document).off('click.apiConfigManager', '#api-config-fetch-models')
            .on('click.apiConfigManager', '#api-config-fetch-models', fixture.fetchModelsForTest);
        $('.api-config-edit[data-index="0"]').trigger('click');
    `);
    await check('credentials: both fields start masked with accessible icon-only eye buttons', `
        const buttons = $('.api-config-credential-toggle');
        return buttons.length === 2 && $('#api-config-key').val() === 'TEST-ONLY-CUSTOM-KEY' && buttons.toArray().every(button => {
            const input = document.getElementById(button.getAttribute('aria-controls'));
            return button.type === 'button' && !button.textContent.trim() && button.getAttribute('aria-pressed') === 'false' && button.title.startsWith('显示') && input.type === 'password' && button.querySelector('.fa-eye');
        });
    `);
    await check('credentials: eye click reveals only its field without saving, applying or reading server secrets', `
        const button = $('.api-config-credential-toggle[aria-controls="api-config-key"]'); button.trigger('click');
        const revealed = $('#api-config-key').attr('type') === 'text' && button.attr('aria-pressed') === 'true' && button.attr('aria-label') === '隐藏API 密钥' && button.find('.fa-eye-slash').length === 1 && $('#api-config-proxy-password').attr('type') === 'password';
        button.trigger('click');
        return revealed && $('#api-config-key').attr('type') === 'password' && $('#api-config-key').val() === 'TEST-ONLY-CUSTOM-KEY' && fixture.saveCount() === credentialBaseline.saves && fixture.secretMutations() === credentialBaseline.secrets && fixture.applied.length === credentialBaseline.applied && fixture.statusMock.calls.length === credentialBaseline.calls && JSON.stringify(fixture.nativeSettings) === credentialBaseline.native;
    `);
    await evaluate(`$('.api-config-credential-toggle[aria-controls="api-config-key"]')[0].focus();`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await check('credentials: Enter activates the focused eye without submitting the config', `
        return $('#api-config-key').attr('type') === 'text' && fixture.saveCount() === credentialBaseline.saves && fixture.editingIndex() === 0;
    `);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await check('credentials: Space hides the focused field again', `return $('#api-config-key').attr('type') === 'password' && fixture.saveCount() === credentialBaseline.saves;`);
    await check('credentials: API key and proxy token can be revealed independently and reset when changing configs', `
        $('.api-config-credential-toggle[aria-controls="api-config-key"]').trigger('click');
        $('.api-config-edit[data-index="1"]').trigger('click');
        const reset = $('#api-config-key').attr('type') === 'password' && $('#api-config-key').val() === 'TEST-ONLY-GOOGLE-KEY';
        $('.api-config-credential-toggle[aria-controls="api-config-proxy-password"]').trigger('click');
        const independent = $('#api-config-proxy-password').attr('type') === 'text' && $('#api-config-key').attr('type') === 'password' && $('#api-config-proxy-password').val() === 'TEST-ONLY-PROXY-TOKEN';
        $('.api-config-credential-toggle[aria-controls="api-config-key"]').trigger('click');
        return reset && independent && $('.api-config-credential-toggle[aria-pressed="true"]').length === 2;
    `);
    await check('credentials: closing or leaving the editor masks values while retaining the unsaved draft', `
        $('#api-config-name').val('保留但隐藏的草稿'); $('#api-config-close').trigger('click'); $('.api-config-open').trigger('click');
        const closed = $('.api-config-credential-toggle[aria-pressed="false"]').length === 2 && $('#api-config-name').val() === '保留但隐藏的草稿' && $('#api-config-proxy-password').val() === 'TEST-ONLY-PROXY-TOKEN';
        $('.api-config-credential-toggle[aria-controls="api-config-key"]').trigger('click'); $('#api-config-list-tab').trigger('click'); $('#api-config-editor-tab').trigger('click');
        return closed && $('#api-config-key').attr('type') === 'password' && $('#api-config-name').val() === '保留但隐藏的草稿';
    `);
    await check('credentials: source changes mask both fields and hide the proxy eye together with its label', `
        $('.api-config-credential-toggle').trigger('click'); $('#api-config-source').val('custom').trigger('change');
        return $('.api-config-credential-toggle[aria-pressed="false"]').length === 2 && $('#api-config-proxy-password').closest('.api-config-field').prop('hidden') && $('.api-config-credential-toggle:visible').length === 1;
    `);
    await check('credentials: saving a revealed key keeps its value but never persists the reveal state', `
        $('.api-config-edit[data-index="0"]').trigger('click'); $('#api-config-key').val('TEST-ONLY-UPDATED').trigger('input');
        $('.api-config-credential-toggle[aria-controls="api-config-key"]').trigger('click'); $('#api-config-save').trigger('click');
        const saved = fixture.settings.configs[0].key === 'TEST-ONLY-UPDATED' && $('#api-config-key').attr('type') === 'password' && !$('#api-config-key').val();
        $('.api-config-edit[data-index="0"]').trigger('click');
        return saved && $('#api-config-key').attr('type') === 'password' && $('#api-config-key').val() === 'TEST-ONLY-UPDATED' && !JSON.stringify(fixture.settings).includes('aria-pressed') && fixture.secretMutations() === credentialBaseline.secrets;
    `);
    await check('model fetch: the real button uses draft credentials, restores itself and supports selecting multiple results', `
        fixture.statusMock.hold = false; fixture.statusMock.replies.push({ body: { data: [{ id: 'fetched-b' }, { id: 'fetched-a' }] } });
        const saved = JSON.stringify(fixture.settings); const calls = fixture.statusMock.calls.length; $('#api-config-fetch-models').trigger('click'); await waitForModelFetch();
        const request = fixture.statusMock.calls.at(-1);
        $('#api-config-model-select').val('fetched-a').trigger('change'); $('#api-config-model-select').val('fetched-b').trigger('change');
        return fixture.statusMock.calls.length === calls + 1 && request.body.custom_url === 'https://credentials.invalid/v1' && JSON.parse(request.body.custom_include_headers).Authorization === 'Bearer TEST-ONLY-UPDATED' && !('messages' in request.body) && !('model' in request.body) && $('#api-config-fetch-models').text() === '获取模型' && !$('#api-config-fetch-models').prop('disabled') && $('#api-config-preferred-models .api-config-preferred-model').length === 4 && JSON.stringify(fixture.settings) === saved && fixture.secretMutations() === credentialBaseline.secrets;
    `);
    await check('model fetch: a second click cancels in-flight work, restores the button and hides obsolete results', `
        fixture.statusMock.hold = true; $('#api-config-fetch-models').trigger('click');
        const request = fixture.statusMock.calls.at(-1);
        const busy = $('#api-config-fetch-models').attr('aria-busy') === 'true' && !$('#api-config-fetch-models').prop('disabled') && $('#api-config-fetch-models').attr('title').includes('20 秒');
        $('#api-config-fetch-models').trigger('click'); await waitForModelFetch();
        return busy && request.aborted && $('#api-config-fetch-models').text() === '获取模型' && !$('#api-config-model-select').is(':visible') && fixture.messages.at(-1).args[0].includes('已取消');
    `);
    for (const [field, value] of [['url', 'https://changed.invalid/v1'], ['key', 'TEST-NEW'], ['reverse-proxy', 'https://new-proxy.invalid'], ['proxy-password', 'TEST-NEW-PROXY']]) {
        await check(`model fetch: changing ${field} cancels the old request and clears its choices`, `
            $('.api-config-edit[data-index="0"]').trigger('click'); $('#api-config-fetch-models').trigger('click'); const request = fixture.statusMock.calls.at(-1);
            $('#api-config-${field}').val('${value}').trigger('input'); await waitForModelFetch();
            return request.aborted && $('#api-config-fetch-models').text() === '获取模型' && $('#api-config-model-select option').length === 1 && !$('#api-config-model-select').is(':visible');
        `);
    }
    await check('model fetch: changing source or editing a different card cancels the previous request', `
        $('.api-config-edit[data-index="0"]').trigger('click'); $('#api-config-fetch-models').trigger('click'); const first = fixture.statusMock.calls.at(-1);
        $('#api-config-source').val('makersuite').trigger('change'); await waitForModelFetch();
        $('#api-config-fetch-models').trigger('click'); const second = fixture.statusMock.calls.at(-1);
        $('.api-config-edit[data-index="1"]').trigger('click'); await waitForModelFetch();
        return first.aborted && second.aborted && $('#api-config-fetch-models').text() === '获取模型' && $('#api-config-key').val() === 'TEST-ONLY-GOOGLE-KEY';
    `);
    for (const action of ['close', 'list-tab', 'cancel', 'save']) {
        await check(`model fetch: ${action} stops waiting without publishing a background result`, `
            $('.api-config-edit[data-index="0"]').trigger('click'); $('#api-config-fetch-models').trigger('click'); const request = fixture.statusMock.calls.at(-1);
            $('#api-config-${action}').trigger('click'); await waitForModelFetch();
            ${action === 'close' ? "$('.api-config-open').trigger('click');" : ''}
            return request.aborted && $('#api-config-fetch-models').text() === '获取模型' && $('#api-config-key').attr('type') === 'password';
        `);
    }
    await check('model fetch: failures show safe feedback, clear busy state and allow successful retry', `
        $('.api-config-edit[data-index="0"]').trigger('click'); fixture.statusMock.hold = false;
        const messages = fixture.messages.length; fixture.statusMock.replies.push({ status: 401, body: { error: 'TEST-DO-NOT-ECHO' } });
        $('#api-config-fetch-models').trigger('click'); await waitForModelFetch();
        const failed = fixture.messages.at(-1).type === 'error' && fixture.messages.at(-1).args[0].includes('HTTP 401') && !JSON.stringify(fixture.messages.slice(messages)).includes('TEST-DO-NOT-ECHO') && !$('#api-config-model-select').is(':visible');
        $('#api-config-fetch-models').trigger('click'); await waitForModelFetch();
        return failed && $('#api-config-model-select').is(':visible') && $('#api-config-fetch-models').text() === '获取模型' && fixture.messages.at(-1).type === 'success' && fixture.secretMutations() === credentialBaseline.secrets && JSON.stringify(fixture.nativeSettings) === credentialBaseline.native;
    `);
    for (const theme of ['light', 'dark', 'tavern']) {
        await evaluate(`fixture.setManagerTheme('${theme}'); $('.api-config-edit[data-index="1"]').trigger('click');`);
        for (const [width, height] of [[1298, 860], [390, 844], [280, 580]]) {
            await setViewport(width, height, width < 600);
            await settleLayout();
            await check(`credentials: ${theme} ${width}x${height} eyes fit inside inputs without borders or overflow`, `
                const scroll = $('#api-config-editor-scroll')[0];
                return $('.api-config-credential-toggle:visible').length === 2 && scroll.scrollWidth <= scroll.clientWidth + 1 && $('.api-config-credential-toggle:visible').toArray().every(button => {
                    const input = document.getElementById(button.getAttribute('aria-controls')); const b = button.getBoundingClientRect(); const box = input.getBoundingClientRect(); const css = getComputedStyle(button);
                    return b.width >= 30 && b.height >= 30 && b.width <= 32 && b.height <= 32 && b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom && parseFloat(getComputedStyle(input).paddingRight) >= b.width + 8 && css.borderTopWidth === '0px' && css.boxShadow === 'none' && input.type === 'password';
                });
            `);
            if ((theme === 'light' && width === 1298) || (theme === 'dark' && width === 390)) {
                await evaluate(`$('#api-config-editor-scroll').scrollTop(100);`);
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(path.join(artifacts, `credentials-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
            }
        }
    }
    await setViewport(1298, 860);
    await evaluate(`fixture.setManagerTheme('light'); $('#api-config-cancel').trigger('click'); delete window.waitForModelFetch;`);
};