const { ipcRenderer } = require('electron');

const PROMO_CORE_ORIGIN = 'https://promo-core-rider.gkiop88.chatgpt.site';

function postToSite(message) {
  if (location.origin !== PROMO_CORE_ORIGIN) return;
  window.postMessage({ source: 'PROMO_CORE_EXTENSION', ...message }, location.origin);
}

window.addEventListener('message', (event) => {
  if (
    event.source !== window ||
    event.origin !== PROMO_CORE_ORIGIN ||
    event.data?.source !== 'PROMO_CORE_SITE'
  ) return;

  if (event.data.type === 'START_BAEMIN_AUTO_IMPORT') {
    const fromDate = document.querySelector('#baeminFrom')?.value || '';
    const toDate = document.querySelector('#baeminTo')?.value || '';
    ipcRenderer.send('start-baemin-auto-import', { fromDate, toDate });
  }
});

ipcRenderer.on('promo-core-event', (_event, message) => {
  if (!message || typeof message.type !== 'string') return;
  postToSite(message);
});

window.addEventListener('DOMContentLoaded', () => {
  if (location.origin !== PROMO_CORE_ORIGIN) return;

  const loginButton = document.querySelector('#openBaeminLogin');
  if (loginButton) {
    loginButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.send('open-baemin-login');
    }, true);
  }
});
