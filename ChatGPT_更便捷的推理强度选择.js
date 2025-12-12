// ==UserScript==
// @name         （只适用于Pro）ChatGPT 更便捷的推理强度选择（min/max）
// @namespace    https://github.com/lueluelue2006/ChatGPT-Reasoning-Effort-Toggle
// @version      0.4.1
// @downloadURL  https://raw.githubusercontent.com/lueluelue2006/ChatGPT-Reasoning-Effort-Toggle/main/ChatGPT_%E6%9B%B4%E4%BE%BF%E6%8D%B7%E7%9A%84%E6%8E%A8%E7%90%86%E5%BC%BA%E5%BA%A6%E9%80%89%E6%8B%A9.js
// @updateURL    https://raw.githubusercontent.com/lueluelue2006/ChatGPT-Reasoning-Effort-Toggle/main/ChatGPT_%E6%9B%B4%E4%BE%BF%E6%8D%B7%E7%9A%84%E6%8E%A8%E7%90%86%E5%BC%BA%E5%BA%A6%E9%80%89%E6%8B%A9.js
// @description  在输入框附近添加 min/max 按钮，按需强制请求中的 reasoning effort。
// @author       schweigen
// @license      MIT
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const DEBUG = false;
  const STORAGE_KEY = "tm-thinking-effort";

  /** @type {"min"|"max"|null} */
  let forcedEffort = null;

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "min" || saved === "max") forcedEffort = saved;
  } catch (_) {
    // ignore
  }

  function setForcedEffort(next) {
    forcedEffort = next;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      // ignore
    }
    ensureNetworkPatchWhenNeeded();
    updateButtonsUI();
    if (DEBUG) console.debug("[TM] thinking_effort forced:", forcedEffort);
  }

  function getForcedEffort() {
    return forcedEffort;
  }

  function toggleForcedEffortMinMax() {
    const effort = getForcedEffort();
    const next = effort === "min" ? "max" : "min";
    setForcedEffort(next);
  }

  function forceKeyDeep(obj, keyName, forcedValue) {
    let changed = false;

    if (!obj || typeof obj !== "object") return false;

    if (Array.isArray(obj)) {
      for (const v of obj) changed = forceKeyDeep(v, keyName, forcedValue) || changed;
      return changed;
    }

    for (const k of Object.keys(obj)) {
      if (k === keyName) {
        if (obj[k] !== forcedValue) {
          obj[k] = forcedValue;
          changed = true;
        }
      } else {
        changed = forceKeyDeep(obj[k], keyName, forcedValue) || changed;
      }
    }

    return changed;
  }

  function patchBody(body) {
    const effort = getForcedEffort();
    if (!effort) return body;
    if (typeof body !== "string") return body;
    if (!body.includes('"thinking_effort"')) return body;

    try {
      const obj = JSON.parse(body);
      const changed = forceKeyDeep(obj, "thinking_effort", effort);
      if (changed) return JSON.stringify(obj);
      return body;
    } catch (_) {
      const re = /("thinking_effort"\s*:\s*)"(.*?)"/g;
      return body.replace(re, `$1"${effort}"`);
    }
  }

  // ===== Network patch =====
  // 不在 document-start 阶段立即替换 fetch/XHR：部分站点会在早期做 feature-detect / 初始化，
  // 提前 monkey patch 可能产生副作用（例如布局/滚动行为异常）。这里延迟到页面可用后再安装，
  // 且只在“确实需要强制 min/max”时安装。
  let networkPatched = false;
  let originalFetch = null;
  let originalXhrOpen = null;
  let originalXhrSend = null;

  function installNetworkPatch() {
    if (networkPatched) return;
    if (typeof window.fetch !== "function") return;

    originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      try {
        if (init && typeof init.body === "string") {
          const patched = patchBody(init.body);
          if (patched !== init.body) {
            if (DEBUG) console.debug("[TM] patched fetch init.body");
            const newInit = Object.assign({}, init, { body: patched });
            return originalFetch.call(this, input, newInit);
          }
        }

        if (input instanceof Request && !init) {
          const method = (input.method || "GET").toUpperCase();
          if (method !== "GET" && method !== "HEAD") {
            const txt = await input.clone().text();
            if (txt && txt.includes('"thinking_effort"')) {
              const patched = patchBody(txt);
              if (patched !== txt) {
                if (DEBUG) console.debug("[TM] patched fetch Request body");
                const newReq = new Request(input, { body: patched });
                return originalFetch.call(this, newReq);
              }
            }
          }
        }
      } catch (_) {
        // ignore
      }

      return originalFetch.call(this, input, init);
    };

    originalXhrOpen = XMLHttpRequest.prototype.open;
    originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__tm_method = method;
      this.__tm_url = url;
      return originalXhrOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (typeof body === "string" && body.includes('"thinking_effort"')) {
          const patched = patchBody(body);
          if (patched !== body) {
            if (DEBUG) console.debug("[TM] patched XHR body");
            body = patched;
          }
        }
      } catch (_) {
        // ignore
      }
      return originalXhrSend.call(this, body);
    };

    networkPatched = true;
    if (DEBUG) console.debug("[TM] network patch installed");
  }

  function ensureNetworkPatchWhenNeeded() {
    if (!getForcedEffort()) return;
    installNetworkPatch();
  }

  function isLikelyComposerTarget(target) {
    if (!(target instanceof Element)) return false;
    return (
      !!target.closest('form[data-type="unified-composer"]') ||
      !!target.closest('[data-testid="composer"]') ||
      !!target.closest("#thread-bottom-container")
    );
  }

  function setupSendHooks() {
    // 在用户“即将发送”之前再安装网络补丁，尽量避免影响站点初始化/布局。
    document.addEventListener(
      "submit",
      (event) => {
        if (!getForcedEffort()) return;
        if (!isLikelyComposerTarget(event.target)) return;
        ensureNetworkPatchWhenNeeded();
      },
      true
    );

    document.addEventListener(
      "keydown",
      (event) => {
        if (!getForcedEffort()) return;
        if (event.key !== "Enter") return;
        if (event.shiftKey || event.altKey || event.metaKey) return;
        if (event.isComposing) return;
        if (!isLikelyComposerTarget(event.target)) return;
        ensureNetworkPatchWhenNeeded();
      },
      true
    );
  }

  function setupHotkeys() {
    // 在捕获阶段尽早拦截：先禁用站点/浏览器默认 Cmd+O，再用它切换 min/max
    window.addEventListener(
      "keydown",
      (event) => {
        if (!event.metaKey) return;
        if (event.ctrlKey || event.altKey || event.shiftKey) return;

        const code = typeof event.code === "string" ? event.code : "";
        const key = typeof event.key === "string" ? event.key : "";
        if (code !== "KeyO" && key.toLowerCase() !== "o") return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (event.repeat) return;
        toggleForcedEffortMinMax();
      },
      true
    );
  }

  // ===== UI =====
  let minBtn;
  let maxBtn;

  // 将按钮插入输入框内部（in-flow）可能会把 composer 撑高，导致消息区底部出现额外留白；
  // 默认关闭，改为用 fixed “挂件”方式贴在输入框旁边。
  const INLINE_IN_COMPOSER = false;

  const baseBtnCss = `
    display:flex; align-items:center; justify-content:center;
    height:36px; min-width:56px; padding:0 14px;
    border-radius:9999px;
    font-weight:700; font-size:12px; line-height:1;
    cursor:pointer; user-select:none;
    transition:all .2s ease; border:1px solid rgba(255,255,255,.12);
    color:#e5e7eb; background:rgba(255,255,255,.06);
  `;

  // 选中态配色：min 偏蓝、max 偏红
  const activeMinCss = `
    background: linear-gradient(140.91deg, #5b8cff 12.61%, #2f6bff 76.89%);
    color:#fff; border-color:transparent;
  `;

  const activeMaxCss = `
    background: linear-gradient(140.91deg, #ff5c5c 12.61%, #ff2d55 76.89%);
    color:#fff; border-color:transparent;
  `;

  // 垂直排列：上 max 下 min
  const inlineWrapCss =
    "display:flex; flex-direction:column; align-items:center; gap:6px; flex-shrink:0; margin-inline:6px;";

  const floatingWrapCss =
    "display:flex; align-items:center; gap:6px; position:fixed; z-index:2147483647; padding:4px 6px; border-radius:9999px; background:rgba(0,0,0,.35); backdrop-filter:blur(6px);";

  // “挂件”样式：固定在输入框左侧外部
  const pendantWrapCss =
    "display:flex; flex-direction:column; align-items:center; gap:6px; position:fixed; z-index:2147483647; padding:6px 8px; border-radius:12px; background:rgba(0,0,0,.35); backdrop-filter:blur(6px);";

  function ensureWrapOnBody(wrap) {
    if (!document.body) return false;
    if (wrap.parentElement !== document.body) document.body.appendChild(wrap);
    return true;
  }

  function parkWrapOffscreen(wrap) {
    wrap.style.cssText = pendantWrapCss + "visibility:hidden; left:-9999px; top:-9999px;";
    ensureWrapOnBody(wrap);
  }

  function updateButtonsUI() {
    if (!minBtn || !maxBtn) return;
    const effort = getForcedEffort();
    minBtn.style.cssText = baseBtnCss + (effort === "min" ? activeMinCss : "");
    maxBtn.style.cssText = baseBtnCss + (effort === "max" ? activeMaxCss : "");
    minBtn.setAttribute("aria-pressed", effort === "min" ? "true" : "false");
    maxBtn.setAttribute("aria-pressed", effort === "max" ? "true" : "false");
  }

  function findTrailingContainer() {
    let container = document.querySelector('div[data-testid="composer-trailing-actions"]');
    if (!container) {
      container = document.querySelector('form[data-type="unified-composer"] div[class*="[grid-area:trailing]"]');
    }
    if (!container) {
      const speechContainer = document.querySelector('div[data-testid="composer-speech-button-container"]');
      if (speechContainer && speechContainer.parentElement) {
        container = speechContainer.parentElement;
      }
    }
    return container || null;
  }

  function findLeftContainer() {
    let container = document.querySelector('#thread-bottom-container [data-testid="composer-footer-actions"]');
    if (container) return container;
    const plusAnchor = document.querySelector('#thread-bottom-container div > div.absolute.start-2\\.5.bottom-2\\.5');
    if (plusAnchor && plusAnchor.parentElement) return plusAnchor.parentElement;
    return null;
  }

  function findComposerAnchor() {
    return (
      document.querySelector('form[data-type="unified-composer"]') ||
      document.querySelector('[data-testid="composer"]') ||
      document.querySelector("#thread-bottom-container")
    );
  }

  function tryPendantLeft(wrap) {
    const anchor = findComposerAnchor();
    if (!anchor) {
      // 找不到锚点时也要保证 wrap 不在输入框内部（避免撑高 composer 造成底部留白）
      parkWrapOffscreen(wrap);
      return false;
    }

    // 先挂到 body 上再测量定位
    ensureWrapOnBody(wrap);
    wrap.style.cssText = pendantWrapCss + "visibility:hidden;";

    const rect = anchor.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();

    const left = rect.left - wRect.width - 8;
	    const top = rect.top + (rect.height - wRect.height) / 2 - 6;

    wrap.style.cssText = pendantWrapCss;
    wrap.style.left = `${Math.max(4, left)}px`;
    wrap.style.top = `${Math.max(4, top)}px`;
    return true;
  }

  function buildWrap() {
    const wrap = document.createElement("div");
    wrap.id = "tm-effort-btn-wrap";

    minBtn = document.createElement("div");
    minBtn.id = "tm-effort-min-btn";
    minBtn.textContent = "min";
    minBtn.title = "强制 thinking_effort=min（再次点击取消）";
    minBtn.addEventListener("click", () => {
      const next = forcedEffort === "min" ? null : "min";
      setForcedEffort(next);
    });

    maxBtn = document.createElement("div");
    maxBtn.id = "tm-effort-max-btn";
    maxBtn.textContent = "max";
    maxBtn.title = "强制 thinking_effort=max（再次点击取消）";
    maxBtn.addEventListener("click", () => {
      const next = forcedEffort === "max" ? null : "max";
      setForcedEffort(next);
    });

    // 一列：上 max 下 min
    wrap.appendChild(maxBtn);
    wrap.appendChild(minBtn);
    updateButtonsUI();
    return wrap;
  }

  function getOrCreateWrap() {
    const existing = document.getElementById("tm-effort-btn-wrap");
    if (existing) return existing;
    return buildWrap();
  }

  function addEffortButtons() {
    const wrap = getOrCreateWrap();

    // 即使旧版本曾把 wrap 插进输入框内部，这里也强制挪到 body 下并用 fixed 脱离文档流，
    // 避免 composer 被“撑高”后导致消息区底部出现额外空白。
    if (!INLINE_IN_COMPOSER && wrap.isConnected && wrap.parentElement !== document.body) {
      parkWrapOffscreen(wrap);
    }

    // 优先：作为挂件固定在输入框左侧外部
    if (tryPendantLeft(wrap)) {
      updateButtonsUI();
      return true;
    }

    if (INLINE_IN_COMPOSER) {
      const left = findLeftContainer();
      const trailing = left ? null : findTrailingContainer();
      const host = left || trailing;

      if (host) {
        wrap.style.cssText = inlineWrapCss;
        if (wrap.parentElement !== host) host.appendChild(wrap);
        updateButtonsUI();
        return true;
      }
    }

    // 兜底：挂到输入框左侧附近（固定定位）
    const anchor =
      document.querySelector("#thread-bottom-container") ||
      document.querySelector('[data-testid="composer"]') ||
      document.querySelector('form[data-type="unified-composer"]');
    if (!anchor) {
      parkWrapOffscreen(wrap);
      return false;
    }

    const rect = anchor.getBoundingClientRect();
    wrap.style.cssText = floatingWrapCss;
    wrap.style.left = `${Math.max(8, rect.left + 8)}px`;
    wrap.style.top = `${Math.max(8, rect.bottom - 48)}px`;
    ensureWrapOnBody(wrap);
    updateButtonsUI();
    return true;
  }

  function boot() {
    if (!document.body) return;
    addEffortButtons();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
  setInterval(boot, 2000);
  setupSendHooks();
  setupHotkeys();
})();
