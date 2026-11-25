import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnHub, parseHubJson, runHubScript, hubArgsFor } from '../hub-process.mjs';

test('native mode is forwarded as a config option', () => {
  const { args } = hubArgsFor({ agent: 'codex', mode: 'read-only' });
  const index = args.indexOf('--config');
  assert.ok(index >= 0);
  assert.equal(args[index + 1], 'mode=read-only');
});

function run(t, code, options) {
  const result=spawnHub('--input-type=module',['-e',code],options);
  t.after(() => { if (result.child.exitCode===null && result.child.signalCode===null) result.child.kill(); });
  return result.exit;
}

test('captured output preserves valid UTF-8 JSON across stream chunks', async (t) => {
  const result=await run(t, `
    const b=Buffer.from(JSON.stringify({ok:true,text:'café'}));
    const split=b.indexOf(0xc3)+1;
    process.stdout.write(b.subarray(0,split));
    setTimeout(()=>process.stdout.end(b.subarray(split)),10);
  `,{maxOutputBytes:128});
  assert.equal(result.code,0);
  assert.deepEqual(parseHubJson(result,'fixture'),{ok:true,text:'café'});
});

test('stdout overflow is bounded and requests graceful cancellation', {timeout:5000}, async (t) => {
  const result=await run(t, `
    const watchdog=setTimeout(()=>{process.exitCode=77;process.disconnect();},1000);
    process.on('message',(message)=>{
      if(message.type==='cancel') {
        clearTimeout(watchdog);
        process.stderr.write('CANCEL_OBSERVED');
        process.disconnect();
      }
    });
    process.stdout.write('x'.repeat(8192));
  `,{maxOutputBytes:128});
  assert.equal(result.code,0,'the IPC cancellation arrived before the watchdog');
  assert.match(result.stderr,/CANCEL_OBSERVED/);
  assert.ok(Buffer.byteLength(result.stdout)<=128);
  assert.throws(()=>parseHubJson(result,'fixture'),/stdout.*128.*limit/i);
});

test('stderr overflow cannot be hidden by otherwise valid stdout JSON', async (t) => {
  const result=await run(t,"process.stderr.write('x'.repeat(8192));process.stdout.write('{\"ok\":true}');",{maxOutputBytes:128});
  assert.ok(Buffer.byteLength(result.stderr)<=128);
  assert.throws(()=>parseHubJson(result,'fixture'),/stderr.*128.*limit/i);
});

test('runHubScript rejects an oversized result instead of returning truncated success', async () => {
  await assert.rejects(runHubScript('--input-type=module',['-e',"process.stdout.write(JSON.stringify({ok:true,text:'x'.repeat(8192)}));"],{maxOutputBytes:128}),/stdout.*128.*limit/i);
});
