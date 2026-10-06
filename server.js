const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const tls = require('tls');
const nodemailer = require('nodemailer');
const { URL } = require('url');
let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) {}

const ROOT = __dirname;
const DBFILE = path.join(ROOT, 'data', 'db.json');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
let pgPool = null;
let dbCache = null;

// Production hardening: basic response headers and in-memory login throttling.
const loginAttempts = new Map();
function clientKey(req){return String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim()}
function loginAllowed(req){const k=clientKey(req),now=Date.now(),windowMs=15*60*1000,max=10;let a=loginAttempts.get(k)||[];a=a.filter(t=>now-t<windowMs);loginAttempts.set(k,a);return a.length<max}
function recordLoginFailure(req){const k=clientKey(req),a=loginAttempts.get(k)||[];a.push(Date.now());loginAttempts.set(k,a)}
function clearLoginFailures(req){loginAttempts.delete(clientKey(req))}
function setSecurityHeaders(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(self)');res.setHeader('Cross-Origin-Opener-Policy','same-origin');}

function emptyDB(){return {users:[], sessions:[], passwordResets:[], listings:[], offers:[], bookings:[], matches:[], verifications:[], notifications:[], settings:{brandName:'TUT Move',siteUrl:'https://tutmove.com',platformFeePct:5,defaultCurrency:'USD',ownerName:'',ownerEmail:'',legalEntity:'',supportEmail:'info@tutmove.com',launchMarkets:['USA','Canada','Europe','Middle East']}};}
function normalizeDB(d){return {...emptyDB(),...(d||{}),settings:{...emptyDB().settings,...((d&&d.settings)||{})}}}
function readLocalDB(){
  try{return normalizeDB(JSON.parse(fs.readFileSync(DBFILE,'utf8')))}
  catch{return emptyDB()}
}
function writeLocalDB(db){
  fs.mkdirSync(path.dirname(DBFILE),{recursive:true});
  fs.writeFileSync(DBFILE,JSON.stringify(db,null,2));
}
async function initDB(){
  if(DATABASE_URL){
    if(!Pool) throw new Error('DATABASE_URL is set but pg package is unavailable. Run npm install.');
    pgPool = new Pool({
      connectionString:DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : {rejectUnauthorized:false},
      max:5
    });
    await pgPool.query(`CREATE TABLE IF NOT EXISTS tut_app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const r=await pgPool.query('SELECT data FROM tut_app_state WHERE id=1');
    if(r.rows.length){
      dbCache=normalizeDB(r.rows[0].data);
    }else{
      const local=readLocalDB();
      dbCache=normalizeDB(local);
      await pgPool.query(
        'INSERT INTO tut_app_state (id,data,updated_at) VALUES (1,$1::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()',
        [JSON.stringify(dbCache)]
      );
    }
    console.log('TUT Move database: PostgreSQL persistent storage connected');
  }else{
    dbCache=readLocalDB();
    writeLocalDB(dbCache);
    console.warn('TUT Move database: local-file fallback active. Set DATABASE_URL in production.');
  }
}
function readDB(){
  if(!dbCache) dbCache=readLocalDB();
  return dbCache;
}
async function writeDB(db){
  dbCache=normalizeDB(db);
  if(pgPool){
    await pgPool.query(
      'INSERT INTO tut_app_state (id,data,updated_at) VALUES (1,$1::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()',
      [JSON.stringify(dbCache)]
    );
  }else{
    writeLocalDB(dbCache);
  }
}
async function dbInfo(){
  return {persistent:!!pgPool,engine:pgPool?'postgresql':'local-file',ownerConfigured:ownerExists()};
}
function id(prefix){return prefix+'_'+crypto.randomBytes(6).toString('hex')}
function addNotification(db,userId,type,title,message,link='offers'){
  if(!userId)return null;db.notifications=db.notifications||[];const n={id:id('n'),userId,type,title,message,link,read:false,createdAt:new Date().toISOString()};db.notifications.push(n);if(db.notifications.length>1000)db.notifications=db.notifications.slice(-1000);return n;
}
function verificationRecordForUser(db,userId){const u=db.users.find(x=>x.id===userId);const legacy=(db.verifications||[]).find(v=>v.userId===userId)||{};return {...legacy,...((u&&u.verification)||{})};}
function json(res,status,obj){const s=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s),'Cache-Control':'no-store'});res.end(s)}
function getBody(req,limit=8e6){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>limit){reject(new Error('Request too large'));req.destroy()}});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});req.on('error',reject)});}
function cookies(req){const out={};(req.headers.cookie||'').split(';').forEach(x=>{const i=x.indexOf('=');if(i>0)out[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1))});return out}
function sessionIdsFromRequest(req){
  // Browser sessions are kept only in the HttpOnly cookie; do not expose durable bearer tokens to JavaScript.
  const cookieSid=cookies(req).sid||'';
  return cookieSid?[cookieSid]:[];
}
function sessionIdFromRequest(req){return sessionIdsFromRequest(req)[0]||''}
function auth(req){
  const ids=sessionIdsFromRequest(req);if(!ids.length)return null;
  const db=readDB(),now=Date.now();
  const sess=(db.sessions||[]).find(x=>ids.includes(x.id) && (!x.expiresAt || Date.parse(x.expiresAt)>now));
  if(!sess)return null;
  return db.users.find(u=>u.id===sess.userId)||null;
}
function addSession(db,userId){
  const sid=id('s'),now=Date.now(),expiresAt=new Date(now+30*24*60*60*1000).toISOString();
  db.sessions=(db.sessions||[]).filter(x=>!x.expiresAt||Date.parse(x.expiresAt)>now);
  db.sessions.push({id:sid,userId,createdAt:new Date(now).toISOString(),expiresAt});
  return sid;
}
function sessionCookie(sid){return `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`}
function clearSessionCookie(){return 'sid=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/'}
function dealTypeForListing(listing){
  if(!listing)return 'transport';
  if(listing.resource==='driver')return 'driver';
  if(listing.resource==='warehouse'||listing.resource==='storage')return 'warehouse';
  if(listing.resource==='truck')return 'truck';
  if(listing.resource==='equipment')return 'equipment';
  return 'transport';
}
function bookingDealType(b,db){return b.dealType||dealTypeForListing(db.listings.find(x=>x.id===b.listingId))}
function requiredChecks(type){
  if(type==='driver')return ['driverVerified','licenceVerified','termsConfirmed'];
  if(type==='warehouse')return ['warehouseVerified','datesConfirmed'];
  if(type==='truck')return ['truckVerified','handoverConfirmed'];
  if(type==='equipment')return ['equipmentVerified','handoverConfirmed'];
  return ['driverVerified','licenceVerified','truckVerified','cargoConfirmed','receiverConfirmed'];
}
function normalizeBookingWorkflow(b,db){b.dealType=bookingDealType(b,db);return b;}
function userVerificationSummary(u,db){
  const legacy=(db.verifications||[]).find(v=>v.userId===u?.id)||{};const v={...legacy,...(u?.verification||{})};
  return {status:v.status||u?.verificationStatus||'not_submitted',licenceClass:v.licenceClass||v.licenseClass||'',licenceNumberMasked:maskValue(v.licenceNumber||v.licenseNumber||v.licence||v.license||''),licenceExpiry:v.expiry||v.licenceExpiry||'',vehicleId:v.vehicleId||'',verified:!!u?.verified||['verified','manual_verified'].includes(v.status)};
}
function latestListingFor(db,userId,resource,intent,excludeId=''){
  return db.listings.filter(x=>x.userId===userId&&x.resource===resource&&x.intent===intent&&x.id!==excludeId).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0]||null;
}
function compactListing(x,db){if(!x)return null;const u=db.users.find(z=>z.id===x.userId);return {id:x.id,intent:x.intent,resource:x.resource,title:x.title,country:x.country,currency:x.currency,priceMode:x.priceMode,price:x.price,data:x.data||{},user:u?{id:u.id,name:u.name,roles:u.roles||[u.role],country:u.country||'',region:u.region||'',verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started',verification:userVerificationSummary(u,db)}:null};}
function driverDealContext(b,db){
  const accepted=db.listings.find(x=>x.id===b.listingId);if(!accepted||accepted.resource!=='driver')return null;
  const offer=db.offers.find(o=>o.id===b.offerId);if(!offer)return null;
  const acceptedOwnerId=accepted.userId,otherId=offer.fromUserId===acceptedOwnerId?offer.toUserId:offer.fromUserId;
  let driverUserId,requesterUserId,availableListing,requestListing;
  if(accepted.intent==='have'){
    driverUserId=acceptedOwnerId;requesterUserId=offer.fromUserId;availableListing=accepted;requestListing=latestListingFor(db,requesterUserId,'driver','need',accepted.id);
  }else{
    requesterUserId=acceptedOwnerId;driverUserId=offer.fromUserId;requestListing=accepted;availableListing=latestListingFor(db,driverUserId,'driver','have',accepted.id);
  }
  const driver=db.users.find(u=>u.id===driverUserId),requester=db.users.find(u=>u.id===requesterUserId);
  return {driverUserId,requesterUserId,driver:driver?{id:driver.id,name:driver.name,roles:driver.roles||[driver.role],country:driver.country||'',region:driver.region||'',verified:!!driver.verified,verificationStatus:driver.verificationStatus||'not_started',verification:userVerificationSummary(driver,db)}:null,requester:requester?{id:requester.id,name:requester.name,roles:requester.roles||[requester.role],country:requester.country||'',region:requester.region||'',verified:!!requester.verified,verificationStatus:requester.verificationStatus||'not_started'}:null,availableListing:compactListing(availableListing,db),requestListing:compactListing(requestListing,db),acceptedOffer:{amount:offer.amount,currency:offer.currency,message:offer.message||''}};
}
function simpleUser(u,db){return u?{id:u.id,name:u.name,roles:u.roles||[u.role],country:u.country||'',region:u.region||'',verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started',verification:userVerificationSummary(u,db)}:null;}
function pairedResourceDealContext(b,db,resource){
  const accepted=db.listings.find(x=>x.id===b.listingId);if(!accepted||accepted.resource!==resource)return null;
  const offer=db.offers.find(o=>o.id===b.offerId);if(!offer)return null;
  const ownerId=accepted.userId,otherId=offer.fromUserId===ownerId?offer.toUserId:offer.fromUserId;
  let providerUserId,requesterUserId,availableListing,requestListing;
  if(accepted.intent==='have'){
    providerUserId=ownerId;requesterUserId=otherId;availableListing=accepted;requestListing=latestListingFor(db,requesterUserId,resource,'need',accepted.id);
  }else{
    requesterUserId=ownerId;providerUserId=otherId;requestListing=accepted;availableListing=latestListingFor(db,providerUserId,resource,'have',accepted.id);
  }
  const provider=db.users.find(u=>u.id===providerUserId),requester=db.users.find(u=>u.id===requesterUserId);
  return {providerUserId,requesterUserId,provider:simpleUser(provider,db),requester:simpleUser(requester,db),availableListing:compactListing(availableListing,db),requestListing:compactListing(requestListing,db),acceptedOffer:{amount:offer.amount,currency:offer.currency,message:offer.message||''}};
}
function transportDealContext(b,db){
  const accepted=db.listings.find(x=>x.id===b.listingId);if(!accepted||accepted.resource!=='load')return null;
  const offer=db.offers.find(o=>o.id===b.offerId);if(!offer)return null;
  const cargoUserId=accepted.userId,transportUserId=offer.fromUserId===cargoUserId?offer.toUserId:offer.fromUserId;
  const cargoUser=db.users.find(u=>u.id===cargoUserId),transportUser=db.users.find(u=>u.id===transportUserId);
  return {cargoUserId,transportUserId,cargoOwner:simpleUser(cargoUser,db),transportProvider:simpleUser(transportUser,db),loadListing:compactListing(accepted,db),truckListing:compactListing(latestListingFor(db,transportUserId,'truck','have'),db),driverListing:compactListing(latestListingFor(db,transportUserId,'driver','have'),db),acceptedOffer:{amount:offer.amount,currency:offer.currency,message:offer.message||''}};
}
function bookingView(b,db){
  const buyer=db.users.find(u=>u.id===b.buyerUserId),provider=db.users.find(u=>u.id===b.providerUserId);
  const out={...b,feePayerUserId:b.feePayerUserId||b.buyerUserId,verificationState:{buyerReady:verificationReady(buyer),providerReady:verificationReady(provider)}},type=bookingDealType(b,db);
  if(type==='driver')out.dealContext=driverDealContext(b,db);
  else if(type==='warehouse'){const accepted=db.listings.find(x=>x.id===b.listingId);out.dealContext=pairedResourceDealContext(b,db,accepted?.resource==='storage'?'storage':'warehouse');}
  else if(type==='truck')out.dealContext=pairedResourceDealContext(b,db,'truck');
  else if(type==='equipment')out.dealContext=pairedResourceDealContext(b,db,'equipment');
  else if(type==='transport')out.dealContext=transportDealContext(b,db);
  return out;
}
function hashPassword(p,salt=crypto.randomBytes(16).toString('hex')){const h=crypto.scryptSync(p,salt,64).toString('hex');return {salt,hash:h}}
function resetTokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}
function emailTokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}
function accountActive(u){return !!u&&(u.role==='owner'||!!u.emailVerifiedAt)}
async function smtpSend({host,port,user,pass,from,to,subject,text,attachments=[]}){
  const secure=Number(port)===465;
  const transporter=nodemailer.createTransport({host,port:Number(port),secure,auth:{user,pass},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
  await transporter.sendMail({from:from||user,to,subject,text,attachments});
}

async function sendEmailVerification(to,token){
  const host=process.env.SMTP_HOST||'mail.privateemail.com',port=Number(process.env.SMTP_PORT||465),user=process.env.SMTP_USER||'',pass=process.env.SMTP_PASS||'',from=process.env.SMTP_FROM||user||'info@tutmove.com';
  if(!user||!pass) throw new Error('Email verification is not configured.');
  const link=`${process.env.PUBLIC_SITE_URL||'https://tutmove.com'}/?verify_email=${encodeURIComponent(token)}`;
  const text=`Welcome to TUT Move.\n\nConfirm that this email address belongs to you by opening this link:\n${link}\n\nThis verification link expires in 24 hours and can be used once. If you did not create a TUT Move account, ignore this email.`;
  await smtpSend({host,port,user,pass,from,to,subject:'Verify your TUT Move email address',text});
}

async function sendPasswordResetEmail(to,token){
  const host=process.env.SMTP_HOST||'mail.privateemail.com',port=Number(process.env.SMTP_PORT||465),user=process.env.SMTP_USER||'',pass=process.env.SMTP_PASS||'',from=process.env.SMTP_FROM||user||'info@tutmove.com';
  if(!user||!pass) throw new Error('Password reset email is not configured.');
  const link=`${process.env.PUBLIC_SITE_URL||'https://tutmove.com'}/?reset=${encodeURIComponent(token)}`;
  const text=`A password reset was requested for your TUT Move account.\n\nReset your password: ${link}\n\nThis link expires in 30 minutes and can be used once. If you did not request this, ignore this email.`;
  await smtpSend({host,port,user,pass,from,to,subject:'Reset your TUT Move password',text});
}
function safeUser(u){return {id:u.id,name:u.name,email:u.email,emailVerified:!!u.emailVerifiedAt,emailVerifiedAt:u.emailVerifiedAt||null,phone:u.phone||'',accountActive:accountActive(u),role:u.role,roles:u.roles||[u.role],country:u.country||'',region:u.region||'',language:u.language||'en',currency:u.currency||'USD',verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started',createdAt:u.createdAt}}
function isOwner(u){return !!u&&u.role==='owner'}
function ownerExists(){return readDB().users.some(u=>u.role==='owner')}
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()}
function locScore(a,b){a=norm(a);b=norm(b);if(!a||!b)return 0;if(a===b)return 35;const A=new Set(a.split(' ')),B=new Set(b.split(' '));let c=0;for(const x of A)if(B.has(x))c++;return c?18:0}
function dateScore(a,b){if(!a||!b)return 10;return a===b?30:0}
function coord(d){const lat=Number(d.locationLat??d.pickupLat),lng=Number(d.locationLng??d.pickupLng);return Number.isFinite(lat)&&Number.isFinite(lng)&&lat!==0&&lng!==0?[lat,lng]:null}
function km(a,b){const R=6371,toRad=x=>x*Math.PI/180,dLat=toRad(b[0]-a[0]),dLng=toRad(b[1]-a[1]),s=Math.sin(dLat/2)**2+Math.cos(toRad(a[0]))*Math.cos(toRad(b[0]))*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(s))}
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
  const ac=coord(ad),bc=coord(bd);if(ac&&bc){const dist=km(ac,bc);s+=dist<=10?35:dist<=50?28:dist<=150?18:dist<=500?8:0}else s+=locScore(ad.location||ad.pickup,bd.location||bd.pickup);
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
function saveDataUrl(userId,kind,dataUrl){if(!dataUrl||typeof dataUrl!=='string')return null;const m=dataUrl.match(/^data:(image\/(?:jpeg|png|webp|heic|heif)|application\/pdf);base64,(.+)$/);if(!m)return null;const buf=Buffer.from(m[2],'base64');if(buf.length>8e6)throw new Error('File too large (8MB max).');const ext=m[1]==='application/pdf'?'pdf':m[1].split('/')[1].replace('jpeg','jpg');fs.mkdirSync(UPLOADS,{recursive:true});const name=`${userId}_${kind}_${Date.now()}.${ext}`;fs.writeFileSync(path.join(UPLOADS,name),buf);return {name,mime:m[1],size:buf.length};}
function autoPrecheck(v){const required=['license','identity','selfie'];const files=v.files||{};const present=required.every(k=>files[k]&&files[k].size>0);if(!present)return {status:'incomplete',score:0,message:'Required documents are missing.'};const acceptable=required.every(k=>files[k].size>=15000&&files[k].size<=3e6);if(!acceptable)return {status:'review_required',score:45,message:'Files received but quality/size needs review.'};return {status:'precheck_passed',score:80,message:'Automated file pre-check passed. Official identity/document verification provider is not connected yet.'};}
function publicListing(x,db){const u=db.users.find(z=>z.id===x.userId);return {...x,user:u?{id:u.id,name:u.name,verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started'}:null};}
function serveStatic(res,p,req=null){const allowed=new Set(['/','/index.html','/app.js','/style.css','/tut-emblem.png','/tut-header-logo.jpg','/tut-hero-logistics.jpg','/favicon-48.png','/favicon-96.png','/favicon-192.png','/apple-touch-icon.png']);const route=p==='/'?'/index.html':p;if(!allowed.has(route))return false;const f=path.join(ROOT,route.slice(1));if(!fs.existsSync(f))return false;const ext=path.extname(f);const ct={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[ext]||'application/octet-stream';let b=fs.readFileSync(f);const cache=['.html','.css','.js'].includes(ext)?'no-store':'public, max-age=86400';const headers={'Content-Type':ct,'Cache-Control':cache,'Vary':'Accept-Encoding'};if(req&&/gzip/.test(String(req.headers['accept-encoding']||''))&&['.html','.css','.js'].includes(ext)){b=zlib.gzipSync(b,{level:6});headers['Content-Encoding']='gzip'}headers['Content-Length']=b.length;res.writeHead(200,headers);res.end(b);return true;}


function rawBody(req,limit=2e6){return new Promise((resolve,reject)=>{const chunks=[];let n=0;req.on('data',c=>{n+=c.length;if(n>limit){reject(new Error('Request too large'));req.destroy();return}chunks.push(c)});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject)})}

function bookingPartiesForOffer(db,o){
  const listing=db.listings.find(x=>x.id===o.listingId);if(!listing)return null;
  const otherUserId=o.fromUserId===listing.userId?o.toUserId:o.fromUserId;
  const isLoad=listing.resource==='load';
  const buyerUserId=isLoad?(listing.intent==='have'?listing.userId:otherUserId):(listing.intent==='need'?listing.userId:otherUserId);
  const providerUserId=isLoad?(listing.intent==='need'?listing.userId:otherUserId):(listing.intent==='have'?listing.userId:otherUserId);
  return {listing,buyerUserId,providerUserId};
}
function createBookingFromAcceptedOffer(db,o){
  const existing=(db.bookings||[]).find(b=>b.offerId===o.id);if(existing)return existing;
  const x=bookingPartiesForOffer(db,o);if(!x)return null;const {listing,buyerUserId,providerUserId}=x;
  const feePct=Number(db.settings.platformFeePct ?? 5),fee=+(Number(o.amount)*feePct/100).toFixed(2);
  const b={id:id('b'),listingId:o.listingId,offerId:o.id,dealType:dealTypeForListing(listing),buyerUserId,providerUserId,agreedPrice:Number(o.amount),currency:o.currency,platformFeePct:feePct,platformFee:fee,buyerTotal:+fee.toFixed(2),providerNet:+Number(o.amount).toFixed(2),feeChargedTo:'buyer',feePayerUserId:buyerUserId,paymentStatus:'unpaid',paymentMode:'stripe_fee_only',commissionLockedAt:new Date().toISOString(),basicVerification:{buyerContinue:false,providerContinue:false,buyerAt:null,providerAt:null,rejectedBy:null},dealTerms:{buyer:null,provider:null,confirmed:false,settlementMethod:'',paymentTiming:'',confirmedAt:null},completion:{buyer:false,provider:false,buyerAt:null,providerAt:null},payoutStatus:'not_applicable',status:'basic_verification',createdAt:new Date().toISOString()};
  db.bookings=db.bookings||[];db.bookings.push(b);listing.status='booked';return b;
}
function migrateAcceptedOffersToDeals(db){
  let changed=false;
  for(const o of (db.offers||[])){
    if(o.status!=='accepted')continue;
    let deal=(db.bookings||[]).find(b=>b.offerId===o.id);
    if(!deal){deal=createBookingFromAcceptedOffer(db,o);if(deal)changed=true;}
    if(deal&&o.dealId!==deal.id){o.dealId=deal.id;changed=true;}
  }
  return changed;
}
function pdfEsc(v){return String(v??'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[\r\n]+/g,' ')}
function pdfText(x,y,size,text,font='F1',rgb='1 1 1'){return `BT /${font} ${size} Tf ${rgb} rg ${x} ${y} Td (${pdfEsc(text)}) Tj ET`}
function dealPartyLabels(b,db){
  const buyer=db.users.find(x=>x.id===b.buyerUserId),provider=db.users.find(x=>x.id===b.providerUserId),type=b.dealType||'deal';
  const labels={driver:['REQUESTER','DRIVER'],truck:['REQUESTER','TRUCK / VEHICLE OWNER'],warehouse:['REQUESTER','WAREHOUSE PROVIDER'],equipment:['REQUESTER','EQUIPMENT PROVIDER'],transport:['CARGO OWNER','TRANSPORT PROVIDER']};
  const [buyerRole,providerRole]=labels[type]||['REQUESTER','PROVIDER'];return {buyer,provider,buyerRole,providerRole};
}
function dealPdfBuffer(b,db){
  const {buyer,provider,buyerRole,providerRole}=dealPartyLabels(b,db),offer=db.offers.find(x=>x.id===b.offerId),feePayer=db.users.find(x=>x.id===(b.feePayerUserId||b.buyerUserId));
  const bv=buyer?.verification||{},pv=provider?.verification||{},terms=b.dealTerms||{},method=terms.settlementMethod||'Not specified',timing=terms.paymentTiming||'Not specified',gold='.92 .65 .20',white='.96 .96 .94',muted='.55 .55 .53';
  const c=[], line=(y,w=1)=>c.push(`${gold} RG ${w} w 34 ${y} m 561 ${y} l S`), txt=(x,y,n,t,f='F1',col=white)=>c.push(pdfText(x,y,n,String(t||'—').slice(0,54),f,col));
  c.push('0 0 0 rg 0 0 595 842 re f');
  txt(226,806,27,'TUT MOVE','F2',gold);txt(205,788,7,'VEHICLE TRANSPORT MADE SIMPLE');line(774,1.5);
  txt(224,752,10,'FINAL DEAL RECORD');txt(218,718,25,'COMPLETED','F2',gold);txt(196,701,7,'OFFICIAL TUT MOVE TRANSACTION RECORD');line(687,1.5);
  txt(38,660,16,buyer?.name||'—','F2');txt(375,660,16,provider?.name||'—','F2');txt(238,659,8,`${String(b.dealType||'deal').toUpperCase()} DEAL`);line(643,1);
  txt(70,622,7,'AGREED TRANSPORT PRICE');txt(86,595,21,`${b.currency} ${Number(b.agreedPrice||0).toFixed(2)}`,'F2',gold);txt(58,578,8,'Paid directly between the parties');
  txt(355,622,7,`TUT MOVE FEE (${Number(b.platformFeePct||0)}%)`);txt(390,595,21,`${b.currency} ${Number(b.platformFee||0).toFixed(2)}`,'F2',gold);txt(355,578,8,`Paid by ${feePayer?.name||'—'}`);txt(432,561,9,'PAID','F2',gold);line(546,1.5);
  txt(38,525,12,'CONTACT DETAILS','F2',gold);
  txt(42,504,11,buyer?.name||'—','F2');txt(310,504,11,provider?.name||'—','F2');
  const contactRows=[['LEGAL NAME',bv.legalName||buyer?.name,pv.legalName||provider?.name],['PHONE',bv.phone||buyer?.phone,pv.phone||provider?.phone],['EMAIL',buyer?.email,provider?.email],['COUNTRY',bv.country||buyer?.country,pv.country||provider?.country],['ROLE',buyerRole,providerRole]];let cy=486;
  for(const [k,l,r] of contactRows){txt(42,cy,6,k,'F1',muted);txt(112,cy,8,l);txt(310,cy,6,k,'F1',muted);txt(380,cy,8,r);cy-=18}line(388,1.5);
  txt(38,368,12,'DEAL DETAILS','F2',gold);
  const rows=[['DEAL REFERENCE',b.id],['DEAL TYPE',String(b.dealType||'deal').toUpperCase()],['SETTLEMENT METHOD',method],['PAYMENT TIMING',timing],['CONFIRMATION','Confirmed by both parties'],['ADDITIONAL TERMS',offer?.message||'No additional written terms']];let y=346;
  for(const [k,v] of rows){txt(42,y,6,k,'F1',muted);txt(300,y,8,v);c.push(`${muted} RG .35 w 38 ${y-8} m 557 ${y-8} l S`);y-=27}
  line(174,1.5);txt(38,151,8,'TUT Move records the agreement and its applicable platform fee only.','F2',gold);txt(38,134,7,'TUT Move is not a party to the underlying transaction. Identity and document checks,');txt(38,122,7,'payment, handover, inspection and fulfilment remain the responsibility of the parties.');line(96,1.5);txt(38,72,11,'TUTMOVE.COM','F2',gold);txt(225,72,7,'VEHICLE TRANSPORT MADE SIMPLE');txt(438,72,8,db.settings?.supportEmail||'info@tutmove.com','F1',gold);
  const stream=c.join('\n');const objs=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>'];let out='%PDF-1.4\n',offsets=[0];for(let i=1;i<objs.length;i++){offsets[i]=Buffer.byteLength(out);out+=`${i} 0 obj\n${objs[i]}\nendobj\n`}const xref=Buffer.byteLength(out);out+=`xref\n0 ${objs.length}\n0000000000 65535 f \n`;for(let i=1;i<objs.length;i++)out+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';out+=`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Promise.resolve(Buffer.from(out));
}
async function emailDealRecord(b,db,pdf){const host=process.env.SMTP_HOST||'mail.privateemail.com',port=Number(process.env.SMTP_PORT||465),user=process.env.SMTP_USER||'',pass=process.env.SMTP_PASS||'',from=process.env.SMTP_FROM||user||'info@tutmove.com';if(!user||!pass)return;const parties=[db.users.find(x=>x.id===b.buyerUserId),db.users.find(x=>x.id===b.providerUserId)].filter(Boolean);for(const party of parties){try{await smtpSend({host,port,user,pass,from,to:party.email,subject:`TUT Move deal completed — ${b.id}`,text:`Your TUT Move deal ${b.id} is completed. Attached is the final Deal Record. The underlying deal amount was handled directly between the parties outside TUT Move.`,attachments:[{filename:`TUT-Move-Deal-${b.id}.pdf`,content:pdf,contentType:'application/pdf'}]})}catch(e){console.error('Deal PDF email failed:',e.message)}}}

function maskValue(v){const x=String(v||'').trim();if(!x)return '';if(x.length<=2)return x[0]+'•';return [...x].map((c,i)=>{const show=i===0||i===x.length-1||i===2||i===x.length-2;return show?c:'•'}).join('')}
function verificationReady(user){
  const v=user?.verification||{},files=v.files||{},role=String(v.role||user?.role||'').toLowerCase();
  const base=!!(user?.emailVerifiedAt&&String(v.legalName||'').trim()&&String(v.phone||user?.phone||'').trim()&&String(v.identityNumber||'').trim()&&files.identity?.name&&files.selfie?.name);
  const driving=['driver','carrier'].includes(role);
  return base&&(!driving||!!(String(v.licenceNumber||'').trim()&&(v.licenceClasses||[]).length&&String(v.licenceExpiry||'').trim()&&files.license?.name));
}
function closeCompletedDealListings(db,b){
  const accepted=db.listings.find(x=>x.id===b.listingId);if(!accepted)return [];
  const ids=new Set([accepted.id]);const otherId=accepted.userId===b.buyerUserId?b.providerUserId:b.buyerUserId;
  const opposite=accepted.intent==='have'?'need':'have';
  const related=db.listings.filter(x=>x.userId===otherId&&x.resource===accepted.resource&&x.intent===opposite&&x.status==='open').sort((a,z)=>String(z.createdAt||'').localeCompare(String(a.createdAt||'')))[0];
  if(related)ids.add(related.id);
  for(const id0 of ids){const x=db.listings.find(z=>z.id===id0);if(x){x.status='closed';x.closedAt=new Date().toISOString();x.closedReason='deal_completed';x.bookingId=b.id;}}
  b.closedListingIds=[...ids];recomputeMatches(db);return b.closedListingIds;
}
function reconcileCompletedDeals(db){
  let changed=false;
  for(const b of (db.bookings||[])){
    if(b.status!=='completed')continue;
    if(!b.completedAt){b.completedAt=new Date().toISOString();changed=true;}
    const before=JSON.stringify((b.closedListingIds||[]).slice().sort());closeCompletedDealListings(db,b);
    if(before!==JSON.stringify((b.closedListingIds||[]).slice().sort()))changed=true;
  }
  if(changed)recomputeMatches(db);return changed;
}
function stripeSigValid(raw,header,secret){try{const parts=String(header||'').split(',').map(x=>x.split('='));const t=parts.find(x=>x[0]==='t')?.[1];const sigs=parts.filter(x=>x[0]==='v1').map(x=>x[1]);if(!t||!sigs.length)return false;if(Math.abs(Date.now()/1000-Number(t))>300)return false;const expected=crypto.createHmac('sha256',secret).update(t+'.'+raw.toString('utf8')).digest('hex');return sigs.some(sig=>sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))}catch{return false}}
async function createStripeCheckout(b,siteUrl){const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new Error('Stripe secret key is not configured on the server.');const amount=Math.round(Number(b.platformFee||0)*100);if(amount<50)throw new Error('Commission amount is below Stripe minimum for this currency.');const q=new URLSearchParams();q.set('mode','payment');q.set('success_url',`${siteUrl}/?payment=success&deal=${encodeURIComponent(b.id)}`);q.set('cancel_url',`${siteUrl}/?payment=cancelled&deal=${encodeURIComponent(b.id)}`);q.set('client_reference_id',b.id);q.set('metadata[deal_id]',b.id);q.set('metadata[expected_fee_minor]',String(amount));q.set('metadata[fee_currency]',String(b.currency).toLowerCase());q.set('line_items[0][quantity]','1');q.set('line_items[0][price_data][currency]',String(b.currency).toLowerCase());q.set('line_items[0][price_data][unit_amount]',String(amount));q.set('line_items[0][price_data][product_data][name]',`TUT Move success fee — ${b.id}`);const r=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded'},body:q});const j=await r.json();if(!r.ok)throw new Error(j?.error?.message||'Stripe Checkout could not be created.');return j;}

const server=http.createServer(async(req,res)=>{setSecurityHeaders(res);
 const url=new URL(req.url,`http://${req.headers.host}`),p=url.pathname;
 try{
  if(p==='/api/health')return json(res,200,{ok:true,version:'96',site:'tutmove.com',database:await dbInfo()});
  if(p==='/api/database/status'&&req.method==='GET')return json(res,200,await dbInfo());

  if(p==='/api/site'&&req.method==='GET'){const st=readDB().settings;return json(res,200,{brandName:st.brandName,siteUrl:st.siteUrl,legalEntity:st.legalEntity,supportEmail:st.supportEmail,launchMarkets:st.launchMarkets});}
  if(p==='/robots.txt'&&req.method==='GET'){const body='User-agent: *\nAllow: /\nSitemap: https://tutmove.com/sitemap.xml\n';res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});return res.end(body);}
  if(p==='/sitemap.xml'&&req.method==='GET'){const body='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://tutmove.com/</loc></url></urlset>';res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'});return res.end(body);}
  if(p==='/ownership.json'&&req.method==='GET'){const st=readDB().settings;return json(res,200,{site:'TUT Move',domain:'tutmove.com',ownerConfigured:ownerExists(),legalEntity:st.legalEntity||null,statement:'Official TUT Move application instance.'});}

  if(p==='/api/owner/status'&&req.method==='GET')return json(res,200,{ownerConfigured:ownerExists()});
  if(p==='/api/owner/setup'&&req.method==='POST'){
    const db=readDB();if(db.users.some(u=>u.role==='owner'))return json(res,409,{error:'Owner account is already configured.'});
    const b=await getBody(req);if(!b.name||!b.email||!b.password||b.password.length<10)return json(res,400,{error:'Name, email and password (10+ chars) required.'});
    if(db.users.some(u=>u.email.toLowerCase()===String(b.email).trim().toLowerCase()))return json(res,409,{error:'Email already registered.'});
    const hp=hashPassword(b.password);const u={id:id('u'),name:String(b.name).trim(),email:String(b.email).trim().toLowerCase(),role:'owner',roles:['owner'],country:b.country||'',region:b.region||'',language:b.language||'en',currency:b.currency||'USD',verified:true,verificationStatus:'owner',...hp,createdAt:new Date().toISOString()};db.users.push(u);const sid=addSession(db,u.id);await writeDB(db);res.setHeader('Set-Cookie',sessionCookie(sid));return json(res,201,{user:safeUser(u)});
  }
  if(p==='/api/register'&&req.method==='POST'){
    const b=await getBody(req),email=String(b.email||'').trim().toLowerCase(),phone=String(b.phone||'').trim();if(!b.name||!email||!phone||!b.password||b.password.length<8)return json(res,400,{error:'Name, email, phone and password (8+ chars) required.'});if(b.acceptedTerms!==true)return json(res,400,{error:'You must agree to the Terms of Service and Privacy Policy.'});const db=readDB();
    const existing=db.users.find(u=>String(u.email||'').trim().toLowerCase()===email);
    if(existing){
      if(existing.emailVerifiedAt)return json(res,409,{error:'Email already registered. Please sign in.'});
      const hpExisting=hashPassword(String(b.password||''),existing.salt);
      if(!existing.hash||!crypto.timingSafeEqual(Buffer.from(hpExisting.hash,'hex'),Buffer.from(existing.hash,'hex')))return json(res,409,{error:'An unverified account already exists for this email. Sign in with its password, then resend the verification email.'});
      const token=crypto.randomBytes(32).toString('hex');existing.emailVerificationTokenHash=emailTokenHash(token);existing.emailVerificationExpiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
      const sid=addSession(db,existing.id);await writeDB(db);let emailSent=true;try{await sendEmailVerification(existing.email,token)}catch(e){emailSent=false;console.error('Email verification recovery send failed:',e.message)}
      res.setHeader('Set-Cookie',sessionCookie(sid));return json(res,200,{user:safeUser(existing),emailVerificationSent:emailSent,message:emailSent?'This account already existed but was not verified. A new verification email has been sent.':'This account already existed but was not verified. You are signed in; use Resend email after the mail service is available.'});
    }
    const hp=hashPassword(b.password);const roles=Array.isArray(b.roles)&&b.roles.length?b.roles.slice(0,5):['member'];const token=crypto.randomBytes(32).toString('hex'),now=Date.now();const u={id:id('u'),name:String(b.name).trim(),email,phone:phone.slice(0,50),emailVerifiedAt:null,emailVerificationTokenHash:emailTokenHash(token),emailVerificationExpiresAt:new Date(now+24*60*60*1000).toISOString(),role:roles[0],roles,country:b.country||'',region:b.region||'',language:b.language||'en',currency:b.currency||'USD',verified:false,verificationStatus:'not_started',termsAcceptedAt:new Date().toISOString(),termsVersion:String(b.termsVersion||'2026-09-17'),...hp,createdAt:new Date().toISOString()};db.users.push(u);const sid=addSession(db,u.id);await writeDB(db);let emailSent=true;try{await sendEmailVerification(u.email,token)}catch(e){emailSent=false;console.error('Email verification send failed:',e.message)}res.setHeader('Set-Cookie',sessionCookie(sid));return json(res,201,{user:safeUser(u),emailVerificationSent:emailSent,message:emailSent?'Account created. Check your email to verify and activate the account.':'Account created, but the verification email could not be sent. Open Account and use Resend email.'});
  }
  if(p==='/api/email/verify'&&req.method==='POST'){
    const b=await getBody(req),token=String(b.token||'').trim();if(!token)return json(res,400,{error:'Verification token is required.'});
    const db=readDB(),h=emailTokenHash(token),now=Date.now(),u=db.users.find(x=>x.emailVerificationTokenHash===h&&!x.emailVerifiedAt&&new Date(x.emailVerificationExpiresAt||0).getTime()>now);
    if(!u)return json(res,400,{error:'This email verification link is invalid or has expired.'});
    u.emailVerifiedAt=new Date().toISOString();u.emailVerificationTokenHash=null;u.emailVerificationExpiresAt=null;await writeDB(db);return json(res,200,{ok:true,user:safeUser(u),message:'Email address verified successfully.'});
  }
  if(p==='/api/email/resend'&&req.method==='POST'){
    const u0=auth(req);if(!u0)return json(res,401,{error:'Login required.'});const db=readDB(),u=db.users.find(x=>x.id===u0.id);if(!u)return json(res,404,{error:'User not found.'});if(u.emailVerifiedAt)return json(res,200,{ok:true,message:'Email address is already verified.'});
    const token=crypto.randomBytes(32).toString('hex');u.emailVerificationTokenHash=emailTokenHash(token);u.emailVerificationExpiresAt=new Date(Date.now()+24*60*60*1000).toISOString();await writeDB(db);try{await sendEmailVerification(u.email,token)}catch(e){console.error('Email verification resend failed:',e.message);return json(res,503,{error:'Verification email is temporarily unavailable. Please try again later.'})}return json(res,200,{ok:true,message:'Verification email sent.'});
  }
  if(p==='/api/login'&&req.method==='POST'){
    if(!loginAllowed(req))return json(res,429,{error:'Too many login attempts. Please try again later.'});const b=await getBody(req),db=readDB(),u=db.users.find(x=>x.email===String(b.email||'').toLowerCase());if(!u){recordLoginFailure(req);return json(res,401,{error:'Invalid email or password.'})}if(u.accountStatus==='suspended')return json(res,403,{error:'Account suspended.'});const hp=hashPassword(String(b.password||''),u.salt);if(!crypto.timingSafeEqual(Buffer.from(hp.hash,'hex'),Buffer.from(u.hash,'hex'))){recordLoginFailure(req);return json(res,401,{error:'Invalid email or password.'})}clearLoginFailures(req);const sid=addSession(db,u.id);await writeDB(db);res.setHeader('Set-Cookie',sessionCookie(sid));return json(res,200,{user:safeUser(u)});
  }
  if(p==='/api/logout'&&req.method==='POST'){const ids=sessionIdsFromRequest(req),db=readDB();if(ids.length)db.sessions=(db.sessions||[]).filter(x=>!ids.includes(x.id));await writeDB(db);res.setHeader('Set-Cookie',clearSessionCookie());return json(res,200,{ok:true});}
  if(p==='/api/password/forgot'&&req.method==='POST'){
    const b=await getBody(req),email=String(b.email||'').trim().toLowerCase();
    if(!email)return json(res,400,{error:'Email is required.'});
    const db=readDB(),u=db.users.find(x=>x.email===email);
    const generic={ok:true,message:'If an account exists for that email, a password reset link has been sent.'};
    if(!u)return json(res,200,generic);
    const now=Date.now();db.passwordResets=(db.passwordResets||[]).filter(x=>new Date(x.expiresAt).getTime()>now&&!x.usedAt);
    const token=crypto.randomBytes(32).toString('hex');
    db.passwordResets.push({id:id('pr'),userId:u.id,tokenHash:resetTokenHash(token),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+30*60*1000).toISOString(),usedAt:null});
    await writeDB(db);
    try{await sendPasswordResetEmail(u.email,token)}catch(e){console.error('Password reset email failed:',e.message);db.passwordResets=db.passwordResets.filter(x=>x.tokenHash!==resetTokenHash(token));await writeDB(db);return json(res,503,{error:'Password reset email is temporarily unavailable. Please try again later.'})}
    return json(res,200,generic);
  }
  if(p==='/api/password/reset'&&req.method==='POST'){
    const b=await getBody(req),token=String(b.token||''),next=String(b.password||'');
    if(!token||next.length<8)return json(res,400,{error:'A valid reset link and password (8+ characters) are required.'});
    const db=readDB(),h=resetTokenHash(token),now=Date.now(),r=(db.passwordResets||[]).find(x=>x.tokenHash===h&&!x.usedAt&&new Date(x.expiresAt).getTime()>now);
    if(!r)return json(res,400,{error:'This reset link is invalid or has expired.'});
    const u=db.users.find(x=>x.id===r.userId);if(!u)return json(res,400,{error:'This reset link is invalid or has expired.'});
    const hp=hashPassword(next);u.salt=hp.salt;u.hash=hp.hash;r.usedAt=new Date().toISOString();
    db.sessions=(db.sessions||[]).filter(x=>x.userId!==u.id);db.passwordResets=(db.passwordResets||[]).filter(x=>x.userId!==u.id||x.id===r.id);
    await writeDB(db);res.setHeader('Set-Cookie',clearSessionCookie());return json(res,200,{ok:true,message:'Password updated. You can now sign in with your new password.'});
  }

  if(p==='/api/owner/password'&&req.method==='PUT'){
    const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});
    const b=await getBody(req),current=String(b.currentPassword||''),next=String(b.newPassword||'');
    if(next.length<10)return json(res,400,{error:'New password must be at least 10 characters.'});
    const hp=hashPassword(current,u.salt);try{if(!crypto.timingSafeEqual(Buffer.from(hp.hash,'hex'),Buffer.from(u.hash,'hex')))return json(res,401,{error:'Current password is incorrect.'});}catch{return json(res,401,{error:'Current password is incorrect.'});}
    const db=readDB(),target=db.users.find(x=>x.id===u.id);if(!target)return json(res,404,{error:'Owner account not found.'});const nh=hashPassword(next);target.salt=nh.salt;target.hash=nh.hash;await writeDB(db);return json(res,200,{ok:true});
  }

  if(p==='/api/account/profile'&&req.method==='PUT'){
    const u0=auth(req);if(!u0)return json(res,401,{error:'Login required.'});
    const b=await getBody(req),db=readDB(),u=db.users.find(x=>x.id===u0.id);if(!u)return json(res,404,{error:'User not found.'});
    const name=String(b.name??u.name??'').trim(),phone=String(b.phone??u.phone??'').trim();if(!name)return json(res,400,{error:'Name is required.'});if(!phone)return json(res,400,{error:'Phone number is required.'});
    u.name=name.slice(0,120);u.phone=phone.slice(0,50);if('country' in b)u.country=String(b.country||'').trim().slice(0,80);if('region' in b)u.region=String(b.region||'').trim().slice(0,120);
    await writeDB(db);return json(res,200,{ok:true,user:safeUser(u),message:'Profile updated.'});
  }

  if(p==='/api/account'&&req.method==='DELETE'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});
    if(u.role==='owner')return json(res,403,{error:'The platform-owner account cannot be deleted from this screen.'});
    const body=await getBody(req);const password=String(body.password||'');
    if(!password)return json(res,400,{error:'Password is required to delete your account.'});
    const hp=hashPassword(password,u.salt);
    try{if(!crypto.timingSafeEqual(Buffer.from(hp.hash,'hex'),Buffer.from(u.hash,'hex')))return json(res,401,{error:'Incorrect password. Account was not deleted.'});}catch{return json(res,401,{error:'Incorrect password. Account was not deleted.'});}
    const db=readDB(),uid=u.id;
    const listingIds=new Set(db.listings.filter(x=>x.userId===uid).map(x=>x.id));
    const offerIds=new Set(db.offers.filter(x=>x.fromUserId===uid||x.toUserId===uid||listingIds.has(x.listingId)).map(x=>x.id));
    db.users=db.users.filter(x=>x.id!==uid);
    db.listings=db.listings.filter(x=>x.userId!==uid);
    db.offers=db.offers.filter(x=>x.fromUserId!==uid&&x.toUserId!==uid&&!listingIds.has(x.listingId));
    db.bookings=db.bookings.filter(x=>x.buyerUserId!==uid&&x.providerUserId!==uid&&!listingIds.has(x.listingId)&&!offerIds.has(x.offerId));
    db.verifications=db.verifications.filter(x=>x.userId!==uid);db.notifications=(db.notifications||[]).filter(x=>x.userId!==uid);
    db.matches=[];recomputeMatches(db);
    try{if(fs.existsSync(UPLOADS)){for(const name of fs.readdirSync(UPLOADS)){if(name.startsWith(uid+'_')){try{fs.unlinkSync(path.join(UPLOADS,name))}catch{}}}}}catch{}
    db.sessions=(db.sessions||[]).filter(x=>x.userId!==uid);
    await writeDB(db);res.setHeader('Set-Cookie',clearSessionCookie());return json(res,200,{ok:true,message:'Account deleted.'});
  }

  if(p==='/api/me'&&req.method==='GET'){const u=auth(req);return json(res,200,{user:u?safeUser(u):null});}
  if(p==='/api/integrations/status'&&req.method==='GET'){const paymentCredentials=!!(process.env.STRIPE_SECRET_KEY||process.env.PAYMENT_PROVIDER_SECRET);const webhookSecret=!!(process.env.STRIPE_WEBHOOK_SECRET||process.env.PAYMENT_WEBHOOK_SECRET);const kycProvider=!!(process.env.KYC_PROVIDER||process.env.KYC_API_KEY);return json(res,200,{payment:{mode:paymentCredentials?'provider_credentials_detected':'test',credentialsDetected:paymentCredentials,webhookSecretDetected:webhookSecret,realCaptureEnabled:paymentCredentials&&webhookSecret},kyc:{providerConfigured:kycProvider,manualReviewEnabled:false}});}
  if(p==='/api/settings'&&req.method==='GET'){return json(res,200,{settings:readDB().settings});}
  if(p==='/api/admin/settings'&&req.method==='PUT'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const b=await getBody(req),db=readDB();if(Number.isFinite(Number(b.platformFeePct))){const nextFeePct=Math.max(0,Math.min(100,Number(b.platformFeePct)));db.settings.platformFeePct=nextFeePct;}if(b.defaultCurrency)db.settings.defaultCurrency=String(b.defaultCurrency).slice(0,5);for(const k of ['brandName','siteUrl','ownerName','ownerEmail','legalEntity','supportEmail'])if(k in b)db.settings[k]=String(b[k]||'').trim().slice(0,180);await writeDB(db);return json(res,200,{settings:db.settings});}
  if(p==='/api/listings'&&req.method==='GET'){const db=readDB();const listings=db.listings.filter(x=>x.status==='open').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(x=>publicListing(x,db));return json(res,200,{listings});}
  if(p==='/api/listings'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});if(!accountActive(u))return json(res,403,{error:'Verify your email before using the marketplace.'});const b=await getBody(req);const resources=['driver','truck','load','warehouse','storage','equipment'];const intents=['have','need'];const priceModes=['fixed','negotiable','request_quotes','open_bidding'];if(!resources.includes(b.resource)||!intents.includes(b.intent)||!priceModes.includes(b.priceMode))return json(res,400,{error:'Invalid listing.'});
    const db=readDB();const x={id:id('l'),userId:u.id,intent:b.intent,resource:b.resource,title:String(b.title||'').slice(0,120),country:b.country||u.country||'',currency:b.currency||u.currency||db.settings.defaultCurrency,priceMode:b.priceMode,price:Number(b.price||0),data:sanitizeData(b.data),status:'open',createdAt:new Date().toISOString()};db.listings.push(x);recomputeMatches(db);await writeDB(db);return json(res,201,{listing:x});
  }
  if(p.startsWith('/api/listings/')&&req.method==='DELETE'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const lid=p.split('/').pop(),db=readDB(),x=db.listings.find(z=>z.id===lid);if(!x)return json(res,404,{error:'Listing not found.'});if(x.userId!==u.id&&!isOwner(u))return json(res,403,{error:'Not your listing.'});x.status='closed';recomputeMatches(db);await writeDB(db);return json(res,200,{ok:true});}
  if(p==='/api/matches'&&req.method==='GET'){const db=readDB();recomputeMatches(db);await writeDB(db);const map=Object.fromEntries(db.listings.map(x=>[x.id,publicListing(x,db)]));return json(res,200,{matches:db.matches.map(m=>({...m,listings:m.listingIds.map(i=>map[i]).filter(Boolean)}))});}
  if(p==='/api/offers'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const myListings=new Set(db.listings.filter(x=>x.userId===u.id).map(x=>x.id));const mine=isOwner(u)?db.offers:db.offers.filter(o=>o.fromUserId===u.id||o.toUserId===u.id||myListings.has(o.listingId));const completedOfferIds=new Set(db.bookings.filter(b=>b.status==='completed').map(b=>b.offerId));const offers=mine.filter(o=>!completedOfferIds.has(o.id));return json(res,200,{offers:offers.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});}
  if(p==='/api/offers'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});if(!accountActive(u))return json(res,403,{error:'Verify your email before using the marketplace.'});const b=await getBody(req),db=readDB(),listing=db.listings.find(x=>x.id===b.listingId&&x.status==='open');if(!listing)return json(res,404,{error:'Listing not found.'});if(listing.userId===u.id)return json(res,400,{error:'You cannot offer on your own listing.'});const amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Offer amount required.'});const o={id:id('o'),listingId:listing.id,fromUserId:u.id,toUserId:listing.userId,amount,currency:b.currency||listing.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:b.parentOfferId||null,createdAt:new Date().toISOString()};db.offers.push(o);addNotification(db,listing.userId,'offer','New offer received',`${u.name||'A member'} sent you an offer of ${o.currency} ${o.amount}.`,'offers');await writeDB(db);return json(res,201,{offer:o});
  }
  if(/^\/api\/offers\/[^/]+\/(accept|reject|counter)$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const parts=p.split('/'),oid=parts[3],action=parts[4],db=readDB(),o=db.offers.find(x=>x.id===oid);if(!o)return json(res,404,{error:'Offer not found.'});if(o.toUserId!==u.id&&o.fromUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Not allowed.'});
    if(action==='accept'){
      if(o.toUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Only recipient can accept.'});o.status='accepted';o.acceptedAt=new Date().toISOString();const booking=createBookingFromAcceptedOffer(db,o);if(!booking)return json(res,409,{error:'The accepted listing could not be converted into a deal.'});o.dealId=booking.id;addNotification(db,booking.buyerUserId,'agreement','Agreement accepted',`Your ${booking.dealType} agreement is accepted. Complete basic verification before the TUT Move fee.`,'offers');addNotification(db,booking.providerUserId,'agreement','You were selected',`Your ${booking.dealType} offer/agreement was accepted. Open Activity to continue.`,'offers');recomputeMatches(db);await writeDB(db);return json(res,200,{booking:bookingView(booking,db)});
    }
    if(action==='reject'){o.status='rejected';addNotification(db,o.fromUserId,'offer_rejected','Offer update','Your offer was not accepted.','offers');await writeDB(db);return json(res,200,{offer:o});}
    const b=await getBody(req),amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Counter amount required.'});o.status='countered';const c={id:id('o'),listingId:o.listingId,fromUserId:u.id,toUserId:u.id===o.fromUserId?o.toUserId:o.fromUserId,amount,currency:o.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:o.id,createdAt:new Date().toISOString()};db.offers.push(c);addNotification(db,c.toUserId,'counter','Counter offer received',`${u.name||'A member'} sent a counter offer of ${c.currency} ${c.amount}.`,'offers');await writeDB(db);return json(res,201,{offer:c});
  }
  if(p==='/api/verification/me'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});
    const db=readDB(),me=db.users.find(x=>x.id===u.id);if(!me)return json(res,404,{error:'User not found.'});
    return json(res,200,{verification:me.verification||{status:'not_submitted',role:'',legalName:'',country:'',licenceNumber:'',vehicleId:'',notes:'',submittedAt:null,reviewedAt:null}});
  }
  if(p==='/api/verification/submit'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const body=await getBody(req,30e6),db=readDB(),me=db.users.find(x=>x.id===u.id);if(!me)return json(res,404,{error:'User not found.'});if(!me.emailVerifiedAt)return json(res,403,{error:'Verify your email address before saving your verification profile.'});const activeDeal=(db.bookings||[]).find(x=>[x.buyerUserId,x.providerUserId].includes(me.id)&&['basic_verification','basic_waiting','agreement_terms','commission_due'].includes(x.status));if(!activeDeal)return json(res,403,{error:'Verification documents are requested only after a preliminary deal is accepted.'});
    const files={};for(const k of ['license','identity','selfie']){if(body.files&&body.files[k])files[k]=saveDataUrl(u.id,k,body.files[k]);}
    me.verification={...(me.verification||{}),status:'profile_saved',role:String(body.role||''),legalName:String(body.legalName||'').trim(),phone:String(body.phone||'').trim().slice(0,50),country:String(body.country||''),identityNumber:String(body.identityNumber||'').trim(),licenceNumber:String(body.licenceNumber||'').trim(),licenceClasses:Array.isArray(body.licenceClasses)?body.licenceClasses.map(x=>String(x).slice(0,50)).slice(0,20):[],licenceExpiry:String(body.licenceExpiry||'').slice(0,20),endorsements:String(body.endorsements||'').trim().slice(0,500),registrationNumber:String(body.registrationNumber||'').trim().slice(0,120),vehicleId:String(body.vehicleId||'').trim(),notes:String(body.notes||'').trim(),files:{...(me.verification?.files||{}),...files},submittedAt:new Date().toISOString(),reviewedAt:null};
    me.phone=String(body.phone||me.phone||'').trim().slice(0,50);me.verified=false;me.verificationStatus='profile_saved';
    await writeDB(db);return json(res,200,{verification:me.verification,ready:verificationReady(me),message:verificationReady(me)?'Verification saved. Return to Activity to review the other party.':'Verification saved, but required documents/details are still missing. Upload the required ID + selfie (and driving licence for driver/carrier roles).'});
  }
  if(false&&p==='/api/admin/verifications'&&req.method==='GET'){
    const u=auth(req);if(!u||!isOwner(u))return json(res,403,{error:'Owner only.'});const db=readDB();
    return json(res,200,{items:db.users.filter(x=>x.verification).map(x=>({userId:x.id,email:x.email,name:x.name,verification:x.verification}))});
  }
  if(false&&/^\/api\/admin\/verifications\/[^/]+\/review$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u||!isOwner(u))return json(res,403,{error:'Owner only.'});const body=await getBody(req);if(!['verified','rejected'].includes(body.status))return json(res,400,{error:'Invalid status.'});
    const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target||!target.verification)return json(res,404,{error:'Verification not found.'});
    target.verification.status=body.status;target.verification.reviewNote=String(body.reviewNote||'');target.verification.reviewedAt=new Date().toISOString();target.verified=body.status==='verified';target.verificationStatus=body.status==='verified'?'manual_verified':'rejected';await writeDB(db);return json(res,200,{verification:target.verification});
  }
  if(/^\/api\/bookings\/[^/]+\/checkout$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});const feePayerUserId=b.feePayerUserId||b.buyerUserId;if(feePayerUserId!==u.id)return json(res,403,{error:'Only the party responsible for the TUT Move fee can pay it.'});if(b.status!=='commission_due'||!b.dealTerms?.confirmed)return json(res,409,{error:'Both parties must confirm the underlying payment method and timing before the TUT Move fee can be paid.'});if(b.paymentStatus==='paid')return json(res,409,{error:'TUT Move fee is already paid.'});if(!(b.basicVerification?.buyerContinue&&b.basicVerification?.providerContinue))return json(res,409,{error:'Both parties must complete basic verification and choose Continue before payment.'});const session=await createStripeCheckout(b,db.settings.siteUrl||'https://tutmove.com');b.stripeCheckoutSessionId=session.id;b.paymentStatus='checkout_created';await writeDB(db);return json(res,200,{url:session.url});
  }
  if(p==='/api/stripe/webhook'&&req.method==='POST'){
    const secret=process.env.STRIPE_WEBHOOK_SECRET;if(!secret)return json(res,503,{error:'Webhook secret is not configured.'});const raw=await rawBody(req);if(!stripeSigValid(raw,req.headers['stripe-signature'],secret))return json(res,400,{error:'Invalid Stripe signature.'});const event=JSON.parse(raw.toString('utf8'));if(event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded'){const session=event.data?.object||{};if(session.payment_status==='paid'){const bid=session.metadata?.deal_id||session.client_reference_id,db=readDB(),b=db.bookings.find(x=>x.id===bid);if(b){const expected=Math.round(Number(b.platformFee||0)*100),currency=String(b.currency||'').toLowerCase();if(Number(session.amount_total)===expected&&String(session.currency||'').toLowerCase()===currency){b.paymentStatus='paid';b.paymentMode='stripe_fee_only';b.stripeCheckoutSessionId=session.id;b.commissionPaidAt=new Date().toISOString();b.status='deal_open';addNotification(db,b.buyerUserId,'payment','TUT Move fee paid','The fee is confirmed. The deal is open and limited contact details are available.','offers');addNotification(db,b.providerUserId,'payment','TUT Move fee paid','The fee is confirmed. The deal is open and limited contact details are available.','offers');await writeDB(db)}}}}return json(res,200,{received:true});
  }
  if(/^\/api\/bookings\/[^/]+\/basic-profile$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(!['basic_verification','basic_waiting','agreement_terms','commission_due'].includes(b.status))return json(res,409,{error:'Basic verification is not available in the current deal state.'});const otherId=u.id===b.buyerUserId?b.providerUserId:b.buyerUserId,other=db.users.find(x=>x.id===otherId),me=db.users.find(x=>x.id===u.id);const ov=other?.verification||{};return json(res,200,{myReady:verificationReady(me),otherReady:verificationReady(other),profile:{displayName:String(ov.legalName||other?.name||'').split(/\s+/).slice(0,2).join(' '),country:ov.country||other?.country||'',role:ov.role||other?.role||'',emailVerified:!!other?.emailVerifiedAt,contactUnlocked:false,phone:'',email:'',identityProvided:!!ov.files?.identity?.name,identityNumberMasked:maskValue(ov.identityNumber),selfieProvided:!!ov.files?.selfie?.name,licenceProvided:!!ov.files?.license?.name,licenceNumberMasked:maskValue(ov.licenceNumber),licenceExpiry:ov.licenceExpiry||'',licenceClasses:ov.licenceClasses||[]},basicVerification:b.basicVerification||{}});
  }
  if(/^\/api\/bookings\/[^/]+\/basic-continue$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(!['basic_verification','basic_waiting','agreement_terms','commission_due'].includes(b.status))return json(res,409,{error:'This deal can no longer change its basic-verification decision.'});const me=db.users.find(x=>x.id===u.id),other=db.users.find(x=>x.id===(u.id===b.buyerUserId?b.providerUserId:b.buyerUserId));if(!verificationReady(me)||!verificationReady(other))return json(res,409,{error:'Both parties must provide the required basic verification information first.'});b.basicVerification=b.basicVerification||{buyerContinue:false,providerContinue:false};const now=new Date().toISOString();if(u.id===b.buyerUserId){b.basicVerification.buyerContinue=true;b.basicVerification.buyerAt=now}else{b.basicVerification.providerContinue=true;b.basicVerification.providerAt=now}const ready=b.basicVerification.buyerContinue&&b.basicVerification.providerContinue;b.status=ready?'agreement_terms':'basic_waiting';if(ready){addNotification(db,b.buyerUserId,'agreement','Basic verification complete','Both parties chose Continue. The TUT Move fee is now ready for payment.','offers');addNotification(db,b.providerUserId,'agreement','Basic verification complete','Both parties chose Continue. Waiting for the TUT Move fee.','offers')}await writeDB(db);return json(res,200,{booking:b,readyForPayment:!!ready});
  }
  if(/^\/api\/bookings\/[^/]+\/deal-terms$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],body=await getBody(req),db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(!['agreement_terms','commission_due'].includes(b.status))return json(res,409,{error:'Deal terms are not available yet.'});
    const methods=['Cash','Bank Transfer','Cash / Bank Transfer','Other agreed method'],timings=['Upon meeting','Upon handover','Before handover','After delivery / service','As agreed between the parties'];const settlementMethod=String(body.settlementMethod||''),paymentTiming=String(body.paymentTiming||'');if(!methods.includes(settlementMethod)||!timings.includes(paymentTiming))return json(res,400,{error:'Choose a valid payment method and payment timing.'});
    b.dealTerms=b.dealTerms||{buyer:null,provider:null,confirmed:false};const choice={settlementMethod,paymentTiming,at:new Date().toISOString()};if(u.id===b.buyerUserId)b.dealTerms.buyer=choice;else b.dealTerms.provider=choice;const a=b.dealTerms.buyer,z=b.dealTerms.provider;b.dealTerms.confirmed=!!(a&&z&&a.settlementMethod===z.settlementMethod&&a.paymentTiming===z.paymentTiming);if(b.dealTerms.confirmed){b.dealTerms.settlementMethod=a.settlementMethod;b.dealTerms.paymentTiming=a.paymentTiming;b.dealTerms.confirmedAt=new Date().toISOString();b.status='commission_due';}else b.status='agreement_terms';await writeDB(db);return json(res,200,{booking:bookingView(b,db),confirmed:b.dealTerms.confirmed});
  }
  if(/^\/api\/bookings\/[^/]+\/basic-reject$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(['cancelled','completed'].includes(b.status))return json(res,409,{error:'This deal is already closed.'});if(b.paymentStatus==='paid')return json(res,409,{error:'This deal is already paid and open.'});b.status='cancelled';b.cancelledAt=new Date().toISOString();b.basicVerification=b.basicVerification||{};b.basicVerification.rejectedBy=u.id;const listing=db.listings.find(x=>x.id===b.listingId);if(listing&&listing.status==='booked')listing.status='open';const offer=db.offers.find(x=>x.id===b.offerId);if(offer)offer.status='rejected_after_basic_verification';recomputeMatches(db);await writeDB(db);return json(res,200,{ok:true});
  }
  if(/^\/api\/bookings\/[^/]+\/deal-profile$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(b.paymentStatus!=='paid')return json(res,403,{error:'Deal details unlock only after the TUT Move fee is paid.'});const other=db.users.find(x=>x.id===(u.id===b.buyerUserId?b.providerUserId:b.buyerUserId)),v=other?.verification||{};return json(res,200,{profile:{legalName:v.legalName||other?.name||'',phone:v.phone||other?.phone||'',email:other?.email||'',country:v.country||other?.country||'',role:v.role||other?.role||'',identityNumberMasked:maskValue(v.identityNumber),licenceNumberMasked:maskValue(v.licenceNumber),licenceClasses:v.licenceClasses||[],licenceExpiry:v.licenceExpiry||'',selfieAvailable:!!v.files?.selfie?.name},mutualVerification:b.mutualVerification||{},completion:b.completion||{}});
  }
  if(/^\/api\/bookings\/[^/]+\/complete$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(b.status==='completed')return json(res,409,{error:'This deal is already completed.'});if(b.status!=='deal_open'||b.paymentStatus!=='paid')return json(res,409,{error:'The deal must be open before completion.'});b.completion=b.completion||{buyer:false,provider:false};const now=new Date().toISOString();if(u.id===b.buyerUserId){b.completion.buyer=true;b.completion.buyerAt=now}else{b.completion.provider=true;b.completion.providerAt=now}const complete=b.completion.buyer&&b.completion.provider;if(complete){b.status='completed';b.completedAt=now;closeCompletedDealListings(db,b);b.dealRecordReady=true;addNotification(db,b.buyerUserId,'deal','Deal completed','Both parties confirmed completion. The deal is closed and the final Deal Record is ready.','offers');addNotification(db,b.providerUserId,'deal','Deal completed','Both parties confirmed completion. The deal is closed and the final Deal Record is ready.','offers')}else b.status='deal_open';await writeDB(db);if(complete){const pdf=await dealPdfBuffer(b,db);await emailDealRecord(b,db,pdf);return json(res,200,{complete,booking:b,pdfUrl:`/api/bookings/${b.id}/deal-record.pdf`});}return json(res,200,{complete,booking:b});
  }
  if(p==='/api/notifications'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const items=(db.notifications||[]).filter(n=>n.userId===u.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,60);return json(res,200,{items,unread:items.filter(x=>!x.read).length});
  }
  if(p==='/api/notifications/read'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();for(const n of (db.notifications||[]))if(n.userId===u.id)n.read=true;await writeDB(db);return json(res,200,{ok:true});
  }
  if(/^\/api\/bookings\/[^/]+\/deal-record\.pdf$/.test(p)&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Deal not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id)&&!isOwner(u))return json(res,403,{error:'Not part of this deal.'});if(b.status!=='completed')return json(res,409,{error:'Deal Record is available after completion.'});const pdf=await dealPdfBuffer(b,db);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="TUT-Move-Deal-${b.id}.pdf"`,'Content-Length':pdf.length,'Cache-Control':'private, no-store'});return res.end(pdf);}
  if(p==='/api/bookings/history'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const visible=isOwner(u)?db.bookings:db.bookings.filter(b=>b.buyerUserId===u.id||b.providerUserId===u.id);const deals=visible.filter(b=>b.status==='completed').sort((a,b)=>String(b.completedAt||b.createdAt).localeCompare(String(a.completedAt||a.createdAt))).map(b=>bookingView(b,db));return json(res,200,{deals});}
  if(p==='/api/bookings'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();db.bookings.forEach(b=>normalizeBookingWorkflow(b,db));const visible=isOwner(u)?db.bookings:db.bookings.filter(b=>b.buyerUserId===u.id||b.providerUserId===u.id);const bookings=visible.filter(b=>!['completed','cancelled'].includes(b.status)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(b=>bookingView(b,db));return json(res,200,{bookings});}
  // v94: obsolete payment/trip/pickup/delivery and post-payment mutual-document flows are removed.
  // v94: verification profile exists only for an accepted preliminary deal.
  if(p==='/api/admin/summary'&&req.method==='GET'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const db=readDB();const marketplaceUsers=db.users.filter(x=>x.role!=='owner');const roleCounts={driver:0,carrier:0,shipper:0,warehouse:0,equipment:0,other:0};for(const x of marketplaceUsers){const roles=(x.roles&&x.roles.length?x.roles:[x.role]).filter(r=>r&&r!=='owner');if(!roles.length)roleCounts.other++;else for(const r of new Set(roles)){if(Object.prototype.hasOwnProperty.call(roleCounts,r))roleCounts[r]++;else roleCounts.other++;}}const pendingVerifications=(db.verifications||[]).filter(v=>['pending','pending_review','submitted','not_started'].includes(v.status)).length;return json(res,200,{users:marketplaceUsers.map(safeUser),listings:db.listings,offers:db.offers,bookings:db.bookings,verifications:db.verifications,settings:db.settings,stats:{users:marketplaceUsers.length,roleCounts,pendingVerifications,verifiedUsers:marketplaceUsers.filter(x=>x.verified||x.verificationStatus==='verified').length,openListings:db.listings.filter(x=>x.status==='open').length,offers:db.offers.length,bookings:db.bookings.length,platformRevenue:+db.bookings.reduce((s,b)=>s+(b.platformFee||0),0).toFixed(2)}});}
  if(/^\/api\/admin\/users\/[^/]+$/.test(p)&&req.method==='DELETE'){const owner=auth(req);if(!isOwner(owner))return json(res,403,{error:'Owner access required.'});const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target)return json(res,404,{error:'User not found.'});if(target.role==='owner')return json(res,403,{error:'Owner account cannot be deleted.'});const listingIds=new Set(db.listings.filter(x=>x.userId===uid).map(x=>x.id));const offerIds=new Set(db.offers.filter(x=>x.fromUserId===uid||x.toUserId===uid||listingIds.has(x.listingId)).map(x=>x.id));db.users=db.users.filter(x=>x.id!==uid);db.listings=db.listings.filter(x=>x.userId!==uid);db.offers=db.offers.filter(x=>x.fromUserId!==uid&&x.toUserId!==uid&&!listingIds.has(x.listingId));db.bookings=db.bookings.filter(x=>x.buyerUserId!==uid&&x.providerUserId!==uid&&!listingIds.has(x.listingId)&&!offerIds.has(x.offerId));db.verifications=db.verifications.filter(x=>x.userId!==uid);db.notifications=(db.notifications||[]).filter(x=>x.userId!==uid);db.sessions=(db.sessions||[]).filter(x=>x.userId!==uid);db.matches=[];recomputeMatches(db);try{if(fs.existsSync(UPLOADS)){for(const name of fs.readdirSync(UPLOADS)){if(name.startsWith(uid+'_')){try{fs.unlinkSync(path.join(UPLOADS,name))}catch{}}}}}catch{}await writeDB(db);return json(res,200,{ok:true,message:'User account deleted.'});}
  if(false&&p.startsWith('/api/admin/users/')&&p.endsWith('/verify')&&req.method==='POST'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target)return json(res,404,{error:'User not found.'});target.verified=true;target.verificationStatus='manual_verified';if(target.verification){target.verification.status='verified';target.verification.reviewedAt=new Date().toISOString();}await writeDB(db);return json(res,200,{user:safeUser(target)});}
  if(serveStatic(res,p,req))return;
  return json(res,404,{error:'Not found'});
 }catch(e){console.error(e);return json(res,500,{error:e.message||'Server error'});}
});
initDB()
  .then(async()=>{const db=readDB();let changed=migrateAcceptedOffersToDeals(db);if(reconcileCompletedDeals(db))changed=true;if(changed)await writeDB(db);server.listen(PORT,()=>console.log(`TUT Move v97 canonical deal flow running on ${PORT}`))})
  .catch(err=>{console.error('Database initialization failed:',err);process.exit(1)});
