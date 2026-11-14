import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const cli=fileURLToPath(new URL('./cli.mjs',import.meta.url));
test('retired live and credential flags are rejected before loading any files',()=>{
  for(const args of [['--live'],['--key-file','C:/not-a-real-key-file']]) {
    const result=spawnSync(process.execPath,[cli,'run','--bundle','C:/not-a-real-bundle',...args],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,1);
    assert.equal(JSON.parse(result.stderr).error,'live_execution_removed');
  }
});
test('actual CLI init/prepare/plan/run/report succeeds with JSON fixture and no network',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'replay-cli-'));
  t.after(async()=>{assert.ok(root.startsWith(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const run=(...args)=>{const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');return JSON.parse(r.stdout);};
  const specFile=path.join(root,'suite.json');run('init','--out',specFile);
  const spec=JSON.parse(await fs.readFile(specFile));spec.cases[0].initialDraft=spec.cases[0].source;spec.limits.maxReworks=0;spec.limits.maxToolSteps=1;spec.limits.maxRequests=10;await fs.writeFile(specFile,JSON.stringify(spec));
  const bundle=path.join(root,'bundle'),prepared=run('prepare','--spec',specFile,'--out',bundle);assert.equal(prepared.runs,2);
  assert.equal(run('plan','--bundle',bundle).minimumRequestsToStartPair,5);
  const usage={input_tokens:10,output_tokens:3,input_tokens_details:{cached_tokens:0}},response=text=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage});
  const steps=Array.from({length:2},()=>[{role:'primary',response:response('deliverable')},{role:'judge',response:response(JSON.stringify({items:[{id:'latest-correction',status:'met',evidence:'fixture'}]}))}]).flat();
  const fixture=path.join(root,'responses.json');await fs.writeFile(fixture,JSON.stringify({steps}));
  const result=run('run','--bundle',bundle,'--fixture',fixture);assert.equal(result.requests,4);assert.ok(result.runs.every(r=>r.status==='completed'));
  assert.equal(run('report','--bundle',bundle).status,'report_only_no_replay');
  const repeated=spawnSync(process.execPath,[cli,'run','--bundle',bundle,'--fixture',fixture],{encoding:'utf8',windowsHide:true});assert.equal(repeated.status,1);assert.equal(JSON.parse(repeated.stderr).error,'target_exists');
});
