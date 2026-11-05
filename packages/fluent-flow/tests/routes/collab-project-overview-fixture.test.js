import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

vi.mock('../../src/tracing.cjs',()=>({}));
vi.mock('../../src/logger.js',async()=>{
  const {createMockLogger}=await import('../helpers/mock-logger.js');
  return {default:createMockLogger()};
});
const {resolveCollabTestDatabaseUrl,resetCollabSchema}=await import('../helpers/collab-db.js');
const database=resolveCollabTestDatabaseUrl();
process.env.DATABASE_URL=database;
const db=await import('@fluent-flow/db');
const run=promisify(execFile);
const repo=resolve(import.meta.dirname,'../../../..');
let root,output;

async function seedFixture(){
  const seed=`import {pathToFileURL} from 'node:url';
    const [file,index,...args]=process.argv.slice(1);
    process.argv=[process.execPath,file,...args];
    await import(pathToFileURL(file).href);
    await (await import(pathToFileURL(index).href)).pool.end();`;
  await run(process.execPath,['--input-type=module','-e',seed,join(repo,'packages/db/scripts/collab-fixture.mjs'),join(repo,'packages/db/dist/index.js'),'--database',database,'--output',output],{timeout:20000});
}
async function overviews(){
  const {rows}=await db.getPool().query(`SELECT p.name,o.description,o.run_instructions,o.test_instructions
    FROM collab_project_overviews o JOIN collab_projects p ON p.id=o.project_id ORDER BY p.name`);
  return Object.fromEntries(rows.map(row=>[row.name,row]));
}

beforeAll(async()=>{
  await resetCollabSchema(database);
  root=mkdtempSync(join(tmpdir(),'ff-overview-fixture-'));
  output=join(root,'credentials.json');
},30000);
afterAll(async()=>{await db.closePool();rmSync(root,{recursive:true,force:true});});

it('seeds honest demo overviews once and preserves edited rows and credentials on re-run',async()=>{
  await seedFixture();
  const seeded=await overviews();
  expect(Object.keys(seeded)).toEqual(['Project A1','Project A2','Project B1']);
  expect(seeded['Project A1'].description).toMatch(/Node\.js arithmetic demo/);
  expect(seeded['Project A1'].description).toMatch(/no web server/i);
  expect(seeded['Project A1'].test_instructions).toMatch(/npm test/);
  expect(seeded['Project A1'].test_instructions).toMatch(/broken add/i);
  expect(seeded['Project A2'].description).toMatch(/permission/i);
  expect(seeded['Project A2'].run_instructions).toMatch(/no repository or execution host/i);
  expect(seeded['Project B1'].description).toMatch(/separate client/i);
  expect(seeded['Project B1'].run_instructions).toMatch(/no application/i);

  const credentials=JSON.parse(readFileSync(output,'utf8'));
  const ownerA=credentials.principals.find(item=>item.email==='fixture-owner-a@example.test');
  const projectA1=credentials.projects.find(item=>item.name==='Project A1');
  const {rows:[principal]}=await db.getPool().query('SELECT session_version FROM collab_principals WHERE id=$1',[ownerA.principalId]);
  const actor={principalId:ownerA.principalId,sessionVersion:principal.session_version};
  const current=await db.getCollabProjectOverview({actor,projectId:projectA1.id});
  expect(current.description).toBe(seeded['Project A1'].description);
  await db.updateCollabProjectOverview({actor,projectId:projectA1.id,expectedVersion:current.version,description:'Owner-edited overview'});
  const hashes=(await db.getPool().query('SELECT principal_id,password_hash FROM collab_password_credentials ORDER BY principal_id')).rows;
  await db.getPool().query(`DELETE FROM collab_project_overviews WHERE project_id=(SELECT id FROM collab_projects WHERE name='Project A2')`);

  await seedFixture();
  const reseeded=await overviews();
  expect(reseeded['Project A1'].description).toBe('Owner-edited overview');
  expect(reseeded['Project A1'].test_instructions).toBe(seeded['Project A1'].test_instructions);
  expect(reseeded['Project A2']).toEqual(seeded['Project A2']);
  expect(reseeded['Project B1']).toEqual(seeded['Project B1']);
  expect((await db.getPool().query('SELECT principal_id,password_hash FROM collab_password_credentials ORDER BY principal_id')).rows).toEqual(hashes);
  const rerunCredentials=JSON.parse(readFileSync(output,'utf8'));
  const passwords=list=>Object.fromEntries(list.principals.filter(item=>item.password).map(item=>[item.principalId,item.password]));
  expect(passwords(rerunCredentials)).toEqual(passwords(credentials));
},60000);
