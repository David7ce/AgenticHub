import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function inspect(env) {
  const code = `
    const runtime = await import('./acp/hub-env.mjs');
    const control = await import('./hubctl/common.mjs');
    const mcp = await import('./mcp/hub-process.mjs');
    const router = await import('./acp/router-config.mjs');
    const consent = await import('./acp/consent.mjs');
    const { gatherDoctor } = await import('./hubctl/doctor.mjs');
    const doctor = gatherDoctor({root:control.ROOT, hub:control.HUB, readJson:control.readJson, inflight:[], locks:[], fast:true});
    console.log(JSON.stringify({
      runtime:{registry:runtime.DEFAULT_REGISTRY,log:runtime.LOG_PATH,locks:runtime.LOCKS_DIR,inflight:runtime.INFLIGHT_DIR},
      control:{consent:control.CONSENT_PATH,log:control.LOG_PATH,locks:control.LOCKS_DIR,inflight:control.INFLIGHT_DIR},
      mcp:{registry:mcp.REGISTRY,consent:consent.CONSENT_PATH},
      router:{registry:router.DEFAULT_REGISTRY,log:router.DEFAULT_LOG}, doctor
    }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function isolatedEnv(dir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('AGENT_HUB_')) delete env[key];
  return { ...env, AGENT_HUB_REGISTRY:join(dir,'custom-registry.json'), AGENT_HUB_CONSENT:join(dir,'custom-consent.json'), AGENT_HUB_LOG:join(dir,'custom-runs.jsonl'), AGENT_HUB_RESULTS:join(dir,'output'), AGENT_HUB_STATE:join(dir,'state') };
}

test('dispatch, MCP, control-room views, routing and doctor use the same override paths', (t) => {
  const dir = sandbox(t), env = isolatedEnv(dir);
  writeFileSync(env.AGENT_HUB_REGISTRY, JSON.stringify({agents:{configured:{command:process.execPath}}}));
  writeFileSync(env.AGENT_HUB_CONSENT, JSON.stringify({configured:{enabled:false}}));
  const result = inspect(env);
  assert.equal(result.runtime.registry, env.AGENT_HUB_REGISTRY);
  assert.equal(result.router.registry, env.AGENT_HUB_REGISTRY);
  assert.equal(result.mcp.registry, env.AGENT_HUB_REGISTRY);
  assert.equal(result.control.consent, env.AGENT_HUB_CONSENT);
  assert.equal(result.mcp.consent, env.AGENT_HUB_CONSENT);
  assert.equal(result.runtime.log, env.AGENT_HUB_LOG);
  assert.equal(result.control.log, env.AGENT_HUB_LOG);
  assert.equal(result.router.log, env.AGENT_HUB_LOG);
  assert.equal(result.control.locks, join(env.AGENT_HUB_RESULTS,'locks'));
  assert.equal(result.control.inflight, join(env.AGENT_HUB_RESULTS,'inflight'));
  assert.equal(result.runtime.locks, result.control.locks);
  assert.equal(result.runtime.inflight, result.control.inflight);
  assert.ok(result.doctor.checks.some((row) => row.check==='registry' && row.level==='ok' && /1 agents/.test(row.detail)));
  assert.equal(result.doctor.checks.some((row) => row.check==='consent' && row.level==='fail'), false);
});

test('an explicit missing registry or consent is diagnosed rather than falling back', (t) => {
  const dir = sandbox(t), env = isolatedEnv(dir);
  const result = inspect(env);
  assert.ok(result.doctor.checks.some((row) => row.check==='registry' && row.level==='fail' && row.detail.includes(env.AGENT_HUB_REGISTRY)));
  assert.ok(result.doctor.checks.some((row) => row.check==='consent' && row.level==='fail' && row.detail.includes(env.AGENT_HUB_CONSENT)));
});

test('runtime path resolution preserves fallback and normalizes relative overrides', async (t) => {
  const { resolveHubConfig } = await import('../../acp/config.mjs');
  const dir=sandbox(t), hub=join(dir,'renamed hub');
  mkdirSync(join(hub,'acp'),{recursive:true});
  const example=join(hub,'acp','agents.example.json');
  writeFileSync(example,'{}');
  const defaults=resolveHubConfig({hubDir:hub,env:{},cwd:dir});
  assert.equal(defaults.registryPath,example);
  assert.equal(defaults.usingExampleRegistry,true);
  assert.equal(defaults.logPath,join(dir,'projects','logs','runs.jsonl'));
  writeFileSync(join(hub,'acp','agents.json'),'{}');
  assert.equal(resolveHubConfig({hubDir:hub,env:{},cwd:dir}).usingExampleRegistry,false);
  const selected=resolveHubConfig({hubDir:hub,cwd:dir,env:{AGENT_HUB_CONSENT:'other/consent.json',AGENT_HUB_REGISTRY:'missing.json',AGENT_HUB_STATE:'state',AGENT_HUB_RESULTS:'out',AGENT_HUB_INDEX:'index.db',AGENT_HUB_TASKS_DB:'queue.db'}});
  assert.equal(selected.consentPath,resolve(dir,'other/consent.json'));
  assert.equal(selected.registryPath,resolve(dir,'missing.json'));
  assert.equal(selected.usingExampleRegistry,false);
  assert.equal(selected.locksDir,resolve(dir,'out/locks'));
  assert.equal(selected.inflightDir,resolve(dir,'out/inflight'));
  assert.equal(selected.indexPath,resolve(dir,'index.db'));
  assert.equal(selected.tasksDb,resolve(dir,'queue.db'));
});

test('the direct ACP CLI honors the environment registry and an explicit CLI override', (t) => {
  const dir=sandbox(t), env=isolatedEnv(dir), alternate=join(dir,'alternate.json');
  writeFileSync(env.AGENT_HUB_REGISTRY,JSON.stringify({agents:{fromEnvironment:{command:process.execPath}}}));
  writeFileSync(alternate,JSON.stringify({agents:{fromFlag:{command:process.execPath}}}));
  function list(extra=[]) {
    const result=spawnSync(process.execPath,['acp/hub-acp.mjs','--list','--json',...extra],{cwd:repo,env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout).map((agent)=>agent.name);
  }
  assert.deepEqual(list(),['fromEnvironment']);
  assert.deepEqual(list(['--registry',alternate]),['fromFlag']);
});

test('router explanations use the explicit registry instead of the environment fallback chain', (t) => {
  const dir=sandbox(t), env=isolatedEnv(dir), alternate=join(dir,'alternate.json');
  writeFileSync(env.AGENT_HUB_REGISTRY,JSON.stringify({agents:{opencode:{command:process.execPath,defaultConfig:{model:'environment/model'}}}}));
  writeFileSync(alternate,JSON.stringify({agents:{opencode:{command:process.execPath,defaultConfig:{model:'explicit/model'}}}}));
  const result=spawnSync(process.execPath,['acp/router.mjs','--prompt','hello','--force','opencode','--no-health','--explain','--json','--registry',alternate],{cwd:repo,env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const route=JSON.parse(result.stdout);
  assert.ok(route.fallbacks.includes('explicit/model'));
  assert.equal(route.fallbacks.includes('environment/model'),false);
});
