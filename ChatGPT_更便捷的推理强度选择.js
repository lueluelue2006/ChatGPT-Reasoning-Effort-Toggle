// ==UserScript==
// @name         ChatGPT 推理强度快捷切换（⌘O：Light ↔ Heavy / Standard ↔ Extended）
// @namespace    https://github.com/lueluelue2006/ChatGPT-Reasoning-Effort-Toggle
// @version      1.3
// @description  在 chatgpt.com 使用 ⌘O 切换推理强度：5.2 Thinking(四档)在 Light↔Heavy 之间切；5.2 Pro(两档)在 Standard↔Extended 之间切；每次切换会在控制台输出检测模式与目标档位，并让选择器闪一下提示已切换（低档蓝，高档红）。本脚本会强制修改发送消息请求里的 thinking_effort，避免官网 UI 切换“看起来切了但实际没生效”。
// @author       schweigen
// @license      MIT
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/lueluelue2006/ChatGPT-Reasoning-Effort-Toggle/main/ChatGPT_%E6%9B%B4%E4%BE%BF%E6%8D%B7%E7%9A%84%E6%8E%A8%E7%90%86%E5%BC%BA%E5%BA%A6%E9%80%89%E6%8B%A9.js
// @updateURL    https://raw.githubusercontent.com/lueluelue2006/ChatGPT-Reasoning-Effort-Toggle/main/ChatGPT_%E6%9B%B4%E4%BE%BF%E6%8D%B7%E7%9A%84%E6%8E%A8%E7%90%86%E5%BC%BA%E5%BA%A6%E9%80%89%E6%8B%A9.js
// ==/UserScript==

(() => {
  "use strict";

  const DEBUG = false;
  const LOG_PREFIX = "[TM][ThinkingToggle]";
  const PULSE_STYLE_ID = "__tm_thinking_toggle_pulse_style";
  const PULSE_CLASS = "__tm_thinking_toggle_pulse";
  const PULSE_RGB_VAR = "--__tmThinkingTogglePulseRGB";
  const PULSE_RGB_LOW = "56,189,248"; // blue
  const PULSE_RGB_HIGH = "239,68,68"; // red

  const FETCH_PATCH_FLAG = "__tm_thinking_toggle_fetch_patched__";

  /** @type {boolean} */
  let busy = false;

  /** @type {"min"|"max"|null} */
  let forcedThinkingEffort = null;
  /** @type {"standard"|"extended"|null} */
  let forcedProEffort = null;
  /** @type {string|null} */
  let lastSeenModelSlug = null;

  function log(...args) {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.debug(LOG_PREFIX, ...args);
  }

  function info(message) {
    // eslint-disable-next-line no-console
    console.log(LOG_PREFIX, message);
  }

  function warn(message) {
    // eslint-disable-next-line no-console
    console.warn(LOG_PREFIX, message);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function ensurePulseStyle() {
    if (document.getElementById(PULSE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PULSE_STYLE_ID;
    style.textContent = `
@keyframes __tmThinkingTogglePulse {
  0%   { transform: scale(1);    box-shadow: 0 0 0 0 rgba(var(${PULSE_RGB_VAR}, ${PULSE_RGB_LOW}), 0);    filter: brightness(1); }
  45%  { transform: scale(1.06); box-shadow: 0 0 0 6px rgba(var(${PULSE_RGB_VAR}, ${PULSE_RGB_LOW}), .35); filter: brightness(1.18); }
  100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(var(${PULSE_RGB_VAR}, ${PULSE_RGB_LOW}), 0);    filter: brightness(1); }
}
button.${PULSE_CLASS} {
  animation: __tmThinkingTogglePulse 650ms ease-in-out 0s 1;
  will-change: transform, box-shadow, filter;
}
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function pulseOnce(el, rgb) {
    if (!(el instanceof HTMLElement)) return;
    ensurePulseStyle();
    try {
      el.style.setProperty(PULSE_RGB_VAR, rgb);
      el.classList.remove(PULSE_CLASS);
      // 强制 reflow 以便重复触发动画
      void el.offsetWidth;
      el.classList.add(PULSE_CLASS);
    } catch (_) {
      // ignore
    }
  }

  function schedulePulse(pill, isHigh) {
    const rgb = isHigh ? PULSE_RGB_HIGH : PULSE_RGB_LOW;
    window.setTimeout(() => {
      let target = pill;
      if (!(target instanceof HTMLElement) || !document.contains(target)) {
        const root = getComposerRoot();
        const pills = Array.from(root.querySelectorAll("button.__composer-pill"));
        target =
          pills.find((p) => /thinking|pro/i.test((p.textContent || "").trim())) || pills[0] || null;
      }
      if (target) pulseOnce(target, rgb);
    }, 80);
  }

  function isHotkey(event) {
    if (!event.metaKey) return false;
    if (event.ctrlKey || event.altKey || event.shiftKey) return false;

    const code = typeof event.code === "string" ? event.code : "";
    const key = typeof event.key === "string" ? event.key : "";
    return code === "KeyO" || key.toLowerCase() === "o";
  }

  function getComposerRoot() {
    return document.querySelector("#thread-bottom-container") || document.body;
  }

  function listComposerPills() {
    const root = getComposerRoot();
    return Array.from(
      root.querySelectorAll(
        "button.__composer-pill[aria-haspopup='menu'],button.__composer-pill"
      )
    ).filter((el) => el instanceof HTMLButtonElement);
  }

  async function findEffortPill() {
    const pills = listComposerPills();
    if (!pills.length) return null;
    if (pills.length === 1) return pills[0];

    const likely = pills.find((p) => /thinking|pro/i.test((p.textContent || "").trim()));
    return likely || pills[0] || null;
  }

  function normalizeText(s) {
    return (s || "").toString().trim();
  }

  function getModelSelectorText() {
    const btn =
      document.querySelector('button[aria-label*=\"current model is\"]') ||
      document.querySelector('button[aria-label^=\"Model selector\"]');
    const aria = btn?.getAttribute("aria-label");
    const text = btn?.textContent;
    return normalizeText(aria || text || "");
  }

  function modeFromModelSlug(model) {
    if (typeof model !== "string") return null;
    if (/\bpro\b/i.test(model)) return "pro";
    if (/\bthinking\b/i.test(model)) return "thinking";
    return null;
  }

  function detectMode() {
    const byModelSlug = modeFromModelSlug(lastSeenModelSlug);
    if (byModelSlug) return byModelSlug;

    const modelText = getModelSelectorText();
    if (/\b5\.?2\b/i.test(modelText)) {
      if (/\bpro\b/i.test(modelText)) return "pro";
      if (/\bthinking\b/i.test(modelText)) return "thinking";
    }

    if (/\bpro\b/i.test(modelText)) return "pro";
    if (/\bthinking\b/i.test(modelText)) return "thinking";
    return null;
  }

  function isHighByEffort(mode, effort) {
    if (mode === "thinking") return effort === "max";
    if (mode === "pro") return effort === "extended";
    return false;
  }

  function getForcedEffort(mode) {
    if (mode === "thinking") return forcedThinkingEffort;
    if (mode === "pro") return forcedProEffort;
    return null;
  }

  function setForcedEffort(mode, isHigh) {
    if (mode === "thinking") forcedThinkingEffort = isHigh ? "max" : "min";
    if (mode === "pro") forcedProEffort = isHigh ? "extended" : "standard";
  }

  function getCurrentIsHigh(mode, pill) {
    const forced = getForcedEffort(mode);
    if (forced) return isHighByEffort(mode, forced);

    const text = normalizeText(pill?.textContent).toLowerCase();
    if (mode === "thinking") return /\bheavy\b/.test(text);
    if (mode === "pro") return /\bextended\b/.test(text);
    return false;
  }

  function getTargetLabel(mode, isHigh) {
    if (mode === "thinking") return isHigh ? "Heavy" : "Light";
    if (mode === "pro") return isHigh ? "Extended" : "Standard";
    return isHigh ? "High" : "Low";
  }

  async function toggleThinkingTime() {
    if (busy) return;
    busy = true;

    try {
      const pill = await findEffortPill();
      if (!pill) {
        warn("没找到推理强度选择器（可能当前模型/页面不支持）");
        return;
      }

      const mode = detectMode();
      if (!mode) {
        warn("无法识别当前模式（5.2 Thinking / 5.2 Pro）");
        return;
      }

      const currentHigh = getCurrentIsHigh(mode, pill);
      const nextHigh = !currentHigh;
      setForcedEffort(mode, nextHigh);

      info(`检测到${mode}模式，切换到${getTargetLabel(mode, nextHigh)} thinking`);
      schedulePulse(pill, nextHigh);
    } catch (err) {
      log(err);
      warn("切换失败（异常已吞掉，避免影响页面）");
    } finally {
      busy = false;
    }
  }

  function isConversationRequestUrl(url) {
    if (typeof url !== "string") return false;
    return (
      /\/backend-api\/f\/conversation(?:\?|$)/.test(url) ||
      /\/backend-api\/conversation(?:\?|$)/.test(url)
    );
  }

  function installFetchPatch() {
    if (window[FETCH_PATCH_FLAG]) return;
    window[FETCH_PATCH_FLAG] = true;

    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") return;

    window.fetch = async function (input, init) {
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : typeof input?.url === "string"
                ? input.url
                : "";

        if (!isConversationRequestUrl(url)) return originalFetch.apply(this, arguments);

        // 优先处理最常见的：fetch(url, { body: JSON.stringify(...) })
        if (init && typeof init.body === "string") {
          let payload = null;
          try {
            payload = JSON.parse(init.body);
          } catch (_) {
            payload = null;
          }

          if (payload && typeof payload === "object") {
            const model = typeof payload.model === "string" ? payload.model : null;
            if (model) lastSeenModelSlug = model;
            const mode = modeFromModelSlug(model);
            const forced = mode ? getForcedEffort(mode) : null;

            if (mode && forced) {
              payload.thinking_effort = forced;
              init = { ...init, body: JSON.stringify(payload) };
            }
          }

          return originalFetch.call(this, input, init);
        }

        // 兜底：fetch(Request) / fetch(Request, init)
        const request = new Request(input, init);
        if (request.method.toUpperCase() !== "POST") return originalFetch.apply(this, arguments);

        const text = await request.clone().text();
        if (!text) return originalFetch.apply(this, arguments);

        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch (_) {
          payload = null;
        }
        if (!payload || typeof payload !== "object") return originalFetch.apply(this, arguments);

        const model = typeof payload.model === "string" ? payload.model : null;
        if (model) lastSeenModelSlug = model;
        const mode = modeFromModelSlug(model);
        const forced = mode ? getForcedEffort(mode) : null;
        if (!mode || !forced) return originalFetch.apply(this, arguments);

        payload.thinking_effort = forced;

        const headers = new Headers(request.headers);
        const patched = new Request(request.url, {
          method: request.method,
          headers,
          body: JSON.stringify(payload),
          credentials: request.credentials,
          cache: request.cache,
          redirect: request.redirect,
          referrer: request.referrer,
          referrerPolicy: request.referrerPolicy,
          integrity: request.integrity,
          keepalive: request.keepalive,
          mode: request.mode,
          signal: request.signal,
        });
        return originalFetch.call(this, patched);
      } catch (err) {
        log(err);
        return originalFetch.apply(this, arguments);
      }
    };
  }

  installFetchPatch();

  window.addEventListener(
    "keydown",
    (event) => {
      if (!isHotkey(event)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.repeat) return;
      toggleThinkingTime();
    },
    true
  );
})();
