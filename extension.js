const vscode = require('vscode');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, execFile } = require('child_process');

let output = null;
let child = null;
let url = null;
let currentPort = null;
let starting = null;
let panel = null;
let tree = null;
let chatProvider = null;
let proxySrv = null;
let proxyPortNum = 0;
let authCookieStr = null;

function log(line) {
    if (!output) output = vscode.window.createOutputChannel('dsh-vscode-ok');
    const stamp = new Date().toTimeString().slice(0, 8);
    output.appendLine('[' + stamp + '] ' + line);
}

function refreshTree() {
    if (tree) tree.refresh();
}

function candidateExecutables() {
    const configured = vscode.workspace.getConfiguration('dsh').get('executable');
    const list = [];
    if (configured) list.push(configured);

    const local = process.env.LOCALAPPDATA || '';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    list.push(path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    list.push(path.join(pf, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    list.push('D:\\Software-2\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd');

    return list.filter(function (p) {
        try { return !!p && fs.existsSync(p); } catch (e) { return false; }
    });
}

function workspaceCwd() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : undefined;
}

function portFree(port) {
    return new Promise(function (resolve) {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', function () { resolve(false); });
        srv.once('listening', function () { srv.close(function () { resolve(true); }); });
        srv.listen(port, '127.0.0.1');
    });
}

async function pickPort(preferred, autoPort) {
    if (preferred === 0) return 0;
    if (await portFree(preferred)) return preferred;
    if (!autoPort) throw new Error('端口 ' + preferred + ' 被占用。关掉占用它的进程，或在设置里改 dsh.port');

    for (let p = preferred + 1; p <= preferred + 20 && p < 65535; p++) {
        if (await portFree(p)) {
            log('port ' + preferred + ' busy, fallback to ' + p);
            return p;
        }
    }
    throw new Error('从 ' + preferred + ' 起找不到空闲端口');
}

function quote(s) {
    return /\s/.test(s) ? '"' + s + '"' : s;
}

function doStart() {
    return new Promise(async function (resolve, reject) {
        let port;
        try {
            const cfg = vscode.workspace.getConfiguration('dsh');
            port = await pickPort(cfg.get('port') === undefined ? 3081 : cfg.get('port'), cfg.get('autoPort'));

            const found = candidateExecutables();
            if (!found.length) throw new Error('找不到 dsh.cmd，请在设置 dsh.executable 里填写完整路径');

            const exe = found[0];
            const extra = vscode.workspace.getConfiguration('dsh').get('executableArgs') || [];
            const home = cfg.get('dshHome');
            const timeout = cfg.get('startTimeoutMs') || 120000;
            const cwd = workspaceCwd();

            const command = [quote(exe)].concat(extra.map(quote)).concat(['web', '--no-open', '--port', String(port)]).join(' ');
            log('launch: ' + command + (cwd ? ' (cwd=' + cwd + ')' : ''));

            const env = Object.assign({}, process.env);
            if (home) env.DSH_HOME = home;

            const proc = spawn(command, {
                cwd: cwd,
                env: env,
                windowsHide: true,
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            child = proc;
            currentPort = port;

            let buf = '';
            let settled = false;

            const timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error('后端在 ' + Math.round(timeout / 1000) + ' 秒内没有打印访问地址，看输出通道 dsh-vscode-ok 的日志'));
            }, timeout);

            function handle(chunk) {
                const text = chunk.toString();
                buf += text;
                text.split('\n').forEach(function (l) { l = l.split(String.fromCharCode(13)).join(''); if (l) log('  ' + l); });

                const m = /dsh web:\s*(https?:\/\/[^\s?]+)\/?\?token=([A-Za-z0-9_-]+)/.exec(buf);
                if (m && !settled) {
                    settled = true;
                    clearTimeout(timer);
                    let origin = m[1];
                    while (origin.endsWith('/')) origin = origin.substring(0, origin.length - 1);
                    url = origin + '/?token=' + m[2];
                    const hostPart = origin.split('//').pop();
                    const realPort = Number(hostPart.slice(hostPart.lastIndexOf(':') + 1));
                    currentPort = Number.isFinite(realPort) && realPort > 0 ? realPort : port;
                    log('ready: ' + origin + '/?token=***');
                    refreshTree();
                    resolve(url);
                }
            }

            proc.stdout.on('data', handle);
            proc.stderr.on('data', handle);

            proc.on('exit', function (code) {
                log('backend exited: ' + code);
                if (child === proc) {
                    child = null;
                    url = null;
                    currentPort = null;
                }
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(new Error('后端退出，退出码 ' + code + '。看输出通道 dsh-vscode-ok 的日志'));
                }
                refreshTree();
            });
        } catch (e) {
            reject(e);
        }
    });
}

async function startBackend() {
    if (url && child) return url;
    if (starting) return starting;
    starting = doStart().finally(function () { starting = null; });
    return starting;
}

async function ensureBackend() {
    try {
        await startBackend();
    } catch (e) {
        log('background start failed: ' + e.message);
    }
}

function stopBackend(quiet) {
    if (!child) {
        if (!quiet) vscode.window.showInformationMessage('dsh 后端未在运行');
        return;
    }
    const pid = child.pid;
    try {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], function () { });
    } catch (e) {
        log('taskkill failed: ' + e.message);
    }
    child = null;
    url = null;
    currentPort = null;
    stopProxy();
    authCookieStr = null;
    log('stopped pid ' + pid);
    refreshTree();
}

// webview 的 iframe 属于第三方上下文，后端下发的 Set-Cookie 会被丢弃，
// 跳转后的请求就变成 401「authentication required」。
// 因此由扩展持有 cookie，本机反代只负责把请求原样转发并注入认证。
function fetchAuthCookie(target) {
    return new Promise(function (resolve, reject) {
        const u = new URL(target);
        const req = http.get({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search
        }, function (res) {
            res.resume();
            const set = res.headers['set-cookie'] || [];
            if (set.length) {
                resolve(set.map(function (c) { return c.split(';')[0]; }).join('; '));
            } else {
                reject(new Error('登录响应未携带 Set-Cookie（status ' + res.statusCode + '）'));
            }
        });
        req.on('error', reject);
    });
}

function stopProxy() {
    if (proxySrv) {
        try { proxySrv.close(); } catch (e) { }
        proxySrv = null;
        proxyPortNum = 0;
    }
}

function startProxy(backendUrl, cookie) {
    return new Promise(function (resolve, reject) {
        stopProxy();
        const state = { cookie: cookie, backend: backendUrl };
        const u = new URL(backendUrl);
        const authority = u.host;

        function cleanHeaders(src) {
            const h = Object.assign({}, src);
            delete h.host;
            delete h.origin;
            delete h.referer;
            delete h.cookie;
            h.host = authority;
            h.cookie = state.cookie;
            return h;
        }

        function forward(req, res, retried) {
            const up = http.request({
                hostname: u.hostname,
                port: u.port,
                path: req.url,
                method: req.method,
                headers: cleanHeaders(req.headers)
            }, function (ures) {
                if (ures.statusCode === 401 && !retried && req.method === 'GET') {
                    ures.resume();
                    fetchAuthCookie(state.backend).then(function (c) {
                        state.cookie = c;
                        log('proxy: 会话已续期');
                        forward(req, res, true);
                    }).catch(function (e) {
                        log('proxy renew failed: ' + e.message);
                        try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('dsh 代理续期失败：' + e.message); } catch (_) { }
                    });
                    return;
                }
                const out = Object.assign({}, ures.headers);
                delete out['set-cookie'];
                res.writeHead(ures.statusCode || 502, out);
                ures.pipe(res);
            });
            up.on('error', function (e) {
                log('proxy forward error: ' + e.message);
                try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('dsh 代理请求失败：' + e.message); } catch (_) { }
            });
            req.pipe(up);
        }

        function forwardUpgrade(cReq, cSock, cHead) {
            const up = http.request({
                hostname: u.hostname,
                port: u.port,
                path: cReq.url,
                headers: cleanHeaders(cReq.headers)
            });
            up.on('upgrade', function (ures, usock, uhead) {
                const lines = ['HTTP/1.1 101 Switching Protocols'];
                Object.keys(ures.headers).forEach(function (k) {
                    lines.push(k + ': ' + ures.headers[k]);
                });
                cSock.write(lines.join('\r\n') + '\r\n\r\n');
                if (uhead && uhead.length) cSock.write(uhead);
                usock.pipe(cSock);
                cSock.pipe(usock);
                cSock.on('error', function () { usock.destroy(); });
                usock.on('error', function () { cSock.destroy(); });
            });
            up.on('error', function () { cSock.destroy(); });
            if (cHead && cHead.length) up.write(cHead);
            up.end();
            cSock.on('error', function () { });
        }

        const srv = http.createServer(function (req, res) { forward(req, res, false); });
        srv.on('upgrade', forwardUpgrade);
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', function () {
            proxySrv = srv;
            proxyPortNum = srv.address().port;
            log('proxy listening on 127.0.0.1:' + proxyPortNum);
            resolve(proxyPortNum);
        });
    });
}

function showPanel(target) {
    if (panel) panel.dispose();

    panel = vscode.window.createWebviewPanel('dsh.chat', 'DeepSeek Harness', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true
    });

    const origin = new URL(target).origin;
    panel.webview.html = [
        '<!DOCTYPE html><html><head><meta charset="utf-8">',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src ' + origin + '; style-src \'unsafe-inline\';">',
        '<style>html,body{height:100%;margin:0;padding:0;background:var(--vscode-editor-background)}',
        'iframe{border:0;width:100%;height:100vh;display:block}</style></head>',
        '<body><iframe src="' + target + '" allow="clipboard-read; clipboard-write"></iframe></body></html>'
    ].join('');

    panel.onDidDispose(function () { panel = null; });
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RETRY_SCRIPT = '<script>(function(){var api=acquireVsCodeApi();' +
    'document.getElementById("retry").addEventListener("click",function(){api.postMessage({type:"retry"});});})();</script>';

function renderStatus(message, retryable) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
        '<style>body{margin:0;padding:16px;font-family:var(--vscode-font-family);font-size:12px;line-height:1.7;color:var(--vscode-foreground)}' +
        'button{margin-top:14px;padding:4px 12px;font-size:12px;border:0;border-radius:2px;cursor:pointer;' +
        'color:var(--vscode-button-foreground);background:var(--vscode-button-background)}' +
        'button:hover{background:var(--vscode-button-hoverBackground)}</style>' +
        '</head><body>' + escapeHtml(message || '').split('\n').join('<br>') +
        (retryable ? '<div><button id="retry">重新加载</button></div>' + RETRY_SCRIPT : '') +
        '</body></html>';
}

function renderFrame(target) {
    const origin = new URL(target).origin;
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src ' + origin + '; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
        '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--vscode-editor-background)}' +
        'iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}' +
        '#bar{position:absolute;top:6px;right:6px;z-index:9}' +
        '#bar button{width:22px;height:22px;border:0;border-radius:4px;cursor:pointer;opacity:.5;font-size:13px;line-height:1;' +
        'color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}' +
        '#bar button:hover{opacity:1}</style></head>' +
        '<body><iframe src="' + target + '" allow="clipboard-read; clipboard-write"></iframe>' +
        '<div id="bar"><button id="retry" title="重新加载界面">↻</button></div>' +
        RETRY_SCRIPT + '</body></html>';
}

class ChatViewProvider {
    constructor() {
        this.view = null;
    }

    attach(webviewView) {
        const self = this;
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.onDidReceiveMessage(function (msg) {
            if (msg && msg.type === 'retry') self.render();
        });
        webviewView.onDidDispose(function () { self.view = null; });
    }

    async render() {
        if (!this.view) return;
        this.view.webview.html = renderStatus('正在启动 dsh 后端，首次启动需要十几秒…', false);

        let target;
        try {
            target = await startBackend();
        } catch (e) {
            if (!this.view) return;
            log('sidebar load failed: ' + e.message);
            this.view.webview.html = renderStatus('后端启动失败：' + e.message + '\n\n可点下面重试，或查看输出通道 dsh-vscode-ok 的日志。', true);
            return;
        }

        try {
            if (!authCookieStr) authCookieStr = await fetchAuthCookie(target);
            await startProxy(target, authCookieStr);
        } catch (e) {
            if (!this.view) return;
            log('proxy setup failed: ' + e.message);
            this.view.webview.html = renderStatus('本地代理建立失败：' + e.message + '\n\n可点下面重试。', true);
            return;
        }

        if (!this.view) return;
        this.view.webview.html = renderFrame('http://127.0.0.1:' + proxyPortNum + '/');
    }

    async resolveWebviewView(webviewView) {
        this.attach(webviewView);
        await this.render();
    }

    async reload() {
        await this.render();
    }
}

async function focusSidebar() {
    const all = await vscode.commands.getCommands(true);

    if (all.indexOf('dsh.chatView.focus') >= 0) {
        await vscode.commands.executeCommand('dsh.chatView.focus');
        return true;
    }
    if (all.indexOf('workbench.view.extension.dshSidebar') >= 0) {
        await vscode.commands.executeCommand('workbench.view.extension.dshSidebar');
        return true;
    }

    const related = all.filter(function (c) { return c.toLowerCase().indexOf('dsh') >= 0; });
    log('找不到侧边栏命令，当前 dsh 相关命令：' + related.join(', '));
    return false;
}

async function openInterface(mode) {
    const placement = mode || vscode.workspace.getConfiguration('dsh').get('placement') || 'sidebar';

    if (placement === 'sidebar') {
        try {
            if (await focusSidebar()) return;
        } catch (e) {
            log('focus sidebar failed: ' + e.message);
        }
        log('sidebar view 未注册，回退到编辑器打开');
        vscode.window.showWarningMessage('侧边栏视图未注册，已改用编辑器标签页打开');
        return openInterface('editor');
    }

    try {
        const target = await startBackend();
        const useTab = vscode.workspace.getConfiguration('dsh').get('useEditorTab');

        if (useTab) {
            try {
                await vscode.commands.executeCommand('simpleBrowser.show', target);
                return;
            } catch (e) {
                log('simpleBrowser 不可用，改用 webview 面板：' + e.message);
            }
        }
        showPanel(target);
    } catch (e) {
        log('open failed: ' + e.message);
        vscode.window.showErrorMessage('dsh 启动失败：' + e.message);
    }
}

class StatusTree {
    constructor() {
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
    }

    refresh() {
        this.emitter.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren() {
        const running = !!(child && url);
        const items = [];

        const state = new vscode.TreeItem(running ? '运行中' : '未运行', vscode.TreeItemCollapsibleState.None);
        state.iconPath = running
            ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('circle-outline');
        state.description = running && currentPort ? ('端口 ' + currentPort) : '';
        state.tooltip = running ? '后端已就绪，可以打开界面' : '点下面的“打开界面”会自动启动后端';
        items.push(state);

        if (running) {
            const host = new vscode.TreeItem('127.0.0.1:' + currentPort, vscode.TreeItemCollapsibleState.None);
            host.iconPath = new vscode.ThemeIcon('plug');
            host.tooltip = '只监听本机回环地址，外部无法访问';
            items.push(host);
        }

        const open = new vscode.TreeItem('打开界面', vscode.TreeItemCollapsibleState.None);
        open.command = { command: 'dsh.openChat', title: '打开界面' };
        open.iconPath = new vscode.ThemeIcon('link-external');
        open.tooltip = '在编辑器标签页里打开 DeepSeek Harness 官方界面';
        items.push(open);

        const browser = new vscode.TreeItem('在外部浏览器打开', vscode.TreeItemCollapsibleState.None);
        browser.command = { command: 'dsh.openInBrowser', title: '在外部浏览器打开' };
        browser.iconPath = new vscode.ThemeIcon('globe');
        items.push(browser);

        const copy = new vscode.TreeItem('复制访问地址', vscode.TreeItemCollapsibleState.None);
        copy.command = { command: 'dsh.copyUrl', title: '复制访问地址' };
        copy.iconPath = new vscode.ThemeIcon('copy');
        items.push(copy);

        const logs = new vscode.TreeItem('查看日志', vscode.TreeItemCollapsibleState.None);
        logs.command = { command: 'dsh.showLogs', title: '查看日志' };
        logs.iconPath = new vscode.ThemeIcon('output');
        items.push(logs);

        return items;
    }
}

function activate(context) {
    output = vscode.window.createOutputChannel('dsh-vscode-ok');
    context.subscriptions.push(output);

    tree = new StatusTree();
    chatProvider = new ChatViewProvider();

    if (vscode.workspace.getConfiguration('dsh').get('autoStart')) ensureBackend();
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('dsh.chatView', chatProvider, {
        webviewOptions: { retainContextWhenHidden: true }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dsh.openInSidebar', function () { return openInterface('sidebar'); }));
    context.subscriptions.push(vscode.commands.registerCommand('dsh.openInEditor', function () { return openInterface('editor'); }));
    context.subscriptions.push(vscode.commands.registerCommand('dsh.openChat', function () { return openInterface(); }));
    context.subscriptions.push(vscode.commands.registerCommand('dsh.focusChat', function () { return openInterface(); }));
    context.subscriptions.push(vscode.commands.registerCommand('dsh.newChat', function () { return openInterface(); }));

    context.subscriptions.push(vscode.commands.registerCommand('dsh.startBackend', async function () {
        try {
            const target = await startBackend();
            const host = new URL(target).host;
            vscode.window.showInformationMessage('dsh 后端已就绪：' + host);
        } catch (e) {
            vscode.window.showErrorMessage('dsh 启动失败：' + e.message);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dsh.restartBackend', async function () {
        stopBackend(true);
        if (chatProvider && chatProvider.view) await chatProvider.reload();
        await openInterface();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dsh.stopBackend', function () { stopBackend(false); }));

    context.subscriptions.push(vscode.commands.registerCommand('dsh.showLogs', function () {
        output.show(true);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dsh.openInBrowser', async function () {
        try {
            const target = await startBackend();
            await vscode.env.openExternal(vscode.Uri.parse(target));
        } catch (e) {
            vscode.window.showErrorMessage('dsh 启动失败：' + e.message);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('dsh.copyUrl', async function () {
        try {
            const target = await startBackend();
            await vscode.env.clipboard.writeText(target);
            vscode.window.showInformationMessage('访问地址已复制，含一次性 token，别贴到公开渠道');
        } catch (e) {
            vscode.window.showErrorMessage('dsh 启动失败：' + e.message);
        }
    }));

    log('dsh-vscode-ok 0.4.0 已激活，聊天界面位于次级侧边栏');
}

function deactivate() {
    stopProxy();
    if (child) {
        try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], function () { }); } catch (e) { }
    }
}

module.exports = { activate: activate, deactivate: deactivate };
