const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const tls = require('tls');
let nodemailer; try { nodemailer = require('nodemailer'); } catch (_) { console.warn('Email disabled: install nodemailer to enable SMTP.'); }
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

function emptyDB(){return {users:[], sessions:[], passwordResets:[], listings:[], offers:[], bookings:[], matches:[], verifications:[], notifications:[], settings:{brandName:'TUT Move',siteUrl:'https://tutmove.com',customerFeeUSD:9.50,providerFeeUSD:9.50,customerFee:9.50,providerFee:9.50,commissionCurrency:'USD',defaultCurrency:'USD',ownerName:'',ownerEmail:'',legalEntity:'',supportEmail:'info@tutmove.com',launchMarkets:['USA','Canada','Europe','Middle East']}};}
function normalizeDB(d){const st={...emptyDB().settings,...((d&&d.settings)||{})};if(!Object.prototype.hasOwnProperty.call(d?.settings||{},'customerFee'))st.customerFee=st.customerFeeUSD;if(!Object.prototype.hasOwnProperty.call(d?.settings||{},'providerFee'))st.providerFee=st.providerFeeUSD;if(!Object.prototype.hasOwnProperty.call(d?.settings||{},'commissionCurrency'))st.commissionCurrency='USD';return {...emptyDB(),...(d||{}),settings:st}}
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
const sseClients=new Map(),ssePending=new Set();
function ssePush(userIds){for(const uid of userIds){const set=sseClients.get(uid);if(!set)continue;for(const r of set){try{r.write('event: update\ndata: {"t":'+Date.now()+'}\n\n')}catch(e){}}}}
function sseFlush(){if(!ssePending.size)return;const ids=[...ssePending];ssePending.clear();ssePush(ids)}
setInterval(()=>{for(const set of sseClients.values())for(const r of set){try{r.write(': ping\n\n')}catch(e){}}},20000).unref();
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
  sseFlush();
}
async function dbInfo(){
  return {persistent:!!pgPool,engine:pgPool?'postgresql':'local-file',ownerConfigured:ownerExists()};
}
function id(prefix){return prefix+'_'+crypto.randomBytes(6).toString('hex')}
function addNotification(db,userId,type,title,message,link='offers',dealId=null,offerId=null){
  if(!userId)return null;ssePending.add(userId);db.notifications=db.notifications||[];const n={id:id('n'),userId,type,title,message,link,dealId,offerId,read:false,createdAt:new Date().toISOString()};db.notifications.push(n);if(db.notifications.length>1000)db.notifications=db.notifications.slice(-1000);return n;
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
  const out={...b,feePayerUserId:b.feePayerUserId||b.buyerUserId,verificationState:{buyerReady:verificationReady(buyer,db,b),providerReady:verificationReady(provider,db,b),buyerMissing:verificationMissing(buyer,db,b),providerMissing:verificationMissing(provider,db,b),buyerSubmitted:!!buyer?.verification?.submittedAt,providerSubmitted:!!provider?.verification?.submittedAt}},type=bookingDealType(b,db);
  out.partyLabels={buyer:capacityLabel(type,'buyer',buyer),provider:capacityLabel(type,'provider',provider)};
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
  if(!nodemailer)throw new Error('Email service unavailable: nodemailer is not installed');const transporter=nodemailer.createTransport({host,port:Number(port),secure,auth:{user,pass},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
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
function saveDataUrl(userId,kind,dataUrl){if(!dataUrl||typeof dataUrl!=='string')return null;const m=dataUrl.match(/^data:(image\/(?:jpeg|png|webp|heic|heif)|application\/pdf);base64,(.+)$/);if(!m)return null;const buf=Buffer.from(m[2],'base64');if(buf.length>8*1024*1024)throw new Error('File too large (8MB max).');const ext=m[1]==='application/pdf'?'pdf':m[1].split('/')[1].replace('jpeg','jpg');fs.mkdirSync(UPLOADS,{recursive:true});const name=`${userId}_${kind}_${Date.now()}.${ext}`;fs.writeFileSync(path.join(UPLOADS,name),buf);return {name,mime:m[1],size:buf.length};}
// Privacy-first automatic document preview: never persist or share the raw document.
// This safe fallback intentionally hides the ENTIRE document because generic OCR cannot
// guarantee detection of all identifiers in arbitrary international documents.
function safeDocumentPreview(userId,kind,raw,legalName){
  if(typeof raw!=='string'||!/^data:image\/(?:jpeg|png|webp);base64,/.test(raw))throw new Error('Please upload a JPG, PNG or WebP document photo.');
  const encoded=raw.slice(raw.indexOf(',')+1);
  if(encoded.length>11*1024*1024||encoded.length<100)throw new Error('Invalid document photo or file too large.');
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length>8*1024*1024||bytes.length<64)throw new Error('Document photo must be under 8MB.');
  const mime=raw.slice(5,raw.indexOf(';'));
  const valid=(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)
    ||(mime==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    ||(mime==='image/webp'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP');
  if(!valid)throw new Error('Photo contents do not match the selected image format.');
  const escapeXml=v=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const name=escapeXml(String(legalName||'').slice(0,80));
  const label=kind==='identity'?'IDENTITY DOCUMENT':'LICENCE / PERMIT';
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="630" viewBox="0 0 1000 630"><rect width="1000" height="630" fill="#121922"/><rect x="30" y="30" width="940" height="570" rx="22" fill="#202b39" stroke="#c6a15c" stroke-width="5"/><text x="65" y="105" font-family="sans-serif" font-size="32" fill="#e8bd68">TUT MOVE - PRIVACY PREVIEW</text><text x="65" y="170" font-family="sans-serif" font-size="30" fill="white">${label}</text><rect x="65" y="205" width="870" height="245" fill="black"/><text x="90" y="330" font-family="sans-serif" font-size="27" fill="white">DOCUMENT CONTENT AUTOMATICALLY HIDDEN</text><text x="65" y="510" font-family="sans-serif" font-size="26" fill="white">Name: ${name}</text><text x="65" y="560" font-family="sans-serif" font-size="20" fill="#e8bd68">Original document image is not stored or shared.</text></svg>`;
  fs.mkdirSync(UPLOADS,{recursive:true});
  const nameFile=`${userId}_${kind}_${Date.now()}_privacy.svg`;
  fs.writeFileSync(path.join(UPLOADS,nameFile),svg,{flag:'wx'});
  return {name:nameFile,mime:'image/svg+xml',size:Buffer.byteLength(svg),masked:true,redactionMethod:'full_document_safe_fallback_v1'};
}
// Document already masked by the user in the browser (original never uploaded). Only a JPEG is accepted.
function saveMaskedDocument(userId,kind,raw){
  if(typeof raw!=='string'||!/^data:image\/jpeg;base64,/.test(raw))throw new Error('Masked document must be a JPEG image.');
  const bytes=Buffer.from(raw.slice(raw.indexOf(',')+1),'base64');
  if(bytes.length<64||bytes.length>8*1024*1024)throw new Error('Document photo must be under 8MB.');
  if(!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw new Error('Photo contents do not match the selected image format.');
  fs.mkdirSync(UPLOADS,{recursive:true});
  const nameFile=`${userId}_${kind}_${Date.now()}_masked.jpg`;
  fs.writeFileSync(path.join(UPLOADS,nameFile),bytes,{flag:'wx'});
  return {name:nameFile,mime:'image/jpeg',size:bytes.length,masked:true,redactionMethod:'user_confirmed_mask_v1'};
}
function docSafe(f){return !!f&&['full_document_safe_fallback_v1','user_confirmed_mask_v1'].includes(f.redactionMethod)}
function autoPrecheck(v){const required=['license','identity','selfie'];const files=v.files||{};const present=required.every(k=>files[k]&&files[k].size>0);if(!present)return {status:'incomplete',score:0,message:'Required documents are missing.'};const acceptable=required.every(k=>files[k].size>=15000&&files[k].size<=8*1024*1024);if(!acceptable)return {status:'review_required',score:45,message:'Files received but quality/size needs review.'};return {status:'precheck_passed',score:80,message:'Automated file pre-check passed. Official identity/document verification provider is not connected yet.'};}
function publicListing(x,db){const u=db.users.find(z=>z.id===x.userId);return {...x,user:u?{id:u.id,name:u.name,verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started'}:null};}
const staticCache=new Map();
function serveStatic(res,p,req=null){const allowed=new Set(['/','/index.html','/app.js','/style.css','/tut-emblem.png','/tut-header-logo.jpg','/tut-hero-logistics.jpg','/favicon-48.png','/favicon-96.png','/favicon-192.png','/apple-touch-icon.png']);const route=p==='/'?'/index.html':p;if(!allowed.has(route))return false;const f=path.join(ROOT,route.slice(1));let st;try{st=fs.statSync(f)}catch(e){return false}const ext=path.extname(f);const ct={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[ext]||'application/octet-stream';
 let c=staticCache.get(f);if(!c||c.mtime!==st.mtimeMs){const raw=fs.readFileSync(f);const text=['.html','.css','.js'].includes(ext);c={mtime:st.mtimeMs,raw,gz:text?zlib.gzipSync(raw,{level:9}):null,etag:'W/"'+st.size.toString(36)+'-'+Math.floor(st.mtimeMs).toString(36)+'"'};staticCache.set(f,c)}
 const text=!!c.gz;const headers={'Content-Type':ct,'Cache-Control':text?'no-cache':'public, max-age=604800','ETag':c.etag,'Vary':'Accept-Encoding'};
 if(req&&req.headers['if-none-match']===c.etag){res.writeHead(304,headers);res.end();return true}
 let b=c.raw;if(text&&req&&/gzip/.test(String(req.headers['accept-encoding']||''))){b=c.gz;headers['Content-Encoding']='gzip'}headers['Content-Length']=b.length;res.writeHead(200,headers);res.end(b);return true;}


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
  const commissionCurrency=['USD','EUR'].includes(db.settings.commissionCurrency)?db.settings.commissionCurrency:'USD';const customerFee=Number(db.settings.customerFee??db.settings.customerFeeUSD??9.50),providerFee=Number(db.settings.providerFee??db.settings.providerFeeUSD??9.50),fee=customerFee;const customerFeeUSD=commissionCurrency==='USD'?customerFee:null,providerFeeUSD=commissionCurrency==='USD'?providerFee:null;
  const b={id:id('b'),listingId:o.listingId,offerId:o.id,dealType:dealTypeForListing(listing),buyerUserId,providerUserId,agreedPrice:Number(o.amount),currency:o.currency,commissionCurrency,customerFee,providerFee,customerFeeUSD,providerFeeUSD,platformFee:fee,buyerTotal:+fee.toFixed(2),providerNet:+Number(o.amount).toFixed(2),feeChargedTo:'both',feePayerUserId:buyerUserId,feePayments:{buyer:{status:'unpaid'},provider:{status:'unpaid'}},paymentStatus:'unpaid',paymentMode:'stripe_fee_only',commissionLockedAt:new Date().toISOString(),basicVerification:{buyerContinue:false,providerContinue:false,buyerAt:null,providerAt:null,rejectedBy:null},dealTerms:{buyer:null,provider:null,confirmed:false,settlementMethod:'',paymentTiming:'',confirmedAt:null},completion:{buyer:false,provider:false,buyerAt:null,providerAt:null},payoutStatus:'not_applicable',status:'basic_verification',createdAt:new Date().toISOString()};
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
// One canonical PDF generator for download and email.
const {createDealRecord:dealPdfBuffer}=require('./deal-record');
const {capacityLabel}=require('./deal-capacity');
async function emailDealRecord(b,db,pdf){const host=process.env.SMTP_HOST||'mail.privateemail.com',port=Number(process.env.SMTP_PORT||465),user=process.env.SMTP_USER||'',pass=process.env.SMTP_PASS||'',from=process.env.SMTP_FROM||user||'info@tutmove.com';if(!user||!pass)return;const parties=[db.users.find(x=>x.id===b.buyerUserId),db.users.find(x=>x.id===b.providerUserId)].filter(Boolean);for(const party of parties){try{await smtpSend({host,port,user,pass,from,to:party.email,subject:`TUT Move deal completed — ${b.id}`,text:`Your TUT Move deal ${b.id} is completed. Attached is the final Deal Record. The underlying deal amount was handled directly between the parties outside TUT Move.`,attachments:[{filename:`TUT-Move-Deal-${b.id}.pdf`,content:pdf,contentType:'application/pdf'}]})}catch(e){console.error('Deal PDF email failed:',e.message)}}}

// Partial masking (server-side only; the full value never leaves the server for the other party).
// Reveals at most the last 4 characters, fewer for short values, keeps length and separators.
function maskValue(v){
  const x=String(v||'').trim();if(!x)return '';
  const alnum=x.replace(/[^0-9A-Za-z]/g,'').length;
  const reveal=alnum>=10?4:alnum>=6?3:alnum>=4?1:0;
  let seen=0;const out=[];
  for(let i=x.length-1;i>=0;i--){const c=x[i];if(/[0-9A-Za-z]/.test(c)){seen++;out.unshift(seen<=reveal?c:'•')}else out.unshift(c)}
  return out.join('').slice(-32);
}
function docsUnlocked(b){return !!(b&&b.docConsent&&b.docConsent.buyer&&b.docConsent.provider)}
// What a person must show depends on the DEAL (type + which side they are on), not on the role they registered with.
// A warehouse owner who drives in a driver deal is asked for a driving licence; a company hiring a driver is not.
const DEAL_LICENCE={
  driver:{buyer:'none',provider:'required'},      // the driver supplies the service -> licence required
  transport:{buyer:'none',provider:'required'},   // the carrier drives -> licence required
  truck:{buyer:'optional',provider:'none'},       // renter may drive the truck -> optional
  equipment:{buyer:'optional',provider:'none'},   // operator licence (e.g. forklift) -> optional
  warehouse:{buyer:'none',provider:'none'}
};
const OPEN_DEAL_STATUSES=['basic_verification','basic_waiting','agreement_terms','commission_due'];
function licenceRequirement(db,userId,onlyDeal){
  const deals=onlyDeal?[onlyDeal]:(db.bookings||[]).filter(b=>[b.buyerUserId,b.providerUserId].includes(userId)&&OPEN_DEAL_STATUSES.includes(b.status));
  let level='none';const list=[];
  for(const b of deals){
    const type=bookingDealType(b,db),side=b.buyerUserId===userId?'buyer':'provider',lv=(DEAL_LICENCE[type]||{})[side]||'none';
    list.push({id:b.id,type,side,licence:lv});
    if(lv==='required')level='required';else if(lv==='optional'&&level==='none')level='optional';
  }
  return {licence:level,deals:list};
}
// Exactly what is still missing for this person in this deal (empty list = ready). Shown to both parties so nobody waits blindly.
function verificationMissing(user,db,deal){
  const v=user?.verification||{},files=v.files||{},role=String(v.role||user?.role||'').toLowerCase(),out=[];
  if(!user?.emailVerifiedAt)out.push('Verified email');
  if(!String(v.legalName||'').trim())out.push('Full legal name');
  if(!String(v.phone||user?.phone||'').trim())out.push('Phone number');
  if(!String(v.identityNumber||'').trim())out.push('Government ID number');
  if(!files.identity?.name)out.push('ID document photo');else if(!docSafe(files.identity))out.push('ID document photo (upload again with the number-covering step)');
  if(!files.selfie?.name)out.push('Selfie (face photo)');
  const need=(db&&user?licenceRequirement(db,user.id,deal).licence:(role==='driver'?'required':'none'))==='required';
  if(need){
    if(!String(v.licenceNumber||'').trim())out.push('Licence number');
    if(!(v.licenceClasses||[]).length)out.push('Licence class');
    if(!String(v.licenceExpiry||'').trim())out.push('Licence expiry date');
    if(!files.license?.name)out.push('Licence photo');else if(!docSafe(files.license))out.push('Licence photo (upload again with the number-covering step)');
  }else if(files.license?.name&&!docSafe(files.license))out.push('Licence photo (upload again with the number-covering step)');
  const company=['carrier','transport_company','transport-company','company'].includes(role);
  if(company&&!String(v.registrationNumber||'').trim())out.push('Business registration number');
  return out;
}
function verificationReady(user,db,deal){return verificationMissing(user,db,deal).length===0}
function relatedOfferIds(db,offerId){
  const ids=new Set();
  let current=(db.offers||[]).find(o=>o.id===offerId);
  while(current&&!ids.has(current.id)){
    ids.add(current.id);
    current=(db.offers||[]).find(o=>o.id===current.parentOfferId);
  }
  return ids;
}
function attachDealToOfferThread(db,b){
  const ids=relatedOfferIds(db,b.offerId);
  for(const o of db.offers||[])if(ids.has(o.id))o.dealId=b.id;
  for(const n of db.notifications||[])if(n.offerId&&ids.has(n.offerId))n.dealId=b.id;
}
function archiveCompletedDealNotifications(db,b){
  attachDealToOfferThread(db,b);
  for(const n of db.notifications||[])if(n.dealId===b.id)n.archived=true;
}

function closeCompletedDealListings(db,b){
  // Close only the listing that actually produced this booking. Never guess
  // another participant's listing from their latest post.
  const listing=db.listings.find(x=>x.id===b.listingId);
  if(!listing)return [];
  listing.status='closed';listing.closedAt=listing.closedAt||new Date().toISOString();
  listing.closedReason='deal_completed';listing.bookingId=b.id;
  b.closedListingIds=[listing.id];
  archiveListingActivity(db,listing.id);
  recomputeMatches(db);
  return b.closedListingIds;
}
function archiveListingActivity(db,listingId){
  const offerIds=new Set((db.offers||[]).filter(o=>o.listingId===listingId).map(o=>o.id));
  const dealIds=new Set((db.bookings||[]).filter(b=>b.listingId===listingId).map(b=>b.id));
  for(const n of db.notifications||[]){
    if((n.offerId&&offerIds.has(n.offerId))||(n.dealId&&dealIds.has(n.dealId))||n.listingId===listingId)n.archived=true;
  }
}
function listingIsAvailable(db,listingId){return db.listings.some(l=>l.id===listingId&&['open','booked'].includes(l.status))}
function reconcileCompletedDeals(db){
  let changed=false;
  for(const b of (db.bookings||[])){
    if(b.status!=='completed')continue;
    if(!b.completedAt){b.completedAt=new Date().toISOString();changed=true;}attachDealToOfferThread(db,b);
    const before=JSON.stringify((b.closedListingIds||[]).slice().sort());closeCompletedDealListings(db,b);
    if(before!==JSON.stringify((b.closedListingIds||[]).slice().sort()))changed=true;
  }
  if(changed)recomputeMatches(db);return changed;
}
function stripeSigValid(raw,header,secret){try{const parts=String(header||'').split(',').map(x=>x.split('='));const t=parts.find(x=>x[0]==='t')?.[1];const sigs=parts.filter(x=>x[0]==='v1').map(x=>x[1]);if(!t||!sigs.length)return false;if(Math.abs(Date.now()/1000-Number(t))>300)return false;const expected=crypto.createHmac('sha256',secret).update(t+'.'+raw.toString('utf8')).digest('hex');return sigs.some(sig=>sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))}catch{return false}}
async function stripeRequest(path,params,idempotencyKey){const key=process.env.STRIPE_SECRET_KEY;if(!key)throw new Error('Stripe secret key missing');const r=await fetch('https://api.stripe.com/v1/'+path,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:new URLSearchParams(params)});const j=await r.json();if(!r.ok)throw new Error(j?.error?.message||'Stripe request failed');return j;}
function bookingFee(b,role){return Number(role==='buyer'?(b.customerFee??b.customerFeeUSD):(b.providerFee??b.providerFeeUSD))||0}
function bookingFeeCurrency(b){return b.commissionCurrency==='EUR'?'EUR':'USD'}
function zeroFeeRole(b,role){return bookingFee(b,role)===0;}
function activateFeeFreeSides(b){
 if(!b.feePayments)return;
 for(const role of ['buyer','provider'])if(zeroFeeRole(b,role))b.feePayments[role]={status:'waived',amount:0};
 if(['paid','waived'].includes(b.feePayments.buyer.status)&&['paid','waived'].includes(b.feePayments.provider.status)){
   b.paymentStatus='paid';b.status='deal_open';b.commissionPaidAt=b.commissionPaidAt||new Date().toISOString();
   b.paymentMode=zeroFeeRole(b,'buyer')&&zeroFeeRole(b,'provider')?'no_fee':'stripe_fee_only';
 }
}
async function createStripeCheckout(b,siteUrl,role){const currency=bookingFeeCurrency(b);const amount=Math.round(bookingFee(b,role)*100);if(amount<50)throw new Error('Fee must be at least 0.50 '+currency);const expires=Math.max(Math.floor(Date.now()/1000)+1800,Math.floor(Date.parse(b.paymentDeadline||0)/1000));return stripeRequest('checkout/sessions',{'mode':'payment','success_url':`${siteUrl}/?payment=success&deal=${encodeURIComponent(b.id)}`,'cancel_url':`${siteUrl}/?payment=cancelled&deal=${encodeURIComponent(b.id)}`,'client_reference_id':b.id,'metadata[deal_id]':b.id,'metadata[role]':role,'metadata[expected_fee_minor]':String(amount),'line_items[0][quantity]':'1','line_items[0][price_data][currency]':currency.toLowerCase(),'line_items[0][price_data][unit_amount]':String(amount),'line_items[0][price_data][product_data][name]':`TUT Move ${role} platform fee — ${b.id}`,'expires_at':String(expires)},`checkout-${b.id}-${role}-${Date.now()}`)}

async function refundExpiredDeal(b,db){if(!b.feePayments||!b.paymentDeadline||Date.now()<Date.parse(b.paymentDeadline)||b.paymentStatus==='paid')return false;const firstExpiry=b.status!=='payment_expired';b.status='payment_expired';b.paymentStatus='expired';for(const role of ['buyer','provider']){const pay=b.feePayments[role];if(pay?.sessionId&&pay.status==='checkout_created'&&!pay.sessionExpired){try{await stripeRequest('checkout/sessions/'+encodeURIComponent(pay.sessionId)+'/expire',{},'expire-'+pay.sessionId);pay.sessionExpired=true;}catch(e){pay.expiryError=e.message;console.error('Checkout expiry needs follow-up',b.id,role,e.message)}}if(pay?.status==='paid'&&pay.paymentIntent){try{await stripeRequest('refunds',{'payment_intent':pay.paymentIntent,'reason':'requested_by_customer'},`expiry-refund-${b.id}-${role}`);pay.status='refund_pending';}catch(e){pay.refundError=e.message;console.error('Refund requires retry',b.id,role,e.message)}}}return firstExpiry;}


const server=http.createServer(async(req,res)=>{setSecurityHeaders(res);
 const url=new URL(req.url,`http://${req.headers.host}`),p=url.pathname;
 if(req.method!=='GET'&&req.method!=='HEAD'&&p.startsWith('/api/'))res.on('finish',()=>{if(res.statusCode<400){clearTimeout(global.__ssePing);global.__ssePing=setTimeout(()=>ssePush([...sseClients.keys()]),60)}});
 try{
  if(p==='/api/events'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required'});
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
   res.write('retry: 3000\n\nevent: hello\ndata: {}\n\n');
   let set=sseClients.get(u.id);if(!set){set=new Set();sseClients.set(u.id,set)}set.add(res);
   req.on('close',()=>{set.delete(res);if(!set.size&&sseClients.get(u.id)===set)sseClients.delete(u.id)});return}
  if(p==='/api/health')return json(res,200,{ok:true,version:'96',site:'tutmove.com',database:await dbInfo()});
  if(p==='/api/database/status'&&req.method==='GET')return json(res,200,await dbInfo());

  if(p==='/api/visit'&&req.method==='POST'){
    const body=await getBody(req);const visitorId=String(body.visitorId||'');if(!/^[0-9a-f-]{36}$/i.test(visitorId))return json(res,400,{error:'Invalid visitor ID'});
    const db=readDB(),digest=crypto.createHash('sha256').update(visitorId).digest('hex');db.visitorHashes=db.visitorHashes||[];
    if(!db.visitorHashes.includes(digest)){db.visitorHashes.push(digest);await writeDB(db)}
    return json(res,200,{ok:true});
  }
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
  if(p==='/api/admin/settings'&&req.method==='PUT'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const b=await getBody(req),db=readDB();for(const k of ['customerFee','providerFee'])if(Object.prototype.hasOwnProperty.call(b,k)){const n=Number(b[k]);if(b[k]===''||!Number.isFinite(n)||n<0||n>10000)return json(res,400,{error:'Fee must be between 0 and 10000'});db.settings[k]=Math.round(n*100)/100;}if(Object.prototype.hasOwnProperty.call(b,'commissionCurrency')){if(!['USD','EUR'].includes(b.commissionCurrency))return json(res,400,{error:'Only USD and EUR are supported for commission fees'});db.settings.commissionCurrency=b.commissionCurrency;}for(const k of ['brandName','siteUrl','ownerName','ownerEmail','legalEntity','supportEmail'])if(k in b)db.settings[k]=String(b[k]||'').trim().slice(0,180);await writeDB(db);return json(res,200,{settings:db.settings});}
  if(p==='/api/listings'&&req.method==='GET'){const db=readDB();const listings=db.listings.filter(x=>x.status==='open').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(x=>publicListing(x,db));return json(res,200,{listings});}
  if(p==='/api/listings'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});if(!accountActive(u))return json(res,403,{error:'Verify your email before using the marketplace.'});const b=await getBody(req);const resources=['driver','truck','load','warehouse','storage','equipment'];const intents=['have','need'];const priceModes=['fixed','negotiable','request_quotes','open_bidding'];if(!resources.includes(b.resource)||!intents.includes(b.intent)||!priceModes.includes(b.priceMode))return json(res,400,{error:'Invalid listing.'});
    const db=readDB();const x={id:id('l'),userId:u.id,intent:b.intent,resource:b.resource,title:String(b.title||'').slice(0,120),country:b.country||u.country||'',currency:b.currency||u.currency||db.settings.defaultCurrency,priceMode:b.priceMode,price:Number(b.price||0),data:sanitizeData(b.data),status:'open',createdAt:new Date().toISOString()};db.listings.push(x);recomputeMatches(db);await writeDB(db);return json(res,201,{listing:x});
  }
  if(p.startsWith('/api/listings/')&&req.method==='DELETE'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const lid=p.split('/').pop(),db=readDB(),x=db.listings.find(z=>z.id===lid);if(!x)return json(res,404,{error:'Listing not found.'});if(x.userId!==u.id&&!isOwner(u))return json(res,403,{error:'Not your listing.'});x.status='closed';x.closedAt=new Date().toISOString();x.closedReason='owner_removed';archiveListingActivity(db,x.id);recomputeMatches(db);await writeDB(db);return json(res,200,{ok:true});}
  if(p==='/api/matches'&&req.method==='GET'){const db=readDB();recomputeMatches(db);await writeDB(db);const map=Object.fromEntries(db.listings.map(x=>[x.id,publicListing(x,db)]));return json(res,200,{matches:db.matches.map(m=>({...m,listings:m.listingIds.map(i=>map[i]).filter(Boolean)}))});}
  if(p==='/api/offers'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});
    const db=readDB(),myListings=new Set(db.listings.filter(x=>x.userId===u.id).map(x=>x.id));
    const mine=isOwner(u)?db.offers:db.offers.filter(o=>o.fromUserId===u.id||o.toUserId===u.id||myListings.has(o.listingId));
    // Rejected and countered offers remain visible until the listing is removed
    // or a deal on that listing is completed.
    const offers=mine.filter(o=>listingIsAvailable(db,o.listingId)&&!(db.bookings||[]).some(b=>b.listingId===o.listingId&&b.status==='completed'));
    return json(res,200,{offers:offers.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
  }
  if(p==='/api/offers'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});if(!accountActive(u))return json(res,403,{error:'Verify your email before using the marketplace.'});const b=await getBody(req),db=readDB(),listing=db.listings.find(x=>x.id===b.listingId&&x.status==='open');if(!listing)return json(res,404,{error:'Listing not found.'});if(listing.userId===u.id)return json(res,400,{error:'You cannot offer on your own listing.'});if(b.parentOfferId){const parent=db.offers.find(x=>x.id===b.parentOfferId);if(!parent||parent.listingId!==listing.id||![parent.fromUserId,parent.toUserId].includes(u.id))return json(res,400,{error:'Invalid offer thread.'});}const amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Offer amount required.'});const o={id:id('o'),listingId:listing.id,fromUserId:u.id,toUserId:listing.userId,amount,currency:b.currency||listing.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:b.parentOfferId||null,createdAt:new Date().toISOString()};db.offers.push(o);addNotification(db,listing.userId,'offer','New offer received',`${u.name||'A member'} sent you an offer of ${o.currency} ${o.amount}.`,'offers',null,o.id);await writeDB(db);return json(res,201,{offer:o});
  }
  if(/^\/api\/offers\/[^/]+\/(accept|reject|counter)$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const parts=p.split('/'),oid=parts[3],action=parts[4],db=readDB(),o=db.offers.find(x=>x.id===oid);if(!o)return json(res,404,{error:'Offer not found.'});if(!listingIsAvailable(db,o.listingId))return json(res,409,{error:'This listing is closed.'});if(o.toUserId!==u.id&&o.fromUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Not allowed.'});
    if(action==='accept'){
      if(o.status!=='pending')return json(res,409,{error:'Only a pending offer can be accepted.'});
      if((db.bookings||[]).some(b=>b.listingId===o.listingId&&!['cancelled','completed'].includes(b.status)))return json(res,409,{error:'This listing already has an active deal.'});
      if(o.toUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Only recipient can accept.'});o.status='accepted';o.acceptedAt=new Date().toISOString();const booking=createBookingFromAcceptedOffer(db,o);if(!booking)return json(res,409,{error:'The accepted listing could not be converted into a deal.'});attachDealToOfferThread(db,booking);addNotification(db,booking.buyerUserId,'agreement','Agreement accepted',`Your ${booking.dealType} agreement is accepted. Complete basic verification before the TUT Move fee.`,'offers',booking.id);addNotification(db,booking.providerUserId,'agreement','You were selected',`Your ${booking.dealType} offer/agreement was accepted. Open Activity to continue.`,'offers',booking.id);recomputeMatches(db);await writeDB(db);return json(res,200,{booking:bookingView(booking,db)});
    }
    if(action==='reject'){if(o.status!=='pending')return json(res,409,{error:'Only a pending offer can be rejected.'});o.status='rejected';addNotification(db,o.fromUserId,'offer_rejected','Offer update','Your offer was not accepted. You can negotiate a new price.','offers',null,o.id);await writeDB(db);return json(res,200,{offer:o});}
    if(!['pending','rejected'].includes(o.status))return json(res,409,{error:'This offer cannot be countered again. Reply to the latest offer.'});const b=await getBody(req),amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Counter amount required.'});o.status='countered';const c={id:id('o'),listingId:o.listingId,fromUserId:u.id,toUserId:u.id===o.fromUserId?o.toUserId:o.fromUserId,amount,currency:o.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:o.id,createdAt:new Date().toISOString()};db.offers.push(c);addNotification(db,c.toUserId,'counter','Counter offer received',`${u.name||'A member'} sent a counter offer of ${c.currency} ${c.amount}.`,'offers',null,c.id);await writeDB(db);return json(res,201,{offer:c});
  }
  if(p==='/api/verification/requirements'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});
    return json(res,200,licenceRequirement(readDB(),u.id));
  }
  if(p==='/api/verification/me'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});
    const db=readDB(),me=db.users.find(x=>x.id===u.id);if(!me)return json(res,404,{error:'User not found.'});
    return json(res,200,{verification:me.verification||{status:'not_submitted',role:'',legalName:'',country:'',licenceNumber:'',vehicleId:'',notes:'',submittedAt:null,reviewedAt:null}});
  }
  if(p==='/api/verification/submit'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const body=await getBody(req,36*1024*1024),db=readDB(),me=db.users.find(x=>x.id===u.id);if(!me)return json(res,404,{error:'User not found.'});if(!me.emailVerifiedAt)return json(res,403,{error:'Verify your email address before saving your verification profile.'});const activeDeal=(db.bookings||[]).find(x=>[x.buyerUserId,x.providerUserId].includes(me.id)&&['basic_verification','basic_waiting','agreement_terms','commission_due'].includes(x.status));if(!activeDeal)return json(res,403,{error:'Verification documents are requested only after a preliminary deal is accepted.'});
    const files={};for(const k of ['license','identity','selfie']){if(body.files&&body.files[k]){const saved=k==='selfie'?saveDataUrl(u.id,k,body.files[k]):(body.docMaskConfirmed===true?saveMaskedDocument(u.id,k,body.files[k]):safeDocumentPreview(u.id,k,body.files[k],body.legalName));if(saved){saved.masked=true;files[k]=saved;}}}
    me.verification={...(me.verification||{}),status:'profile_saved',role:String(body.role||''),legalName:String(body.legalName||'').trim(),phone:String(body.phone||'').trim().slice(0,50),country:String(body.country||''),birthDate:String(body.birthDate||'').slice(0,10),identityNumber:String(body.identityNumber||'').trim(),licenceNumber:String(body.licenceNumber||'').trim(),licenceClasses:Array.isArray(body.licenceClasses)?body.licenceClasses.map(x=>String(x).slice(0,50)).slice(0,20):[],licenceExpiry:String(body.licenceExpiry||'').slice(0,20),endorsements:String(body.endorsements||'').trim().slice(0,500),registrationNumber:String(body.registrationNumber||'').trim().slice(0,120),vehicleId:String(body.vehicleId||'').trim(),notes:String(body.notes||'').trim(),files:{...(me.verification?.files||{}),...files},submittedAt:new Date().toISOString(),reviewedAt:null};
    me.phone=String(body.phone||me.phone||'').trim().slice(0,50);me.verified=false;me.verificationStatus='profile_saved';
    for(const deal of (db.bookings||[]).filter(x=>[x.buyerUserId,x.providerUserId].includes(me.id)&&['basic_verification','basic_waiting','agreement_terms','commission_due'].includes(x.status))){const otherId=deal.buyerUserId===me.id?deal.providerUserId:deal.buyerUserId;addNotification(db,otherId,'verification','Verification photos sent','The other party has sent verification photos. Open the deal to review them.','offers',deal.id)}await writeDB(db);return json(res,200,{verification:me.verification,ready:verificationReady(me,db),message:verificationReady(me,db)?'Verification saved. Return to Activity to review the other party.':'Verification saved, but required documents/details are still missing. Upload the required ID + selfie (and driving licence for drivers).'});
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
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});
    if(!b.feePayments)return json(res,409,{error:'Legacy deal: payment migration required; contact support.'});
    const role=u.id===b.buyerUserId?'buyer':u.id===b.providerUserId?'provider':null;if(!role)return json(res,403,{error:'Not a deal participant.'});
    if(!b.dealTerms?.confirmed||!b.basicVerification?.buyerContinue||!b.basicVerification?.providerContinue)return json(res,409,{error:'Both parties must complete verification and agree on payment terms.'});
    if(zeroFeeRole(b,role))return json(res,409,{error:'No payment is required for this participant.'});
    if(!['commission_due','payment_pending'].includes(b.status))return json(res,409,{error:'Payment is not available for this deal.'});
    if(await refundExpiredDeal(b,db)){await writeDB(db);return json(res,409,{error:'The 10-minute payment window expired; any captured fee is being refunded.'});}
    if(['paid','refund_pending','refunded'].includes(b.feePayments[role].status))return json(res,409,{error:'This fee has already been processed.'});
    if(!b.paymentDeadline)b.paymentDeadline=new Date(Date.now()+10*60*1000).toISOString();
    b.status='payment_pending';await writeDB(db);
    const session=await createStripeCheckout(b,db.settings.siteUrl||'https://tutmove.com',role);
    b.feePayments[role].sessionId=session.id;b.feePayments[role].status='checkout_created';await writeDB(db);return json(res,200,{url:session.url,deadline:b.paymentDeadline});
  }
  if(p==='/api/stripe/webhook'&&req.method==='POST'){
    const secret=process.env.STRIPE_WEBHOOK_SECRET;if(!secret)return json(res,503,{error:'Webhook secret is not configured.'});const raw=await rawBody(req);if(!stripeSigValid(raw,req.headers['stripe-signature'],secret))return json(res,400,{error:'Invalid Stripe signature.'});const event=JSON.parse(raw.toString('utf8'));
    if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)){const session=event.data?.object||{};if(session.payment_status==='paid'){const db=readDB(),b=db.bookings.find(x=>x.id===(session.metadata?.deal_id||session.client_reference_id)),role=session.metadata?.role;
      if(b?.feePayments&&['buyer','provider'].includes(role)&&b.feePayments[role].sessionId===session.id){const pay=b.feePayments[role],expected=Math.round(bookingFee(b,role)*100);
        if(Number(session.amount_total)!==expected||session.currency!==bookingFeeCurrency(b).toLowerCase())return json(res,400,{error:'Payment amount mismatch'});
        if(pay.status!=='paid'&&pay.status!=='refund_pending'){pay.status='paid';pay.paymentIntent=session.payment_intent;pay.paidAt=new Date().toISOString();}
        if(b.status==='payment_expired'||Date.now()>Date.parse(b.paymentDeadline)){await refundExpiredDeal(b,db);if(pay.status==='paid'){try{await stripeRequest('refunds',{payment_intent:pay.paymentIntent,reason:'requested_by_customer'},`expiry-refund-${b.id}-${role}`);pay.status='refund_pending';}catch(e){pay.refundError=e.message}}}
        else if(['paid','waived'].includes(b.feePayments.buyer.status)&&['paid','waived'].includes(b.feePayments.provider.status)){b.paymentStatus='paid';b.status='deal_open';b.commissionPaidAt=new Date().toISOString();for(const uid of [b.buyerUserId,b.providerUserId])addNotification(db,uid,'payment','Both platform fees confirmed','Both parties paid their fees. The deal is now open.','offers',b.id);}
        else for(const uid of [b.buyerUserId,b.providerUserId])addNotification(db,uid,'payment','One platform fee confirmed','Waiting for the second fee before the 10-minute deadline.','offers',b.id);
        await writeDB(db);
      }
    }}
    if(event.type==='charge.refunded'){const db=readDB();for(const b of db.bookings||[])for(const role of ['buyer','provider'])if(b.feePayments?.[role]?.paymentIntent&&b.feePayments[role].paymentIntent===event.data?.object?.payment_intent)b.feePayments[role].status='refunded';await writeDB(db)}
    return json(res,200,{received:true});
  }
  if(/^\/api\/bookings\/[^/]+\/verification-photo\/(identity|license|selfie)$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});
    const parts=p.split('/'),bid=parts[3],kind=parts[5],db=readDB(),b=db.bookings.find(x=>x.id===bid);
    if(!b)return json(res,404,{error:'Deal not found.'});
    if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not a participant.'});
    const other=db.users.find(x=>x.id===(u.id===b.buyerUserId?b.providerUserId:b.buyerUserId));
    const f=other?.verification?.files?.[kind];
    if(!f||!['image/jpeg','image/png','image/webp','image/svg+xml'].includes(f.mime))return json(res,404,{error:'No preview.'});
    if(kind!=='selfie'&&(!f.masked||!docSafe(f)))return json(res,403,{error:'Document must be masked before sharing.'});
    const base=path.resolve(UPLOADS)+path.sep,file=path.resolve(UPLOADS,String(f.name||''));
    if(!file.startsWith(base)||!fs.existsSync(file))return json(res,404,{error:'Photo not found.'});
    const data=fs.readFileSync(file);res.writeHead(200,{'Content-Type':f.mime,'Content-Length':data.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(data);
  }
  if(/^\/api\/bookings\/[^/]+\/basic-profile$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});const otherId=u.id===b.buyerUserId?b.providerUserId:b.buyerUserId,other=db.users.find(x=>x.id===otherId),me=db.users.find(x=>x.id===u.id);const ov=other?.verification||{};return json(res,200,{myReady:verificationReady(me,db,b),otherReady:verificationReady(other,db,b),profile:{displayName:String(ov.legalName||other?.name||'').split(/\s+/).slice(0,2).join(' '),capacity:capacityLabel(bookingDealType(b,db),otherId===b.buyerUserId?'buyer':'provider',other),country:ov.country||other?.country||'',role:ov.role||other?.role||'',emailVerified:!!other?.emailVerifiedAt,contactUnlocked:false,phone:'',email:'',identityProvided:!!ov.files?.identity?.name,identityNumberMasked:maskValue(ov.identityNumber),birthDateMasked:ov.birthDate?String(ov.birthDate).slice(0,4):'',selfieProvided:!!ov.files?.selfie?.name,licenceProvided:!!ov.files?.license?.name,licenceLevel:licenceRequirement(db,other?.id,b).licence,identityPreview:docSafe(ov.files?.identity),selfiePreview:!!ov.files?.selfie?.name,licencePreview:docSafe(ov.files?.license),photoVersion:Date.parse(ov.submittedAt)||0,licenceNumberMasked:maskValue(ov.licenceNumber),licenceExpiry:'',licenceClasses:[]},docConsent:{mine:!!b.docConsent?.[u.id===b.buyerUserId?'buyer':'provider'],other:!!b.docConsent?.[u.id===b.buyerUserId?'provider':'buyer'],unlocked:docsUnlocked(b)},basicVerification:b.basicVerification||{}});
  }
  if(/^\/api\/bookings\/[^/]+\/doc-consent$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],body=await getBody(req),db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});
    if(!['basic_verification','basic_waiting','agreement_terms','commission_due','payment_pending','deal_open'].includes(b.status))return json(res,409,{error:'Document consent is not available for this deal.'});
    const side=u.id===b.buyerUserId?'buyer':'provider',other=side==='buyer'?b.providerUserId:b.buyerUserId,give=body.consent!==false;
    b.docConsent=b.docConsent||{buyer:false,provider:false};b.docConsent[side]=give;b.docConsent[side+'At']=new Date().toISOString();
    if(give)addNotification(db,other,'verification','Document consent','The other party agreed to open verification documents. Documents open only when both of you agree.','offers',b.id);
    await writeDB(db);return json(res,200,{docConsent:{mine:give,other:!!b.docConsent[side==='buyer'?'provider':'buyer'],unlocked:docsUnlocked(b)}});
  }
  if(/^\/api\/bookings\/[^/]+\/basic-continue$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(!['basic_verification','basic_waiting','agreement_terms','commission_due'].includes(b.status))return json(res,409,{error:'This deal can no longer change its basic-verification decision.'});const me=db.users.find(x=>x.id===u.id),other=db.users.find(x=>x.id===(u.id===b.buyerUserId?b.providerUserId:b.buyerUserId));if(!verificationReady(me,db,b)||!verificationReady(other,db,b))return json(res,409,{error:'Both parties must provide the required basic verification information first.'});b.basicVerification=b.basicVerification||{buyerContinue:false,providerContinue:false};const now=new Date().toISOString();if(u.id===b.buyerUserId){b.basicVerification.buyerContinue=true;b.basicVerification.buyerAt=now}else{b.basicVerification.providerContinue=true;b.basicVerification.providerAt=now}const ready=b.basicVerification.buyerContinue&&b.basicVerification.providerContinue;if(!['agreement_terms','commission_due'].includes(b.status))b.status=ready?'agreement_terms':'basic_waiting';if(ready){addNotification(db,b.buyerUserId,'agreement','Basic verification complete','Both parties chose Continue. The TUT Move fee is now ready for payment.','offers',b.id);addNotification(db,b.providerUserId,'agreement','Basic verification complete','Both parties chose Continue. Waiting for the TUT Move fee.','offers',b.id)}await writeDB(db);return json(res,200,{booking:b,readyForPayment:!!ready});
  }
  if(/^\/api\/bookings\/[^/]+\/deal-terms$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],body=await getBody(req),db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(!['agreement_terms','commission_due'].includes(b.status))return json(res,409,{error:'Deal terms are not available yet.'});
    // The requester (buyer) proposes the underlying-service payment terms;
    // the provider can only accept or request a revision. Never auto-confirm two unrelated selections.
    const methods=['Cash','Bank Transfer','Cash / Bank Transfer','Other agreed method'];
    const timings=['Upon meeting','Upon handover','Before handover','After delivery / service','As agreed between the parties'];
    b.dealTerms=b.dealTerms||{buyer:null,provider:null,confirmed:false};
    const terms=b.dealTerms,now=new Date().toISOString();
    if(u.id===b.buyerUserId){
      const settlementMethod=String(body.settlementMethod||''),paymentTiming=String(body.paymentTiming||'');
      if(!methods.includes(settlementMethod)||!timings.includes(paymentTiming))return json(res,400,{error:'Choose a valid payment method and timing.'});
      terms.buyer={settlementMethod,paymentTiming,at:now};terms.provider=null;terms.confirmed=false;
      terms.settlementMethod='';terms.paymentTiming='';terms.confirmedAt=null;
      addNotification(db,b.providerUserId,'agreement','Payment method proposed','Review and accept or request a change to the proposed payment terms.','offers',b.id);
    }else{
      if(!terms.buyer)return json(res,409,{error:'Wait for the payer to propose a payment method.'});
      if(body.decision==='reject'){
        terms.provider={decision:'rejected',at:now};terms.confirmed=false;
        addNotification(db,b.buyerUserId,'agreement','Payment terms change requested','The recipient rejected the proposed payment method. Please propose new terms.','offers',b.id);
      }else if(body.decision==='accept'){
        terms.provider={decision:'accepted',at:now};terms.confirmed=true;
        terms.settlementMethod=terms.buyer.settlementMethod;terms.paymentTiming=terms.buyer.paymentTiming;
        terms.confirmedAt=now;b.status='commission_due';activateFeeFreeSides(b);
        addNotification(db,b.buyerUserId,'agreement','Payment terms accepted','The recipient accepted your proposed payment method.','offers',b.id);
      }else return json(res,400,{error:'Accept or reject the proposed payment terms.'});
    }
    if(!terms.confirmed)b.status='agreement_terms';
    await writeDB(db);return json(res,200,{booking:bookingView(b,db),confirmed:terms.confirmed});
  }
  if(/^\/api\/bookings\/[^/]+\/basic-reject$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(['cancelled','completed','payment_pending','payment_expired'].includes(b.status))return json(res,409,{error:'This deal is already closed.'});if(b.paymentStatus==='paid')return json(res,409,{error:'This deal is already paid and open.'});b.status='cancelled';b.cancelledAt=new Date().toISOString();b.basicVerification=b.basicVerification||{};b.basicVerification.rejectedBy=u.id;const listing=db.listings.find(x=>x.id===b.listingId);if(listing&&listing.status==='booked')listing.status='open';const offer=db.offers.find(x=>x.id===b.offerId);if(offer)offer.status='rejected_after_basic_verification';recomputeMatches(db);await writeDB(db);return json(res,200,{ok:true});
  }
  if(/^\/api\/bookings\/[^/]+\/deal-profile$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(b.paymentStatus!=='paid')return json(res,403,{error:'Deal details unlock only after the TUT Move fee is paid.'});const other=db.users.find(x=>x.id===(u.id===b.buyerUserId?b.providerUserId:b.buyerUserId)),v=other?.verification||{};return json(res,200,{profile:{legalName:v.legalName||other?.name||'',capacity:capacityLabel(bookingDealType(b,db),other?.id===b.buyerUserId?'buyer':'provider',other),phone:v.phone||other?.phone||'',email:other?.email||'',country:v.country||other?.country||'',role:v.role||other?.role||'',identityNumberMasked:maskValue(v.identityNumber),licenceNumberMasked:maskValue(v.licenceNumber),licenceClasses:v.licenceClasses||[],licenceExpiry:v.licenceExpiry||'',selfieAvailable:!!v.files?.selfie?.name},mutualVerification:b.mutualVerification||{},completion:b.completion||{}});
  }
  if(/^\/api\/bookings\/[^/]+\/complete$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id))return json(res,403,{error:'Not part of this deal.'});if(b.status==='completed')return json(res,409,{error:'This deal is already completed.'});if(b.status!=='deal_open'||b.paymentStatus!=='paid')return json(res,409,{error:'The deal must be open before completion.'});b.completion=b.completion||{buyer:false,provider:false};const now=new Date().toISOString();if(u.id===b.buyerUserId){b.completion.buyer=true;b.completion.buyerAt=now}else{b.completion.provider=true;b.completion.providerAt=now}const complete=b.completion.buyer&&b.completion.provider;if(complete){b.status='completed';b.completedAt=now;closeCompletedDealListings(db,b);b.dealRecordReady=true;archiveCompletedDealNotifications(db,b)}else b.status='deal_open';await writeDB(db);if(complete){const pdf=await dealPdfBuffer(b,db);await emailDealRecord(b,db,pdf);return json(res,200,{complete,booking:b,pdfUrl:`/api/bookings/${b.id}/deal-record.pdf`});}return json(res,200,{complete,booking:b});
  }
  if(p==='/api/notifications'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const completedIds=new Set((db.bookings||[]).filter(b=>b.status==='completed').map(b=>b.id));const completedOffers=new Set();for(const b of (db.bookings||[]).filter(b=>b.status==='completed'))for(const oid of relatedOfferIds(db,b.offerId))completedOffers.add(oid);const closedOfferIds=new Set((db.offers||[]).filter(o=>!listingIsAvailable(db,o.listingId)).map(o=>o.id));const closedDealIds=new Set((db.bookings||[]).filter(b=>!listingIsAvailable(db,b.listingId)).map(b=>b.id));const items=(db.notifications||[]).filter(n=>n.userId===u.id&&!n.archived&&!completedIds.has(n.dealId)&&!completedOffers.has(n.offerId)&&!closedOfferIds.has(n.offerId)&&!closedDealIds.has(n.dealId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,60);return json(res,200,{items,unread:items.filter(x=>!x.read).length});
  }
  if(p==='/api/notifications/read'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();for(const n of (db.notifications||[]))if(n.userId===u.id)n.read=true;await writeDB(db);return json(res,200,{ok:true});
  }
  if(/^\/api\/bookings\/[^/]+\/deal-record\.pdf$/.test(p)&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Deal not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id)&&!isOwner(u))return json(res,403,{error:'Not part of this deal.'});if(b.status!=='completed')return json(res,409,{error:'Deal Record is available after completion.'});const pdf=await dealPdfBuffer(b,db);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="TUT-Move-Deal-${b.id}.pdf"`,'Content-Length':pdf.length,'Cache-Control':'private, no-store'});return res.end(pdf);}
  if(p==='/api/bookings/history'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const visible=isOwner(u)?db.bookings:db.bookings.filter(b=>b.buyerUserId===u.id||b.providerUserId===u.id);const deals=visible.filter(b=>b.status==='completed').sort((a,b)=>String(b.completedAt||b.createdAt).localeCompare(String(a.completedAt||a.createdAt))).map(b=>bookingView(b,db));return json(res,200,{deals});}
  if(p==='/api/bookings'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();db.bookings.forEach(b=>normalizeBookingWorkflow(b,db));const visible=isOwner(u)?db.bookings:db.bookings.filter(b=>b.buyerUserId===u.id||b.providerUserId===u.id);const bookings=visible.filter(b=>!['completed','cancelled'].includes(b.status)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(b=>bookingView(b,db));return json(res,200,{bookings});}
  // v94: obsolete payment/trip/pickup/delivery and post-payment mutual-document flows are removed.
  // v94: verification profile exists only for an accepted preliminary deal.
  if(p==='/api/admin/summary'&&req.method==='GET'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const db=readDB();const marketplaceUsers=db.users.filter(x=>x.role!=='owner');const roleCounts={driver:0,carrier:0,shipper:0,warehouse:0,equipment:0,other:0};for(const x of marketplaceUsers){const roles=(x.roles&&x.roles.length?x.roles:[x.role]).filter(r=>r&&r!=='owner');if(!roles.length)roleCounts.other++;else for(const r of new Set(roles)){if(Object.prototype.hasOwnProperty.call(roleCounts,r))roleCounts[r]++;else roleCounts.other++;}}const pendingVerifications=(db.verifications||[]).filter(v=>['pending','pending_review','submitted','not_started'].includes(v.status)).length;const revenue={};for(const b of db.bookings||[])for(const role of ['buyer','provider']){const pay=b.feePayments?.[role];if(pay?.status!=='paid')continue;const currency=bookingFeeCurrency(b);revenue[currency]=(revenue[currency]||0)+bookingFee(b,role)}const revenueDisplay=Object.keys(revenue).length?Object.entries(revenue).map(([cur,amount])=>cur+' '+amount.toFixed(2)).join(' / '):((db.settings.commissionCurrency==='EUR'?'EUR':'USD')+' 0.00');return json(res,200,{users:marketplaceUsers.map(safeUser),listings:db.listings,offers:db.offers,bookings:db.bookings,verifications:db.verifications,settings:db.settings,stats:{users:marketplaceUsers.length,roleCounts,visitors:(db.visitorHashes||[]).length,completedDeals:db.bookings.filter(b=>b.status==='completed').length,revenueDisplay,pendingVerifications,verifiedUsers:marketplaceUsers.filter(x=>x.verified||x.verificationStatus==='verified').length,openListings:db.listings.filter(x=>x.status==='open').length,offers:db.offers.length,bookings:db.bookings.length}});}
  if(/^\/api\/admin\/users\/[^/]+$/.test(p)&&req.method==='DELETE'){const owner=auth(req);if(!isOwner(owner))return json(res,403,{error:'Owner access required.'});const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target)return json(res,404,{error:'User not found.'});if(target.role==='owner')return json(res,403,{error:'Owner account cannot be deleted.'});const listingIds=new Set(db.listings.filter(x=>x.userId===uid).map(x=>x.id));const offerIds=new Set(db.offers.filter(x=>x.fromUserId===uid||x.toUserId===uid||listingIds.has(x.listingId)).map(x=>x.id));db.users=db.users.filter(x=>x.id!==uid);db.listings=db.listings.filter(x=>x.userId!==uid);db.offers=db.offers.filter(x=>x.fromUserId!==uid&&x.toUserId!==uid&&!listingIds.has(x.listingId));db.bookings=db.bookings.filter(x=>x.buyerUserId!==uid&&x.providerUserId!==uid&&!listingIds.has(x.listingId)&&!offerIds.has(x.offerId));db.verifications=db.verifications.filter(x=>x.userId!==uid);db.notifications=(db.notifications||[]).filter(x=>x.userId!==uid);db.sessions=(db.sessions||[]).filter(x=>x.userId!==uid);db.matches=[];recomputeMatches(db);try{if(fs.existsSync(UPLOADS)){for(const name of fs.readdirSync(UPLOADS)){if(name.startsWith(uid+'_')){try{fs.unlinkSync(path.join(UPLOADS,name))}catch{}}}}}catch{}await writeDB(db);return json(res,200,{ok:true,message:'User account deleted.'});}
  if(false&&p.startsWith('/api/admin/users/')&&p.endsWith('/verify')&&req.method==='POST'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target)return json(res,404,{error:'User not found.'});target.verified=true;target.verificationStatus='manual_verified';if(target.verification){target.verification.status='verified';target.verification.reviewedAt=new Date().toISOString();}await writeDB(db);return json(res,200,{user:safeUser(target)});}
  if(serveStatic(res,p,req))return;
  return json(res,404,{error:'Not found'});
 }catch(e){console.error(e);return json(res,500,{error:e.message||'Server error'});}
});
initDB()
  .then(async()=>{const db=readDB();let changed=migrateAcceptedOffersToDeals(db);if(reconcileCompletedDeals(db))changed=true;if(changed)await writeDB(db);server.listen(PORT,()=>console.log(`TUT Move deal flow running on ${PORT}`));setInterval(async()=>{try{const d=readDB();let changed=false;for(const b of d.bookings||[])if(await refundExpiredDeal(b,d)){changed=true;if(b.status==='payment_expired'&&!b.expiryNotifiedAt){b.expiryNotifiedAt=new Date().toISOString();for(const uid of [b.buyerUserId,b.providerUserId])addNotification(d,uid,'payment','Payment window expired','The 10-minute deadline expired. Any captured fee is being refunded.','offers')}}if(changed)await writeDB(d)}catch(e){console.error('Payment expiry scan failed',e)}},60000)})
  .catch(err=>{console.error('Database initialization failed:',err);process.exit(1)});
