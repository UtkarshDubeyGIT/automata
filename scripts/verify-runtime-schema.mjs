// Isolated migration smoke test. Supply AUTOMATA_PGLITE_MODULE when PGlite is
// installed outside this project; no application credentials or network are used.
const { PGlite } = await import(process.env.AUTOMATA_PGLITE_MODULE ?? "@electric-sql/pglite");
import fs from 'node:fs';
const db = new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text primary key,name text,public boolean); CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb default '{}'); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; GRANT USAGE ON SCHEMA auth TO authenticated,service_role;`);
for (const file of fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()) {
  if (file === '20260902080000_workflow_determinism.sql') {
    await db.exec("insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000003','legacy@example.com')");
    await db.exec(`insert into public.workflows(id,workspace_id,name,created_by,state,draft_graph)
      select '00000000-0000-4000-8000-000000000004',id,'Previous version','00000000-0000-4000-8000-000000000003','paused',
      '{"start":"start","steps":{"start":{"type":"manual_trigger","next":null}}}'::jsonb
      from public.workspaces where created_by='00000000-0000-4000-8000-000000000003'`);
    await db.exec(`insert into public.workflow_versions(id,workflow_id,workspace_id,version,graph,created_by)
      select '00000000-0000-4000-8000-000000000005',id,workspace_id,1,'{"nodes":[]}'::jsonb,created_by
      from public.workflows where id='00000000-0000-4000-8000-000000000004'`);
    await db.exec("update public.workflows set published_version_id='00000000-0000-4000-8000-000000000005' where id='00000000-0000-4000-8000-000000000004'");
  }
  try { await db.exec(fs.readFileSync(`supabase/migrations/${file}`,'utf8').replace(/create extension if not exists ["']?pgcrypto["']?;/gi,'')); console.log('PASS',file); }
  catch(error){ console.error('FAIL',file,error.message);process.exit(1); }
}

const legacy = await db.query("select config,draft_config,active from public.workflows where id='00000000-0000-4000-8000-000000000004'");
if(legacy.rows[0].draft_config?.graph?.start!=='start' || legacy.rows[0].config===null) throw Error('legacy draft graph was lost');
if(legacy.rows[0].active) throw Error('paused legacy graph became active');
const actor='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
await db.query("insert into auth.users(id,email) values($1,'owner@example.com'),($2,'other@example.com')",[actor,other]);
let rows=await db.query('select id,owner_id,onboarded from public.workspaces where created_by=$1',[actor]);
const workspace=rows.rows[0].id;
if(rows.rows[0].owner_id!==actor) throw Error('owner id missing');
// handle_new_user() inserts without naming `onboarded`, so the column default
// is the only thing marking a workspace as never set up. If this regresses to
// true, the first-run flow silently stops appearing for every new signup.
if(rows.rows[0].onboarded!==false) throw Error('new workspace should start un-onboarded');
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
await db.exec('set role authenticated');
rows=await db.query('select delta from public.credit_ledger where workspace_id=$1',[workspace]);
if(rows.rows.length!==1 || rows.rows[0].delta!==1000) throw Error('signup credits missing');
const config={graph:{start:'start',steps:{start:{type:'manual_trigger',next:null}}}};
rows=await db.query('insert into public.workflows(workspace_id,name,config,draft_config) values($1,$2,$3,$3) returning id,created_by',[workspace,'Fresh runtime',JSON.stringify(config)]);
const workflow=rows.rows[0].id;
if(rows.rows[0].created_by!==actor) throw Error('workflow creator missing');
await db.query("update public.workspaces set timezone='Asia/Kolkata' where id=$1",[workspace]);
rows=await db.query('select timezone from public.agent_settings where workspace_id=$1',[workspace]);
if(rows.rows[0].timezone!=='Asia/Kolkata') throw Error('timezone was not synchronized');
rows=await db.query("select public.enqueue_workflow_build($1,'build-key','Summarize a meeting',3) as build",[workspace]);
if(rows.rows[0].build.outcome!=='queued') throw Error('atomic build enqueue failed');
await db.exec('reset role; set role service_role');
rows=await db.query("insert into public.workflow_runs(workflow_id,idempotency_key,status,graph,log) values($1,'manual-key','queued',$2,$3) returning id,workspace_id",[workflow,JSON.stringify(config.graph),JSON.stringify({v:1,journal:[],context:{steps:{},input:{}}})]);
if(rows.rows[0].workspace_id!==workspace) throw Error('runtime tenant missing');
await db.query("update public.workflow_runs set status='completed' where id=$1",[rows.rows[0].id]);
await db.exec('reset role; set role authenticated');
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
rows=await db.query('select id from public.workflows where id=$1',[workflow]);
if(rows.rows.length) throw Error('cross-workspace workflow leak');
rows=await db.query('select delta from public.credit_ledger where workspace_id=$1',[workspace]);
if(rows.rows.length) throw Error('cross-workspace ledger leak');
let forbidden=false;
try {await db.query("insert into public.credit_ledger(workspace_id,delta,reason) values($1,100,'fake')",[workspace]);} catch {forbidden=true;}
if(!forbidden) throw Error('browser can forge credits');
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
forbidden=false;
try {await db.query("update public.workspaces set stripe_customer_id='cus_not_owned' where id=$1",[workspace]);} catch {forbidden=true;}
if(!forbidden) throw Error('browser can forge billing customer');
console.log('PASS signup, un-onboarded default, credit grant, workflow insert, timezone sync, paid build enqueue, service run insert/completion, cross-workspace isolation, browser ledger write denial');
await db.close();
