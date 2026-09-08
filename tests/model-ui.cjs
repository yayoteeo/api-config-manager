// 多模型交互和窄屏布局：供 modal-ui.test.cjs 的隔离浏览器调用。
module.exports = async function checkModelControls({ check, evaluate, setViewport, settleLayout, send, fs, path, artifacts }) {
    await evaluate(`
        $('#api-config-cancel').trigger('click');
        fixture.settings.configs = [
            { name: 'Legacy single', group: 'Models', source: 'custom', customUrl: 'https://legacy.invalid/v1', model: 'legacy-model' },
            { name: 'Multi <b>config</b>', group: 'Models', source: 'custom', customUrl: 'https://multi.invalid/v1', key: 'MODEL-TEST-ONLY-KEY', models: ['first-model', 'second-model', 'quoted"model[0]', '<img src=x onerror="window.modelXss=true">', 'vendor/' + 'long-model-'.repeat(12)], model: 'second-model' },
            { name: 'Google multi', group: 'Other', source: 'makersuite', models: ['google-a', 'google-b'], model: 'google-b' },
            { name: 'No models', group: 'Other', source: 'custom', customUrl: 'https://empty.invalid/v1' },
        ];
        fixture.settings.collapsedGroups = {}; fixture.initSettings(); $('#api-config-search').val(''); fixture.renderConfigList();
        window.multiModelConfig = fixture.settings.configs[1];
        window.modelBaseline = { settings: JSON.stringify(fixture.settings), native: JSON.stringify(fixture.nativeSettings), saves: fixture.saveCount(), calls: fixture.statusMock.calls.length, applied: fixture.applied.length };
    `);
    await check('models: legacy compatibility and expansion arrows before names only for multiple models', `
        const single = $('.api-config-item[data-index="0"]'); const multi = $('.api-config-item[data-index="1"]'); const empty = $('.api-config-item[data-index="3"]');
        return fixture.settings.configs[0].models[0] === 'legacy-model' && single.find('.api-config-expand-icon').prop('hidden') && !multi.find('.api-config-expand-icon').prop('hidden') && multi.find('.api-config-expand-icon').next().hasClass('api-config-name-text') && multi.find('.api-config-info').attr('aria-expanded') === 'false' && !empty.find('.api-config-info').attr('role') && !$('#api-config-list b').length;
    `);
    await check('models: clicking card whitespace expands saved models without applying, connecting or saving', `
        $('.api-config-item[data-index="1"]').trigger('click');
        const card = $('.api-config-item[data-index="1"]'); const info = card.find('.api-config-info');
        return card.find('.api-config-saved-model').length === 5 && card.attr('data-expanded') === 'true' && info.attr('aria-expanded') === 'true' && document.getElementById(info.attr('aria-controls')) === card.find('.api-config-saved-models')[0] && card.find('.api-config-expand-icon').hasClass('fa-chevron-down') && JSON.stringify(fixture.settings) === modelBaseline.settings && fixture.saveCount() === modelBaseline.saves && fixture.applied.length === modelBaseline.applied && fixture.statusMock.calls.length === modelBaseline.calls;
    `);
    await check('models: expanded names are plain text, including quotes and markup', `
        const names = $('.api-config-item[data-index="1"] .api-config-saved-model-name').toArray().map(el => el.textContent);
        return JSON.stringify(names) === JSON.stringify(multiModelConfig.models) && !$('#api-config-list img').length && !window.modelXss && !$('#api-config-list').text().includes('MODEL-TEST-ONLY-KEY');
    `);
    await check('models: Enter and Space expand/collapse with focus retained and IME ignored', `
        const info = $('.api-config-item[data-index="1"] .api-config-info').focus();
        info.trigger($.Event('keydown', { key: 'Enter', isComposing: true })); const ime = info.attr('aria-expanded') === 'true';
        info.trigger($.Event('keydown', { key: 'Enter' })); const closed = info.attr('aria-expanded') === 'false';
        info.trigger($.Event('keydown', { key: ' ' }));
        return ime && closed && info.attr('aria-expanded') === 'true' && document.activeElement === info[0];
    `);
    await check('models: model labels and per-model apply never collapse the parent card', `
        const card = $('.api-config-item[data-index="1"]'); card.find('.api-config-saved-model-name').first().trigger('click');
        const before = fixture.saveCount(); card.find('.api-config-model-apply').eq(2).trigger('click'); await Promise.resolve();
        const applied = fixture.appliedModels.at(-1);
        return card.attr('data-expanded') === 'true' && applied.config === multiModelConfig && applied.model === 'quoted"model[0]' && multiModelConfig.model === applied.model && card.find('.api-config-saved-model[data-default="true"]').data('model') === applied.model && fixture.saveCount() === before + 1 && $(document.activeElement).hasClass('api-config-model-apply');
    `);
    await check('models: the main Apply button uses the last selected model and pinning preserves expansion', `
        $('.api-config-apply[data-index="1"]').trigger('click'); await Promise.resolve();
        const applied = fixture.appliedModels.at(-1); $('.api-config-pin[data-index="1"]').trigger('click');
        return applied.config === multiModelConfig && applied.model === 'quoted"model[0]' && $('.api-config-item[data-index="1"]').attr('data-expanded') === 'true' && $('.api-config-pinned-content .api-config-item').data('config') === multiModelConfig;
    `);
    await check('models: search includes non-default saved models and keeps the correct config for actions', `
        $('#api-config-search').val('long-model-').trigger('input');
        const matched = $('.api-config-item').length === 1 && $('.api-config-item').data('config') === multiModelConfig && $('.api-config-item').data('index') === 1;
        $('.api-config-model-apply').eq(1).trigger('click'); await Promise.resolve(); $('#api-config-search-clear').trigger('click');
        return matched && fixture.appliedModels.at(-1).config === multiModelConfig && multiModelConfig.model === 'second-model' && $('.api-config-item[data-index="1"]').attr('data-expanded') === 'true';
    `);
    await check('models: cancellation leaves all models intact and deleting the default falls back without deleting the config', `
        const before = JSON.stringify(multiModelConfig); window.confirm = () => false;
        $('.api-config-item[data-index="1"] .api-config-model-delete').eq(1).trigger('click');
        const cancelled = JSON.stringify(multiModelConfig) === before; window.confirm = () => true;
        $('.api-config-item[data-index="1"] .api-config-model-delete').eq(1).trigger('click');
        return cancelled && fixture.settings.configs.length === 4 && fixture.settings.configs[1] === multiModelConfig && multiModelConfig.model === 'first-model' && multiModelConfig.models.length === 4 && !multiModelConfig.models.includes('second-model') && multiModelConfig.key === 'MODEL-TEST-ONLY-KEY' && $('.api-config-item[data-index="1"]').attr('data-expanded') === 'true';
    `);
    await check('models: deleting a model during a connection test neither cancels nor misroutes its result', `
        fixture.statusMock.hold = true; const pending = fixture.connectConfig(multiModelConfig); await Promise.resolve();
        const before = fixture.statusMock.calls.length;
        $('.api-config-item[data-index="1"] .api-config-model-delete').eq(1).trigger('click');
        fixture.statusMock.hold = false; fixture.statusMock.releaseAll(); await pending;
        return fixture.statusMock.calls.length === before && fixture.connectionState(multiModelConfig).phase === 'connected' && $('.api-config-item[data-index="1"] .api-config-connection-state').text() === '已连通' && JSON.stringify(fixture.nativeSettings) === modelBaseline.native;
    `);
    await check('models: deleting the last model keeps the config, hides its expander and survives settings reload', `
        $('.api-config-item[data-index="0"]').trigger('click'); $('.api-config-item[data-index="0"] .api-config-model-delete').trigger('click');
        const config = fixture.settings.configs[0]; fixture.initSettings(); fixture.renderConfigList(); $('.api-config-item[data-index="0"]').trigger('click');
        return config.models.length === 0 && !config.model && fixture.settings.configs.length === 4 && $('.api-config-item[data-index="0"] .api-config-no-model').text() === '未设置模型' && !$('.api-config-item[data-index="0"] .api-config-info').attr('role') && $('.api-config-item[data-index="0"] .api-config-saved-models').prop('hidden');
    `);
    await check('models: editor loads every saved model; Enter adds rather than prematurely saving', `
        $('.api-config-edit[data-index="1"]').trigger('click'); window.modelEditorBefore = JSON.stringify(multiModelConfig);
        const before = fixture.saveCount(); const count = multiModelConfig.models.length;
        $('#api-config-model').val('draft-model').trigger($.Event('keydown', { key: 'Enter' }));
        return $('#api-config-preferred-models .api-config-preferred-model').length === count + 1 && $('#api-config-model').val() === '' && fixture.editingIndex() === 1 && !$('#api-config-editor-panel').prop('hidden') && fixture.saveCount() === before && JSON.stringify(multiModelConfig) === modelEditorBefore;
    `);
    await check('models: adding duplicates and fetching/selecting repeatedly keeps a unique model draft', `
        const count = $('#api-config-preferred-models .api-config-preferred-model').length;
        $('#api-config-model').val(' draft-model '); $('#api-config-add-model').trigger('click');
        const deduped = $('#api-config-preferred-models .api-config-preferred-model').length === count;
        $('#api-config-fetch-models').trigger('click');
        for (let i = 0; i < 2; i++) $('#api-config-model-select').val('fixture-model').trigger('change');
        return deduped && $('#api-config-preferred-models .api-config-preferred-model').length === count + 1 && $('#api-config-model').val() === '' && JSON.stringify(multiModelConfig) === modelEditorBefore;
    `);
    await check('models: draft models and selected default survive closing, reopening and tab changes', `
        $('.api-config-editor-model-default').last().trigger('click');
        const draft = $('#api-config-preferred-models').text(); $('#api-config-model').val('pending-model');
        $('#api-config-list-tab').trigger('click'); $('#api-config-editor-tab').trigger('click'); $('#api-config-close').trigger('click'); $('.api-config-open').trigger('click');
        return $('#api-config-preferred-models').text() === draft && $('.api-config-editor-model-default[aria-pressed="true"]').attr('aria-label').includes('fixture-model') && $('#api-config-model').val() === 'pending-model' && JSON.stringify(multiModelConfig) === modelEditorBefore;
    `);
    await check('models: save persists all models, including pending input, with the chosen default and clears the draft', `
        $('#api-config-save').trigger('click'); window.multiModelConfig = fixture.settings.configs[1];
        return multiModelConfig.models.includes('draft-model') && multiModelConfig.models.includes('fixture-model') && multiModelConfig.models.includes('pending-model') && multiModelConfig.model === 'fixture-model' && multiModelConfig.pinned && !$('#api-config-list-panel').prop('hidden') && $('#api-config-preferred-models').prop('hidden') && $('#api-config-model').val() === '' && fixture.settings.configs.length === 4;
    `);
    await check('models: removing a draft model then cancelling never mutates the saved config', `
        const saved = JSON.stringify(multiModelConfig); $('.api-config-edit[data-index="1"]').trigger('click');
        $('.api-config-editor-model-delete').first().trigger('click'); $('#api-config-cancel').trigger('click');
        return JSON.stringify(multiModelConfig) === saved && $('#api-config-preferred-models').prop('hidden') && fixture.editingIndex() === -1;
    `);
    await check('models: index shifts after deleting an earlier config retain the correct expansion and model actions', `
        $('.api-config-item[data-index="1"]').trigger('click'); $('.api-config-delete[data-index="0"]').trigger('click');
        const card = $('.api-config-item[data-index="0"]'); card.find('.api-config-model-apply').last().trigger('click'); await Promise.resolve();
        return fixture.settings.configs[0] === multiModelConfig && card.data('config') === multiModelConfig && card.attr('data-expanded') === 'true' && fixture.appliedModels.at(-1).config === multiModelConfig && multiModelConfig.model === 'pending-model';
    `);

    for (const theme of ['light', 'dark', 'tavern']) {
        await evaluate(`fixture.setManagerTheme('${theme}');`);
        for (const [width, height] of [[1298, 860], [600, 800], [390, 844], [320, 640], [280, 580], [640, 320]]) {
            await setViewport(width, height, width < 600 || height < 400);
            await evaluate(`fixture.showManagerView('list'); $('#api-config-list-scroll').scrollTop(0);`);
            await settleLayout();
            await check(`models: ${theme} ${width}x${height} expanded cards and compact actions fit`, `
                const card = $('.api-config-item[data-index="0"]')[0]; const bounds = card.getBoundingClientRect(); const scroll = $('#api-config-list-scroll')[0];
                const minimum = matchMedia('(pointer: coarse)').matches ? 30 : 24;
                const rows = [...card.querySelectorAll('.api-config-saved-model')];
                return rows.length === multiModelConfig.models.length && scroll.scrollWidth <= scroll.clientWidth + 1 && card.scrollWidth <= card.clientWidth + 1 && rows.every(row => {
                    const text = row.querySelector('.api-config-saved-model-name').getBoundingClientRect(); const actions = row.querySelector('.api-config-model-actions').getBoundingClientRect();
                    return text.right <= actions.left && [...row.querySelectorAll('button')].every(button => { const b = button.getBoundingClientRect(); return b.left >= bounds.left && b.right <= bounds.right && b.height >= minimum && b.height <= minimum + 2; });
                });
            `);
            if ((theme === 'light' && width === 1298) || (theme === 'dark' && width === 390)) {
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(path.join(artifacts, `models-${theme}-${width}-list.png`), Buffer.from(shot.data, 'base64'));
            }
            await evaluate(`$('.api-config-edit[data-index="0"]').trigger('click');`);
            await settleLayout();
            await check(`models: ${theme} ${width}x${height} model editor wraps without hiding the save button`, `
                const scroll = $('#api-config-editor-scroll')[0]; const panel = $('#api-config-manager')[0].getBoundingClientRect(); const save = $('#api-config-save')[0].getBoundingClientRect();
                return scroll.scrollWidth <= scroll.clientWidth + 1 && save.top >= panel.top && save.bottom <= panel.bottom && $('#api-config-preferred-models .api-config-preferred-model').length === multiModelConfig.models.length;
            `);
            if ((theme === 'light' && width === 1298) || (theme === 'dark' && width === 390)) {
                await evaluate(`$('#api-config-editor-scroll').scrollTop(9999);`);
                const shot = await send('Page.captureScreenshot', { format: 'png' });
                fs.writeFileSync(path.join(artifacts, `models-${theme}-${width}-editor.png`), Buffer.from(shot.data, 'base64'));
            }
            await evaluate(`$('#api-config-cancel').trigger('click');`);
        }
    }
    await setViewport(1298, 860);
    await evaluate(`fixture.setManagerTheme('light');`);
    await check('models: fetched IDs and applied model options use safe text even for selector metacharacters and HTML', `
        $('#api-config-editor-tab').trigger('click'); $('#api-config-source').val('custom').trigger('change'); $('#api-config-url').val('https://safe-models.invalid/v1'); $('#api-config-key').val('');
        const hostile = '<img src=x onerror="window.modelXss=true">';
        fixture.statusMock.replies.push({ body: { data: [{ id: hostile }, { id: 'quoted"model[0]' }, { id: hostile }, null, { id: 123 }] } });
        await fixture.fetchModelsForTest();
        const fetched = $('#api-config-model-select option').toArray().map(option => option.value);
        const hostSelect = $('<select id="model_custom_select"><option value="">Select</option></select>').appendTo('body');
        const oldModel = fixture.nativeSettings.custom_model;
        fixture.setPreferredModel(hostile, 'Safe config', 'custom'); fixture.setPreferredModel(hostile, 'Safe config', 'custom'); fixture.setPreferredModel('quoted"model[0]', 'Safe config', 'custom');
        const safe = fetched.length === 3 && fetched.includes(hostile) && hostSelect.find('option').length === 3 && hostSelect.val() === 'quoted"model[0]' && !$('#api-config-modal img').length && !window.modelXss;
        hostSelect.remove(); fixture.nativeSettings.custom_model = oldModel; $('#api-config-cancel').trigger('click');
        return safe;
    `);
};