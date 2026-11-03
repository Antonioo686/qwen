'use strict';

/* =========================================================
   КОСМИЧЕСКИЙ УКЛОНИСТ — игровая логика (Canvas API)
   Структура:
   1. Инициализация Yandex SDK
   2. Функции рекламы
   3. Игровые переменные и состояние
   4. Сохранение/загрузка данных (localStorage)
   5. Управление экранами
   6. Логика магазина скинов
   7. Система зон
   8. Обработчики управления (мышь/тач)
   9. Отрисовка (корабль, астероиды, звёзды, частицы)
   10. Игровой цикл (update + render)
   ========================================================= */

// ---------- 1. Инициализация Yandex SDK ----------
let ysdk = null;      // объект SDK (null если не загрузился — игра работает без рекламы)
let sdkInitFailed = false; // true, если YaGames.init() упал (локальный запуск вне iframe Яндекса)

try {
    if (typeof YaGames !== 'undefined') {
        YaGames.init().then(sdk => {
            ysdk = sdk;
            // Инициализация игрока (опционально, без скоупов)
            try { sdk.getPlayer({ scopes: false }); } catch (e) { /* ignore */ }
            // Показ sticky-баннера внизу экрана
            showStickyBanner();
        }).catch(() => {
            // SDK недоступен (например, локальная проверка) — играем без рекламы
            sdkInitFailed = true;
        });
    } else {
        sdkInitFailed = true; // скрипт SDK не загрузился
    }
} catch (e) {
    sdkInitFailed = true; // guard against missing SDK script
}

// ---------- 2. Функции рекламы ----------

/** Sticky баннер (показывается при старте игры) */
function showStickyBanner() {
    try {
        if (ysdk && ysdk.adv && ysdk.adv.showBannerAdv) {
            ysdk.adv.showBannerAdv({
                onShow: () => {},
                onHide: () => {},
                onError: () => {}
            });
        }
    } catch (e) { /* ignore */ }
}

/** Interstitial — показывается после Game Over */
function showInterstitialAd(onDone) {
    const finish = () => { if (onDone) onDone(); };
    try {
        if (ysdk && ysdk.adv && ysdk.adv.showFullscreenAdv) {
            let handled = false;
            const once = () => { if (!handled) { handled = true; finish(); } };
            ysdk.adv.showFullscreenAdv({
                callbacks: {
                    onClose: once,
                    onError: once,
                    onOpen: () => {}
                }
            });
            // Страховка: если коллбэки не сработали (некорректное окружение)
            setTimeout(once, 5000);
        } else {
            finish();
        }
    } catch (e) {
        finish();
    }
}

/** Rewarded video — удвоение очков и монет */
function showRewardedAd(onRewarded) {
    const btn = document.getElementById('btnDouble');
    btn.disabled = true;
    btn.textContent = '⏳ Реклама...';

    let rewardedFired = false;
    const restoreBtn = () => {
        btn.disabled = false;
        btn.textContent = '📺 x2 ОЧКИ (реклама)';
    };
    const grantReward = () => {
        if (!rewardedFired) {
            rewardedFired = true;
            if (onRewarded) onRewarded();
        }
        restoreBtn();
    };

    try {
        if (ysdk && ysdk.adv && ysdk.adv.showRewardedVideo) {
            let closed = false;
            const adv = ysdk.adv;
            // Проверка доступности вознаграждаемой рекламы (если есть такой метод)
            let available = true;
            try {
                if (typeof adv.isRewardedAvailable === 'function') {
                    available = !!adv.isRewardedAvailable();
                }
            } catch (e) { /* ignore */ }

            if (!available) {
                // Реклама недоступна в текущем окружении — симулируем награду,
                // чтобы игрок не терял возможность удвоения
                setTimeout(grantReward, 300);
                return;
            }

            ysdk.adv.showRewardedVideo({
                callbacks: {
                    onOpen: () => {},
                    onRewarded: () => { closed = true; grantReward(); },
                    onClose: () => { closed = true; if (!rewardedFired) restoreBtn(); },
                    onError: () => {
                        closed = true;
                        // Ошибка SDK (например, битое вне-iframe окружение при локальной
                        // проверке) — выдаём награду, на проде Яндекс сам не покажет
                        // reward без onRewarded
                        grantReward();
                    }
                }
            });
            // Страховка на случай, если SDK «завис» без коллбэков (битое окружение)
            setTimeout(() => {
                if (!closed && !rewardedFired) restoreBtn();
            }, 8000);
        } else if (sdkInitFailed || typeof YaGames === 'undefined') {
            // SDK реально недоступен (локальный запуск / скрипт не загрузился) —
            // симулируем просмотр вознаграждаемой рекламы
            setTimeout(grantReward, 300);
        } else {
            // init ещё не завершился — подождём немного и повторим попытку
            setTimeout(() => showRewardedAd(onRewarded), 1000);
        }
    } catch (e) {
        restoreBtn();
    }
}

// ---------- 3. Игровые переменные и состояние ----------

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

let W = 0, H = 0;               // размеры холста
let dpr = Math.min(window.devicePixelRatio || 1, 2);

// Состояние приложения: 'menu' | 'playing' | 'gameover'
let state = 'menu';

// Игровые параметры
const SHIP_W = 44;              // ширина корабля
const SHIP_H = 52;              // высота корабля

let ship = { x: 0, y: 0, targetX: 0 };   // корабль
let asteroids = [];                        // падающие астероиды
let particles = [];                        // частицы взрыва
let stars = [];                            // звёзды фона

let score = 0;               // текущий счёт
let earnedCoins = 0;         // заработанные монеты за эту игру
let frameCount = 0;          // счётчик кадров
let astSpeed = 3;            // текущая скорость астероидов (px/кадр)
let spawnInterval = 60;      // текущий интервал спавна (кадров)
let lastSpawnFrame = 0;      // последний кадр спавна
let doubled = false;         // применялось ли уже удвоение очков

let rafId = null;            // requestAnimationFrame id
let zoneFade = 0;            // коэффициент плавного перехода фона (0..1)
let prevZoneIndex = 0;       // предыдущая зона для fade

// ---------- 4. Сохранение/загрузка данных (localStorage) ----------

const LS_KEYS = {
    best: 'ku_bestScore',
    coins: 'ku_coins',
    owned: 'ku_ownedSkins',
    selected: 'ku_selectedSkin'
};

function loadData(key, def) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
}

function saveData(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

let bestScore = loadData(LS_KEYS.best, 0);
let coins = loadData(LS_KEYS.coins, 0);
let ownedSkins = loadData(LS_KEYS.owned, ['standard']);
let selectedSkin = loadData(LS_KEYS.selected, 'standard');

// ---------- Скины корабля ----------

const SKINS = [
    { id: 'standard', name: 'Стандартный', price: 0,    colors: ['#4facfe', '#2f6db3'], flame: 1.0, glow: 0, shine: false },
    { id: 'fire',     name: 'Огненный',    price: 500,  colors: ['#ff9a3c', '#ff3b3b'], flame: 1.6, glow: 12, shine: false },
    { id: 'gold',     name: 'Золотой',     price: 1000, colors: ['#ffd700', '#c78a00'], flame: 1.0, glow: 10, shine: true },
    { id: 'neon',     name: 'Неоновый',    price: 1500, colors: ['#ff4fd8', '#7b2ff7'], flame: 1.2, glow: 22, shine: false },
    { id: 'ice',      name: 'Ледяной',     price: 2000, colors: ['#aef3ff', '#ffffff'], flame: 1.1, glow: 14, shine: true },
    { id: 'rainbow',  name: 'Радужный',    price: 3000, colors: ['rainbow', 'rainbow'], flame: 1.4, glow: 18, shine: true }
];

function getSkinById(id) {
    for (const s of SKINS) if (s.id === id) return s;
    return SKINS[0];
}

// ---------- Зоны (фоны), меняются каждые 500 очков ----------

const ZONES = [
    { from: 0,    name: 'Начало пути',             bgTop: '#0a0a2e', bgBot: '#1a1a4e', starColor: '#ffffff', starSize: 1.6, starCount: 90 },
    { from: 500,  name: 'Туманность Ориона',       bgTop: '#2e0a3e', bgBot: '#4e1a6e', starColor: '#ff9de2', starSize: 2.4, starCount: 100 },
    { from: 1000, name: 'Окрестности Бетельгейзе', bgTop: '#3e0a0a', bgBot: '#6e1a1a', starColor: '#ffb347', starSize: 3.2, starCount: 80 },
    { from: 1500, name: 'Горизонт событий',        bgTop: '#000000', bgBot: '#1a1a1a', starColor: '#ffffff', starSize: 1.0, starCount: 150 },
    { from: 2000, name: 'Центр Галактики',         bgTop: '#3e2e0a', bgBot: '#6e4e1a', starColor: '#ffd700', starSize: 2.2, starCount: 110 }
];

function getZoneIndex(scoreVal) {
    let idx = 0;
    for (let i = 0; i < ZONES.length; i++) {
        if (scoreVal >= ZONES[i].from) idx = i;
    }
    return idx;
}

function currentZone() { return ZONES[getZoneIndex(score)]; }

// Смешивание двух цветов hex с коэффициентом t (для fade-перехода)
function lerpColor(a, b, t) {
    const pa = hexToRgb(a), pb = hexToRgb(b);
    const r = Math.round(pa.r + (pb.r - pa.r) * t);
    const g = Math.round(pa.g + (pb.g - pa.g) * t);
    const bl = Math.round(pa.b + (pb.b - pa.b) * t);
    return `rgb(${r},${g},${bl})`;
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return {
        r: parseInt(h.substring(0, 2), 16),
        g: parseInt(h.substring(2, 4), 16),
        b: parseInt(h.substring(4, 6), 16)
    };
}

// ---------- Настройка размеров холста ----------

function resizeCanvas() {
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Корректируем позицию корабля после ресайза
    ship.y = H - SHIP_H - 30;
    if (ship.x === 0) ship.x = W / 2;
    ship.x = Math.max(SHIP_W / 2, Math.min(W - SHIP_W / 2, ship.x));
    ship.targetX = ship.x;
}

window.addEventListener('resize', resizeCanvas);

// ---------- Звёзды (параллакс) ----------

function makeStar(layer) {
    const z = currentZone();
    return {
        x: Math.random() * W,
        y: Math.random() * H,
        size: z.starSize * (0.5 + Math.random() * 0.9) * layer,
        speed: (0.4 + Math.random() * 0.8) * layer, // параллакс: разные слои — разная скорость
        twinkle: Math.random() * Math.PI * 2
    };
}

function regenerateStars() {
    stars = [];
    const count = currentZone().starCount;
    for (let i = 0; i < count; i++) {
        const layer = 0.6 + Math.random() * 0.8;
        stars.push(makeStar(layer));
    }
}

function updateStars() {
    const zi = getZoneIndex(score);
    for (const s of stars) {
        s.y += s.speed; // звёзды движутся вниз (корабль летит вверх)
        s.twinkle += 0.05;
        if (s.y > H + 5) {
            s.y = -5;
            s.x = Math.random() * W;
            s.size = ZONES[zi].starSize * (0.5 + Math.random() * 0.9);
            s.zone = zi; // цвет новой звезды — текущей зоны
        }
    }
}

function drawStars() {
    for (const s of stars) {
        const alpha = 0.4 + 0.6 * Math.abs(Math.sin(s.twinkle));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = ZONES[s.zone !== undefined ? s.zone : 0].starColor;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ---------- Астероиды ----------

function spawnAsteroid() {
    const size = 20 + Math.random() * 40; // диаметр 20..60 px
    const hue = Math.floor(Math.random() * 360);
    const r = size / 2;
    const x = r + Math.random() * (W - size);
    // Неправильная форма: 8 вершин со случайными радиусами
    const verts = [];
    for (let i = 0; i < 8; i++) {
        verts.push(r * (0.65 + Math.random() * 0.45));
    }
    asteroids.push({
        x: x,
        y: -size,
        r: r,
        verts: verts,
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.08,
        color: `hsl(${hue}, 45%, 52%)`,
        darkColor: `hsl(${hue}, 45%, 34%)`
    });
}

function updateAsteroids() {
    for (let i = asteroids.length - 1; i >= 0; i--) {
        const a = asteroids[i];
        a.y += astSpeed;
        a.rot += a.rotSpeed;
        if (a.y - a.r > H) {
            // Астероид ушёл за нижний край — +10 очков
            asteroids.splice(i, 1);
            score += 10;
            checkZoneChange();
            updateHUD();
        }
    }
}

function drawAsteroid(a) {
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(a.rot);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const px = Math.cos(ang) * a.verts[i];
        const py = Math.sin(ang) * a.verts[i];
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = a.color;
    ctx.fill();
    ctx.strokeStyle = a.darkColor;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Небольшой кратер для объёма
    ctx.beginPath();
    ctx.arc(-a.r * 0.25, -a.r * 0.2, a.r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = a.darkColor;
    ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
}

// ---------- Столкновения (грубо AABB по ограничивающим прямоугольникам) ----------

function checkCollisions() {
    const sx = ship.x - SHIP_W / 2;
    const sy = ship.y - SHIP_H / 2;
    for (const a of asteroids) {
        const ax = a.x - a.r;
        const ay = a.y - a.r;
        const asz = a.r * 2;
        // AABB с небольшим уменьшением хитбоксов (прощаем края)
        const pad = 4;
        if (sx + pad < ax + asz - pad &&
            sx + SHIP_W - pad > ax + pad &&
            sy + pad < ay + asz - pad &&
            sy + SHIP_H - pad > ay + pad) {
            gameOver();
            return;
        }
    }
}

// ---------- Корабль ----------

function drawShip() {
    const skin = getSkinById(selectedSkin);
    const x = ship.x, y = ship.y;

    ctx.save();
    ctx.translate(x, y);

    // Огонь двигателя (анимированный треугольник снизу)
    const flick = Math.sin(frameCount * 0.4) * 4;
    const flameH = 18 * skin.flame + flick;
    const fg = ctx.createLinearGradient(0, SHIP_H / 2, 0, SHIP_H / 2 + flameH);
    fg.addColorStop(0, 'rgba(255,255,120,0.95)');
    fg.addColorStop(0.5, 'rgba(255,140,40,0.8)');
    fg.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-9, SHIP_H / 2 - 6);
    ctx.lineTo(9, SHIP_H / 2 - 6);
    ctx.lineTo(0, SHIP_H / 2 - 6 + flameH);
    ctx.closePath();
    ctx.fill();

    // Цвет корпуса: радужный скин переливается через HSL
    let c1 = skin.colors[0], c2 = skin.colors[1];
    if (skin.id === 'rainbow') {
        const hue = (frameCount * 3) % 360;
        c1 = `hsl(${hue}, 95%, 62%)`;
        c2 = `hsl(${(hue + 60) % 360}, 95%, 45%)`;
    }

    // Неоновое свечение
    if (skin.glow > 0) {
        ctx.shadowColor = c1;
        ctx.shadowBlur = skin.glow + Math.sin(frameCount * 0.1) * 4;
    }

    // Треугольный корпус
    const bodyGrad = ctx.createLinearGradient(0, -SHIP_H / 2, 0, SHIP_H / 2);
    bodyGrad.addColorStop(0, c1);
    bodyGrad.addColorStop(1, c2);
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(0, -SHIP_H / 2);           // нос
    ctx.lineTo(SHIP_W / 2, SHIP_H / 2);   // правое крыло
    ctx.lineTo(0, SHIP_H / 3);            // центральная выемка
    ctx.lineTo(-SHIP_W / 2, SHIP_H / 2);  // левое крыло
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;

    // Кабина (круг в центре)
    ctx.beginPath();
    ctx.arc(0, -SHIP_H / 8, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(220,240,255,0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Блестящий эффект (золото/лёд/радуга): бегущий блик
    if (skin.shine) {
        const t = (frameCount % 90) / 90;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, -SHIP_H / 2);
        ctx.lineTo(SHIP_W / 2, SHIP_H / 2);
        ctx.lineTo(-SHIP_W / 2, SHIP_H / 2);
        ctx.closePath();
        ctx.clip();
        const sx = -SHIP_W + t * SHIP_W * 2;
        const sg = ctx.createLinearGradient(sx - 8, 0, sx + 8, 0);
        sg.addColorStop(0, 'rgba(255,255,255,0)');
        sg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(-SHIP_W, -SHIP_H, SHIP_W * 2, SHIP_H * 2);
        ctx.restore();
    }

    ctx.restore();
}

// ---------- Взрыв (частицы) ----------

function createExplosion(x, y) {
    const colors = ['#ffd700', '#ff9a3c', '#ff3b3b'];
    for (let i = 0; i < 30; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 1.5 + Math.random() * 4;
        particles.push({
            x: x, y: y,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd,
            life: 1,
            decay: 0.015 + Math.random() * 0.02,
            size: 2 + Math.random() * 4,
            color: colors[Math.floor(Math.random() * colors.length)]
        });
    }
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        if (p.life <= 0) particles.splice(i, 1);
    }
}

function drawParticles() {
    for (const p of particles) {
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ---------- Фон с fade-переходом зон ----------

function drawBackground() {
    const z = currentZone();
    const pz = ZONES[prevZoneIndex];
    let top = z.bgTop, bot = z.bgBot;
    if (zoneFade < 1 && pz !== z) {
        top = lerpColor(pz.bgTop, z.bgTop, zoneFade);
        bot = lerpColor(pz.bgBot, z.bgBot, zoneFade);
    }
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
}

// ---------- Смена зоны ----------

let lastZoneIndex = 0;
let zoneNoticeTimer = null; // таймер скрытия уведомления (для тестов/повторных вызовов)

function checkZoneChange() {
    const zi = getZoneIndex(score);
    if (zi !== lastZoneIndex) {
        prevZoneIndex = lastZoneIndex;
        lastZoneIndex = zi;
        zoneFade = 0; // запускаем плавный переход
        showZoneNotice(ZONES[zi].name);
    }
}

function showZoneNotice(name) {
    const el = document.getElementById('zoneNotice');
    el.textContent = '🌌 ' + name;
    el.classList.remove('hidden');
    // Перезапуск CSS-анимации
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(zoneNoticeTimer);
    zoneNoticeTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ---------- HUD ----------

function updateHUD() {
    document.getElementById('hudScore').textContent = '🏆 ' + score;
    document.getElementById('hudCoins').textContent = '💰 ' + coins;
}

// ---------- 8. Управление (мышь/тач) ----------

function setTargetFromPointer(clientX) {
    // Учитываем смещение канваса (обычно 0)
    const rect = canvas.getBoundingClientRect();
    ship.targetX = clientX - rect.left;
}

canvas.addEventListener('mousemove', e => {
    if (state === 'playing') setTargetFromPointer(e.clientX);
});

canvas.addEventListener('touchstart', e => {
    if (state === 'playing' && e.touches.length) {
        setTargetFromPointer(e.touches[0].clientX);
        e.preventDefault();
    }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
    if (state === 'playing' && e.touches.length) {
        setTargetFromPointer(e.touches[0].clientX);
        e.preventDefault();
    }
}, { passive: false });

// Пауза при потере фокуса окна (опциональное улучшение)
document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'playing') {
        pauseGame();
    }
});

function pauseGame() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    window.addEventListener('focus', resumeGameOnce);
}

function resumeGameOnce() {
    window.removeEventListener('focus', resumeGameOnce);
    if (state === 'playing' && !rafId) {
        lastSpawnFrame = frameCount;
        loop();
    }
}

// ---------- 7. Управление экранами ----------

const screens = {
    start: document.getElementById('startScreen'),
    shop: document.getElementById('shopScreen'),
    gameover: document.getElementById('gameOverScreen'),
    hud: document.getElementById('hud')
};

function showScreen(name) {
    screens.start.classList.add('hidden');
    screens.shop.classList.add('hidden');
    screens.gameover.classList.add('hidden');
    screens.hud.classList.add('hidden');
    if (name === 'start') { refreshStartScreen(); screens.start.classList.remove('hidden'); }
    if (name === 'shop') { renderShop(); screens.shop.classList.remove('hidden'); }
    if (name === 'gameover') { screens.gameover.classList.remove('hidden'); }
    if (name === 'game') { screens.hud.classList.remove('hidden'); }
}

function refreshStartScreen() {
    document.getElementById('startCoins').textContent = coins;
    document.getElementById('startBest').textContent = bestScore;
}

// ---------- 8. Магазин скинов ----------

function renderShop() {
    document.getElementById('shopCoins').textContent = coins;
    const grid = document.getElementById('skinGrid');
    grid.innerHTML = '';

    for (const skin of SKINS) {
        const owned = ownedSkins.includes(skin.id);
        const selected = selectedSkin === skin.id;

        const card = document.createElement('button');
        card.className = 'skin-card' + (selected ? ' selected' : '') + (!owned ? ' locked' : '');

        // Превью: градиентный квадрат цвета скина
        const preview = document.createElement('div');
        preview.className = 'skin-preview';
        if (skin.id === 'rainbow') {
            preview.style.background = 'linear-gradient(135deg, red, orange, yellow, green, cyan, blue, violet)';
        } else {
            preview.style.background = `linear-gradient(135deg, ${skin.colors[0]}, ${skin.colors[1]})`;
        }

        const nameEl = document.createElement('div');
        nameEl.className = 'skin-name';
        nameEl.textContent = skin.name;

        const priceEl = document.createElement('div');
        if (selected) {
            priceEl.className = 'skin-owned-label';
            priceEl.textContent = '✓ Выбран';
        } else if (owned) {
            priceEl.className = 'skin-owned-label';
            priceEl.textContent = 'Куплено';
        } else {
            priceEl.className = 'skin-price';
            priceEl.textContent = '💰 ' + skin.price;
        }

        card.appendChild(preview);
        card.appendChild(nameEl);
        card.appendChild(priceEl);

        card.addEventListener('click', () => onSkinClick(skin));
        grid.appendChild(card);
    }
}

function onSkinClick(skin) {
    const owned = ownedSkins.includes(skin.id);
    if (owned) {
        // Выбор купленного скина
        selectedSkin = skin.id;
        saveData(LS_KEYS.selected, selectedSkin);
        renderShop();
    } else if (coins >= skin.price) {
        // Покупка
        coins -= skin.price;
        ownedSkins.push(skin.id);
        selectedSkin = skin.id;
        saveData(LS_KEYS.coins, coins);
        saveData(LS_KEYS.owned, ownedSkins);
        saveData(LS_KEYS.selected, selectedSkin);
        renderShop();
    } else {
        // Недостаточно монет — подсветим счёт красным
        const el = document.getElementById('shopCoins');
        el.style.color = '#ff5252';
        setTimeout(() => { el.style.color = ''; }, 600);
    }
}

// ---------- Игровой цикл ----------

function resetGame() {
    score = 0;
    earnedCoins = 0;
    frameCount = 0;
    astSpeed = 3;            // начальная скорость: 3 px/кадр
    spawnInterval = 60;      // начальный интервал: 60 кадров
    lastSpawnFrame = 0;
    asteroids = [];
    particles = [];
    doubled = false;
    lastZoneIndex = 0;
    prevZoneIndex = 0;
    zoneFade = 1;
    ship.x = W / 2;
    ship.targetX = W / 2;
    ship.y = H - SHIP_H - 30;
    regenerateStars();
    updateHUD();
}

function startGame() {
    resetGame();
    state = 'playing';
    showScreen('game');
    if (rafId) cancelAnimationFrame(rafId);
    loop();
}

function gameOver() {
    state = 'gameover';
    createExplosion(ship.x, ship.y);

    // Монеты: 1 монета = 10 очков
    earnedCoins = Math.floor(score / 10);
    coins += earnedCoins;

    // Рекорд
    if (score > bestScore) {
        bestScore = score;
        saveData(LS_KEYS.best, bestScore);
    }
    saveData(LS_KEYS.coins, coins);

    // Заполняем экран результатов
    document.getElementById('finalScore').textContent = score;
    document.getElementById('finalBest').textContent = bestScore;
    document.getElementById('earnedCoins').textContent = '💰 ' + earnedCoins;

    // Кнопка x2 активна только если есть что удваивать и ещё не удваивали
    const btnD = document.getElementById('btnDouble');
    btnD.style.display = (earnedCoins > 0 && !doubled) ? '' : 'none';

    // Доигрываем анимацию взрыва, затем показываем экран + interstitial
    setTimeout(() => {
        showScreen('gameover');
        showInterstitialAd();
    }, 900);
}

function doubleReward() {
    if (doubled) return;
    doubled = true;
    showRewardedAd(() => {
        // Удвоение монет (очки удваиваются только для награды монетами)
        coins += earnedCoins; // ещё столько же монет сверху
        score *= 2;
        if (score > bestScore) {
            bestScore = score;
            saveData(LS_KEYS.best, bestScore);
        }
        saveData(LS_KEYS.coins, coins);
        document.getElementById('finalScore').textContent = score;
        document.getElementById('finalBest').textContent = bestScore;
        document.getElementById('earnedCoins').textContent = '💰 ' + (earnedCoins * 2);
        document.getElementById('btnDouble').style.display = 'none';
    });
}

// Обновление сложности: каждые 300 кадров (5 сек при 60 FPS)
function updateDifficulty() {
    if (frameCount > 0 && frameCount % 300 === 0) {
        astSpeed += 0.3;                     // скорость +0.3
        spawnInterval = Math.max(20, spawnInterval - 3); // интервал -3, минимум 20
    }
}

function update() {
    frameCount++;
    updateDifficulty();

    // Плавное следование корабля за пальцем/курсором (интерполяция)
    ship.targetX = Math.max(SHIP_W / 2, Math.min(W - SHIP_W / 2, ship.targetX));
    ship.x += (ship.targetX - ship.x) * 0.15;
    ship.y = H - SHIP_H - 30;

    // Спавн астероидов
    if (frameCount - lastSpawnFrame >= spawnInterval) {
        lastSpawnFrame = frameCount;
        spawnAsteroid();
    }

    updateAsteroids();
    updateStars();
    updateParticles();

    // Fade перехода зоны
    if (zoneFade < 1) zoneFade = Math.min(1, zoneFade + 0.02);

    if (state === 'playing') checkCollisions();
}

function render() {
    drawBackground();
    drawStars();
    for (const a of asteroids) drawAsteroid(a);
    if (state === 'playing') drawShip();
    drawParticles();
}

function loop() {
    rafId = requestAnimationFrame(loop);
    update();
    render();
}

// Фоновая анимация меню (звёзды медленно летят даже на стартовом экране)
function menuLoop() {
    if (state !== 'menu') return;
    frameCount++;
    updateStars();
    drawBackground();
    drawStars();
    requestAnimationFrame(menuLoop);
}

// ---------- Кнопки интерфейса ----------

document.getElementById('btnPlay').addEventListener('click', startGame);
document.getElementById('btnShop').addEventListener('click', () => showScreen('shop'));
document.getElementById('btnBackShop').addEventListener('click', () => showScreen('start'));
document.getElementById('btnRestart').addEventListener('click', startGame);
document.getElementById('btnMenu').addEventListener('click', () => {
    state = 'menu';
    showScreen('start');
    menuLoop();
});
document.getElementById('btnDouble').addEventListener('click', doubleReward);

// ---------- Старт ----------

resizeCanvas();
regenerateStars();
showScreen('start');
menuLoop();
