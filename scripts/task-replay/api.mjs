import { performance } from 'node:perf_hooks';
import { digest, fail, CHECK_IDS } from './schema.mjs';
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
export function normalizeUsage(u) {
    return { inputTokens: count(u?.input_tokens), outputTokens: count(u?.output_tokens), cachedInputTokens: count(u?.input_tokens_details?.cached_tokens), cacheWriteTokens: count(u?.input_tokens_details?.cache_write_tokens) };
}
export function createFixtureClient({ limits, pricing = {}, fetchImpl, signal, onCall = () => { }, budget = { used: 0 } }) {
    if (typeof fetchImpl !== 'function' || fetchImpl === globalThis.fetch)
        fail('offline_transport_required');
    const post = async (path, role, body) => {
        if (budget.used >= limits.maxRequests)
            fail('request_limit');
        const data = JSON.stringify(body);
        if (Buffer.byteLength(data) > limits.maxInputBytes)
            fail('request_input_limit');
        if (signal?.aborted)
            fail('interrupted');
        const timeout = AbortSignal.timeout(limits.requestTimeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const event = { role, model: body.model, requestIndex: ++budget.used, requestHash: digest(data), startedAt: new Date().toISOString(), queueMs: null, status: 'unknown', usage: normalizeUsage(null), pricing: pricing[body.model] ?? null };
        const started = performance.now();
        await onCall({ ...event, phase: 'started', elapsedMs: null });
        try {
            const response = await fetchImpl(`fixture:///${path}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: data, signal: combined });
            event.responseId = response.headers?.get?.('x-request-id') ?? null;
            if (!response.ok) {
                event.status = 'failed';
                fail(`api_http_${response.status}`);
            }
            const reader = response.body.getReader();
            let size = 0;
            const parts = [];
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    size += value.length;
                    if (size > 2097152)
                        fail('api_response_limit');
                    parts.push(value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
            }
            let result;
            try {
                result = JSON.parse(Buffer.concat(parts).toString('utf8'));
            }
            catch {
                fail('api_invalid_json');
            }
            event.usage = normalizeUsage(result.usage);
            event.returnedModel = typeof result.model === 'string' ? result.model : null;
            event.serviceTier = typeof result.service_tier === 'string' ? result.service_tier : null;
            event.status = 'completed';
            event.responseId = result.id ?? event.responseId;
            return result;
        }
        catch (error) {
            const code = /^api_(http_[0-9]{3}|invalid_json|response_limit)$/.test(error.message) ? error.message : signal?.aborted ? 'interrupted' : timeout.aborted ? 'api_timeout' : 'api_transport_unknown';
            event.error = code;
            throw new Error(code);
        }
        finally {
            event.elapsedMs = Math.round(performance.now() - started);
            await onCall({ ...event, phase: 'settled' });
        }
    };
    return {
        get requests() { return budget.used; },
        response({ role = 'primary', model, effort, maxOutputTokens, instructions, input, tools = [], schema }) {
            return post('responses', role, { model, instructions, input, tools, parallel_tool_calls: false, store: false, stream: false, service_tier: 'default', include: ['reasoning.encrypted_content'], reasoning: { effort }, max_output_tokens: maxOutputTokens, ...(schema ? { text: { format: { type: 'json_schema', name: 'replay_verdict', strict: true, schema } } } : {}) });
        },
        decisions(body) { return post('decisions', 'decisions', body); },
    };
}
export function outputText(response) {
    if (response?.status !== 'completed' || !Array.isArray(response.output))
        fail('model_response_incomplete');
    return response.output.filter(x => x.type === 'message').flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text).join('\n');
}
export function validateContract(c) {
    if (c?.version !== 1 || c.model !== 'gpt-6-luna' || !['boundary', 'memoryRelevance', 'memoryApplicability', 'handoffSuffix'].every(k => typeof c[k] === 'string') || JSON.stringify(c.checks?.map(r => r[0])) !== JSON.stringify(CHECK_IDS) || !Array.isArray(c.choices) || c.choices.length !== 3)
        fail('invalid_decisions_contract');
    return c;
}
export function decisionsBody(contract, operation, value) {
    const c = validateContract(contract), questions = [];
    if (operation === 'rank_memory')
        for (let i = 0; i < value.candidates.length; i++) {
            questions.push({ type: 'predicate', name: `r${i}`, instructions: c.boundary + c.memoryRelevance.replaceAll('{index}', String(i)) });
            questions.push({ type: 'choice', name: `a${i}`, instructions: c.boundary + c.memoryApplicability.replaceAll('{index}', String(i)), choices: c.choices });
        }
    else if (operation === 'check_handoff')
        for (const [id, q] of c.checks)
            questions.push({ type: 'predicate', name: id, instructions: c.boundary + q + c.handoffSuffix });
    else
        fail('invalid_decisions_operation');
    return { model: c.model, input: [{ role: 'user', content: [{ type: 'input_json', data: value }] }], questions };
}
export function decisionsAnswers(response, body) {
    if (response?.model !== body.model || !Array.isArray(response.answers) || response.answers.length !== body.questions.length)
        fail('decisions_invalid_response');
    const out = new Map(), p = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
    for (const answer of response.answers) {
        const q = body.questions.find(q => q.name === answer.name);
        if (!q || out.has(answer.name))
            fail('decisions_invalid_response');
        if (answer.type === 'refusal') {
            out.set(answer.name, null);
            continue;
        }
        if (answer.type !== q.type)
            fail('decisions_invalid_response');
        if (q.type === 'predicate' && !p(answer.probability))
            fail('decisions_invalid_response');
        if (q.type === 'choice' && (!q.choices.some(c => c.value === answer.choice) || !p(answer.confidence)))
            fail('decisions_invalid_response');
        out.set(answer.name, answer);
    }
    return out;
}
// Deliberately matches the conservative 0.13.33 policy, not the rejected
// all-candidate classifier. The policy identifier is frozen in every bundle.
export async function assistMemory({ client, contract, query, records }) {
    const eligible = records.slice(0, 16).filter(r => r.conditions.length === 0);
    if (records.length < 2 || eligible.length < 2)
        return { records, status: 'skipped', reason: records.length < 2 ? 'single_candidate' : 'conditional_candidates' };
    if (query.length > 1024 || eligible.some(r => r.title.length > 160))
        return { records, status: 'skipped', reason: 'input_limit' };
    const candidates = eligible.map(({ id, title, text, kind, authority }) => ({ id, title, text: text.length <= 2400 ? text : '[正文未提供：超出长度限制；仅依据标题，内容不完整]', kind, authority, conditions: [] }));
    const body = decisionsBody(contract, 'rank_memory', { query, candidates }), answers = decisionsAnswers(await client.decisions(body), body);
    const scores = new Map(eligible.map((r, i) => [r.id, { relevance: answers.get(`r${i}`)?.probability, applicability: answers.get(`a${i}`)?.choice }]));
    const movable = r => r.conditions.length === 0 && scores.get(r.id)?.applicability === 'applicable' && typeof scores.get(r.id)?.relevance === 'number';
    const sorted = records.slice(0, 16).filter(movable).sort((a, b) => scores.get(b.id).relevance - scores.get(a.id).relevance);
    let j = 0;
    const ordered = [...records.slice(0, 16).map(r => movable(r) ? sorted[j++] : r), ...records.slice(16)];
    return { records: ordered, status: ordered.some((r, i) => r !== records[i]) ? 'applied' : 'unchanged' };
}
export async function assistHandoff({ client, contract, source, draft }) {
    if (source === draft)
        return { status: 'skipped', reason: 'same_source', checks: [] };
    const body = decisionsBody(contract, 'check_handoff', { source, draft, sourceTruncated: true }), answers = decisionsAnswers(await client.decisions(body), body);
    return { status: 'completed', checks: CHECK_IDS.map(id => ({ id, probability: answers.get(id)?.probability ?? null })), sourceTruncated: true };
}
