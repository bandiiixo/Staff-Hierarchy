'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'chart.json');
const COOKIE_NAME = 'kng_admin';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('Missing ADMIN_PASSWORD or SESSION_SECRET environment variable.');
  process.exit(1);
}
if (String(ADMIN_PASSWORD).length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters long.');
  process.exit(1);
}
if (String(SESSION_SECRET).length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters long.');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeEqual(a,b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa,bb);
}
function sign(value) {
  return crypto.createHmac('sha256',SESSION_SECRET).update(value).digest('hex');
}
function isAdmin(req) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME+'='));
  if (!match) return false;
  let token;
  try { token = decodeURIComponent(match.slice(COOKIE_NAME.length+1)); } catch { return false; }
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expires,signature] = parts;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  return safeEqual(signature,sign(expires));
}
function requireAdmin(req,res,next) {
  if (!isAdmin(req)) return res.status(401).json({error:'Please log in with the management password to make changes.'});
  next();
}
const starterChart = {
  title:'KNG ESTATE',
  subtitle:'Organisation structure',
  nodes:[
    {id:'gm',role:'General Manager',name:'',parentId:null},
    {id:'community',role:'Community Director',name:'',parentId:'gm'},
    {id:'orgs',role:'Orgs Director',name:'',parentId:'gm'},
    {id:'wallstreet',role:'WallStreet Director',name:'',parentId:'gm'},
    {id:'admin-manager',role:'Administration Manager',name:'',parentId:'community'},
    {id:'culture-manager',role:'Culture Manager',name:'',parentId:'community'},
    {id:'gangs-manager',role:'Manager Of Gangs',name:'',parentId:'orgs'},
    {id:'legal-manager',role:'Manager Of Legal',name:'',parentId:'orgs'},
    {id:'wolf',role:'Wolf of WallStreet',name:'',parentId:'wallstreet'},
    {id:'tickets-resp',role:'Tickets Responsible',name:'',parentId:'admin-manager'},
    {id:'admin-resp',role:'Administration Responsible',name:'',parentId:'admin-manager'},
    {id:'entertainment',role:'Entertainment Responsible',name:'',parentId:'culture-manager'},
    {id:'moderation',role:'Moderation Responsible',name:'',parentId:'culture-manager'},
    {id:'influencer-resp',role:'Influencer Responsible',name:'',parentId:'culture-manager'},
    {id:'gang-adms',role:'Gangs ADMs',name:'',parentId:'gangs-manager'},
    {id:'legal-adm',role:'Legal ADM',name:'',parentId:'legal-manager'},
    {id:'ws-resp',role:'WallStreet Responsible',name:'',parentId:'wolf'},
    {id:'tickets-team',role:'Tickets Team ADM',name:'',parentId:'tickets-resp'},
    {id:'knowledge',role:'Knowledge ADM',name:'',parentId:'admin-resp'},
    {id:'discord',role:'Discord ADM',name:'',parentId:'admin-resp'},
    {id:'action',role:'Action ADM',name:'',parentId:'entertainment'},
    {id:'interactions',role:'Interactions ADM',name:'',parentId:'entertainment'},
    {id:'calls',role:'Calls ADM',name:'',parentId:'moderation'},
    {id:'order',role:'Order ADM',name:'',parentId:'moderation'},
    {id:'influencer-team',role:'Influencer Team',name:'',parentId:'influencer-resp'},
    {id:'ws-a',role:'WS_CriminalA ADM',name:'',parentId:'ws-resp'},
    {id:'ws-b',role:'WS_CriminalB ADM',name:'',parentId:'ws-resp'}
  ]
};
function ensureData() {
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE,JSON.stringify(starterChart,null,2));
}
function readChart() {
  ensureData();
  return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
}
function saveChart(chart) {
  fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});
  const temp = DATA_FILE+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(chart,null,2));
  fs.renameSync(temp,DATA_FILE);
}
function validateChart(chart) {
  if (!chart || !Array.isArray(chart.nodes) || chart.nodes.length < 1 || chart.nodes.length > 500) return 'Invalid chart data.';
  const ids = new Set();
  for (const node of chart.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || typeof node.role !== 'string' || !node.role.trim() || typeof node.name !== 'string') return 'Each position needs an ID, role and name.';
    if (ids.has(node.id)) return 'Duplicate position ID.';
    ids.add(node.id);
  }
  const roots = chart.nodes.filter(n => n.parentId === null);
  if (roots.length !== 1) return 'The hierarchy must have exactly one top-level position.';
  for (const node of chart.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) return 'A parent position could not be found.';
    let current = node;
    const seen = new Set([node.id]);
    while (current.parentId) {
      if (seen.has(current.parentId)) return 'Positions cannot be placed underneath themselves.';
      seen.add(current.parentId);
      current = chart.nodes.find(n => n.id === current.parentId);
      if (!current) return 'A parent position could not be found.';
    }
  }
  return null;
}
app.get('/api/health',(req,res) => res.json({ok:true,service:'kng-estate-org-chart'}));
app.get('/api/chart',(req,res) => {
  try {
    const chart = readChart();
    const error = validateChart(chart);
    if (error) throw new Error(error);
    res.json(chart);
  } catch (error) {
    console.error('Could not read chart data:',error);
    res.status(500).json({error:'The server could not read the saved hierarchy. Check the Render persistent disk and logs.'});
  }
});
app.get('/api/me',(req,res) => res.json({admin:isAdmin(req)}));
app.post('/api/login',(req,res) => {
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !safeEqual(password,ADMIN_PASSWORD)) return res.status(401).json({error:'Incorrect management password.'});
  const expires = String(Date.now()+7*24*60*60*1000);
  const token = `${expires}.${sign(expires)}`;
  res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${IS_PRODUCTION?'; Secure':''}`);
  res.json({ok:true});
});
app.post('/api/logout',(req,res) => {
  res.setHeader('Set-Cookie',`${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${IS_PRODUCTION?'; Secure':''}`);
  res.json({ok:true});
});
app.put('/api/chart',requireAdmin,(req,res) => {
  const chart = req.body;
  const error = validateChart(chart);
  if (error) return res.status(400).json({error});
  try {
    saveChart({title:'KNG ESTATE',subtitle:'Organisation structure',nodes:chart.nodes});
    res.json({ok:true});
  } catch (err) {
    console.error('Could not save chart:',err);
    res.status(500).json({error:'Could not save the hierarchy. Check that the Render disk is mounted and writable.'});
  }
});
app.get('*',(req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,() => console.log(`KNG Org Chart running on port ${PORT}`));
