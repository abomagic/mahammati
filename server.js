const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "mahammati.db"));
const PORT = Number(process.env.PORT || 3000);
const CURRENCY = process.env.CURRENCY || "EGP";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const PAYMOB_BASE_URL = process.env.PAYMOB_BASE_URL || "https://accept.paymob.com";
const PAYMOB_SECRET_KEY = process.env.PAYMOB_SECRET_KEY || "";
const PAYMOB_PUBLIC_KEY = process.env.PAYMOB_PUBLIC_KEY || "";
const PAYMOB_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || "";
const PAYMOB_PAYMENT_METHOD_IDS = String(process.env.PAYMOB_PAYMENT_METHOD_IDS || "")
  .split(",").map(x => Number(x.trim())).filter(Number.isInteger);
const APP_BASE_URL = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req,res)=>res.status(200).send("ok"));

db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',
  balance_piasters INTEGER NOT NULL DEFAULT 0,
  held_piasters INTEGER NOT NULL DEFAULT 0,
  payout_method TEXT,
  payout_details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reward_piasters INTEGER NOT NULL,
  slots INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS submissions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  answer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reward_piasters INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  UNIQUE(task_id,user_id),
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS withdrawals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount_piasters INTEGER NOT NULL,
  payout_method TEXT NOT NULL,
  payout_details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS vip_plans(
  level INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price_piasters INTEGER NOT NULL,
  badge_color TEXT NOT NULL DEFAULT '#7667ff',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vip_orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_level INTEGER NOT NULL,
  amount_piasters INTEGER NOT NULL,
  special_reference TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'paymob',
  provider_order_id TEXT,
  provider_transaction_id TEXT UNIQUE,
  client_secret TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(plan_level) REFERENCES vip_plans(level)
);
CREATE TABLE IF NOT EXISTS platform_settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function ensureColumn(table, column, definition){
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if(!cols.some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("users","vip_level","INTEGER NOT NULL DEFAULT 0");
ensureColumn("users","vip_updated_at","TEXT");

function seedVipPlans(){
  const insert = db.prepare("INSERT OR IGNORE INTO vip_plans(level,name,price_piasters,badge_color,active) VALUES(?,?,?,?,1)");
  const tx = db.transaction(()=>{
    insert.run(1,"VIP 1",500,"#39c6ff");
    insert.run(2,"VIP 2",1000,"#a875ff");
    insert.run(3,"VIP 3",2000,"#ffb33d");
    insert.run(4,"VIP 4",3500,"#ff607c");
  });
  tx();
}
seedVipPlans();
db.prepare("INSERT OR IGNORE INTO platform_settings(key,value) VALUES('withdrawals_enabled','1')").run();

function hashPassword(password, salt=crypto.randomBytes(16).toString("hex")){
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return {salt, hash};
}
function verifyPassword(password, salt, expected){
  const actual = crypto.scryptSync(password, salt, 64);
  const exp = Buffer.from(expected, "hex");
  return exp.length === actual.length && crypto.timingSafeEqual(actual, exp);
}
function createAdmin(){
  const existing = db.prepare("SELECT id FROM users WHERE email=?").get(ADMIN_EMAIL);
  if(!existing){
    const {salt, hash} = hashPassword(ADMIN_PASSWORD);
    db.prepare("INSERT INTO users(email,password_hash,salt,role) VALUES(?,?,?,'admin')").run(ADMIN_EMAIL,hash,salt);
    console.log("Admin created:", ADMIN_EMAIL);
  }
}
createAdmin();

function seedTasks(){
  const count = db.prepare("SELECT COUNT(*) c FROM tasks").get().c;
  if(count) return;
  const seed = [
    ["تصنيف منتج واحد","راجع اسم المنتج واختر الفئة المناسبة، ثم اكتب سببًا قصيرًا.",75,30],
    ["تقييم وضوح عنوان","اقرأ العنوان وحدد هل هو واضح أم يحتاج تعديلًا، مع تعليق من سطر واحد.",50,50],
    ["مراجعة وصف قصير","ابحث عن خطأ إملائي أو صياغة غير واضحة في النص المعروض.",100,25],
    ["اختيار أفضل تسمية","اختر الاسم الأنسب من الخيارات واكتب سبب الاختيار.",125,20],
    ["تدقيق بيانات بسيطة","قارن قيمتين واكتب هل هما متطابقتان أم لا.",60,40]
  ];
  const ins = db.prepare("INSERT INTO tasks(title,description,reward_piasters,slots) VALUES(?,?,?,?)");
  db.transaction(()=>seed.forEach(t=>ins.run(...t)))();
}
seedTasks();

function makeSession(userId){
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now()+7*24*60*60*1000).toISOString();
  db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").run(token,userId,expires);
  return token;
}
function auth(req,res,next){
  const token = (req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  if(!token) return res.status(401).json({error:"غير مسجل"});
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at > datetime('now')`).get(token);
  if(!row) return res.status(401).json({error:"الجلسة انتهت"});
  req.user=row; next();
}
function admin(req,res,next){ auth(req,res,()=> req.user.role==="admin" ? next() : res.status(403).json({error:"غير مسموح"})); }
function safeUser(u){
  const plan = u.vip_level ? db.prepare("SELECT level,name,badge_color FROM vip_plans WHERE level=?").get(u.vip_level) : null;
  return {id:u.id,email:u.email,role:u.role,balance_piasters:u.balance_piasters,held_piasters:u.held_piasters,
    payout_method:u.payout_method,payout_details:u.payout_details,vip_level:u.vip_level||0,vip_plan:plan};
}
function getSetting(key, fallback){ const r=db.prepare("SELECT value FROM platform_settings WHERE key=?").get(key); return r?r.value:fallback; }
function validColor(c){ return /^#[0-9a-fA-F]{6}$/.test(String(c||"")); }

app.post("/api/register",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({error:"بريد غير صالح"});
  if(password.length<8) return res.status(400).json({error:"كلمة المرور 8 أحرف على الأقل"});
  const {salt,hash}=hashPassword(password);
  try{
    const info=db.prepare("INSERT INTO users(email,password_hash,salt) VALUES(?,?,?)").run(email,hash,salt);
    res.json({token:makeSession(info.lastInsertRowid)});
  }catch{ res.status(409).json({error:"البريد مستخدم بالفعل"}); }
});
app.post("/api/login",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  const u=db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if(!u || !verifyPassword(password,u.salt,u.password_hash)) return res.status(401).json({error:"بيانات الدخول غير صحيحة"});
  res.json({token:makeSession(u.id)});
});
app.get("/api/me",auth,(req,res)=>res.json({user:safeUser(req.user),currency:CURRENCY,withdrawals_enabled:getSetting("withdrawals_enabled","1")==="1"}));

app.get("/api/tasks",auth,(req,res)=>{
  const rows=db.prepare(`SELECT t.*,(SELECT status FROM submissions s WHERE s.task_id=t.id AND s.user_id=?) my_status
    FROM tasks t WHERE t.active=1 AND t.slots > (SELECT COUNT(*) FROM submissions s2 WHERE s2.task_id=t.id AND s2.status='approved')
    ORDER BY RANDOM() LIMIT 12`).all(req.user.id);
  res.json({tasks:rows});
});
app.post("/api/tasks/:id/submit",auth,(req,res)=>{
  const task=db.prepare("SELECT * FROM tasks WHERE id=? AND active=1").get(Number(req.params.id));
  if(!task) return res.status(404).json({error:"المهمة غير موجودة"});
  const answer=String(req.body.answer||"").trim();
  if(answer.length<2) return res.status(400).json({error:"اكتب إجابة للمهمة"});
  try{
    db.prepare("INSERT INTO submissions(task_id,user_id,answer,reward_piasters) VALUES(?,?,?,?)").run(task.id,req.user.id,answer,task.reward_piasters);
    res.json({ok:true,message:"تم إرسال المهمة للمراجعة. لا تُضاف المكافأة إلا بعد اعتمادها."});
  }catch{ res.status(409).json({error:"أرسلت هذه المهمة من قبل"}); }
});

app.put("/api/payout-profile",auth,(req,res)=>{
  const method=String(req.body.method||"").trim();
  const details=String(req.body.details||"").trim();
  if(!["instapay","bank","wallet","paypal"].includes(method)) return res.status(400).json({error:"طريقة سحب غير مدعومة"});
  if(details.length<3 || details.length>180) return res.status(400).json({error:"بيانات السحب غير صالحة"});
  db.prepare("UPDATE users SET payout_method=?,payout_details=? WHERE id=?").run(method,details,req.user.id);
  res.json({ok:true});
});
app.post("/api/withdrawals",auth,(req,res)=>{
  if(getSetting("withdrawals_enabled","1")!=="1") return res.status(503).json({error:"السحب متوقف مؤقتًا من الإدارة"});
  const amount=Number(req.body.amount_piasters);
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if(!Number.isInteger(amount) || amount<=0) return res.status(400).json({error:"اكتب مبلغ سحب صحيح"});
  if(!u.payout_method || !u.payout_details) return res.status(400).json({error:"أضف بيانات السحب أولًا"});
  if(u.balance_piasters<amount) return res.status(400).json({error:"الرصيد غير كافٍ"});
  db.transaction(()=>{
    db.prepare("UPDATE users SET balance_piasters=balance_piasters-?,held_piasters=held_piasters+? WHERE id=?").run(amount,amount,u.id);
    db.prepare("INSERT INTO withdrawals(user_id,amount_piasters,payout_method,payout_details) VALUES(?,?,?,?)").run(u.id,amount,u.payout_method,u.payout_details);
  })();
  res.json({ok:true,message:"تم حجز المبلغ وفتح طلب السحب للمراجعة والتحويل."});
});
app.get("/api/my-withdrawals",auth,(req,res)=>{
  res.json({withdrawals:db.prepare("SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC").all(req.user.id)});
});

// VIP public API
app.get("/api/vip/plans",auth,(req,res)=>{
  res.json({plans:db.prepare("SELECT level,name,price_piasters,badge_color FROM vip_plans WHERE active=1 ORDER BY level").all(),current_level:req.user.vip_level||0,
    paymob_ready:Boolean(PAYMOB_SECRET_KEY&&PAYMOB_PUBLIC_KEY&&PAYMOB_PAYMENT_METHOD_IDS.length&&APP_BASE_URL)});
});
app.post("/api/vip/checkout",auth,async(req,res)=>{
  const level=Number(req.body.level);
  const fullName=String(req.body.full_name||"").trim();
  const phone=String(req.body.phone||"").trim();
  const plan=db.prepare("SELECT * FROM vip_plans WHERE level=? AND active=1").get(level);
  if(!plan) return res.status(404).json({error:"خطة VIP غير موجودة"});
  if(level <= (req.user.vip_level||0)) return res.status(400).json({error:"اختر VIP أعلى من مستواك الحالي"});
  if(fullName.length<2 || phone.length<7) return res.status(400).json({error:"اكتب الاسم ورقم الهاتف لإتمام الدفع"});
  if(!PAYMOB_SECRET_KEY || !PAYMOB_PUBLIC_KEY || !PAYMOB_PAYMENT_METHOD_IDS.length || !APP_BASE_URL)
    return res.status(503).json({error:"بوابة الشحن التلقائي لم تُربط بعد. أضف مفاتيح Paymob في Railway."});

  const ref=`VIP-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
  const info=db.prepare("INSERT INTO vip_orders(user_id,plan_level,amount_piasters,special_reference) VALUES(?,?,?,?)")
    .run(req.user.id,level,plan.price_piasters,ref);
  const orderId=Number(info.lastInsertRowid);
  const parts=fullName.split(/\s+/);
  const firstName=parts.shift()||"Customer";
  const lastName=parts.join(" ")||"User";
  const payload={
    amount:plan.price_piasters,
    currency:CURRENCY,
    payment_methods:PAYMOB_PAYMENT_METHOD_IDS,
    items:[{name:plan.name,amount:plan.price_piasters,description:`Mahammati ${plan.name}`,quantity:1}],
    billing_data:{first_name:firstName,last_name:lastName,email:req.user.email,phone_number:phone,apartment:"NA",building:"NA",street:"NA",floor:"NA",city:"Cairo",state:"Cairo",country:"EGY"},
    special_reference:ref,
    notification_url:`${APP_BASE_URL}/api/paymob/webhook`,
    redirection_url:`${APP_BASE_URL}/?vip_payment=return`,
    expiration:3600
  };
  try{
    const r=await fetch(`${PAYMOB_BASE_URL}/v1/intention/`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Token ${PAYMOB_SECRET_KEY}`},body:JSON.stringify(payload)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok || !j.client_secret){
      db.prepare("UPDATE vip_orders SET status='failed' WHERE id=?").run(orderId);
      return res.status(502).json({error:"تعذر بدء عملية الدفع",provider_error:j});
    }
    db.prepare("UPDATE vip_orders SET provider_order_id=?,client_secret=? WHERE id=?").run(String(j.intention_order_id||""),j.client_secret,orderId);
    const checkout=`${PAYMOB_BASE_URL}/unifiedcheckout/?publicKey=${encodeURIComponent(PAYMOB_PUBLIC_KEY)}&clientSecret=${encodeURIComponent(j.client_secret)}`;
    res.json({ok:true,checkout_url:checkout,order_id:orderId});
  }catch(e){
    db.prepare("UPDATE vip_orders SET status='failed' WHERE id=?").run(orderId);
    res.status(502).json({error:"تعذر الاتصال ببوابة الدفع"});
  }
});

function paymobValue(v){ if(v===true)return "true"; if(v===false)return "false"; if(v===null||v===undefined)return ""; return String(v); }
function verifyPaymobHmac(obj, received){
  if(!PAYMOB_HMAC_SECRET || !obj) return false;
  const s=obj.source_data||{};
  const values=[obj.amount_cents,obj.created_at,obj.currency,obj.error_occured,obj.has_parent_transaction,obj.id,obj.integration_id,
    obj.is_3d_secure,obj.is_auth,obj.is_capture,obj.is_refunded,obj.is_standalone_payment,obj.is_voided,obj.order?.id,obj.owner,obj.pending,
    s.pan,s.sub_type,s.type,obj.success];
  const signed=values.map(paymobValue).join("");
  const expected=crypto.createHmac("sha512",PAYMOB_HMAC_SECRET).update(signed).digest("hex");
  try{
    const a=Buffer.from(expected,"utf8"), b=Buffer.from(String(received||""),"utf8");
    return a.length===b.length && crypto.timingSafeEqual(a,b);
  }catch{return false;}
}
app.post("/api/paymob/webhook",(req,res)=>{
  const obj=req.body?.obj;
  if(!verifyPaymobHmac(obj,req.query.hmac)) return res.status(401).send("bad hmac");
  const merchantRef=String(obj?.order?.merchant_order_id || obj?.merchant_order_id || "");
  const order=db.prepare("SELECT * FROM vip_orders WHERE special_reference=?").get(merchantRef);
  if(!order) return res.status(200).send("ignored");
  if(order.status==="paid") return res.status(200).send("ok");
  const succeeded=obj.success===true && obj.pending===false && obj.error_occured===false && obj.is_refunded===false && obj.is_voided===false;
  if(!succeeded){
    if(obj.pending===false) db.prepare("UPDATE vip_orders SET status='failed' WHERE id=?").run(order.id);
    return res.status(200).send("ok");
  }
  if(Number(obj.amount_cents)!==order.amount_piasters || String(obj.currency)!==CURRENCY) return res.status(400).send("amount mismatch");
  try{
    db.transaction(()=>{
      db.prepare("UPDATE vip_orders SET status='paid',provider_transaction_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status!='paid'")
        .run(String(obj.id),order.id);
      db.prepare("UPDATE users SET vip_level=?,vip_updated_at=CURRENT_TIMESTAMP WHERE id=?").run(order.plan_level,order.user_id);
    })();
  }catch(e){ return res.status(200).send("ok"); }
  res.status(200).send("ok");
});

// Admin
app.get("/api/admin/queue",admin,(req,res)=>{
  const submissions=db.prepare(`SELECT s.*,u.email,t.title FROM submissions s JOIN users u ON u.id=s.user_id JOIN tasks t ON t.id=s.task_id WHERE s.status='pending' ORDER BY s.id`).all();
  const withdrawals=db.prepare(`SELECT w.*,u.email,u.vip_level,v.name vip_name,v.badge_color vip_color
    FROM withdrawals w JOIN users u ON u.id=w.user_id LEFT JOIN vip_plans v ON v.level=u.vip_level
    WHERE w.status='pending' ORDER BY u.vip_level DESC,w.id`).all();
  res.json({submissions,withdrawals,withdrawals_enabled:getSetting("withdrawals_enabled","1")==="1"});
});
app.post("/api/admin/tasks",admin,(req,res)=>{
  const title=String(req.body.title||"").trim(), description=String(req.body.description||"").trim();
  const reward=Number(req.body.reward_piasters), slots=Number(req.body.slots);
  if(!title||!description||!Number.isInteger(reward)||reward<1||!Number.isInteger(slots)||slots<1) return res.status(400).json({error:"بيانات المهمة غير صالحة"});
  const info=db.prepare("INSERT INTO tasks(title,description,reward_piasters,slots) VALUES(?,?,?,?)").run(title,description,reward,slots);
  res.json({ok:true,id:info.lastInsertRowid});
});
app.post("/api/admin/submissions/:id/review",admin,(req,res)=>{
  const status=String(req.body.status);
  if(!["approved","rejected"].includes(status)) return res.status(400).json({error:"حالة غير صالحة"});
  const s=db.prepare("SELECT * FROM submissions WHERE id=?").get(Number(req.params.id));
  if(!s||s.status!=="pending") return res.status(404).json({error:"العنصر غير متاح"});
  db.transaction(()=>{
    db.prepare("UPDATE submissions SET status=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(status,s.id);
    if(status==="approved") db.prepare("UPDATE users SET balance_piasters=balance_piasters+? WHERE id=?").run(s.reward_piasters,s.user_id);
  })();
  res.json({ok:true});
});
app.post("/api/admin/withdrawals/:id/paid",admin,(req,res)=>{
  const ref=String(req.body.reference||"").trim();
  if(ref.length<2) return res.status(400).json({error:"أدخل مرجع التحويل الحقيقي"});
  const w=db.prepare("SELECT * FROM withdrawals WHERE id=?").get(Number(req.params.id));
  if(!w||w.status!=="pending") return res.status(404).json({error:"طلب السحب غير متاح"});
  db.transaction(()=>{
    db.prepare("UPDATE withdrawals SET status='paid',reference=?,paid_at=CURRENT_TIMESTAMP WHERE id=?").run(ref,w.id);
    db.prepare("UPDATE users SET held_piasters=held_piasters-? WHERE id=?").run(w.amount_piasters,w.user_id);
  })();
  res.json({ok:true});
});
app.post("/api/admin/withdrawals/:id/reject",admin,(req,res)=>{
  const w=db.prepare("SELECT * FROM withdrawals WHERE id=?").get(Number(req.params.id));
  if(!w||w.status!=="pending") return res.status(404).json({error:"طلب السحب غير متاح"});
  db.transaction(()=>{
    db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").run(w.id);
    db.prepare("UPDATE users SET held_piasters=held_piasters-?,balance_piasters=balance_piasters+? WHERE id=?").run(w.amount_piasters,w.amount_piasters,w.user_id);
  })();
  res.json({ok:true});
});
app.put("/api/admin/settings/withdrawals",admin,(req,res)=>{
  const enabled=Boolean(req.body.enabled);
  db.prepare("INSERT INTO platform_settings(key,value,updated_at) VALUES('withdrawals_enabled',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(enabled?"1":"0");
  res.json({ok:true,enabled});
});
app.get("/api/admin/vip",admin,(req,res)=>{
  const plans=db.prepare("SELECT * FROM vip_plans ORDER BY level").all();
  const users=db.prepare(`SELECT u.id,u.email,u.vip_level,u.balance_piasters,u.created_at,v.name vip_name,v.badge_color vip_color
    FROM users u LEFT JOIN vip_plans v ON v.level=u.vip_level WHERE u.role!='admin' ORDER BY u.id DESC LIMIT 200`).all();
  const orders=db.prepare(`SELECT o.*,u.email,p.name plan_name FROM vip_orders o JOIN users u ON u.id=o.user_id JOIN vip_plans p ON p.level=o.plan_level ORDER BY o.id DESC LIMIT 100`).all();
  res.json({plans,users,orders});
});
app.put("/api/admin/vip/plans/:level",admin,(req,res)=>{
  const level=Number(req.params.level), name=String(req.body.name||"").trim(), price=Number(req.body.price_piasters), color=String(req.body.badge_color||"").trim(), active=Boolean(req.body.active);
  if(!Number.isInteger(level)||level<1||level>20||!name||!Number.isInteger(price)||price<0||!validColor(color)) return res.status(400).json({error:"بيانات VIP غير صالحة"});
  db.prepare("INSERT INTO vip_plans(level,name,price_piasters,badge_color,active,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(level) DO UPDATE SET name=excluded.name,price_piasters=excluded.price_piasters,badge_color=excluded.badge_color,active=excluded.active,updated_at=CURRENT_TIMESTAMP")
    .run(level,name,price,color,active?1:0);
  res.json({ok:true});
});
app.put("/api/admin/users/:id/vip",admin,(req,res)=>{
  const userId=Number(req.params.id), level=Number(req.body.vip_level);
  if(!Number.isInteger(level)||level<0) return res.status(400).json({error:"VIP غير صالح"});
  if(level>0 && !db.prepare("SELECT 1 FROM vip_plans WHERE level=?").get(level)) return res.status(400).json({error:"خطة VIP غير موجودة"});
  const info=db.prepare("UPDATE users SET vip_level=?,vip_updated_at=CURRENT_TIMESTAMP WHERE id=? AND role!='admin'").run(level,userId);
  if(!info.changes) return res.status(404).json({error:"المستخدم غير موجود"});
  res.json({ok:true});
});

app.listen(PORT,()=>console.log(`Mahammati running on http://localhost:${PORT}`));
