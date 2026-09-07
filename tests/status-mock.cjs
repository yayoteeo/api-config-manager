// Node / 浏览器共用的只读连接模拟器。没有任何真实网络请求或真实凭据。
function createStatusMock() {
    const mock = { calls: [], replies: [], unexpected: [], active: 0, maxActive: 0, hold: false };
    mock.fetch = (url, options = {}) => {
        if (url !== '/api/backends/chat-completions/status') {
            mock.unexpected.push(url);
            return Promise.reject(new Error('Non-status request blocked by fixture'));
        }
        const reply = mock.replies.shift() || {};
        const call = { url, options, body: JSON.parse(options.body), settled: false, aborted: false };
        mock.calls.push(call);
        mock.maxActive = Math.max(mock.maxActive, ++mock.active);
        return new Promise((resolve, reject) => {
            const finish = (callback, value) => {
                if (call.settled) return;
                call.settled = true;
                mock.active--;
                options.signal?.removeEventListener('abort', abort);
                callback(value);
            };
            const abort = () => {
                call.aborted = true;
                finish(reject, new DOMException('Fixture aborted', 'AbortError'));
            };
            call.release = (result = reply) => {
                if (call.settled) return;
                if (result.networkError) return finish(reject, new Error(result.networkError));
                const body = Object.hasOwn(result, 'body') ? result.body : { data: [{ id: 'fixture-model' }] };
                finish(resolve, new Response(result.raw ?? JSON.stringify(body), {
                    status: result.status ?? 200, headers: { 'Content-Type': 'application/json' },
                }));
            };
            options.signal?.addEventListener('abort', abort, { once: true });
            if (options.signal?.aborted) abort();
            else if (!mock.hold) queueMicrotask(() => call.release());
        });
    };
    mock.releaseAll = () => mock.calls.filter(call => !call.settled).forEach(call => call.release());
    return mock;
}

module.exports = createStatusMock;
