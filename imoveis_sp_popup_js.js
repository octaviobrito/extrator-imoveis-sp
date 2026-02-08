// Elementos DOM
const enderecoInput = document.getElementById('endereco');
const buscarBtn = document.getElementById('buscar');
const loadingDiv = document.getElementById('loading');
const erroDiv = document.getElementById('erro');
const resultadosDiv = document.getElementById('resultados');

// Event Listeners
buscarBtn.addEventListener('click', buscarDados);
enderecoInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') buscarDados();
});

// Função principal de busca
async function buscarDados() {
  const endereco = enderecoInput.value.trim();
  
  if (!endereco) {
    mostrarErro('Por favor, digite um endereço válido.');
    return;
  }

  mostrarLoading();
  limparResultados();
  
  try {
    // 1. Geocodificar endereço
    const coordenadas = await geocodificarEndereco(endereco);
    
    // 2. Buscar dados em paralelo de todas as fontes
    const [
      dadosGeoSampa,
      dadosIPTU,
      dadosZoneamento,
      dadosMercado,
      dadosInfraestrutura
    ] = await Promise.allSettled([
      buscarDadosGeoSampa(coordenadas),
      buscarDadosIPTU(endereco, coordenadas),
      buscarDadosZoneamento(coordenadas),
      buscarDadosMercado(endereco, coordenadas),
      buscarDadosInfraestrutura(coordenadas)
    ]);

    // 3. Exibir resultados
    exibirResultados({
      coordenadas,
      geoSampa: dadosGeoSampa.status === 'fulfilled' ? dadosGeoSampa.value : null,
      iptu: dadosIPTU.status === 'fulfilled' ? dadosIPTU.value : null,
      zoneamento: dadosZoneamento.status === 'fulfilled' ? dadosZoneamento.value : null,
      mercado: dadosMercado.status === 'fulfilled' ? dadosMercado.value : null,
      infraestrutura: dadosInfraestrutura.status === 'fulfilled' ? dadosInfraestrutura.value : null
    });

    esconderLoading();
    
  } catch (erro) {
    esconderLoading();
    mostrarErro(`Erro ao buscar dados: ${erro.message}`);
  }
}

// Geocodificação usando Nominatim (OpenStreetMap - gratuito)
async function geocodificarEndereco(endereco) {
  const enderecoCompleto = `${endereco}, São Paulo, SP, Brasil`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(enderecoCompleto)}&limit=1`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ExtensaoImoveisSP/1.0'
    }
  });
  
  const data = await response.json();
  
  if (data.length === 0) {
    throw new Error('Endereço não encontrado');
  }
  
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    display_name: data[0].display_name
  };
}

// Buscar dados do GeoSampa (Prefeitura de SP)
async function buscarDadosGeoSampa(coordenadas) {
  // Simulação - A API real do GeoSampa requer autenticação
  // URL real: http://geosampa.prefeitura.sp.gov.br/PaginasPublicas/
  
  // Para implementação real, você precisaria:
  // 1. Acessar o GeoSampa Web
  // 2. Usar as coordenadas para consultar camadas
  // 3. Extrair SQL, distrito, subprefeitura
  
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        sql: 'Dados disponíveis via consulta manual no GeoSampa',
        distrito: 'Consulte manualmente',
        subprefeitura: 'Consulte manualmente',
        cep: 'Via API ViaCEP'
      });
    }, 1000);
  });
}

// Buscar dados de IPTU
async function buscarDadosIPTU(endereco, coordenadas) {
  // Simulação - Dados reais exigiriam scraping do site da prefeitura
  // ou acesso a base de dados oficial
  
  // A Prefeitura de SP não disponibiliza API pública de IPTU
  // Seria necessário fazer web scraping ou comprar acesso a bases privadas
  
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        valorVenal: 'Requer consulta no site da Prefeitura',
        areaTerreno: 'Dados via consulta cadastral',
        areaConstruida: 'Dados via consulta cadastral',
        anoConstrucao: '-',
        tipoUso: 'Residencial/Comercial (verificar)'
      });
    }, 1200);
  });
}

// Buscar dados de zoneamento
async function buscarDadosZoneamento(coordenadas) {
  // GeoSampa contém camadas de zoneamento
  // Seria necessário fazer requisição às camadas WMS/WFS
  
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        zona: 'Consultar GeoSampa - Camada de Zoneamento',
        coefAprov: 'Varia conforme zona',
        gabarito: 'Varia conforme zona'
      });
    }, 1000);
  });
}

// Buscar dados do mercado imobiliário
async function buscarDadosMercado(endereco, coordenadas) {
  // APIs possíveis: ZAP Imóveis, Viva Real, FipeZap
  // Maioria requer autenticação ou scraping
  
  try {
    // Exemplo com API do FipeZap (índice de preços)
    // Nota: API real requer chave de acesso
    return {
      valorM2: 'R$ 8.000 - R$ 12.000 (estimativa região central)',
      imoveisVenda: 'Dados via ZAP/Viva Real',
      precoMedio: 'Varia por bairro'
    };
  } catch (erro) {
    return {
      valorM2: 'Não disponível',
      imoveisVenda: 'Não disponível',
      precoMedio: 'Não disponível'
    };
  }
}

// Buscar dados de infraestrutura
async function buscarDadosInfraestrutura(coordenadas) {
  // Buscar estação de metrô mais próxima
  // Poderia usar API do Google Places ou Overpass API (OpenStreetMap)
  
  try {
    // Usando Overpass API para buscar estações de metrô
    const query = `
      [out:json];
      (
        node["railway"="station"]["station"="subway"](around:2000,${coordenadas.lat},${coordenadas.lon});
      );
      out body;
    `;
    
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.elements && data.elements.length > 0) {
      const estacaoProxima = data.elements[0];
      const distancia = calcularDistancia(
        coordenadas.lat, 
        coordenadas.lon, 
        estacaoProxima.lat, 
        estacaoProxima.lon
      );
      
      return {
        metroProximo: estacaoProxima.tags.name || 'Estação sem nome',
        metroDistancia: `${distancia.toFixed(0)} metros`
      };
    }
    
    return {
      metroProximo: 'Nenhuma estação próxima (raio de 2km)',
      metroDistancia: '-'
    };
    
  } catch (erro) {
    return {
      metroProximo: 'Erro ao buscar',
      metroDistancia: '-'
    };
  }
}

// Calcular distância entre dois pontos (Haversine)
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Exibir resultados na interface
function exibirResultados(dados) {
  // Localização
  document.getElementById('endereco-completo').textContent = dados.coordenadas.display_name;
  document.getElementById('cep').textContent = dados.geoSampa?.cep || '-';
  document.getElementById('distrito').textContent = dados.geoSampa?.distrito || '-';
  document.getElementById('subprefeitura').textContent = dados.geoSampa?.subprefeitura || '-';
  document.getElementById('sql').textContent = dados.geoSampa?.sql || '-';
  
  // IPTU
  document.getElementById('valor-venal').textContent = dados.iptu?.valorVenal || '-';
  document.getElementById('area-terreno').textContent = dados.iptu?.areaTerreno || '-';
  document.getElementById('area-construida').textContent = dados.iptu?.areaConstruida || '-';
  document.getElementById('ano-construcao').textContent = dados.iptu?.anoConstrucao || '-';
  document.getElementById('tipo-uso').textContent = dados.iptu?.tipoUso || '-';
  
  // Zoneamento
  document.getElementById('zona').textContent = dados.zoneamento?.zona || '-';
  document.getElementById('coef-aprov').textContent = dados.zoneamento?.coefAprov || '-';
  document.getElementById('gabarito').textContent = dados.zoneamento?.gabarito || '-';
  
  // Mercado
  document.getElementById('valor-m2').textContent = dados.mercado?.valorM2 || '-';
  document.getElementById('imoveis-venda').textContent = dados.mercado?.imoveisVenda || '-';
  document.getElementById('preco-medio').textContent = dados.mercado?.precoMedio || '-';
  
  // Infraestrutura
  document.getElementById('metro-proximo').textContent = dados.infraestrutura?.metroProximo || '-';
  document.getElementById('metro-distancia').textContent = dados.infraestrutura?.metroDistancia || '-';
  
  resultadosDiv.classList.remove('hidden');
}

// Funções auxiliares de UI
function mostrarLoading() {
  loadingDiv.classList.remove('hidden');
  erroDiv.classList.add('hidden');
  resultadosDiv.classList.add('hidden');
}

function esconderLoading() {
  loadingDiv.classList.add('hidden');
}

function mostrarErro(mensagem) {
  erroDiv.textContent = mensagem;
  erroDiv.classList.remove('hidden');
}

function limparResultados() {
  resultadosDiv.classList.add('hidden');
}