const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const DBFILE = path.join(ROOT, 'data', 'db.json');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const PORT = process.env.PORT || 3000;
const sessions = new Map();

function emptyDB(){return {users:[], listings:[], offers:[], bookings:[], matches:[], verifications:[], settings:{brandName:'TUT Move',siteUrl:'https://tutmove.com',platformFeePct:5,defaultCurrency:'USD',ownerName:'',ownerEmail:'',legalEntity:'',supportEmail:'',launchMarkets:['USA','Canada','Europe','Middle East']}};}
function readDB(){try{const d=JSON.parse(fs.readFileSync(DBFILE,'utf8'));return {...emptyDB(),...d,settings:{...emptyDB().settings,...(d.settings||{})}}}catch{const d=emptyDB();writeDB(d);return d}}
function writeDB(db){fs.mkdirSync(path.dirname(DBFILE),{recursive:true});fs.writeFileSync(DBFILE,JSON.stringify(db,null,2));}
function id(prefix){return prefix+'_'+crypto.randomBytes(6).toString('hex')}
function json(res,status,obj){const s=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s),'Cache-Control':'no-store'});res.end(s)}
function getBody(req,limit=8e6){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>limit){reject(new Error('Request too large'));req.destroy()}});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});req.on('error',reject)});}
function cookies(req){const out={};(req.headers.cookie||'').split(';').forEach(x=>{const i=x.indexOf('=');if(i>0)out[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1))});return out}
function auth(req){const sid=cookies(req).sid;if(!sid)return null;const uid=sessions.get(sid);if(!uid)return null;return readDB().users.find(u=>u.id===uid)||null}
function hashPassword(p,salt=crypto.randomBytes(16).toString('hex')){const h=crypto.scryptSync(p,salt,64).toString('hex');return {salt,hash:h}}
function safeUser(u){return {id:u.id,name:u.name,email:u.email,role:u.role,roles:u.roles||[u.role],country:u.country||'',region:u.region||'',language:u.language||'en',currency:u.currency||'USD',verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started',createdAt:u.createdAt}}
function isOwner(u){return !!u&&u.role==='owner'}
function ownerExists(){return readDB().users.some(u=>u.role==='owner')}
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()}
function locScore(a,b){a=norm(a);b=norm(b);if(!a||!b)return 0;if(a===b)return 35;const A=new Set(a.split(' ')),B=new Set(b.split(' '));let c=0;for(const x of A)if(B.has(x))c++;return c?18:0}
function dateScore(a,b){if(!a||!b)return 10;return a===b?30:0}
function resourcePair(a,b){return a.resource===b.resource && a.intent!==b.intent}
function compatible(a,b){
  if(a.status!=='open'||b.status!=='open'||a.id===b.id)return 0;
  let s=0;
  if(resourcePair(a,b)) s+=45; else {
    const combo = new Set([a.resource,b.resource]);
    if(combo.has('load')&&combo.has('truck'))s+=35;
    else if(combo.has('driver')&&combo.has('truck'))s+=35;
    else if(combo.has('warehouse')&&combo.has('storage'))s+=35;
    else return 0;
  }
  const ad=a.data||{},bd=b.data||{};
  s+=locScore(ad.location||ad.pickup,bd.location||bd.pickup);
  s+=dateScore(ad.date||ad.from,bd.date||bd.from);
  if(a.country&&b.country&&a.country===b.country)s+=10;
  return Math.min(100,s);
}
function recomputeMatches(db){
  const open=db.listings.filter(x=>x.status==='open');const out=[];
  for(let i=0;i<open.length;i++)for(let j=i+1;j<open.length;j++){const s=compatible(open[i],open[j]);if(s>=55)out.push({id:id('m'),kind:'direct',score:s,listingIds:[open[i].id,open[j].id],createdAt:new Date().toISOString()})}
  const loads=open.filter(x=>x.resource==='load'&&x.intent==='have');
  const trucks=open.filter(x=>x.resource==='truck'&&x.intent==='have');
  const drivers=open.filter(x=>x.resource==='driver'&&x.intent==='have');
  for(const l of loads)for(const t of trucks){const lt=compatible(l,t);if(lt<45)continue;for(const d of drivers){const dt=compatible(d,t);if(dt>=55){const score=Math.min(100,Math.round((lt+dt)/2)+10);out.push({id:id('m'),kind:'load_truck_driver',score,listingIds:[l.id,t.id,d.id],createdAt:new Date().toISOString()})}}}
  out.sort((a,b)=>b.score-a.score);db.matches=out.slice(0,250);return db.matches;
}
function sanitizeData(data){const out={};for(const [k,v] of Object.entries(data||{})){if(typeof v==='string')out[k]=v.slice(0,500);else if(typeof v==='number'||typeof v==='boolean')out[k]=v;}return out}
function saveDataUrl(userId,kind,dataUrl){if(!dataUrl||typeof dataUrl!=='string')return null;const m=dataUrl.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,(.+)$/);if(!m)return null;const buf=Buffer.from(m[2],'base64');if(buf.length>3e6)throw new Error('File too large (3MB max).');const ext=m[1]==='application/pdf'?'pdf':m[1].split('/')[1].replace('jpeg','jpg');fs.mkdirSync(UPLOADS,{recursive:true});const name=`${userId}_${kind}_${Date.now()}.${ext}`;fs.writeFileSync(path.join(UPLOADS,name),buf);return {name,mime:m[1],size:buf.length};}
function autoPrecheck(v){const required=['license','identity','selfie'];const files=v.files||{};const present=required.every(k=>files[k]&&files[k].size>0);if(!present)return {status:'incomplete',score:0,message:'Required documents are missing.'};const acceptable=required.every(k=>files[k].size>=15000&&files[k].size<=3e6);if(!acceptable)return {status:'review_required',score:45,message:'Files received but quality/size needs review.'};return {status:'precheck_passed',score:80,message:'Automated file pre-check passed. Official identity/document verification provider is not connected yet.'};}
function publicListing(x,db){const u=db.users.find(z=>z.id===x.userId);return {...x,user:u?{id:u.id,name:u.name,verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started'}:null};}
function serveStatic(res,p){const allowed=new Set(['/','/index.html','/app.js','/style.css','/tut-emblem.png']);const route=p==='/'?'/index.html':p;if(!allowed.has(route))return false;const f=path.join(ROOT,route.slice(1));if(!fs.existsSync(f))return false;const ext=path.extname(f);const ct={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png'}[ext]||'application/octet-stream';const b=fs.readFileSync(f);res.writeHead(200,{'Content-Type':ct,'Content-Length':b.length});res.end(b);return true;}

const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,`http://${req.headers.host}`),p=url.pathname;
 try{
  if(p==='/api/health')return json(res,200,{ok:true,version:'9',site:'tutmove.com'});

  if(p==='/api/site'&&req.method==='GET'){const st=readDB().settings;return json(res,200,{brandName:st.brandName,siteUrl:st.siteUrl,legalEntity:st.legalEntity,supportEmail:st.supportEmail,launchMarkets:st.launchMarkets});}
  if(p==='/robots.txt'&&req.method==='GET'){const body='User-agent: *\nAllow: /\nSitemap: https://tutmove.com/sitemap.xml\n';res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end(body);}
  if(p==='/sitemap.xml'&&req.method==='GET'){const body='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://tutmove.com/</loc></url></urlset>';res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'});return res.end(body);}
  if(p==='/ownership.json'&&req.method==='GET'){const st=readDB().settings;return json(res,200,{site:'TUT Move',domain:'tutmove.com',ownerConfigured:ownerExists(),legalEntity:st.legalEntity||null,statement:'Official TUT Move application instance.'});}

  if(p==='/api/owner/status'&&req.method==='GET')return json(res,200,{ownerConfigured:ownerExists()});
  if(p==='/api/owner/setup'&&req.method==='POST'){
    const db=readDB();if(db.users.some(u=>u.role==='owner'))return json(res,409,{error:'Owner account is already configured.'});
    const b=await getBody(req);if(!b.name||!b.email||!b.password||b.password.length<10)return json(res,400,{error:'Name, email and password (10+ chars) required.'});
    const hp=hashPassword(b.password);const u={id:id('u'),name:String(b.name).trim(),email:String(b.email).trim().toLowerCase(),role:'owner',roles:['owner'],country:b.country||'',region:b.region||'',language:b.language||'en',currency:b.currency||'USD',verified:true,verificationStatus:'owner',...hp,createdAt:new Date().toISOString()};db.users.push(u);writeDB(db);const sid=id('s');sessions.set(sid,u.id);res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);return json(res,201,{user:safeUser(u)});
  }
  if(p==='/api/register'&&req.method==='POST'){
    const b=await getBody(req);if(!b.name||!b.email||!b.password||b.password.length<8)return json(res,400,{error:'Name, email and password (8+ chars) required.'});const db=readDB();if(db.users.some(u=>u.email.toLowerCase()===String(b.email).toLowerCase()))return json(res,409,{error:'Email already registered.'});
    const hp=hashPassword(b.password);const roles=Array.isArray(b.roles)&&b.roles.length?b.roles.slice(0,5):['member'];const u={id:id('u'),name:String(b.name).trim(),email:String(b.email).trim().toLowerCase(),role:roles[0],roles,country:b.country||'',region:b.region||'',language:b.language||'en',currency:b.currency||'USD',verified:false,verificationStatus:'not_started',...hp,createdAt:new Date().toISOString()};db.users.push(u);writeDB(db);const sid=id('s');sessions.set(sid,u.id);res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);return json(res,201,{user:safeUser(u)});
  }
  if(p==='/api/login'&&req.method==='POST'){
    const b=await getBody(req),db=readDB(),u=db.users.find(x=>x.email===String(b.email||'').toLowerCase());if(!u)return json(res,401,{error:'Invalid email or password.'});const hp=hashPassword(String(b.password||''),u.salt);if(!crypto.timingSafeEqual(Buffer.from(hp.hash,'hex'),Buffer.from(u.hash,'hex')))return json(res,401,{error:'Invalid email or password.'});const sid=id('s');sessions.set(sid,u.id);res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);return json(res,200,{user:safeUser(u)});
  }
  if(p==='/api/logout'&&req.method==='POST'){const sid=cookies(req).sid;if(sid)sessions.delete(sid);res.setHeader('Set-Cookie','sid=; Max-Age=0; Path=/');return json(res,200,{ok:true});}
  if(p==='/api/me'&&req.method==='GET'){const u=auth(req);return json(res,200,{user:u?safeUser(u):null});}
  if(p==='/api/settings'&&req.method==='GET'){return json(res,200,{settings:readDB().settings});}
  if(p==='/api/admin/settings'&&req.method==='PUT'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const b=await getBody(req),db=readDB();if(Number.isFinite(Number(b.platformFeePct)))db.settings.platformFeePct=Math.max(0,Math.min(30,Number(b.platformFeePct)));if(b.defaultCurrency)db.settings.defaultCurrency=String(b.defaultCurrency).slice(0,5);for(const k of ['brandName','siteUrl','ownerName','ownerEmail','legalEntity','supportEmail'])if(k in b)db.settings[k]=String(b[k]||'').trim().slice(0,180);writeDB(db);return json(res,200,{settings:db.settings});}
  if(p==='/api/listings'&&req.method==='GET'){const db=readDB();const listings=db.listings.filter(x=>x.status==='open').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(x=>publicListing(x,db));return json(res,200,{listings});}
  if(p==='/api/listings'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const b=await getBody(req);const resources=['driver','truck','load','warehouse','storage'];const intents=['have','need'];const priceModes=['fixed','negotiable','request_quotes','open_bidding'];if(!resources.includes(b.resource)||!intents.includes(b.intent)||!priceModes.includes(b.priceMode))return json(res,400,{error:'Invalid listing.'});
    const db=readDB();const x={id:id('l'),userId:u.id,intent:b.intent,resource:b.resource,title:String(b.title||'').slice(0,120),country:b.country||u.country||'',currency:b.currency||u.currency||db.settings.defaultCurrency,priceMode:b.priceMode,price:Number(b.price||0),data:sanitizeData(b.data),status:'open',createdAt:new Date().toISOString()};db.listings.push(x);recomputeMatches(db);writeDB(db);return json(res,201,{listing:x});
  }
  if(p.startsWith('/api/listings/')&&req.method==='DELETE'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const lid=p.split('/').pop(),db=readDB(),x=db.listings.find(z=>z.id===lid);if(!x)return json(res,404,{error:'Listing not found.'});if(x.userId!==u.id&&!isOwner(u))return json(res,403,{error:'Not your listing.'});x.status='closed';recomputeMatches(db);writeDB(db);return json(res,200,{ok:true});}
  if(p==='/api/matches'&&req.method==='GET'){const db=readDB();recomputeMatches(db);writeDB(db);const map=Object.fromEntries(db.listings.map(x=>[x.id,publicListing(x,db)]));return json(res,200,{matches:db.matches.map(m=>({...m,listings:m.listingIds.map(i=>map[i]).filter(Boolean)}))});}
  if(p==='/api/offers'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const myListings=new Set(db.listings.filter(x=>x.userId===u.id).map(x=>x.id));const offers=isOwner(u)?db.offers:db.offers.filter(o=>o.fromUserId===u.id||myListings.has(o.listingId));return json(res,200,{offers:offers.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});}
  if(p==='/api/offers'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const b=await getBody(req),db=readDB(),listing=db.listings.find(x=>x.id===b.listingId&&x.status==='open');if(!listing)return json(res,404,{error:'Listing not found.'});if(listing.userId===u.id)return json(res,400,{error:'You cannot offer on your own listing.'});const amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Offer amount required.'});const o={id:id('o'),listingId:listing.id,fromUserId:u.id,toUserId:listing.userId,amount,currency:b.currency||listing.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:b.parentOfferId||null,createdAt:new Date().toISOString()};db.offers.push(o);writeDB(db);return json(res,201,{offer:o});
  }
  if(/^\/api\/offers\/[^/]+\/(accept|reject|counter)$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const parts=p.split('/'),oid=parts[3],action=parts[4],db=readDB(),o=db.offers.find(x=>x.id===oid);if(!o)return json(res,404,{error:'Offer not found.'});if(o.toUserId!==u.id&&o.fromUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Not allowed.'});
    if(action==='accept'){
      if(o.toUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Only recipient can accept.'});o.status='accepted';const listing=db.listings.find(x=>x.id===o.listingId);if(listing)listing.status='booked';const feePct=Number(db.settings.platformFeePct||0);const fee=+(o.amount*feePct/100).toFixed(2);const booking={id:id('b'),listingId:o.listingId,offerId:o.id,buyerUserId:o.fromUserId,providerUserId:o.toUserId,agreedPrice:o.amount,currency:o.currency,platformFeePct:feePct,platformFee:fee,providerNet:+(o.amount-fee).toFixed(2),paymentStatus:'not_connected',status:'agreed',createdAt:new Date().toISOString()};db.bookings.push(booking);recomputeMatches(db);writeDB(db);return json(res,200,{booking});
    }
    if(action==='reject'){o.status='rejected';writeDB(db);return json(res,200,{offer:o});}
    const b=await getBody(req),amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Counter amount required.'});o.status='countered';const c={id:id('o'),listingId:o.listingId,fromUserId:u.id,toUserId:u.id===o.fromUserId?o.toUserId:o.fromUserId,amount,currency:o.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:o.id,createdAt:new Date().toISOString()};db.offers.push(c);writeDB(db);return json(res,201,{offer:c});
  }
  if(p==='/api/bookings'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const bookings=isOwner(u)?db.bookings:db.bookings.filter(b=>b.buyerUserId===u.id||b.providerUserId===u.id);return json(res,200,{bookings:bookings.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});}
  if(p==='/api/verification'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB(),v=db.verifications.find(x=>x.userId===u.id);return json(res,200,{verification:v||null});}
  if(p==='/api/verification'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const b=await getBody(req,14e6),db=readDB();const files={};for(const k of ['license','identity','selfie']){if(b.files&&b.files[k])files[k]=saveDataUrl(u.id,k,b.files[k]);}
    let v=db.verifications.find(x=>x.userId===u.id);if(!v){v={id:id('v'),userId:u.id,createdAt:new Date().toISOString()};db.verifications.push(v)}v.country=b.country||u.country||'';v.licenseNumber=String(b.licenseNumber||'').slice(0,80);v.licenseClass=String(b.licenseClass||'').slice(0,40);v.expiry=String(b.expiry||'').slice(0,20);v.files={...(v.files||{}),...files};v.updatedAt=new Date().toISOString();const pre=autoPrecheck(v);v.status=pre.status;v.score=pre.score;v.message=pre.message;const user=db.users.find(x=>x.id===u.id);if(user){user.verificationStatus=v.status;user.verified=v.status==='precheck_passed';}writeDB(db);return json(res,200,{verification:v,user:safeUser(user)});
  }
  if(p==='/api/admin/summary'&&req.method==='GET'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const db=readDB();return json(res,200,{users:db.users.map(safeUser),listings:db.listings,offers:db.offers,bookings:db.bookings,verifications:db.verifications,settings:db.settings,stats:{users:db.users.length,openListings:db.listings.filter(x=>x.status==='open').length,offers:db.offers.length,bookings:db.bookings.length,platformRevenue:+db.bookings.reduce((s,b)=>s+(b.platformFee||0),0).toFixed(2)}});}
  if(p.startsWith('/api/admin/users/')&&p.endsWith('/verify')&&req.method==='POST'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target)return json(res,404,{error:'User not found.'});target.verified=true;target.verificationStatus='manual_verified';writeDB(db);return json(res,200,{user:safeUser(target)});}
  if(serveStatic(res,p))return;
  return json(res,404,{error:'Not found'});
 }catch(e){console.error(e);return json(res,500,{error:e.message||'Server error'});}
});
server.listen(PORT,()=>console.log(`TUT Move v9 running on ${PORT}`));
