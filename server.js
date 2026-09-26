const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const tls = require('tls');
const { URL } = require('url');
let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) {}

const ROOT = __dirname;
const DBFILE = path.join(ROOT, 'data', 'db.json');
const UPLOADS = path.join(ROOT, 'data', 'uploads');
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const REVOLUT_SECRET_KEY = process.env.REVOLUT_MERCHANT_SECRET_KEY || '';
const REVOLUT_ENV = String(process.env.REVOLUT_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const REVOLUT_API_VERSION = process.env.REVOLUT_API_VERSION || '2026-03-12';
const REVOLUT_BASE_URL = REVOLUT_ENV === 'production' ? 'https://merchant.revolut.com' : 'https://sandbox-merchant.revolut.com';
let pgPool = null;
let dbCache = null;

// Production hardening: basic response headers and in-memory login throttling.
const loginAttempts = new Map();
function clientKey(req){return String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim()}
function loginAllowed(req){const k=clientKey(req),now=Date.now(),windowMs=15*60*1000,max=10;let a=loginAttempts.get(k)||[];a=a.filter(t=>now-t<windowMs);loginAttempts.set(k,a);return a.length<max}
function recordLoginFailure(req){const k=clientKey(req),a=loginAttempts.get(k)||[];a.push(Date.now());loginAttempts.set(k,a)}
function clearLoginFailures(req){loginAttempts.delete(clientKey(req))}
function setSecurityHeaders(res){res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(self)');res.setHeader('Cross-Origin-Opener-Policy','same-origin');}

function emptyDB(){return {users:[], sessions:[], passwordResets:[], listings:[], offers:[], bookings:[], matches:[], verifications:[], notifications:[], settings:{brandName:'TUT Move',siteUrl:'https://tutmove.com',platformFeePct:5,defaultCurrency:'USD',ownerName:'',ownerEmail:'',legalEntity:'',supportEmail:'info@tutmove.com',commissionIban:'',commissionAccountName:'',launchMarkets:['USA','Canada','Europe','Middle East']}};}
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
function currencyMinorAmount(amount,currency){
  const c=String(currency||'').toUpperCase();
  const zero=new Set(['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF']);
  const three=new Set(['BHD','IQD','JOD','KWD','LYD','OMR','TND']);
  const digits=zero.has(c)?0:(three.has(c)?3:2),factor=10**digits;
  return Math.round(Number(amount||0)*factor);
}
function commissionIsPaid(b){return ['commission_paid','paid','completed'].includes(String(b?.paymentStatus||''))}
async function revolutRequest(method,endpoint,body){
  if(!REVOLUT_SECRET_KEY)throw new Error('Revolut Merchant API is not configured yet. Add REVOLUT_MERCHANT_SECRET_KEY in Render.');
  const headers={'Authorization':`Bearer ${REVOLUT_SECRET_KEY}`,'Revolut-Api-Version':REVOLUT_API_VERSION,'Accept':'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetch(REVOLUT_BASE_URL+endpoint,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const raw=await r.text();let data={};try{data=raw?JSON.parse(raw):{}}catch{data={raw}}
  if(!r.ok)throw new Error(data?.message||data?.error||`Revolut API error (${r.status})`);
  return data;
}
async function syncRevolutCommission(db,b){
  if(!b?.revolutOrderId)return false;
  const order=await revolutRequest('GET',`/api/orders/${encodeURIComponent(b.revolutOrderId)}`);
  b.revolutOrderState=order.state||b.revolutOrderState||'';b.revolutLastSyncAt=new Date().toISOString();
  if(order.state==='completed'){
    b.paymentStatus='commission_paid';b.paymentMode=`revolut_${REVOLUT_ENV}`;b.commissionPaidAt=b.commissionPaidAt||new Date().toISOString();
    b.commissionPaidAmount=Number(b.commissionAmount??b.platformFee??0);b.commissionPaidCurrency=b.currency;
    if(b.trip?.ready&&bookingDealType(b,db)==='transport'&&!b.trip.pickupConfirmed)b.status='ready_for_pickup';
    return true;
  }
  return false;
}
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
function normalizeBookingWorkflow(b,db){
  const type=bookingDealType(b,db);b.dealType=type;b.trip=b.trip||{};
  const listing=db.listings.find(x=>x.id===b.listingId),offer=db.offers.find(x=>x.id===b.offerId);
  if(listing&&offer){const otherUserId=offer.fromUserId===listing.userId?offer.toUserId:offer.fromUserId;if(listing.resource==='load'){if(listing.intent==='have'){b.buyerUserId=listing.userId;b.providerUserId=otherUserId}else if(listing.intent==='need'){b.providerUserId=listing.userId;b.buyerUserId=otherUserId}}else if(listing.intent==='need'){b.buyerUserId=listing.userId;b.providerUserId=otherUserId}else if(listing.intent==='have'){b.providerUserId=listing.userId;b.buyerUserId=otherUserId}}
  if(type==='driver'){
    const feePct=Number(b.platformFeePct ?? db.settings.platformFeePct ?? 5);b.platformFeePct=feePct;b.platformFee=+(Number(b.agreedPrice||0)*feePct/100).toFixed(2);b.commissionAmount=b.platformFee;b.serviceAmount=Number(b.agreedPrice||0);b.servicePaymentMode='direct_between_users';b.providerNet=Number(b.agreedPrice||0);b.feeChargedTo='buyer';b.buyerTotal=Number(b.agreedPrice||0);if(!b.paymentStatus||b.paymentStatus==='not_required'||b.paymentStatus==='test_unpaid')b.paymentStatus='commission_due';if(!b.paymentMode||b.paymentMode==='not_required'||b.paymentMode==='test_commission')b.paymentMode='revolut_pending';
    if(['ready_for_pickup','in_transit','completed_test'].includes(b.status))b.status=b.trip.ready?'driver_match_confirmed':'driver_agreed';
  }else if(type==='warehouse'&&(b.trip.ready||b.status==='ready_for_pickup'))b.status='storage_confirmed';
  else if((type==='truck'||type==='equipment')&&(b.trip.ready||b.status==='ready_for_pickup'))b.status='vehicle_ready';
  return b;
}
function maskedLicence(v){const raw=String(v?.licenceNumber||v?.licenseNumber||'').trim();if(!raw)return '';return raw.length<=4?'••••'+raw:'•••• '+raw.slice(-4)}
function userVerificationSummary(u,db){
  const legacy=(db.verifications||[]).find(v=>v.userId===u?.id)||{};const v={...legacy,...(u?.verification||{})};
  return {status:v.status||u?.verificationStatus||'not_submitted',licenceClass:v.licenceClass||v.licenseClass||'',licenceNumberMasked:maskedLicence(v),licenceExpiry:v.expiry||v.licenceExpiry||'',vehicleId:v.vehicleId||'',verified:!!u?.verified||['verified','manual_verified'].includes(v.status)};
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
  const out={...b},type=bookingDealType(b,db);
  if(type==='driver')out.dealContext=driverDealContext(b,db);
  else if(type==='warehouse'){const accepted=db.listings.find(x=>x.id===b.listingId);out.dealContext=pairedResourceDealContext(b,db,accepted?.resource==='storage'?'storage':'warehouse');}
  else if(type==='truck')out.dealContext=pairedResourceDealContext(b,db,'truck');
  else if(type==='equipment')out.dealContext=pairedResourceDealContext(b,db,'equipment');
  else if(type==='transport')out.dealContext=transportDealContext(b,db);
  return out;
}
function hashPassword(p,salt=crypto.randomBytes(16).toString('hex')){const h=crypto.scryptSync(p,salt,64).toString('hex');return {salt,hash:h}}
function resetTokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}
async function smtpSend({host,port,user,pass,from,to,subject,text}){
  return new Promise((resolve,reject)=>{
    const socket=tls.connect({host,port,servername:host,rejectUnauthorized:true});let buffer='',queue=[];
    const fail=e=>{try{socket.destroy()}catch{}reject(e instanceof Error?e:new Error(String(e)))};
    const wait=()=>new Promise((res,rej)=>queue.push({res,rej}));
    socket.setTimeout(15000,()=>fail(new Error('SMTP timeout')));
    socket.on('error',fail);socket.on('data',d=>{buffer+=d.toString();let lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const line of lines){if(!line)continue;if(/^\d{3}-/.test(line))continue;if(/^\d{3} /.test(line)){const q=queue.shift();if(q){const code=Number(line.slice(0,3));code>=400?q.rej(new Error('SMTP '+code)):q.res(line)}}}});
    socket.on('secureConnect',async()=>{try{await wait();const cmd=async c=>{socket.write(c+'\r\n');return wait()};await cmd('EHLO tutmove.com');await cmd('AUTH LOGIN');await cmd(Buffer.from(user).toString('base64'));await cmd(Buffer.from(pass).toString('base64'));await cmd(`MAIL FROM:<${from}>`);await cmd(`RCPT TO:<${to}>`);await cmd('DATA');const safeText=String(text).replace(/\r?\n\./g,'\r\n..');socket.write(`From: TUT Move <${from}>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${safeText}\r\n.\r\n`);await wait();await cmd('QUIT');socket.end();resolve()}catch(e){fail(e)}});
  });
}
async function sendPasswordResetEmail(to,token){
  const host=process.env.SMTP_HOST||'mail.privateemail.com',port=Number(process.env.SMTP_PORT||465),user=process.env.SMTP_USER||'',pass=process.env.SMTP_PASS||'',from=process.env.SMTP_FROM||user||'info@tutmove.com';
  if(!user||!pass) throw new Error('Password reset email is not configured.');
  const link=`${process.env.PUBLIC_SITE_URL||'https://tutmove.com'}/?reset=${encodeURIComponent(token)}`;
  const text=`A password reset was requested for your TUT Move account.\n\nReset your password: ${link}\n\nThis link expires in 30 minutes and can be used once. If you did not request this, ignore this email.`;
  await smtpSend({host,port,user,pass,from,to,subject:'Reset your TUT Move password',text});
}
function safeUser(u){return {id:u.id,name:u.name,email:u.email,role:u.role,roles:u.roles||[u.role],country:u.country||'',region:u.region||'',language:u.language||'en',currency:u.currency||'USD',verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started',createdAt:u.createdAt}}
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
function saveDataUrl(userId,kind,dataUrl){if(!dataUrl||typeof dataUrl!=='string')return null;const m=dataUrl.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,(.+)$/);if(!m)return null;const buf=Buffer.from(m[2],'base64');if(buf.length>3e6)throw new Error('File too large (3MB max).');const ext=m[1]==='application/pdf'?'pdf':m[1].split('/')[1].replace('jpeg','jpg');fs.mkdirSync(UPLOADS,{recursive:true});const name=`${userId}_${kind}_${Date.now()}.${ext}`;fs.writeFileSync(path.join(UPLOADS,name),buf);return {name,mime:m[1],size:buf.length};}
function autoPrecheck(v){const required=['license','identity','selfie'];const files=v.files||{};const present=required.every(k=>files[k]&&files[k].size>0);if(!present)return {status:'incomplete',score:0,message:'Required documents are missing.'};const acceptable=required.every(k=>files[k].size>=15000&&files[k].size<=3e6);if(!acceptable)return {status:'review_required',score:45,message:'Files received but quality/size needs review.'};return {status:'precheck_passed',score:80,message:'Automated file pre-check passed. Official identity/document verification provider is not connected yet.'};}
function publicListing(x,db){const u=db.users.find(z=>z.id===x.userId);return {...x,user:u?{id:u.id,name:u.name,verified:!!u.verified,verificationStatus:u.verificationStatus||'not_started'}:null};}
function serveStatic(res,p,req=null){const allowed=new Set(['/','/index.html','/app.js','/style.css','/tut-emblem.png','/favicon-48.png','/favicon-96.png','/favicon-192.png','/apple-touch-icon.png']);const route=p==='/'?'/index.html':p;if(!allowed.has(route))return false;const f=path.join(ROOT,route.slice(1));if(!fs.existsSync(f))return false;const ext=path.extname(f);const ct={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png'}[ext]||'application/octet-stream';let b=fs.readFileSync(f);const cache=['.html','.css','.js'].includes(ext)?'no-store':'public, max-age=86400';const headers={'Content-Type':ct,'Cache-Control':cache,'Vary':'Accept-Encoding'};if(req&&/gzip/.test(String(req.headers['accept-encoding']||''))&&['.html','.css','.js'].includes(ext)){b=zlib.gzipSync(b,{level:6});headers['Content-Encoding']='gzip'}headers['Content-Length']=b.length;res.writeHead(200,headers);res.end(b);return true;}

const server=http.createServer(async(req,res)=>{setSecurityHeaders(res);
 const url=new URL(req.url,`http://${req.headers.host}`),p=url.pathname;
 try{
  if(p==='/api/health')return json(res,200,{ok:true,version:'85',site:'tutmove.com',database:await dbInfo()});
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
    const b=await getBody(req);if(!b.name||!b.email||!b.password||b.password.length<8)return json(res,400,{error:'Name, email and password (8+ chars) required.'});if(b.acceptedTerms!==true)return json(res,400,{error:'You must agree to the Terms of Service and Privacy Policy.'});const db=readDB();if(db.users.some(u=>u.email.toLowerCase()===String(b.email).toLowerCase()))return json(res,409,{error:'Email already registered.'});
    const hp=hashPassword(b.password);const roles=Array.isArray(b.roles)&&b.roles.length?b.roles.slice(0,5):['member'];const u={id:id('u'),name:String(b.name).trim(),email:String(b.email).trim().toLowerCase(),role:roles[0],roles,country:b.country||'',region:b.region||'',language:b.language||'en',currency:b.currency||'USD',verified:false,verificationStatus:'not_started',termsAcceptedAt:new Date().toISOString(),termsVersion:String(b.termsVersion||'2026-09-17'),...hp,createdAt:new Date().toISOString()};db.users.push(u);const sid=addSession(db,u.id);await writeDB(db);res.setHeader('Set-Cookie',sessionCookie(sid));return json(res,201,{user:safeUser(u)});
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
  if(p==='/api/integrations/status'&&req.method==='GET'){const paymentCredentials=!!REVOLUT_SECRET_KEY;const kycProvider=!!(process.env.KYC_PROVIDER||process.env.KYC_API_KEY);return json(res,200,{payment:{provider:'revolut',mode:paymentCredentials?REVOLUT_ENV:'not_configured',credentialsDetected:paymentCredentials,realCaptureEnabled:paymentCredentials&&REVOLUT_ENV==='production',sandboxEnabled:paymentCredentials&&REVOLUT_ENV==='sandbox'},kyc:{providerConfigured:kycProvider,manualReviewEnabled:true}});}
  if(p==='/api/settings'&&req.method==='GET'){return json(res,200,{settings:readDB().settings});}
  if(p==='/api/admin/settings'&&req.method==='PUT'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const b=await getBody(req),db=readDB();if(Number.isFinite(Number(b.platformFeePct))){const nextFeePct=Math.max(0,Math.min(100,Number(b.platformFeePct)));db.settings.platformFeePct=nextFeePct;}if(b.defaultCurrency)db.settings.defaultCurrency=String(b.defaultCurrency).slice(0,5);for(const k of ['brandName','siteUrl','ownerName','ownerEmail','legalEntity','supportEmail','commissionIban','commissionAccountName'])if(k in b)db.settings[k]=String(b[k]||'').trim().slice(0,180);await writeDB(db);return json(res,200,{settings:db.settings});}
  if(p==='/api/listings'&&req.method==='GET'){const db=readDB();const listings=db.listings.filter(x=>x.status==='open').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(x=>publicListing(x,db));return json(res,200,{listings});}
  if(p==='/api/listings'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const b=await getBody(req);const resources=['driver','truck','load','warehouse','storage','equipment'];const intents=['have','need'];const priceModes=['fixed','negotiable','request_quotes','open_bidding'];if(!resources.includes(b.resource)||!intents.includes(b.intent)||!priceModes.includes(b.priceMode))return json(res,400,{error:'Invalid listing.'});
    const db=readDB();const x={id:id('l'),userId:u.id,intent:b.intent,resource:b.resource,title:String(b.title||'').slice(0,120),country:b.country||u.country||'',currency:b.currency||u.currency||db.settings.defaultCurrency,priceMode:b.priceMode,price:Number(b.price||0),data:sanitizeData(b.data),status:'open',createdAt:new Date().toISOString()};db.listings.push(x);recomputeMatches(db);await writeDB(db);return json(res,201,{listing:x});
  }
  if(p.startsWith('/api/listings/')&&req.method==='DELETE'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const lid=p.split('/').pop(),db=readDB(),x=db.listings.find(z=>z.id===lid);if(!x)return json(res,404,{error:'Listing not found.'});if(x.userId!==u.id&&!isOwner(u))return json(res,403,{error:'Not your listing.'});x.status='closed';recomputeMatches(db);await writeDB(db);return json(res,200,{ok:true});}
  if(p==='/api/matches'&&req.method==='GET'){const db=readDB();recomputeMatches(db);await writeDB(db);const map=Object.fromEntries(db.listings.map(x=>[x.id,publicListing(x,db)]));return json(res,200,{matches:db.matches.map(m=>({...m,listings:m.listingIds.map(i=>map[i]).filter(Boolean)}))});}
  if(p==='/api/offers'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const myListings=new Set(db.listings.filter(x=>x.userId===u.id).map(x=>x.id));const offers=isOwner(u)?db.offers:db.offers.filter(o=>o.fromUserId===u.id||o.toUserId===u.id||myListings.has(o.listingId));return json(res,200,{offers:offers.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});}
  if(p==='/api/offers'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const b=await getBody(req),db=readDB(),listing=db.listings.find(x=>x.id===b.listingId&&x.status==='open');if(!listing)return json(res,404,{error:'Listing not found.'});if(listing.userId===u.id)return json(res,400,{error:'You cannot offer on your own listing.'});const amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Offer amount required.'});const o={id:id('o'),listingId:listing.id,fromUserId:u.id,toUserId:listing.userId,amount,currency:b.currency||listing.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:b.parentOfferId||null,createdAt:new Date().toISOString()};db.offers.push(o);addNotification(db,listing.userId,'offer','New offer received',`${u.name||'A member'} sent you an offer of ${o.currency} ${o.amount}.`,'offers');await writeDB(db);return json(res,201,{offer:o});
  }
  if(/^\/api\/offers\/[^/]+\/(accept|reject|counter)$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const parts=p.split('/'),oid=parts[3],action=parts[4],db=readDB(),o=db.offers.find(x=>x.id===oid);if(!o)return json(res,404,{error:'Offer not found.'});if(o.toUserId!==u.id&&o.fromUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Not allowed.'});
    if(action==='accept'){
      if(o.toUserId!==u.id&&!isOwner(u))return json(res,403,{error:'Only recipient can accept.'});o.status='accepted';const listing=db.listings.find(x=>x.id===o.listingId);if(listing)listing.status='booked';const dealType=dealTypeForListing(listing);const feePct=Number(db.settings.platformFeePct ?? 5);const fee=+(o.amount*feePct/100).toFixed(2);const otherUserId=listing?(o.fromUserId===listing.userId?o.toUserId:o.fromUserId):o.fromUserId;const isLoad=listing&&listing.resource==='load';const buyerUserId=isLoad?(listing.intent==='have'?listing.userId:otherUserId):(listing&&listing.intent==='need'?listing.userId:otherUserId),providerUserId=isLoad?(listing.intent==='need'?listing.userId:otherUserId):(listing&&listing.intent==='have'?listing.userId:otherUserId);const booking={id:id('b'),listingId:o.listingId,offerId:o.id,dealType,buyerUserId,providerUserId,agreedPrice:o.amount,currency:o.currency,platformFeePct:feePct,platformFee:fee,commissionAmount:fee,serviceAmount:+o.amount.toFixed(2),servicePaymentMode:'direct_between_users',buyerTotal:+o.amount.toFixed(2),providerNet:+o.amount.toFixed(2),feeChargedTo:'buyer',paymentStatus:'commission_due',paymentMode:'bank_transfer_manual_confirmation',commissionReference:`TM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,payoutStatus:'not_applicable',status:'agreed',trip:{driverVerified:false,licenceVerified:false,truckVerified:false,cargoConfirmed:false,receiverConfirmed:false,termsConfirmed:false,warehouseVerified:false,datesConfirmed:false,handoverConfirmed:false,equipmentVerified:false,pickupConfirmed:false,providerReady:false,buyerReady:false,pickupAt:null,deliveredAt:null,updatedAt:new Date().toISOString()},createdAt:new Date().toISOString()};db.bookings.push(booking);addNotification(db,buyerUserId,'agreement','Agreement accepted',`Your ${dealType} agreement is accepted. TUT Move commission of ${o.currency} ${fee.toFixed(2)} is now due separately. The service amount remains payable directly between the parties.`,'offers');addNotification(db,providerUserId,'agreement','You were selected',`Your ${dealType} offer/agreement was accepted. Open Activity to continue.`,'offers');recomputeMatches(db);await writeDB(db);return json(res,200,{booking});
    }
    if(action==='reject'){o.status='rejected';addNotification(db,o.fromUserId,'offer_rejected','Offer update','Your offer was not accepted.','offers');await writeDB(db);return json(res,200,{offer:o});}
    const b=await getBody(req),amount=Number(b.amount||0);if(!(amount>0))return json(res,400,{error:'Counter amount required.'});o.status='countered';const c={id:id('o'),listingId:o.listingId,fromUserId:u.id,toUserId:u.id===o.fromUserId?o.toUserId:o.fromUserId,amount,currency:o.currency,message:String(b.message||'').slice(0,500),status:'pending',parentOfferId:o.id,createdAt:new Date().toISOString()};db.offers.push(c);addNotification(db,c.toUserId,'counter','Counter offer received',`${u.name||'A member'} sent a counter offer of ${c.currency} ${c.amount}.`,'offers');await writeDB(db);return json(res,201,{offer:c});
  }
  // Privacy boundary: TUT Move does not collect, store, review or expose deal/KYC documents.
  if(p.startsWith('/api/verification')||p.startsWith('/api/admin/verifications')||/\/api\/bookings\/[^/]+\/driver-document/.test(p)){
    return json(res,410,{error:'TUT Move does not collect or review user transaction documents.'});
  }
  if(p==='/api/verification/me'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});
    const db=readDB(),me=db.users.find(x=>x.id===u.id);if(!me)return json(res,404,{error:'User not found.'});
    return json(res,200,{verification:me.verification||{status:'not_submitted',role:'',legalName:'',country:'',licenceNumber:'',vehicleId:'',notes:'',submittedAt:null,reviewedAt:null}});
  }
  if(p==='/api/verification/submit'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const body=await getBody(req,14e6),db=readDB(),me=db.users.find(x=>x.id===u.id);if(!me)return json(res,404,{error:'User not found.'});
    const files={};for(const k of ['license','identity','selfie']){if(body.files&&body.files[k])files[k]=saveDataUrl(u.id,k,body.files[k]);}
    me.verification={...(me.verification||{}),status:'pending',role:String(body.role||''),legalName:String(body.legalName||'').trim(),country:String(body.country||''),identityNumber:String(body.identityNumber||'').trim(),licenceNumber:String(body.licenceNumber||'').trim(),licenceClasses:Array.isArray(body.licenceClasses)?body.licenceClasses.map(x=>String(x).slice(0,50)).slice(0,20):[],licenceExpiry:String(body.licenceExpiry||'').slice(0,20),endorsements:String(body.endorsements||'').trim().slice(0,500),registrationNumber:String(body.registrationNumber||'').trim().slice(0,120),vehicleId:String(body.vehicleId||'').trim(),notes:String(body.notes||'').trim(),files:{...(me.verification?.files||{}),...files},submittedAt:new Date().toISOString(),reviewedAt:null};
    me.verified=false;me.verificationStatus='pending';
    await writeDB(db);return json(res,200,{verification:me.verification,message:'Verification submitted for review.'});
  }
  if(p==='/api/admin/verifications'&&req.method==='GET'){
    const u=auth(req);if(!u||!isOwner(u))return json(res,403,{error:'Owner only.'});const db=readDB();
    return json(res,200,{items:db.users.filter(x=>x.verification).map(x=>({userId:x.id,email:x.email,name:x.name,verification:x.verification}))});
  }
  if(/^\/api\/admin\/verifications\/[^/]+\/review$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u||!isOwner(u))return json(res,403,{error:'Owner only.'});const body=await getBody(req);if(!['verified','rejected'].includes(body.status))return json(res,400,{error:'Invalid status.'});
    const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target||!target.verification)return json(res,404,{error:'Verification not found.'});
    target.verification.status=body.status;target.verification.reviewNote=String(body.reviewNote||'');target.verification.reviewedAt=new Date().toISOString();target.verified=body.status==='verified';target.verificationStatus=body.status==='verified'?'manual_verified':'rejected';await writeDB(db);return json(res,200,{verification:target.verification});
  }
  if(p==='/api/notifications'&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();const items=(db.notifications||[]).filter(n=>n.userId===u.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,60);return json(res,200,{items,unread:items.filter(x=>!x.read).length});
  }
  if(p==='/api/notifications/read'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();for(const n of (db.notifications||[]))if(n.userId===u.id)n.read=true;await writeDB(db);return json(res,200,{ok:true});
  }
  if(/^\/api\/bookings\/[^/]+\/driver-documents$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b||bookingDealType(b,db)!=='driver')return json(res,404,{error:'Driver agreement not found.'});const ctx=driverDealContext(b,db);if(!ctx)return json(res,404,{error:'Driver agreement not found.'});if(![ctx.driverUserId,ctx.requesterUserId].includes(u.id)&&!isOwner(u))return json(res,403,{error:'Documents are private.'});const v=verificationRecordForUser(db,ctx.driverUserId),files=v.files||{};const docs=['license','identity','selfie'].filter(k=>files[k]&&files[k].name).map(k=>({kind:k,mime:files[k].mime||'',size:files[k].size||0,url:`/api/bookings/${bid}/driver-document/${k}`}));return json(res,200,{driver:{name:ctx.driver?.name||'',verificationStatus:v.status||ctx.driver?.verificationStatus||'pending'},documents:docs});
  }
  if(/^\/api\/bookings\/[^/]+\/driver-document\/(license|identity|selfie)$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const parts=p.split('/'),bid=parts[3],kind=parts[5],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b||bookingDealType(b,db)!=='driver')return json(res,404,{error:'Driver agreement not found.'});const ctx=driverDealContext(b,db);if(!ctx||(![ctx.driverUserId,ctx.requesterUserId].includes(u.id)&&!isOwner(u)))return json(res,403,{error:'Documents are private.'});const v=verificationRecordForUser(db,ctx.driverUserId),f=v.files&&v.files[kind];if(!f||!f.name)return json(res,404,{error:'Document not uploaded.'});const fp=path.join(UPLOADS,path.basename(f.name));if(!fs.existsSync(fp))return json(res,404,{error:'Document file not found.'});const buf=fs.readFileSync(fp);res.writeHead(200,{'Content-Type':f.mime||'application/octet-stream','Content-Length':buf.length,'Content-Disposition':`inline; filename="${path.basename(f.name)}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(buf);
  }
  if(p==='/api/bookings'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB();db.bookings.forEach(b=>normalizeBookingWorkflow(b,db));const bookings=(isOwner(u)?db.bookings:db.bookings.filter(b=>b.buyerUserId===u.id||b.providerUserId===u.id)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(b=>bookingView(b,db));await writeDB(db);return json(res,200,{bookings});}
  if(/^\/api\/bookings\/[^/]+\/commission-instructions$/.test(p)&&req.method==='GET'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id)&&!isOwner(u))return json(res,403,{error:'Not part of this booking.'});
    if(!b.commissionReference)b.commissionReference=`TM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    await writeDB(db);return json(res,200,{bookingId:b.id,amount:Number(b.commissionAmount??b.platformFee??0),currency:b.currency,reference:b.commissionReference,iban:db.settings.commissionIban||'',accountName:db.settings.commissionAccountName||db.settings.ownerName||'TUT Move',paymentStatus:b.paymentStatus});
  }
  if(/^\/api\/bookings\/[^/]+\/commission-submitted$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(b.buyerUserId!==u.id)return json(res,403,{error:'Only the commission payer can submit payment.'});if(commissionIsPaid(b))return json(res,200,{booking:b,message:'Commission is already confirmed.'});
    if(!b.commissionReference)b.commissionReference=`TM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;b.paymentStatus='commission_pending_owner_confirmation';b.paymentMode='bank_transfer_manual_confirmation';b.commissionSubmittedAt=new Date().toISOString();addNotification(db,b.providerUserId,'payment','Commission payment submitted','The requester submitted the TUT Move commission for owner verification.','offers');await writeDB(db);return json(res,200,{booking:b,message:'Payment submitted for verification.'});
  }
  if(/^\/api\/admin\/bookings\/[^/]+\/confirm-commission$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const bid=p.split('/')[4],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(commissionIsPaid(b))return json(res,200,{booking:b,message:'Commission is already confirmed.'});
    if(b.paymentStatus!=='commission_pending_owner_confirmation')return json(res,409,{error:'The payer must submit the commission transfer before it can be confirmed.'});
    b.paymentStatus='commission_paid';b.paymentMode='bank_transfer_owner_confirmed';b.commissionPaidAt=new Date().toISOString();b.commissionPaidAmount=Number(b.commissionAmount??b.platformFee??0);b.commissionPaidCurrency=b.currency;b.commissionConfirmedBy=u.id;addNotification(db,b.buyerUserId,'payment','Commission confirmed','TUT Move confirmed receipt of the commission. The next deal stage is now unlocked.','offers');addNotification(db,b.providerUserId,'payment','Commission confirmed','TUT Move confirmed receipt of the commission. The next deal stage is now unlocked.','offers');await writeDB(db);return json(res,200,{booking:b,message:'Commission receipt confirmed.'});
  }
  if(/^\/api\/bookings\/[^/]+\/test-pay$/.test(p)&&req.method==='POST'){return json(res,410,{error:'Test payment bypass is disabled.'});}

  if(/^\/api\/bookings\/[^/]+\/trip-check$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],body=await getBody(req),db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id)&&!isOwner(u))return json(res,403,{error:'Not part of this booking.'});
    const dealType=bookingDealType(b,db);b.dealType=dealType;b.trip=b.trip||{};
    // The private completion stage belongs to the two parties and opens only after TUT Move commission is confirmed.
    if(!commissionIsPaid(b))return json(res,409,{error:'TUT Move commission must be confirmed before the final party-to-party stage opens.'});
    if(dealType==='transport'&&(b.trip.pickupConfirmed||['in_transit','completed_test'].includes(b.status)))return json(res,409,{error:'Party confirmation is locked after pickup.'});
    const prevProviderReady=!!b.trip.providerReady,prevBuyerReady=!!b.trip.buyerReady;
    if(u.id===b.providerUserId)b.trip.providerReady=!!body.ready;if(u.id===b.buyerUserId)b.trip.buyerReady=!!body.ready;
    if(u.id===b.buyerUserId&&b.trip.buyerReady&&!prevBuyerReady){addNotification(db,b.providerUserId,'agreement','Requester confirmed',`The requester confirmed the ${dealType} agreement. Open Activity for your next action.`,'offers')}
    if(u.id===b.providerUserId&&b.trip.providerReady&&!prevProviderReady){addNotification(db,b.buyerUserId,'agreement','Provider confirmed',`The provider confirmed the ${dealType} agreement. Open Activity to continue.`,'offers')}
    b.trip.ready=!!b.trip.providerReady&&!!b.trip.buyerReady;
    if(b.trip.ready){
      if(dealType==='transport')b.status='ready_for_pickup';
      else if(dealType==='warehouse')b.status='storage_confirmed';
      else if(dealType==='truck'||dealType==='equipment')b.status='vehicle_ready';
      else if(dealType==='driver')b.status='driver_match_confirmed';
      else b.status='parties_confirmed';
    }else if(b.trip.buyerReady&&!b.trip.providerReady)b.status='requester_confirmed';
    else if(b.trip.providerReady&&!b.trip.buyerReady)b.status='provider_ready';
    else b.status='agreed';
    b.trip.updatedAt=new Date().toISOString();
    await writeDB(db);return json(res,200,{booking:b});
  }
  if(/^\/api\/bookings\/[^/]+\/pickup$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id)&&!isOwner(u))return json(res,403,{error:'Not part of this booking.'});if(bookingDealType(b,db)!=='transport')return json(res,400,{error:'Pickup applies only to transport bookings.'});if(!b.trip?.ready)return json(res,409,{error:'Trip verification is not complete.'});if(!commissionIsPaid(b))return json(res,409,{error:'TUT Move commission must be paid before pickup.'});if(b.trip?.pickupConfirmed||['in_transit','completed_test'].includes(b.status))return json(res,409,{error:'Pickup is already confirmed.'});b.trip.pickupConfirmed=true;b.trip.pickupAt=new Date().toISOString();b.status='in_transit';await writeDB(db);return json(res,200,{booking:b});
  }
  if(/^\/api\/bookings\/[^/]+\/deliver$/.test(p)&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const bid=p.split('/')[3],db=readDB(),b=db.bookings.find(x=>x.id===bid);if(!b)return json(res,404,{error:'Booking not found.'});if(![b.buyerUserId,b.providerUserId].includes(u.id)&&!isOwner(u))return json(res,403,{error:'Not part of this booking.'});if(bookingDealType(b,db)!=='transport')return json(res,400,{error:'Delivery applies only to transport bookings.'});if(b.status!=='in_transit')return json(res,409,{error:'Pickup must be confirmed first.'});b.trip.receiverConfirmed=true;b.trip.deliveredAt=new Date().toISOString();b.status='completed_test';b.payoutStatus='not_applicable';await writeDB(db);return json(res,200,{booking:b,message:'Delivery recorded. The underlying service payment remains directly between the parties.'});
  }
  if(p==='/api/verification'&&req.method==='GET'){const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const db=readDB(),v=db.verifications.find(x=>x.userId===u.id);return json(res,200,{verification:v||null});}
  if(p==='/api/verification'&&req.method==='POST'){
    const u=auth(req);if(!u)return json(res,401,{error:'Login required.'});const b=await getBody(req,14e6),db=readDB();const files={};for(const k of ['license','identity','selfie']){if(b.files&&b.files[k])files[k]=saveDataUrl(u.id,k,b.files[k]);}
    let v=db.verifications.find(x=>x.userId===u.id);if(!v){v={id:id('v'),userId:u.id,createdAt:new Date().toISOString()};db.verifications.push(v)}v.country=b.country||u.country||'';v.licenseNumber=String(b.licenseNumber||'').slice(0,80);v.licenseClass=String(b.licenseClass||'').slice(0,40);v.expiry=String(b.expiry||'').slice(0,20);v.files={...(v.files||{}),...files};v.updatedAt=new Date().toISOString();const pre=autoPrecheck(v);v.status=pre.status;v.score=pre.score;v.message=pre.message;const user=db.users.find(x=>x.id===u.id);if(user){user.verificationStatus=v.status;user.verified=false;}await writeDB(db);return json(res,200,{verification:v,user:safeUser(user)});
  }
  if(p==='/api/admin/summary'&&req.method==='GET'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const db=readDB();const marketplaceUsers=db.users.filter(x=>x.role!=='owner');const roleCounts={driver:0,carrier:0,shipper:0,warehouse:0,equipment:0,other:0};for(const x of marketplaceUsers){const roles=(x.roles&&x.roles.length?x.roles:[x.role]).filter(r=>r&&r!=='owner');if(!roles.length)roleCounts.other++;else for(const r of new Set(roles)){if(Object.prototype.hasOwnProperty.call(roleCounts,r))roleCounts[r]++;else roleCounts.other++;}}return json(res,200,{users:marketplaceUsers.map(safeUser),listings:db.listings,offers:db.offers,bookings:db.bookings,settings:db.settings,stats:{users:marketplaceUsers.length,roleCounts,openListings:db.listings.filter(x=>x.status==='open').length,offers:db.offers.length,bookings:db.bookings.length,platformRevenueByCurrency:Object.fromEntries(Object.entries(db.bookings.reduce((a,b)=>{const c=b.currency||'UNKNOWN';a[c]=(a[c]||0)+Number(b.platformFee||0);return a},{})).map(([c,v])=>[c,+v.toFixed(2)]))}});}
  if(/^\/api\/admin\/users\/[^/]+$/.test(p)&&req.method==='DELETE'){const owner=auth(req);if(!isOwner(owner))return json(res,403,{error:'Owner access required.'});const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target)return json(res,404,{error:'User not found.'});if(target.role==='owner')return json(res,403,{error:'Owner account cannot be deleted.'});const listingIds=new Set(db.listings.filter(x=>x.userId===uid).map(x=>x.id));const offerIds=new Set(db.offers.filter(x=>x.fromUserId===uid||x.toUserId===uid||listingIds.has(x.listingId)).map(x=>x.id));db.users=db.users.filter(x=>x.id!==uid);db.listings=db.listings.filter(x=>x.userId!==uid);db.offers=db.offers.filter(x=>x.fromUserId!==uid&&x.toUserId!==uid&&!listingIds.has(x.listingId));db.bookings=db.bookings.filter(x=>x.buyerUserId!==uid&&x.providerUserId!==uid&&!listingIds.has(x.listingId)&&!offerIds.has(x.offerId));db.verifications=db.verifications.filter(x=>x.userId!==uid);db.notifications=(db.notifications||[]).filter(x=>x.userId!==uid);db.sessions=(db.sessions||[]).filter(x=>x.userId!==uid);db.matches=[];recomputeMatches(db);try{if(fs.existsSync(UPLOADS)){for(const name of fs.readdirSync(UPLOADS)){if(name.startsWith(uid+'_')){try{fs.unlinkSync(path.join(UPLOADS,name))}catch{}}}}}catch{}await writeDB(db);return json(res,200,{ok:true,message:'User account deleted.'});}
  if(p.startsWith('/api/admin/users/')&&p.endsWith('/verify')&&req.method==='POST'){const u=auth(req);if(!isOwner(u))return json(res,403,{error:'Owner access required.'});const uid=p.split('/')[4],db=readDB(),target=db.users.find(x=>x.id===uid);if(!target)return json(res,404,{error:'User not found.'});target.verified=true;target.verificationStatus='manual_verified';if(target.verification){target.verification.status='verified';target.verification.reviewedAt=new Date().toISOString();}await writeDB(db);return json(res,200,{user:safeUser(target)});}
  if(serveStatic(res,p,req))return;
  return json(res,404,{error:'Not found'});
 }catch(e){console.error(e);return json(res,500,{error:e.message||'Server error'});}
});
initDB()
  .then(()=>server.listen(PORT,()=>console.log(`TUT Move production running on ${PORT}`)))
  .catch(err=>{console.error('Database initialization failed:',err);process.exit(1)});
