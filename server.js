const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = ROOT;
const DBFILE = path.join(ROOT, 'data', 'db.json');
const PORT = process.env.PORT || 3000;
const sessions = new Map();

function emptyDB(){return {users:[], listings:[], matches:[]};}
function readDB(){ try { return JSON.parse(fs.readFileSync(DBFILE,'utf8')); } catch { const d=emptyDB(); writeDB(d); return d; } }
function writeDB(db){ fs.mkdirSync(path.dirname(DBFILE),{recursive:true}); fs.writeFileSync(DBFILE,JSON.stringify(db,null,2)); }
function id(prefix){return prefix+'_'+crypto.randomBytes(5).toString('hex')}
function json(res,status,obj){const s=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)});res.end(s)}
function getBody(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6)req.destroy()});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});req.on('error',reject)});}
function cookies(req){const out={};(req.headers.cookie||'').split(';').forEach(x=>{const i=x.indexOf('=');if(i>0)out[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1))});return out}
function auth(req){const sid=cookies(req).sid; if(!sid) return null; const uid=sessions.get(sid); if(!uid)return null; return readDB().users.find(u=>u.id===uid)||null}
function hashPassword(p,salt=crypto.randomBytes(16).toString('hex')){const h=crypto.scryptSync(p,salt,64).toString('hex');return {salt,hash:h}}
function safeUser(u){return {id:u.id,name:u.name,email:u.email,role:u.role,verified:!!u.verified,createdAt:u.createdAt}}
function isOwner(u){return !!u && u.role==='owner'}
function ownerExists(){return readDB().users.some(u=>u.role==='owner')}

function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()}
function locScore(a,b){a=norm(a);b=norm(b);if(!a||!b)return 0;if(a===b)return 30;const A=new Set(a.split(' ')),B=new Set(b.split(' '));let c=0;for(const x of A)if(B.has(x))c++;return c?15:0}
function dateScore(a,b){return a&&b&&a===b?30:0}
function scoreDriverTruck(d,t){let s=locScore(d.location,t.location)+dateScore(d.date,t.date);if((d.license||'').includes('A'))s+=20;if(d.hours&&t.hours)s+=Math.min(d.hours,t.hours)>=6?10:5;return s}
function scoreTruckLoad(t,l){let s=locScore(t.location,l.pickup)+dateScore(t.date,l.date);if(t.equipment===l.equipment)s+=25;if(!l.weight||!t.capacity||t.capacity>=l.weight)s+=15;return s}
function scoreWarehouse(w,n){let s=locScore(w.location,n.location);if(w.from&&n.from&&w.from<=n.from)s+=20;if(w.to&&n.to&&w.to>=n.to)s+=20;if(!n.pallets||w.pallets>=n.pallets)s+=20;return s}
function recomputeMatches(db){const open=db.listings.filter(x=>x.status==='open');const D=open.filter(x=>x.type==='driver'),T=open.filter(x=>x.type==='truck'),L=open.filter(x=>x.type==='load'),W=open.filter(x=>x.type==='warehouse'),S=open.filter(x=>x.type==='storage_need');const out=[];
 for(const t of T)for(const d of D){const s=scoreDriverTruck(d.data,t.data);if(s>=45)out.push({id:id('m'),kind:'driver_truck',score:s,listingIds:[d.id,t.id],createdAt:new Date().toISOString()})}
 for(const l of L)for(const t of T){const ts=scoreTruckLoad(t.data,l.data);if(ts>=50){out.push({id:id('m'),kind:'load_truck',score:ts,listingIds:[l.id,t.id],createdAt:new Date().toISOString()});for(const d of D){const ds=scoreDriverTruck(d.data,t.data);const total=Math.round((ts+ds)/2)+15;if(ds>=45&&total>=65)out.push({id:id('m'),kind:'load_truck_driver',score:Math.min(total,100),listingIds:[l.id,t.id,d.id],createdAt:new Date().toISOString()})}}}
 for(const sn of S)for(const w of W){const s=scoreWarehouse(w.data,sn.data);if(s>=45)out.push({id:id('m'),kind:'warehouse_storage',score:s,listingIds:[w.id,sn.id],createdAt:new Date().toISOString()})}
 out.sort((a,b)=>b.score-a.score);db.matches=out.slice(0,200);return db.matches;
}
function serveStatic(req,res,pathname){const allowed=new Set(['/','/index.html','/app.js','/style.css','/tut-emblem.png']);let p=pathname==='/'?'/index.html':pathname;if(!allowed.has(pathname)&&!allowed.has(p))return false;const f=path.join(PUBLIC,p.slice(1));if(!fs.existsSync(f)||fs.statSync(f).isDirectory())return false;const ext=path.extname(f);const ct={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.png':'image/png'}[ext]||'application/octet-stream';const b=fs.readFileSync(f);res.writeHead(200,{'Content-Type':ct,'Content-Length':b.length});res.end(b);return true}

const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,`http://${req.headers.host}`), p=url.pathname;
 try{
  if(p==='/api/health')return json(res,200,{ok:true});
  if(p==='/api/owner/status'&&req.method==='GET')return json(res,200,{ownerConfigured:ownerExists()});
  if(p==='/api/owner/setup'&&req.method==='POST'){
   const db=readDB(); if(db.users.some(u=>u.role==='owner'))return json(res,409,{error:'Owner account is already configured.'});
   const b=await getBody(req); if(!b.name||!b.email||!b.password||b.password.length<10)return json(res,400,{error:'Name, email and password (10+ chars) required.'});
   if(db.users.some(u=>u.email.toLowerCase()===String(b.email).toLowerCase()))return json(res,409,{error:'That email is already registered.'});
   const hp=hashPassword(b.password); const u={id:id('u'),name:String(b.name).trim(),email:String(b.email).trim().toLowerCase(),role:'owner',verified:true,...hp,createdAt:new Date().toISOString()};
   db.users.push(u); writeDB(db); const sid=id('s'); sessions.set(sid,u.id); res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`); return json(res,201,{user:safeUser(u)});
  }
  if(p==='/api/admin/summary'&&req.method==='GET'){
   const u=auth(req); if(!isOwner(u))return json(res,403,{error:'Owner access required.'}); const db=readDB();
   return json(res,200,{users:db.users.map(safeUser),listings:db.listings,matches:db.matches,stats:{users:db.users.length,openListings:db.listings.filter(x=>x.status==='open').length,matches:db.matches.length}});
  }
  if(p.startsWith('/api/admin/users/')&&p.endsWith('/verify')&&req.method==='POST'){
   const u=auth(req); if(!isOwner(u))return json(res,403,{error:'Owner access required.'}); const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid); if(!target)return json(res,404,{error:'User not found.'}); target.verified=true; writeDB(db); return json(res,200,{user:safeUser(target)});
  }
  if(p.startsWith('/api/admin/listings/')&&p.endsWith('/close')&&req.method==='POST'){
   const u=auth(req); if(!isOwner(u))return json(res,403,{error:'Owner access required.'}); const lid=p.split('/')[4],db=readDB(),x=db.listings.find(x=>x.id===lid); if(!x)return json(res,404,{error:'Listing not found.'}); x.status='closed'; recomputeMatches(db); writeDB(db); return json(res,200,{ok:true});
  }
  if(p==='/api/register'&&req.method==='POST'){
   const b=await getBody(req); if(!b.name||!b.email||!b.password||b.password.length<8)return json(res,400,{error:'Name, email and password (8+ chars) required.'});
   const db=readDB(); if(db.users.some(u=>u.email.toLowerCase()===b.email.toLowerCase()))return json(res,409,{error:'Email already registered.'});
   const hp=hashPassword(b.password); const u={id:id('u'),name:b.name.trim(),email:b.email.trim().toLowerCase(),role:b.role||'member',verified:false,...hp,createdAt:new Date().toISOString()};db.users.push(u);writeDB(db);const sid=id('s');sessions.set(sid,u.id);res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);return json(res,201,{user:safeUser(u)});
  }
  if(p==='/api/login'&&req.method==='POST'){
   const b=await getBody(req),db=readDB(),u=db.users.find(x=>x.email===String(b.email||'').toLowerCase());if(!u)return json(res,401,{error:'Invalid email or password.'});const hp=hashPassword(String(b.password||''),u.salt);if(!crypto.timingSafeEqual(Buffer.from(hp.hash,'hex'),Buffer.from(u.hash,'hex')))return json(res,401,{error:'Invalid email or password.'});const sid=id('s');sessions.set(sid,u.id);res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);return json(res,200,{user:safeUser(u)});
  }
  if(p==='/api/logout'&&req.method==='POST'){const sid=cookies(req).sid;if(sid)sessions.delete(sid);res.setHeader('Set-Cookie','sid=; Max-Age=0; Path=/');return json(res,200,{ok:true})}
  if(p==='/api/me'){const u=auth(req);return json(res,200,{user:u?safeUser(u):null})}
  if(p==='/api/listings'&&req.method==='GET'){const db=readDB();return json(res,200,{listings:db.listings.filter(x=>x.status==='open').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))})}
  if(p==='/api/listings'&&req.method==='POST'){
   const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const b=await getBody(req);const allowed=['driver','truck','load','warehouse','storage_need'];if(!allowed.includes(b.type)||!b.data)return json(res,400,{error:'Invalid listing.'});const db=readDB();const x={id:id('l'),userId:u.id,type:b.type,data:b.data,status:'open',createdAt:new Date().toISOString()};db.listings.push(x);recomputeMatches(db);writeDB(db);return json(res,201,{listing:x});
  }
  if(p.startsWith('/api/listings/')&&req.method==='DELETE'){
   const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const lid=p.split('/').pop(),db=readDB(),x=db.listings.find(x=>x.id===lid);if(!x)return json(res,404,{error:'Not found.'});if(x.userId!==u.id)return json(res,403,{error:'Not your listing.'});x.status='closed';recomputeMatches(db);writeDB(db);return json(res,200,{ok:true});
  }
  if(p==='/api/matches'&&req.method==='GET'){const db=readDB();recomputeMatches(db);writeDB(db);const map=Object.fromEntries(db.listings.map(x=>[x.id,x]));return json(res,200,{matches:db.matches.map(m=>({...m,listings:m.listingIds.map(i=>map[i]).filter(Boolean)}))})}
  if(p==='/api/demo'&&req.method==='POST'){
   let db=readDB();const demoUser=db.users.find(u=>u.email==='demo@tut.local')||(()=>{const hp=hashPassword('Demo12345');const u={id:id('u'),name:'Demo Market',email:'demo@tut.local',role:'carrier',verified:true,...hp,createdAt:new Date().toISOString()};db.users.push(u);return u})();
   const date='2026-08-25';db.listings=db.listings.filter(x=>x.userId!==demoUser.id);const add=(type,data)=>db.listings.push({id:id('l'),userId:demoUser.id,type,data,status:'open',createdAt:new Date().toISOString()});
   add('driver',{location:'Dallas, TX',date,hours:12,license:'CDL-A',experience:6,radius:40,endorsements:'Hazmat',minPay:320});add('driver',{location:'Fort Worth, TX',date,hours:10,license:'CDL-A',experience:4,radius:55,endorsements:'',minPay:300});add('truck',{location:'Dallas, TX',date,hours:12,equipment:"Dry Van 53'",capacity:45000,price:480,carrier:'Demo Carrier'});add('load',{pickup:'Dallas, TX',delivery:'Austin, TX',date,weight:32000,equipment:"Dry Van 53'",budget:1450,pallets:18});add('warehouse',{location:'Dallas, TX',from:'2026-08-22',to:'2026-09-30',pallets:220,price:1.8,capabilities:'Dock, forklift'});add('storage_need',{location:'Dallas, TX',from:'2026-08-27',to:'2026-09-05',pallets:80,budget:2.4,requirements:'Forklift'});recomputeMatches(db);writeDB(db);return json(res,200,{ok:true});
  }
  if(serveStatic(req,res,p))return;json(res,404,{error:'Not found'});
 }catch(e){console.error(e);json(res,500,{error:'Server error'})}
});
server.listen(PORT,()=>console.log(`TUT running at http://localhost:${PORT}`));
