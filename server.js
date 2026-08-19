
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
const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL_PIASTERS || 2000);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";

app.get("/health", (req,res)=>res.status(200).send("ok"));
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

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
`);

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
    db.prepare("INSERT INTO users(email,password_hash,salt,role) VALUES(?,?,?,'admin')")
      .run(ADMIN_EMAIL,hash,salt);
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
  const tx = db.transaction(()=>seed.forEach(t=>ins.run(...t)));
  tx();
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
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at > datetime('now')
  `).get(token);
  if(!row) return res.status(401).json({error:"الجلسة انتهت"});
  req.user=row; next();
}
function admin(req,res,next){
  auth(req,res,()=> req.user.role==="admin" ? next() : res.status(403).json({error:"غير مسموح"}));
}
function safeUser(u){
  return {id:u.id,email:u.email,role:u.role,balance_piasters:u.balance_piasters,
    held_piasters:u.held_piasters,payout_method:u.payout_method,payout_details:u.payout_details};
}

app.post("/api/register",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({error:"بريد غير صالح"});
  if(password.length<8) return res.status(400).json({error:"كلمة المرور 8 أحرف على الأقل"});
  const {salt,hash}=hashPassword(password);
  try{
    const info=db.prepare("INSERT INTO users(email,password_hash,salt) VALUES(?,?,?)").run(email,hash,salt);
    const token=makeSession(info.lastInsertRowid);
    res.json({token});
  }catch(e){
    res.status(409).json({error:"البريد مستخدم بالفعل"});
  }
});
app.post("/api/login",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  const u=db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if(!u || !verifyPassword(password,u.salt,u.password_hash)) return res.status(401).json({error:"بيانات الدخول غير صحيحة"});
  res.json({token:makeSession(u.id)});
});
app.get("/api/me",auth,(req,res)=>res.json({user:safeUser(req.user),currency:CURRENCY,min_withdrawal_piasters:MIN_WITHDRAWAL}));

app.get("/api/tasks",auth,(req,res)=>{
  const rows=db.prepare(`
    SELECT t.*,
      (SELECT status FROM submissions s WHERE s.task_id=t.id AND s.user_id=?) my_status
    FROM tasks t
    WHERE t.active=1 AND t.slots > (
      SELECT COUNT(*) FROM submissions s2 WHERE s2.task_id=t.id AND s2.status='approved'
    )
    ORDER BY RANDOM() LIMIT 12
  `).all(req.user.id);
  res.json({tasks:rows});
});

app.post("/api/tasks/:id/submit",auth,(req,res)=>{
  const task=db.prepare("SELECT * FROM tasks WHERE id=? AND active=1").get(Number(req.params.id));
  if(!task) return res.status(404).json({error:"المهمة غير موجودة"});
  const answer=String(req.body.answer||"").trim();
  if(answer.length<2) return res.status(400).json({error:"اكتب إجابة للمهمة"});
  try{
    db.prepare("INSERT INTO submissions(task_id,user_id,answer,reward_piasters) VALUES(?,?,?,?)")
      .run(task.id,req.user.id,answer,task.reward_piasters);
    res.json({ok:true,message:"تم إرسال المهمة للمراجعة. لا تُضاف المكافأة إلا بعد اعتمادها."});
  }catch{
    res.status(409).json({error:"أرسلت هذه المهمة من قبل"});
  }
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
  const amount=Number(req.body.amount_piasters);
  const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  if(!Number.isInteger(amount) || amount<MIN_WITHDRAWAL) return res.status(400).json({error:`الحد الأدنى ${MIN_WITHDRAWAL/100} ${CURRENCY}`});
  if(!u.payout_method || !u.payout_details) return res.status(400).json({error:"أضف بيانات السحب أولًا"});
  if(u.balance_piasters<amount) return res.status(400).json({error:"الرصيد غير كافٍ"});

  const tx=db.transaction(()=>{
    db.prepare("UPDATE users SET balance_piasters=balance_piasters-?,held_piasters=held_piasters+? WHERE id=?")
      .run(amount,amount,u.id);
    db.prepare("INSERT INTO withdrawals(user_id,amount_piasters,payout_method,payout_details) VALUES(?,?,?,?)")
      .run(u.id,amount,u.payout_method,u.payout_details);
  });
  tx();
  res.json({ok:true,message:"تم حجز المبلغ وفتح طلب سحب حقيقي للمراجعة والتحويل."});
});

app.get("/api/my-withdrawals",auth,(req,res)=>{
  res.json({withdrawals:db.prepare("SELECT * FROM withdrawals WHERE user_id=? ORDER BY id DESC").all(req.user.id)});
});

// Admin
app.get("/api/admin/queue",admin,(req,res)=>{
  const submissions=db.prepare(`
    SELECT s.*,u.email,t.title FROM submissions s
    JOIN users u ON u.id=s.user_id JOIN tasks t ON t.id=s.task_id
    WHERE s.status='pending' ORDER BY s.id
  `).all();
  const withdrawals=db.prepare(`
    SELECT w.*,u.email FROM withdrawals w JOIN users u ON u.id=w.user_id
    WHERE w.status='pending' ORDER BY w.id
  `).all();
  res.json({submissions,withdrawals});
});
app.post("/api/admin/tasks",admin,(req,res)=>{
  const title=String(req.body.title||"").trim();
  const description=String(req.body.description||"").trim();
  const reward=Number(req.body.reward_piasters);
  const slots=Number(req.body.slots);
  if(!title || !description || !Number.isInteger(reward) || reward<1 || !Number.isInteger(slots) || slots<1)
    return res.status(400).json({error:"بيانات المهمة غير صالحة"});
  const info=db.prepare("INSERT INTO tasks(title,description,reward_piasters,slots) VALUES(?,?,?,?)")
    .run(title,description,reward,slots);
  res.json({ok:true,id:info.lastInsertRowid});
});
app.post("/api/admin/submissions/:id/review",admin,(req,res)=>{
  const status=String(req.body.status);
  if(!["approved","rejected"].includes(status)) return res.status(400).json({error:"حالة غير صالحة"});
  const s=db.prepare("SELECT * FROM submissions WHERE id=?").get(Number(req.params.id));
  if(!s || s.status!=="pending") return res.status(404).json({error:"العنصر غير متاح"});
  const tx=db.transaction(()=>{
    db.prepare("UPDATE submissions SET status=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(status,s.id);
    if(status==="approved"){
      db.prepare("UPDATE users SET balance_piasters=balance_piasters+? WHERE id=?").run(s.reward_piasters,s.user_id);
    }
  });
  tx();
  res.json({ok:true});
});
app.post("/api/admin/withdrawals/:id/paid",admin,(req,res)=>{
  const ref=String(req.body.reference||"").trim();
  if(ref.length<2) return res.status(400).json({error:"أدخل مرجع التحويل الحقيقي"});
  const w=db.prepare("SELECT * FROM withdrawals WHERE id=?").get(Number(req.params.id));
  if(!w || w.status!=="pending") return res.status(404).json({error:"طلب السحب غير متاح"});
  const tx=db.transaction(()=>{
    db.prepare("UPDATE withdrawals SET status='paid',reference=?,paid_at=CURRENT_TIMESTAMP WHERE id=?").run(ref,w.id);
    db.prepare("UPDATE users SET held_piasters=held_piasters-? WHERE id=?").run(w.amount_piasters,w.user_id);
  });
  tx();
  res.json({ok:true});
});
app.post("/api/admin/withdrawals/:id/reject",admin,(req,res)=>{
  const w=db.prepare("SELECT * FROM withdrawals WHERE id=?").get(Number(req.params.id));
  if(!w || w.status!=="pending") return res.status(404).json({error:"طلب السحب غير متاح"});
  const tx=db.transaction(()=>{
    db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").run(w.id);
    db.prepare("UPDATE users SET held_piasters=held_piasters-?,balance_piasters=balance_piasters+? WHERE id=?")
      .run(w.amount_piasters,w.amount_piasters,w.user_id);
  });
  tx();
  res.json({ok:true});
});

app.listen(PORT,()=>console.log(`Mahammati running on http://localhost:${PORT}`));
