// Service Worker para a extensão
// Usado para tarefas em segundo plano e gerenciamento de requisições

// Instalação do service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extrator de Imóveis SP instalado com sucesso!');
  
  // Configurações iniciais
  chrome.storage.local.set({
    installedAt: new Date().toISOString(),
    version: '1.0'
  });
});

// Listener para mensagens do popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  // Requisições de dados podem ser tratadas aqui
  if (request.action === 'fetchData') {
    fetchExternalData(request.url)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'fetchPost') {
    fetchPostData(request.url, request.body)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
  // Cache de requisições
  if (request.action === 'cacheData') {
    chrome.storage.local.set({ [request.key]: request.data }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
  
  // Recuperar dados em cache
  if (request.action === 'getCachedData') {
    chrome.storage.local.get([request.key], (result) => {
      sendResponse({ success: true, data: result[request.key] });
    });
    return true;
  }
});

async function fetchPostData(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

async function fetchExternalData(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ExtensaoImoveisSP/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  } catch (error) {
    console.error('Erro ao buscar dados externos:', error);
    throw error;
  }
}
