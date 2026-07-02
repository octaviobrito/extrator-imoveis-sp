document.getElementById('buscar').addEventListener('click', () => {
  const endereco = document.getElementById('endereco').value.trim();
  if (!endereco) return;
  chrome.tabs.create({ url: `tab.html?endereco=${encodeURIComponent(endereco)}` });
});

document.getElementById('endereco').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('buscar').click();
});

// Exibir versão da extensão
try {
  const v = document.getElementById('app-version');
  if (v) v.textContent = chrome.runtime.getManifest().version;
} catch (e) { /* ignore */ }
