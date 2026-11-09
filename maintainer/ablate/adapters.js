'use strict';

function cases(json) {
  if (!Array.isArray(json?.cases) || json.cases.length !== 1) throw new TypeError('Expected exactly one designated case');
  return json.cases;
}
function leg(options, runs) {
  if (!Number.isInteger(options?.seq) || options.seq < 1 || !['known-fail', 'null', 'full', 'placebo'].includes(options.arm)) throw new TypeError('Expected leg seq and arm');
  if (!Array.isArray(runs) || !runs.length) throw new TypeError('Missing per-run results');
  return {seq: options.seq, arm: options.arm, runs};
}
function fromLegacyRunner(json, options) {
  const runs = cases(json).flatMap(c => {
    if (!Array.isArray(c.runs)) throw new TypeError('Missing legacy runs');
    return c.runs.map(r => {
      const error = r.status === 'error';
      const judges = (r.assertions || []).filter(a => a.method === 'judge');
      return {judgePass: !error && judges.length > 0 && judges.every(a => a.passed === true), error, subjectText: null};
    });
  });
  return leg(options, runs);
}
function subjectText(run, judges) {
  const candidates = [run.subjectText, run.evidence, ...judges.map(g => g?.evidence)];
  for (const text of candidates) if (typeof text === 'string' && text.trim()) return text;
  // Only inline assistant messages qualify; tracePath alone is not captured text.
  const trace = Array.isArray(run.trace) ? run.trace : run.trace?.events;
  if (Array.isArray(trace)) {
    const replies = trace.filter(e => e.type === 'assistant' || e.role === 'assistant').map(e => {
      const content = e.message?.content ?? e.content;
      return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    }).filter(t => typeof t === 'string' && t.trim());
    if (replies.length) return replies.at(-1);
  }
  return null;
}
function fromPluginEval(json, options) {
  const runs = cases(json).flatMap(c => {
    if (c.name !== options?.caseName) {
      throw new TypeError(`Expected case name ${options?.caseName}; got ${c.name}`);
    }
    const source = c.arms?.with;
    if (!Array.isArray(source)) throw new TypeError('Missing plugin-eval with-arm runs');
    const definitions = (c.graders || []).filter(g => g.type === 'llm');
    return source.map(r => {
      const error = r.error !== null;
      const judges = definitions.map(d => (r.graders || []).find(g => g.name === d.name));
      return {judgePass: !error && judges.length > 0 && judges.every(g => g?.passed === true), error, subjectText: subjectText(r, judges)};
    });
  });
  return leg(options, runs);
}
module.exports = {fromPluginEval, fromLegacyRunner};
