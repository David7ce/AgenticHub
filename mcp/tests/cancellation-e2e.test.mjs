import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { killTree } from '../../acp/process-utils.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, label, ms = 20000) {
  const deadline = Date.now() + ms;
  do {
    const result = read();
    if (result) return result;
    await sleep(30);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${label}`);
}

async function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-stop-'));
  const env = { ...process.env, HUB_CANCEL_WAIT_MS:'1000' };
  for (const [key, name] of Object.entries({REGISTRY:'agents.json',CONSENT:'consent.json',LOG:'runs.jsonl',INFLIGHT:'inflight',LOCKS:'locks',RESULTS:'results',STATE:'state'})) env[`AGENT_HUB_${key}`]=join(dir,name);
  const entry = { command:process.execPath, args:[FIXTURE], defaultConfig:{model:'fake/model-1'} };
  const agents = {fake:entry,other:entry,opencode:entry};
  writeFileSync(env.AGENT_HUB_REGISTRY, JSON.stringify({agents}));
  writeFileSync(env.AGENT_HUB_CONSENT, JSON.stringify(Object.fromEntries(Object.keys(agents).map((name)=>[name,{enabled:true,overseerAck:true,expires:'2099-01-01'}]))));
  const child=spawn(process.execPath,[SERVER],{env,stdio:['pipe','pipe','pipe']});
  const closed=new Promise((resolve)=>child.once('close',resolve));
  const pending=new Map(), replies=[];
  let nextId=1, stderr='';
  child.stderr.on('data',(chunk)=>{stderr+=chunk;});
  const reader=createInterface({input:child.stdout});
  reader.on('line',(line)=>{
    const reply=JSON.parse(line);replies.push(reply);
    pending.get(reply.id)?.(reply);pending.delete(reply.id);
  });
  const raw=(message)=>child.stdin.write(JSON.stringify(message)+'\n');
  const request=(method,params)=>{
    const id=nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`request ${id} timed out: ${stderr}`));},25000);
      pending.set(id,(reply)=>{clearTimeout(timer);resolve(reply);});
      raw({jsonrpc:'2.0',id,method,params});
    });
  };
  const records=()=>{try{return readFileSync(env.AGENT_HUB_LOG,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
  const inflight=()=>{try{return readdirSync(env.AGENT_HUB_INFLIGHT).map((name)=>JSON.parse(readFileSync(join(env.AGENT_HUB_INFLIGHT,name),'utf8')));}catch{return [];}};
  const ownedPids=new Set();
  const running=(count)=>until(()=>{
    const rows=inflight();for(const row of rows)ownedPids.add(row.pid);
    return rows.filter((row)=>row.sessionId).length>=count && rows;
  },`${count} active sessions`);
  t.after(async()=>{
    child.stdin.end();
    let timer;
    await Promise.race([closed,new Promise((resolve)=>{timer=setTimeout(resolve,18000);})]);clearTimeout(timer);
    if(child.exitCode===null && child.signalCode===null)killTree(child);
    // On a failing regression, clean only fixture processes observed in this
    // test's private inflight directory; never leave a HANG fixture behind.
    for(const {pid} of inflight()){if(ownedPids.has(pid)){try{killTree({pid,kill:(signal)=>process.kill(pid,signal)});}catch{}}}
    reader.close();
    rmSync(dir,{recursive:true,force:true});
  });
  const init=await request('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'cancel-test',version:'1'}});
  assert.equal(init.result.serverInfo.name,'agent-hub');
  return {dir,env,child,closed,raw,request,records,inflight,running,replies};
}
const call=(server,id,name,args)=>server.raw({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
const cancel=(server,id)=>server.raw({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}});

test('cancelling a routed call produces one cancelled audit record and no fallback', {timeout:40000}, async(t)=>{
  const server=await harness(t);
  call(server,9001,'route',{prompt:'HANG-ACK',run:true});
  await server.running(1);cancel(server,9001);
  await until(()=>server.records().length===1,'routed cancellation audit');
  const [record]=server.records();
  assert.equal(record.status,'cancelled');assert.equal(record.cancelAck,true);
  const after=await server.request('tools/call',{name:'ask_agent',arguments:{agent:'fake',prompt:'healthy'}});
  assert.equal(after.result.isError,false);
  assert.equal(server.records().length,2,'one cancelled attempt plus the health call');
  assert.equal(server.replies.some((reply)=>reply.id===9001),false);
  assert.equal(server.inflight().length,0);
});

test('fan-out cancellation preserves each verdict and records a cancelled aggregate', {timeout:40000}, async(t)=>{
  const server=await harness(t);
  call(server,9002,'fanout',{agents:['fake','other'],prompt:'HANG-ACK'});
  await server.running(2);cancel(server,9002);
  await until(()=>server.records().length===3,'fan-out cancellation audit');
  const records=server.records(), attempts=records.filter((row)=>row.mode!=='fanout');
  assert.equal(attempts.length,2);
  assert.ok(attempts.every((row)=>row.status==='cancelled' && row.cancelAck===true));
  const aggregate=records.find((row)=>row.mode==='fanout');
  assert.equal(aggregate.status,'cancelled');assert.equal(aggregate.cancelAck,true);
  assert.ok(aggregate.agents.every((row)=>row.cancelAck===true));
  assert.equal(server.replies.some((reply)=>reply.id===9002),false);
});

test('job_cancel does not claim the agent stopped when only its wrapper exited', {timeout:40000}, async(t)=>{
  const server=await harness(t);
  const started=await server.request('tools/call',{name:'ask_agent',arguments:{agent:'fake',prompt:'HANG-IGNORE',background:true}});
  const jobId=/job_[0-9a-f]+/.exec(started.result.content[0].text)[0];
  await server.running(1);
  const stopped=await server.request('tools/call',{name:'job_cancel',arguments:{jobId}});
  const text=stopped.result.content[0].text;
  assert.match(text,/may still be changing|did not confirm/);
  assert.doesNotMatch(text,/the callee stopped/);
  await until(()=>server.records().length===1,'background cancellation audit');
  assert.equal(server.records()[0].cancelAck,false);
});

test('closing the MCP connection cancels foreground work and background jobs before exit', {timeout:40000}, async(t)=>{
  const server=await harness(t);
  const foreground=join(server.dir,'foreground'),background=join(server.dir,'background');
  mkdirSync(foreground);mkdirSync(background);
  call(server,9003,'ask_agent',{agent:'fake',prompt:'HANG-ACK',cwd:foreground});
  const started=await server.request('tools/call',{name:'ask_agent',arguments:{agent:'other',prompt:'HANG-ACK',cwd:background,background:true}});
  assert.equal(started.result.isError,false);
  await server.running(2);
  call(server,9004,'ask_agent',{agent:'fake',prompt:'QUEUED-MUST-NOT-RUN',cwd:foreground});
  server.child.stdin.end();await server.closed;
  const records=server.records();
  assert.equal(records.length,2,'both runs are audited before the MCP server exits');
  assert.ok(records.every((row)=>row.status==='cancelled' && row.cancelAck===true));
  assert.equal(server.inflight().length,0);
});


test('a background job can be cancelled immediately after its id is returned', {timeout:40000}, async(t)=>{
  const server=await harness(t);
  const started=await server.request('tools/call',{name:'ask_agent',arguments:{agent:'fake',prompt:'HANG-ACK',background:true}});
  const jobId=/job_[0-9a-f]+/.exec(started.result.content[0].text)[0];
  const stopped=await server.request('tools/call',{name:'job_cancel',arguments:{jobId}});
  assert.equal(stopped.result.isError,false);
  await until(()=>server.records().length===1,'startup cancellation audit');
  assert.equal(server.records()[0].status,'cancelled');
  assert.equal(server.inflight().length,0);
});

test('fan-out retains an unconfirmed cancellation in its aggregate audit', {timeout:40000}, async(t)=>{
  const server=await harness(t);
  call(server,9005,'fanout',{agents:['fake','other'],prompt:'HANG-IGNORE'});
  await server.running(2);cancel(server,9005);
  await until(()=>server.records().length===3,'unconfirmed fan-out audit');
  const aggregate=server.records().find((row)=>row.mode==='fanout');
  assert.equal(aggregate.status,'cancelled');
  assert.equal(aggregate.cancelAck,false);
  assert.ok(aggregate.agents.every((row)=>row.cancelAck===false));
});

test('an acknowledged write cancellation releases its managed tree lock', {timeout:40000}, async(t)=>{
  const server=await harness(t), cwd=join(server.dir,'write-tree');
  mkdirSync(cwd);
  call(server,9006,'ask_agent',{agent:'fake',prompt:'HANG-ACK',cwd,permission:'allow-all'});
  await server.running(1);
  assert.equal(readdirSync(server.env.AGENT_HUB_LOCKS).filter((name)=>name.endsWith('.lock')).length,1);
  cancel(server,9006);
  await until(()=>server.records().length===1,'write cancellation audit');
  assert.equal(server.records()[0].cancelAck,true);
  assert.deepEqual(readdirSync(server.env.AGENT_HUB_LOCKS).filter((name)=>name.endsWith('.lock')),[]);
  const after=await server.request('tools/call',{name:'ask_agent',arguments:{agent:'fake',prompt:'healthy',cwd,permission:'allow-all'}});
  assert.equal(after.result.isError,false);
});
