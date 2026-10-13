import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import type { WorldHost, ToolCallContext } from 'cortico/core/types.ts';
import { dshMemoryDefaults, LEVELS } from '../src/config.ts';
import { DshMemoryWorld } from '../src/world.ts';

function fixture() {
  const root = resolve('scratch/tests'); mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, 'world-v4-'));
  const dbFile = join(dir, 'memory.db'), db = new DatabaseSync(dbFile); db.exec('PRAGMA journal_mode=WAL;');
  for (const level of LEVELS) {
    const extra = ['soul','user'].includes(level) ? '' : level === 'project' ? ',project TEXT,subcategory TEXT' : level === 'lesson' ? ',project TEXT,corrected INTEGER DEFAULT 0' : level === 'topic' ? ',project TEXT,goal TEXT' : ',project TEXT';
    db.exec(`CREATE TABLE "${level}" (id TEXT PRIMARY KEY,title TEXT,content TEXT NOT NULL,importance INTEGER DEFAULT 1,keywords TEXT DEFAULT '[]',status TEXT DEFAULT 'active',source_session TEXT,created_at INTEGER,updated_at INTEGER,hit_count INTEGER DEFAULT 0,last_accessed_at INTEGER${extra})`);
  }
  const cfg = { ...dshMemoryDefaults(), enabled: true, dbFile, allowedProjects: 'a,b', levels: 'fact,topic', rawEnabled: false, watchTrigger: 'debounce', watchIntervalSeconds: 0, writeFlushSeconds: 1000, watchMaxPerTick: 2, stateDir: join(dir,'runtime') };
  const insert = (id: string, ts: number, project = 'a', content = 'fixture') => db.prepare("INSERT INTO fact(id,content,created_at,updated_at,project) VALUES(?,?,?,?,?)").run(id, content, ts, ts, project);
  const events: any[] = [];
  const host = { store: { grep: ({ keyword }: any) => events.filter(e => e.text.includes(keyword)).map(e => ({ hitCursor: e.cursor, events: [e] })) },
    pushEvent: async (e: any) => { const event = { ...e, cursor: events.length + 1 }; events.push(event); return event; } } as unknown as WorldHost;
  const world = () => new DshMemoryWorld(cfg);
  return { dir, db, cfg, insert, events, host, world };
}
const remember = async (w: DshMemoryWorld, content = 'fixture queued') => JSON.parse(await w.tools().find(t=>t.name==='dshmemory_remember')!.handler({level:'fact',project:'a',content,keywords:['fixture']},{} as ToolCallContext) as string);

test('composite cursor pages all allowed projects and catches late lower-ID commit at same timestamp', async () => {
  const f=fixture(),w=f.world();f.insert('history',10);await w.start(f.host);assert.equal(await w.pollOnce(),0);
  for(const id of ['b','c','d','e','f'])f.insert(id,20,id==='d'?'b':'a');
  assert.equal(await w.pollOnce(),2);assert.equal(await w.pollOnce(),2);await w.stop();
  const restarted=f.world();await restarted.start(f.host);assert.equal(await restarted.pollOnce(),1);
  f.insert('a',20);assert.equal(await restarted.pollOnce(),1);assert.equal(await restarted.pollOnce(),0);
  assert.deepEqual(f.events.flatMap(e=>e.meta.entries.map((r:any)=>r.id)),['b','c','d','e','f','a']);
  await restarted.stop();f.db.close();
});
test('failed push persists frozen intent across restart and mutation of source', async () => {
  const f=fixture(),w=f.world();await w.start({...f.host,pushEvent:async()=>{throw new Error('offline');}});
  f.insert('new',50,'a','original body');assert.equal(await w.pollOnce(),0);assert.ok(w.status().watch.pendingDelivery);await w.stop();
  f.db.prepare('UPDATE fact SET content=?,updated_at=? WHERE id=?').run('changed after failure',51,'new');
  const restarted=f.world();await restarted.start(f.host);assert.equal(await restarted.pollOnce(),1);
  assert.ok(f.events[0].text.includes('original body'));assert.ok(!f.events[0].text.includes('changed after failure'));
  assert.equal(await restarted.pollOnce(),1);await restarted.stop();f.db.close();
});
test('receipt recovery does not resend when event persisted but cursor checkpoint fails', async () => {
  const f=fixture(),w=f.world();await w.start(f.host);f.insert('new',100);
  const runtime=(w as any).runtime,save=runtime.save.bind(runtime);let fail=true;
  runtime.save=(s:any)=>{if(fail&&f.events.length&&s.pendingDelivery===null){fail=false;throw new Error('checkpoint interrupted');}save(s);};
  assert.equal(await w.pollOnce(),0);assert.equal(f.events.length,1);assert.ok(w.status().watch.pendingDelivery);
  await w.stop();const restarted=f.world();await restarted.start(f.host);assert.equal(await restarted.pollOnce(),1);
  assert.equal(f.events.length,1);assert.equal(restarted.status().counters.pushedEvents,1);await restarted.stop();f.db.close();
});
test('locked write queue survives stop and process replacement, then writes exactly once', async () => {
  const f=fixture(),w=f.world();await w.start(f.host);const queued=await remember(w);assert.equal(queued.queued,true);
  f.db.exec('BEGIN IMMEDIATE;');assert.equal(await w.flush(),0);await w.stop();
  assert.equal(JSON.parse(readFileSync(join(f.cfg.stateDir,'checkpoint.json'),'utf8')).queue.length,1);
  f.db.exec('ROLLBACK;');const restarted=f.world();await restarted.start(f.host);assert.equal(await restarted.flush(),1);
  assert.equal(f.db.prepare('SELECT count(*) as n FROM fact WHERE id=?').get(queued.id)!.n,1);
  assert.equal(restarted.status().write.pending,0);await restarted.stop();f.db.close();
});
test('DB commit before checkpoint failure is recovered idempotently without a duplicate row', async () => {
  const f=fixture(),w=f.world();await w.start(f.host);const queued=await remember(w);
  const runtime=(w as any).runtime,save=runtime.save.bind(runtime);let fail=true;
  runtime.save=(s:any)=>{if(fail&&s.queue.length===0){fail=false;throw new Error('queue checkpoint interrupted');}save(s);};
  assert.equal(await w.flush(),0);assert.equal(w.status().write.pending,1);
  assert.equal(await w.flush(),1);assert.equal(f.db.prepare('SELECT count(*) as n FROM fact WHERE id=?').get(queued.id)!.n,1);
  await w.stop();f.db.close();
});
test('durable enqueue failure is not acknowledged and damaged checkpoint remains untouched', async () => {
  const f=fixture(),w=f.world();await w.start(f.host);const runtime=(w as any).runtime;runtime.save=()=>{throw new Error('disk blocked');};
  const outcome=await w.tools().find(t=>t.name==='dshmemory_remember')!.handler({level:'fact',project:'a',content:'x',keywords:['x']},{} as ToolCallContext) as any;
  assert.equal(outcome.failed,true);assert.equal(w.status().write.pending,0);await w.stop();
  const path=join(f.cfg.stateDir,'checkpoint.json');writeFileSync(path,'corrupt');await assert.rejects(f.world().start(f.host));assert.equal(readFileSync(path,'utf8'),'corrupt');f.db.close();
});
test('stop waits for an in-flight delivery before closing and persists its cursor', async () => {
  const f=fixture(),w=f.world();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  await w.start({...f.host,pushEvent:async(e)=>{await gate;return f.host.pushEvent(e);}});f.insert('new',100);
  const poll=w.pollOnce(),stop=w.stop();let stopped=false;void stop.then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);
  release();await poll;await stop;const restarted=f.world();await restarted.start(f.host);assert.equal(await restarted.pollOnce(),0);assert.equal(f.events.length,1);await restarted.stop();f.db.close();
});
test('enabled idle components report online while disabled timers report offline', async () => {
  const f=fixture(),w=f.world();await w.start(f.host);const lamps=w.console().lamps!;
  assert.deepEqual(lamps.map(l=>l.state),['online','offline','online','offline']);assert.equal(w.status().write.writtenRows,0);
  await w.stop();assert.ok(w.console().lamps!.every(l=>l.state==='offline'));f.db.close();
});
test('tool scrubbing preserves full memory IDs and blocks source-text secrets', async () => {
  const f=fixture(),w=f.world(),id='abc-'+ 'a'.repeat(32);f.insert(id,10,'a','password="example-secret-123456"');await w.start(f.host);
  const value=JSON.parse(await w.tools().find(t=>t.name==='dshmemory_read')!.handler({id,level:'fact',project:'a'},{} as ToolCallContext) as string);
  assert.equal(value.memory.id,id);assert.ok(!value.memory.content.includes('example-secret-123456'));await w.stop();f.db.close();
});
test('turning raw off keeps the same scope and the persistent write queue', async () => {
  const f=fixture();f.cfg.rawEnabled=true;
  const w=f.world();await w.start(f.host);const queued=await remember(w);
  f.db.exec('BEGIN IMMEDIATE;');await w.stop();f.db.exec('ROLLBACK;');f.cfg.rawEnabled=false;
  const restarted=f.world();await restarted.start(f.host);assert.equal(restarted.status().write.pending,1);assert.equal(restarted.status().raw.enabled,false);
  assert.equal(await restarted.flush(),1);assert.equal(f.db.prepare('SELECT count(*) as n FROM fact WHERE id=?').get(queued.id)!.n,1);await restarted.stop();f.db.close();
});
test('an audit failure is a runtime fault after a successful delivery, not an unconfirmed delivery', async () => {
  const f=fixture(),w=f.world();await w.start(f.host);f.insert('new',100);
  const runtime=(w as any).runtime,audit=runtime.audit.bind(runtime);runtime.audit=(kind:string,meta:any)=>{if(kind==='delivery')throw new Error('journal disk blocked');audit(kind,meta);};
  assert.equal(await w.pollOnce(),1);assert.equal(w.status().watch.pendingDelivery,null);assert.equal(w.status().watch.error,null);
  assert.ok(w.status().runtime.error);assert.equal(await w.pollOnce(),0);assert.equal(f.events.length,1);await w.stop();f.db.close();
});
test('a bounded raw Worker batch stays healthy and continues from its persisted source cursor', async () => {
  const f=fixture();f.cfg.rawEnabled=true;
  Object.assign(f.cfg,{sessionsDir:join(f.dir,'sessions'),rawDir:join(f.dir,'raw'),rawMaxSourceBytes:3200,rawSyncIntervalSeconds:0});
  const bucket='--F-AI-C--',dir=join((f.cfg as any).sessionsDir,bucket,'session-a');mkdirSync(dir,{recursive:true});
  const events=[{type:'session',version:3,id:'session-a',createdAt:100},
    {type:'user/message',seq:1,time:100,data:{source:{kind:'user'},content:[{type:'text',text:'question'}]}},
    {type:'assistant/message',seq:2,time:101,data:{message:{content:[{type:'text',text:randomBytes(3000).toString('base64')}]}}}];
  writeFileSync(join(dir,'session.v3.jsonl.zstd'),Buffer.concat(events.map(e=>zstdCompressSync(JSON.stringify(e)+'\n'))));
  const w=f.world();await w.start(f.host);const result=await w.syncRawOnce();assert.equal(result.capped,true);assert.equal(result.budgetLimited,true);assert.equal(result.newTurns,1);
  assert.equal(w.status().raw.error,null);assert.ok(w.status().raw.lastSuccessAt);assert.equal(w.console().lamps!.at(-1)!.state,'online');
  (w as any).access.rawMaxSourceBytes=65536;const next=await w.syncRawOnce();assert.equal(next.capped,false);assert.equal(w.status().raw.totalTurns,2);
  await w.stop();f.db.close();
});
