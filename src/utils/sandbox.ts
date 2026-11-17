/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Executes an LLM/user-generated dataset-transform function inside a fresh,
// sandboxed iframe (allow-scripts only, no allow-same-origin) instead of this
// page's own realm. Because the iframe gets an opaque origin, code running
// inside it cannot reach this page's document, cookies, or localStorage, and
// cannot navigate or deface the real page - it can only see the exact
// `dataset` value it is handed and return a replacement. This does not stop
// that code from exfiltrating the dataset slice it was given (it must see
// that data to transform it), but it removes the far larger blast radius of
// running attacker-influenced code with full access to the live session.
export function runSandboxedDatasetJs(jsCode: string, dataset: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const sandboxHtml = [
      '<!DOCTYPE html><html><body><script>',
      'window.addEventListener("message", function(event) {',
      '  try {',
      '    var fn = new Function("dataset", "return (" + event.data.jsCode + ")(dataset);");',
      '    var result = fn(event.data.dataset);',
      '    parent.postMessage({ __sandboxResult: true, ok: true, result: result }, "*");',
      '  } catch (e) {',
      '    parent.postMessage({ __sandboxResult: true, ok: false, error: (e && e.message) ? e.message : String(e) }, "*");',
      '  }',
      '});',
      '</' + 'script></body></html>'
    ].join('\n');

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.display = 'none';
    iframe.srcdoc = sandboxHtml;

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.parentNode?.removeChild(iframe);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || !event.data || !event.data.__sandboxResult) return;
      if (settled) return;
      settled = true;
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error || 'Sandboxed execution failed'));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Sandboxed script execution timed out after 5s'));
    }, 5000);

    window.addEventListener('message', onMessage);

    iframe.onload = () => {
      iframe.contentWindow?.postMessage({ jsCode, dataset }, '*');
    };

    document.body.appendChild(iframe);
  });
}
