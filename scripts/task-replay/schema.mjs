import { createHash } from 'node:crypto';
export const CHECK_IDS = ['goals_preserved', 'latest_corrections_preserved', 'pending_work_preserved', 'failed_approaches_preserved', 'verification_limits_preserved', 'uncertainty_preserved'];
export function stable(value) {
    if (Array.isArray(value))
        return value.map(stable);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    return value;
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
export const fail = code => { throw new Error(code); };
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, n = 48000) => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= n && !v.includes('\0');
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
function keys(v, allowed) { if (!plain(v) || Object.keys(v).some(k => !allowed.includes(k)))
    fail('invalid_spec_fields'); }
export function validateCase(v) {
    keys(v, ['id', 'kind', 'prompt', 'source', 'initialDraft', 'candidates', 'requirements', 'snapshot', 'snapshotDir', 'provenance', 'allowWrite', 'recipes', 'dockerImage']);
    if (!id(v.id) || !['memory', 'handoff'].includes(v.kind) || !text(v.prompt) || !Array.isArray(v.requirements) || !v.requirements.length || v.requirements.length > 40)
        fail('invalid_case');
    const seen = new Set();
    for (const r of v.requirements) {
        keys(r, ['id', 'description', 'critical']);
        if (!id(r.id) || seen.has(r.id) || !text(r.description, 4000) || typeof r.critical !== 'boolean')
            fail('invalid_requirement');
        seen.add(r.id);
    }
    if (v.kind === 'handoff' && (!text(v.source, 180000) || !text(v.initialDraft, 180000) || v.source.length > 48000 || v.initialDraft.length > 48000))
        fail('invalid_handoff_case');
    if (v.kind === 'memory') {
        if (!Array.isArray(v.candidates) || v.candidates.length > 48)
            fail('invalid_candidates');
        const ids = new Set();
        for (const r of v.candidates) {
            keys(r, ['id', 'title', 'text', 'conditions', 'kind', 'authority', 'revision']);
            if (!id(r.id) || ids.has(r.id) || !text(r.title, 640) || !text(r.text, 50000) || !text(r.kind, 160) || !text(r.authority, 256) || !integer(r.revision, 1, 1e9) || !Array.isArray(r.conditions) || r.conditions.length > 20 || r.conditions.some(s => !text(s, 4000)))
                fail('invalid_candidate');
            ids.add(r.id);
        }
    }
    if (v.allowWrite !== undefined && typeof v.allowWrite !== 'boolean')
        fail('invalid_write_policy');
    if (!Array.isArray(v.recipes ?? []) || (v.recipes ?? []).length > 12)
        fail('invalid_recipes');
    const recipeIds = new Set();
    for (const r of v.recipes ?? []) {
        keys(r, ['id', 'argv', 'timeoutMs', 'protectedPaths']);
        if (!id(r.id) || recipeIds.has(r.id) || !Array.isArray(r.argv) || !r.argv.length || r.argv.length > 40 || r.argv.some(s => !text(s, 4096)) || !integer(r.timeoutMs, 100, 300000) || !Array.isArray(r.protectedPaths) || !r.protectedPaths.length || r.protectedPaths.length > 40 || r.protectedPaths.some(s => !text(s, 1024) || s.includes('\\') || s.includes(':') || s.startsWith('/') || s.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')))
            fail('invalid_recipe');
        recipeIds.add(r.id);
    }
    if ((v.recipes ?? []).length && !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(v.dockerImage ?? ''))
        fail('pinned_docker_image_required');
    if (v.snapshot) {
        keys(v.snapshot, ['repoRoot', 'commit', 'mode']);
        if (!text(v.snapshot.repoRoot, 8192) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.snapshot.commit) || !['commit', 'working-tree'].includes(v.snapshot.mode))
            fail('invalid_snapshot_source');
    }
    if (v.snapshotDir !== undefined && !text(v.snapshotDir, 8192))
        fail('invalid_snapshot_directory');
    if (v.snapshot && v.snapshotDir)
        fail('ambiguous_snapshot_source');
    if (v.provenance) {
        keys(v.provenance, ['taskStartedAt', 'snapshotRecordedAtStart', 'evidence']);
        if (typeof v.provenance.snapshotRecordedAtStart !== 'boolean' || !text(v.provenance.evidence, 4000) || !Number.isFinite(Date.parse(v.provenance.taskStartedAt)))
            fail('invalid_provenance');
    }
    return structuredClone(v);
}
export function validateSuite(v) {
    keys(v, ['schemaVersion', 'id', 'primary', 'judge', 'decisions', 'limits', 'repeats', 'seed', 'cases', 'pricing']);
    if (v.schemaVersion !== 1 || !id(v.id) || !Array.isArray(v.cases) || !v.cases.length || v.cases.length > 100 || !integer(v.repeats, 1, 5) || !text(v.seed, 200))
        fail('invalid_suite');
    for (const p of [v.primary, v.judge]) {
        keys(p, ['model', 'effort', 'maxOutputTokens']);
        if (!text(p.model, 200) || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(p.effort) || !integer(p.maxOutputTokens, 128, 16384))
            fail('invalid_model');
    }
    keys(v.decisions, ['model']);
    if (v.decisions.model !== 'gpt-6-luna')
        fail('invalid_decisions_model');
    keys(v.limits, ['maxRequests', 'maxReworks', 'maxToolSteps', 'requestTimeoutMs', 'maxInputBytes', 'maxRunMs']);
    const l = v.limits;
    if (!integer(l.maxRequests, 1, 10000) || !integer(l.maxReworks, 0, 5) || !integer(l.maxToolSteps, 1, 30) || !integer(l.requestTimeoutMs, 1000, 180000) || !integer(l.maxInputBytes, 1024, 524288) || !integer(l.maxRunMs, 1000, 3600000))
        fail('invalid_limits');
    const cases = v.cases.map(validateCase);
    if (new Set(cases.map(c => c.id)).size !== cases.length)
        fail('duplicate_case_id');
    if (v.pricing !== undefined) {
        if (!plain(v.pricing) || Object.keys(v.pricing).length > 20) fail('invalid_pricing');
        for (const [model, rate] of Object.entries(v.pricing)) {
            if (!text(model, 200)) fail('invalid_pricing');
            keys(rate, ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion', 'cacheWritePerMillion', 'cacheWriteMode', 'source', 'asOf', 'currency']);
            for (const field of ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion', 'cacheWritePerMillion']) if (rate[field] !== undefined && (typeof rate[field] !== 'number' || !Number.isFinite(rate[field]) || rate[field] < 0 || rate[field] > 1000000)) fail('invalid_pricing');
            if (rate.source !== undefined && !text(rate.source, 2048) || rate.asOf !== undefined && !text(rate.asOf, 64) || rate.currency !== undefined && rate.currency !== 'USD' || rate.cacheWriteMode !== undefined && !['included', 'additional'].includes(rate.cacheWriteMode)) fail('invalid_pricing');
        }
    }
    return { ...structuredClone(v), cases };
}
export function validateVerdict(v, requirements) {
    if (!plain(v) || !Array.isArray(v.items) || v.items.length !== requirements.length)
        fail('invalid_judge_response');
    const ids = new Set();
    for (const x of v.items) {
        if (!plain(x) || ids.has(x.id) || !requirements.some(r => r.id === x.id) || !['met', 'missing', 'uncertain'].includes(x.status) || typeof x.evidence !== 'string' || x.evidence.length > 2000)
            fail('invalid_judge_response');
        ids.add(x.id);
    }
    const omittedIds = v.items.filter(x => x.status === 'missing').map(x => x.id), uncertainIds = v.items.filter(x => x.status === 'uncertain').map(x => x.id);
    return { accepted: !omittedIds.length && !uncertainIds.length, omittedIds, uncertainIds, criticalMissingIds: requirements.filter(r => r.critical && (omittedIds.includes(r.id) || uncertainIds.includes(r.id))).map(r => r.id), items: v.items };
}
export function verdictSchema(requirements) { return { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: requirements.length, maxItems: requirements.length, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', enum: requirements.map(r => r.id) }, status: { type: 'string', enum: ['met', 'missing', 'uncertain'] }, evidence: { type: 'string' } }, required: ['id', 'status', 'evidence'] } } }, required: ['items'] }; }
