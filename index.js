import { extension_settings, renderExtensionTemplateAsync } from '../../../../../scripts/extensions.js';
import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { SECRET_KEYS, writeSecret, findSecret, readSecretState, secret_state } from '../../../../../scripts/secrets.js';

// Import rotateSecret if available (added in newer SillyTavern versions)
let rotateSecret = null;
try {
    const secretsModule = await import('../../../../../scripts/secrets.js');
    rotateSecret = secretsModule.rotateSecret || null;
} catch (e) {
    console.log('rotateSecret not available in this SillyTavern version');
}
import { oai_settings } from '../../../../../scripts/openai.js';
import { fixToastrForDialogs } from '../../../../../scripts/popup.js';

// 扩展名称
const MODULE_NAME = 'api-config-manager';

const CHAT_COMPLETION_SOURCES = {
    CUSTOM: 'custom',
    MAKERSUITE: 'makersuite',
};

const SOURCE_LABELS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: 'Custom (OpenAI兼容)',
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: 'Google AI Studio',
};

const SOURCE_MODEL_SELECTORS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: '#model_custom_select',
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: '#model_google_select',
};

const SOURCE_MODEL_SETTING_KEYS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: 'custom_model',
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: 'google_model',
};

const SOURCE_SECRET_KEYS = {
    [CHAT_COMPLETION_SOURCES.CUSTOM]: SECRET_KEYS.CUSTOM,
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: SECRET_KEYS.MAKERSUITE,
};

// 扩展信息
const EXTENSION_INFO = {
    name: 'API配置管理器',
    version: '1.3.1',
    author: 'Lorenzzz-Elio',
};

// 默认设置
const defaultSettings = {
    configs: [], // 存储配置列表: [{name: string, url: string, key: string, model?: string, pinned?: boolean}]
    collapsedGroups: {}, // 存储折叠状态: {groupName: boolean}
    theme: 'light', // light / dark / tavern，独立保存，不随关闭弹窗重置
};

const MANAGER_THEMES = {
    light: '白色美化',
    dark: '黑色美化',
    tavern: '跟随酒馆 CSS',
};

function setManagerTheme(theme, persist = false) {
    const value = Object.hasOwn(MANAGER_THEMES, theme) ? theme : defaultSettings.theme;
    const settings = extension_settings[MODULE_NAME];
    const changed = settings.theme !== value;
    settings.theme = value;
    // 只作用于扩展自身，不修改酒馆主题变量、用户 CSS 或其他扩展。
    $('.api-config-launcher, #api-config-modal').attr('data-api-config-theme', value);
    $('#api-config-theme').val(value);
    $('.api-config-theme-note').text(MANAGER_THEMES[value]);
    if (persist && changed) saveSettingsDebounced();
    if (document.getElementById('api-config-modal')?.open) scheduleManagerViewport();
}

// 编辑状态
let editingIndex = -1;
let managerView = 'list';
let managerTrigger = null;
let managerScrollPosition = null;
let managerViewport = null;
let managerViewportFrame = 0;

// 只调整本扩展的顶层遮罩；移动键盘、地址栏和缩放都以实际可见区域为准。
function syncManagerViewport() {
    const modal = document.getElementById('api-config-modal');
    if (!modal || modal.hidden) return;

    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    modal.style.setProperty('--acm-viewport-width', `${width}px`);
    modal.style.setProperty('--acm-viewport-height', `${height}px`);
    modal.style.setProperty('--acm-viewport-left', `${viewport?.offsetLeft || 0}px`);
    modal.style.setProperty('--acm-viewport-top', `${viewport?.offsetTop || 0}px`);
    modal.classList.toggle('api-config-compact-height', height <= 500);

    // 键盘出现后只滚动当前表单，不能使用会带动酒馆整页的 scrollIntoView。
    const active = document.activeElement;
    const scroll = active?.closest('.api-config-scroll-area');
    if (scroll && modal.contains(scroll)) {
        const fieldRect = active.getBoundingClientRect();
        const scrollRect = scroll.getBoundingClientRect();
        if (fieldRect.bottom > scrollRect.bottom - 8) {
            scroll.scrollTop += fieldRect.bottom - scrollRect.bottom + 8;
        } else if (fieldRect.top < scrollRect.top + 8) {
            scroll.scrollTop -= scrollRect.top + 8 - fieldRect.top;
        }
    }
}

function scheduleManagerViewport() {
    if (managerViewportFrame) return;
    managerViewportFrame = requestAnimationFrame(() => {
        managerViewportFrame = 0;
        syncManagerViewport();
    });
}

function stopManagerViewport() {
    window.removeEventListener('resize', scheduleManagerViewport);
    managerViewport?.removeEventListener('resize', scheduleManagerViewport);
    managerViewport?.removeEventListener('scroll', scheduleManagerViewport);
    managerViewport = null;
    cancelAnimationFrame(managerViewportFrame);
    managerViewportFrame = 0;
}

function startManagerViewport() {
    stopManagerViewport();
    managerViewport = window.visualViewport;
    window.addEventListener('resize', scheduleManagerViewport, { passive: true });
    managerViewport?.addEventListener('resize', scheduleManagerViewport, { passive: true });
    managerViewport?.addEventListener('scroll', scheduleManagerViewport, { passive: true });
    syncManagerViewport();
}

// 弹窗只切换可见性，关闭时保留搜索条件和未保存的表单。
function showManagerView(view, focus = true) {
    managerView = view === 'editor' ? 'editor' : 'list';
    const isEditor = managerView === 'editor';
    $('#api-config-list-panel').prop('hidden', isEditor);
    $('#api-config-editor-panel').prop('hidden', !isEditor);
    $('#api-config-list-tab').attr('aria-selected', String(!isEditor)).prop('tabIndex', isEditor ? -1 : 0);
    $('#api-config-editor-tab').attr('aria-selected', String(isEditor)).prop('tabIndex', isEditor ? 0 : -1)
        .text(editingIndex >= 0 ? '编辑配置' : '新增配置');
    $('#api-config-editor-title').text(editingIndex >= 0 ? '编辑配置' : '添加新配置');

    if (focus && !$('#api-config-modal').prop('hidden')) {
        // 触屏先聚焦容器，避免刚打开或切换页面就自动唤起软键盘。
        const target = window.matchMedia('(pointer: coarse)').matches
            ? 'api-config-manager' : isEditor ? 'api-config-name' : 'api-config-search';
        document.getElementById(target)?.focus({ preventScroll: true });
    }
}

function openConfigManager(trigger) {
    const modal = document.getElementById('api-config-modal');
    if (!modal || !modal.hidden) return;

    managerTrigger = trigger || document.activeElement;
    managerScrollPosition = { left: window.scrollX, top: window.scrollY };
    modal.hidden = false;
    // 使用浏览器顶层，避免宿主 html 的 transform 影响定位和遮挡关系。
    modal.showModal();
    fixToastrForDialogs();
    $('html, body').addClass('api-config-modal-open');
    startManagerViewport();
    $('.api-config-open').attr('aria-expanded', 'true');
    renderConfigList();
    showManagerView(managerView);
}

function closeConfigManager() {
    const modal = document.getElementById('api-config-modal');
    if (!modal || modal.hidden) return;

    stopManagerViewport();
    modal.close();
    modal.hidden = true;
    for (const name of ['width', 'height', 'left', 'top']) {
        modal.style.removeProperty(`--acm-viewport-${name}`);
    }
    modal.classList.remove('api-config-compact-height');
    fixToastrForDialogs();
    $('html, body').removeClass('api-config-modal-open');
    $('.api-config-open').attr('aria-expanded', 'false');
    const trigger = managerTrigger?.isConnected && $(managerTrigger).is(':visible')
        ? managerTrigger : $('.api-config-open:visible')[0];
    trigger?.focus({ preventScroll: true });
    if (managerScrollPosition) window.scrollTo({ ...managerScrollPosition, behavior: 'instant' });
    managerTrigger = null;
    managerScrollPosition = null;
}

async function findExistingSecretIdByValue(key, value) {
    const secrets = Array.isArray(secret_state?.[key]) ? secret_state[key] : [];

    for (const secret of secrets) {
        if (!secret?.id) continue;
        if (typeof secret.value === 'string' && secret.value === value) {
            return secret.id;
        }
    }

    // If secret values are masked, trying to read every entry would be very slow.
    // Only attempt server-side reads if we can read at least one secret value.
    const probeId = secrets.find(s => s?.id)?.id;
    if (!probeId) return null;
    const probeValue = await findSecret(key, probeId);
    if (!probeValue) return null;

    for (const secret of secrets) {
        if (!secret?.id) continue;
        const realValue = await findSecret(key, secret.id);
        if (realValue && realValue === value) {
            return secret.id;
        }
    }

    return null;
}

async function ensureSecretActive(key, value, label) {
    if (!value) return null;

    if (!secret_state || Object.keys(secret_state).length === 0) {
        await readSecretState();
    }

    const existingId = await findExistingSecretIdByValue(key, value);
    if (existingId) {
        if (rotateSecret) {
            await rotateSecret(key, existingId);
        }
        return existingId;
    }

    return await writeSecret(key, value, label);
}

function normalizeSource(source) {
    if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) return CHAT_COMPLETION_SOURCES.MAKERSUITE;
    return CHAT_COMPLETION_SOURCES.CUSTOM;
}

function getSourceLabel(source) {
    const normalized = normalizeSource(source);
    if (normalized !== source && source) {
        return `Unsupported (${source})`;
    }
    return SOURCE_LABELS[normalized] || SOURCE_LABELS[CHAT_COMPLETION_SOURCES.CUSTOM];
}

function getModelSelectSelector(source) {
    return SOURCE_MODEL_SELECTORS[normalizeSource(source)] || SOURCE_MODEL_SELECTORS[CHAT_COMPLETION_SOURCES.CUSTOM];
}

function setChatCompletionSource(source) {
    const normalized = normalizeSource(source);
    $('#chat_completion_source').val(normalized).trigger('change');
    if (typeof oai_settings !== 'undefined') {
        oai_settings.chat_completion_source = normalized;
    }
}

function setReverseProxyFields(reverseProxy, proxyPassword) {
    if (reverseProxy !== undefined) {
        $('#openai_reverse_proxy').val(reverseProxy ?? '').trigger('input');
        if (typeof oai_settings !== 'undefined') {
            oai_settings.reverse_proxy = reverseProxy ?? '';
        }
    }

    if (proxyPassword !== undefined) {
        $('#openai_proxy_password').val(proxyPassword ?? '').trigger('input');
        if (typeof oai_settings !== 'undefined') {
            oai_settings.proxy_password = proxyPassword ?? '';
        }
    }
}

async function setSourceSecretIfProvided(source, configName, value, config) {
    const normalized = normalizeSource(source);
    const secretKey = SOURCE_SECRET_KEYS[normalized];
    if (!secretKey || !value) return;

    const label = `ACM: ${configName || getSourceLabel(normalized)}`;

    if (!secret_state || Object.keys(secret_state).length === 0) {
        await readSecretState();
    }

    const knownId =
        (config?.secretIds && typeof config.secretIds === 'object' && config.secretIds[secretKey]) ||
        (normalized === CHAT_COMPLETION_SOURCES.CUSTOM ? config?.secretId : null);

    const secrets = Array.isArray(secret_state?.[secretKey]) ? secret_state[secretKey] : [];
    const hasKnownSecret = knownId ? secrets.some(s => s?.id === knownId) : false;

    if (hasKnownSecret) {
        if (rotateSecret) {
            await rotateSecret(secretKey, knownId);
        }
        return;
    }

    const id = await ensureSecretActive(secretKey, value, label);
    if (!id) return;

    if (!config.secretIds || typeof config.secretIds !== 'object') {
        config.secretIds = {};
    }
    config.secretIds[secretKey] = id;
}

// 初始化扩展设置
function initSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...defaultSettings, configs: [], collapsedGroups: {} };
    }
    
    // 确保configs数组存在
    if (!extension_settings[MODULE_NAME].configs) {
        extension_settings[MODULE_NAME].configs = [];
    }

    // 确保collapsedGroups对象存在
    if (!extension_settings[MODULE_NAME].collapsedGroups) {
        extension_settings[MODULE_NAME].collapsedGroups = {};
    }

    if (!Object.hasOwn(MANAGER_THEMES, extension_settings[MODULE_NAME].theme)) {
        extension_settings[MODULE_NAME].theme = defaultSettings.theme;
    }

    // 兼容旧配置结构
    for (const config of extension_settings[MODULE_NAME].configs) {
        if (!config || typeof config !== 'object') continue;

        if (!config.source) {
            config.source = CHAT_COMPLETION_SOURCES.CUSTOM;
        }

        if (config.source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            if (config.customUrl === undefined && typeof config.url === 'string') {
                config.customUrl = config.url;
            }
            if (typeof config.customUrl === 'string') {
                config.url = config.customUrl;
            }
        }

        if (config.secretId && (!config.secretIds || typeof config.secretIds !== 'object')) {
            config.secretIds = { [SECRET_KEYS.CUSTOM]: config.secretId };
        }
    }
}

// 获取当前API配置
async function getCurrentApiConfig() {
    const url = $('#custom_api_url_text').val() || '';
    // 从secrets系统获取密钥
    const key = secret_state[SECRET_KEYS.CUSTOM] ? await findSecret(SECRET_KEYS.CUSTOM) : '';
    return { url, key };
}

// 应用配置到表单
async function applyConfig(config) {
    try {
        if (!$('#api_button_openai').length || !$('#chat_completion_source').length) {
            throw new Error('未找到API连接界面元素，请在OpenAI/Chat Completions设置页使用此扩展');
        }

        const rawSource = typeof config?.source === 'string' ? config.source : CHAT_COMPLETION_SOURCES.CUSTOM;
        if (rawSource && ![CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.MAKERSUITE].includes(rawSource)) {
            toastr.error(`该配置的来源“${rawSource}”已不再受此扩展支持，请编辑配置并改为Custom/Google AI Studio`, 'API配置管理器');
            return;
        }

        const source = normalizeSource(rawSource);
        setChatCompletionSource(source);

        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            const customUrl = (typeof config.customUrl === 'string' ? config.customUrl : config.url) || '';
            $('#custom_api_url_text').val(customUrl).trigger('input');
            if (typeof oai_settings !== 'undefined') {
                oai_settings.custom_url = customUrl;
            }
        } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            setReverseProxyFields(config.reverseProxy, config.proxyPassword);
        }

        // 通过secrets系统设置密钥（仅在配置里填写了key时覆盖/激活）
        await setSourceSecretIfProvided(source, config.name, config.key, config);

        // 保存设置
        saveSettingsDebounced();

        // 显示应用成功消息
        toastr.success(`正在连接到: ${config.name}（${getSourceLabel(source)}）`, 'API配置管理器');

        // 如果有指定模型，先尝试设置（连接完成后会再次尝试自动选中）
        if (config.model) {
            setPreferredModel(config.model, config.name, source);
        }

        // 自动重新连接
        $('#api_button_openai').trigger('click');

        // 监听连接状态变化，连接成功后立即设置模型
        if (config.model) {
            waitForConnectionAndSetModel(config.model, config.name, source);
        }

    } catch (error) {
        console.error('应用配置时出错:', error);
        toastr.error(`应用配置失败: ${error.message}`, 'API配置管理器');
    }
}

// 智能等待连接并设置模型
function waitForConnectionAndSetModel(modelName, configName, source) {
    let attempts = 0;
    const maxAttempts = 20; // 最多尝试20次，每次500ms，总共10秒

    const checkConnection = () => {
        attempts++;

        // 检查是否已连接（通过检查模型下拉列表是否有选项）
        const modelSelect = $(getModelSelectSelector(source));
        const hasModels = modelSelect.find('option').length > 1; // 除了默认选项外还有其他选项

        if (hasModels) {
            // 连接成功，设置模型
            setPreferredModel(modelName, configName, source);
            return;
        }

        if (attempts < maxAttempts) {
            // 继续等待
            setTimeout(checkConnection, 500);
        } else {
            // 超时，但仍然尝试设置模型
            setPreferredModel(modelName, configName, source);
        }
    };

    // 开始检查
    setTimeout(checkConnection, 1000); // 1秒后开始检查
}

// 设置首选模型
function setPreferredModel(modelName, configName, source) {
    try {
        const normalized = normalizeSource(source);

        // 更新oai_settings
        if (typeof oai_settings !== 'undefined') {
            const settingKey = SOURCE_MODEL_SETTING_KEYS[normalized];
            if (settingKey) {
                oai_settings[settingKey] = modelName;
            }
        }

        if (normalized === CHAT_COMPLETION_SOURCES.CUSTOM) {
            $('#custom_model_id').val(modelName).trigger('input');
        }

        // 检查下拉列表中是否有该模型
        const modelSelect = $(getModelSelectSelector(normalized));
        if (!modelSelect.length) {
            toastr.info(`已设置首选模型: ${modelName}（未找到模型下拉框，连接后可用）`, 'API配置管理器');
            saveSettingsDebounced();
            return;
        }

        const modelOption = modelSelect.find(`option[value="${modelName}"]`);

        if (modelOption.length > 0) {
            // 模型在下拉列表中，选择它
            modelSelect.val(modelName).trigger('change');
            toastr.success(`已自动选择模型: ${modelName}`, 'API配置管理器');
        } else {
            // 模型不在下拉列表中：允许手动输入的来源（尤其是Custom）可以临时注入选项以便生效
            if (modelSelect.is('select')) {
                modelSelect.append(`<option value="${modelName}">${modelName}</option>`);
                modelSelect.val(modelName).trigger('change');
                toastr.success(`已设置模型: ${modelName}（手动添加）`, 'API配置管理器');
            } else {
                toastr.info(`已设置首选模型: ${modelName}（模型将在连接后可用）`, 'API配置管理器');
            }
        }

        // 保存设置
        saveSettingsDebounced();

    } catch (error) {
        console.error('设置模型时出错:', error);
        toastr.warning(`无法自动设置模型 ${modelName}，请手动选择`, 'API配置管理器');
    }
}

// 获取可用模型列表
async function fetchAvailableModels() {
    const source = normalizeSource($('#api-config-source').val());

    const customUrl = $('#api-config-url').val().trim();
    const apiKey = $('#api-config-key').val().trim();
    const reverseProxy = $('#api-config-reverse-proxy').val().trim();
    const proxyPassword = $('#api-config-proxy-password').val().trim();

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM && !customUrl) {
        toastr.error('请先输入Custom API URL', 'API配置管理器');
        return;
    }

    const button = $('#api-config-fetch-models');
    const originalText = button.text();
    button.text('获取中...').prop('disabled', true);

    try {
        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            if (apiKey) {
                await ensureSecretActive(SECRET_KEYS.CUSTOM, apiKey, 'ACM: Fetch models (Custom)');
            }
        } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            if (!reverseProxy && apiKey) {
                await ensureSecretActive(SECRET_KEYS.MAKERSUITE, apiKey, 'ACM: Fetch models (AI Studio)');
            }
        }

        /** @type {any} */
        const requestData = {
            chat_completion_source: source,
            reverse_proxy: reverseProxy,
            proxy_password: proxyPassword,
        };

        if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            requestData.custom_url = customUrl;
        }

        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(requestData),
            cache: 'no-cache'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.error) {
            throw new Error('API连接失败，请检查URL和密钥是否正确');
        }

        if (data.data && Array.isArray(data.data)) {
            const modelSelect = $('#api-config-model-select');
            modelSelect.empty().append('<option value="">选择模型...</option>');

            // 按模型ID排序
            const models = data.data.sort((a, b) => a.id.localeCompare(b.id));

            models.forEach(model => {
                modelSelect.append(`<option value="${model.id}">${model.id}</option>`);
            });

            modelSelect.show();
            toastr.success(`已获取到 ${models.length} 个可用模型`, 'API配置管理器');
        } else {
            throw new Error('API返回的数据格式不正确');
        }

    } catch (error) {
        console.error('获取模型列表失败:', error);
        toastr.error(`获取模型列表失败: ${error.message}`, 'API配置管理器');
    } finally {
        button.text(originalText).prop('disabled', false);
    }
}

// 保存新配置（从用户输入）
function saveNewConfig() {
    const name = $('#api-config-name').val().trim();
    const group = $('#api-config-group').val().trim();
    const source = normalizeSource($('#api-config-source').val());

    const customUrl = $('#api-config-url').val().trim();
    const key = $('#api-config-key').val().trim();
    const reverseProxy = $('#api-config-reverse-proxy').val().trim();
    const proxyPassword = $('#api-config-proxy-password').val().trim();
    const model = $('#api-config-model').val().trim();

    if (!name) {
        toastr.error('请输入配置名称', 'API配置管理器');
        return;
    }

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        if (!customUrl && !key) {
            toastr.error('Custom配置请至少输入URL或密钥', 'API配置管理器');
            return;
        }
    } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        if (!reverseProxy && !key) {
            toastr.info('未填写反代URL和密钥：将使用酒馆已保存的Google AI Studio密钥（如已配置）', 'API配置管理器');
        }
    }

    const config = {
        name: name,
        group: group || undefined,
        source: source,
        url: source === CHAT_COMPLETION_SOURCES.CUSTOM ? customUrl : undefined,
        customUrl: source === CHAT_COMPLETION_SOURCES.CUSTOM ? customUrl : undefined,
        key: key,
        reverseProxy: source === CHAT_COMPLETION_SOURCES.MAKERSUITE ? reverseProxy : undefined,
        proxyPassword: source === CHAT_COMPLETION_SOURCES.MAKERSUITE ? proxyPassword : undefined,
        model: model || undefined, // 只有在有值时才保存model字段
        secretId: undefined,
        secretIds: undefined,
    };

    if (editingIndex >= 0) {
        // 更新现有配置（编辑模式）
        const previousConfig = extension_settings[MODULE_NAME].configs[editingIndex];
        config.pinned = previousConfig?.pinned === true;
        const secretKey = SOURCE_SECRET_KEYS[source];
        const prevSource = normalizeSource(previousConfig?.source);
        const prevSecretId =
            (previousConfig?.secretIds && typeof previousConfig.secretIds === 'object' && secretKey ? previousConfig.secretIds[secretKey] : null) ||
            (source === CHAT_COMPLETION_SOURCES.CUSTOM ? previousConfig?.secretId : null);

        if (prevSecretId && previousConfig?.key === config.key && prevSource === source) {
            config.secretId = previousConfig.secretId;
            config.secretIds = previousConfig.secretIds;
        }

        discardConfigConnection(previousConfig);
        extension_settings[MODULE_NAME].configs[editingIndex] = config;
        toastr.success(`已更新配置: ${name}`, 'API配置管理器');
        editingIndex = -1; // 重置编辑状态
        $('#api-config-save').text('保存配置'); // 重置按钮文本
    } else {
        // 检查是否已存在同名配置
        const existingIndex = extension_settings[MODULE_NAME].configs.findIndex(c => c.name === name);

        if (existingIndex >= 0) {
            // 更新现有配置
            const previousConfig = extension_settings[MODULE_NAME].configs[existingIndex];
            config.pinned = previousConfig?.pinned === true;
            const secretKey = SOURCE_SECRET_KEYS[source];
            const prevSource = normalizeSource(previousConfig?.source);
            const prevSecretId =
                (previousConfig?.secretIds && typeof previousConfig.secretIds === 'object' && secretKey ? previousConfig.secretIds[secretKey] : null) ||
                (source === CHAT_COMPLETION_SOURCES.CUSTOM ? previousConfig?.secretId : null);

            if (prevSecretId && previousConfig?.key === config.key && prevSource === source) {
                config.secretId = previousConfig.secretId;
                config.secretIds = previousConfig.secretIds;
            }

            discardConfigConnection(previousConfig);
            extension_settings[MODULE_NAME].configs[existingIndex] = config;
            toastr.success(`已更新配置: ${name}`, 'API配置管理器');
        } else {
            // 添加新配置
            extension_settings[MODULE_NAME].configs.push(config);
            toastr.success(`已保存配置: ${name}`, 'API配置管理器');
        }
    }

    lastConnectionSummary = '';
    saveSettingsDebounced();
    $('#api-config-name').val('');
    $('#api-config-group').val('');
    $('#api-config-url').val('');
    $('#api-config-key').val('');
    $('#api-config-reverse-proxy').val('');
    $('#api-config-proxy-password').val('');
    $('#api-config-model').val('');
    $('#api-config-model-select').hide(); // 隐藏模型选择下拉框
    updateFormBySource($('#api-config-source').val());
    $('#api-config-search').val('');
    renderConfigList();
    showManagerView('list');
}

function updateFormBySource(sourceValue) {
    const source = normalizeSource(sourceValue);

    const $customUrl = $('#api-config-url');
    const $apiKey = $('#api-config-key');
    const $reverseProxy = $('#api-config-reverse-proxy');
    const $proxyPassword = $('#api-config-proxy-password');
    const $fetchModels = $('#api-config-fetch-models');
    const $hint = $('#api-config-source-hint');

    // 标签与输入框一起切换，避免切换来源后留下空白表单行。
    $customUrl.closest('.api-config-field').prop('hidden', source !== CHAT_COMPLETION_SOURCES.CUSTOM);
    $reverseProxy.closest('.api-config-field').prop('hidden', source !== CHAT_COMPLETION_SOURCES.MAKERSUITE);
    $proxyPassword.closest('.api-config-field').prop('hidden', source !== CHAT_COMPLETION_SOURCES.MAKERSUITE);

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        $customUrl.show().attr('placeholder', 'Custom API URL (例如: https://api.openai.com/v1)');
        $apiKey.show().attr('placeholder', 'Custom API密钥 (可选)');
        $reverseProxy.hide();
        $proxyPassword.hide();
        $fetchModels.prop('disabled', false);
        $hint.text('Custom：使用OpenAI兼容接口（可用于反代OpenAI兼容服务）。');
    } else if (source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
        $customUrl.hide();
        $apiKey.show().attr('placeholder', 'Google AI Studio API Key (可选；不填则使用酒馆已保存的密钥)');
        $reverseProxy.show().attr('placeholder', '反代服务器URL (可选；留空使用默认)');
        $proxyPassword.show().attr('placeholder', '反代密码/Key (可选；反代需要时填写)');
        $fetchModels.prop('disabled', false);
        $hint.text('Google AI Studio：支持直接Key或使用反代（reverse_proxy + proxy_password）。');
    }
}

// 连接只走酒馆原生的模型列表 /status，不发送聊天、测试消息或生成请求。
// 限定这两种来源：其他来源的原生 /status 不一定是只读连接（例如 Azure）。
const CONNECTION_TIMEOUT_MS = 20000;
const CONNECTION_CONCURRENCY = 3;
const CONNECTION_NOTE = '“连接”仅获取模型列表，不发送消息；切换 API 请点“应用”。';
const connectionStates = new WeakMap();
const connectionTasks = new Map();
const connectionQueue = [];
let activeConnections = 0;
let allConnectionsRun = null;
let lastConnectionSummary = '';

class ConfigConnectionError extends Error {
    constructor(label, detail) {
        super(detail);
        this.label = label;
    }
}

function validateConnectionUrl(value) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
        throw new ConfigConnectionError('无效端点', '请填写完整的 http:// 或 https:// 端点地址；不要在 URL 中嵌入用户名或密码。');
    }
    return value;
}

function buildConnectionRequest(config) {
    const source = config.source || CHAT_COMPLETION_SOURCES.CUSTOM;
    if (![CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.MAKERSUITE].includes(source)) {
        throw new ConfigConnectionError('不支持', '此来源暂不支持只读连接，未发送任何请求。');
    }

    const key = String(config.key || '').trim();
    const secretKey = SOURCE_SECRET_KEYS[source];
    const secretId = config.secretIds?.[secretKey] || (source === CHAT_COMPLETION_SOURCES.CUSTOM ? config.secretId : undefined);
    const request = { chat_completion_source: source };

    if (source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        const url = String(config.customUrl ?? config.url ?? '').trim();
        if (!url) throw new ConfigConnectionError('缺少端点', '请先编辑此配置并填写自定义端点 URL。');
        request.custom_url = validateConnectionUrl(url);
        if (!key && secretId) {
            // 按配置指定密钥 ID，服务端读取，不切换酒馆当前的活动密钥。
            request.secret_id = secretId;
        } else {
            // /status 支持 JSON（有效 YAML）格式的自定义头；显式覆盖 Authorization。
            // 无密钥的自定义端点使用空授权，绝不把当前其他配置的密钥带到此端点。
            request.custom_include_headers = JSON.stringify({ Authorization: key ? `Bearer ${key}` : '' });
        }
    } else {
        const reverseProxy = String(config.reverseProxy || '').trim();
        if (reverseProxy) {
            request.reverse_proxy = validateConnectionUrl(reverseProxy);
            request.proxy_password = String(config.proxyPassword || '').trim();
        } else if (key) {
            // 指向酒馆原生 Google 默认地址，借用只读 /status 的单次凭据参数。
            // 仍由酒馆选择 Gemini API 版本，不写入或轮换任何服务器密钥。
            request.reverse_proxy = 'https://generativelanguage.googleapis.com';
            request.proxy_password = key;
        } else if (secretId) {
            request.secret_id = secretId;
        } else {
            throw new ConfigConnectionError('缺少密钥', '此配置没有保存 Google AI Studio 密钥或反代地址；请先编辑补全，不会借用其他配置的密钥。');
        }
    }
    return request;
}

function updateConnectionItem(item, config) {
    const state = connectionStates.get(config) || { phase: 'idle', label: '未连接', detail: CONNECTION_NOTE };
    const busy = connectionTasks.has(config);
    item.attr('data-connection-state', state.phase);
    item.find('.api-config-connection-state')
        .text(state.label).attr('title', state.detail).attr('aria-live', allConnectionsRun ? 'off' : 'polite');
    item.find('.api-config-connect').prop('disabled', busy)
        .attr('title', busy ? state.detail : '连接此配置：仅获取模型列表，不发送消息，不切换当前 API');
}

function getAllConnectionsSummary(run, finished = false) {
    const label = finished ? (run.stopping ? '已停止' : '连接完成') : (run.stopping ? '正在停止' : '连接中');
    return `${label} ${run.done}/${run.total} · 连通 ${run.connected} · 未通过 ${run.failed}`
        + (run.cancelled ? ` · 取消 ${run.cancelled}` : '');
}

function updateConnectionToolbar() {
    const run = allConnectionsRun;
    const label = run ? '停止连接' : '全部连接';
    const button = $('#api-config-connect-all');
    button.prop('disabled', Boolean(run?.stopping) || (!run && !extension_settings[MODULE_NAME].configs.length))
        .attr('aria-label', label)
        .attr('title', run ? '停止本次全部连接：取消排队并停止等待已发起的请求' : '连接所有已保存的配置（含搜索隐藏及折叠项）；只获取模型列表，不发送消息');
    button.find('.api-config-connect-all-label').text(label);
    button.find('i').attr('class', `fa-solid ${run ? 'fa-stop' : 'fa-plug'}`);
    $('#api-config-connection-summary').text(run ? getAllConnectionsSummary(run) : lastConnectionSummary || CONNECTION_NOTE);
}

function refreshConnectionUI(config) {
    // 不重建列表：完成异步连接时保留搜索、折叠、滚动位置和其他按钮的焦点。
    $('#api-config-list .api-config-item').each(function () {
        const item = $(this);
        const savedConfig = item.data('config');
        if (!config || savedConfig === config) updateConnectionItem(item, savedConfig);
    });
    updateConnectionToolbar();
}

function finishConnectionTask(task, state) {
    if (task.settled) return;
    task.settled = true;
    connectionTasks.delete(task.config);
    if (extension_settings[MODULE_NAME].configs.includes(task.config)) connectionStates.set(task.config, state);
    if (task.started) activeConnections--;
    task.resolve(state);
    refreshConnectionUI(task.config);
}

async function runConnectionTask(task) {
    let timeout;
    let state;
    const startedAt = performance.now();
    try {
        if (task.controller.signal.aborted) throw new Error('Aborted');
        const request = buildConnectionRequest(task.config);
        timeout = setTimeout(() => {
            task.timedOut = true;
            task.controller.abort();
        }, CONNECTION_TIMEOUT_MS);
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(request),
            signal: task.controller.signal,
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new ConfigConnectionError('未连通', `连接请求未通过（HTTP ${response.status}）；请检查端点、授权或酒馆连接。`);
        }
        let data;
        try {
            data = await response.json();
        } catch {
            throw new ConfigConnectionError('未连通', '端点没有返回有效的模型列表，请检查 URL 与 /models 支持情况。');
        }
        if (task.controller.signal.aborted) throw new Error('Aborted');
        if (!data || data.error || data.bypass || !Array.isArray(data.data)) {
            throw new ConfigConnectionError('未连通', '未能获取模型列表，请检查 URL、密钥以及 /models 支持情况；未发送任何生成请求。');
        }
        const elapsed = Math.max(1, Math.round(performance.now() - startedAt));
        state = {
            phase: 'connected', label: '已连通',
            detail: `本次连接已通过 · ${elapsed} ms · ${data.data.length} 个模型。仅表示模型列表可访问，不代表模型一定能生成回复。`,
        };
    } catch (error) {
        // 不展示或记录上游错误正文、URL、请求体，避免错误信息回显 API 密钥。
        if (task.cancelled) {
            state = { phase: 'cancelled', label: '已取消', detail: '已停止等待本次连接；未发送生成请求。' };
        } else if (task.timedOut) {
            state = { phase: 'failed', label: '连接超时', detail: '20 秒内未收到模型列表；已停止等待，可以稍后重连。' };
        } else if (error instanceof ConfigConnectionError) {
            state = { phase: 'failed', label: error.label, detail: error.message };
        } else {
            state = { phase: 'failed', label: '未连通', detail: '无法获取连接状态，请检查酒馆服务、端点与网络；未发送生成请求。' };
        }
    } finally {
        clearTimeout(timeout);
        finishConnectionTask(task, state);
        pumpConnectionQueue();
    }
}

function pumpConnectionQueue() {
    while (activeConnections < CONNECTION_CONCURRENCY && connectionQueue.length) {
        const task = connectionQueue.shift();
        if (task.settled) continue;
        task.started = true;
        activeConnections++;
        connectionStates.set(task.config, { phase: 'connecting', label: '连接中', detail: '正在获取模型列表（最多等待 20 秒），不会发送消息。' });
        refreshConnectionUI(task.config);
        // 推迟执行，避免一长串无效配置同步失败时递归占满调用栈。
        void Promise.resolve().then(() => runConnectionTask(task));
    }
}

function connectConfig(config) {
    const existing = connectionTasks.get(config);
    if (existing) return existing.promise; // 重复点击或全部连接遇到单条连接时复用，不重复请求。
    if (!config || !extension_settings[MODULE_NAME].configs.includes(config)) {
        return Promise.resolve({ phase: 'cancelled' });
    }
    if (!allConnectionsRun) lastConnectionSummary = '';
    const task = { config, controller: new AbortController(), started: false, settled: false, cancelled: false, timedOut: false };
    task.promise = new Promise(resolve => { task.resolve = resolve; });
    connectionTasks.set(config, task);
    connectionQueue.push(task);
    connectionStates.set(config, { phase: 'queued', label: '等待中', detail: '已排队；同时最多连接 3 个配置，不发送消息。' });
    refreshConnectionUI(config);
    pumpConnectionQueue();
    return task.promise;
}

function cancelConfigConnection(config) {
    const task = connectionTasks.get(config);
    if (!task) return;
    task.cancelled = true;
    task.controller.abort();
    if (!task.started) {
        const index = connectionQueue.indexOf(task);
        if (index >= 0) connectionQueue.splice(index, 1);
        finishConnectionTask(task, { phase: 'cancelled', label: '已取消', detail: '已取消排队，未向此端点发起请求。' });
    }
}

function discardConfigConnection(config) {
    cancelConfigConnection(config);
    connectionStates.delete(config);
    lastConnectionSummary = '';
}

function connectAllConfigs() {
    if (allConnectionsRun) return allConnectionsRun.promise;
    const configs = [...extension_settings[MODULE_NAME].configs];
    if (!configs.length) return Promise.resolve();
    const run = { configs, total: configs.length, done: 0, connected: 0, failed: 0, cancelled: 0, stopping: false };
    allConnectionsRun = run;
    lastConnectionSummary = '';
    run.promise = Promise.all(configs.map(config => connectConfig(config).then(state => {
        run.done++;
        if (state.phase === 'connected') run.connected++;
        else if (state.phase === 'cancelled') run.cancelled++;
        else run.failed++;
        updateConnectionToolbar();
    }))).then(() => {
        lastConnectionSummary = getAllConnectionsSummary(run, true);
        allConnectionsRun = null;
        refreshConnectionUI();
    });
    return run.promise;
}

function stopAllConnections() {
    const run = allConnectionsRun;
    if (!run || run.stopping) return;
    run.stopping = true;
    // 先取消全部排队项，再让异步的活动请求释放并发槽位，避免停止时又启动下一条。
    run.configs.forEach(cancelConfigConnection);
    updateConnectionToolbar();
}

// 删除配置
function deleteConfig(index) {
    const config = extension_settings[MODULE_NAME].configs[index];
    if (!config) return;
    if (confirm(`确定要删除配置 "${config.name}" 吗？`)) {
        discardConfigConnection(config);
        extension_settings[MODULE_NAME].configs.splice(index, 1);
        if (editingIndex === index) {
            resetConfigEditor();
        } else if (editingIndex > index) {
            editingIndex--;
        }
        saveSettingsDebounced();
        renderConfigList();
        document.getElementById('api-config-search')?.focus({ preventScroll: true });
        toastr.success(`已删除配置: ${config.name}`, 'API配置管理器');
    }
}

// 置顶只改变展示位置，不重排保存数组，也不影响正在连接或编辑的配置。
function toggleConfigPin(index) {
    if (!Number.isInteger(index) || index < 0) return;
    const config = extension_settings[MODULE_NAME].configs[index];
    if (!config) return;

    config.pinned = config.pinned !== true;
    saveSettingsDebounced();
    renderConfigList();

    const scroll = document.getElementById('api-config-list-scroll');
    if (config.pinned && scroll) scroll.scrollTop = 0;
    let target = document.querySelector(`.api-config-pin[data-index="${index}"]`);
    // 取消置顶后，原分组可能已折叠；把焦点交回分组标题，不展开分组或唤起键盘。
    if (!target || !$(target).is(':visible')) {
        target = $('#api-config-list .api-config-group-header').filter(function () {
            return $(this).data('group') === (config.group || '未分组');
        }).get(0) || document.getElementById('api-config-list-tab');
    }
    target?.focus({ preventScroll: true });
    if (!scroll || !target || !scroll.contains(target)) return;

    // 只滚动列表来显示操作后的配置，避免 scrollIntoView 带动酒馆整页。
    const row = target.closest('.api-config-item') || target;
    const bounds = scroll.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < bounds.top) scroll.scrollTop += rect.top - bounds.top - 4;
    else if (rect.bottom > bounds.bottom) scroll.scrollTop += rect.bottom - bounds.bottom + 4;
}

// 渲染配置列表
function renderConfigList() {
    const container = $('#api-config-list');
    container.empty();

    const configs = extension_settings[MODULE_NAME].configs;
    const query = String($('#api-config-search').val() || '').trim().toLocaleLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    // 搜索只涉及展示信息，不搜索或展示 API 密钥；保留原始索引用于操作。
    const matches = configs.map((config, index) => ({ config, index })).filter(({ config }) => {
        const text = [config.name, config.group || '未分组', config.model, getSourceLabel(config.source)]
            .filter(Boolean).join(' ').toLocaleLowerCase();
        return terms.every(term => text.includes(term));
    });
    $('#api-config-launcher-count').text(`${configs.length} 个配置`);
    $('#api-config-result-count').text(query ? `找到 ${matches.length} / ${configs.length} 个配置` : `共 ${configs.length} 个配置`);
    $('#api-config-search-clear').prop('hidden', !query);
    updateConnectionToolbar();

    if (matches.length === 0) {
        container.append($('<div class="api-config-empty"></div>').text(
            configs.length ? '没有匹配的配置，试试其他关键词或清空搜索。' : '还没有配置，点击上方“新增配置”开始添加。',
        ));
        return;
    }

    // 置顶区跨分组显示且始终展开；每条配置只渲染一次，取消后回到原分组。
    const pinnedItems = [];
    const grouped = Object.create(null);
    matches.forEach(({ config, index }) => {
        if (config.pinned === true) {
            pinnedItems.push({ config, index });
            return;
        }
        const groupName = config.group || '未分组';
        if (!grouped[groupName]) {
            grouped[groupName] = [];
        }
        grouped[groupName].push({ config, index });
    });

    // 同为置顶的配置保持原保存顺序，不改变操作索引或编辑状态。
    const sections = Object.keys(grouped).sort().map(groupName => ({ groupName, groupItems: grouped[groupName] }));
    if (pinnedItems.length) sections.unshift({ groupName: '置顶', groupItems: pinnedItems, pinned: true });

    sections.forEach(({ groupName, groupItems, pinned = false }) => {
        const headerTag = pinned ? 'div' : 'button';
        const groupHeader = $(`
            <${headerTag} class="${pinned ? 'api-config-pinned-header' : 'api-config-group-header'}"
                ${pinned ? 'role="heading" aria-level="3"' : 'type="button" aria-expanded="true"'}>
                <i class="fa-solid ${pinned ? 'fa-thumbtack' : 'fa-chevron-down'}" aria-hidden="true"></i>
                <span class="api-config-group-name"></span>
                <span class="api-config-group-count">(${groupItems.length})</span>
            </${headerTag}>
        `);
        groupHeader.data('group', groupName);
        groupHeader.find('.api-config-group-name').text(groupName).attr('title', groupName);

        const groupContent = $('<div class="api-config-group-content"></div>').toggleClass('api-config-pinned-content', pinned);

        groupItems.forEach(({ config, index }) => {
            const sourceLabel = getSourceLabel(config.source);
            const configItem = $(`
                <div class="api-config-item">
                    <div class="api-config-info">
                        <div class="api-config-name">
                            <span class="api-config-name-text"></span>
                            <span class="api-config-source-tag"></span>
                        </div>
                        <div class="api-config-details">
                            <div class="${config.model ? 'api-config-model' : 'api-config-no-model'}"></div>
                            <span id="api-config-connection-status-${index}" class="api-config-connection-state" role="status" aria-live="polite" aria-atomic="true"></span>
                        </div>
                    </div>
                    <button type="button" class="menu_button api-config-pin" data-index="${index}">
                        <i class="fa-solid fa-thumbtack" aria-hidden="true"></i>
                    </button>
                    <div class="api-config-actions">
                        <button type="button" class="menu_button api-config-connect" data-index="${index}" aria-describedby="api-config-connection-status-${index}">连接</button>
                        <button type="button" class="menu_button api-config-apply" data-index="${index}">应用</button>
                        <button type="button" class="menu_button api-config-edit" data-index="${index}">编辑</button>
                        <button type="button" class="menu_button api-config-delete" data-index="${index}">删除</button>
                    </div>
                </div>
            `);
            const modelLabel = config.model ? `首选模型: ${config.model}` : '未设置模型';
            const tagLabel = pinned ? `${config.group || '未分组'} · ${sourceLabel}` : sourceLabel;
            const pinLabel = pinned ? '取消置顶' : '置顶';
            configItem.attr('data-pinned', String(pinned));
            configItem.find('.api-config-pin').attr({ 'aria-pressed': String(pinned), 'aria-label': `${pinLabel}：${config.name}`, title: pinLabel });
            configItem.find('.api-config-name-text').text(config.name).attr('title', config.name);
            configItem.find('.api-config-source-tag').text(tagLabel).attr('title', tagLabel);
            configItem.find('.api-config-model, .api-config-no-model').text(modelLabel).attr('title', modelLabel);
            // 对象引用不会因搜索、排序或删除前面的配置而错位；不把密钥写入 DOM 属性。
            configItem.data('config', config);
            updateConnectionItem(configItem, config);
            groupContent.append(configItem);
        });

        container.append(groupHeader);
        container.append(groupContent);

        // 应用保存的折叠状态
        // 搜索时临时展开命中分组，不覆盖用户保存的折叠状态。
        const isCollapsed = !pinned && !query && extension_settings[MODULE_NAME].collapsedGroups[groupName] === true;
        if (isCollapsed) {
            groupContent.hide();
            groupHeader.attr('aria-expanded', 'false');
            groupHeader.find('i').removeClass('fa-chevron-down').addClass('fa-chevron-right');
        }
    });
}

// 编辑配置
function editConfig(index) {
    const config = extension_settings[MODULE_NAME].configs[index];
    if (!config) return;

    // 填充表单
    $('#api-config-name').val(config.name);
    $('#api-config-group').val(config.group || '');
    $('#api-config-source').val(normalizeSource(config.source)).trigger('change');
    $('#api-config-url').val((typeof config.customUrl === 'string' ? config.customUrl : config.url) || '');
    $('#api-config-key').val(config.key || '');
    $('#api-config-reverse-proxy').val(config.reverseProxy || '');
    $('#api-config-proxy-password').val(config.proxyPassword || '');
    $('#api-config-model').val(config.model || '');

    // 隐藏模型选择下拉框
    $('#api-config-model-select').hide();

    // 设置编辑模式
    editingIndex = index;
    $('#api-config-save').text('更新配置');
    showManagerView('editor');
    $('#api-config-editor-scroll').scrollTop(0);
}

function resetConfigEditor() {
    // 重置编辑状态
    editingIndex = -1;
    $('#api-config-save').text('保存配置');

    // 清空表单
    $('#api-config-name').val('');
    $('#api-config-group').val('');
    $('#api-config-url').val('');
    $('#api-config-key').val('');
    $('#api-config-reverse-proxy').val('');
    $('#api-config-proxy-password').val('');
    $('#api-config-model').val('');
    $('#api-config-model-select').hide(); // 隐藏模型选择下拉框
    updateFormBySource($('#api-config-source').val());

    $('#api-config-editor-tab').text('新增配置');
    $('#api-config-editor-title').text('添加新配置');
}

// 取消时明确清空草稿；关闭弹窗或切换到列表不会清空。
function cancelEditConfig() {
    resetConfigEditor();
    showManagerView('list');
}

// 创建紧凑入口和独立弹窗，避免整页被配置列表撑长。
async function createUI() {
    try {
        if (document.getElementById('api-config-modal')) return;

        const launcher = $(`
            <div class="api_config_settings api-config-launcher">
                <div class="api-config-launcher-info">
                    <b>API配置管理器</b>
                    <small id="api-config-launcher-count">0 个配置</small>
                </div>
                <button type="button" class="menu_button api-config-open" aria-haspopup="dialog" aria-controls="api-config-modal" aria-expanded="false">
                    <i class="fa-solid fa-up-right-from-square" aria-hidden="true"></i> 管理配置
                </button>
            </div>
        `);

        const modal = $(`
            <dialog id="api-config-modal" class="api-config-modal" aria-modal="true" aria-labelledby="api-config-dialog-title" hidden>
                <section id="api-config-manager" class="api-config-dialog popup" tabindex="-1" autofocus>
                    <header class="api-config-dialog-header">
                        <div class="api-config-title">
                            <i class="fa-solid fa-layer-group api-config-title-icon" aria-hidden="true"></i>
                            <div class="api-config-title-copy">
                                <div class="api-config-title-line">
                                    <h3 id="api-config-dialog-title">API配置管理器</h3>
                                    <span class="api-config-version">v${EXTENSION_INFO.version}</span>
                                </div>
                                <small class="api-config-theme-note"></small>
                            </div>
                        </div>
                        <div class="api-config-header-actions">
                            <button type="button" id="api-config-connect-all" class="menu_button" title="连接所有已保存的配置；仅获取模型列表，不发送消息" aria-label="全部连接">
                                <i class="fa-solid fa-plug" aria-hidden="true"></i>
                                <span class="api-config-connect-all-label">全部连接</span>
                            </button>
                            <button type="button" id="api-config-close" class="menu_button api-config-icon-button" title="关闭（Esc）" aria-label="关闭配置管理器">×</button>
                        </div>
                    </header>
                    <div class="api-config-navigation">
                        <div class="api-config-tabs" role="tablist" aria-label="配置管理页面">
                            <button type="button" id="api-config-list-tab" role="tab" aria-selected="true" aria-controls="api-config-list-panel">已保存</button>
                            <button type="button" id="api-config-editor-tab" role="tab" aria-selected="false" aria-controls="api-config-editor-panel" tabindex="-1">新增配置</button>
                        </div>
                        <label class="api-config-theme-control" for="api-config-theme">
                            <span>美化</span>
                            <select id="api-config-theme" class="text_pole" aria-label="美化样式" title="白色美化、黑色美化，或跟随酒馆自定义 CSS">
                                <option value="light">白色美化</option>
                                <option value="dark">黑色美化</option>
                                <option value="tavern">跟随酒馆 CSS</option>
                            </select>
                        </label>
                    </div>
                    <section id="api-config-list-panel" class="api-config-panel" role="tabpanel" aria-labelledby="api-config-list-tab">
                        <div class="api-config-list-toolbar">
                            <div class="api-config-search-box">
                                <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                                <input type="search" id="api-config-search" class="text_pole" placeholder="搜索名称、分组、模型或来源…" aria-label="搜索已保存的配置" autocomplete="off">
                                <button type="button" id="api-config-search-clear" class="menu_button api-config-icon-button" title="清空搜索" aria-label="清空搜索" hidden>×</button>
                            </div>
                            <small id="api-config-result-count" role="status" aria-live="polite"></small>
                        </div>
                        <div id="api-config-list-scroll" class="api-config-scroll-area" tabindex="0" role="region" aria-label="已保存的 API 配置列表">
                            <div id="api-config-list"></div>
                        </div>
                        <footer id="api-config-connection-summary" class="api-config-list-footer" role="status" aria-live="polite" aria-atomic="true" title="${CONNECTION_NOTE}">${CONNECTION_NOTE}</footer>
                    </section>
                    <section id="api-config-editor-panel" class="api-config-panel" role="tabpanel" aria-labelledby="api-config-editor-tab" hidden>
                        <div id="api-config-editor-scroll" class="api-config-scroll-area">
                            <h4 id="api-config-editor-title">添加新配置</h4>
                            <div class="api-config-form-grid">
                                <div class="api-config-field">
                                    <label for="api-config-name">配置名称 <span class="api-config-field-note">必填</span></label>
                                    <input type="text" id="api-config-name" placeholder="例如：日常使用" class="text_pole" aria-required="true" autocomplete="off">
                                </div>
                                <div class="api-config-field">
                                    <label for="api-config-group">分组 <span class="api-config-field-note">可选</span></label>
                                    <input type="text" id="api-config-group" placeholder="例如：工作用" class="text_pole" autocomplete="off">
                                </div>
                                <div class="api-config-field api-config-field-wide">
                                    <label for="api-config-source">API 来源</label>
                                    <select id="api-config-source" class="text_pole" aria-describedby="api-config-source-hint">
                                        <option value="${CHAT_COMPLETION_SOURCES.CUSTOM}">Custom (OpenAI兼容)</option>
                                        <option value="${CHAT_COMPLETION_SOURCES.MAKERSUITE}">Google AI Studio</option>
                                    </select>
                                </div>
                                <div class="api-config-field api-config-field-wide">
                                    <label for="api-config-url">API URL</label>
                                    <input type="text" id="api-config-url" placeholder="例如：https://api.openai.com/v1" class="text_pole" spellcheck="false" autocomplete="off">
                                </div>
                                <div class="api-config-field api-config-field-wide">
                                    <label for="api-config-key">API 密钥 <span class="api-config-field-note">可选</span></label>
                                    <input type="password" id="api-config-key" placeholder="API密钥 (可选)" class="text_pole" autocomplete="new-password">
                                </div>
                                <div class="api-config-field api-config-field-wide" hidden>
                                    <label for="api-config-reverse-proxy">反代服务器 URL <span class="api-config-field-note">可选</span></label>
                                    <input type="text" id="api-config-reverse-proxy" class="text_pole" spellcheck="false" autocomplete="off">
                                </div>
                                <div class="api-config-field api-config-field-wide" hidden>
                                    <label for="api-config-proxy-password">反代密码 / Token <span class="api-config-field-note">可选</span></label>
                                    <input type="password" id="api-config-proxy-password" class="text_pole" autocomplete="new-password">
                                </div>
                                <div class="api-config-field api-config-field-wide">
                                    <label for="api-config-model">首选模型 <span class="api-config-field-note">可选</span></label>
                                    <div class="api-config-model-input">
                                        <input type="text" id="api-config-model" placeholder="例如：gpt-4" class="text_pole" autocomplete="off">
                                        <button type="button" id="api-config-fetch-models" class="menu_button">获取模型</button>
                                    </div>
                                    <select id="api-config-model-select" class="text_pole" aria-label="选择获取到的模型" style="display: none;">
                                        <option value="">选择模型...</option>
                                    </select>
                                </div>
                            </div>
                            <small id="api-config-source-hint"></small>
                        </div>
                        <footer class="api-config-editor-footer">
                            <button type="button" id="api-config-cancel" class="menu_button">取消</button>
                            <button type="button" id="api-config-save" class="menu_button">保存配置</button>
                        </footer>
                    </section>
                </section>
            </dialog>
        `);

        // 放在连接面板顶部，无需滑过 API 表单才能打开。
        const apiContainer = $('#openai_api');
        if (apiContainer.length) {
            apiContainer.prepend(launcher);
        } else if ($('#custom_form').length) {
            $('#custom_form').before(launcher);
        } else {
            const container = $('#extensions_settings, #extensions_settings2').first();
            if (!container.length) {
                console.error('找不到扩展设置容器，API配置管理器UI可能无法正常显示');
                return;
            }
            container.prepend(launcher);
        }
        // 脱离设置面板，防止被面板的 overflow / transform 裁切。
        $(document.body).append(modal);
        setManagerTheme(extension_settings[MODULE_NAME].theme);
        // cancel 不冒泡，直接监听以兼容浏览器原生 Esc / 关闭请求。
        modal[0].addEventListener('cancel', event => {
            event.preventDefault();
            closeConfigManager();
        });
        modal[0].addEventListener('keydown', event => {
            if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                event.stopPropagation();
                closeConfigManager();
            }
        });
    } catch (error) {
        console.error('创建UI时出错:', error);
    }
}



// 绑定事件
function bindEvents() {
    $(document).off('.apiConfigManager');

    $(document).on('click.apiConfigManager', '.api-config-open', function () {
        openConfigManager(this);
    });
    $(document).on('click.apiConfigManager', '#api-config-close', closeConfigManager);
    $(document).on('change.apiConfigManager', '#api-config-theme', function () {
        setManagerTheme(this.value, true);
    });

    // 必须从遮罩开始点击才关闭，避免在输入框中拖选文字时误关弹窗。
    let backdropPressed = false;
    $(document).on('pointerdown.apiConfigManager', '#api-config-modal', function (event) {
        backdropPressed = event.target === this;
    });
    $(document).on('click.apiConfigManager', '#api-config-modal', function (event) {
        if (event.target === this && backdropPressed) closeConfigManager();
        backdropPressed = false;
    });

    $(document).on('click.apiConfigManager', '#api-config-list-tab, #api-config-editor-tab', function () {
        showManagerView(this.id === 'api-config-editor-tab' ? 'editor' : 'list');
    });
    $(document).on('keydown.apiConfigManager', '.api-config-tabs [role="tab"]', function (event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const editor = event.key === 'End' || (event.key !== 'Home' && this.id === 'api-config-list-tab');
        showManagerView(editor ? 'editor' : 'list', false);
        document.getElementById(editor ? 'api-config-editor-tab' : 'api-config-list-tab').focus({ preventScroll: true });
    });

    $(document).on('input.apiConfigManager', '#api-config-search', function () {
        renderConfigList();
        $('#api-config-list-scroll').scrollTop(0);
    });
    $(document).on('click.apiConfigManager', '#api-config-search-clear', function () {
        $('#api-config-search').val('').trigger('input');
        document.getElementById('api-config-search').focus({ preventScroll: true });
    });

    // 键盘操作留在弹窗内；宿主另开的原生对话框优先处理自己的按键。
    $(document).on('keydown.apiConfigManager', function (event) {
        const modal = document.getElementById('api-config-modal');
        const topDialog = Array.from(document.querySelectorAll('dialog[open]')).pop();
        if (!modal || modal.hidden || (topDialog && topDialog !== modal)) return;
        if (event.isComposing || event.originalEvent?.isComposing || event.which === 229) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeConfigManager();
        } else if (event.key === 'Tab') {
            const focusable = $('#api-config-manager').find('button, input, select, textarea, a[href], [tabindex]')
                .filter(':visible:not(:disabled):not([tabindex="-1"])').toArray();
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const outside = !focusable.includes(document.activeElement);
            if (outside || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus({ preventScroll: true });
            }
        }
    });

    // 保存新配置
    $(document).on('click.apiConfigManager', '#api-config-save', saveNewConfig);

    // 取消编辑配置
    $(document).on('click.apiConfigManager', '#api-config-cancel', cancelEditConfig);

    // 获取模型列表
    $(document).on('click.apiConfigManager', '#api-config-fetch-models', fetchAvailableModels);

    // 切换来源（更新表单展示）
    $(document).on('change.apiConfigManager', '#api-config-source', function () {
        updateFormBySource($(this).val());
    });

    // 分组折叠/展开
    $(document).on('click.apiConfigManager', '.api-config-group-header', function() {
        const header = $(this);
        const groupName = header.data('group');
        const content = header.next('.api-config-group-content');
        const icon = header.find('i');

        const willBeCollapsed = content.is(':visible');

        content.toggle(!willBeCollapsed);
        header.attr('aria-expanded', String(!willBeCollapsed));
        icon.toggleClass('fa-chevron-down fa-chevron-right');

        if (!String($('#api-config-search').val() || '').trim()) {
            extension_settings[MODULE_NAME].collapsedGroups = {
                ...extension_settings[MODULE_NAME].collapsedGroups,
                [groupName]: willBeCollapsed,
            };
            saveSettingsDebounced();
        }
    });

    // 全部连接包含折叠、搜索隐藏的配置；再次点击可停止，不清空编辑草稿。
    $(document).on('click.apiConfigManager', '#api-config-connect-all', function(e) {
        e.stopPropagation();
        e.preventDefault();
        if (allConnectionsRun) {
            stopAllConnections();
        } else {
            showManagerView('list', false);
            void connectAllConfigs();
        }
    });

    $(document).on('click.apiConfigManager', '.api-config-connect', function(e) {
        e.preventDefault();
        const config = extension_settings[MODULE_NAME].configs[Number($(this).data('index'))];
        if (config) void connectConfig(config);
    });

    $(document).on('click.apiConfigManager', '.api-config-pin', function(e) {
        e.preventDefault();
        e.stopPropagation();
        toggleConfigPin(Number($(this).data('index')));
    });

    // 模型选择下拉框变化
    $(document).on('change.apiConfigManager', '#api-config-model-select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            $('#api-config-model').val(selectedModel);
        }
    });

    // 应用配置
    $(document).on('click.apiConfigManager', '.api-config-apply', async function() {
        const index = parseInt($(this).data('index'));
        const config = extension_settings[MODULE_NAME].configs[index];
        await applyConfig(config);
    });

    // 编辑配置
    $(document).on('click.apiConfigManager', '.api-config-edit', function() {
        const index = parseInt($(this).data('index'));
        editConfig(index);
    });

    // 删除配置
    $(document).on('click.apiConfigManager', '.api-config-delete', function() {
        const index = parseInt($(this).data('index'));
        deleteConfig(index);
    });

    // 回车保存配置
    $(document).on('keydown.apiConfigManager', '#api-config-editor-panel input', function(e) {
        if (e.key === 'Enter' && !e.isComposing && !e.originalEvent?.isComposing && e.which !== 229) {
            e.preventDefault();
            saveNewConfig();
        }
    });
}

// 扩展初始化函数
async function initExtension() {
    initSettings();
    await createUI();
    bindEvents();
    updateFormBySource($('#api-config-source').val());
    renderConfigList(); // 初始化时渲染配置列表

}

// SillyTavern扩展初始化
jQuery(async () => {
    // 检查是否被禁用
    if (extension_settings.disabledExtensions.includes(MODULE_NAME)) {
        return;
    }

    await initExtension();
});
