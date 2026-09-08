import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import pg from "pg";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FREE_DAILY_LIMIT = 5;
const PRO_PRICE_RUB = process.env.PRO_PRICE_RUB || "299.00";
const PRO_DAYS = Number(process.env.PRO_DAYS || 30);
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const id = () => crypto.randomUUID();
const token = () => crypto.randomBytes(32).toString("hex");
const tokenHash = t => crypto.createHash("sha256").update(t).digest("hex");
const today = () => new Date().toISOString().slice(0,10);

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual,"hex"), Buffer.from(expected,"hex"));
}
function isPro(user) {
  if (user.plan !== "pro") return false;
  if (user.pro_until && new Date(user.pro_until) <= new Date()) return false;
  return true;
}
function publicUser(user) {
  const pro = isPro(user);
  return { id:user.id, email:user.email, plan:pro?"pro":"free", proUntil:user.pro_until||null, usageCount:user.usage_count||0, limit:FREE_DAILY_LIMIT };
}

async function yookassaRequest(pathname, options={}) {
  const shop=process.env.YOOKASSA_SHOP_ID, secret=process.env.YOOKASSA_SECRET_KEY;
  if(!shop || !secret){ const e=new Error("ЮKassa не настроена. Добавьте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY в .env."); e.status=503; throw e; }
  const headers={Authorization:"Basic "+Buffer.from(shop+":"+secret).toString("base64"),"Content-Type":"application/json",...(options.headers||{})};
  const r=await fetch("https://api.yookassa.ru/v3"+pathname,{...options,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(data.description||data.error||"Ошибка ЮKassa");e.status=r.status;throw e;}
  return data;
}

async function auth(req,res,next){
  const raw=req.headers.authorization?.replace(/^Bearer\s+/i,"");
  if(!raw) return res.status(401).json({error:"Требуется вход в аккаунт."});
  const {rows}=await pool.query(`SELECT s.id AS session_id,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1`,[tokenHash(raw)]);
  if(!rows[0]) return res.status(401).json({error:"Сессия истекла. Войдите снова."});
  req.user=rows[0]; req.sessionId=rows[0].session_id; req.token=raw; next();
}

function cleanJson(text){const t=String(text||"").trim().replace(/^```json\s*/i,"").replace(/^```\s*/,"").replace(/```$/i,"").trim();const a=t.indexOf("{"),b=t.lastIndexOf("}");if(a<0||b<0)throw new Error("AI returned invalid JSON");return JSON.parse(t.slice(a,b+1));}
async function askAI(instructions,input){if(!client){const e=new Error("OPENAI_API_KEY не настроен на сервере.");e.status=503;throw e;}const r=await client.responses.create({model:process.env.OPENAI_MODEL||"gpt-5.6-luna",instructions,input,store:false});return cleanJson(r.output_text);}

async function initDatabase(){
  if(!process.env.DATABASE_URL){
    const e=new Error("DATABASE_URL не настроен на сервере.");
    e.status=503;
    throw e;
  }
  const schema=await fs.readFile(path.join(__dirname,"schema.sql"),"utf8");
  await pool.query(schema);
}

async function ensureAdmin(){
  if(!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  const {rows}=await pool.query('SELECT id FROM users WHERE email=$1',[ADMIN_EMAIL]);
  if(rows[0]){ await pool.query("UPDATE users SET role='admin', updated_at=NOW() WHERE email=$1",[ADMIN_EMAIL]); return; }
  const hp=hashPassword(ADMIN_PASSWORD);
  await pool.query(`INSERT INTO users(id,email,password_hash,password_salt,plan,usage_day,usage_count,role) VALUES($1,$2,$3,$4,'pro',$5,0,'admin')`,[id(),ADMIN_EMAIL,hp.hash,hp.salt,today()]);
}

function isAdmin(user){ return user?.role==='admin'; }

async function adminAuth(req,res,next){
  return auth(req,res,()=>{ if(!isAdmin(req.user)) return res.status(403).json({error:'Доступ только для администратора.'}); next(); });
}

async function refreshUsage(user){
  const d=today();
  if(String(user.usage_day).slice(0,10)!==d){
    const {rows}=await pool.query(`UPDATE users SET usage_day=$1, usage_count=0, updated_at=NOW() WHERE id=$2 RETURNING *`,[d,user.id]);
    return rows[0];
  }
  return user;
}
async function consume(req,res){
  let user=await refreshUsage(req.user); req.user=user;
  if(isPro(user)) return true;
  if((user.usage_count||0)>=FREE_DAILY_LIMIT){res.status(429).json({error:"Лимит Free исчерпан. Откройте SHORTS PRO.",code:"FREE_LIMIT",used:user.usage_count,limit:FREE_DAILY_LIMIT});return false;}
  const {rows}=await pool.query(`UPDATE users SET usage_count=usage_count+1,updated_at=NOW() WHERE id=$1 RETURNING *`,[user.id]);
  req.user=rows[0]; return true;
}

app.get("/api/health",async(req,res)=>{try{await pool.query("SELECT 1");res.json({ok:true,db:"postgres"});}catch(e){res.status(503).json({ok:false,error:e.message});}});

app.post("/api/auth/register",async(req,res)=>{try{const email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||"");if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:"Введите корректный email."});if(password.length<8)return res.status(400).json({error:"Пароль должен быть не короче 8 символов."});const {rows:exists}=await pool.query("SELECT 1 FROM users WHERE email=$1",[email]);if(exists[0])return res.status(409).json({error:"Такой аккаунт уже существует."});const hp=hashPassword(password),userId=id(),raw=token();const {rows}=await pool.query(`INSERT INTO users(id,email,password_hash,password_salt,plan,usage_day,usage_count) VALUES($1,$2,$3,$4,'free',$5,0) RETURNING *`,[userId,email,hp.hash,hp.salt,today()]);await pool.query(`INSERT INTO sessions(id,user_id,token_hash) VALUES($1,$2,$3)`,[id(),userId,tokenHash(raw)]);res.json({token:raw,user:publicUser(rows[0])});}catch(e){res.status(500).json({error:e.message||"Ошибка регистрации"});}});

app.post("/api/auth/login",async(req,res)=>{try{const email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||"");const {rows}=await pool.query("SELECT * FROM users WHERE email=$1",[email]);const user=rows[0];if(!user||!verifyPassword(password,user.password_salt,user.password_hash))return res.status(401).json({error:"Неверный email или пароль."});const fresh=await refreshUsage(user);const raw=token();await pool.query("DELETE FROM sessions WHERE user_id=$1",[user.id]);await pool.query("INSERT INTO sessions(id,user_id,token_hash) VALUES($1,$2,$3)",[id(),user.id,tokenHash(raw)]);res.json({token:raw,user:publicUser(fresh)});}catch(e){res.status(500).json({error:e.message||"Ошибка входа"});}});
app.post("/api/auth/logout",auth,async(req,res)=>{await pool.query("DELETE FROM sessions WHERE id=$1",[req.sessionId]);res.json({ok:true});});
app.get("/api/auth/me",auth,async(req,res)=>{const user=await refreshUsage(req.user);res.json({user:publicUser(user)});});
app.get("/api/profile",auth,async(req,res)=>{
  try{
    const user=await refreshUsage(req.user);
    const [stats, recent]=await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS saved_count FROM saved_scripts WHERE user_id=$1`,[user.id]),
      pool.query(`SELECT action_type AS action,created_at FROM usage_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`,[user.id])
    ]);
    res.json({user:publicUser(user),stats:{savedCount:stats.rows[0]?.saved_count||0},recent:recent.rows});
  }catch(e){res.status(500).json({error:e.message||"Не удалось загрузить профиль"});}
});
app.post("/api/profile/password",auth,async(req,res)=>{
  try{const old=String(req.body?.oldPassword||""), next=String(req.body?.newPassword||"");
    if(next.length<8)return res.status(400).json({error:"Новый пароль должен быть не короче 8 символов."});
    if(!verifyPassword(old,req.user.password_salt,req.user.password_hash))return res.status(401).json({error:"Текущий пароль указан неверно."});
    const hp=hashPassword(next); await pool.query(`UPDATE users SET password_hash=$1,password_salt=$2,updated_at=NOW() WHERE id=$3`,[hp.hash,hp.salt,req.user.id]);
    await pool.query(`DELETE FROM sessions WHERE user_id=$1 AND id<>$2`,[req.user.id,req.sessionId]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message||"Не удалось изменить пароль"});}
});
app.post("/api/profile/logout-all",auth,async(req,res)=>{try{await pool.query(`DELETE FROM sessions WHERE user_id=$1`,[req.user.id]);res.json({ok:true});}catch(e){res.status(500).json({error:e.message})}});


app.post("/api/billing/create",auth,async(req,res)=>{try{if(isPro(req.user))return res.status(409).json({error:"PRO уже активен.",proUntil:req.user.pro_until});const base=process.env.PUBLIC_URL||`http://localhost:${port}`;const payment=await yookassaRequest("/payments",{method:"POST",headers:{"Idempotence-Key":crypto.randomUUID()},body:JSON.stringify({amount:{value:PRO_PRICE_RUB,currency:"RUB"},capture:true,description:"SHORTS AI PRO — 30 дней",confirmation:{type:"redirect",return_url:base+"/?payment=return"},metadata:{userId:req.user.id,product:"shorts_pro_30d"},save_payment_method:false})});res.json({id:payment.id,status:payment.status,confirmation_url:payment.confirmation?.confirmation_url||null});}catch(e){console.error(e);res.status(e.status||500).json({error:e.message||"Не удалось создать оплату"});}});

app.post("/api/billing/webhook",async(req,res)=>{try{if(req.body?.event!=="payment.succeeded")return res.sendStatus(200);const paymentId=req.body?.object?.id;if(!paymentId)return res.sendStatus(200);const payment=await yookassaRequest("/payments/"+encodeURIComponent(paymentId),{method:"GET"});if(payment.status!=="succeeded"||payment.paid!==true)return res.sendStatus(200);const userId=payment.metadata?.userId;if(!userId)return res.sendStatus(200);const clientDb=await pool.connect();try{await clientDb.query("BEGIN");const {rows}=await clientDb.query("SELECT * FROM users WHERE id=$1 FOR UPDATE",[userId]);const user=rows[0];if(!user){await clientDb.query("ROLLBACK");return res.sendStatus(200);}if(user.last_payment_id===payment.id){await clientDb.query("COMMIT");return res.sendStatus(200);}const now=new Date();const base=user.pro_until&&new Date(user.pro_until)>now?new Date(user.pro_until):now;base.setDate(base.getDate()+PRO_DAYS);await clientDb.query(`UPDATE users SET plan='pro',pro_until=$1,last_payment_id=$2,updated_at=NOW() WHERE id=$3`,[base.toISOString(),payment.id,userId]);await clientDb.query(`INSERT INTO payments(id,user_id,provider_payment_id,amount_rub,status) VALUES($1,$2,$3,$4,'succeeded') ON CONFLICT (provider_payment_id) DO UPDATE SET status='succeeded'`,[id(),userId,payment.id,Number(payment.amount?.value||PRO_PRICE_RUB)]);await clientDb.query("COMMIT");}catch(e){await clientDb.query("ROLLBACK");throw e;}finally{clientDb.release();}return res.sendStatus(200);}catch(e){console.error("Webhook error:",e);return res.sendStatus(500);}});

app.get('/api/admin/stats',adminAuth,async(req,res)=>{
  try{
    const [u,p,e,a]=await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE plan='pro' AND pro_until>NOW())::int AS pro, COUNT(*) FILTER (WHERE created_at>=CURRENT_DATE)::int AS new_today FROM users WHERE role<>'admin'`),
      pool.query(`SELECT COALESCE(SUM(amount_rub),0)::numeric AS revenue, COUNT(*)::int AS payments FROM payments WHERE status='succeeded'`),
      pool.query(`SELECT COUNT(*)::int AS total FROM usage_events`),
      pool.query(`SELECT COUNT(*)::int AS active_today FROM sessions WHERE created_at>=CURRENT_DATE`)
    ]);
    res.json({users:u.rows[0],payments:p.rows[0],ai:e.rows[0],active:a.rows[0]});
  }catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/admin/users',adminAuth,async(req,res)=>{
  try{const {rows}=await pool.query(`SELECT id,email,role,plan,pro_until,usage_day,usage_count,created_at,last_payment_id FROM users WHERE role<>'admin' ORDER BY created_at DESC LIMIT 200`);res.json(rows);}catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/admin/users/:id/pro',adminAuth,async(req,res)=>{
  try{const days=Math.max(1,Math.min(3650,Number(req.body?.days||30)));const until=new Date();until.setDate(until.getDate()+days);const {rows}=await pool.query(`UPDATE users SET plan='pro',pro_until=$1,updated_at=NOW() WHERE id=$2 AND role<>'admin' RETURNING id,email,plan,pro_until`,[until.toISOString(),req.params.id]);if(!rows[0])return res.status(404).json({error:'Пользователь не найден.'});res.json(rows[0]);}catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/admin/users/:id/free',adminAuth,async(req,res)=>{
  try{const {rows}=await pool.query(`UPDATE users SET plan='free',pro_until=NULL,updated_at=NOW() WHERE id=$1 AND role<>'admin' RETURNING id,email,plan,pro_until`,[req.params.id]);if(!rows[0])return res.status(404).json({error:'Пользователь не найден.'});res.json(rows[0]);}catch(e){res.status(500).json({error:e.message})}
});
app.get('/api/admin/activity',adminAuth,async(req,res)=>{
  try{const {rows}=await pool.query(`SELECT DATE_TRUNC('day',created_at)::date AS day, action_type, COUNT(*)::int AS count FROM usage_events WHERE created_at>=CURRENT_DATE-INTERVAL '13 days' GROUP BY 1,2 ORDER BY 1 DESC`);res.json(rows);}catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/saved",auth,async(req,res)=>{const {rows}=await pool.query(`SELECT id,title,hook,niche,duration,icon,TO_CHAR(created_at,'DD.MM.YYYY') AS date,created_at AS "createdAt" FROM saved_scripts WHERE user_id=$1 ORDER BY created_at DESC`,[req.user.id]);res.json(rows);});
app.post("/api/saved",auth,async(req,res)=>{const item=req.body||{};if(!item.title)return res.status(400).json({error:"Нужен title"});const {rows}=await pool.query(`INSERT INTO saved_scripts(id,user_id,title,hook,niche,duration) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,hook,niche,duration,icon,TO_CHAR(created_at,'DD.MM.YYYY') AS date,created_at AS "createdAt"`,[id(),req.user.id,String(item.title).slice(0,120),String(item.hook||"").slice(0,1000),String(item.niche||"Контент"),String(item.duration||"30с")]);res.json(rows[0]);});
app.delete("/api/saved/:id",auth,async(req,res)=>{await pool.query("DELETE FROM saved_scripts WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({ok:true});});

app.post("/api/generate",auth,async(req,res)=>{try{if(!(await consume(req,res)))return;const {idea,niche,tone,duration,platform}=req.body||{};if(!idea||idea.length>2000)return res.status(400).json({error:"Укажите идею до 2000 символов."});const data=await askAI(`Ты — креативный стратег коротких видео. Отвечай только валидным JSON без markdown. Создай оригинальный сценарий для ${platform||"Shorts"} длительностью ${duration||"30с"}. Ниша: ${niche||"общая"}. Стиль: ${tone||"вирусный"}. Структура: {"viral_score":0,"hook":"","shots":[{"time":"","text":""}],"on_screen_text":[],"voiceover":"","cta":"","description":"","hashtags":[]}. viral_score 0-100, shots 4-6, on_screen_text 3-6, hashtags 5-10. Не обещай гарантированные просмотры и не копируй известные сценарии.`,`Сгенерируй сценарий на русском языке для идеи: ${idea}`);await pool.query(`INSERT INTO usage_events(id,user_id,action_type) VALUES($1,$2,'generate')`,[id(),req.user.id]);res.json(data);}catch(e){console.error(e);res.status(e.status||500).json({error:e.message||"Ошибка сервера"});}});
app.post("/api/analyze",auth,async(req,res)=>{try{if(!(await consume(req,res)))return;const {idea}=req.body||{};if(!idea||idea.length>2000)return res.status(400).json({error:"Введите идею до 2000 символов."});const data=await askAI(`Ты — аналитик коротких видео. Отвечай только валидным JSON без markdown. Верни {"viral_score":0,"hook_score":0,"retention_score":0,"competition_score":0,"verdict":"","improvements":""}. Все score 0-100. competition_score: чем выше, тем сильнее конкуренция. Это экспертная оценка, не прогноз просмотров.`,`Проанализируй идею: ${idea}`);await pool.query(`INSERT INTO usage_events(id,user_id,action_type) VALUES($1,$2,'analyze')`,[id(),req.user.id]);res.json(data);}catch(e){console.error(e);res.status(e.status||500).json({error:e.message||"Ошибка сервера"});}});

app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

(async()=>{try{await initDatabase();await ensureAdmin();app.listen(port,"0.0.0.0",()=>console.log(`SHORTS AI running on port ${port}`));}catch(e){console.error('Startup DB error:',e);process.exit(1)}})();
process.on("SIGINT",async()=>{await pool.end();process.exit(0)});
process.on("SIGTERM",async()=>{await pool.end();process.exit(0)});
