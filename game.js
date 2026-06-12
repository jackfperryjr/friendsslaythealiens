'use strict';

const W = 960, H = 540;
const GROUND = H - 90;
const SPR = 128;        // display size of one character frame
const FRAME_SRC = 128;  // source size of one frame in the 256×256 sprite sheet (2×2 grid)
const FOOT_INSET = 15;  // pixels from bottom of sprite frame to the visual feet
const GRAVITY = 0.25;
const FALL_MULTIPLIER = 0.10; // heavier gravity on the way down for a snappier arc
const JUMP_FORCE = -10;
const WALK_SPEED = 1.75;

// Background: natural size 5623x1536, scale to canvas height
const BG_SCALE = H / 1536;
const BG_W = Math.round(5623 * BG_SCALE); // ~1977

// Parallax multipliers: index matches draw order [bg4(back), bg3, bg2, bg1(front)]
const PARALLAX_SPEEDS = [0.08, 0.25, 0.55, 1.0];

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;

// ─── Asset loading ────────────────────────────────────────────────────────────
const imgs = {};
const ASSET_MAP = {
  bg1:'assets/backgrounds/redplanet_layer01.png', bg2:'assets/backgrounds/redplanet_layer02.png',
  bg3:'assets/backgrounds/redplanet_layer03.png', bg4:'assets/backgrounds/redplanet_layer04.png',
  title:'assets/game_title.png',
  boy1:'assets/character/boy_01.png', boy2:'assets/character/boy_02.png',
  boy3:'assets/character/boy_03.png', boy4:'assets/character/boy_04.png',
  boy5:'assets/character/boy_05.png', boy6:'assets/character/boy_06.png',
  alien1:'assets/enemies/alien_01.png', alien2:'assets/enemies/alien_02.png',
  alien3:'assets/enemies/alien_03.png',
};

function loadAssets(cb) {
  let remaining = Object.keys(ASSET_MAP).length;
  for (const [k, src] of Object.entries(ASSET_MAP)) {
    const img = new Image();
    img.onload = img.onerror = () => { if (--remaining === 0) cb(); };
    img.src = src;
    imgs[k] = img;
  }
}

// ─── Game state ───────────────────────────────────────────────────────────────
let phase = 'title'; // title | playing | gameover
let score = 0;
let lives = 3;
let cameraX = 0;
let worldDist = 0;
let shakeFrames = 0;

// ─── Player ───────────────────────────────────────────────────────────────────
const PLAYER_DEFAULTS = {
  x: 160, y: GROUND, vx: 0, vy: 0,
  onGround: true, facing: 1,
  state: 'idle', // idle walk jump punch pistol hammer sword block
  weapon: 'none', // none pistol hammer sword
  hp: 5, maxHp: 5,
  attackTimer: 0, attackCooldown: 0, invincible: 0,
  blocking: false,
  walkCycle: 0, animFrame: 0,
};
let player = { ...PLAYER_DEFAULTS };

const WEAPON_RANGE  = { none: 90,  hammer: 110, sword: 140, pistol: 0  };
const WEAPON_DAMAGE = { none: 1,   hammer: 2,   sword: 2,   pistol: 1  };
const WEAPON_COOL   = { none: 30,  hammer: 40,  sword: 28,  pistol: 22 };
const WEAPON_COLOR  = { pistol: '#4af', hammer: '#fa0', sword: '#0ef'  };
const WEAPON_LABEL  = { pistol: 'P',    hammer: 'H',    sword: 'S'     };

function playerSprite() {
  const { state } = player;
  if (state === 'jump')   return imgs.boy2;
  if (state === 'block')  return imgs.boy4;
  if (state === 'punch')  return imgs.boy4;
  if (state === 'pistol') return imgs.boy3;
  if (state === 'hammer') return imgs.boy5;
  if (state === 'sword')  return imgs.boy6;
  return imgs.boy1;
}

// ─── Collections ─────────────────────────────────────────────────────────────
let enemies        = [];
let bullets        = [];
let pickups        = [];
let particles      = [];
let shootingStars  = [];

// ─── Spawn timing ─────────────────────────────────────────────────────────────
let enemySpawnTimer = 300;
let pickupSpawnDist = 800;

// Enemy config by type (1-3)
const ENEMY_CFG = [
  { hp: 2, speed: 0.7, damage: 0.25, scale: 1.0,  score: 10 },
  { hp: 4, speed: 0.5, damage: 0.25, scale: 1.15, score: 20 },
  { hp: 7, speed: 0.4, damage: 0.5,  scale: 1.35, score: 40 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function spawnParticles(x, y, color, n = 8) {
  for (let i = 0; i < n; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 4;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      life: 20 + Math.random() * 20 | 0,
      maxLife: 40,
      color,
      r: 3 + Math.random() * 4,
    });
  }
}

function spawnEnemy() {
  const difficulty = Math.min(3, 1 + Math.floor(worldDist / 2000));
  const type = Math.ceil(Math.random() * difficulty);
  const cfg = ENEMY_CFG[type - 1];
  enemies.push({
    type, x: cameraX + W + 80 + Math.random() * 120,
    y: GROUND, vx: cfg.speed,
    hp: cfg.hp, maxHp: cfg.hp,
    damage: cfg.damage, scale: cfg.scale, scoreVal: cfg.score,
    hitFlash: 0, dead: false, walkCycle: 0,
    shootTimer: 90 + Math.random() * 120 | 0, // staggered first shot
    attackAnim: 0,
  });
}

function spawnPickup() {
  const types = ['pistol', 'hammer', 'sword', 'heart'];
  const type = types[Math.floor(Math.random() * types.length)];
  // 40% on ground, 40% low float (jump required), 20% high float (full jump)
  const rng = Math.random();
  const floatH = rng < 0.4 ? 0 : rng < 0.8 ? 70 + Math.random() * 40 | 0 : 130 + Math.random() * 30 | 0;
  pickups.push({ x: cameraX + W + 60 + Math.random() * 200, y: GROUND - 36 - floatH, type });
  pickupSpawnDist = 600 + Math.random() * 600;
}

function doMeleeAttack() {
  const range  = WEAPON_RANGE[player.weapon];
  const damage = WEAPON_DAMAGE[player.weapon];
  for (const e of enemies) {
    if (e.dead) continue;
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    if (Math.abs(dx) < range && Math.sign(dx) === player.facing && Math.abs(dy) < 70) {
      damageEnemy(e, damage);
    }
  }
}

function damageEnemy(e, dmg) {
  e.hp -= dmg;
  e.hitFlash = 10;
  score += dmg * 2; // points per hit
  playSound('enemy_hit');
  spawnParticles(e.x, e.y - SPR * 0.5 * e.scale, '#f84', 6);
  if (e.hp <= 0) {
    e.dead = true;
    score += e.scoreVal;
    spawnParticles(e.x, e.y - SPR * 0.6 * e.scale, '#f50', 14);
    if (Math.random() < 0.30) {
      pickups.push({ x: e.x, y: GROUND - 36, type: 'heart' }); // ground-level drop
    }
  }
}

function triggerAttack() {
  if (player.attackCooldown > 0) return;
  player.attackCooldown = WEAPON_COOL[player.weapon];

  if (player.weapon === 'pistol') {
    player.state = 'pistol';
    player.attackTimer = 18;
    bullets.push({
      x: player.x + player.facing * 48,
      y: player.y - SPR * 0.58,
      vx: player.facing * 13,
      life: 55, damage: 1,
    });
    playSound('laser');
  } else {
    const stateMap = { none: 'punch', hammer: 'hammer', sword: 'sword' };
    player.state = stateMap[player.weapon] || 'punch';
    player.attackTimer = 37;
    doMeleeAttack();
    playSound(player.weapon === 'hammer' ? 'hammer' : player.weapon === 'sword' ? 'sword' : 'punch');
  }
}

// ─── Init / Reset ─────────────────────────────────────────────────────────────
function startGame() {
  phase = 'playing';
  playMusic('game');
  document.body.classList.add('game-on');
  score = 0; lives = 3; cameraX = 0; worldDist = 0; shakeFrames = 0;
  player = { ...PLAYER_DEFAULTS };
  enemies = []; bullets = []; pickups = []; particles = []; shootingStars = [];
  enemySpawnTimer = 160;
  pickupSpawnDist = 800;
}

// ─── Music ────────────────────────────────────────────────────────────────────
const _musicTracks = {
  title: Object.assign(new Audio('assets/music/title_loop.mp3'), { loop: true, volume: 0.5 }),
  game:  Object.assign(new Audio('assets/music/game_loop.mp3'),  { loop: true, volume: 0.45 }),
};
let _currentMusic = null;
let _currentAudio = null;

function playMusic(name) {
  if (_currentMusic === name) return;
  if (_currentAudio) { _currentAudio.pause(); _currentAudio.currentTime = 0; }
  _currentMusic = name;
  _currentAudio = _musicTracks[name] ?? null;
  if (_currentAudio) _currentAudio.play().catch(() => {});
}

function pauseMusic()  { if (_currentAudio) _currentAudio.pause(); }
function resumeMusic() { if (_currentAudio) _currentAudio.play().catch(() => {}); }

// ─── Audio (Web Audio API — lazy-init on first user gesture) ─────────────────
let _ac = null;
function getAC() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  if (_ac.state === 'suspended') _ac.resume();
  return _ac;
}

function playSound(type) {
  try {
    const a = getAC();
    const t = a.currentTime;
    const g = a.createGain();
    g.connect(a.destination);

    switch (type) {
      case 'punch': {
        const buf = a.createBuffer(1, a.sampleRate * 0.08, a.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random()*2-1) * (1 - i/d.length);
        const s = a.createBufferSource(); s.buffer = buf;
        g.gain.setValueAtTime(0.35, t); s.connect(g); s.start(t);
        break;
      }
      case 'sword': {
        const buf = a.createBuffer(1, a.sampleRate * 0.18, a.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random()*2-1) * Math.sin(Math.PI * i/d.length);
        const s = a.createBufferSource(); s.buffer = buf;
        const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1200;
        g.gain.setValueAtTime(0.4, t); s.connect(f); f.connect(g); s.start(t);
        break;
      }
      case 'hammer': {
        const o = a.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(120, t);
        o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        o.connect(g); o.start(t); o.stop(t + 0.25);
        break;
      }
      case 'laser': {
        const o = a.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(900, t);
        o.frequency.exponentialRampToValueAtTime(180, t + 0.18);
        g.gain.setValueAtTime(0.2, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.connect(g); o.start(t); o.stop(t + 0.18);
        break;
      }
      case 'enemy_hit': {
        const o = a.createOscillator(); o.type = 'square';
        o.frequency.setValueAtTime(350, t);
        o.frequency.exponentialRampToValueAtTime(120, t + 0.07);
        g.gain.setValueAtTime(0.2, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        o.connect(g); o.start(t); o.stop(t + 0.07);
        break;
      }
      case 'player_hit': {
        const o = a.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(200, t);
        o.frequency.exponentialRampToValueAtTime(60, t + 0.22);
        g.gain.setValueAtTime(0.45, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        o.connect(g); o.start(t); o.stop(t + 0.22);
        break;
      }
    }
  } catch(_) {}
}

function togglePause() {
  if (phase === 'playing') { phase = 'paused';  pauseMusic();  }
  else                     { phase = 'playing'; resumeMusic(); }
}

// ─── Input: Keyboard ──────────────────────────────────────────────────────────
const keys = {};
document.addEventListener('keydown', e => {
  if (phase === 'title') playMusic('title');
  if (keys[e.code]) return;
  keys[e.code] = true;
  if (phase === 'title'    && (e.code === 'Space' || e.code === 'Enter')) { startGame(); return; }
  if (phase === 'gameover' && (e.code === 'Space' || e.code === 'Enter')) { startGame(); return; }
  if ((phase === 'playing' || phase === 'paused') && e.code === 'Escape') { togglePause(); return; }
  if (phase === 'playing'  && (e.code === 'KeyF'  || e.code === 'KeyZ'))  triggerAttack();
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

// ─── Input: Gamepad ───────────────────────────────────────────────────────────
// Standard mapping: 0=Cross/X  1=Circle  2=Square  3=Triangle  (PS4/PS5)
//                   0=A        1=B       2=X        3=Y         (Xbox)
//                   9=Options/Start  12=DUp  13=DDown  14=DLeft  15=DRight
// PS5:  Cross(0)=Block  Circle(1)=Jump  Square(2)=Attack
let padIndex = -1;
const pad = { left: false, right: false, jump: false, block: false };
const padEdge = { attack: false, start: false };
let _padPrevAttack = false, _padPrevStart = false;

window.addEventListener('gamepadconnected',    e => { padIndex = e.gamepad.index; });
window.addEventListener('gamepaddisconnected', e => { if (e.gamepad.index === padIndex) padIndex = -1; });

function pollGamepad() {
  if (padIndex < 0) return;
  const gp = navigator.getGamepads()[padIndex];
  if (!gp) return;

  const DEAD = 0.25;
  const ax  = gp.axes[0] ?? 0;
  const btn = i => gp.buttons[i]?.pressed ?? false;

  pad.left  = ax < -DEAD || btn(14);
  pad.right = ax >  DEAD || btn(15);
  pad.jump  = btn(1) || btn(12);  // Circle or D-pad Up
  pad.block = btn(0);              // Cross/X (held)

  const attackNow = btn(2) || btn(5); // Square or RB
  const startNow  = btn(9) || btn(8); // Options/Start or Select

  padEdge.attack = attackNow && !_padPrevAttack;
  padEdge.start  = startNow  && !_padPrevStart;
  _padPrevAttack = attackNow;
  _padPrevStart  = startNow;
}

// ─── Input: Touch ─────────────────────────────────────────────────────────────
const touch = { left: false, right: false, jump: false, block: false };

function bindTouchBtn(id, onDown, onUp) {
  const el = document.getElementById(id);
  if (!el) return;
  const down = e => { e.preventDefault(); el.classList.add('active');    onDown(); };
  const up   = e => { e.preventDefault(); el.classList.remove('active'); onUp();   };
  el.addEventListener('touchstart',  down, { passive: false });
  el.addEventListener('touchend',    up,   { passive: false });
  el.addEventListener('touchcancel', up,   { passive: false });
}

// Virtual joystick
let _joyId = null;
const _joyBase  = document.getElementById('joystick-base');
const _joyThumb = document.getElementById('joystick-thumb');

function _joyMove(clientX, clientY) {
  const r    = _joyBase.getBoundingClientRect();
  const cx   = r.left + r.width  / 2;
  const cy   = r.top  + r.height / 2;
  const maxR = r.width / 2 - _joyThumb.offsetWidth / 2;
  let dx = clientX - cx, dy = clientY - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > maxR) { dx = dx / dist * maxR; dy = dy / dist * maxR; }
  _joyThumb.style.transform = `translate(${dx}px, ${dy}px)`;
  const thr = maxR * 0.25;
  touch.left  = dx < -thr;
  touch.right = dx >  thr;
}

function _joyReset() {
  _joyThumb.style.transform = '';
  touch.left = touch.right = false;
}

if (_joyBase) {
  _joyBase.addEventListener('touchstart', e => {
    e.preventDefault();
    if (_joyId !== null) return;
    const t = e.changedTouches[0];
    _joyId = t.identifier;
    _joyMove(t.clientX, t.clientY);
  }, { passive: false });
}

document.addEventListener('touchmove', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === _joyId) { e.preventDefault(); _joyMove(t.clientX, t.clientY); return; }
  }
}, { passive: false });

document.addEventListener('touchend', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === _joyId) { _joyId = null; _joyReset(); return; }
  }
}, { passive: false });

document.addEventListener('touchcancel', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === _joyId) { _joyId = null; _joyReset(); return; }
  }
}, { passive: false });

bindTouchBtn('btn-jump',   () => { touch.jump  = true; }, () => { touch.jump  = false; });
bindTouchBtn('btn-block',  () => { touch.block = true; }, () => { touch.block = false; });
bindTouchBtn('btn-attack', () => { triggerAttack();     }, () => {});
bindTouchBtn('btn-pause',  () => { if (phase === 'playing' || phase === 'paused') togglePause(); }, () => {});

// Tap canvas background to start from title / game-over
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (phase === 'title')         { playMusic('title'); startGame(); }
  else if (phase === 'gameover') startGame();
}, { passive: false });

function isLeft()  { return keys['ArrowLeft']  || keys['KeyA']  || pad.left  || touch.left;  }
function isRight() { return keys['ArrowRight'] || keys['KeyD']  || pad.right || touch.right; }
function isJump()  { return keys['ArrowUp'] || keys['KeyW'] || keys['Space'] || pad.jump || touch.jump; }
function isBlock() { return (keys['ShiftLeft'] || keys['ShiftRight'] || pad.block || touch.block) && player.onGround && player.attackTimer <= 0; }

// ─── Update ───────────────────────────────────────────────────────────────────
function update() {
  pollGamepad();

  const anyPadInput = pad.left || pad.right || pad.jump || pad.block || padEdge.attack || padEdge.start;
  if (phase === 'title' && anyPadInput) playMusic('title');

  if (padEdge.start) {
    if (phase === 'title' || phase === 'gameover') { startGame(); return; }
    if (phase === 'playing' || phase === 'paused') { togglePause(); return; }
  }
  if (padEdge.attack && (phase === 'title' || phase === 'gameover')) { startGame(); return; }

  // Shooting stars (always update so they finish even on pause transition)
  for (const s of shootingStars) { s.x += s.vx; s.y += s.vy; s.life--; }
  shootingStars = shootingStars.filter(s => s.life > 0);

  if (phase !== 'playing') return;
  if (shakeFrames > 0) shakeFrames--;

  // Spawn occasional shooting stars
  if (Math.random() < 0.005) {
    shootingStars.push({
      x: Math.random() * W, y: Math.random() * H * 0.45,
      vx: -(3 + Math.random() * 5), vy: 0.5 + Math.random() * 1.5,
      life: 30 + Math.random() * 35 | 0, maxLife: 55,
    });
  }

  if (padEdge.attack) triggerAttack();

  // Horizontal movement
  const moving = isLeft() || isRight();
  if (isLeft())       { player.vx = -WALK_SPEED; player.facing = -1; }
  else if (isRight()) { player.vx =  WALK_SPEED; player.facing =  1; }
  else                  player.vx = 0;

  if (isJump() && player.onGround) {
    player.vy = JUMP_FORCE;
    player.onGround = false;
  }

  // Physics — apply stronger gravity on the way down for a weighted arc
  const gravScale = (!player.onGround && player.vy > 0) ? FALL_MULTIPLIER : 1;
  player.vy += GRAVITY * gravScale;
  player.x  += player.vx;
  player.y  += player.vy;

  if (player.y >= GROUND) { player.y = GROUND; player.vy = 0; player.onGround = true; }

  // Hard world left wall
  if (player.x < 60) player.x = 60;

  // Camera right scroll: keep player at 80% of screen when moving right
  const scrollEdge = cameraX + W * 0.70;
  if (player.x > scrollEdge) {
    const delta = player.x - scrollEdge;
    cameraX   += delta;
    player.x   = scrollEdge;
    worldDist += delta;
    pickupSpawnDist -= delta;
    if (pickupSpawnDist <= 0) spawnPickup();
  }

  // Camera left scroll: keep player at 20% of screen when moving left
  const leftScrollEdge = cameraX + W * 0.20;
  if (player.x < leftScrollEdge && cameraX > 0) {
    const scrollAmt = Math.min(leftScrollEdge - player.x, cameraX);
    cameraX  -= scrollAmt;
    player.x += scrollAmt;
  }

  // Player state machine
  if (player.attackTimer > 0) {
    player.attackTimer--;
    if (player.attackTimer <= 0) player.state = 'idle';
  }
  if (player.attackTimer <= 0) {
    if (!player.onGround)       player.state = 'jump';
    else if (isBlock())         { player.state = 'block'; player.blocking = true; }
    else if (moving)            { player.state = 'walk'; player.walkCycle += 0.065; }
    else                          player.state = 'idle';
    if (player.state !== 'block') player.blocking = false;
  }
  if (player.attackCooldown > 0) player.attackCooldown--;
  if (player.invincible > 0)     player.invincible--;
  player.animFrame = calcAnimFrame(player);

  const SPAWN_ENEMIES = true;
  if (SPAWN_ENEMIES && --enemySpawnTimer <= 0) {
    spawnEnemy();
    const baseInterval = Math.max(200, 500 - Math.floor(worldDist / 500));
    enemySpawnTimer = baseInterval + Math.random() * 120 | 0;
  }

  // Update enemies
  for (const e of enemies) {
    if (e.dead) continue;
    const dx = player.x - e.x;
    if (e.attackAnim > 0) {
      // Stand still, cycle alien_01 frames, fire red projectile at midpoint
      e.attackAnim--;
      e.walkCycle += 0.065;
      if (e.attackAnim === 30 && (e.x - cameraX) >= -30 && (e.x - cameraX) <= W + 30) {
        const bx0 = e.x + (Math.sign(player.x - e.x) || 1) * 30;
        const by0 = e.y - SPR * e.scale * 0.55;
        const tdx = player.x - bx0;
        const tdy = (player.y - SPR * 0.5) - by0;
        const t   = Math.max(40, Math.min(90, Math.abs(tdx) / 6)) | 0;
        const bvx = tdx / t;
        const bvy = (tdy - 0.5 * GRAVITY * t * t) / t; // aim for player torso
        bullets.push({ x: bx0, y: by0, vx: bvx, vy: bvy, life: t + 20, damage: e.damage, isEnemy: true });
        playSound('laser');
      }
    } else {
      e.shootTimer--;
      if (e.shootTimer <= 0) {
        e.attackAnim = 60;
        e.shootTimer = 120;
      } else {
        e.walkCycle += 0.065;
        if (Math.abs(dx) > 55) e.x += Math.sign(dx) * e.vx;
      }
    }
    if (e.hitFlash > 0) e.hitFlash--;
  }

  // Bullets
  for (const b of bullets) {
    b.x += b.vx;
    if (b.vy !== undefined) { b.vy += GRAVITY; b.y += b.vy; }
    b.life--;
    if (b.isEnemy) {
      if (player.invincible <= 0 && Math.abs(b.x - player.x) < 35 && Math.abs(b.y - (player.y - SPR * 0.5)) < SPR * 0.55) {
        const dmgMult = player.blocking ? 0.25 : 1;
        player.hp -= b.damage * dmgMult;
        player.invincible = 70;
        shakeFrames = 12;
        b.life = 0;
        playSound('player_hit');
        if (player.hp <= 0) {
          lives--;
          if (lives <= 0) { phase = 'gameover'; playMusic(null); document.body.classList.remove('game-on'); return; }
          player = { ...PLAYER_DEFAULTS, x: cameraX + 120, y: GROUND, invincible: 150 };
          return;
        }
      }
    } else {
      for (const e of enemies) {
        if (e.dead) continue;
        const eSize = SPR * e.scale;
        if (Math.abs(b.x - e.x) < eSize * 0.45 && Math.abs(b.y - (e.y - eSize * 0.5)) < eSize * 0.5) {
          damageEnemy(e, b.damage);
          b.life = 0;
          break;
        }
      }
    }
  }
  bullets = bullets.filter(b => b.life > 0);

  // Pickups — walk over to grab
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    if (Math.abs(player.x - p.x) < 55 && Math.abs((player.y - 60) - p.y) < 55) {
      if (p.type === 'heart') {
        player.hp = Math.min(player.maxHp, player.hp + 3);
        spawnParticles(p.x, p.y - 40, '#f55', 10);
      } else {
        player.weapon = p.type;
        spawnParticles(p.x, p.y - 40, WEAPON_COLOR[p.type], 10);
      }
      pickups.splice(i, 1);
    }
  }

  // Particles
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy;
    p.vy += 0.18; p.life--;
  }
  particles = particles.filter(p => p.life > 0);

  // Prune enemies
  enemies = enemies.filter(e => !e.dead && e.x > cameraX - 300);
}

// ─── Sprite-sheet helpers ─────────────────────────────────────────────────────
// Frames are in a 2×2 grid: 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right
function drawSpriteFrame(img, frameIdx, dx, dy, dw, dh) {
  const col = frameIdx % 2;
  const row = Math.floor(frameIdx / 2);
  ctx.drawImage(img, col * FRAME_SRC, row * FRAME_SRC, FRAME_SRC, FRAME_SRC, dx, dy, dw, dh);
}

function calcAnimFrame(p) {
  if (p.state === 'block') return 3; // bottom-right frame of boy_04
  if (p.state === 'jump') {
    // Cycle all 4 boy_02 frames across the arc using vy thresholds
    if (p.vy < -5)   return 0; // burst off ground (takeoff)
    if (p.vy < -0.5) return 1; // rising
    if (p.vy <=  1)  return 2; // apex / flip
    return 3;                   // descending
  }
  if (p.attackTimer > 0) {
    // Spreads 4 frames evenly across the full attack window.
    // ATTACK_ANIM_DURATION must match attackTimer in triggerAttack().
    // Raise ATTACK_ANIM_DURATION or lower the divisor (9) to slow the frames down.
    const ATTACK_ANIM_DURATION = 37;
    const elapsed = ATTACK_ANIM_DURATION - p.attackTimer;
    return Math.min(3, Math.floor(elapsed / 9));
  }
  if (p.state === 'walk') return Math.floor(p.walkCycle) % 4;
  return 0; // idle
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────
function drawBg() {
  const layers = [imgs.bg4, imgs.bg3, imgs.bg2, imgs.bg1];
  for (let i = 0; i < 4; i++) {
    const speed  = PARALLAX_SPEEDS[i];
    const offset = -(cameraX * speed) % BG_W;
    for (let t = -1; t <= 2; t++) {
      ctx.drawImage(layers[i], Math.round(offset + t * BG_W), 0, BG_W, H);
    }
    if (i === 0 && shootingStars.length > 0) {
      ctx.save();
      for (const s of shootingStars) {
        const alpha = s.life / s.maxLife;
        const trailLen = 18 + (1 - alpha) * 30;
        const nx = s.vx / Math.hypot(s.vx, s.vy);
        const ny = s.vy / Math.hypot(s.vx, s.vy);
        const grad = ctx.createLinearGradient(s.x - nx * trailLen, s.y - ny * trailLen, s.x, s.y);
        grad.addColorStop(0, 'rgba(255,255,220,0)');
        grad.addColorStop(1, `rgba(255,255,220,${alpha * 0.85})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(s.x - nx * trailLen, s.y - ny * trailLen);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

// charY is the character's current feet y; shadow is pinned to groundY and scales with height
function drawShadow(x, groundY, charY, w) {
  const height = Math.max(0, groundY - charY);
  const scale  = 1 - Math.min(0.7, height / 160);
  ctx.save();
  ctx.globalAlpha = 0.22 * scale;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(x - 14, groundY - FOOT_INSET, w * 0.28 * scale, 3.5 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer() {
  const sx  = player.x - cameraX;
  const spr = playerSprite();
  const bob = player.state === 'walk' ? Math.sin(player.walkCycle * 2) * 3 : 0;

  drawShadow(sx, GROUND, player.y, SPR);

  ctx.save();
  if (player.facing === -1) { ctx.translate(sx * 2, 0); ctx.scale(-1, 1); }
  if (player.invincible > 0 && Math.floor(player.invincible / 5) % 2 === 0) ctx.globalAlpha = 0.35;
  drawSpriteFrame(spr, player.animFrame, sx - SPR / 2, player.y - SPR + bob, SPR, SPR);
  ctx.restore();
}

function drawEnemies() {
  for (const e of enemies) {
    const sx = e.x - cameraX;
    if (sx < -200 || sx > W + 200) continue;
    const eSPR        = SPR * e.scale;
    const eImg        = e.attackAnim > 0 ? imgs.alien1 : imgs.alien3;
    const facingRight = player.x >= e.x;
    const bob        = Math.sin(e.walkCycle * 2) * 2;

    drawShadow(sx, GROUND, e.y, eSPR);

    ctx.save();
    if (facingRight)  { ctx.translate(sx * 2, 0); ctx.scale(-1, 1); }
    if (e.hitFlash > 0) ctx.filter = 'brightness(4) saturate(0)';
    const eFrame = Math.floor(e.walkCycle) % 4;
    drawSpriteFrame(eImg, eFrame, sx - eSPR / 2, e.y - eSPR + bob, eSPR, eSPR);
    ctx.restore();

    const bw = eSPR * 0.75;
    const bx = sx - bw / 2, by = e.y - eSPR - 10;
    ctx.fillStyle = '#300'; ctx.fillRect(bx, by, bw, 5);
    ctx.fillStyle = '#e33'; ctx.fillRect(bx, by, bw * (e.hp / e.maxHp), 5);
  }
}

function drawBullets() {
  ctx.save();
  for (const b of bullets) {
    const sx = b.x - cameraX;
    ctx.shadowColor = b.isEnemy ? '#f44' : '#4ff';
    ctx.shadowBlur = 10;
    ctx.fillStyle  = b.isEnemy ? '#f88' : '#8ff';
    ctx.beginPath();
    ctx.ellipse(sx, b.y, 9, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPickups() {
  const t = Date.now() / 600;
  for (const p of pickups) {
    const sx = p.x - cameraX;
    if (sx < -60 || sx > W + 60) continue;
    const floatY = p.y + Math.sin(t + p.x) * 7;

    // Dashed guide line for airborne pickups
    if (p.y < GROUND - 60) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.setLineDash([3, 6]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, floatY + 14);
      ctx.lineTo(sx, GROUND - FOOT_INSET);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    if (p.type === 'heart') {
      ctx.fillStyle = '#f33';
      ctx.shadowColor = '#f55'; ctx.shadowBlur = 14;
      ctx.font = 'bold 26px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('❤', sx, floatY);
    } else {
      const col = WEAPON_COLOR[p.type];
      ctx.shadowColor = col; ctx.shadowBlur = 16;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sx, floatY, 13, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(WEAPON_LABEL[p.type], sx, floatY + 4);
    }
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of particles) {
    const sx = p.x - cameraX;
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(sx, p.y, p.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawHUD() {
  // HP bar (top-left)
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(8, 8, 126, 18);
  ctx.fillStyle = player.hp > 2 ? '#e33' : '#f80';
  ctx.fillRect(10, 10, 122 * Math.max(0, player.hp / player.maxHp), 14);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(10, 10, 122, 14);
  ctx.fillStyle = '#fff';
  ctx.font = '10px monospace';
  ctx.fillText('HP', 14, 21);

  // Score (top-right)
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(W - 140, 8, 132, 22);
  ctx.fillStyle = '#ffd';
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${score} pts`, W - 12, 24);
  ctx.textAlign = 'left';

  // Lives — mini player sprites to the right of the HP bar
  const lifeSize = 18;
  for (let i = 0; i < 3; i++) {
    ctx.save();
    ctx.globalAlpha = i < lives ? 1 : 0.18;
    drawSpriteFrame(imgs.boy1, 0, 142 + i * (lifeSize + 2), 8, lifeSize, lifeSize);
    ctx.restore();
  }

  // Controller connected indicator
  if (padIndex >= 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(W / 2 - 46, 8, 92, 18);
    ctx.fillStyle = '#4f8';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('● CONTROLLER', W / 2, 21);
    ctx.textAlign = 'left';
  }

  // Weapon indicator
  if (player.weapon !== 'none') {
    const col = WEAPON_COLOR[player.weapon];
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, 34, 100, 20);
    ctx.fillStyle = col;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(`[${player.weapon.toUpperCase()}]`, 12, 49);
  }
}

function drawTitle() {
  ctx.drawImage(imgs.title, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.52)';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(imgs.title, 0, 0, W, H * 0.6);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, W, H * 0.6);

  ctx.textAlign = 'center';
  ctx.shadowColor = '#f44'; ctx.shadowBlur = 20;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px monospace';
  ctx.fillText('FRIENDS SLAY THE ALIENS', W / 2, H * 0.62);
  ctx.shadowBlur = 0;

  ctx.font = '17px monospace';
  ctx.fillStyle = '#aff';
  ctx.fillText('Press  SPACE  or  ENTER  to Start', W / 2, H * 0.74);

  ctx.font = '12px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('Arrow Keys / WASD: Move  ·  Space / W: Jump  ·  F / Z: Attack', W / 2, H * 0.85);
  ctx.fillText('Walk over glowing orbs to pick up weapons', W / 2, H * 0.91);
  ctx.textAlign = 'left';
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.shadowColor = '#f33'; ctx.shadowBlur = 30;
  ctx.fillStyle = '#f55';
  ctx.font = 'bold 52px monospace';
  ctx.fillText('GAME OVER', W / 2, H / 2 - 50);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#ffd';
  ctx.font = '26px monospace';
  ctx.fillText(`Score: ${score}`, W / 2, H / 2 + 10);

  ctx.font = '16px monospace';
  ctx.fillStyle = '#8df';
  ctx.fillText('Press  SPACE  or  ENTER  to Retry', W / 2, H / 2 + 60);
  ctx.textAlign = 'left';
}

function drawPause() {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.shadowColor = '#fff'; ctx.shadowBlur = 12;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 52px monospace';
  ctx.fillText('PAUSED', W / 2, H / 2 - 20);
  ctx.shadowBlur = 0;
  ctx.font = '16px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('ESC  or  Start  to resume', W / 2, H / 2 + 30);
  ctx.textAlign = 'left';
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function draw() {
  ctx.save();
  if (shakeFrames > 0) {
    ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6);
  }

  ctx.clearRect(-10, -10, W + 20, H + 20);

  if (phase === 'title') {
    drawTitle();
  } else {
    drawBg();
    drawPickups();
    drawParticles();
    drawBullets();
    drawEnemies();
    drawPlayer();
    drawHUD();
    if (phase === 'gameover') drawGameOver();
    if (phase === 'paused')   drawPause();
  }

  ctx.restore();
}

// Fixed timestep: always simulate at 60 ticks/s regardless of display frame rate.
// At 30 fps each rendered frame runs 2 update() ticks; at 60 fps it runs 1.
const TIMESTEP = 1000 / 60;
let _lastTime = 0;
let _accum    = 0;

function loop(ts = 0) {
  const dt = Math.min(ts - _lastTime, 100); // cap prevents spiral-of-death after tab sleep
  _lastTime = ts;
  _accum   += dt;
  while (_accum >= TIMESTEP) { update(); _accum -= TIMESTEP; }
  draw();
  requestAnimationFrame(loop);
}

loadAssets(() => requestAnimationFrame(loop));
