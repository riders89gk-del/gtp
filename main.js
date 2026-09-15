const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const PROMO_CORE_URL = 'https://promo-core-rider.gkiop88.chatgpt.site';
const BAEMIN_ORIGIN = 'https://deliverycenter.baemin.com';
const MAX_PAGES = 50;

let promoWindow;
let baeminWindow;
let collecting = false;

function cleanText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim();
}

function numberOf(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePartner(value) {
  return cleanText(value)
    .replace(/\s*표준\s*/g, ' ')
    .replace(/\s*DP\s*번호\s*[:：]?\s*[A-Za-z0-9_-]+/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function detectPartner(lines) {
  const menu = /^(협력사 관리|협력사 상세 정보|협력사관리자 조회|협력사관리자 등록|라이더별 배달내역|배달 관리|라이더 관리)$/;
  const candidates = lines.slice(0, 100).map(normalizePartner).filter(Boolean);
  return candidates.find((line) =>
    line.length >= 3 &&
    line.length <= 60 &&
    /(노터치|센트럴|라이더페이|강남|서초|동작|송파)/.test(line) &&
    !menu.test(line)
  ) || '';
}

function parseRowsFromCells(rows) {
  const phonePattern = /^01[016789]-?\d{3,4}-?\d{4}$/;
  const riders = [];

  for (const rawCells of rows) {
    const cells = rawCells.map(cleanText);
    if (cells.length < 50 || cells[0] === '합계' || !phonePattern.test(cells[2] || '')) continue;
    const total = numberOf(cells[3]);
    if (!Number.isFinite(total)) continue;
    riders.push({
      name: cells[0],
      id: cells[1],
      phone: cells[2].replace(/\D/g, ''),
      total,
      hours: cells.slice(25, 49).map(numberOf)
    });
  }

  return riders;
}

function parseRowsFromText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const phonePattern = /^01[016789]-?\d{3,4}-?\d{4}$/;
  const valid = (row) => row.length >= 50 && phonePattern.test(row[2] || '');
  let rows = lines.map((line) => line.split('\t').map(cleanText)).filter(valid);

  if (!rows.length) {
    const tokens = lines.map(cleanText).filter(Boolean);
    const totalAt = tokens.findIndex((value, index) =>
      value === '합계' && tokens[index + 1] === '-' && tokens[index + 2] === '-'
    );
    if (totalAt >= 0) {
      const data = tokens.slice(totalAt + 50);
      for (let index = 0; index + 49 < data.length; index += 50) {
        const row = data.slice(index, index + 50);
        if (!valid(row)) break;
        rows.push(row);
      }
    }
  }

  return parseRowsFromCells(rows);
}

function uniqueRiders(riders) {
  const seen = new Set();
  return riders.filter((rider) => {
    const key = rider.id
      ? `id:${cleanText(rider.id).toLowerCase()}`
      : `name:${cleanText(rider.name).replace(/\s/g, '').toLowerCase()}|${rider.phone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historyUrl(fromDate, toDate, page = 1) {
  const params = new URLSearchParams({
    page: String(page),
    size: '100',
    fromDate,
    toDate
  });
  return `${BAEMIN_ORIGIN}/delivery/rider-history?${params.toString()}`;
}

function isAllowedNavigation(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === PROMO_CORE_URL || parsed.origin === BAEMIN_ORIGIN;
  } catch (_) {
    return false;
  }
}

function sendToPromo(type, details = {}) {
  if (!promoWindow || promoWindow.isDestroyed()) return;
  promoWindow.webContents.send('promo-core-event', { type, ...details });
}

function installNavigationGuard(window) {
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BAEMIN_ORIGIN)) {
      openBaeminWindow(url);
    } else if (url.startsWith(PROMO_CORE_URL)) {
      promoWindow.loadURL(url);
    } else if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function createPromoWindow() {
  promoWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: 'PROMO CORE',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:promo-core'
    }
  });

  installNavigationGuard(promoWindow);
  promoWindow.loadURL(PROMO_CORE_URL);
  promoWindow.on('closed', () => {
    promoWindow = null;
    if (baeminWindow && !baeminWindow.isDestroyed()) baeminWindow.close();
  });
}

function openBaeminWindow(url = BAEMIN_ORIGIN) {
  if (baeminWindow && !baeminWindow.isDestroyed()) {
    baeminWindow.show();
    baeminWindow.focus();
    if (url && baeminWindow.webContents.getURL() !== url) baeminWindow.loadURL(url);
    return baeminWindow;
  }

  baeminWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: '배민 로그인 · 자료 조회',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:promo-core'
    }
  });

  installNavigationGuard(baeminWindow);
  baeminWindow.loadURL(url);
  baeminWindow.on('closed', () => { baeminWindow = null; });
  return baeminWindow;
}

async function waitForPageReady(window, timeoutMs = 30000) {
  if (!window.webContents.isLoading()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('배민 화면을 불러오는 시간이 오래 걸립니다. 다시 시도해주세요.'));
    }, timeoutMs);
    const done = () => { cleanup(); resolve(); };
    const failed = (_event, code, description) => {
      cleanup();
      reject(new Error(`배민 화면을 열지 못했습니다. (${description || code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.webContents.removeListener('did-finish-load', done);
      window.webContents.removeListener('did-fail-load', failed);
    };
    window.webContents.once('did-finish-load', done);
    window.webContents.once('did-fail-load', failed);
  });
}

async function readCurrentBaeminPage() {
  return baeminWindow.webContents.executeJavaScript(`(() => {
    const text = document.body ? document.body.innerText : '';
    const rows = [...document.querySelectorAll('tr')].map(tr =>
      [...tr.querySelectorAll('th,td')].map(cell => (cell.innerText || cell.textContent || '').trim())
    );
    const pageNumbers = [...document.querySelectorAll('a,button')]
      .map(el => Number((el.textContent || '').trim()))
      .filter(n => Number.isInteger(n) && n > 0 && n <= ${MAX_PAGES});
    return { text, rows, maxVisiblePage: pageNumbers.length ? Math.max(...pageNumbers) : 1 };
  })()`, true);
}

async function collectBaemin(payload) {
  if (collecting) return;
  collecting = true;
  sendToPromo('EXTENSION_READY');

  try {
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.fromDate || '') ? payload.fromDate : '';
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.toDate || '') ? payload.toDate : '';
    if (!fromDate || !toDate) throw new Error('PROMO CORE에서 조회 시작일과 종료일을 먼저 선택해주세요.');

    const window = openBaeminWindow(historyUrl(fromDate, toDate, 1));
    await waitForPageReady(window);

    const currentUrl = window.webContents.getURL();
    if (!currentUrl.includes('/delivery/rider-history')) {
      window.show();
      window.focus();
      throw new Error('배민 로그인이 필요합니다. 열린 배민 창에서 로그인한 뒤 자동 가져오기를 다시 눌러주세요.');
    }

    let partner = '';
    let allRiders = [];
    let pageCount = 1;

    for (let page = 1; page <= Math.min(pageCount, MAX_PAGES); page += 1) {
      if (page > 1) {
        await window.loadURL(historyUrl(fromDate, toDate, page));
        await waitForPageReady(window);
      }

      const pageData = await readCurrentBaeminPage();
      const lines = String(pageData.text || '').split('\n').map(cleanText).filter(Boolean);
      if (!partner) partner = detectPartner(lines);
      const riders = parseRowsFromCells(pageData.rows || []);
      const fallbackRiders = riders.length ? riders : parseRowsFromText(pageData.text || '');
      pageCount = Math.max(pageCount, Math.min(numberOf(pageData.maxVisiblePage) || 1, MAX_PAGES));

      if (!fallbackRiders.length) {
        if (page === 1) throw new Error('라이더별 배달내역을 읽지 못했습니다. 조회 권한과 날짜를 확인해주세요.');
        break;
      }

      allRiders.push(...fallbackRiders);
      sendToPromo('IMPORT_PROGRESS', {
        page,
        pageCount,
        count: uniqueRiders(allRiders).length
      });

      if (fallbackRiders.length < 100 && page >= pageCount) break;
      if (fallbackRiders.length >= 100 && page === pageCount && pageCount < MAX_PAGES) pageCount += 1;
    }

    const riders = uniqueRiders(allRiders);
    if (!partner) throw new Error('협력사명을 자동으로 확인하지 못했습니다. 배민 협력사 화면을 확인해주세요.');
    if (!riders.length) throw new Error('가져올 기사 자료가 없습니다. 조회 기간을 확인해주세요.');

    sendToPromo('IMPORT_RESULT', {
      payload: { partner, fromDate, toDate, riders }
    });
    if (baeminWindow && !baeminWindow.isDestroyed()) baeminWindow.hide();
    if (promoWindow && !promoWindow.isDestroyed()) promoWindow.focus();
  } catch (error) {
    sendToPromo('IMPORT_ERROR', { message: error.message || '배민 자동 가져오기에 실패했습니다.' });
  } finally {
    collecting = false;
  }
}

ipcMain.on('start-baemin-auto-import', (_event, payload) => collectBaemin(payload || {}));
ipcMain.on('open-baemin-login', () => openBaeminWindow(BAEMIN_ORIGIN));

app.whenReady().then(() => {
  app.setAppUserModelId('kr.co.riderpayments.promocore');
  createPromoWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createPromoWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => {
  dialog.showErrorBox('PROMO CORE 오류', error.message || String(error));
});
