document.getElementById('buscar').addEventListener('click', () => {
  const endereco = document.getElementById('endereco').value.trim();
  if (!endereco) return;
  const cidade = document.getElementById('cidade').value;
  try { localStorage.setItem('cidade', cidade); } catch (e) {}
  chrome.tabs.create({ url: `tab.html?cidade=${cidade}&endereco=${encodeURIComponent(endereco)}` });
});

document.getElementById('endereco').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('buscar').click();
});

// Exibir versão da extensão
try {
  const v = document.getElementById('app-version');
  if (v) v.textContent = chrome.runtime.getManifest().version;
} catch (e) { /* ignore */ }

try {
  const salva = localStorage.getItem('cidade');
  if (salva) document.getElementById('cidade').value = salva;
} catch (e) { /* ignore */ }
