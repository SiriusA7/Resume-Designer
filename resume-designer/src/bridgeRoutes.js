/**
 * Bridge Router
 *
 * Pure request routing for the companion-extension bridge: auth check +
 * endpoint logic, with every capability injected (see bridge.js for the real
 * deps). Pure so vitest can drive the full HTTP surface without Tauri.
 *
 * Contract with bridge.js / bridge.rs: input is {method, path, authorization,
 * body:string}; output is {status, body:object} — bridge.js stringifies body.
 */

const json = (status, body) => ({ status, body });

/** Own-key variant lookup — inherited keys (__proto__, constructor) must 404, not resolve. */
const findVariant = (variants, id) => (Object.hasOwn(variants, id) ? variants[id] : undefined);

/** "Backend Resume" -> "Backend-Resume.pdf" (safe cross-platform filename). */
function pdfFilename(name) {
  const base = String(name || 'Resume').trim().replace(/[^\p{L}\p{N} _.-]+/gu, '').replace(/\s+/g, '-');
  return `${base || 'Resume'}.pdf`;
}

export function createBridgeRouter(deps) {
  return async function handleBridgeRequest({ method, path, authorization, body }) {
    if (method === 'GET' && path === '/health') {
      return json(200, { ok: true, app: 'resume-designer', version: deps.version });
    }

    const token = deps.getToken();
    if (!token || authorization !== `Bearer ${token}`) {
      return json(401, { error: 'invalid or missing bearer token' });
    }

    let parsed = null;
    if (method === 'POST') {
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return json(400, { error: 'invalid JSON body' });
      }
    }

    try {
      if (method === 'GET' && path === '/resumes') {
        const resumes = Object.values(deps.getVariants())
          .map((v) => ({ id: v.id, name: v.name, updatedAt: v.updatedAt }))
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return json(200, { resumes });
      }

      const detail = method === 'GET' && path.match(/^\/resumes\/([^/]+)$/);
      if (detail) {
        const variant = findVariant(deps.getVariants(), detail[1]);
        if (!variant) return json(404, { error: `no resume with id ${detail[1]}` });
        return json(200, {
          id: variant.id,
          name: variant.name,
          updatedAt: variant.updatedAt,
          data: variant.data,
          profile: deps.getUserProfile(),
          learnedAnswers: deps.getLearnedAnswers(),
        });
      }

      const pdf = method === 'GET' && path.match(/^\/resumes\/([^/]+)\/pdf$/);
      if (pdf) {
        const variant = findVariant(deps.getVariants(), pdf[1]);
        if (!variant) return json(404, { error: `no resume with id ${pdf[1]}` });
        const pdfBase64 = await deps.exportVariantPdf(variant.id);
        return json(200, { filename: pdfFilename(variant.name), pdfBase64 });
      }

      if (method === 'POST' && path === '/ai/complete') {
        const messages = parsed.messages;
        const valid = Array.isArray(messages) && messages.length > 0
          && messages.every((m) => m && typeof m.role === 'string' && typeof m.content === 'string');
        if (!valid) return json(400, { error: 'messages must be a non-empty array of {role, content}' });
        try {
          const text = await deps.complete(messages, {
            systemPrompt: parsed.systemPrompt,
            reasoningEffort: parsed.reasoningEffort,
          });
          return json(200, { text });
        } catch (err) {
          return json(502, { error: err?.message || 'AI request failed' });
        }
      }

      if (method === 'POST' && path === '/applications') {
        // A destructive import is rewriting storage and awaiting its reload;
        // persisting now would serialize a stale cache over the restored keys.
        if (deps.writesSuspended?.()) return json(503, { error: 'a data import is in progress; retry after the app reloads' });
        const variantId = typeof parsed.variantId === 'string' ? parsed.variantId.trim() : '';
        if (!variantId) return json(400, { error: 'variantId is required' });
        const variant = findVariant(deps.getVariants(), variantId);
        if (!variant) return json(404, { error: `no resume with id ${variantId}` });
        const application = deps.addApplication({
          variantId,
          variantName: variant.name,
          jobSnapshot: {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            company: typeof parsed.company === 'string' ? parsed.company : '',
          },
          status: 'applied',
          notes: typeof parsed.notes === 'string' ? parsed.notes : '',
        });
        return json(201, { application });
      }

      if (method === 'POST' && path === '/profile/answers') {
        if (deps.writesSuspended?.()) return json(503, { error: 'a data import is in progress; retry after the app reloads' });
        const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
        const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
        if (!question || !answer) return json(400, { error: 'question and answer are required' });
        const saved = deps.saveLearnedAnswer(question, answer);
        return json(201, { answer: saved });
      }

      return json(404, { error: `no route: ${method} ${path}` });
    } catch (err) {
      return json(500, { error: err?.message || 'internal error' });
    }
  };
}
