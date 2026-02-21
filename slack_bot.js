import pkg from '@slack/bolt';
const { App } = pkg;
import { SELECTORS } from './selectors.js';
import chokidar from 'chokidar';
import 'dotenv/config';
import WebSocket from 'ws';
import http from 'http';
import https from 'https';
import readline from 'readline';
import { stdin as input, stdout as output } from 'process';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const PORTS = [9222, 9000, 9001, 9002, 9003];
const CDP_CALL_TIMEOUT = 30000;
const POLLING_INTERVAL = 2000;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// State
let cdpConnection = null;
let isGenerating = false;
let lastActiveChannel = null;
let WORKSPACE_ROOT = null;
const LOG_FILE = 'slack_interaction.log';

// --- LOGGING ---
const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

function setTitle(status) {
  process.stdout.write(String.fromCharCode(27) + "]0;Antigravity Slack Bot: " + status + String.fromCharCode(7));
}

function logInteraction(type, content) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${type}] ${content}\n`;
  fs.appendFileSync(LOG_FILE, logEntry);

  let color = COLORS.reset;
  let icon = "";
  switch (type) {
    case 'INJECT': case 'SUCCESS': color = COLORS.green; icon = "✅ "; break;
    case 'ERROR': color = COLORS.red; icon = "❌ "; break;
    case 'generating': color = COLORS.yellow; icon = "🤔 "; break;
    case 'CDP': color = COLORS.cyan; icon = "🔌 "; break;
    default: color = COLORS.reset;
  }
  console.log(`${color}[${type}] ${icon}${content}${COLORS.reset}`);

  if (type === 'CDP' && content.includes('Connected')) setTitle("🟢 Connected");
  if (type === 'CDP' && content.includes('disconnected')) setTitle("🔴 Disconnected");
  if (type === 'generating') setTitle("🟡 Generating...");
  if (type === 'SUCCESS' || (type === 'INJECT' && !content.includes('failed'))) setTitle("🟢 Connected");
}

// --- ファイルダウンロード ---
function downloadFile(url, token) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const options = token ? { headers: { 'Authorization': `Bearer ${token}` } } : {};
    const parsedUrl = new URL(url);
    const reqOptions = { ...options, hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, port: parsedUrl.port };
    protocol.get(reqOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, token).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// --- CDP HELPERS ---
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function discoverCDP() {
  for (const port of PORTS) {
    try {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      console.log(`[CDP] Checking port ${port}, found ${list.length} targets.`);
      for (const t of list) {
        console.log(` - ${t.type}: ${t.title || t.url} (${t.webSocketDebuggerUrl})`);
      }
      let target = list.find(t =>
        t.type === 'page' && t.webSocketDebuggerUrl &&
        !t.title.includes('Launchpad') && !t.url.includes('workbench-jetski-agent') &&
        (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade'))
      );
      if (!target) {
        target = list.find(t =>
          t.webSocketDebuggerUrl &&
          (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade')) &&
          !t.title.includes('Launchpad')
        );
      }
      if (!target) {
        target = list.find(t =>
          t.webSocketDebuggerUrl &&
          (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade') || t.title.includes('Launchpad'))
        );
      }
      if (target && target.webSocketDebuggerUrl) {
        console.log(`[CDP] Connected to target: ${target.title} (${target.url})`);
        return { port, url: target.webSocketDebuggerUrl };
      }
    } catch (e) {
      console.log(`[CDP] Port ${port} check failed: ${e.message}`);
    }
  }
  throw new Error("CDP not found.");
}

async function connectCDP(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const contexts = [];
  let idCounter = 1;
  const pending = new Map();

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.id !== undefined && pending.has(data.id)) {
        const { resolve, reject, timeoutId } = pending.get(data.id);
        clearTimeout(timeoutId);
        pending.delete(data.id);
        if (data.error) reject(data.error); else resolve(data.result);
      }
      if (data.method === 'Runtime.executionContextCreated') contexts.push(data.params.context);
      if (data.method === 'Runtime.executionContextDestroyed') {
        const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
        if (idx !== -1) contexts.splice(idx, 1);
      }
    } catch (e) { }
  });

  const call = (method, params) => new Promise((resolve, reject) => {
    const id = idCounter++;
    const timeoutId = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("Timeout")); }
    }, CDP_CALL_TIMEOUT);
    pending.set(id, { resolve, reject, timeoutId });
    ws.send(JSON.stringify({ id, method, params }));
  });

  ws.on('close', () => {
    logInteraction('CDP', 'WebSocket disconnected.');
    if (cdpConnection && cdpConnection.ws === ws) cdpConnection = null;
  });

  await call("Runtime.enable", {});
  await call("Runtime.disable", {});
  await call("Runtime.enable", {});
  await new Promise(r => setTimeout(r, 1000));
  console.log(`[CDP] Initialized with ${contexts.length} contexts.`);
  logInteraction('CDP', `Connected to target: ${url}`);
  return { ws, call, contexts };
}

async function ensureCDP() {
  if (cdpConnection && cdpConnection.ws.readyState === WebSocket.OPEN) return cdpConnection;
  try {
    const { url } = await discoverCDP();
    cdpConnection = await connectCDP(url);
    return cdpConnection;
  } catch (e) { return null; }
}

async function ensureWatchDir() {
  if (process.env.WATCH_DIR !== undefined) {
    if (process.env.WATCH_DIR.trim() === '') { WORKSPACE_ROOT = null; return; }
    WORKSPACE_ROOT = process.env.WATCH_DIR;
    if (!fs.existsSync(WORKSPACE_ROOT)) {
      console.error(`Error: WATCH_DIR '${WORKSPACE_ROOT}' does not exist.`);
      process.exit(1);
    }
    return;
  }
  const rl = readline.createInterface({ input, output });
  console.log('\n--- 監視設定 ---');
  while (true) {
    const answer = await rl.question(`監視するフォルダのパスを入力してください（空欄で監視機能を無効化）: `);
    const folderPath = answer.trim();
    if (folderPath === '') {
      console.log('🚫 監視機能を無効化しました。');
      WORKSPACE_ROOT = null;
      try { fs.appendFileSync('.env', `\nWATCH_DIR=`); } catch (e) { console.warn('⚠️ .envへの保存に失敗しました:', e.message); }
      break;
    }
    if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
      WORKSPACE_ROOT = folderPath;
      try { fs.appendFileSync('.env', `\nWATCH_DIR=${folderPath}`); console.log(`✅ 設定を.envに保存しました: WATCH_DIR=${folderPath}`); }
      catch (e) { console.warn('⚠️ .envへの保存に失敗しました:', e.message); }
      break;
    } else { console.log('❌ 無効なパスです。存在するディレクトリを指定してください。'); }
  }
  rl.close();
}

// --- DOM SCRIPTS ---
async function injectMessage(cdp, text) {
  const safeText = JSON.stringify(text);
  const EXP = `(async () => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        function isSubmitButton(btn) {
            if (btn.disabled || btn.offsetWidth === 0) return false;
            const svg = btn.querySelector('svg');
            if (svg) {
                const cls = (svg.getAttribute('class') || '') + ' ' + (btn.getAttribute('class') || '');
                if (SELECTORS.SUBMIT_BUTTON_SVG_CLASSES.some(c => cls.includes(c))) return true;
            }
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (['send', 'run'].includes(txt)) return true;
            return false;
        }
        const doc = document;
        const editors = Array.from(doc.querySelectorAll(SELECTORS.CHAT_INPUT));
        const validEditors = editors.filter(el => el.offsetParent !== null);
        const editor = validEditors.at(-1);
        if (!editor) return { ok: false, error: "No editor found in this context" };
        editor.focus();
        let inserted = doc.execCommand("insertText", false, ${safeText});
        if (!inserted) {
            editor.textContent = ${safeText};
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: ${safeText} }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: ${safeText} }));
        }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const allButtons = Array.from(doc.querySelectorAll(SELECTORS.SUBMIT_BUTTON_CONTAINER));
        const submit = allButtons.find(isSubmitButton);
        if (submit) { submit.click(); return { ok: true, method: "click" }; }
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        return { ok: true, method: "enter" };
    })()`;

  const targetContexts = cdp.contexts.filter(c =>
    (c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) || (c.name && c.name.includes('Extension'))
  );
  const contextsToTry = targetContexts.length > 0 ? targetContexts : cdp.contexts;
  console.log(`Injecting message. Priority contexts: ${targetContexts.length}, Total: ${cdp.contexts.length}`);

  for (const ctx of contextsToTry) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
      if (res.result?.value?.ok) { logInteraction('INJECT', `Sent: ${text} (Context: ${ctx.id})`); return res.result.value; }
    } catch (e) { }
  }
  if (targetContexts.length > 0) {
    const otherContexts = cdp.contexts.filter(c => !targetContexts.includes(c));
    for (const ctx of otherContexts) {
      try {
        const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
        if (res.result?.value?.ok) { logInteraction('INJECT', `Sent: ${text} (Fallback Context: ${ctx.id})`); return res.result.value; }
      } catch (e) { }
    }
  }
  return { ok: false, error: `Injection failed. Tried ${cdp.contexts.length} contexts.` };
}

async function checkIsGenerating(cdp) {
  const EXP = `(() => {
        function findAgentFrame(win) {
             const iframes = document.querySelectorAll('iframe');
             for(let i=0; i<iframes.length; i++) {
                 if(iframes[i].src.includes('cascade-panel')) {
                     try { return iframes[i].contentDocument; } catch(e){}
                 }
             }
             return document;
        }
        const doc = findAgentFrame(window);
        const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return true;
        return false;
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value === true) return true;
    } catch (e) { }
  }
  return false;
}

async function checkApprovalRequired(cdp) {
  const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for(let i=0; i<iframes.length; i++) {
                if(iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e){}
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        if (!doc) return null;
        const approvalKeywords = [
            'run', 'approve', 'allow', 'yes', 'accept', 'confirm',
            'save', 'apply', 'create', 'update', 'delete', 'remove', 'submit', 'send', 'retry', 'continue',
            'always allow', 'allow once', 'allow this conversation',
            '実行', '許可', '承認', 'はい', '同意', '保存', '適用', '作成', '更新', '削除', '送信', '再試行', '続行'
        ];
        const anchorKeywords = ['cancel', 'reject', 'deny', 'ignore', 'キャンセル', '拒否', '無視', 'いいえ', '不許可'];
        const ignoreKeywords = ['all', 'すべて', '一括', 'auto'];
        let found = null;
        function scan(root) {
            if (found) return;
            if (!root) return;
            const potentialAnchors = Array.from(root.querySelectorAll ? root.querySelectorAll('button, [role="button"], .cursor-pointer') : []).filter(el => {
                if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
                const txt = (el.innerText || '').trim().toLowerCase();
                return anchorKeywords.some(kw => txt === kw || txt.startsWith(kw + ' '));
            });
            for (const anchor of potentialAnchors) {
                if (found) return;
                const container = anchor.closest('.flex') || anchor.parentElement;
                if (!container) continue;
                const parent = container.parentElement;
                if (!parent) continue;
                const searchScope = parent.parentElement || parent;
                const buttons = Array.from(searchScope.querySelectorAll('button, [role="button"], .cursor-pointer'));
                const approvalButton = buttons.find(btn => {
                    if (btn === anchor) return false;
                    if (btn.offsetWidth === 0) return false;
                    const txt = (btn.innerText || '').toLowerCase().trim();
                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
                    const title = (btn.getAttribute('title') || '').toLowerCase().trim();
                    const combined = txt + ' ' + aria + ' ' + title;
                    return approvalKeywords.some(kw => combined.includes(kw)) &&
                           !ignoreKeywords.some(kw => combined.includes(kw));
                });
                if (approvalButton) {
                    let textContext = "Command or Action requiring approval";
                    const itemContainer = searchScope.closest('.flex.flex-col.gap-2.border-gray-500\\\\/25') ||
                                          searchScope.closest('.group') ||
                                          searchScope.closest('.prose')?.parentElement;
                    if (itemContainer) {
                         const prose = itemContainer.querySelector('.prose');
                         const pre = itemContainer.querySelector('pre');
                         const header = itemContainer.querySelector('.text-sm.border-b') || itemContainer.querySelector('.font-semibold');
                         let msg = [];
                         if (header) msg.push(\`[Header] \${header.innerText.trim()}\`);
                         if (prose) msg.push(prose.innerText.trim());
                         if (pre) msg.push(\`[Command] \${pre.innerText.trim()}\`);
                         if (msg.length > 0) textContext = msg.join('\\n\\n');
                         else textContext = itemContainer.innerText.trim();
                    }
                    found = { required: true, message: textContext.substring(0, 1500) };
                    return;
                }
            }
            try {
                const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
                let n;
                while (n = walker.nextNode()) {
                    if (found) return;
                    if (n.shadowRoot) scan(n.shadowRoot);
                }
            } catch(e){}
        }
        scan(doc.body);
        return found;
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value?.required) return res.result.value;
    } catch (e) { }
  }
  return null;
}

async function clickApproval(cdp, allow) {
  const isAllowStr = allow ? 'true' : 'false';
  const EXP = '(async () => {' +
    'function getTargetDoc() {' +
    '  var iframes = document.querySelectorAll("iframe");' +
    '  for (var i = 0; i < iframes.length; i++) {' +
    '    if (iframes[i].src.indexOf("cascade-panel") !== -1) {' +
    '      try { return iframes[i].contentDocument; } catch(e) {}' +
    '    }' +
    '  }' +
    '  return document;' +
    '}' +
    'var doc = getTargetDoc();' +
    'var log = []; ' +
    'var approvalKeywords = ["run","approve","allow","yes","accept","confirm","save","apply","create","update","delete","remove","submit","send","retry","continue","always allow","allow once","allow this conversation","実行","許可","承認","はい","同意","保存","適用","作成","更新","削除","送信","再試行","続行"];' +
    'var cancelKeywords = ["cancel","reject","deny","ignore","no","キャンセル","拒否","無視","いいえ","中止","不許可"];' +
    'var ignoreKeywords = ["all","すべて","一括","auto"];' +
    'var isAllow = ' + isAllowStr + ';' +
    'var found = false;' +
    'function matchKeyword(combined, kw) {' +
    '  if (kw.length <= 4) {' +
    '    return combined === kw || combined.indexOf(kw) === 0 || combined.indexOf(" " + kw) !== -1;' +
    '  }' +
    '  return combined.indexOf(kw) !== -1;' +
    '}' +
    'var allButtons = Array.from(doc.body ? doc.body.querySelectorAll("button, [role=\\"button\\"], .cursor-pointer") : []);' +
    'log.push("Total buttons found: " + allButtons.length);' +
    'var anchors = allButtons.filter(function(el) {' +
    '  if (el.offsetWidth === 0) return false;' +
    '  var txt = (el.innerText || "").trim().toLowerCase();' +
    '  return cancelKeywords.some(function(kw) { return txt === kw || txt.indexOf(kw + " ") === 0; });' +
    '});' +
    'log.push("Cancel anchors found: " + anchors.length);' +
    'if (!isAllow && anchors.length > 0) {' +
    '  anchors[0].click();' +
    '  found = true;' +
    '}' +
    'if (isAllow && !found) {' +
    '  allButtons.forEach(function(btn) {' +
    '    if (btn.offsetWidth === 0) return;' +
    '    var txt = (btn.innerText || "").trim().substring(0, 60);' +
    '    log.push("Btn: " + JSON.stringify(txt));' +
    '  });' +
    '  var approvalBtns = allButtons.filter(function(btn) {' +
    '    if (btn.offsetWidth === 0) return false;' +
    '    var txt = (btn.innerText || "").toLowerCase().trim();' +
    '    if (txt.length > 30) return false;' +
    '    if (cancelKeywords.some(function(kw) { return txt === kw || txt.indexOf(kw + " ") === 0; })) return false;' +
    '    var aria = (btn.getAttribute("aria-label") || "").toLowerCase().trim();' +
    '    var title = (btn.getAttribute("title") || "").toLowerCase().trim();' +
    '    var combined = txt + " " + aria + " " + title;' +
    '    return approvalKeywords.some(function(kw) { return matchKeyword(combined, kw); }) && ' +
    '           !ignoreKeywords.some(function(kw) { return combined.indexOf(kw) !== -1; });' +
    '  });' +
    '  approvalBtns.sort(function(a, b) {' +
    '     var txtA = (a.innerText || "").toLowerCase();' +
    '     var txtB = (b.innerText || "").toLowerCase();' +
    '     var scoreA = 0; if(txtA.indexOf("allow this conversation") !== -1) scoreA = 2; else if(txtA.indexOf("always allow") !== -1) scoreA = 1;' +
    '     var scoreB = 0; if(txtB.indexOf("allow this conversation") !== -1) scoreB = 2; else if(txtB.indexOf("always allow") !== -1) scoreB = 1;' +
    '     return scoreB - scoreA;' +
    '  });' +
    '  var approvalBtn = approvalBtns[0];' +
    '  if (approvalBtn) {' +
    '    log.push("CLICKING: " + (approvalBtn.innerText || "").trim().substring(0, 30));' +
    '    approvalBtn.click();' +
    '    found = true;' +
    '  } else {' +
    '    log.push("No approval button found!");' +
    '  }' +
    '}' +
    'return { success: found, log: log };' +
    '})()';
  for (const ctx of cdp.contexts) {
    try {
      const evalPromise = cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
      const res = await Promise.race([evalPromise, timeoutPromise]);
      if (res.result?.value?.success) {
        logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (success)`);
        return res.result.value;
      }
    } catch (e) { }
  }
  logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (failed)`);
  return { success: false };
}

async function getLastResponse(cdp) {
  const EXP = `(() => {
            function getTargetDoc() {
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    if (iframes[i].src.includes('cascade-panel')) {
                        try { return iframes[i].contentDocument; } catch(e) {}
                    }
                }
                return document;
            }
            const doc = getTargetDoc();
            const candidates = Array.from(doc.querySelectorAll('[data-message-role="assistant"], .prose, .group.relative.flex.gap-3'));
            if (candidates.length === 0) return null;
            const lastMsg = candidates[candidates.length - 1];
            return { text: lastMsg.innerText, images: Array.from(lastMsg.querySelectorAll('img')).map(img => img.src) };
        })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value?.text) return res.result.value;
    } catch (e) { }
  }
  return null;
}

async function getScreenshot(cdp) {
  try {
    const result = await cdp.call("Page.captureScreenshot", { format: "png" });
    return Buffer.from(result.data, 'base64');
  } catch (e) { return null; }
}

async function stopGeneration(cdp) {
  const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e) {}
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) { cancel.click(); return { success: true }; }
        const buttons = doc.querySelectorAll('button');
        for (const btn of buttons) {
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (txt === 'stop' || txt === '停止') { btn.click(); return { success: true }; }
        }
        return { success: false, reason: 'Cancel button not found' };
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value?.success) { logInteraction('STOP', 'Generation stopped by user.'); return true; }
    } catch (e) { }
  }
  return false;
}

async function startNewChat(cdp) {
  const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e) {}
                }
            }
            return null;
        }
        const selectors = [
            '[data-tooltip-id="new-conversation-tooltip"]',
            '[data-tooltip-id*="new-chat"]', '[data-tooltip-id*="new_chat"]',
            '[aria-label*="New Chat"]', '[aria-label*="New Conversation"]'
        ];
        const docs = [document];
        const iframeDoc = getTargetDoc();
        if (iframeDoc) docs.push(iframeDoc);
        for (const doc of docs) {
            for (const sel of selectors) {
                const btn = doc.querySelector(sel);
                if (btn) { btn.click(); return { success: true, method: sel }; }
            }
        }
        return { success: false };
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value?.success) { logInteraction('NEWCHAT', 'New chat started. Method: ' + res.result.value.method); return true; }
    } catch (e) { }
  }
  return false;
}

// --- モデル管理 ---

async function getCurrentModel(cdp) {
  const EXP = `(() => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        return txt;
                    }
                }
                if (txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    if (btn.querySelector('svg')) return txt;
                }
            }
        }
        return null;
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value) return res.result.value;
    } catch (e) { }
  }
  return null;
}

async function getCurrentTitle(cdp) {
  const EXP = `(() => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        for (const doc of docs) {
            const els = doc.querySelectorAll('p.text-ide-sidebar-title-color');
            for (const el of els) {
                const txt = (el.innerText || '').trim();
                if (txt.length > 1) return txt;
            }
        }
        return null;
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value) return res.result.value;
    } catch (e) { }
  }
  return null;
}

async function getModelList(cdp) {
  const EXP = `(async () => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        let targetDoc = null;
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        btn.click(); targetDoc = doc; break;
                    }
                }
                if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    if (btn.querySelector('svg')) { btn.click(); targetDoc = doc; break; }
                }
            }
            if (targetDoc) break;
        }
        if (!targetDoc) return JSON.stringify([]);
        await new Promise(r => setTimeout(r, 1000));
        let models = [];
        const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
        for (const opt of options) {
            if (opt.className.includes('px-') || opt.className.includes('py-')) {
                 const txt = (opt.textContent || '').replace('New', '').trim();
                 if(txt.length > 3 && txt.length < 50 && (txt.toLowerCase().includes('claude') || txt.toLowerCase().includes('gemini') || txt.toLowerCase().includes('gpt') || txt.toLowerCase().includes('o1') || txt.toLowerCase().includes('o3'))) {
                     if(!models.includes(txt)) models.push(txt);
                 }
            }
        }
        const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
        if (openBtn) openBtn.click();
        return JSON.stringify(models);
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
      if (res.result?.value) {
        const models = JSON.parse(res.result.value);
        if (models.length > 0) return models;
      }
    } catch (e) { }
  }
  return [];
}

async function switchModel(cdp, targetName) {
  const SWITCH_EXP = `(async () => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        let targetDoc = null;
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        btn.click(); targetDoc = doc; break;
                    }
                }
                if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    if (btn.querySelector('svg')) { btn.click(); targetDoc = doc; break; }
                }
            }
            if (targetDoc) break;
        }
        if (!targetDoc) return JSON.stringify({ success: false, reason: 'button not found' });
        await new Promise(r => setTimeout(r, 1000));
        const target = ${JSON.stringify(targetName)}.toLowerCase();
        const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
        for (const opt of options) {
            if (opt.className.includes('px-') || opt.className.includes('py-')) {
                 const txt = (opt.textContent || '').replace('New', '').trim();
                 if (txt.toLowerCase().includes(target)) {
                     opt.click();
                     return JSON.stringify({ success: true, model: txt });
                 }
            }
        }
        const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
        if (openBtn) openBtn.click();
        return JSON.stringify({ success: false, reason: 'model not found in options list' });
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
      if (res.result?.value) {
        const result = JSON.parse(res.result.value);
        if (result.success) { logInteraction('MODEL', `Switched to: ${result.model}`); return result; }
      }
    } catch (e) { }
  }
  return { success: false, reason: 'CDP error' };
}

// --- モード管理 ---

async function getCurrentMode(cdp) {
  const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch (e) { }
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const spans = doc.querySelectorAll('span.text-xs.select-none');
        for (const s of spans) {
            const txt = (s.innerText || '').trim();
            if (txt === 'Planning' || txt === 'Fast') return txt;
        }
        return null;
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
      if (res.result?.value) return res.result.value;
    } catch (e) { }
  }
  return null;
}

async function switchMode(cdp, targetMode) {
  const SWITCH_EXP = `(async () => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch (e) { }
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const toggles = doc.querySelectorAll('div[role="button"][aria-haspopup="dialog"]');
        let clicked = false;
        for (const t of toggles) {
            const txt = (t.innerText || '').trim();
            if (txt === 'Planning' || txt === 'Fast') {
                t.querySelector('button').click();
                clicked = true;
                break;
            }
        }
        if (!clicked) return JSON.stringify({ success: false, reason: 'toggle not found' });
        await new Promise(r => setTimeout(r, 1000));
        const target = ${JSON.stringify(targetMode)};
        const dialogs = doc.querySelectorAll('div[role="dialog"]');
        for (const dialog of dialogs) {
            const txt = (dialog.innerText || '');
            if (txt.includes('Conversation mode') || txt.includes('Planning') && txt.includes('Fast')) {
                const divs = dialog.querySelectorAll('div.font-medium');
                for (const d of divs) {
                    if (d.innerText.trim().toLowerCase() === target.toLowerCase()) {
                        d.click();
                        return JSON.stringify({ success: true, mode: d.innerText.trim() });
                    }
                }
            }
        }
        return JSON.stringify({ success: false, reason: 'mode not found in dialog' });
    })()`;
  for (const ctx of cdp.contexts) {
    try {
      const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
      if (res.result?.value) {
        const result = JSON.parse(res.result.value);
        if (result.success) { logInteraction('MODE', `Switched to: ${result.mode}`); return result; }
      }
    } catch (e) { }
  }
  return { success: false, reason: 'CDP error' };
}

// --- FILE WATCHER ---
function setupFileWatcher() {
  if (!WORKSPACE_ROOT) {
    console.log('🚫 File watching is disabled.');
    return;
  }
  const watcher = chokidar.watch(WORKSPACE_ROOT, { ignored: [/node_modules/, /\.git/, /slack_interaction\.log$/], persistent: true, ignoreInitial: true, awaitWriteFinish: true });
  watcher.on('all', async (event, filePath) => {
    if (!lastActiveChannel) return;
    try {
      if (event === 'unlink') {
        await app.client.chat.postMessage({ token: process.env.SLACK_BOT_TOKEN, channel: lastActiveChannel, text: `🗑️ *File Deleted:* \`${path.basename(filePath)}\`` });
      } else if (event === 'add' || event === 'change') {
        const stats = fs.statSync(filePath);
        if (stats.size > 8 * 1024 * 1024) return;
        await app.client.files.uploadV2({ token: process.env.SLACK_BOT_TOKEN, channel_id: lastActiveChannel, file: fs.createReadStream(filePath), filename: path.basename(filePath), initial_comment: `📁 *File ${event === 'add' ? 'Created' : 'Updated'}:* \`${path.basename(filePath)}\`` });
      }
    } catch (e) { console.error('[FileWatcher] Error sending to Slack:', e.message); }
  });
}

// --- MONITOR LOOP ---
let lastApprovalMessage = null;
// Store pending approval resolvers keyed by message timestamp
const pendingApprovals = new Map();

async function monitorAIResponse(channel, threadTs, cdp) {
  if (isGenerating) return;
  isGenerating = true;
  let stableCount = 0;
  lastApprovalMessage = null;

  await new Promise(r => setTimeout(r, 3000));

  const poll = async () => {
    try {
      const approval = await checkApprovalRequired(cdp);
      if (approval) {
        if (lastApprovalMessage === approval.message) { setTimeout(poll, POLLING_INTERVAL); return; }
        await new Promise(r => setTimeout(r, 3000));
        const stillRequiresApproval = await checkApprovalRequired(cdp);
        if (!stillRequiresApproval) { console.log("Approval button disappeared during grace period."); setTimeout(poll, POLLING_INTERVAL); return; }
        if (lastApprovalMessage === approval.message) { setTimeout(poll, POLLING_INTERVAL); return; }

        lastApprovalMessage = approval.message;

        const blocks = [
          { type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Approval Required*\n\`\`\`${approval.message}\`\`\`` } },
          {
            type: 'actions', block_id: 'approval_actions', elements: [
              { type: 'button', text: { type: 'plain_text', text: '✅ Approve / Run' }, style: 'primary', action_id: 'approve_action' },
              { type: 'button', text: { type: 'plain_text', text: '❌ Reject / Cancel' }, style: 'danger', action_id: 'reject_action' },
            ]
          }
        ];

        const result = await app.client.chat.postMessage({ token: process.env.SLACK_BOT_TOKEN, channel, thread_ts: threadTs, blocks, text: '⚠️ Approval Required' });
        logInteraction('APPROVAL', `Request sent to Slack: ${approval.message.substring(0, 50)}...`);

        // Store resolver for this approval message
        const approvalPromise = new Promise((resolve) => {
          pendingApprovals.set(result.ts, { resolve, channel, cdp, poll, threadTs });
        });

        // Set timeout for approval
        const timeoutId = setTimeout(() => {
          if (pendingApprovals.has(result.ts)) {
            pendingApprovals.delete(result.ts);
            app.client.chat.update({ token: process.env.SLACK_BOT_TOKEN, channel, ts: result.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ Approval timed out.' } }], text: '⚠️ Approval timed out.' }).catch(() => { });
            lastApprovalMessage = null;
            setTimeout(poll, POLLING_INTERVAL);
          }
        }, 60000);

        const approvalResult = await approvalPromise;
        clearTimeout(timeoutId);

        const allow = approvalResult === 'approve';
        await clickApproval(cdp, allow);
        await app.client.chat.update({ token: process.env.SLACK_BOT_TOKEN, channel, ts: result.ts, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${blocks[0].text.text}\n\n${allow ? '✅ *Approved*' : '❌ *Rejected*'}` } }], text: allow ? '✅ Approved' : '❌ Rejected' });
        logInteraction('ACTION', `User ${allow ? 'Approved' : 'Rejected'} the request.`);

        for (let j = 0; j < 15; j++) {
          if (!(await checkApprovalRequired(cdp))) break;
          await new Promise(r => setTimeout(r, 500));
        }
        lastApprovalMessage = null;
        setTimeout(poll, POLLING_INTERVAL);
        return;
      }

      const generating = await checkIsGenerating(cdp);
      if (!generating) {
        stableCount++;
        if (stableCount >= 3) {
          isGenerating = false;
          const response = await getLastResponse(cdp);
          if (response) {
            const chunks = response.text.match(/[\s\S]{1,3900}/g) || [response.text];
            await app.client.chat.postMessage({ token: process.env.SLACK_BOT_TOKEN, channel, thread_ts: threadTs, text: `🤖 *AI Response:*\n${chunks[0]}` });
            for (let i = 1; i < chunks.length; i++) {
              await app.client.chat.postMessage({ token: process.env.SLACK_BOT_TOKEN, channel, thread_ts: threadTs, text: chunks[i] });
            }
          }
          return;
        }
      } else { stableCount = 0; }
      setTimeout(poll, POLLING_INTERVAL);
    } catch (e) { console.error("Poll error:", e); isGenerating = false; }
  };
  setTimeout(poll, POLLING_INTERVAL);
}

// --- SLACK ACTION HANDLERS ---
app.action('approve_action', async ({ ack, body }) => {
  await ack();
  const msgTs = body.message.ts;
  if (pendingApprovals.has(msgTs)) {
    const { resolve } = pendingApprovals.get(msgTs);
    pendingApprovals.delete(msgTs);
    resolve('approve');
  }
});

app.action('reject_action', async ({ ack, body }) => {
  await ack();
  const msgTs = body.message.ts;
  if (pendingApprovals.has(msgTs)) {
    const { resolve } = pendingApprovals.get(msgTs);
    pendingApprovals.delete(msgTs);
    resolve('reject');
  }
});

// --- SLACK SLASH COMMANDS ---
app.command('/ag-help', async ({ ack, respond }) => {
  await ack();
  await respond(
    `📖 *Antigravity Bot コマンド一覧*\n\n` +
    `💬 *テキスト送信* — ボットへのDMまたはメンションで送信\n` +
    `📎 *ファイル添付* — 画像・ファイルを添付して送信\n\n` +
    `🖼️ \`/ag-screenshot\` — スクリーンショット取得\n` +
    `⏹️ \`/ag-stop\` — 生成を停止\n` +
    `🆕 \`/ag-newchat\` — 新規チャット作成\n` +
    `📊 \`/ag-status\` — 現在のモデル・モード表示\n` +
    `📝 \`/ag-title\` — チャットタイトル表示\n` +
    `🤖 \`/ag-model\` — モデル一覧表示\n` +
    `🤖 \`/ag-model <番号>\` — モデル切替\n` +
    `📋 \`/ag-mode\` — 現在のモード表示\n` +
    `📋 \`/ag-mode <planning|fast>\` — モード切替`
  );
});

app.command('/ag-screenshot', async ({ ack, respond, command }) => {
  await ack();
  const cdp = await ensureCDP();
  if (!cdp) return respond('❌ CDP not found. Is Antigravity running?');
  const ss = await getScreenshot(cdp);
  if (!ss) return respond('❌ Failed to capture screenshot.');
  await app.client.files.uploadV2({ token: process.env.SLACK_BOT_TOKEN, channel_id: command.channel_id, file: ss, filename: 'screenshot.png', initial_comment: '🖼️ Screenshot' });
});

app.command('/ag-stop', async ({ ack, respond }) => {
  await ack();
  const cdp = await ensureCDP();
  if (!cdp) return respond('❌ CDP not found. Is Antigravity running?');
  const stopped = await stopGeneration(cdp);
  if (stopped) { isGenerating = false; await respond('⏹️ 生成を停止しました。'); }
  else { await respond('⚠️ 現在生成中ではありません。'); }
});

app.command('/ag-newchat', async ({ ack, respond }) => {
  await ack();
  const cdp = await ensureCDP();
  if (!cdp) return respond('❌ CDP not found. Is Antigravity running?');
  const started = await startNewChat(cdp);
  if (started) { isGenerating = false; await respond('🆕 新規チャットを開始しました。'); }
  else { await respond('⚠️ New Chatボタンが見つかりませんでした。'); }
});

app.command('/ag-title', async ({ ack, respond }) => {
  await ack();
  const cdp = await ensureCDP();
  if (!cdp) return respond('❌ CDP not found. Is Antigravity running?');
  const title = await getCurrentTitle(cdp);
  await respond(`📝 *チャットタイトル:* ${title || '不明'}`);
});

app.command('/ag-status', async ({ ack, respond }) => {
  await ack();
  const cdp = await ensureCDP();
  if (!cdp) return respond('❌ CDP not found. Is Antigravity running?');
  const model = await getCurrentModel(cdp);
  const mode = await getCurrentMode(cdp);
  await respond(`🤖 *モデル:* ${model || '不明'}\n📋 *モード:* ${mode || '不明'}`);
});

app.command('/ag-model', async ({ ack, respond, command }) => {
  await ack();
  const cdp = await ensureCDP();
  if (!cdp) return respond('❌ CDP not found. Is Antigravity running?');
  const args = (command.text || '').trim();

  if (!args) {
    const current = await getCurrentModel(cdp);
    const models = await getModelList(cdp);
    if (models.length === 0) return respond('⚠️ モデル一覧を取得できませんでした。');
    const list = models.map((m, i) => `${m === current ? '▶' : '　'} *${i + 1}.* ${m}`).join('\n');
    return respond(`🤖 *現在のモデル:* ${current || '不明'}\n\n${list}\n\n_切替: \`/ag-model <番号>\`_`);
  }

  const num = parseInt(args, 10);
  if (isNaN(num) || num < 1) return respond('⚠️ 番号は1以上の数値を指定してください。');
  const models = await getModelList(cdp);
  if (num > models.length) return respond(`⚠️ 番号は1〜${models.length}で指定してください。`);
  const result = await switchModel(cdp, models[num - 1]);
  if (result.success) return respond(`✅ *${result.model}* に切り替えました`);
  return respond(`⚠️ 切替に失敗しました: ${result.reason}`);
});

app.command('/ag-mode', async ({ ack, respond, command }) => {
  await ack();
  const cdp = await ensureCDP();
  if (!cdp) return respond('❌ CDP not found. Is Antigravity running?');
  const args = (command.text || '').trim().toLowerCase();

  if (!args) {
    const mode = await getCurrentMode(cdp);
    return respond(`📋 *現在のモード:* ${mode || '不明'}\n\n_切替: \`/ag-mode <planning|fast>\`_`);
  }

  if (args !== 'planning' && args !== 'fast') return respond('⚠️ planning または fast を指定してください。');
  const result = await switchMode(cdp, args);
  if (result.success) return respond(`✅ モード: *${result.mode}* に切り替えました`);
  return respond(`⚠️ モード切替に失敗しました: ${result.reason}`);
});

// --- SLACK MESSAGE EVENT ---
app.message(async ({ message, say }) => {
  // bot自身のメッセージやsubtypeを無視
  if (message.subtype) return;
  if (message.bot_id) return;

  // 許可ユーザーチェック
  if (process.env.SLACK_ALLOWED_USER_ID && message.user !== process.env.SLACK_ALLOWED_USER_ID) return;

  lastActiveChannel = message.channel;

  const cdp = await ensureCDP();
  if (!cdp) { await say('❌ CDP not found. Is Antigravity running?'); return; }

  let messageText = message.text || '';

  // Slackメンションタグ <@USERID> を除去
  messageText = messageText.replace(/<@[A-Z0-9]+>/g, '').trim();

  // ファイル添付処理
  if (message.files && message.files.length > 0 && WORKSPACE_ROOT) {
    const uploadDir = path.join(WORKSPACE_ROOT, 'slack_uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const downloadedFiles = [];
    for (const file of message.files) {
      try {
        const fileName = `${Date.now()}_${file.name}`;
        const filePath = path.join(uploadDir, fileName);
        const fileData = await downloadFile(file.url_private, process.env.SLACK_BOT_TOKEN);
        fs.writeFileSync(filePath, fileData);
        downloadedFiles.push({ name: file.name, path: filePath });
        logInteraction('UPLOAD', `Downloaded: ${file.name} -> ${filePath}`);
      } catch (e) {
        logInteraction('UPLOAD_ERROR', `Failed to download ${file.name}: ${e.message}`);
      }
    }

    if (downloadedFiles.length > 0) {
      const fileInfo = downloadedFiles.map(f => `[添付ファイル: ${f.name}] パス: ${f.path}`).join('\n');
      messageText = messageText ? `${messageText}\n\n${fileInfo}` : fileInfo;
      await app.client.reactions.add({ token: process.env.SLACK_BOT_TOKEN, channel: message.channel, name: 'paperclip', timestamp: message.ts }).catch(() => { });
    }
  }

  if (!messageText) return;

  // スラッシュで始まるメッセージは無視
  if (messageText.startsWith('/')) return;

  const res = await injectMessage(cdp, messageText);
  if (res.ok) {
    await app.client.reactions.add({ token: process.env.SLACK_BOT_TOKEN, channel: message.channel, name: 'white_check_mark', timestamp: message.ts }).catch(() => { });
    monitorAIResponse(message.channel, message.ts, cdp);
  } else {
    await app.client.reactions.add({ token: process.env.SLACK_BOT_TOKEN, channel: message.channel, name: 'x', timestamp: message.ts }).catch(() => { });
    if (res.error) await say(`Error: ${res.error}`);
  }
});

// --- MAIN EXECUTION ---
(async () => {
  try {
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
      throw new Error("❌ SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required in .env");
    }
    await ensureWatchDir();
    console.log(`📂 Watching directory: ${WORKSPACE_ROOT}`);

    await app.start();
    console.log('⚡️ Antigravity Slack Bot is running!');

    setupFileWatcher();
    ensureCDP().then(res => {
      if (res) console.log("✅ Auto-connected to Antigravity on startup.");
      else console.log("❌ Could not auto-connect to Antigravity on startup.");
    });
  } catch (e) {
    console.error('Fatal Error:', e);
    process.exit(1);
  }
})();
