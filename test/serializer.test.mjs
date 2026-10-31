import test from 'node:test';
import assert from 'node:assert/strict';

import { installPageHelpers } from '../src/browser/page-scripts.mjs';
import { requireBrowser, closeBrowser } from './helpers/browser.mjs';

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="ds-assistant-message-main-content">
  <div class="ds-think-content"><div class="ds-markdown"><p>先想一想。</p></div></div>
  <div class="ds-markdown">
    <h2>标题</h2>
    <p>这是一段 <strong>粗体</strong> 和 <em>斜体</em>，还有 <code>inline</code>。</p>
    <ul>
      <li>第一项</li>
      <li>第二项
        <ul><li>嵌套项</li></ul>
      </li>
    </ul>
    <ol><li>一</li><li>二</li></ol>
    <pre><div class="code-header">python<button>复制</button></div><code class="language-python">def f(x):
    # 保留缩进
    return x + 1

print(f(1))</code></pre>
    <blockquote><p>引用内容</p></blockquote>
    <p><a href="https://example.com">链接</a> 和 <code>code</code></p>
    <table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody><tr><td>内核名</td><td>Linux</td></tr></tbody></table>
  </div>
</div>
</body></html>`;

test('Markdown DOM 还原成 Markdown 文本', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const page = await browser.newPage();
  try {
    await page.addInitScript(installPageHelpers);
    await page.goto('data:text/html,<html><body></body></html>');
    await page.evaluate(installPageHelpers);
    await page.setContent(HTML);

    const result = await page.evaluate(() => {
      const block = document.querySelector('.ds-assistant-message-main-content');
      const think = block.querySelector('.ds-think-content');
      const mds = Array.from(block.querySelectorAll('.ds-markdown')).filter((el) => !think.contains(el));
      return {
        thinking: window.__DSW__.serialize(think.querySelector('.ds-markdown')),
        answer: window.__DSW__.serialize(mds[mds.length - 1]),
      };
    });

    assert.equal(result.thinking, '先想一想。');
    const md = result.answer;

    assert.match(md, /^## 标题$/m);
    assert.match(md, /这是一段 \*\*粗体\*\* 和 \*斜体\*，还有 `inline`。/);
    assert.match(md, /^- 第一项$/m);
    assert.match(md, /嵌套项/);
    assert.match(md, /^1\. 一$/m);
    assert.match(md, /^2\. 二$/m);

    // 代码块：语言、内容、缩进都要在，复制按钮不能混进来
    assert.match(md, /```python\n/);
    assert.match(md, /\n {4}# 保留缩进/);
    assert.ok(!md.includes('复制'), '复制按钮文字不该出现在 markdown 里');

    assert.match(md, /^> 引用内容$/m);
    assert.match(md, /\[链接\]\(https:\/\/example\.com\)/);
    assert.match(md, /^\| 字段 \| 值 \|$/m);
    assert.match(md, /^\| --- \| --- \|$/m);
    assert.match(md, /^\| 内核名 \| Linux \|$/m);
  } finally {
    await page.close();
  }
});

test('真实 DeepSeek 代码块：语言名从 banner 取，按钮文案不能混进正文', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const page = await browser.newPage();
  try {
    await page.addInitScript(installPageHelpers);
    await page.goto('data:text/html,<html><body></body></html>');
    await page.evaluate(installPageHelpers);
    await page.setContent(`<!doctype html><html><body>
      <div class="ds-markdown ds-assistant-message-main-content">
        <p class="ds-markdown-paragraph">示例：</p>
        <div class="md-code-block md-code-block-light">
          <div class="md-code-block-banner-wrap">
            <div class="md-code-block-banner md-code-block-banner-lite">
              <div class="_121d384">
                <div class="d2a24f03"><span class="d813de27">python</span></div>
                <div class="d2a24f03 _246a029"><div class="efa13877">
                  <div role="button" class="ds-button"><div class="ds-button__icon"><svg></svg></div>复制</div>
                  <div role="button" class="ds-button"><div class="ds-button__icon"><svg></svg></div>下载</div>
                </div></div>
              </div>
            </div>
          </div>
          <pre><code>print("Hello, World!")</code></pre>
        </div>
        <p class="ds-markdown-paragraph">结束</p>
      </div>
    </body></html>`);

    const md = await page.evaluate(() => {
      const el = document.querySelector('.ds-assistant-message-main-content');
      return window.__DSW__.serialize(el);
    });

    assert.match(md, /```python\nprint\("Hello, World!"\)\n```/);
    assert.ok(!md.includes('复制'));
    assert.ok(!md.includes('下载'));
    assert.ok(md.startsWith('示例：'), 'banner 的语言名不能跑到正文最前面');
  } finally {
    await page.close();
  }
});

test('extract(): 区分思考与回答，识别生成中状态', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const page = await browser.newPage();
  try {
    await page.addInitScript(installPageHelpers);
    await page.goto('data:text/html,<html><body></body></html>');
    await page.evaluate(installPageHelpers);
    await page.setContent(`<!doctype html><html><body>
      <div class="ds-assistant-message-main-content">
        <div class="ds-think-content"><div class="ds-markdown">思考内容</div></div>
        <div class="ds-markdown">正式回答</div>
      </div>
      <button aria-label="停止生成">停止生成</button>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    </body></html>`);

    const state = await page.evaluate(() => window.__DSW__.extract());
    assert.equal(state.thinking, '思考内容');
    assert.equal(state.answer, '正式回答');
    assert.equal(state.generating, true);
    assert.equal(state.assistantCount, 1);
    assert.equal(state.inputVisible, true);
    assert.equal(state.captcha, false);
  } finally {
    await page.close();
  }
});

test('流式序列化：逐次增长的 DOM 必须保持前缀关系', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const page = await browser.newPage();
  try {
    await page.addInitScript(installPageHelpers);
    await page.goto('data:text/html,<html><body></body></html>');
    await page.evaluate(installPageHelpers);

    const states = [
      '<h2>冒泡排序</h2>',
      '<h2>冒泡排序</h2><p>思路是先比较相邻元素</p>',
      '<h2>冒泡排序</h2><p>思路是先比较相邻元素，把大的往后换。</p>',
      '<h2>冒泡排序</h2><p>思路是先比较相邻元素，把大的往后换。</p><div class="md-code-block"><pre><code>def f(a):</code></pre></div>',
      '<h2>冒泡排序</h2><p>思路是先比较相邻元素，把大的往后换。</p><div class="md-code-block"><pre><code>def f(a):\n    return a</code></pre></div>',
      '<h2>冒泡排序</h2><p>思路是先比较相邻元素，把大的往后换。</p><div class="md-code-block"><pre><code>def f(a):\n    return a</code></pre></div><ul><li>平均 O(n²)</li></ul>',
      '<h2>冒泡排序</h2><p>思路是先比较相邻元素，把大的往后换。</p><div class="md-code-block"><pre><code>def f(a):\n    return a</code></pre></div><ul><li>平均 O(n²)</li><li>稳定排序</li></ul><p><strong>结论：简单但慢</strong></p>',
    ];

    const outputs = await page.evaluate((htmls) => {
      const host = document.createElement('div');
      host.className = 'ds-markdown';
      document.body.appendChild(host);
      return htmls.map((html) => {
        host.innerHTML = html;
        return window.__DSW__.serialize(host, { streaming: true });
      });
    }, states);

    for (let i = 1; i < outputs.length; i += 1) {
      assert.ok(
        outputs[i].startsWith(outputs[i - 1]),
        `第 ${i} 次输出破坏了前缀关系\n上一版: ${JSON.stringify(outputs[i - 1])}\n新版:   ${JSON.stringify(outputs[i])}`,
      );
    }

    // 流式阶段代码块不补收尾 fence，粗体不补闭合星号
    assert.ok(!outputs[3].endsWith('```'));
    assert.ok(outputs[6].endsWith('**结论：简单但慢'), '流式阶段末尾的粗体不补闭合星号');
    // 收尾（非流式）必须补全
    const final = await page.evaluate(() => {
      const host = document.querySelector('.ds-markdown');
      return window.__DSW__.serialize(host, { streaming: false });
    });
    assert.ok(final.endsWith('**结论：简单但慢**'));
    assert.ok(final.includes('```'));
  } finally {
    await page.close();
  }
});

test('流式序列化：末尾的表格先不输出，等它完整', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const page = await browser.newPage();
  try {
    await page.addInitScript(installPageHelpers);
    await page.goto('data:text/html,<html><body></body></html>');
    await page.evaluate(installPageHelpers);

    const out = await page.evaluate(() => {
      const host = document.createElement('div');
      host.className = 'ds-markdown';
      host.innerHTML = '<p>对比如下：</p><table><tr><th>特性</th><th>TCP</th></tr><tr><td>连接</td><td>面向连接</td></tr></table>';
      document.body.appendChild(host);
      return {
        streaming: window.__DSW__.serialize(host, { streaming: true }),
        full: window.__DSW__.serialize(host, { streaming: false }),
      };
    });

    assert.ok(!out.streaming.includes('| 特性 |'), '流式阶段不该提前输出表格');
    assert.ok(out.full.includes('| 特性 | TCP |'));
    assert.ok(out.full.startsWith(out.streaming.replace(/\s+$/, '')));
  } finally {
    await page.close();
  }
});

test.after(async () => {
  await closeBrowser();
});
