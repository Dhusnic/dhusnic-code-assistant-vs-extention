'use strict';

/** Problems with a deployment config (empty when valid). */
function validate(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { return ['config must be a JSON object']; }
  if (typeof cfg.service !== 'string' || !cfg.service) { problems.push('service: required string'); }
  if (!Number.isInteger(cfg.replicas) || cfg.replicas < 1) { problems.push('replicas: whole number >= 1'); }
  if (cfg.env !== undefined && (typeof cfg.env !== 'object' || Array.isArray(cfg.env))) { problems.push('env: must be an object'); }
  return problems;
}

module.exports = { validate };
