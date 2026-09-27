const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Execute the shipped scheduler and batch runner; stub only browser IO and tasks.
const source = fs.readFileSync(path.join(__dirname, '..', 'doubao-image-auto.user.js'), 'utf8');
const boot = source.lastIndexOf('  if (document.readyState === "loading")');
assert.ok(boot > 0);

function setup() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const storage = new Map();
  const hint = { textContent: '', style: {} };
  const calls = [];
  const io = { pageMessage: '', task: async () => {}, conversation: async () => {} };
  const addTimer = (fn, delay, interval = false) => {
    const id = ++sequence;
    timers.set(id, { fn, at: now + delay, delay, interval });
    return id;
  };
  const context = vm.createContext({
    console, Error,
    Date: class extends Date { static now() { return now; } },
    window: {
      setTimeout: (fn, ms) => addTimer(fn, ms), clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, ms) => addTimer(fn, ms, true), clearInterval: (id) => timers.delete(id),
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key),
    },
    document: { querySelectorAll: () => [] },
    io, hint, calls,
  });
  vm.runInContext(source.slice(0, boot) + `
    getPanelElement = (id) => id === RESUME_HINT_ID ? hint : null;
    toggleButtons = () => {};
    enableRemoveWatermarkHook = () => {};
    const originalLimitDetector = getGenerationLimitMessage;
    getGenerationLimitMessage = () => io.pageMessage;
    applyBatchSettings = () => {};
    deleteResumeFilesForCheckpoint = async () => {};
    sleepRandom = async () => {};
    startFreshConversation = () => io.conversation();
    runSingleTask = async (task, index) => {
      calls.push(index);
      await io.task(task, index);
      state.completedTasks = index + 1;
    };
    globalThis.api = {
      state, runBatch, scheduleAutoRetry, stopBatch, clearResumeCheckpoint,
      resumeBatchFromCheckpoint, getAutoRetryBlockReason, originalLimitDetector,
      waitForNewImages,
    };
  })();`, context);
  const api = context.api;
  const checkpoint = (count = 3) => ({
    id: 'batch-1', mode: 'text', nextIndex: 0, total: count, completedTasks: 0,
    tasks: Array.from({ length: count }, (_, index) => ({ kind: 'text', prompt: `p${index}`, label: `t${index}` })),
    settings: {}, stoppedManually: false, failedTasks: [],
  });
  async function tick(ms) {
    const target = now + ms;
    for (;;) {
      const pending = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
      if (!pending.length) break;
      const [id, timer] = pending[0];
      now = timer.at;
      if (timer.interval) timer.at += timer.delay;
      else timers.delete(id);
      await timer.fn();
    }
    now = target;
  }
  return { api, io, timers, calls, hint, tick, checkpoint, context };
}

test('generation timeout retries the same index after exactly 120 seconds, preserving completed work', async () => {
  const h = setup();
  const cp = h.checkpoint();
  let fail = true;
  h.io.task = async (_, index) => { if (index === 1 && fail) { fail = false; throw new Error('等待新图片生成超时'); } };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  assert.deepEqual(h.calls, [0, 1]);
  assert.equal(h.api.state.resumeCheckpoint.nextIndex, 1);
  assert.equal(h.api.state.resumeCheckpoint.completedTasks, 1);
  assert.match(h.hint.textContent, /120 秒后自动重试/);
  await h.tick(119000);
  assert.deepEqual(h.calls, [0, 1]);
  assert.match(h.hint.textContent, /1 秒后自动重试/);
  await h.tick(1000);
  assert.deepEqual(h.calls, [0, 1, 1, 2]);
  assert.equal(h.api.state.resumeCheckpoint, null);
  assert.equal(h.timers.size, 0);
});

test('repeated failures stop after three automatic retries, keeping the checkpoint', async () => {
  const h = setup();
  const cp = h.checkpoint(1);
  h.io.task = async () => { throw new Error('Failed to fetch'); };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  await h.tick(240000);
  assert.deepEqual(h.calls, [0, 0, 0]);
  assert.equal(h.timers.size, 2);
  assert.equal(h.api.state.autoRetryAt, 360000);
  await h.tick(120000);
  assert.deepEqual(h.calls, [0, 0, 0, 0]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.state.resumeCheckpoint.autoRetryAttempts, 3);
  assert.equal(h.api.state.resumeCheckpoint.nextIndex, 0);
  assert.match(h.api.state.resumeCheckpoint.autoRetryBlockedReason, /已重试 3 次/);
  await h.tick(600000);
  assert.equal(h.calls.length, 4);
});

test('retry budget resets after success for the next task', async () => {
  const h = setup();
  const cp = h.checkpoint(2);
  const attempts = [0, 0];
  h.io.task = async (_, index) => {
    attempts[index]++;
    if (attempts[index] <= 3) throw new Error('网络断开');
  };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  await h.tick(720000);
  assert.deepEqual(h.calls, [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal(h.api.state.resumeCheckpoint, null);
  assert.equal(h.timers.size, 0);
});

test('manual resume resets an exhausted retry budget', async () => {
  const h = setup();
  const cp = h.checkpoint(1);
  h.io.task = async () => { throw new Error('网络断开'); };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  await h.tick(360000);
  assert.equal(h.api.state.resumeCheckpoint.autoRetryAttempts, 3);
  await h.api.resumeBatchFromCheckpoint();
  assert.equal(h.api.state.resumeCheckpoint.autoRetryAttempts, 0);
  assert.equal(h.api.state.autoRetryAt, 480000);
  h.io.task = async () => {};
  await h.tick(120000);
  assert.equal(h.api.state.resumeCheckpoint, null);
});

for (const message of [
  '今天的生成次数已达到上限', '今日生图次数已用完', '额度不足', '明天再来免费生成',
  '请求过于频繁，请稍后再试', '下载失败: 429', 'insufficient_quota', 'Rate limit exceeded',
  '请重新登录', '请完成人机验证', '下载失败: 403', '断点文件丢失：a.png，请重新选择文件夹再启动',
  '提示词写入校验失败，已停止发送。请保留断点并检查输入框。', '内容违反相关政策',
]) {
  test(`does not automatically retry: ${message}`, async () => {
    const h = setup();
    const cp = h.checkpoint(1);
    h.io.task = async () => { throw new Error(message); };
    await h.api.runBatch(cp.tasks, { checkpoint: cp });
    assert.ok(h.api.state.resumeCheckpoint.autoRetryBlockedReason);
    assert.equal(h.api.state.resumeCheckpoint.nextIndex, 0);
    assert.equal(h.timers.size, 0);
    await h.tick(240000);
    assert.deepEqual(h.calls, [0]);
  });
}

test('limit appearing during the countdown cancels retry before any new task', async () => {
  const h = setup();
  const cp = h.checkpoint(1);
  h.io.task = async () => { throw new Error('等待发送按钮超时'); };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  h.io.pageMessage = '今日生成次数已达到上限';
  await h.tick(120000);
  assert.deepEqual(h.calls, [0]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.state.resumeCheckpoint.autoRetryBlockedReason, '生成限额或额度不足');
});

test('quota on page blocks retry even if the caught error is a timeout', async () => {
  const h = setup();
  const cp = h.checkpoint(1);
  h.io.pageMessage = '额度不足';
  h.io.task = async () => { throw new Error('等待页面元素超时'); };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  assert.equal(h.timers.size, 0);
  assert.ok(h.api.state.resumeCheckpoint.autoRetryBlockedReason);
});

for (const action of ['stopBatch', 'clearResumeCheckpoint', 'resumeBatchFromCheckpoint']) {
  test(`${action} cancels pending retry`, async () => {
    const h = setup();
    const cp = h.checkpoint(1);
    h.io.task = async () => { throw new Error('网络连接断开'); };
    await h.api.runBatch(cp.tasks, { checkpoint: cp });
    h.io.task = async () => {};
    await h.api[action]();
    const count = h.calls.length;
    await h.tick(240000);
    assert.equal(h.calls.length, count);
    assert.equal(h.timers.size, 0);
    if (action === 'stopBatch') assert.equal(h.api.state.resumeCheckpoint.stoppedManually, true);
  });
}

test('manual stop during a running task never schedules retry', async () => {
  const h = setup();
  const cp = h.checkpoint(1);
  h.io.task = async () => { h.api.stopBatch(); throw new Error('任务已停止'); };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.state.resumeCheckpoint.stoppedManually, true);
});

test('new batch cancels old pending retry', async () => {
  const h = setup();
  const old = h.checkpoint(1);
  h.io.task = async () => { throw new Error('网络断开'); };
  await h.api.runBatch(old.tasks, { checkpoint: old });
  const fresh = { ...h.checkpoint(1), id: 'batch-2' };
  h.io.task = async () => {};
  await h.api.runBatch(fresh.tasks, { checkpoint: fresh });
  await h.tick(240000);
  assert.deepEqual(h.calls, [0, 0]);
  assert.equal(h.timers.size, 0);
});

test('stale scheduled retry cannot resume a replacement checkpoint', async () => {
  const h = setup();
  h.api.state.resumeCheckpoint = h.checkpoint(1);
  h.api.scheduleAutoRetry('网络断开');
  h.api.state.resumeCheckpoint = { ...h.checkpoint(1), id: 'replacement' };
  await h.tick(120000);
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 0);
});

test('failed conversation setup also schedules retry', async () => {
  const h = setup();
  const cp = h.checkpoint(1);
  h.io.conversation = async () => { throw new Error('等待新会话超时'); };
  await h.api.runBatch(cp.tasks, { checkpoint: cp });
  assert.equal(h.api.state.autoRetryAt, 120000);
  h.io.conversation = async () => {};
  await h.tick(120000);
  assert.deepEqual(h.calls, [0]);
});

test('image wait honors manual stop immediately', async () => {
  const h = setup();
  h.api.state.stopRequested = true;
  await assert.rejects(h.api.waitForNewImages(new Set()), /任务已停止/);
});

test('limit detection ignores old replies and recognizes newest reply', () => {
  const h = setup();
  let replies = [{ textContent: '今天的生成次数已达到上限' }, { textContent: '已为你生成图片' }];
  h.context.document.querySelectorAll = (selector) => selector === '[data-testid="receive_message"]' ? replies : [];
  assert.equal(h.api.originalLimitDetector(), '');
  replies = [{ textContent: '今日生图次数已用完' }];
  assert.equal(h.api.originalLimitDetector(), '今日生图次数已用完');
});

test('release metadata versions match', () => {
  const version = source.match(/@version\s+(\S+)/)[1];
  assert.equal(source.match(/const SCRIPT_VERSION = "([^"]+)"/)[1], version);
  assert.ok(source.includes(`@name         豆包图像生成助手 v${version}`));
});

test('legacy message fallback detects quota and excludes user prompt text', () => {
  const h = setup();
  let messages = [{ textContent: '今天的生成次数已达到上限', closest: () => null }];
  h.context.document.querySelectorAll = (selector) => selector === '[data-testid="message_content"], .markdown' ? messages : [];
  assert.equal(h.api.originalLimitDetector(), '今天的生成次数已达到上限');
  messages = [{ textContent: '额度不足', closest: () => ({}) }];
  assert.equal(h.api.originalLimitDetector(), '');
});

test('exhausted saved retry budget does not schedule another automatic attempt', () => {
  const h = setup();
  h.api.state.resumeCheckpoint = { ...h.checkpoint(1), autoRetryAttempts: 3 };
  h.api.scheduleAutoRetry('网络错误');
  assert.equal(h.timers.size, 0);
  assert.match(h.api.state.resumeCheckpoint.autoRetryBlockedReason, /已重试 3 次/);
});
