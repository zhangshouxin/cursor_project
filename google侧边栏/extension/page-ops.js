/** 在用户可见标签页中执行操作，便于侧边栏左侧实时看到效果 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitTabComplete(tabId, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(200);
  }
  return chrome.tabs.get(tabId);
}

async function ensureScriptable(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  if (!/^https?:/i.test(url)) {
    throw new Error(`当前页无法注入脚本：${url || "未知地址"}`);
  }
  return tab;
}

/** 在页面中高亮元素，让用户看清即将操作的目标 */
function highlightAndAct(selector, action, value, key) {
  const el = document.querySelector(selector);
  if (!el) {
    return { ok: false, error: `未找到元素: ${selector}` };
  }

  el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  const prevOutline = el.style.outline;
  const prevTransition = el.style.transition;
  el.style.transition = "outline 0.15s ease";
  el.style.outline = "3px solid #c45c26";
  el.style.outlineOffset = "2px";

  const cleanup = () => {
    el.style.outline = prevOutline;
    el.style.transition = prevTransition;
  };

  try {
    if (action === "click") {
      el.focus?.();
      el.click();
    } else if (action === "fill") {
      el.focus?.();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value ?? "");
      else el.value = value ?? "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (action === "press") {
      el.focus?.();
      const k = key || "Enter";
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
      );
      el.dispatchEvent(
        new KeyboardEvent("keyup", { key: k, bubbles: true, cancelable: true })
      );
      if (k === "Enter" && el.form) {
        el.form.requestSubmit?.();
      }
    }
  } catch (err) {
    cleanup();
    return { ok: false, error: err.message || String(err) };
  }

  setTimeout(cleanup, 1200);
  return {
    ok: true,
    selector,
    tag: el.tagName?.toLowerCase(),
    text: (el.innerText || el.value || "").slice(0, 120),
  };
}

function readSnapshot(maxLength = 6000) {
  const text = (document.body?.innerText || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    ok: true,
    title: document.title,
    url: location.href,
    text: text.slice(0, maxLength),
    length: text.length,
  };
}

function extractText(selector, maxLength = 12000) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { ok: false, error: `未找到: ${selector}` };
  const text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    ok: true,
    selector: selector || "body",
    text: text.slice(0, maxLength),
    length: text.length,
  };
}

export async function openAndBindTab(url) {
  const wins = await chrome.windows.getCurrent();
  const [current] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  const tab = await chrome.tabs.create({
    url,
    active: true,
    windowId: wins?.id ?? current?.windowId,
    index: current?.index != null ? current.index + 1 : undefined,
  });
  await waitTabComplete(tab.id);
  const ready = await chrome.tabs.get(tab.id);
  return {
    ok: true,
    tabId: ready.id,
    url: ready.url,
    title: ready.title,
  };
}

export async function bindActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有可用的活动标签页");
  if (!/^https?:/i.test(tab.url || "")) {
    throw new Error("请先打开一个普通网页标签（http/https）");
  }
  return {
    ok: true,
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
  };
}

export async function navigateBoundTab(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitTabComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, tabId, url: tab.url, title: tab.title };
}

export async function runPageTool(tabId, name, args = {}) {
  if (name === "open_webpage") {
    return openAndBindTab(args.url);
  }
  if (name === "bind_current_tab") {
    return bindActiveTab();
  }
  if (name === "page_navigate") {
    return navigateBoundTab(tabId, args.url);
  }
  if (name === "page_wait") {
    if (args.selector && tabId) {
      await ensureScriptable(tabId);
      const started = Date.now();
      const timeout = Math.min(Number(args.ms) || 10000, 20000);
      while (Date.now() - started < timeout) {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel) => Boolean(document.querySelector(sel)),
          args: [args.selector],
        });
        if (result) return { ok: true, selector: args.selector, waited: true };
        await sleep(250);
      }
      return { ok: false, error: `等待超时: ${args.selector}` };
    }
    await sleep(Math.min(Number(args.ms) || 800, 10000));
    return { ok: true, waitedMs: Number(args.ms) || 800 };
  }

  if (!tabId) {
    return { ok: false, error: "尚未绑定页面，请先 open_webpage 或 bind_current_tab" };
  }

  await ensureScriptable(tabId);
  // 操作前稍等，方便用户看到左侧页面
  await sleep(180);

  if (name === "page_snapshot") {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readSnapshot,
      args: [args.maxLength || 6000],
    });
    return result;
  }

  if (name === "page_extract") {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractText,
      args: [args.selector || null, args.maxLength || 12000],
    });
    return result;
  }

  if (name === "page_click" || name === "page_fill" || name === "page_press") {
    const action =
      name === "page_click" ? "click" : name === "page_fill" ? "fill" : "press";
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: highlightAndAct,
      args: [args.selector, action, args.value ?? "", args.key || "Enter"],
    });
    await sleep(350);
    return result;
  }

  return { ok: false, error: `未知页面工具: ${name}` };
}
